//! Progress broadcasting for task status updates
//!
//! Provides real-time task progress events via broadcast channel
//! for WebSocket streaming to connected clients.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use super::models::TaskStatus;

/// Event sent to WebSocket clients when task progress changes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    /// Event type identifier (always "task_progress")
    #[serde(rename = "type")]
    pub event_type: String,
    /// Task ID this event is for
    pub task_id: String,
    /// Current task status
    pub status: String,
    /// Progress percentage (0-100)
    pub progress_pct: i32,
    /// Optional human-readable progress message
    pub message: Option<String>,
    /// Optional result data (set on completion)
    pub result: Option<serde_json::Value>,
    /// Optional error message (set on failure/cancellation)
    pub error: Option<String>,
    /// Optional persisted transcript step (Feature A glass-box). When present,
    /// this event carries one task_messages row so the UI can append it live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<serde_json::Value>,
}

impl TaskProgressEvent {
    /// Create a new progress event
    pub fn new(
        task_id: String,
        status: TaskStatus,
        progress_pct: i32,
        message: Option<String>,
    ) -> Self {
        Self {
            event_type: "task_progress".to_string(),
            task_id,
            status: status.as_str().to_string(),
            progress_pct,
            message,
            result: None,
            error: None,
            step: None,
        }
    }

    /// Add result data to the event (for completed tasks)
    pub fn with_result(mut self, result: serde_json::Value) -> Self {
        self.result = Some(result);
        self
    }

    /// Add error message to the event (for failed/cancelled tasks)
    pub fn with_error(mut self, error: String) -> Self {
        self.error = Some(error);
        self
    }

    /// Attach a persisted transcript step to this event (Feature A).
    pub fn with_step(mut self, step: serde_json::Value) -> Self {
        self.step = Some(step);
        self
    }
}

/// Broadcaster for task progress events
///
/// Uses tokio broadcast channel to send events to all connected
/// WebSocket clients. Clients subscribe via subscribe() method.
#[derive(Clone)]
pub struct ProgressBroadcaster {
    sender: broadcast::Sender<TaskProgressEvent>,
}

impl ProgressBroadcaster {
    /// Create a new broadcaster with the specified channel capacity
    ///
    /// Events that exceed capacity are dropped for slow receivers.
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// Send a progress event to all connected clients
    ///
    /// Returns silently if no receivers are connected (normal case).
    pub fn send(&self, event: TaskProgressEvent) {
        // Ignore send errors (no receivers is fine)
        let _ = self.sender.send(event);
    }

    /// Subscribe to progress events
    ///
    /// Returns a receiver that will receive all future progress events.
    pub fn subscribe(&self) -> broadcast::Receiver<TaskProgressEvent> {
        self.sender.subscribe()
    }
}
