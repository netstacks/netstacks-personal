//! `ask_user` — a non-mutating tool that pauses the task to ask the human a
//! free-form clarifying question, then resumes the SAME Tokio task with the
//! typed answer in the conversation. The concurrency permit is released while
//! parked (the react loop's PermitGuard wraps this dispatch), so a long
//! question does not starve the cap-N pool. Feature B.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::info;

use super::{Tool, ToolError, ToolOutput};
use crate::tasks::approvals::{HumanResponse, InteractionKind, PendingInteraction, TaskApprovalService};

#[derive(Debug, Deserialize)]
struct AskUserInput {
    question: String,
    #[serde(default)]
    choices: Option<Vec<String>>,
}

/// Non-mutating tool: ask the human a clarifying question and resume with the
/// answer. Holds the `Arc<TaskApprovalService>` to park on a Question-kind
/// interaction via `request_full`.
pub struct AskUserTool {
    approval_service: Arc<TaskApprovalService>,
}

impl AskUserTool {
    pub fn new(approval_service: Arc<TaskApprovalService>) -> Self {
        Self { approval_service }
    }
}

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }

    /// Blocks inside execute() awaiting the human — release the permit while parked.
    fn parks(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Pause and ask the human operator a clarifying question, then resume \
         with their answer. Use ONLY when you genuinely cannot proceed without \
         human input (ambiguous target device, missing parameter, a yes/no \
         judgment call). Do NOT use it to ask permission to run a tool — \
         mutating tools already prompt for approval automatically."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The clarifying question to ask the user."
                },
                "choices": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional list of suggested answers shown as chips."
                }
            },
            "required": ["question"],
            "additionalProperties": false
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: AskUserInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid ask_user input: {}", e)))?;

        if params.question.trim().is_empty() {
            return Err(ToolError::InvalidInput("question must not be empty".into()));
        }

        info!(task_id = %task_id, "ask_user parking for human answer");

        let interaction = PendingInteraction {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            kind: InteractionKind::Question,
            prompt: params.question.clone(),
            choices: params.choices.clone(),
            tool_name: None,
            tool_input: None,
            diff: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        // The Tool trait carries no cancel token; the park relies on the
        // service's 600s timeout + the react loop's permit-release. Pass a
        // fresh (never-cancelled) token.
        let response = self
            .approval_service
            .request_full(interaction, &CancellationToken::new())
            .await;

        // STRUCTURAL INVARIANT (also enforced in resolve()): a Question can only
        // be answered by Answer / AnswerStructured / Reject.
        let answer = match response {
            HumanResponse::Answer { text } => text,
            HumanResponse::AnswerStructured { json } => json.to_string(),
            HumanResponse::Reject { reason } => {
                // User declined / timed out. Tell the model so it can wrap up
                // gracefully rather than loop. Non-fatal.
                let r = reason.unwrap_or_else(|| "no answer provided".to_string());
                return Ok(ToolOutput::success(json!({
                    "answered": false,
                    "message": format!("User did not answer the question ({}).", r),
                })));
            }
            // Should be unreachable thanks to resolve()'s kind check.
            other => {
                return Err(ToolError::ExecutionFailed(format!(
                    "ask_user received an incompatible response variant: {:?}",
                    std::mem::discriminant(&other)
                )));
            }
        };

        Ok(ToolOutput::success(json!({
            "answered": true,
            "answer": answer,
        })))
    }
}
