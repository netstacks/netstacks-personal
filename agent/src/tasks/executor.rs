//! Agent task executor for background task execution
//!
//! Spawns background Tokio tasks with concurrency control via semaphore.
//! Uses the ReAct loop to execute tasks with Claude API and network tools.
//! Also integrates enabled MCP tools from connected MCP servers.

use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::models::{FailurePolicy, TaskStatus, UpdateTaskRequest};
use super::progress::{ProgressBroadcaster, TaskProgressEvent};
use super::react::{execute_react_loop_with_agent, ReactError, ReactTask};
use super::registry::TaskRegistry;
use super::store::TaskStore;
use super::tools::{
    AskUserTool, DelegateAgentTool, DeviceQueryTool, EditFileTool, ListSpecialistsTool,
    MopAnalysisTool, MopExecutionTool, MopPlanTool, PatchFileTool, SaveDocumentTool, SendEmailTool,
    SharedTool, SshCommandTool, ToolRegistry, WriteFileTool,
};
use crate::ai::config_mode::ConfigModeHandle;
use crate::ai::sanitizer::Sanitizer;
use crate::integrations::{McpClientManager, McpToolWrapper};
use crate::providers::DataProvider;

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
    /// Live AI config-mode state (shared with the API) — lifts the read-only
    /// device-command rule for the SSH tool and the permission resolver.
    config_mode: ConfigModeHandle,
}

/// Shared services an [`AgentTaskExecutor`] is built from (one per process).
pub struct AgentTaskExecutorDeps {
    pub store: TaskStore,
    pub registry: Arc<TaskRegistry>,
    pub broadcaster: ProgressBroadcaster,
    pub pool: SqlitePool,
    pub provider: Arc<dyn DataProvider>,
    pub mcp_manager: Arc<RwLock<McpClientManager>>,
    pub sanitizer: Arc<RwLock<Option<Sanitizer>>>,
    pub config_mode: ConfigModeHandle,
}

impl AgentTaskExecutor {
    pub fn new(deps: AgentTaskExecutorDeps) -> Self {
        let AgentTaskExecutorDeps {
            store,
            registry,
            broadcaster,
            pool,
            provider,
            mcp_manager,
            sanitizer,
            config_mode,
        } = deps;
        Self {
            // Evaluate the clone before `store` is moved by the shorthand below.
            approval_service: super::approvals::TaskApprovalService::new(store.clone()),
            store,
            registry,
            broadcaster,
            pool,
            provider,
            mcp_manager,
            sanitizer,
            config_mode,
        }
    }

    /// Spawn a task for background execution
    ///
    /// Returns immediately after spawning. Task runs in background Tokio task.
    /// Use TaskStore or WebSocket events to track progress.
    pub async fn spawn_task(self: &Arc<Self>, task_id: String) -> Result<(), ExecutorError> {
        self.spawn_task_with_policy(task_id, FailurePolicy::default()).await
    }

    /// [`Self::spawn_task`] with an explicit tool-failure policy (from the
    /// `failure_policy` field of `POST /tasks`).
    pub async fn spawn_task_with_policy(
        self: &Arc<Self>,
        task_id: String,
        failure_policy: FailurePolicy,
    ) -> Result<(), ExecutorError> {
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

        // The semaphore permit is acquired INSIDE the spawned task (below), so
        // this returns immediately even when the pool is full (NS-API-8).
        let semaphore = self.registry.semaphore();

        // Create cancellation token for this task. It also aborts the queued
        // wait for a slot, so a queued task can be cancelled without running.
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
        let config_mode = self.config_mode.clone();
        // Self-handle so the delegate_to_agent tool can spawn child agents.
        let executor = self.clone();

        // The task must not be able to `unregister` before `register` below has
        // run (a task that finishes instantly could otherwise leave a stale
        // handle in the registry — NS-AGENT-13). Gate the body on this signal.
        let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();

        // Spawn the background task
        let join_handle = tokio::spawn(async move {
            // Registration happens right after spawn; a dropped sender (spawn_task
            // bailed out) just means we proceed without the gate.
            let _ = registered_rx.await;
            // Wait for a concurrency slot here — not in the HTTP handler — so
            // `POST /tasks` returns the pending row at once (NS-API-8).
            let permit = match acquire_slot(&semaphore, &cancel_token_clone).await {
                Ok(p) => p,
                Err(SlotWaitError::Cancelled) => {
                    info!("Task {} cancelled while queued for a slot", task_id_clone);
                    if let Err(e) = mark_cancelled_before_execution(&store, &task_id_clone).await {
                        warn!(
                            "Task {}: failed to record queued cancellation: {}",
                            task_id_clone, e
                        );
                    }
                    registry.unregister(&task_id_clone).await;
                    return;
                }
                Err(SlotWaitError::SemaphoreClosed) => {
                    error!(
                        "Task {} could not start: executor semaphore closed",
                        task_id_clone
                    );
                    registry.unregister(&task_id_clone).await;
                    return;
                }
            };

            // Hold the permit for real work; the guard lets the react loop
            // RELEASE the slot while parked on a human decision and RE-ACQUIRE
            // it (cancel-aware) before resuming. Feature B permit-release.
            let mut permit_guard = super::PermitGuard::new(semaphore, permit);

            // Load agent definition if this task references one
            let agent_definition = if let Some(ref def_id) = agent_definition_id {
                match provider.get_agent_definition(def_id).await {
                    Ok(Some(def)) => {
                        info!(
                            "Task {} using agent definition: {} ({})",
                            task_id_clone, def.name, def_id
                        );
                        Some(def)
                    }
                    Ok(None) => {
                        warn!(
                            "Task {} references missing agent definition: {}",
                            task_id_clone, def_id
                        );
                        None
                    }
                    Err(e) => {
                        warn!(
                            "Failed to load agent definition {} for task {}: {}",
                            def_id, task_id_clone, e
                        );
                        None
                    }
                }
            } else {
                None
            };

            // Build tool registry with network tools
            let mut tool_registry = ToolRegistry::new();
            tool_registry.register(Arc::new(SshCommandTool::new(provider.clone(), config_mode.clone())));
            tool_registry.register(Arc::new(DeviceQueryTool::new(pool.clone())));
            tool_registry.register(Arc::new(SendEmailTool::new(pool.clone())));
            tool_registry.register(Arc::new(MopPlanTool::new(pool.clone())));
            tool_registry.register(Arc::new(MopExecutionTool::new(pool.clone())));
            tool_registry.register(Arc::new(MopAnalysisTool::new(pool.clone())));
            // Feature B: ask_user lets the agent pause and ask a clarifying
            // question. Clone the approval service (it's moved into the react
            // loop below). It IS the user prompt, so it is never gated.
            tool_registry.register(Arc::new(AskUserTool::new(approval_service.clone())));
            // Save artifacts (reports/configs/notes) as app documents the user
            // can open in a tab + split-view.
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

            // The task's permission settings at start: the write tools are
            // registered only with AI terminal mode on, and tools disabled for
            // Auto Pilot are not offered at all. The react loop re-resolves
            // every call against the live settings.
            let permissions =
                super::permissions::PermissionContext::load(&provider, &config_mode).await;

            if permissions.terminal_mode {
                tool_registry.register(Arc::new(WriteFileTool::new(provider.clone())));
                tool_registry.register(Arc::new(EditFileTool::new(provider.clone())));
                tool_registry.register(Arc::new(PatchFileTool::new(provider.clone())));
                tracing::info!("AI terminal mode enabled — write tools registered");
            }

            // Load and register enabled MCP tools
            let mcp_tools = load_enabled_mcp_tools(&pool, mcp_manager).await;
            for tool in mcp_tools {
                tool_registry.register(tool);
            }
            tool_registry.retain(|name| !permissions.disables(name));

            let tool_registry = Arc::new(tool_registry);

            // Run the ReAct loop
            let react_task = ReactTask {
                task_id: &task_id_clone,
                prompt: &prompt,
                store: &store,
                registry: tool_registry,
                broadcaster: &broadcaster,
                cancel_token: cancel_token_clone,
                data_provider: provider,
                approval_service,
                config_mode,
                failure_policy,
            };
            let result =
                execute_task_with_react(&react_task, agent_definition, sanitizer, &mut permit_guard)
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
        // Registered — let the task body run (NS-AGENT-13).
        let _ = registered_tx.send(());

        info!("Spawned task {} for background execution", task_id);
        Ok(())
    }

    /// Cancel a task AND its entire sub-agent subtree (breadth-first), so a
    /// parent awaiting a child doesn't hang and orphaned children don't run on.
    pub async fn cancel_task(&self, task_id: &str) -> Result<(), ExecutorError> {
        cancel_subtree(&self.store, &self.registry, task_id).await
    }

    /// Cancel-only (`POST /tasks/:id/cancel`): cancel the task and its
    /// subtree but keep the record, unlike `DELETE /tasks/:id`.
    pub async fn cancel_keep_record(&self, task_id: &str) -> Result<CancelOutcome, ExecutorError> {
        cancel_keep_record(&self.store, &self.registry, task_id).await
    }
}

/// Result of a cancel-only request.
#[derive(Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// No task with that id.
    NotFound,
    /// The task had already finished; nothing was changed.
    AlreadyFinished(TaskStatus),
    /// Cancellation was signalled; the status read back afterwards.
    Cancelled(TaskStatus),
}

/// How long a cancel-only request waits for a running task's loop to record
/// the cancellation (the loop is `select!`-aware, so this is normally quick).
const CANCEL_SETTLE_POLLS: u32 = 20;
const CANCEL_SETTLE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

async fn cancel_keep_record(
    store: &TaskStore,
    registry: &TaskRegistry,
    task_id: &str,
) -> Result<CancelOutcome, ExecutorError> {
    let task = match store.get_task(task_id).await {
        Ok(task) => task,
        Err(super::store::TaskStoreError::NotFound(_)) => return Ok(CancelOutcome::NotFound),
        Err(e) => return Err(ExecutorError::StoreError(e.to_string())),
    };
    if task.status.is_terminal() {
        return Ok(CancelOutcome::AlreadyFinished(task.status));
    }
    cancel_subtree(store, registry, task_id).await?;

    let mut status = task.status;
    for _ in 0..CANCEL_SETTLE_POLLS {
        status = store
            .get_task(task_id)
            .await
            .map_err(|e| ExecutorError::StoreError(e.to_string()))?
            .status;
        if status.is_terminal() {
            break;
        }
        tokio::time::sleep(CANCEL_SETTLE_INTERVAL).await;
    }
    Ok(CancelOutcome::Cancelled(status))
}

/// Cancel `task_id` and every descendant sub-agent task.
async fn cancel_subtree(
    store: &TaskStore,
    registry: &TaskRegistry,
    task_id: &str,
) -> Result<(), ExecutorError> {
    let mut queue = vec![task_id.to_string()];
    while let Some(id) = queue.pop() {
        match store.children_of(&id).await {
            Ok(kids) => queue.extend(kids),
            Err(e) => warn!("cancel: failed to list children of {}: {}", id, e),
        }
        cancel_one(store, registry, &id).await?;
    }
    Ok(())
}

/// Cancel a single task: signal a running task, or mark a pending one cancelled.
async fn cancel_one(
    store: &TaskStore,
    registry: &TaskRegistry,
    task_id: &str,
) -> Result<(), ExecutorError> {
    // Signal cancellation
    if !registry.cancel(task_id).await {
        // Task not running - check if it exists and update status if pending
        let task = store
            .get_task(task_id)
            .await
            .map_err(|e| ExecutorError::StoreError(e.to_string()))?;

        if task.status == TaskStatus::Pending {
            mark_cancelled_before_execution(store, task_id).await?;
        }
    }

    Ok(())
}

/// Why a queued task never got its concurrency slot.
#[derive(Debug, PartialEq, Eq)]
enum SlotWaitError {
    /// The task was cancelled while waiting in the queue.
    Cancelled,
    /// The registry semaphore was closed.
    SemaphoreClosed,
}

/// Wait for a concurrency slot, giving up as soon as `cancel_token` fires so a
/// queued task can be cancelled without ever running (NS-API-8).
async fn acquire_slot(
    semaphore: &Arc<tokio::sync::Semaphore>,
    cancel_token: &CancellationToken,
) -> Result<tokio::sync::OwnedSemaphorePermit, SlotWaitError> {
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => Err(SlotWaitError::Cancelled),
        res = semaphore.clone().acquire_owned() => res.map_err(|_| SlotWaitError::SemaphoreClosed),
    }
}

/// Record that a task was cancelled before its ReAct loop ever started.
async fn mark_cancelled_before_execution(
    store: &TaskStore,
    task_id: &str,
) -> Result<(), ExecutorError> {
    store
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
        .map(|_| ())
        .map_err(|e| ExecutorError::StoreError(e.to_string()))
}

/// Executor errors
#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("Store error: {0}")]
    StoreError(String),
    #[error("Invalid state: {0}")]
    InvalidState(String),
    #[error("Execution error: {0}")]
    _ExecutionError(String),
}

/// Execute a task using the ReAct loop with Claude API
async fn execute_task_with_react(
    task: &ReactTask<'_>,
    agent_definition: Option<crate::models::AgentDefinition>,
    sanitizer: Arc<RwLock<Option<Sanitizer>>>,
    permit_guard: &mut super::PermitGuard,
) -> Result<(), ExecutorError> {
    let store = task.store;
    let broadcaster = task.broadcaster;
    let task_id = task.task_id;
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
    // AUDIT FIX (EXEC-017): pass the approval service + config-mode handle so
    // every tool call is resolved against the user's permission settings.
    let result =
        execute_react_loop_with_agent(task, agent_definition, sanitizer, permit_guard).await;

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
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            Option<String>,
            String,
        ),
    >(
        r#"SELECT t.id, t.server_id, s.name, s.server_type, t.name, t.description, t.input_schema
           FROM mcp_tools t
           JOIN mcp_servers s ON t.server_id = s.id
           WHERE t.enabled = 1 AND s.enabled = 1"#,
    )
    .fetch_all(pool)
    .await;

    match rows {
        Ok(tools) => {
            let count = tools.len();
            let wrapped: Vec<SharedTool> = tools
                .into_iter()
                .filter_map(
                    |(_id, server_id, server_name, server_type, name, description, schema_str)| {
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
                    },
                )
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

#[cfg(test)]
mod slot_wait_tests {
    use super::{acquire_slot, SlotWaitError};
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn returns_permit_when_slot_is_free() {
        let sem = Arc::new(Semaphore::new(1));
        let permit = acquire_slot(&sem, &CancellationToken::new()).await;
        assert!(permit.is_ok());
        assert_eq!(sem.available_permits(), 0);
        drop(permit);
        assert_eq!(sem.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancellation_while_queued_does_not_take_a_slot() {
        let sem = Arc::new(Semaphore::new(1));
        let _held = sem.clone().acquire_owned().await.unwrap();
        let token = CancellationToken::new();

        let waiter = {
            let sem = sem.clone();
            let token = token.clone();
            tokio::spawn(async move { acquire_slot(&sem, &token).await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        token.cancel();

        assert_eq!(waiter.await.unwrap(), Err(SlotWaitError::Cancelled));
        assert_eq!(sem.available_permits(), 0, "the held slot is untouched");
    }

    #[tokio::test]
    async fn closed_semaphore_is_reported() {
        let sem = Arc::new(Semaphore::new(1));
        sem.close();
        assert_eq!(
            acquire_slot(&sem, &CancellationToken::new())
                .await
                .map(|_| ()),
            Err(SlotWaitError::SemaphoreClosed)
        );
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::{cancel_keep_record, CancelOutcome};
    use crate::tasks::models::{CreateTaskRequest, TaskStatus, UpdateTaskRequest};
    use crate::tasks::registry::TaskRegistry;
    use crate::tasks::store::TaskStore;
    use tokio_util::sync::CancellationToken;

    async fn fresh_store() -> (TaskStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(&dir.path().join("test.db")).await.unwrap();
        (TaskStore::new(pool), dir)
    }

    async fn new_task(store: &TaskStore) -> String {
        store
            .create_task(CreateTaskRequest {
                prompt: "p".into(),
                failure_policy: None,
            })
            .await
            .unwrap()
            .id
    }

    async fn set_status(store: &TaskStore, id: &str, status: TaskStatus) {
        store
            .update_task(
                id,
                UpdateTaskRequest {
                    status: Some(status),
                    progress_pct: None,
                    result_json: None,
                    error_message: None,
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn unknown_task_is_not_found() {
        let (store, _dir) = fresh_store().await;
        let registry = TaskRegistry::new(1);
        assert_eq!(
            cancel_keep_record(&store, &registry, "nope").await.unwrap(),
            CancelOutcome::NotFound
        );
    }

    #[tokio::test]
    async fn pending_task_is_cancelled_and_kept() {
        let (store, _dir) = fresh_store().await;
        let registry = TaskRegistry::new(1);
        let id = new_task(&store).await;
        assert_eq!(
            cancel_keep_record(&store, &registry, &id).await.unwrap(),
            CancelOutcome::Cancelled(TaskStatus::Cancelled)
        );
        assert_eq!(store.get_task(&id).await.unwrap().status, TaskStatus::Cancelled);
    }

    #[tokio::test]
    async fn finished_task_is_a_conflict_and_untouched() {
        let (store, _dir) = fresh_store().await;
        let registry = TaskRegistry::new(1);
        let id = new_task(&store).await;
        set_status(&store, &id, TaskStatus::Running).await;
        set_status(&store, &id, TaskStatus::Completed).await;
        assert_eq!(
            cancel_keep_record(&store, &registry, &id).await.unwrap(),
            CancelOutcome::AlreadyFinished(TaskStatus::Completed)
        );
        assert_eq!(store.get_task(&id).await.unwrap().status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn running_task_is_signalled_and_status_read_back() {
        let (store, _dir) = fresh_store().await;
        let registry = TaskRegistry::new(1);
        let id = new_task(&store).await;
        set_status(&store, &id, TaskStatus::Running).await;

        // Stand-in for the ReAct loop: records Cancelled once signalled.
        let token = CancellationToken::new();
        let handle = {
            let (store, token, id) = (store.clone(), token.clone(), id.clone());
            tokio::spawn(async move {
                token.cancelled().await;
                set_status(&store, &id, TaskStatus::Cancelled).await;
            })
        };
        registry.register(id.clone(), token.clone(), handle).await;

        assert_eq!(
            cancel_keep_record(&store, &registry, &id).await.unwrap(),
            CancelOutcome::Cancelled(TaskStatus::Cancelled)
        );
        assert!(token.is_cancelled());
        assert!(store.get_task(&id).await.is_ok(), "record is kept");
    }
}
