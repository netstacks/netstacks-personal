//! Output-side LLM validator (AUDIT FIX EXEC-009).
//!
//! Even with the per-tool input validation, prompt-injected LLM responses
//! were the highest-leverage residual attack path: a hostile device banner
//! or a Knowledge Pack snippet could coax the model into emitting a
//! `tool_use` that, while syntactically valid, did something the user did
//! not intend (write to `/etc/sudoers`, run `request system reboot`, etc.).
//!
//! This module is the last line of defence. The ReAct loop calls
//! `validate_tool_use` immediately before dispatching every emitted
//! `tool_use`. If validation fails, the dispatch is replaced with a
//! `tool_result` that says "blocked" — the LLM sees the rejection and can
//! adjust, the user is shielded, and an `audit` log entry records the
//! attempted call.
//!
//! Device commands (`execute_ssh_command`) are NOT checked here: whether a
//! non-read-only command may run depends on live AI config mode, so that rule
//! lives in the task permission resolver (`tasks::permissions`), which runs
//! alongside this validator on every call.

use serde_json::Value;

use super::catalog;

/// Outcome of validating a tool_use emitted by the LLM.
#[derive(Debug)]
pub enum ValidationOutcome {
    /// Dispatch as normal.
    Allow,
    /// Block dispatch and return this string to the model as the tool result.
    Block(String),
}

impl ValidationOutcome {
    fn block(reason: impl Into<String>) -> Self {
        Self::Block(reason.into())
    }
}

/// Validate an LLM-emitted `tool_use` against per-tool policy.
///
/// Returns `Allow` when the call should proceed, or `Block(reason)` when it
/// should be rejected. The reason is fed back to the model as a
/// `tool_result` so it can adjust without seeing a silent failure.
pub fn validate_tool_use(tool_name: &str, input: &Value) -> ValidationOutcome {
    match tool_name {
        // File-write surfaces — the existing `validate_filepath` already
        // enforces the deny list, but it's only invoked inside the tool's
        // own execute(). Re-run the input-key check so the validator
        // catches obvious malformed AI inputs (missing filepath etc.)
        // before the tool does any work.
        name if catalog::is_file_write(name) => {
            let filepath = input.get("filepath").and_then(|v| v.as_str()).unwrap_or("");
            if filepath.is_empty() {
                return ValidationOutcome::block("filepath argument missing or empty");
            }
            // Re-use the helper for path-policy enforcement so EVERY write
            // path (even a future one that forgets to call the helper)
            // benefits.
            if let Err(e) = super::write_helpers::validate_filepath(filepath) {
                audit_blocked(tool_name, "path_policy", filepath, &e);
                return ValidationOutcome::block(format!(
                    "Filepath rejected by output-side validator: {}", e
                ));
            }
            ValidationOutcome::Allow
        }

        // Patch via sed — the per-tool helper already restricts the
        // expression, but again: defence-in-depth.
        name if catalog::is_patch(name) => {
            let filepath = input.get("filepath").and_then(|v| v.as_str()).unwrap_or("");
            let expr = input.get("sed_expression").and_then(|v| v.as_str()).unwrap_or("");
            if filepath.is_empty() {
                return ValidationOutcome::block("filepath argument missing or empty");
            }
            if expr.is_empty() {
                return ValidationOutcome::block("sed_expression missing or empty");
            }
            if let Err(e) = super::write_helpers::validate_filepath(filepath) {
                audit_blocked(tool_name, "path_policy", filepath, &e);
                return ValidationOutcome::block(format!(
                    "Filepath rejected by output-side validator: {}", e
                ));
            }
            // Re-use the sed validator by trying to build the command —
            // the helper rejects all the dangerous flags.
            if let Err(e) = super::write_helpers::build_sed_command(filepath, expr) {
                audit_blocked(tool_name, "sed_policy", expr, &e);
                return ValidationOutcome::block(format!(
                    "sed expression rejected by output-side validator: {}", e
                ));
            }
            ValidationOutcome::Allow
        }

        // Email — block obvious header-injection and over-large bodies
        // before they hit the SMTP path. Per-process rate limit is
        // enforced inside the tool itself.
        "send_email" => {
            let to = input.get("to").and_then(|v| v.as_str()).unwrap_or("");
            let subject = input.get("subject").and_then(|v| v.as_str()).unwrap_or("");
            let body = input.get("body").and_then(|v| v.as_str()).unwrap_or("");
            if !to.contains('@') {
                return ValidationOutcome::block("invalid recipient");
            }
            if subject.contains('\r') || subject.contains('\n') {
                audit_blocked(tool_name, "header_injection", subject, "CR/LF in subject");
                return ValidationOutcome::block(
                    "subject contains CR/LF (potential header injection) — blocked"
                );
            }
            if body.len() > 64 * 1024 {
                return ValidationOutcome::block("body exceeds 64 KiB");
            }
            ValidationOutcome::Allow
        }

        // MCP tool dispatch — argument-policy validation lives in the
        // per-tool wrapper (see EXEC-008). Here we only catch obviously
        // malformed AI inputs (missing required fields).
        name if name.starts_with("mcp_") => {
            if input.get("arguments").is_none() && input.get("name").is_none() {
                // Many MCP wrappers expect an `arguments` object — surface
                // a friendly error if the LLM emitted something else.
                return ValidationOutcome::block(
                    "MCP tool call missing `arguments` — re-emit with proper schema"
                );
            }
            ValidationOutcome::Allow
        }

        // Unknown / unmodelled tools — let through so introduction of a
        // new tool doesn't accidentally break. Adding a new
        // security-sensitive tool means adding a match arm here.
        _ => ValidationOutcome::Allow,
    }
}

fn audit_blocked(tool: &str, reason: &str, value: &str, detail: &str) {
    tracing::warn!(
        target: "audit",
        tool = %tool,
        reason = %reason,
        value = %value,
        detail = %detail,
        "output-side validator blocked LLM tool_use"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_blocks_shadow() {
        let input = json!({"filepath": "/etc/shadow", "content": "x"});
        match validate_tool_use("write_file", &input) {
            ValidationOutcome::Block(_) => {}
            ValidationOutcome::Allow => panic!("should have been blocked"),
        }
    }

    #[test]
    fn patch_blocks_e_flag() {
        let input = json!({
            "filepath": "/tmp/foo",
            "sed_expression": "s/.*/x/e"
        });
        match validate_tool_use("patch_file", &input) {
            ValidationOutcome::Block(_) => {}
            ValidationOutcome::Allow => panic!("should have been blocked"),
        }
    }

    #[test]
    fn email_blocks_crlf_subject() {
        let input = json!({
            "to": "ops@example.com",
            "subject": "fine\r\nBcc: attacker@evil.example",
            "body": "hi"
        });
        match validate_tool_use("send_email", &input) {
            ValidationOutcome::Block(_) => {}
            ValidationOutcome::Allow => panic!("should have been blocked"),
        }
    }
}
