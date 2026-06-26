//! Write File Tool - Create or overwrite a file on a remote server via SSH

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::time::Duration;
use tracing::info;

use super::write_helpers::{build_write_command, execute_ssh_for_session, validate_filepath};
use super::{Tool, ToolError, ToolOutput};

/// Tool for creating or overwriting a file on a remote server
pub struct WriteFileTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct WriteFileInput {
    session_id: String,
    filepath: String,
    content: String,
}

impl WriteFileTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Create or overwrite a file on a remote server. \
         Content is transferred via base64 encoding for safety."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Session ID of the remote device"
                },
                "filepath": {
                    "type": "string",
                    "description": "Absolute path of the file to create or overwrite"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            },
            "required": ["session_id", "filepath", "content"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: WriteFileInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        let filepath =
            validate_filepath(&params.filepath).map_err(ToolError::InvalidInput)?;

        info!(
            task_id = %task_id,
            session_id = %params.session_id,
            filepath = %filepath,
            content_len = params.content.len(),
            "write_file tool invoked"
        );

        let write_cmd =
            build_write_command(&filepath, &params.content).map_err(ToolError::InvalidInput)?;

        execute_ssh_for_session(
            &self.pool,
            &params.session_id,
            &write_cmd,
            Duration::from_secs(30),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;

        Ok(ToolOutput::success(json!({
            "message": format!("Successfully wrote {} bytes to {}", params.content.len(), filepath),
            "filepath": filepath,
            "bytes_written": params.content.len(),
        })))
    }
}
