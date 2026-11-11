//! Tool-call permissions for background agent tasks — the Rust port of the
//! frontend resolver (`frontend/src/lib/aiPermissions.ts`).
//!
//! Background tasks run as the **Auto Pilot** agent type: it is the agent
//! type that "runs autonomously", so its permission mode and per-tool toggles
//! (mirrored into the sidecar settings store by the frontend) govern every
//! task. The Settings → AI page is the single source of truth:
//!
//! - DENY (in every mode): the tool is disabled for Auto Pilot; a file-write
//!   tool while AI Terminal Mode is off; a device command that is not
//!   read-only while AI Config Mode is off.
//! - MODE: Ask → every call needs approval; Auto → reads run, writes need
//!   approval; Go Nuts (`yolo`) → everything runs.
//!
//! `ask_user` is never gated: it IS the prompt to the user.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use super::tools::catalog;
use super::tools::filter::CommandFilter;
use crate::ai::config_mode::{self, ConfigModeHandle};
use crate::providers::DataProvider;

/// Sidecar setting holding Auto Pilot's permission mode (`"ask" | "auto" | "yolo"`).
pub const PERMISSION_MODE_SETTING: &str = "ai.permissionMode.autopilot";
/// Sidecar setting holding Auto Pilot's disabled tools (Settings → AI Tools names).
pub const DISABLED_TOOLS_SETTING: &str = "ai.disabledTools.autopilot";
/// Sidecar setting gating the remote file-write tools.
pub const TERMINAL_MODE_SETTING: &str = "ai.terminal_mode";

/// The background tool that asks the user a question.
const ASK_USER: &str = "ask_user";

/// How much the user wants to approve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// Every tool call needs approval.
    Ask,
    /// Reads run; writes need approval.
    Auto,
    /// Everything runs ("Go Nuts").
    Yolo,
}

impl PermissionMode {
    /// Parse the setting value. Missing or unrecognised → `Auto` (the Auto
    /// Pilot default).
    pub fn from_setting(value: &Value) -> Self {
        match value.get("value").unwrap_or(value).as_str() {
            Some("ask") => Self::Ask,
            Some("yolo") => Self::Yolo,
            _ => Self::Auto,
        }
    }
}

/// Outcome of resolving one tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Execute without asking.
    Allow,
    /// Park on a user approval; the string says why.
    Ask(String),
    /// Refuse without executing; the string is returned to the model.
    Deny(String),
}

/// Everything the resolver decides from: settings plus live config mode.
#[derive(Debug, Clone)]
pub struct PermissionContext {
    pub mode: PermissionMode,
    /// Settings → AI Tools names disabled for Auto Pilot.
    pub disabled_tools: HashSet<String>,
    pub terminal_mode: bool,
    pub config_mode: bool,
}

impl PermissionContext {
    /// Read the current settings and config-mode state. Called per tool call
    /// so a change made mid-task applies to the very next call.
    pub async fn load(provider: &Arc<dyn DataProvider>, config_mode: &ConfigModeHandle) -> Self {
        let setting = |key: &'static str| async move {
            provider.get_setting(key).await.unwrap_or(Value::Null)
        };
        Self {
            mode: PermissionMode::from_setting(&setting(PERMISSION_MODE_SETTING).await),
            disabled_tools: serde_json::from_value(setting(DISABLED_TOOLS_SETTING).await)
                .unwrap_or_default(),
            terminal_mode: terminal_mode_enabled(&setting(TERMINAL_MODE_SETTING).await),
            config_mode: config_mode::is_active(config_mode).await,
        }
    }

    /// Whether the user disabled this background tool for Auto Pilot.
    /// `ask_user` can never be disabled: it is how the task reaches the user.
    pub fn disables(&self, tool: &str) -> bool {
        tool != ASK_USER && self.disabled_tools.contains(settings_tool_name(tool))
    }
}

/// Interpret the `ai.terminal_mode` setting. Accepts the seeded bare boolean
/// (`true`), a bare string (`"true"`), and the frontend's settings envelope
/// (`{"value": "true"}` / `{"value": true}`). Anything else is disabled.
pub fn terminal_mode_enabled(value: &Value) -> bool {
    let inner = value.get("value").unwrap_or(value);
    match inner {
        Value::Bool(b) => *b,
        Value::String(s) => s.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// The Settings → AI Tools name that toggles a background tool. Tools with a
/// frontend counterpart of the same name (write_file, save_document, …) map
/// to themselves.
fn settings_tool_name(tool: &str) -> &str {
    match tool {
        "execute_ssh_command" => "ai_ssh_execute",
        "query_devices" => "list_sessions",
        "list_specialists" => "list_agent_definitions",
        "delegate_to_agent" => "spawn_agent_task",
        other => other,
    }
}

/// Every command string an `execute_ssh_command` call would run.
fn ssh_commands(input: &Value) -> Vec<&str> {
    let single = input.get("command").and_then(Value::as_str);
    let batch = input
        .get("commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    single.into_iter().chain(batch).collect()
}

/// Read vs write: does the call change state outside the conversation?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Effect {
    Read,
    Write,
}

/// Resolve one LLM-emitted tool call against the user's settings.
pub fn resolve(tool: &str, input: &Value, ctx: &PermissionContext) -> Decision {
    if tool == ASK_USER {
        return Decision::Allow;
    }

    if ctx.disables(tool) {
        return Decision::Deny(format!(
            "'{}' is disabled for Auto Pilot in Settings → AI → AI Tools.",
            settings_tool_name(tool)
        ));
    }

    if (catalog::is_file_write(tool) || catalog::is_patch(tool)) && !ctx.terminal_mode {
        return Decision::Deny(format!(
            "'{}' needs AI Terminal Mode, which is off. The user can enable it in Settings → AI.",
            tool
        ));
    }

    let mut write_reason = format!("'{}' changes state outside the conversation", tool);
    let effect = if catalog::is_ssh_command(tool) {
        let filter = CommandFilter::new();
        match ssh_commands(input)
            .into_iter()
            .find_map(|cmd| filter.is_allowed(cmd).err().map(|e| (cmd, e)))
        {
            None => Effect::Read,
            Some((cmd, err)) if !ctx.config_mode => {
                return Decision::Deny(format!(
                    "`{}` is not a read-only command ({}). The user can enable AI Config Mode \
                     in Settings → AI to allow configuration commands.",
                    cmd, err
                ));
            }
            Some((cmd, _)) => {
                write_reason = format!("configuration command `{}`", cmd);
                Effect::Write
            }
        }
    } else {
        match tool {
            "query_devices" | "list_specialists" | "mop_execution" | "mop_analysis" => Effect::Read,
            "mop_plan" => match input.get("action").and_then(Value::as_str) {
                Some("list" | "get" | "export") => Effect::Read,
                _ => Effect::Write,
            },
            _ => Effect::Write,
        }
    };

    match (ctx.mode, effect) {
        (PermissionMode::Yolo, _) | (PermissionMode::Auto, Effect::Read) => Decision::Allow,
        (PermissionMode::Ask, _) => {
            Decision::Ask("Ask mode: every tool call needs approval".to_string())
        }
        (PermissionMode::Auto, Effect::Write) => Decision::Ask(format!("Auto mode: {}", write_reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(mode: PermissionMode) -> PermissionContext {
        PermissionContext {
            mode,
            disabled_tools: HashSet::new(),
            terminal_mode: true,
            config_mode: false,
        }
    }

    fn is_ask(d: &Decision) -> bool {
        matches!(d, Decision::Ask(_))
    }

    fn is_deny(d: &Decision) -> bool {
        matches!(d, Decision::Deny(_))
    }

    #[test]
    fn disables_maps_settings_names_and_never_ask_user() {
        let mut c = ctx(PermissionMode::Yolo);
        c.disabled_tools = ["ai_ssh_execute", "send_email", "ask_user"]
            .into_iter()
            .map(String::from)
            .collect();
        assert!(c.disables("execute_ssh_command"));
        assert!(c.disables("send_email"));
        assert!(!c.disables("ask_user"));
        assert!(!c.disables("query_devices"));
    }

    /// A read tool call and a write tool call.
    fn read(c: &PermissionContext) -> Decision {
        resolve("query_devices", &json!({}), c)
    }

    fn write(c: &PermissionContext) -> Decision {
        resolve("send_email", &json!({ "to": "a@b.c" }), c)
    }

    #[test]
    fn ask_mode_prompts_for_reads_and_writes() {
        let c = ctx(PermissionMode::Ask);
        assert!(is_ask(&read(&c)));
        assert!(is_ask(&write(&c)));
    }

    #[test]
    fn auto_mode_runs_reads_and_prompts_for_writes() {
        let c = ctx(PermissionMode::Auto);
        assert_eq!(read(&c), Decision::Allow);
        assert!(is_ask(&write(&c)));
    }

    #[test]
    fn yolo_mode_runs_everything() {
        let c = ctx(PermissionMode::Yolo);
        assert_eq!(read(&c), Decision::Allow);
        assert_eq!(write(&c), Decision::Allow);
    }

    #[test]
    fn disabled_tools_are_denied_in_every_mode_via_their_settings_name() {
        for mode in [PermissionMode::Ask, PermissionMode::Auto, PermissionMode::Yolo] {
            let mut c = ctx(mode);
            c.disabled_tools = ["ai_ssh_execute", "spawn_agent_task", "save_document", "list_sessions"]
                .into_iter()
                .map(String::from)
                .collect();
            let show = json!({ "command": "show version" });
            assert!(is_deny(&resolve("execute_ssh_command", &show, &c)));
            assert!(is_deny(&resolve("delegate_to_agent", &json!({}), &c)));
            assert!(is_deny(&resolve("save_document", &json!({}), &c)));
            assert!(is_deny(&resolve("query_devices", &json!({}), &c)));
            assert!(!is_deny(&resolve("list_specialists", &json!({}), &c)));
        }
    }

    #[test]
    fn file_tools_are_denied_while_terminal_mode_is_off() {
        let mut c = ctx(PermissionMode::Yolo);
        c.terminal_mode = false;
        for tool in ["write_file", "edit_file", "patch_file"] {
            assert!(is_deny(&resolve(tool, &json!({ "filepath": "/tmp/x" }), &c)));
        }
        c.terminal_mode = true;
        assert_eq!(resolve("write_file", &json!({ "filepath": "/tmp/x" }), &c), Decision::Allow);
    }

    #[test]
    fn config_commands_are_denied_without_config_mode_and_writes_with_it() {
        let cfg = json!({ "commands": ["show version", "configure terminal"] });
        let chained = json!({ "command": "show version; reload" });
        let mut c = ctx(PermissionMode::Yolo);
        assert!(is_deny(&resolve("execute_ssh_command", &cfg, &c)));
        assert!(is_deny(&resolve("execute_ssh_command", &chained, &c)));

        c.config_mode = true;
        assert_eq!(resolve("execute_ssh_command", &cfg, &c), Decision::Allow);
        c.mode = PermissionMode::Auto;
        assert!(is_ask(&resolve("execute_ssh_command", &cfg, &c)));
    }

    #[test]
    fn read_only_device_commands_are_reads() {
        let c = ctx(PermissionMode::Auto);
        let show = json!({ "commands": ["show version", "show ip route"] });
        assert_eq!(resolve("execute_ssh_command", &show, &c), Decision::Allow);
    }

    #[test]
    fn ask_user_is_never_gated() {
        let mut c = ctx(PermissionMode::Ask);
        c.disabled_tools.insert("ask_user".to_string());
        assert_eq!(resolve("ask_user", &json!({ "question": "?" }), &c), Decision::Allow);
    }

    #[test]
    fn mcp_and_unknown_tools_are_writes() {
        let c = ctx(PermissionMode::Auto);
        assert!(is_ask(&resolve("mcp_nso_get_device", &json!({ "arguments": {} }), &c)));
        assert!(is_ask(&resolve("brand_new_tool", &json!({}), &c)));
    }

    #[test]
    fn mop_plan_reads_and_writes_split_on_action() {
        let c = ctx(PermissionMode::Auto);
        for action in ["list", "get", "export"] {
            assert_eq!(resolve("mop_plan", &json!({ "action": action }), &c), Decision::Allow);
        }
        for action in ["create", "add_steps", "import"] {
            assert!(is_ask(&resolve("mop_plan", &json!({ "action": action }), &c)));
        }
        assert_eq!(resolve("mop_execution", &json!({ "action": "list" }), &c), Decision::Allow);
        assert_eq!(resolve("mop_analysis", &json!({}), &c), Decision::Allow);
    }

    #[test]
    fn permission_mode_parsing_defaults_to_auto() {
        assert_eq!(PermissionMode::from_setting(&json!("ask")), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_setting(&json!("yolo")), PermissionMode::Yolo);
        assert_eq!(PermissionMode::from_setting(&json!("auto")), PermissionMode::Auto);
        assert_eq!(PermissionMode::from_setting(&json!({ "value": "ask" })), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_setting(&Value::Null), PermissionMode::Auto);
        assert_eq!(PermissionMode::from_setting(&json!("nonsense")), PermissionMode::Auto);
        assert_eq!(PermissionMode::from_setting(&json!(3)), PermissionMode::Auto);
    }

    #[test]
    fn terminal_mode_accepts_bare_and_enveloped_encodings() {
        assert!(terminal_mode_enabled(&json!(true)));
        assert!(terminal_mode_enabled(&json!("true")));
        assert!(terminal_mode_enabled(&json!({ "value": "true" })));
        assert!(terminal_mode_enabled(&json!({ "value": true })));
    }

    #[test]
    fn terminal_mode_everything_else_is_disabled() {
        assert!(!terminal_mode_enabled(&json!(false)));
        assert!(!terminal_mode_enabled(&json!("false")));
        assert!(!terminal_mode_enabled(&json!({ "value": "false" })));
        assert!(!terminal_mode_enabled(&json!({ "value": false })));
        assert!(!terminal_mode_enabled(&json!(null)));
        assert!(!terminal_mode_enabled(&json!({})));
        assert!(!terminal_mode_enabled(&json!(1)));
    }
}
