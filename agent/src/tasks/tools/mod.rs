//! Tool infrastructure for AI agent tasks
//!
//! Provides a consistent interface for tools that agents can invoke,
//! along with a registry for dynamic tool lookup and command filtering
//! for safety enforcement.

pub mod ask_user;
pub mod bash_filter;
pub mod catalog;
pub mod device_query;
pub mod edit_file;
pub mod filter;
pub mod mop;
pub mod output_validator;
pub mod patch_file;
pub mod registry;
pub mod save_document;
pub mod send_email;
pub mod subagent;
pub mod ssh_command;
pub mod write_file;
pub mod write_helpers;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub use ask_user::AskUserTool;
pub use device_query::DeviceQueryTool;
pub use edit_file::EditFileTool;
pub use mop::{MopAnalysisTool, MopExecutionTool, MopPlanTool};
pub use patch_file::PatchFileTool;
pub use registry::ToolRegistry;
pub use save_document::SaveDocumentTool;
pub use send_email::SendEmailTool;
pub use subagent::{DelegateAgentTool, ListSpecialistsTool};
pub use ssh_command::SshCommandTool;
pub use write_file::WriteFileTool;

/// Input for a tool invocation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct _ToolInput {
    /// Name of the tool to invoke
    pub name: String,
    /// Arguments passed to the tool as JSON
    pub arguments: serde_json::Value,
}

/// Output from a tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    /// Whether the tool executed successfully
    pub success: bool,
    /// Output data from the tool
    pub output: serde_json::Value,
    /// Error message if execution failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolOutput {
    /// Create a successful output
    pub fn success(output: serde_json::Value) -> Self {
        Self {
            success: true,
            output,
            error: None,
        }
    }

    /// Create a failed output
    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            output: serde_json::Value::Null,
            error: Some(error),
        }
    }
}

/// Errors that can occur during tool execution
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Execution failed: {0}")]
    ExecutionFailed(String),
    #[error("Command not allowed: {0}")]
    _NotAllowed(String),
    #[error("Unknown error: {0}")]
    _Unknown(String),
}

/// Trait for tools that can be invoked by AI agents
///
/// Tools are the bridge between agent intentions and system actions.
/// Each tool has a schema describing its inputs and an async execute method.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Returns the unique name of this tool
    fn name(&self) -> &str;

    /// Returns a human-readable description of what this tool does
    fn description(&self) -> &str;

    /// Returns the JSON Schema for the tool's input arguments
    fn input_schema(&self) -> serde_json::Value;

    /// Execute the tool with the given input arguments
    ///
    /// # Arguments
    /// * `input` - JSON value containing the tool's arguments
    /// * `task_id` - ID of the task invoking this tool (for logging/tracking)
    ///
    /// # Returns
    /// Result containing the tool output or an error
    async fn execute(&self, input: serde_json::Value, task_id: &str) -> Result<ToolOutput, ToolError>;

    /// Whether this tool BLOCKS inside `execute` waiting on something external —
    /// a human (ask_user) or a delegated child agent (delegate_to_agent). The
    /// ReAct loop releases this task's concurrency permit while such a tool runs
    /// and re-acquires (cancel-aware) afterwards, so a long wait can't starve the
    /// cap-N pool or deadlock a parent that's awaiting its own child. Default false.
    fn parks(&self) -> bool {
        false
    }
}

/// Type alias for a boxed tool that can be shared across threads
pub type SharedTool = Arc<dyn Tool + Send + Sync>;
