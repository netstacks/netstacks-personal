//! Patch File Tool - Apply a sed substitution to a file on a remote server via SSH

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::time::Duration;
use tracing::info;

use super::write_helpers::{build_sed_command, execute_ssh_for_session, validate_filepath};
use super::{Tool, ToolError, ToolOutput};

/// Tool for applying sed substitutions to a file on a remote server
pub struct PatchFileTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct PatchFileInput {
    session_id: String,
    filepath: String,
    sed_expression: String,
}

impl PatchFileTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Tool for PatchFileTool {
    fn name(&self) -> &str {
        "patch_file"
    }

    fn description(&self) -> &str {
        "Apply a sed substitution to a file on a remote server. \
         Uses GNU sed -i. Best for simple line-by-line replacements."
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
                    "description": "Absolute path of the file to patch"
                },
                "sed_expression": {
                    "type": "string",
                    "description": "sed expression to apply (e.g., 's/old/new/g'). Must not contain single quotes."
                }
            },
            "required": ["session_id", "filepath", "sed_expression"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: PatchFileInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        let filepath =
            validate_filepath(&params.filepath).map_err(ToolError::InvalidInput)?;

        info!(
            task_id = %task_id,
            session_id = %params.session_id,
            filepath = %filepath,
            sed_expression = %params.sed_expression,
            "patch_file tool invoked"
        );

        let sed_cmd = build_sed_command(&filepath, &params.sed_expression)
            .map_err(ToolError::InvalidInput)?;

        execute_ssh_for_session(
            &self.pool,
            &params.session_id,
            &sed_cmd,
            Duration::from_secs(30),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;

        Ok(ToolOutput::success(json!({
            "message": format!("Successfully applied sed expression to {}", filepath),
            "filepath": filepath,
            "sed_expression": params.sed_expression,
        })))
    }
}
