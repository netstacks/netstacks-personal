//! Agent task executor for background task execution
//!
//! Spawns background Tokio tasks with concurrency control via semaphore.
//! Uses the ReAct loop to execute tasks with Claude API and network tools.
//! Also integrates enabled MCP tools from connected MCP servers.

use std::sync::Arc;
use sqlx::sqlite::SqlitePool;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::ai::sanitizer::Sanitizer;
use crate::integrations::{McpClientManager, McpToolWrapper};
use crate::providers::DataProvider;
use super::models::{TaskStatus, UpdateTaskRequest};
use super::progress::{ProgressBroadcaster, TaskProgressEvent};
use super::react::{execute_react_loop_with_agent, ReactError};
use super::registry::TaskRegistry;
use super::store::TaskStore;
use super::tools::{AskUserTool, DelegateAgentTool, DeviceQueryTool, EditFileTool, ListSpecialistsTool, MopAnalysisTool, MopExecutionTool, MopPlanTool, PatchFileTool, SaveDocumentTool, SendEmailTool, SharedTool, SshCommandTool, ToolRegistry, WriteFileTool};

/// Agent task executor - spawns background tasks with concurrency control
pub struct AgentTaskExecutor {
    store: TaskStore,
    registry: Arc<TaskRegistry>,
    broadcaster: ProgressBroadcaster,
    pool: SqlitePool,
    provider: Arc<dyn DataProvider>,
    /// MCP client manager for invoking external MCP tools
    mcp_manager: Arc<RwLock<McpClientManager>>,
    /// Cached sanitizer for AI data scrubbing
    sanitizer: Arc<RwLock<Option<Sanitizer>>>,
    /// AUDIT FIX (EXEC-017): per-tool-call user approval prompts.
    pub approval_service: Arc<super::approvals::TaskApprovalService>,
}

impl AgentTaskExecutor {
    pub fn new(
        store: TaskStore,
        registry: Arc<TaskRegistry>,
        broadcaster: ProgressBroadcaster,
        pool: SqlitePool,
        provider: Arc<dyn DataProvider>,
        mcp_manager: Arc<RwLock<McpClientManager>>,
        sanitizer: Arc<RwLock<Option<Sanitizer>>>,
    ) -> Self {
        Self {
            // Evaluate the clone before `store` is moved by the shorthand below.
            approval_service: super::approvals::TaskApprovalService::new(store.clone()),
            store, registry, broadcaster, pool, provider, mcp_manager, sanitizer,
        }
    }

    /// Spawn a task for background execution
    ///
    /// Returns immediately after spawning. Task runs in background Tokio task.
    /// Use TaskStore or WebSocket events to track progress.
    pub async fn spawn_task(self: &Arc<Self>, task_id: String) -> Result<(), ExecutorError> {
        // Check if task exists and is pending
        let task = self
            .store
            .get_task(&task_id)
            .await
            .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

        if task.status != TaskStatus::Pending {
            return Err(ExecutorError::InvalidState(format!(
                "Task {} is {:?}, expected Pending",
                task_id, task.status
            )));
        }

        // Acquire semaphore permit (blocks if at capacity)
        let semaphore = self.registry.semaphore();
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ExecutorError::SemaphoreClosed)?;

        // Create cancellation token for this task
        let cancel_token = CancellationToken::new();
        let cancel_token_clone = cancel_token.clone();

        // Clone what we need for the spawned task
        let store = self.store.clone();
        let registry = self.registry.clone();
        let broadcaster = self.broadcaster.clone();
        let task_id_clone = task_id.clone();
        let pool = self.pool.clone();
        let prompt = task.prompt.clone();
        let agent_definition_id = task.agent_definition_id.clone();
        let provider = self.provider.clone();
        let mcp_manager = self.mcp_manager.clone();
        let sanitizer = self.sanitizer.clone();
        let approval_service = self.approval_service.clone();
        // Self-handle so the delegate_to_agent tool can spawn child agents.
        let executor = self.clone();

        // Spawn the background task
        let join_handle = tokio::spawn(async move {
            // Hold the permit for real work; the guard lets the react loop
            // RELEASE the slot while parked on a human decision and RE-ACQUIRE
            // it (cancel-aware) before resuming. Feature B permit-release.
            let mut permit_guard = super::PermitGuard::new(semaphore, permit);

            // Load agent definition if this task references one
            let agent_definition = if let Some(ref def_id) = agent_definition_id {
                match provider.get_agent_definition(def_id).await {
                    Ok(Some(def)) => {
                        info!("Task {} using agent definition: {} ({})", task_id_clone, def.name, def_id);
                        Some(def)
                    }
                    Ok(None) => {
                        warn!("Task {} references missing agent definition: {}", task_id_clone, def_id);
                        None
                    }
                    Err(e) => {
                        warn!("Failed to load agent definition {} for task {}: {}", def_id, task_id_clone, e);
                        None
                    }
                }
            } else {
                None
            };

            // Build tool registry with network tools
            let mut tool_registry = ToolRegistry::new();
            tool_registry.register(Arc::new(SshCommandTool::new(pool.clone())));
            tool_registry.register(Arc::new(DeviceQueryTool::new(pool.clone())));
            tool_registry.register(Arc::new(SendEmailTool::new(pool.clone())));
            tool_registry.register(Arc::new(MopPlanTool::new(pool.clone())));
            tool_registry.register(Arc::new(MopExecutionTool::new(pool.clone())));
            tool_registry.register(Arc::new(MopAnalysisTool::new(pool.clone())));
            // Feature B: ask_user lets the agent pause and ask a clarifying
            // question. Clone the approval service (it's moved into the react
            // loop below). Non-mutating, so it does not gate on approval.
            tool_registry.register(Arc::new(AskUserTool::new(approval_service.clone())));
            // Save artifacts (reports/configs/notes) as app documents the user
            // can open in a tab + split-view. Non-mutating (no device change).
            tool_registry.register(Arc::new(SaveDocumentTool::new(pool.clone())));
            // Sub-agent orchestration: discover specialist agents + delegate a
            // sub-job to a specialist or an ephemeral child (correlated to this
            // run). delegate_to_agent parks (releases its slot) while awaiting.
            tool_registry.register(Arc::new(ListSpecialistsTool::new(provider.clone())));
            tool_registry.register(Arc::new(DelegateAgentTool::new(
                executor.clone(),
                store.clone(),
                provider.clone(),
            )));

            // Register write tools if AI terminal mode is enabled (Professional+ only)
            let ai_terminal_mode_enabled: bool = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key = 'ai.terminal_mode'"
            )
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(false);

            if ai_terminal_mode_enabled {
                tool_registry.register(Arc::new(WriteFileTool::new(pool.clone())));
                tool_registry.register(Arc::new(EditFileTool::new(pool.clone())));
                tool_registry.register(Arc::new(PatchFileTool::new(pool.clone())));
                tracing::info!("AI terminal mode enabled — write tools registered");
            }

            // Load and register enabled MCP tools
            let mcp_tools = load_enabled_mcp_tools(&pool, mcp_manager).await;
            for tool in mcp_tools {
                tool_registry.register(tool);
            }

            let tool_registry = Arc::new(tool_registry);

            // Run the ReAct loop
            let result = execute_task_with_react(
                &store,
                &task_id_clone,
                &prompt,
                tool_registry,
                cancel_token_clone,
                broadcaster,
                provider,
                agent_definition,
                sanitizer,
                approval_service,
                &mut permit_guard,
            )
            .await;

            // Unregister from registry when done
            registry.unregister(&task_id_clone).await;

            if let Err(e) = result {
                error!("Task {} failed: {}", task_id_clone, e);
            }
        });

        // Register the task handle for cancellation support
        self.registry
            .register(task_id.clone(), cancel_token, join_handle)
            .await;

        info!("Spawned task {} for background execution", task_id);
        Ok(())
    }

    /// Cancel a task AND its entire sub-agent subtree (breadth-first), so a
    /// parent awaiting a child doesn't hang and orphaned children don't run on.
    pub async fn cancel_task(&self, task_id: &str) -> Result<(), ExecutorError> {
        let mut queue = vec![task_id.to_string()];
        while let Some(id) = queue.pop() {
            match self.store.children_of(&id).await {
                Ok(kids) => queue.extend(kids),
                Err(e) => warn!("cancel: failed to list children of {}: {}", id, e),
            }
            self.cancel_one(&id).await?;
        }
        Ok(())
    }

    /// Cancel a single task: signal a running task, or mark a pending one cancelled.
    async fn cancel_one(&self, task_id: &str) -> Result<(), ExecutorError> {
        // Signal cancellation
        if !self.registry.cancel(task_id).await {
            // Task not running - check if it exists and update status if pending
            let task = self
                .store
                .get_task(task_id)
                .await
                .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

            if task.status == TaskStatus::Pending {
                self.store
                    .update_task(
                        task_id,
                        UpdateTaskRequest {
                            status: Some(TaskStatus::Cancelled),
                            progress_pct: None,
                            result_json: None,
                            error_message: Some("Cancelled before execution".to_string()),
                        },
                    )
                    .await
                    .map_err(|e| ExecutorError::StoreError(e.to_string()))?;
            }
        }

        Ok(())
    }
}

/// Executor errors
#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("Store error: {0}")]
    StoreError(String),
    #[error("Invalid state: {0}")]
    InvalidState(String),
    #[error("Semaphore closed")]
    SemaphoreClosed,
    #[error("Execution error: {0}")]
    _ExecutionError(String),
}

/// Execute a task using the ReAct loop with Claude API
#[allow(clippy::too_many_arguments)]
async fn execute_task_with_react(
    store: &TaskStore,
    task_id: &str,
    prompt: &str,
    tool_registry: Arc<ToolRegistry>,
    cancel_token: CancellationToken,
    broadcaster: ProgressBroadcaster,
    provider: Arc<dyn DataProvider>,
    agent_definition: Option<crate::models::AgentDefinition>,
    sanitizer: Arc<RwLock<Option<Sanitizer>>>,
    approval_service: Arc<super::approvals::TaskApprovalService>,
    permit_guard: &mut super::PermitGuard,
) -> Result<(), ExecutorError> {
    // Mark task as running
    store
        .update_task(
            task_id,
            UpdateTaskRequest {
                status: Some(TaskStatus::Running),
                progress_pct: Some(0),
                result_json: None,
                error_message: None,
            },
        )
        .await
        .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

    broadcaster.send(TaskProgressEvent::new(
        task_id.to_string(),
        TaskStatus::Running,
        0,
        Some("Task started".to_string()),
    ));

    info!("Task {} started execution", task_id);

    // Execute ReAct loop (with agent definition config if available).
    // AUDIT FIX (EXEC-017): pass the approval service so mutating tools
    // pause for explicit user consent.
    let result = execute_react_loop_with_agent(
        task_id,
        prompt,
        store,
        tool_registry,
        &broadcaster,
        cancel_token,
        provider,
        agent_definition,
        sanitizer,
        approval_service,
        permit_guard,
    )
    .await;

    match result {
        Ok(output) => {
            // Mark as completed
            store
                .update_task(
                    task_id,
                    UpdateTaskRequest {
                        status: Some(TaskStatus::Completed),
                        progress_pct: Some(100),
                        result_json: Some(output.to_string()),
                        error_message: None,
                    },
                )
                .await
                .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

            broadcaster.send(
                TaskProgressEvent::new(
                    task_id.to_string(),
                    TaskStatus::Completed,
                    100,
                    Some("Task completed".to_string()),
                )
                .with_result(output),
            );

            info!("Task {} completed successfully", task_id);
        }
        Err(ReactError::Cancelled) => {
            store
                .update_task(
                    task_id,
                    UpdateTaskRequest {
                        status: Some(TaskStatus::Cancelled),
                        progress_pct: None,
                        result_json: None,
                        error_message: Some("Task cancelled by user".to_string()),
                    },
                )
                .await
                .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

            broadcaster.send(
                TaskProgressEvent::new(
                    task_id.to_string(),
                    TaskStatus::Cancelled,
                    0,
                    Some("Task cancelled".to_string()),
                )
                .with_error("Task cancelled by user".to_string()),
            );

            warn!("Task {} cancelled", task_id);
        }
        Err(e) => {
            let error_msg = e.to_string();
            store
                .update_task(
                    task_id,
                    UpdateTaskRequest {
                        status: Some(TaskStatus::Failed),
                        progress_pct: None,
                        result_json: None,
                        error_message: Some(error_msg.clone()),
                    },
                )
                .await
                .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

            broadcaster.send(
                TaskProgressEvent::new(
                    task_id.to_string(),
                    TaskStatus::Failed,
                    0,
                    Some("Task failed".to_string()),
                )
                .with_error(error_msg.clone()),
            );

            error!("Task {} failed: {}", task_id, error_msg);
        }
    }

    Ok(())
}

/// Load enabled MCP tools from database and wrap them for the tool registry
///
/// Only loads tools that are:
/// 1. Marked as enabled in the mcp_tools table
/// 2. Belong to servers that are enabled in the mcp_servers table
///
/// Tools are wrapped in McpToolWrapper to implement the Tool trait.
async fn load_enabled_mcp_tools(
    pool: &SqlitePool,
    manager: Arc<RwLock<McpClientManager>>,
) -> Vec<SharedTool> {
    // Query enabled tools from enabled servers (include server name and type for AI context)
    let rows = sqlx::query_as::<_, (String, String, String, String, String, Option<String>, String)>(
        r#"SELECT t.id, t.server_id, s.name, s.server_type, t.name, t.description, t.input_schema
           FROM mcp_tools t
           JOIN mcp_servers s ON t.server_id = s.id
           WHERE t.enabled = 1 AND s.enabled = 1"#
    )
    .fetch_all(pool)
    .await;

    match rows {
        Ok(tools) => {
            let count = tools.len();
            let wrapped: Vec<SharedTool> = tools
                .into_iter()
                .filter_map(|(_id, server_id, server_name, server_type, name, description, schema_str)| {
                    // Parse the input schema JSON
                    let schema: serde_json::Value = match serde_json::from_str(&schema_str) {
                        Ok(s) => s,
                        Err(e) => {
                            warn!(
                                tool = %name,
                                server_id = %server_id,
                                error = %e,
                                "Failed to parse MCP tool input schema, skipping"
                            );
                            return None;
                        }
                    };

                    Some(Arc::new(McpToolWrapper::new(
                        server_id,
                        server_name,
                        server_type,
                        name,
                        description,
                        schema,
                        manager.clone(),
                    )) as SharedTool)
                })
                .collect();

            if !wrapped.is_empty() {
                info!(
                    count = count,
                    "Loaded {} enabled MCP tools for task execution",
                    wrapped.len()
                );
            }

            wrapped
        }
        Err(e) => {
            warn!(error = %e, "Failed to load MCP tools from database");
            vec![]
        }
    }
}
