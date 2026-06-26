//! AI Agent Tasks module
//!
//! Provides task persistence, status management, and background execution
//! for long-running AI tasks.

pub mod approvals;
mod executor;
mod models;
mod permit;
mod progress;
mod react;
mod registry;
mod store;
pub mod tools;

pub use executor::AgentTaskExecutor;
pub use models::{AgentTask, CreateTaskRequest, TaskMessage, TaskStatus};
pub use permit::{PermitGuard, ReacquireError};
pub use progress::ProgressBroadcaster;
pub use registry::TaskRegistry;
pub use store::{TaskStore, TaskStoreError};

// Re-export tool types for convenience
