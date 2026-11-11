//! Task store for CRUD operations on agent tasks
//!
//! Provides persistence layer for AI agent tasks using SQLite.

use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::{AgentTask, CreateTaskRequest, TaskStatus, UpdateTaskRequest};

/// Spec for creating a sub-agent (child) task linked to its parent. A specialist
/// child sets `specialist_definition_id` (it also drives execution — the child
/// runs with that definition's prompt); an ephemeral child leaves it None.
pub struct NewSubagent {
    pub prompt: String,
    pub parent_task_id: String,
    pub root_task_id: String,
    pub depth: i32,
    pub specialist_definition_id: Option<String>,
    pub delegation_label: Option<String>,
}

/// Task store errors
#[derive(Debug, thiserror::Error)]
pub enum TaskStoreError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Task not found: {0}")]
    NotFound(String),
    #[error("Invalid status transition: {0} -> {1}")]
    InvalidTransition(String, String),
}

/// Task store for CRUD operations
#[derive(Clone)]
pub struct TaskStore {
    pool: SqlitePool,
}

const SELECT_COLUMNS: &str = "id, prompt, status, progress_pct, result_json, error_message, created_at, updated_at, started_at, completed_at, agent_definition_id, parent_task_id, root_task_id, depth, spawned_by_agent_definition_id, delegation_label";

type TaskRow = (
    String,
    String,
    String,
    i32,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    // Sub-agent orchestration linkage
    Option<String>, // parent_task_id
    Option<String>, // root_task_id
    i32,            // depth
    Option<String>, // spawned_by_agent_definition_id
    Option<String>, // delegation_label
);

fn row_to_task(row: TaskRow) -> AgentTask {
    AgentTask {
        id: row.0,
        prompt: row.1,
        status: TaskStatus::from_str(&row.2).unwrap_or(TaskStatus::Pending),
        progress_pct: row.3,
        result_json: row.4,
        error_message: row.5,
        created_at: row.6,
        updated_at: row.7,
        started_at: row.8,
        completed_at: row.9,
        agent_definition_id: row.10,
        parent_task_id: row.11,
        root_task_id: row.12,
        depth: row.13,
        spawned_by_agent_definition_id: row.14,
        delegation_label: row.15,
    }
}

const MSG_SELECT_COLUMNS: &str =
    "id, task_id, seq, iteration, kind, tool_name, content, created_at";

type TaskMessageRow = (
    String,         // id
    String,         // task_id
    i64,            // seq
    i32,            // iteration
    String,         // kind
    Option<String>, // tool_name
    String,         // content
    String,         // created_at
);

fn row_to_message(row: TaskMessageRow) -> super::models::TaskMessage {
    super::models::TaskMessage {
        id: row.0,
        task_id: row.1,
        seq: row.2,
        iteration: row.3,
        kind: row.4,
        tool_name: row.5,
        content: row.6,
        created_at: row.7,
    }
}

impl TaskStore {
    /// Create a new task store
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Create a new task
    pub async fn create_task(&self, req: CreateTaskRequest) -> Result<AgentTask, TaskStoreError> {
        self.create_task_with_agent(req, None).await
    }

    /// Create a new task with an optional agent definition ID
    pub async fn create_task_with_agent(&self, req: CreateTaskRequest, agent_definition_id: Option<String>) -> Result<AgentTask, TaskStoreError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r#"INSERT INTO agent_tasks (id, prompt, status, progress_pct, created_at, updated_at, agent_definition_id)
               VALUES (?, ?, 'pending', 0, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(&req.prompt)
        .bind(&now)
        .bind(&now)
        .bind(&agent_definition_id)
        .execute(&self.pool)
        .await?;

        self.get_task(&id).await
    }

    /// Create a child (sub-agent) task linked to its parent. The specialist id (if
    /// any) is written to BOTH `agent_definition_id` (so the child executes with
    /// that definition) and `spawned_by_agent_definition_id` (delegation marker).
    pub async fn create_subagent_task(&self, spec: NewSubagent) -> Result<AgentTask, TaskStoreError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            r#"INSERT INTO agent_tasks
               (id, prompt, status, progress_pct, created_at, updated_at,
                agent_definition_id, parent_task_id, root_task_id, depth,
                spawned_by_agent_definition_id, delegation_label)
               VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(&spec.prompt)
        .bind(&now)
        .bind(&now)
        .bind(&spec.specialist_definition_id)
        .bind(&spec.parent_task_id)
        .bind(&spec.root_task_id)
        .bind(spec.depth)
        .bind(&spec.specialist_definition_id)
        .bind(&spec.delegation_label)
        .execute(&self.pool)
        .await?;

        self.get_task(&id).await
    }

    /// Number of direct children of a task (for fan-out limits).
    pub async fn count_children(&self, parent_task_id: &str) -> Result<i64, TaskStoreError> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agent_tasks WHERE parent_task_id = ?")
            .bind(parent_task_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0)
    }

    /// Total tasks in a delegation tree (for whole-tree spawn limits).
    pub async fn count_descendants(&self, root_task_id: &str) -> Result<i64, TaskStoreError> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agent_tasks WHERE root_task_id = ?")
            .bind(root_task_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0)
    }

    /// Direct child task ids of a task (for recursive cancel propagation).
    pub async fn children_of(&self, parent_task_id: &str) -> Result<Vec<String>, TaskStoreError> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT id FROM agent_tasks WHERE parent_task_id = ?")
            .bind(parent_task_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    /// Get a task by ID
    pub async fn get_task(&self, id: &str) -> Result<AgentTask, TaskStoreError> {
        let query = format!("SELECT {} FROM agent_tasks WHERE id = ?", SELECT_COLUMNS);
        let row: TaskRow = sqlx::query_as(&query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| TaskStoreError::NotFound(id.to_string()))?;

        Ok(row_to_task(row))
    }

    /// Update task status and/or progress
    pub async fn update_task(
        &self,
        id: &str,
        req: UpdateTaskRequest,
    ) -> Result<AgentTask, TaskStoreError> {
        let current = self.get_task(id).await?;
        let now = Utc::now().to_rfc3339();

        // Validate status transition if status is being updated
        if let Some(ref new_status) = req.status {
            if !current.status.can_transition_to(new_status) {
                return Err(TaskStoreError::InvalidTransition(
                    current.status.as_str().to_string(),
                    new_status.as_str().to_string(),
                ));
            }
        }

        let new_status = req
            .status
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or(current.status.as_str());
        let new_progress = req.progress_pct.unwrap_or(current.progress_pct);

        // Set started_at when transitioning to running
        let started_at = if new_status == "running" && current.started_at.is_none() {
            Some(now.clone())
        } else {
            current.started_at.clone()
        };

        // Set completed_at when transitioning to a terminal state
        let completed_at =
            if matches!(new_status, "completed" | "failed" | "cancelled")
                && current.completed_at.is_none()
            {
                Some(now.clone())
            } else {
                current.completed_at.clone()
            };

        sqlx::query(
            r#"UPDATE agent_tasks
               SET status = ?, progress_pct = ?, result_json = COALESCE(?, result_json),
                   error_message = COALESCE(?, error_message), updated_at = ?,
                   started_at = ?, completed_at = ?
               WHERE id = ?"#,
        )
        .bind(new_status)
        .bind(new_progress)
        .bind(&req.result_json)
        .bind(&req.error_message)
        .bind(&now)
        .bind(&started_at)
        .bind(&completed_at)
        .bind(id)
        .execute(&self.pool)
        .await?;

        self.get_task(id).await
    }

    /// List tasks with optional status filter
    pub async fn list_tasks(
        &self,
        status: Option<TaskStatus>,
        limit: i32,
        offset: i32,
    ) -> Result<Vec<AgentTask>, TaskStoreError> {
        let rows: Vec<TaskRow> = if let Some(status) = status {
            let query = format!("SELECT {} FROM agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", SELECT_COLUMNS);
            sqlx::query_as(&query)
                .bind(status.as_str())
                .bind(limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?
        } else {
            let query = format!("SELECT {} FROM agent_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?", SELECT_COLUMNS);
            sqlx::query_as(&query)
                .bind(limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?
        };

        Ok(rows.into_iter().map(row_to_task).collect())
    }

    /// Delete a task (for cleanup or cancellation)
    pub async fn delete_task(&self, id: &str) -> Result<(), TaskStoreError> {
        let result = sqlx::query("DELETE FROM agent_tasks WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(TaskStoreError::NotFound(id.to_string()));
        }

        Ok(())
    }

    /// Count tasks by status (for concurrency limiting)
    pub async fn _count_by_status(&self, status: TaskStatus) -> Result<i64, TaskStoreError> {
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM agent_tasks WHERE status = ?")
                .bind(status.as_str())
                .fetch_one(&self.pool)
                .await?;

        Ok(count.0)
    }

    /// Append a transcript step for a task. Assigns the next per-task `seq`
    /// (max(seq)+1) and returns the persisted message. Feature A.
    pub async fn create_message(
        &self,
        task_id: &str,
        req: super::models::CreateTaskMessageRequest,
    ) -> Result<super::models::TaskMessage, TaskStoreError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        // Next seq for this task. COALESCE handles the first row (NULL -> 0).
        let next_seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM task_messages WHERE task_id = ?",
        )
        .bind(task_id)
        .fetch_one(&self.pool)
        .await?;

        sqlx::query(
            r#"INSERT INTO task_messages
               (id, task_id, seq, iteration, kind, tool_name, content, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(task_id)
        .bind(next_seq)
        .bind(req.iteration)
        .bind(&req.kind)
        .bind(&req.tool_name)
        .bind(&req.content)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(super::models::TaskMessage {
            id,
            task_id: task_id.to_string(),
            seq: next_seq,
            iteration: req.iteration,
            kind: req.kind,
            tool_name: req.tool_name,
            content: req.content,
            created_at: now,
        })
    }

    /// List transcript steps for a task with seq strictly greater than
    /// `since_seq` (pass -1 to get all), ordered ascending. Feature A.
    pub async fn list_messages(
        &self,
        task_id: &str,
        since_seq: i64,
    ) -> Result<Vec<super::models::TaskMessage>, TaskStoreError> {
        let query = format!(
            "SELECT {} FROM task_messages WHERE task_id = ? AND seq > ? ORDER BY seq ASC",
            MSG_SELECT_COLUMNS
        );
        let rows: Vec<TaskMessageRow> = sqlx::query_as(&query)
            .bind(task_id)
            .bind(since_seq)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(row_to_message).collect())
    }

    /// Persist a pending interaction BEFORE the task parks on it (Feature B).
    #[allow(clippy::too_many_arguments)]
    pub async fn create_interaction(
        &self,
        id: &str,
        task_id: &str,
        kind: &str,
        prompt: &str,
        choices_json: Option<&str>,
        tool_name: Option<&str>,
        tool_input_json: Option<&str>,
        diff: Option<&str>,
    ) -> Result<(), TaskStoreError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO task_interactions \
             (id, task_id, kind, status, prompt, choices_json, tool_name, tool_input_json, diff, created_at) \
             VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
        )
        .bind(id).bind(task_id).bind(kind).bind(prompt)
        .bind(choices_json).bind(tool_name).bind(tool_input_json).bind(diff).bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Mark an interaction resolved (or expired) once the human responds or it
    /// times out. `response_json` is None for expired/timed-out. Feature B.
    pub async fn resolve_interaction(
        &self,
        id: &str,
        status: &str, // "resolved" | "expired"
        response_json: Option<&str>,
    ) -> Result<(), TaskStoreError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE task_interactions SET status = ?, response_json = ?, resolved_at = ? WHERE id = ?",
        )
        .bind(status).bind(response_json).bind(&now).bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// STARTUP RECOVERY: any interaction left 'pending' after a restart is
    /// orphaned (its in-memory oneshot is gone). Fail-closed: mark expired so
    /// the agent never resumes a stale park. Returns the count expired. Feature B.
    pub async fn expire_orphaned_interactions(&self) -> Result<u64, TaskStoreError> {
        let res = sqlx::query(
            "UPDATE task_interactions SET status = 'expired', resolved_at = datetime('now') \
             WHERE status = 'pending'",
        )
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }
}
