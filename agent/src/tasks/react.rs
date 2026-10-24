//! ReAct Loop - Reasoning and Acting with AI Provider
//!
//! Implements the ReAct pattern: AI reasons about the task, decides on actions,
//! executes tools, and iterates until completion.
//!
//! Uses the shared AI provider infrastructure from `ai::providers` for all
//! API communication. The ReAct loop handles iteration, tool execution, and
//! conversation management while delegating HTTP calls to the provider layer.

use std::future::Future;
use std::sync::Arc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::ai::providers::{
    AgentMessage, AgentContent, AgentContentBlock, AgentChatOptions,
};
use crate::ai::sanitizer::{Sanitizer, SanitizingProvider};
use crate::models::AgentDefinition;
use crate::providers::DataProvider;
use super::models::{FailurePolicy, TaskStatus};
use super::progress::{ProgressBroadcaster, TaskProgressEvent};
use super::tools::{ToolError, ToolOutput, ToolRegistry};
use super::store::TaskStore;
use super::models::CreateTaskMessageRequest;
use tokio::sync::RwLock;

/// Feature A: persist one transcript step then stream it live. Best-effort —
/// a transcript write must never fail the task (the run is the source of truth).
#[allow(clippy::too_many_arguments)]
async fn record_step(
    store: &TaskStore,
    broadcaster: &ProgressBroadcaster,
    task_id: &str,
    iteration: i32,
    kind: &str,
    tool_name: Option<String>,
    content: String,
    progress: i32,
) {
    match store
        .create_message(
            task_id,
            CreateTaskMessageRequest {
                iteration,
                kind: kind.to_string(),
                tool_name,
                content,
            },
        )
        .await
    {
        Ok(msg) => {
            let step = serde_json::to_value(&msg).unwrap_or(Value::Null);
            broadcaster.send(
                TaskProgressEvent::new(
                    task_id.to_string(),
                    TaskStatus::Running,
                    progress,
                    Some(format!("step:{}", kind)),
                )
                .with_step(step),
            );
        }
        Err(e) => {
            warn!(task_id = %task_id, error = %e, "failed to persist transcript step");
        }
    }
}

/// Default maximum iterations to prevent infinite loops
const DEFAULT_MAX_ITERATIONS: usize = 15;

/// Default maximum tokens for AI response
const DEFAULT_MAX_TOKENS: usize = 4096;

/// Default temperature
const DEFAULT_TEMPERATURE: f64 = 0.7;

/// Default system prompt
const DEFAULT_SYSTEM_PROMPT: &str = "You are a network automation assistant. You help users gather information from network devices using SSH commands. You have access to tools for querying devices and executing commands, which are read-only unless the user has enabled AI Config Mode. Be concise and focus on the task at hand.

WORKFLOW: Use a plan-execute-analyze rhythm:
- Plan: Decide what commands to run upfront. Batch related commands using the 'commands' array.
- Execute: Send the batch. Commands fire rapidly.
- Analyze: Review all output. Make terse observations. Plan next batch if needed.

BE TERSE: Keep observations to 1-2 sentences. Focus on findings, not process.
Don't narrate every command you're about to run.

Good: \"BGP neighbor 10.0.0.1 stuck in Active — AS mismatch (configured 65001, received 65002).\"
Bad: \"I'm going to run show bgp summary to check the BGP peers. Let me look at the output...\"";

/// DEFAULT operating-model guidance appended to EVERY agent task's system prompt
/// (the default one AND user-declared agent definitions). This is only the
/// fallback — users can edit it in Settings → Prompts ("Agent Operating Guide",
/// stored at the `ai.agent_operating_guide` setting). Agents run autonomously in a
/// non-interactive UI, so they must reach the user through tools (never plain
/// text), and should delegate / persist work via the provided tools.
const DEFAULT_AGENT_OPERATING_GUIDE: &str = "--- HOW YOU OPERATE (NetStacks Agent) ---\n\
You are an autonomous background Agent, NOT an interactive chat. The UI does not \
support free-form back-and-forth for your agent type, so a plain-text question will \
hang with no one to answer. Therefore:\n\
- To ask the user ANYTHING, call the ask_user tool. Never stop and wait by writing a \
question in your normal response.\n\
- Prefer to proceed with sensible assumptions and the tools you have; use ask_user only \
when you genuinely cannot continue without the user's input.\n\
- To delegate a self-contained sub-task, call list_specialists, then delegate_to_agent \
with a specialist's id (or omit the id for an ephemeral child) and use its result.\n\
- Save deliverables (reports, configs, summaries) with save_document so the user can open \
them.\n\
- Work the task to completion, then return a clear final summary of what you did and found.";

/// ReAct execution error
#[derive(Debug, thiserror::Error)]
pub enum ReactError {
    #[error("API error: {0}")]
    ApiError(String),
    #[error("Max iterations ({0}) reached")]
    MaxIterationsReached(usize),
    #[error("Task cancelled")]
    Cancelled,
    #[error("Tool error: {0}")]
    ToolError(String),
    #[error("No API key configured")]
    _NoApiKey,
    #[error("No AI provider configured")]
    _NoProviderConfigured,
}

/// Agent configuration loaded from settings
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AgentConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,
}

fn default_temperature() -> f64 {
    DEFAULT_TEMPERATURE
}

fn default_max_tokens() -> usize {
    DEFAULT_MAX_TOKENS
}

fn default_max_iterations() -> usize {
    DEFAULT_MAX_ITERATIONS
}

fn default_system_prompt() -> String {
    DEFAULT_SYSTEM_PROMPT.to_string()
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            provider: None,
            model: None,
            temperature: DEFAULT_TEMPERATURE,
            max_tokens: DEFAULT_MAX_TOKENS,
            max_iterations: DEFAULT_MAX_ITERATIONS,
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        }
    }
}

/// Load agent-specific configuration from settings
pub(crate) async fn load_agent_config(provider: &Arc<dyn DataProvider>) -> AgentConfig {
    let settings_result = provider.get_setting("ai.agent_config").await;

    match settings_result {
        Ok(value) if !value.is_null() => {
            // Handle wrapped {value: "..."} format
            let inner_value = if let Some(obj) = value.as_object() {
                if let Some(v) = obj.get("value") {
                    v.clone()
                } else {
                    value
                }
            } else {
                value
            };

            if inner_value.is_null() {
                return AgentConfig::default();
            }

            // The inner value may be a JSON string that needs parsing
            let config_value: serde_json::Value = if let serde_json::Value::String(s) = &inner_value {
                match serde_json::from_str(s) {
                    Ok(parsed) => parsed,
                    Err(e) => {
                        warn!("Failed to parse agent config string: {}", e);
                        return AgentConfig::default();
                    }
                }
            } else {
                inner_value
            };

            match serde_json::from_value::<AgentConfig>(config_value) {
                Ok(config) => config,
                Err(e) => {
                    warn!("Failed to deserialize agent config: {}", e);
                    AgentConfig::default()
                }
            }
        }
        _ => AgentConfig::default(),
    }
}

/// Read a plain-string setting (unwrapping the `{value: ...}` shape), returning
/// None when unset/empty so callers can fall back to a default.
async fn load_setting_bool(provider: &Arc<dyn DataProvider>, key: &str, default: bool) -> bool {
    match provider.get_setting(key).await {
        Ok(value) if !value.is_null() => {
            let inner = value
                .as_object()
                .and_then(|o| o.get("value").cloned())
                .unwrap_or(value);
            inner.as_bool().unwrap_or(default)
        }
        _ => default,
    }
}

async fn load_setting_string(provider: &Arc<dyn DataProvider>, key: &str) -> Option<String> {
    match provider.get_setting(key).await {
        Ok(value) if !value.is_null() => {
            let inner = value
                .as_object()
                .and_then(|o| o.get("value").cloned())
                .unwrap_or(value);
            match inner {
                serde_json::Value::String(s) if !s.trim().is_empty() => Some(s),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Everything one ReAct run needs to know about its task (built by the executor).
pub struct ReactTask<'a> {
    pub task_id: &'a str,
    pub prompt: &'a str,
    pub store: &'a TaskStore,
    pub registry: Arc<ToolRegistry>,
    pub broadcaster: &'a ProgressBroadcaster,
    pub cancel_token: CancellationToken,
    pub data_provider: Arc<dyn DataProvider>,
    pub approval_service: Arc<super::approvals::TaskApprovalService>,
    pub config_mode: crate::ai::config_mode::ConfigModeHandle,
    /// What a failing tool call does to the run (see [`FailurePolicy`]).
    pub failure_policy: FailurePolicy,
}

/// Per-run loop settings resolved from the agent config and sidecar settings.
struct LoopSettings {
    system_prompt: String,
    tools_json: Vec<Value>,
    options: AgentChatOptions,
    max_iterations: usize,
    show_thinking: bool,
}

/// Run `fut` unless the task is cancelled first. Stop must not wait for a
/// slow provider response or a long-running tool to finish on its own.
async fn until_cancelled<F: Future>(
    cancel_token: &CancellationToken,
    fut: F,
) -> Result<F::Output, ReactError> {
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => Err(ReactError::Cancelled),
        out = fut => Ok(out),
    }
}

/// The failure text of a tool call, or None when it succeeded.
fn tool_failure(result: &Result<ToolOutput, ToolError>) -> Option<String> {
    match result {
        Ok(output) if output.success => None,
        Ok(output) => Some(
            output
                .error
                .clone()
                .unwrap_or_else(|| "tool reported failure".to_string()),
        ),
        Err(e) => Some(e.to_string()),
    }
}

/// Execute ReAct loop for a task, optionally using an AgentDefinition for config overrides
///
/// Every tool call is resolved against the user's permission settings
/// (`tasks::permissions::resolve`, live config mode from `config_mode`):
/// denied calls never run, and calls the resolver sends to the user park on
/// `approval_service` (AUDIT FIX EXEC-017). The frontend polls for pending
/// approvals scoped to this task_id and resolves them via REST.
pub async fn execute_react_loop_with_agent(
    task: &ReactTask<'_>,
    agent_definition: Option<AgentDefinition>,
    sanitizer_cache: Arc<RwLock<Option<Sanitizer>>>,
    permit_guard: &mut super::PermitGuard,
) -> Result<Value, ReactError> {
    let task_id = task.task_id;
    let prompt = task.prompt;
    let data_provider = &task.data_provider;
    let registry = &task.registry;
    info!(task_id = %task_id, prompt_len = prompt.len(), "ReAct loop entry");

    // Load agent-specific configuration: use AgentDefinition overrides if provided, else global settings
    let agent_config = if let Some(ref def) = agent_definition {
        AgentConfig {
            provider: def.provider.clone(),
            model: def.model.clone(),
            temperature: def.temperature.unwrap_or(DEFAULT_TEMPERATURE),
            max_tokens: def.max_tokens as usize,
            max_iterations: def.max_iterations as usize,
            system_prompt: def.system_prompt.clone(),
        }
    } else {
        load_agent_config(data_provider).await
    };
    info!(task_id = %task_id, "Agent config loaded: {:?}", agent_config);

    // Load AI provider using the shared infrastructure
    let ai_config = crate::ai::chat::load_ai_config_from_provider(
        data_provider.as_ref(),
        agent_config.provider.as_deref(),
        agent_config.model.as_deref(),
    ).await;

    let raw_provider = crate::ai::providers::create_provider(ai_config);
    // Wrap with sanitization layer to scrub credentials/secrets before sending to AI
    let ai_provider: Box<dyn crate::ai::providers::AiProvider> = Box::new(SanitizingProvider::new(
        raw_provider,
        sanitizer_cache,
        data_provider.clone(),
    ));

    info!(
        task_id = %task_id,
        provider = %ai_provider.provider_name(),
        temperature = %agent_config.temperature,
        max_tokens = %agent_config.max_tokens,
        max_iterations = %agent_config.max_iterations,
        "Loaded AI configuration"
    );

    // Build tool definitions as JSON values (Anthropic format - provider layer handles conversion)
    let tools_json: Vec<Value> = registry
        .list_tools()
        .into_iter()
        .map(|t| json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.input_schema,
        }))
        .collect();

    let tool_defs = registry.list_tools();
    let tool_names: Vec<&str> = tool_defs.iter().map(|t| t.name.as_str()).collect();
    info!(
        task_id = %task_id,
        tools_count = tools_json.len(),
        tool_names = ?tool_names,
        "Starting ReAct loop"
    );

    let options = AgentChatOptions {
        temperature: Some(agent_config.temperature),
        max_tokens: Some(agent_config.max_tokens as u32),
    };

    // Append the non-interactive operating guide so every agent (default or
    // user-declared) understands how to reach the user + use its tools. Editable
    // in Settings → Prompts; falls back to the built-in default.
    let show_thinking = load_setting_bool(data_provider, "ai.showThinking", false).await;
    let operating_guide = load_setting_string(data_provider, "ai.agent_operating_guide")
        .await
        .unwrap_or_else(|| DEFAULT_AGENT_OPERATING_GUIDE.to_string());
    let system_prompt = if operating_guide.trim().is_empty() {
        agent_config.system_prompt.clone()
    } else {
        format!("{}\n\n{}", agent_config.system_prompt, operating_guide)
    };

    let settings = LoopSettings {
        system_prompt,
        tools_json,
        options,
        max_iterations: agent_config.max_iterations,
        show_thinking,
    };
    run_react_loop(task, ai_provider.as_ref(), &settings, permit_guard).await
}

/// The ReAct iterations themselves, against an already-built provider.
async fn run_react_loop(
    task: &ReactTask<'_>,
    ai_provider: &dyn crate::ai::providers::AiProvider,
    settings: &LoopSettings,
    permit_guard: &mut super::PermitGuard,
) -> Result<Value, ReactError> {
    let ReactTask {
        task_id,
        prompt,
        store,
        broadcaster,
        failure_policy,
        ..
    } = *task;
    let registry = &task.registry;
    let cancel_token = &task.cancel_token;
    let data_provider = &task.data_provider;
    let approval_service = &task.approval_service;
    let config_mode = &task.config_mode;
    let LoopSettings {
        system_prompt,
        tools_json,
        options,
        max_iterations,
        show_thinking,
    } = settings;
    let max_iterations = *max_iterations;
    let show_thinking = *show_thinking;

    // Initialize conversation with user prompt
    let mut messages: Vec<AgentMessage> = vec![AgentMessage {
        role: "user".to_string(),
        content: AgentContent::Text(prompt.to_string()),
    }];

    let mut iteration = 0;
    let mut final_result: Option<String> = None;
    // Set only by a clean `end_turn` — finishing on the last allowed
    // iteration is still a success, not MaxIterationsReached.
    let mut completed = false;

    while iteration < max_iterations {
        // Check for cancellation
        if cancel_token.is_cancelled() {
            warn!(task_id = %task_id, "ReAct loop cancelled");
            return Err(ReactError::Cancelled);
        }

        iteration += 1;
        let progress = ((iteration as f32 / max_iterations as f32) * 80.0) as i32 + 10; // 10-90%

        broadcaster.send(TaskProgressEvent::new(
            task_id.to_string(),
            TaskStatus::Running,
            progress,
            Some(format!("Reasoning iteration {}/{}", iteration, max_iterations)),
        ));

        info!(
            task_id = %task_id,
            iteration = iteration,
            "Calling AI API"
        );

        // Call the shared provider infrastructure (cancel-aware: Stop must
        // not wait out a slow provider response).
        let response = until_cancelled(
            cancel_token,
            ai_provider.agent_chat(
                system_prompt.clone(),
                messages.clone(),
                Some(tools_json.clone()),
                Some(options.clone()),
            ),
        )
        .await
        .inspect_err(|_| warn!(task_id = %task_id, "ReAct loop cancelled during provider call"))?
        .map_err(|e| ReactError::ApiError(e.to_string()))?;

        // Process response content
        let mut has_tool_use = false;
        let mut assistant_blocks: Vec<AgentContentBlock> = Vec::new();
        let mut tool_results: Vec<AgentContentBlock> = Vec::new();

        for block in response.content {
            match block {
                AgentContentBlock::Text { ref text } => {
                    info!(
                        task_id = %task_id,
                        text_len = text.len(),
                        "AI responded with text"
                    );
                    final_result = Some(text.clone());
                    // Feature A: record the model's reasoning text as a step.
                    record_step(store, broadcaster, task_id, iteration as i32, "thought", None, text.clone(), progress).await;
                    assistant_blocks.push(block);
                }
                AgentContentBlock::ToolUse { ref id, ref name, ref input } => {
                    has_tool_use = true;
                    info!(
                        task_id = %task_id,
                        tool = %name,
                        "AI requested tool use"
                    );

                    let tool_use_id = id.clone();
                    let tool_name = name.clone();
                    let tool_input = input.clone();
                    assistant_blocks.push(block);

                    // AUDIT FIX (EXEC-009): re-validate every LLM-emitted
                    // tool_use against per-tool policy BEFORE dispatching.
                    use super::permissions::{resolve, Decision, PermissionContext};
                    use super::tools::output_validator::{validate_tool_use, ValidationOutcome};
                    let validation = validate_tool_use(&tool_name, &tool_input);

                    // Resolve against the user's permission settings, read per
                    // call so a mid-task change applies. Validator-blocked
                    // calls skip the resolver entirely (no point asking the
                    // user to approve something we already rejected).
                    let decision = match validation {
                        ValidationOutcome::Allow => {
                            let ctx = PermissionContext::load(data_provider, config_mode).await;
                            Some(resolve(&tool_name, &tool_input, &ctx))
                        }
                        ValidationOutcome::Block(_) => None,
                    };
                    let approval_decision = if let Some(Decision::Ask(reason)) = &decision {
                        broadcaster.send(TaskProgressEvent::new(
                            task_id.to_string(),
                            TaskStatus::Running,
                            progress,
                            Some(format!("Awaiting approval for: {}", tool_name)),
                        ));
                        // Feature B: release the concurrency slot WHILE parked
                        // on the human so a long decision does not starve the
                        // cap-N pool; re-acquire (cancel-aware) before resuming.
                        permit_guard.release();
                        let decision = approval_service
                            .request(
                                task_id.to_string(),
                                super::approvals::InteractionKind::Approval,
                                format!("Approve tool: {} — {}", tool_name, reason),
                                tool_name.clone(),
                                tool_input.clone(),
                                cancel_token,
                            )
                            .await;
                        if let Err(e) = permit_guard.reacquire(cancel_token).await {
                            return match e {
                                super::ReacquireError::Cancelled => Err(ReactError::Cancelled),
                                super::ReacquireError::SemaphoreClosed => {
                                    Err(ReactError::ApiError("semaphore closed during resume".into()))
                                }
                            };
                        }
                        Some(decision)
                    } else {
                        None
                    };

                    let tool_result = if let Some(super::approvals::HumanResponse::Reject { reason }) = &approval_decision {
                        warn!(
                            target: "audit",
                            task_id = %task_id,
                            tool = %tool_name,
                            reason = ?reason,
                            "ReAct task tool-use REJECTED by user"
                        );
                        format!(
                            "User rejected the call to '{}'{}. Do not retry the same call; \
                             ask the user what they want done instead.",
                            tool_name,
                            reason.as_ref().map(|r| format!(" ({})", r)).unwrap_or_default()
                        )
                    } else if let ValidationOutcome::Block(reason) = validation {
                        warn!(
                            target: "audit",
                            task_id = %task_id,
                            tool = %tool_name,
                            reason = %reason,
                            "output-side validator blocked LLM tool_use"
                        );
                        format!(
                            "Tool call blocked by NetStacks output validator: {}. \
                             If you intend this command, ask the user to confirm explicitly.",
                            reason
                        )
                    } else if let Some(Decision::Deny(reason)) = decision {
                        warn!(
                            target: "audit",
                            task_id = %task_id,
                            tool = %tool_name,
                            reason = %reason,
                            "permission settings denied LLM tool_use"
                        );
                        format!("Tool call denied by the user's permission settings: {}", reason)
                    } else if let Some(tool) = registry.get(&tool_name) {
                        broadcaster.send(TaskProgressEvent::new(
                            task_id.to_string(),
                            TaskStatus::Running,
                            progress,
                            Some(format!("Executing tool: {}", tool_name)),
                        ));

                        // Feature A: record the EXACT command/arguments BEFORE
                        // running, so the glass-box shows what will execute.
                        let command_repr = serde_json::to_string_pretty(&tool_input)
                            .unwrap_or_else(|_| tool_input.to_string());
                        record_step(
                            store, broadcaster, task_id, iteration as i32,
                            "command", Some(tool_name.clone()), command_repr, progress,
                        )
                        .await;

                        // A parking tool blocks INSIDE execute() waiting on
                        // something external — a human (ask_user) or a delegated
                        // child agent (delegate_to_agent). Release the slot while
                        // parked (else it starves the pool / deadlocks a parent
                        // awaiting its child) and re-acquire (cancel-aware) after.
                        let parks = tool.parks();
                        if parks {
                            permit_guard.release();
                        }
                        // failure_policy: `retry` re-runs a failing call up to
                        // its retry budget; every attempt is cancel-aware so
                        // Stop does not wait out a long-running tool.
                        let attempts = failure_policy.attempts(parks);
                        let mut attempt = 1;
                        let exec_result = loop {
                            let result = until_cancelled(
                                cancel_token,
                                tool.execute(tool_input.clone(), task_id),
                            )
                            .await
                            .inspect_err(|_| {
                                warn!(task_id = %task_id, tool = %tool_name, "ReAct loop cancelled during tool execution")
                            })?;
                            match tool_failure(&result) {
                                Some(reason) if attempt < attempts => {
                                    warn!(
                                        task_id = %task_id,
                                        tool = %tool_name,
                                        attempt = attempt,
                                        error = %reason,
                                        "Tool failed; retrying per failure policy"
                                    );
                                    record_step(
                                        store, broadcaster, task_id, iteration as i32,
                                        "status", Some(tool_name.clone()),
                                        format!("Attempt {}/{} failed ({}); retrying", attempt, attempts, reason),
                                        progress,
                                    )
                                    .await;
                                    attempt += 1;
                                }
                                _ => break result,
                            }
                        };
                        if parks {
                            if let Err(e) = permit_guard.reacquire(cancel_token).await {
                                return match e {
                                    super::ReacquireError::Cancelled => Err(ReactError::Cancelled),
                                    super::ReacquireError::SemaphoreClosed => {
                                        Err(ReactError::ApiError("semaphore closed during resume".into()))
                                    }
                                };
                            }
                        }
                        let failure = tool_failure(&exec_result);
                        let result_str = match exec_result {
                            Ok(output) => {
                                let result_str = serde_json::to_string_pretty(&output.output)
                                    .unwrap_or_else(|_| output.output.to_string());

                                if output.success {
                                    info!(
                                        task_id = %task_id,
                                        tool = %tool_name,
                                        result_len = result_str.len(),
                                        "Tool executed successfully"
                                    );
                                } else {
                                    warn!(
                                        task_id = %task_id,
                                        tool = %tool_name,
                                        error = ?output.error,
                                        "Tool returned error"
                                    );
                                }
                                // Feature A: record the tool result.
                                record_step(
                                    store, broadcaster, task_id, iteration as i32,
                                    "tool_result", Some(tool_name.clone()), result_str.clone(), progress,
                                )
                                .await;
                                result_str
                            }
                            Err(e) => {
                                warn!(
                                    task_id = %task_id,
                                    tool = %tool_name,
                                    error = %e,
                                    "Tool execution failed"
                                );
                                let err_str = format!("Tool execution error: {}", e);
                                // Feature A: record the tool error.
                                record_step(
                                    store, broadcaster, task_id, iteration as i32,
                                    "error", Some(tool_name.clone()), err_str.clone(), progress,
                                )
                                .await;
                                err_str
                            }
                        };
                        // failure_policy `stop` / exhausted `retry`: the
                        // failure ends the task instead of going to the model.
                        if let Some(reason) = failure.filter(|_| failure_policy.fails_task()) {
                            let tries = if attempts > 1 {
                                format!(" after {} attempts", attempts)
                            } else {
                                String::new()
                            };
                            return Err(ReactError::ToolError(format!(
                                "'{}' failed{}: {}",
                                tool_name, tries, reason
                            )));
                        }
                        result_str
                    } else {
                        warn!(
                            task_id = %task_id,
                            tool = %tool_name,
                            "Unknown tool requested"
                        );
                        format!("Error: Unknown tool '{}'", tool_name)
                    };

                    tool_results.push(AgentContentBlock::ToolResult {
                        tool_use_id,
                        content: tool_result,
                        is_error: None,
                    });
                }
                AgentContentBlock::ToolResult { .. } => {
                    // Shouldn't appear in AI response, but handle gracefully
                    assistant_blocks.push(block);
                }
                AgentContentBlock::Thinking { thinking, .. } => {
                    if show_thinking && !thinking.is_empty() {
                        record_step(store, broadcaster, task_id, iteration as i32, "thinking", None, thinking, progress).await;
                    }
                }
            }
        }

        // Add assistant message
        messages.push(AgentMessage {
            role: "assistant".to_string(),
            content: AgentContent::Blocks(assistant_blocks),
        });

        // If there were tool uses, add results as user message
        if has_tool_use {
            messages.push(AgentMessage {
                role: "user".to_string(),
                content: AgentContent::Blocks(tool_results),
            });
        }

        // Check stop reason
        let stop_reason = response.stop_reason.as_deref().unwrap_or("end_turn");
        if stop_reason == "end_turn" && !has_tool_use {
            info!(
                task_id = %task_id,
                iterations = iteration,
                "ReAct loop completed"
            );
            completed = true;
            break;
        }
    }

    if !completed {
        warn!(
            task_id = %task_id,
            "ReAct loop reached max iterations"
        );
        return Err(ReactError::MaxIterationsReached(max_iterations));
    }

    // Return final result
    Ok(json!({
        "iterations": iteration,
        "result": final_result.unwrap_or_else(|| "Task completed".to_string())
    }))
}

#[cfg(test)]
mod loop_tests {
    use super::*;
    use crate::ai::providers::{AiError, AiProvider, AgentResponse, ChatMessage};
    use crate::tasks::models::{CreateTaskRequest, FailurePolicyKind};
    use crate::tasks::tools::Tool;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::sync::Semaphore;

    /// Replays scripted responses; once the script runs out it never answers.
    struct ScriptedProvider(Mutex<VecDeque<AgentResponse>>);

    impl ScriptedProvider {
        fn new(responses: Vec<AgentResponse>) -> Self {
            Self(Mutex::new(responses.into()))
        }
    }

    #[async_trait]
    impl AiProvider for ScriptedProvider {
        async fn chat_completion(
            &self,
            _messages: Vec<ChatMessage>,
            _context: Option<crate::ai::providers::AiContext>,
        ) -> Result<String, AiError> {
            Err(AiError::NotConfigured("test".into()))
        }

        async fn agent_chat(
            &self,
            _system_prompt: String,
            _messages: Vec<AgentMessage>,
            _tools: Option<Vec<Value>>,
            _options: Option<AgentChatOptions>,
        ) -> Result<AgentResponse, AiError> {
            let next = self.0.lock().unwrap().pop_front();
            match next {
                Some(response) => Ok(response),
                None => std::future::pending().await,
            }
        }

        fn provider_name(&self) -> &str {
            "scripted"
        }
    }

    fn text_reply(text: &str) -> AgentResponse {
        AgentResponse {
            content: vec![AgentContentBlock::Text { text: text.into() }],
            stop_reason: Some("end_turn".into()),
            usage: None,
        }
    }

    fn tool_call() -> AgentResponse {
        AgentResponse {
            content: vec![AgentContentBlock::ToolUse {
                id: "call-1".into(),
                name: "query_devices".into(),
                input: json!({}),
            }],
            stop_reason: Some("tool_use".into()),
            usage: None,
        }
    }

    #[derive(Clone, Copy)]
    enum ToolBehaviour {
        Fail,
        FailOnce,
        Hang,
    }

    /// Stand-in for a read-only tool (named `query_devices` so the
    /// permission resolver allows it in the default Auto mode).
    struct FakeTool {
        behaviour: ToolBehaviour,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Tool for FakeTool {
        fn name(&self) -> &str {
            "query_devices"
        }
        fn description(&self) -> &str {
            "test tool"
        }
        fn input_schema(&self) -> Value {
            json!({ "type": "object" })
        }
        async fn execute(&self, _input: Value, _task_id: &str) -> Result<ToolOutput, ToolError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            match self.behaviour {
                ToolBehaviour::Fail => Err(ToolError::ExecutionFailed("boom".into())),
                ToolBehaviour::FailOnce if n == 0 => Ok(ToolOutput::failure("flaky".into())),
                ToolBehaviour::FailOnce => Ok(ToolOutput::success(json!({ "ok": true }))),
                ToolBehaviour::Hang => std::future::pending().await,
            }
        }
    }

    struct Harness {
        store: TaskStore,
        task_id: String,
        registry: Arc<ToolRegistry>,
        data_provider: Arc<dyn DataProvider>,
        broadcaster: ProgressBroadcaster,
        calls: Arc<AtomicUsize>,
        _dir: tempfile::TempDir,
    }

    async fn harness(behaviour: ToolBehaviour) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(&dir.path().join("test.db")).await.unwrap();
        let store = TaskStore::new(pool.clone());
        let task_id = store
            .create_task(CreateTaskRequest { prompt: "p".into(), failure_policy: None })
            .await
            .unwrap()
            .id;
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(FakeTool { behaviour, calls: calls.clone() }));
        Harness {
            store,
            task_id,
            registry: Arc::new(registry),
            data_provider: Arc::new(crate::providers::local::LocalDataProvider::new(pool)),
            broadcaster: ProgressBroadcaster::new(64),
            calls,
            _dir: dir,
        }
    }

    async fn run(
        h: &Harness,
        provider: &ScriptedProvider,
        max_iterations: usize,
        failure_policy: FailurePolicy,
        cancel_token: CancellationToken,
    ) -> Result<Value, ReactError> {
        let task = ReactTask {
            task_id: &h.task_id,
            prompt: "p",
            store: &h.store,
            registry: h.registry.clone(),
            broadcaster: &h.broadcaster,
            cancel_token,
            data_provider: h.data_provider.clone(),
            approval_service: super::super::approvals::TaskApprovalService::new(h.store.clone()),
            config_mode: Arc::new(RwLock::new(None)),
            failure_policy,
        };
        let settings = LoopSettings {
            system_prompt: "s".into(),
            tools_json: vec![],
            options: AgentChatOptions { temperature: None, max_tokens: None },
            max_iterations,
            show_thinking: false,
        };
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let mut guard = super::super::PermitGuard::new(semaphore, permit);
        run_react_loop(&task, provider, &settings, &mut guard).await
    }

    fn policy(kind: FailurePolicyKind, retry_count: Option<u32>) -> FailurePolicy {
        FailurePolicy { policy: kind, retry_count }
    }

    #[tokio::test]
    async fn finishing_on_the_last_iteration_is_success() {
        let h = harness(ToolBehaviour::FailOnce).await;
        // Iteration 1 calls a tool, iteration 2 (the last allowed) ends the turn.
        let provider = ScriptedProvider::new(vec![tool_call(), text_reply("done")]);
        let out = run(&h, &provider, 2, FailurePolicy::default(), CancellationToken::new())
            .await
            .expect("end_turn on the final iteration must complete");
        assert_eq!(out["result"], "done");
        assert_eq!(out["iterations"], 2);
    }

    #[tokio::test]
    async fn running_out_of_iterations_still_fails() {
        let h = harness(ToolBehaviour::FailOnce).await;
        let provider = ScriptedProvider::new(vec![tool_call(), tool_call()]);
        let err = run(&h, &provider, 2, FailurePolicy::default(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, ReactError::MaxIterationsReached(2)), "{err:?}");
    }

    #[tokio::test]
    async fn cancel_interrupts_a_pending_provider_call() {
        let h = harness(ToolBehaviour::FailOnce).await;
        let provider = ScriptedProvider::new(vec![]); // never answers
        let token = CancellationToken::new();
        let canceller = {
            let token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                token.cancel();
            })
        };
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run(&h, &provider, 3, FailurePolicy::default(), token),
        )
        .await
        .expect("cancel must not wait for the provider")
        .unwrap_err();
        canceller.await.unwrap();
        assert!(matches!(err, ReactError::Cancelled), "{err:?}");
    }

    #[tokio::test]
    async fn cancel_interrupts_a_running_tool() {
        let h = harness(ToolBehaviour::Hang).await;
        let provider = ScriptedProvider::new(vec![tool_call(), text_reply("unreached")]);
        let token = CancellationToken::new();
        // Cancel once the tool is actually running.
        let canceller = {
            let (token, calls) = (token.clone(), h.calls.clone());
            tokio::spawn(async move {
                while calls.load(Ordering::SeqCst) == 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                token.cancel();
            })
        };
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run(&h, &provider, 3, FailurePolicy::default(), token),
        )
        .await
        .expect("cancel must not wait for the tool")
        .unwrap_err();
        canceller.await.unwrap();
        assert!(matches!(err, ReactError::Cancelled), "{err:?}");
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn continue_policy_hands_tool_failure_to_the_model() {
        let h = harness(ToolBehaviour::Fail).await;
        let provider = ScriptedProvider::new(vec![tool_call(), text_reply("recovered")]);
        let out = run(&h, &provider, 3, policy(FailurePolicyKind::Continue, None), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(out["result"], "recovered");
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_policy_fails_the_task_on_first_tool_failure() {
        let h = harness(ToolBehaviour::Fail).await;
        let provider = ScriptedProvider::new(vec![tool_call(), text_reply("unreached")]);
        let err = run(&h, &provider, 3, policy(FailurePolicyKind::Stop, None), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, ReactError::ToolError(ref m) if m.contains("boom")), "{err:?}");
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_policy_reruns_until_success() {
        let h = harness(ToolBehaviour::FailOnce).await;
        let provider = ScriptedProvider::new(vec![tool_call(), text_reply("done")]);
        let out = run(&h, &provider, 3, policy(FailurePolicyKind::Retry, Some(2)), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(out["result"], "done");
        assert_eq!(h.calls.load(Ordering::SeqCst), 2, "one failure, one successful retry");
    }

    #[tokio::test]
    async fn retry_policy_fails_the_task_when_retries_are_exhausted() {
        let h = harness(ToolBehaviour::Fail).await;
        let provider = ScriptedProvider::new(vec![tool_call(), text_reply("unreached")]);
        let err = run(&h, &provider, 3, policy(FailurePolicyKind::Retry, Some(2)), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, ReactError::ToolError(ref m) if m.contains("after 3 attempts")), "{err:?}");
        assert_eq!(h.calls.load(Ordering::SeqCst), 3);
    }
}
