//! SSH Command Tool - Execute read-only commands on network devices

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::time::Duration;
use tracing::{info, warn};

use super::filter::CommandFilter;
use super::{Tool, ToolError, ToolOutput};
use crate::ssh::{execute_command_on_session, CommandStatus, SshAuth, SshConfig};

/// Tool for executing SSH commands on network devices
pub struct SshCommandTool {
    filter: CommandFilter,
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct SshCommandInput {
    session_id: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    commands: Option<Vec<String>>,
    #[serde(default)]
    stop_on_error: Option<bool>,
}

impl SshCommandInput {
    /// Resolve the command list from either `command` or `commands` fields.
    fn resolve_commands(&self) -> Result<Vec<String>, ToolError> {
        match (&self.command, &self.commands) {
            (Some(cmd), None) => Ok(vec![cmd.clone()]),
            (None, Some(cmds)) => {
                if cmds.is_empty() {
                    return Err(ToolError::InvalidInput(
                        "commands array must not be empty".to_string(),
                    ));
                }
                if cmds.len() > 10 {
                    return Err(ToolError::InvalidInput(
                        "commands array must have at most 10 commands".to_string(),
                    ));
                }
                Ok(cmds.clone())
            }
            (Some(_), Some(_)) => Err(ToolError::InvalidInput(
                "Cannot specify both 'command' and 'commands' — use one or the other".to_string(),
            )),
            (None, None) => Err(ToolError::InvalidInput(
                "Must specify either 'command' (string) or 'commands' (array of strings)"
                    .to_string(),
            )),
        }
    }
}

/// Row from session + profile join query
#[derive(Debug, sqlx::FromRow)]
struct SessionConfigRow {
    name: String,
    host: String,
    port: i32,
    legacy_ssh: bool,
    username: String,
    auth_type: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
}

impl SshCommandTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            filter: CommandFilter::new(),
            pool,
        }
    }

    /// Get session and profile info from database
    async fn get_session_config(
        &self,
        session_id: &str,
    ) -> Result<(SshConfig, String, String), ToolError> {
        // Query session joined with profile and credentials
        // Note: Credentials are stored encrypted in vault - for now we query what's available
        // In production, this would need to decrypt via the vault
        let row: SessionConfigRow = sqlx::query_as(
            r#"
            SELECT
                s.name, s.host, s.port, s.legacy_ssh,
                p.username, p.auth_type, p.key_path,
                v.password, v.key_passphrase
            FROM sessions s
            JOIN credential_profiles p ON s.profile_id = p.id
            LEFT JOIN vault_credentials v ON v.profile_id = p.id
            WHERE s.id = ?
            "#,
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ToolError::ExecutionFailed(format!("DB query failed: {}", e)))?
        .ok_or_else(|| {
            ToolError::ExecutionFailed(format!(
                "Session '{}' not found or has no profile",
                session_id
            ))
        })?;

        let auth = match row.auth_type.as_str() {
            "password" => {
                let password = row.password.ok_or_else(|| {
                    ToolError::ExecutionFailed(
                        "Password not set in profile - unlock vault first".to_string(),
                    )
                })?;
                SshAuth::Password(password)
            }
            "key" => {
                let path = row.key_path.ok_or_else(|| {
                    ToolError::ExecutionFailed("Key path not set in profile".to_string())
                })?;
                SshAuth::KeyFile {
                    path,
                    passphrase: row.key_passphrase,
                }
            }
            _ => {
                return Err(ToolError::ExecutionFailed(format!(
                    "Unknown auth type: {}",
                    row.auth_type
                )))
            }
        };

        let config = SshConfig {
            host: row.host.clone(),
            port: row.port as u16,
            username: row.username,
            auth,
            legacy_ssh: row.legacy_ssh,
            skip_keyboard_interactive: false,
        };

        Ok((config, row.name, row.host))
    }
}

#[async_trait]
impl Tool for SshCommandTool {
    fn name(&self) -> &str {
        "execute_ssh_command"
    }

    fn description(&self) -> &str {
        "Execute a read-only command on a network device via SSH. \
         Only show/display/ping/traceroute commands are allowed. \
         Configuration commands are blocked for safety."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Session ID from query_devices or known device"
                },
                "command": {
                    "type": "string",
                    "description": "Single command to execute (must be read-only, e.g., 'show version'). Use 'command' or 'commands', not both."
                },
                "commands": {
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": 10,
                    "description": "Array of commands to execute in sequence (max 10). Use 'command' or 'commands', not both."
                },
                "stop_on_error": {
                    "type": "boolean",
                    "description": "If true, stop executing remaining commands when one fails. Default false."
                }
            },
            "required": ["session_id"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: SshCommandInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        let command_list = params.resolve_commands()?;
        let stop_on_error = params.stop_on_error.unwrap_or(false);
        let is_batch = command_list.len() > 1;

        info!(
            task_id = %task_id,
            session_id = %params.session_id,
            command_count = command_list.len(),
            "SSH command tool invoked"
        );

        // Get session configuration (connect once, reuse for all commands)
        let (config, session_name, host) = self.get_session_config(&params.session_id).await?;

        let mut results: Vec<serde_json::Value> = Vec::with_capacity(command_list.len());
        let mut all_success = true;

        for (i, command) in command_list.iter().enumerate() {
            // Add delay between commands in batch mode
            if i > 0 {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }

            // Validate command is read-only
            if let Err(e) = self.filter.is_allowed(command) {
                warn!(
                    task_id = %task_id,
                    command = %command,
                    error = %e,
                    "Command blocked by filter"
                );
                all_success = false;
                results.push(json!({
                    "command": command,
                    "blocked": true,
                    "reason": e.to_string(),
                    "help": "Only read-only commands are allowed. Try: show version, show interfaces, display ip routing-table"
                }));
                if stop_on_error {
                    break;
                }
                continue;
            }

            // Execute command with 30-second timeout
            let result = execute_command_on_session(
                config.clone(),
                params.session_id.clone(),
                session_name.clone(),
                command.clone(),
                Duration::from_secs(30),
            )
            .await;

            // Truncate output if too large (prevent context explosion)
            let output = if result.output.len() > 8000 {
                let truncated = &result.output[..8000];
                format!(
                    "{}\n\n... [OUTPUT TRUNCATED - {} more bytes]",
                    truncated,
                    result.output.len() - 8000
                )
            } else {
                result.output.clone()
            };

            let success = result.status == CommandStatus::Success;
            if !success {
                all_success = false;
            }

            info!(
                task_id = %task_id,
                session_id = %params.session_id,
                command = %command,
                success = success,
                output_len = output.len(),
                "SSH command completed"
            );

            results.push(json!({
                "command": command,
                "output": output,
                "exit_status": if success { "success" } else { "failed" },
                "execution_time_ms": result.execution_time_ms,
                "error": result.error,
            }));

            if stop_on_error && !success {
                break;
            }
        }

        // Single command: return result directly for backwards compatibility
        if !is_batch {
            let r = results.into_iter().next().unwrap();
            // Check if this was a blocked command
            let is_blocked = r.get("blocked").and_then(|v| v.as_bool()).unwrap_or(false);
            if is_blocked {
                let reason = r
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                return Ok(ToolOutput {
                    success: false,
                    output: r,
                    error: Some(format!("Command blocked: {}", reason)),
                });
            }
            let success =
                r.get("exit_status").and_then(|v| v.as_str()) == Some("success");
            let cmd = r
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let out = r
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let exec_time = r.get("execution_time_ms").cloned();
            let err = r
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            return Ok(ToolOutput {
                success,
                output: json!({
                    "device": session_name,
                    "host": host,
                    "command": cmd,
                    "output": out,
                    "execution_time_ms": exec_time,
                }),
                error: err,
            });
        }

        // Batch: return all results
        Ok(ToolOutput {
            success: all_success,
            output: json!({
                "device": session_name,
                "host": host,
                "results": results,
            }),
            error: if all_success {
                None
            } else {
                Some("One or more commands failed or were blocked".to_string())
            },
        })
    }
}
