//! Sub-agent orchestration tools — let an Agent delegate work to other agents.
//!
//! - `list_specialists`: discover user-declared specialist agents to delegate to.
//! - `delegate_to_agent`: hand a sub-job to a specialist (by id) OR spin up an
//!   ephemeral child (no id), correlated to the parent run, and (blocking) return
//!   the child's result so the parent can continue with it.
//!
//! `delegate_to_agent` is a PARKING tool (`parks()` = true): while it awaits the
//! child the ReAct loop releases this task's concurrency permit, so a parent
//! never holds a slot that its own child needs — no starvation, no deadlock.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tracing::{info, warn};

use super::{Tool, ToolError, ToolOutput};
use crate::providers::DataProvider;
use crate::tasks::models::TaskStatus;
use crate::tasks::store::{NewSubagent, TaskStore};
use crate::tasks::AgentTaskExecutor;

/// Orchestration guardrails (fail-closed). A child inherits these against its own
/// depth/root, so a tree can't recurse or fan out without bound.
const MAX_DEPTH: i32 = 3;
const MAX_CHILDREN_PER_TASK: i64 = 5;
const MAX_DESCENDANTS_PER_ROOT: i64 = 25;
const DEFAULT_TIMEOUT_SECS: u64 = 300;
const POLL_INTERVAL_MS: u64 = 750;

fn is_terminal(s: &TaskStatus) -> bool {
    matches!(
        s,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    )
}

// ---------------------------------------------------------------------------
// list_specialists
// ---------------------------------------------------------------------------

pub struct ListSpecialistsTool {
    provider: Arc<dyn DataProvider>,
}

impl ListSpecialistsTool {
    pub fn new(provider: Arc<dyn DataProvider>) -> Self {
        Self { provider }
    }
}

#[async_trait]
impl Tool for ListSpecialistsTool {
    fn name(&self) -> &str {
        "list_specialists"
    }

    fn description(&self) -> &str {
        "List user-declared specialist agents you can delegate sub-jobs to. Call \
         this BEFORE delegate_to_agent: if a specialist matches the sub-job, pass \
         its id to delegate_to_agent; if none matches, delegate WITHOUT an id to \
         spin up an ephemeral child. Returns each agent's id, name, and description."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({ "type": "object", "properties": {}, "required": [] })
    }

    async fn execute(
        &self,
        _input: serde_json::Value,
        _task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let defs = self
            .provider
            .list_agent_definitions()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("failed to list specialists: {}", e)))?;

        let specialists: Vec<_> = defs
            .into_iter()
            .filter(|d| d.enabled)
            .map(|d| {
                json!({
                    "id": d.id,
                    "name": d.name,
                    "description": d.description.unwrap_or_default(),
                })
            })
            .collect();

        Ok(ToolOutput::success(json!({ "specialists": specialists })))
    }
}

// ---------------------------------------------------------------------------
// delegate_to_agent
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DelegateInput {
    prompt: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

pub struct DelegateAgentTool {
    executor: Arc<AgentTaskExecutor>,
    store: TaskStore,
    provider: Arc<dyn DataProvider>,
}

impl DelegateAgentTool {
    pub fn new(
        executor: Arc<AgentTaskExecutor>,
        store: TaskStore,
        provider: Arc<dyn DataProvider>,
    ) -> Self {
        Self { executor, store, provider }
    }
}

#[async_trait]
impl Tool for DelegateAgentTool {
    fn name(&self) -> &str {
        "delegate_to_agent"
    }

    /// Blocks awaiting the child — release the permit while parked (so the child
    /// can acquire a slot) and re-acquire on resume.
    fn parks(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Delegate a sub-job to another agent and wait for its result. Pass agent_id \
         (from list_specialists) to use a declared specialist, or omit it to spin up \
         an ephemeral child agent. The child runs as part of THIS workflow (shown \
         under this run) and is independently auditable. Returns the child's result \
         so you can continue. Use for self-contained sub-tasks a specialist is better \
         at, or to parallelize/scope context — not for trivial steps you can do yourself."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "Full, self-contained instructions for the child agent." },
                "agent_id": { "type": "string", "description": "Specialist agent id from list_specialists. Omit for an ephemeral child." },
                "label": { "type": "string", "description": "Short label for this sub-job (e.g. 'check BGP on core'), shown in the workflow graph." },
                "timeout_seconds": { "type": "integer", "description": "Max seconds to wait for the child (default 300)." }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: DelegateInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid delegate_to_agent input: {}", e)))?;
        if params.prompt.trim().is_empty() {
            return Err(ToolError::InvalidInput("prompt must not be empty".into()));
        }

        // Parent context drives linkage + safety.
        let parent = self
            .store
            .get_task(task_id)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("failed to load parent task: {}", e)))?;
        let depth = parent.depth + 1;
        let root_task_id = parent
            .root_task_id
            .clone()
            .unwrap_or_else(|| parent.id.clone());

        // Guardrails (fail-closed). Return a structured refusal (not an error) so
        // the agent reads the reason and adapts instead of retrying blindly.
        let refuse = |reason: String| Ok(ToolOutput::success(json!({ "delegated": false, "reason": reason })));
        if depth > MAX_DEPTH {
            return refuse(format!(
                "Delegation depth limit reached (max {}). Do this sub-job yourself.",
                MAX_DEPTH
            ));
        }
        let children = self
            .store
            .count_children(task_id)
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        if children >= MAX_CHILDREN_PER_TASK {
            return refuse(format!(
                "Child limit reached for this agent (max {}). Combine sub-jobs or do them yourself.",
                MAX_CHILDREN_PER_TASK
            ));
        }
        let descendants = self
            .store
            .count_descendants(&root_task_id)
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        if descendants >= MAX_DESCENDANTS_PER_ROOT {
            return refuse(format!(
                "This workflow has reached its total sub-agent limit (max {}).",
                MAX_DESCENDANTS_PER_ROOT
            ));
        }

        // If a specialist was named, verify it exists/enabled (else ephemeral).
        let specialist_id = match &params.agent_id {
            Some(id) if !id.is_empty() => match self.provider_definition(id).await {
                Some(true) => Some(id.clone()),
                Some(false) => {
                    return refuse(format!("Specialist '{}' is disabled. Omit agent_id for an ephemeral child.", id))
                }
                None => {
                    return refuse(format!("No specialist with id '{}'. Call list_specialists, or omit agent_id.", id))
                }
            },
            _ => None,
        };

        // Create the linked child + run it.
        let child = self
            .store
            .create_subagent_task(NewSubagent {
                prompt: params.prompt.clone(),
                parent_task_id: task_id.to_string(),
                root_task_id: root_task_id.clone(),
                depth,
                specialist_definition_id: specialist_id.clone(),
                delegation_label: params.label.clone(),
            })
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("failed to create child task: {}", e)))?;

        info!(
            parent = %task_id, child = %child.id, specialist = ?specialist_id, depth,
            "delegating sub-job to child agent"
        );

        self.executor
            .spawn_task(child.id.clone())
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("failed to spawn child agent: {}", e)))?;

        // Await the child (permit released by the loop while we park here). If the
        // parent is cancelled, cancel propagation drives the child to a terminal
        // state, which ends this wait.
        let timeout = Duration::from_secs(params.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECS));
        let started = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            let current = match self.store.get_task(&child.id).await {
                Ok(t) => t,
                Err(e) => {
                    warn!(child = %child.id, "failed to poll child: {}", e);
                    continue;
                }
            };
            if is_terminal(&current.status) {
                return Ok(ToolOutput::success(json!({
                    "delegated": true,
                    "child_id": child.id,
                    "specialist_id": specialist_id,
                    "status": current.status.as_str(),
                    "result": current.result_json,
                    "error": current.error_message,
                })));
            }
            if started.elapsed() > timeout {
                return Ok(ToolOutput::success(json!({
                    "delegated": true,
                    "child_id": child.id,
                    "status": "running",
                    "note": format!(
                        "Child still running after {}s; it continues in the background — \
                         check the workflow for its result.",
                        timeout.as_secs()
                    ),
                })));
            }
        }
    }
}

impl DelegateAgentTool {
    /// Returns Some(enabled) if a definition with `id` exists, else None.
    async fn provider_definition(&self, id: &str) -> Option<bool> {
        self.provider
            .get_agent_definition(id)
            .await
            .ok()
            .flatten()
            .map(|d| d.enabled)
    }
}
