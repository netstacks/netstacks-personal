//! Task registry for tracking running tasks with cancellation support
//!
//! Provides concurrency control via semaphore and task handle management.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Registry for tracking running tasks with cancellation support
pub struct TaskRegistry {
    /// Active task handles keyed by task ID
    handles: RwLock<HashMap<String, TaskHandle>>,
    /// Semaphore for limiting concurrent tasks
    semaphore: Arc<Semaphore>,
    /// Maximum concurrent tasks
    max_concurrent: usize,
}

/// Handle for a running task
struct TaskHandle {
    /// Cancellation token to signal task should stop
    cancel_token: CancellationToken,
    /// Join handle for the spawned task (kept for cleanup)
    _join_handle: JoinHandle<()>,
}

impl TaskRegistry {
    /// Create new registry with specified concurrency limit
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            handles: RwLock::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
        }
    }

    /// Get semaphore for acquiring execution permit
    pub fn semaphore(&self) -> Arc<Semaphore> {
        self.semaphore.clone()
    }

    /// Register a running task
    pub async fn register(
        &self,
        task_id: String,
        cancel_token: CancellationToken,
        join_handle: JoinHandle<()>,
    ) {
        let handle = TaskHandle {
            cancel_token,
            _join_handle: join_handle,
        };
        self.handles.write().await.insert(task_id, handle);
    }

    /// Unregister a completed task
    pub async fn unregister(&self, task_id: &str) {
        self.handles.write().await.remove(task_id);
    }

    /// Cancel a running task
    pub async fn cancel(&self, task_id: &str) -> bool {
        if let Some(handle) = self.handles.read().await.get(task_id) {
            handle.cancel_token.cancel();
            true
        } else {
            false
        }
    }

    /// Get count of currently running tasks
    pub async fn running_count(&self) -> usize {
        self.handles.read().await.len()
    }

    /// Get maximum concurrent tasks
    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }
}
