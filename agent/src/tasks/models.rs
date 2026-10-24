//! Task models for AI agent tasks
//!
//! Defines the core types for task persistence and status tracking.

use serde::{Deserialize, Serialize};

/// Task status enum matching database CHECK constraint
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    /// Get the string representation of the status
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Running => "running",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    /// Parse a status from string
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(TaskStatus::Pending),
            "running" => Some(TaskStatus::Running),
            "completed" => Some(TaskStatus::Completed),
            "failed" => Some(TaskStatus::Failed),
            "cancelled" => Some(TaskStatus::Cancelled),
            _ => None,
        }
    }

    /// Check if status transition is valid
    ///
    /// Valid transitions:
    /// - pending -> running, cancelled
    /// - running -> completed, failed, cancelled
    /// - completed, failed, cancelled are terminal (no transitions out)
    pub fn can_transition_to(&self, next: &TaskStatus) -> bool {
        match (self, next) {
            // From pending: can start running or be cancelled
            (TaskStatus::Pending, TaskStatus::Running) => true,
            (TaskStatus::Pending, TaskStatus::Cancelled) => true,
            // From running: can complete, fail, or be cancelled
            (TaskStatus::Running, TaskStatus::Completed) => true,
            (TaskStatus::Running, TaskStatus::Failed) => true,
            (TaskStatus::Running, TaskStatus::Cancelled) => true,
            // Terminal states cannot transition
            _ => false,
        }
    }

    /// Check if this is a terminal state
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        )
    }
}

/// Agent task record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: String,
    pub prompt: String,
    pub status: TaskStatus,
    pub progress_pct: i32,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_definition_id: Option<String>,
    // Sub-agent orchestration linkage (Phase 1). All optional/defaulted so
    // existing rows and wire payloads stay valid.
    /// Immediate parent run (None = top-level / root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    /// Top of the delegation tree (denormalized for cheap subtree fetch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_task_id: Option<String>,
    /// 0 = root; incremented per delegation level (enforced vs MAX_DEPTH).
    #[serde(default)]
    pub depth: i32,
    /// The specialist definition this child was delegated to (None = ephemeral).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by_agent_definition_id: Option<String>,
    /// Short human label the parent gave the sub-job ("check BGP on core").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_label: Option<String>,
}

/// What the ReAct loop does when a tool call fails (the tool returns an error
/// or reports `success: false`). Wire values match the frontend's
/// `FailurePolicy` type (`frontend/src/types/tasks.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailurePolicyKind {
    /// Fail the task on the first tool failure.
    Stop,
    /// Hand the failure back to the model and keep reasoning. This is what
    /// tasks have always done, so it is the default when no policy is sent.
    #[default]
    Continue,
    /// Re-run the failing call up to `retry_count` more times, then fail the
    /// task if it still fails.
    Retry,
}

/// Per-task failure-handling policy (`{"policy": "...", "retry_count": N}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
pub struct FailurePolicy {
    pub policy: FailurePolicyKind,
    /// Retries after the first attempt (`retry` only). Default 1, capped at
    /// [`MAX_TOOL_RETRIES`].
    #[serde(default)]
    pub retry_count: Option<u32>,
}

/// Upper bound on `retry_count`, so a bad request can't spin a tool forever.
pub const MAX_TOOL_RETRIES: u32 = 5;

impl FailurePolicy {
    /// How many times a failing call is attempted in total. Parking tools
    /// (ask_user, delegate_to_agent) wait on a human or a child agent, so
    /// re-running them would re-ask the question; they get one attempt.
    pub fn attempts(&self, parks: bool) -> u32 {
        match self.policy {
            FailurePolicyKind::Retry if !parks => {
                1 + self.retry_count.unwrap_or(1).min(MAX_TOOL_RETRIES)
            }
            _ => 1,
        }
    }

    /// Whether a tool failure that survived its attempts ends the task.
    pub fn fails_task(&self) -> bool {
        !matches!(self.policy, FailurePolicyKind::Continue)
    }
}

/// Request to create a new task
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTaskRequest {
    pub prompt: String,
    /// Per-task failure-handling policy; absent means
    /// [`FailurePolicyKind::Continue`]. Not persisted: the executor receives
    /// it at spawn time (`AgentTaskExecutor::spawn_task_with_policy`).
    #[serde(default)]
    pub failure_policy: Option<FailurePolicy>,
}

/// Request to update task status/progress
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTaskRequest {
    pub status: Option<TaskStatus>,
    pub progress_pct: Option<i32>,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
}

/// One durable transcript step for the glass-box view (Feature A).
/// kind ∈ "thought" | "command" | "tool_result" | "error" | "status".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub id: String,
    pub task_id: String,
    pub seq: i64,
    pub iteration: i32,
    pub kind: String,
    pub tool_name: Option<String>,
    pub content: String,
    pub created_at: String,
}

/// Insert request for a transcript step. seq/id/created_at are assigned by the store.
#[derive(Debug, Clone)]
pub struct CreateTaskMessageRequest {
    pub iteration: i32,
    pub kind: String,
    pub tool_name: Option<String>,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_transitions() {
        // Pending can transition to running or cancelled
        assert!(TaskStatus::Pending.can_transition_to(&TaskStatus::Running));
        assert!(TaskStatus::Pending.can_transition_to(&TaskStatus::Cancelled));
        assert!(!TaskStatus::Pending.can_transition_to(&TaskStatus::Completed));
        assert!(!TaskStatus::Pending.can_transition_to(&TaskStatus::Failed));

        // Running can transition to completed, failed, or cancelled
        assert!(TaskStatus::Running.can_transition_to(&TaskStatus::Completed));
        assert!(TaskStatus::Running.can_transition_to(&TaskStatus::Failed));
        assert!(TaskStatus::Running.can_transition_to(&TaskStatus::Cancelled));
        assert!(!TaskStatus::Running.can_transition_to(&TaskStatus::Pending));

        // Terminal states cannot transition
        assert!(!TaskStatus::Completed.can_transition_to(&TaskStatus::Running));
        assert!(!TaskStatus::Failed.can_transition_to(&TaskStatus::Running));
        assert!(!TaskStatus::Cancelled.can_transition_to(&TaskStatus::Running));
    }

    #[test]
    fn test_status_is_terminal() {
        assert!(!TaskStatus::Pending.is_terminal());
        assert!(!TaskStatus::Running.is_terminal());
        assert!(TaskStatus::Completed.is_terminal());
        assert!(TaskStatus::Failed.is_terminal());
        assert!(TaskStatus::Cancelled.is_terminal());
    }

    #[test]
    fn failure_policy_parses_frontend_shapes() {
        let req: CreateTaskRequest = serde_json::from_str(
            r#"{"prompt":"p","failure_policy":{"policy":"retry","retry_count":3}}"#,
        )
        .unwrap();
        let policy = req.failure_policy.unwrap();
        assert_eq!(policy.policy, FailurePolicyKind::Retry);
        assert_eq!(policy.attempts(false), 4);
        assert_eq!(policy.attempts(true), 1, "parking tools are never re-run");
        assert!(policy.fails_task());

        let req: CreateTaskRequest =
            serde_json::from_str(r#"{"prompt":"p","failure_policy":{"policy":"stop"}}"#).unwrap();
        let policy = req.failure_policy.unwrap();
        assert_eq!(policy.attempts(false), 1);
        assert!(policy.fails_task());

        let req: CreateTaskRequest = serde_json::from_str(r#"{"prompt":"p"}"#).unwrap();
        let policy = req.failure_policy.unwrap_or_default();
        assert_eq!(policy.policy, FailurePolicyKind::Continue);
        assert!(!policy.fails_task());

        assert!(serde_json::from_str::<CreateTaskRequest>(
            r#"{"prompt":"p","failure_policy":{"policy":"explode"}}"#
        )
        .is_err());
    }

    #[test]
    fn retry_count_defaults_and_is_capped() {
        let retry = |n| FailurePolicy { policy: FailurePolicyKind::Retry, retry_count: n };
        assert_eq!(retry(None).attempts(false), 2);
        assert_eq!(retry(Some(0)).attempts(false), 1);
        assert_eq!(retry(Some(1000)).attempts(false), 1 + MAX_TOOL_RETRIES);
    }

    #[test]
    fn test_status_roundtrip() {
        for status in [
            TaskStatus::Pending,
            TaskStatus::Running,
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
        ] {
            let s = status.as_str();
            let parsed = TaskStatus::from_str(s).unwrap();
            assert_eq!(status, parsed);
        }
    }
}
