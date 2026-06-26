//! Edit File Tool - Replace specific text in a file on a remote server via SSH

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::time::Duration;
use tracing::info;

use super::write_helpers::{
    apply_edit, build_read_file_command, build_write_command, execute_ssh_for_session,
    validate_filepath, MAX_EDIT_FILE_SIZE,
};
use super::{Tool, ToolError, ToolOutput};

/// Tool for replacing specific text in a file on a remote server
pub struct EditFileTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct EditFileInput {
    session_id: String,
    filepath: String,
    old_text: String,
    new_text: String,
}

impl EditFileTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }

    fn description(&self) -> &str {
        "Replace specific text in an existing file. Reads the file, validates old_text \
         appears exactly once, replaces it, writes back atomically."
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
                    "description": "Absolute path of the file to edit"
                },
                "old_text": {
                    "type": "string",
                    "description": "Exact text to find and replace (must appear exactly once)"
                },
                "new_text": {
                    "type": "string",
                    "description": "Replacement text"
                }
            },
            "required": ["session_id", "filepath", "old_text", "new_text"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: EditFileInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        let filepath =
            validate_filepath(&params.filepath).map_err(ToolError::InvalidInput)?;

        info!(
            task_id = %task_id,
            session_id = %params.session_id,
            filepath = %filepath,
            "edit_file tool invoked"
        );

        // Read the current file content
        let read_cmd =
            build_read_file_command(&filepath).map_err(ToolError::InvalidInput)?;

        let content = execute_ssh_for_session(
            &self.pool,
            &params.session_id,
            &read_cmd,
            Duration::from_secs(30),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;

        // Check file size
        if content.len() > MAX_EDIT_FILE_SIZE {
            return Err(ToolError::InvalidInput(format!(
                "File is too large to edit ({} bytes, max {} bytes)",
                content.len(),
                MAX_EDIT_FILE_SIZE
            )));
        }

        // Apply the edit
        let new_content =
            apply_edit(&content, &params.old_text, &params.new_text)
                .map_err(ToolError::InvalidInput)?;

        // Write back atomically
        let write_cmd =
            build_write_command(&filepath, &new_content).map_err(ToolError::InvalidInput)?;

        execute_ssh_for_session(
            &self.pool,
            &params.session_id,
            &write_cmd,
            Duration::from_secs(30),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;

        Ok(ToolOutput::success(json!({
            "message": format!("Successfully edited {}", filepath),
            "filepath": filepath,
            "old_text": params.old_text,
            "new_text": params.new_text,
        })))
    }
}
