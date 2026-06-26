//! Send Email Tool - Send email notifications from agent tasks
//!
//! Allows AI agents to send email reports and notifications using
//! the configured SMTP settings.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use tracing::{info, warn};

use super::{Tool, ToolError, ToolOutput};
use crate::integrations::{EmailService, SmtpConfig};

/// AUDIT FIX (EXEC-016): per-process rate limit on agent-initiated email.
/// Without it a prompt-injected agent can flood arbitrary external recipients
/// from the user's identity, abusing the SMTP relay and triggering reputation
/// damage. We allow up to MAX_EMAILS_PER_HOUR across the whole agent process.
const MAX_EMAILS_PER_HOUR: u32 = 30;
const MAX_BODY_BYTES: usize = 64 * 1024; // 64 KiB
const MAX_SUBJECT_BYTES: usize = 1024;
const RATE_WINDOW_SECS: i64 = 3600;

static EMAIL_COUNT: AtomicU32 = AtomicU32::new(0);
static EMAIL_WINDOW_START: AtomicI64 = AtomicI64::new(0);

/// Returns Ok(()) if a new email is permitted under the rate limit; Err otherwise.
fn check_email_rate_limit() -> Result<(), ToolError> {
    let now = chrono::Utc::now().timestamp();
    let window_start = EMAIL_WINDOW_START.load(Ordering::Relaxed);
    if now - window_start >= RATE_WINDOW_SECS {
        EMAIL_WINDOW_START.store(now, Ordering::Relaxed);
        EMAIL_COUNT.store(0, Ordering::Relaxed);
    }
    let count = EMAIL_COUNT.fetch_add(1, Ordering::Relaxed);
    if count >= MAX_EMAILS_PER_HOUR {
        return Err(ToolError::ExecutionFailed(format!(
            "send_email rate limit hit ({} per hour). Try again later.",
            MAX_EMAILS_PER_HOUR
        )));
    }
    Ok(())
}

/// Tool for sending email from agent tasks
pub struct SendEmailTool {
    pool: SqlitePool,
}

/// Input parameters for send_email tool
#[derive(Debug, Deserialize)]
struct SendEmailInput {
    /// Recipient email address
    to: String,
    /// Email subject line
    subject: String,
    /// Email body (plain text)
    body: String,
}

/// Row from smtp_config table
#[derive(Debug, sqlx::FromRow)]
struct SmtpConfigRow {
    host: String,
    port: i32,
    username: String,
    use_tls: i32,
    from_email: String,
    from_name: Option<String>,
}

/// Row from api_keys table (for password)
#[derive(Debug, sqlx::FromRow)]
struct ApiKeyRow {
    encrypted_data: String,
}

impl SendEmailTool {
    /// Create a new SendEmailTool with database access
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Load SMTP configuration from database and vault
    async fn load_smtp_config(&self) -> Result<(SmtpConfig, String), ToolError> {
        // Query smtp_config table for settings
        let row: SmtpConfigRow = sqlx::query_as(
            "SELECT host, port, username, use_tls, from_email, from_name FROM smtp_config WHERE id = 'default'"
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ToolError::ExecutionFailed(format!("Database error: {}", e)))?
        .ok_or_else(|| ToolError::ExecutionFailed(
            "SMTP not configured. Configure SMTP in Settings > Integrations > Email.".to_string()
        ))?;

        // Query api_keys table for password (key_type = 'smtp_password')
        let key_row: ApiKeyRow = sqlx::query_as(
            "SELECT encrypted_data FROM api_keys WHERE key_type = 'smtp_password'"
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ToolError::ExecutionFailed(format!("Database error: {}", e)))?
        .ok_or_else(|| ToolError::ExecutionFailed(
            "SMTP password not configured. Set password in Settings > Integrations > Email.".to_string()
        ))?;

        let config = SmtpConfig {
            host: row.host,
            port: row.port as u16,
            username: row.username,
            use_tls: row.use_tls != 0,
            from_email: row.from_email,
            from_name: row.from_name,
        };

        Ok((config, key_row.encrypted_data))
    }
}

#[async_trait]
impl Tool for SendEmailTool {
    fn name(&self) -> &str {
        "send_email"
    }

    fn description(&self) -> &str {
        "Send an email message. Requires SMTP to be configured in Settings > Integrations > Email."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "to": {
                    "type": "string",
                    "description": "Recipient email address"
                },
                "subject": {
                    "type": "string",
                    "description": "Email subject line"
                },
                "body": {
                    "type": "string",
                    "description": "Email body content (plain text)"
                }
            },
            "required": ["to", "subject", "body"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        // Parse input
        let params: SendEmailInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        // Validate email address (basic check)
        if !params.to.contains('@') {
            return Err(ToolError::InvalidInput(
                "Invalid recipient email address".to_string(),
            ));
        }

        // AUDIT FIX (EXEC-016): cap subject and body sizes, reject CR/LF in
        // subject (header-injection), and rate-limit per process. The
        // recipient cap (e.g. only org domain) is left for the caller to
        // implement as policy — defaulting to allow-any here would silently
        // change behavior for existing users.
        if params.subject.len() > MAX_SUBJECT_BYTES {
            return Err(ToolError::InvalidInput(
                format!("subject exceeds {} bytes", MAX_SUBJECT_BYTES)
            ));
        }
        if params.subject.contains('\r') || params.subject.contains('\n') {
            return Err(ToolError::InvalidInput(
                "subject must not contain CR/LF".to_string()
            ));
        }
        if params.body.len() > MAX_BODY_BYTES {
            return Err(ToolError::InvalidInput(
                format!("body exceeds {} bytes", MAX_BODY_BYTES)
            ));
        }
        check_email_rate_limit()?;

        info!(
            task_id = %task_id,
            to = %params.to,
            subject = %params.subject,
            "Send email tool invoked"
        );

        // Load SMTP configuration
        let (config, password) = match self.load_smtp_config().await {
            Ok((cfg, pwd)) => (cfg, pwd),
            Err(e) => {
                warn!(
                    task_id = %task_id,
                    error = %e,
                    "SMTP not configured"
                );
                return Ok(ToolOutput {
                    success: false,
                    output: json!({
                        "error": "SMTP not configured",
                        "help": "Configure SMTP in Settings > Integrations > Email before using send_email tool."
                    }),
                    error: Some(e.to_string()),
                });
            }
        };

        // Create email service and send
        let service = EmailService::new(config.clone(), password);

        match service.send_email(&params.to, &params.subject, &params.body).await {
            Ok(()) => {
                info!(
                    task_id = %task_id,
                    to = %params.to,
                    "Email sent successfully"
                );

                Ok(ToolOutput::success(json!({
                    "status": "sent",
                    "to": params.to,
                    "subject": params.subject,
                    "from": config.from_email
                })))
            }
            Err(e) => {
                warn!(
                    task_id = %task_id,
                    to = %params.to,
                    error = %e,
                    "Failed to send email"
                );

                Ok(ToolOutput {
                    success: false,
                    output: json!({
                        "error": "Failed to send email",
                        "details": e.to_string(),
                        "to": params.to,
                        "subject": params.subject
                    }),
                    error: Some(format!("Failed to send email: {}", e)),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_send_email_tool_metadata() {
        // Create a mock pool - won't be used in these tests
        let pool = SqlitePool::connect_lazy("sqlite::memory:").unwrap();
        let tool = SendEmailTool::new(pool);

        assert_eq!(tool.name(), "send_email");
        assert!(tool.description().contains("SMTP"));

        let schema = tool.input_schema();
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["to"]["type"] == "string");
        assert!(schema["properties"]["subject"]["type"] == "string");
        assert!(schema["properties"]["body"]["type"] == "string");
    }
}
