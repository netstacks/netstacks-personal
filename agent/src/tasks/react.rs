//! ReAct Loop - Reasoning and Acting with AI Provider
//!
//! Implements the ReAct pattern: AI reasons about the task, decides on actions,
//! executes tools, and iterates until completion.
//!
//! Uses the shared AI provider infrastructure from `ai::providers` for all
//! API communication. The ReAct loop handles iteration, tool execution, and
//! conversation management while delegating HTTP calls to the provider layer.

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
use super::models::TaskStatus;
use super::progress::{ProgressBroadcaster, TaskProgressEvent};
use super::tools::ToolRegistry;
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
const DEFAULT_SYSTEM_PROMPT: &str = "You are a network automation assistant. You help users gather information from network devices using SSH commands. You have access to tools for querying devices and executing read-only commands. Be concise and focus on the task at hand.

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
    _ToolError(String),
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

/// Execute ReAct loop for a task, optionally using an AgentDefinition for config overrides
///
/// AUDIT FIX (EXEC-017): `approval_service` is consulted before every
/// mutating tool dispatch (`tasks::approvals::is_mutating_tool`). The
/// frontend polls for pending approvals scoped to this task_id and
/// resolves them via REST.
#[allow(clippy::too_many_arguments)]
pub async fn execute_react_loop_with_agent(
    task_id: &str,
    prompt: &str,
    store: &TaskStore,
    registry: Arc<ToolRegistry>,
    broadcaster: &ProgressBroadcaster,
    cancel_token: CancellationToken,
    data_provider: Arc<dyn DataProvider>,
    agent_definition: Option<AgentDefinition>,
    sanitizer_cache: Arc<RwLock<Option<Sanitizer>>>,
    approval_service: Arc<super::approvals::TaskApprovalService>,
    permit_guard: &mut super::PermitGuard,
) -> Result<Value, ReactError> {
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
        load_agent_config(&data_provider).await
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

    // Initialize conversation with user prompt
    let mut messages: Vec<AgentMessage> = vec![AgentMessage {
        role: "user".to_string(),
        content: AgentContent::Text(prompt.to_string()),
    }];

    let mut iteration = 0;
    let mut final_result: Option<String> = None;

    let max_iterations = agent_config.max_iterations;
    // Append the non-interactive operating guide so every agent (default or
    // user-declared) understands how to reach the user + use its tools. Editable
    // in Settings → Prompts; falls back to the built-in default.
    let operating_guide = load_setting_string(&data_provider, "ai.agent_operating_guide")
        .await
        .unwrap_or_else(|| DEFAULT_AGENT_OPERATING_GUIDE.to_string());
    let system_prompt = if operating_guide.trim().is_empty() {
        agent_config.system_prompt.clone()
    } else {
        format!("{}\n\n{}", agent_config.system_prompt, operating_guide)
    };

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

        // Call the shared provider infrastructure
        let response = ai_provider
            .agent_chat(
                system_prompt.clone(),
                messages.clone(),
                Some(tools_json.clone()),
                Some(options.clone()),
            )
            .await
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
                    use super::tools::output_validator::{validate_tool_use, ValidationOutcome};
                    let validation = validate_tool_use(&tool_name, &tool_input);

                    // AUDIT FIX (EXEC-017): mutating tools must be
                    // explicitly approved by the user per invocation.
                    // Read-only tools and validator-blocked calls skip
                    // the prompt entirely (no point asking the user to
                    // approve something we already rejected).
                    let needs_approval = matches!(validation, ValidationOutcome::Allow)
                        && super::approvals::is_mutating_tool(&tool_name);
                    let approval_decision = if needs_approval {
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
                                tool_name.clone(),
                                tool_input.clone(),
                                &cancel_token,
                            )
                            .await;
                        if let Err(e) = permit_guard.reacquire(&cancel_token).await {
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
                        let exec_result = tool.execute(tool_input, task_id).await;
                        if parks {
                            if let Err(e) = permit_guard.reacquire(&cancel_token).await {
                                return match e {
                                    super::ReacquireError::Cancelled => Err(ReactError::Cancelled),
                                    super::ReacquireError::SemaphoreClosed => {
                                        Err(ReactError::ApiError("semaphore closed during resume".into()))
                                    }
                                };
                            }
                        }
                        match exec_result {
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
                        }
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
            break;
        }
    }

    if iteration >= max_iterations {
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
