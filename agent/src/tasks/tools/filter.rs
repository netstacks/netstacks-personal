//! Command filter for read-only enforcement
//!
//! Ensures agents can only execute safe, read-only commands on network devices.
//! Uses an allow-list approach with explicit block patterns for dangerous commands.

use regex::Regex;
use std::sync::OnceLock;

/// Errors from command filtering
#[derive(Debug, thiserror::Error)]
pub enum CommandFilterError {
    #[error("Blocked command '{command}': {reason}")]
    BlockedCommand { command: String, reason: String },

    #[error("Command '{command}' not allowed. Allowed prefixes: {allowed_prefixes:?}")]
    NotAllowed {
        command: String,
        allowed_prefixes: Vec<String>,
    },
}

/// Filter for validating commands before execution
///
/// Implements a two-tier validation:
/// 1. Block list - explicitly dangerous commands are rejected with reason
/// 2. Allow list - only commands starting with safe prefixes are permitted
pub struct CommandFilter {
    allowed_prefixes: Vec<&'static str>,
    blocked_patterns: Vec<BlockedPattern>,
    /// When true, all commands are allowed (config mode enabled)
    bypass: bool,
}

struct BlockedPattern {
    regex: Regex,
    reason: &'static str,
}

/// Get compiled regex patterns (compiled once, reused)
///
/// AUDIT FIX (EXEC-006): patterns now (a) reject shell metacharacters and
/// command-chaining anywhere in the command, (b) include vendor-specific shell
/// escapes that previously bypassed the filter (`start shell`, `bash`, `run`,
/// `do <verb>`, etc.), (c) use `(?m)^` multiline anchors so a leading newline
/// no longer evades the prefix tests, and (d) cover additional destructive
/// commands missing from the original list (`request system reboot`, `format`,
/// `factory-reset`, `boot system`, `archive download-sw`, `clear configuration`,
/// `load merge`, `replace pattern`, `commit confirmed`, `install commit`).
fn get_blocked_patterns() -> &'static Vec<(Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            // Shell metacharacters / command chaining — block anywhere in the line
            (
                Regex::new(r"[;&|`]|\$\(|>\s*[^=]|<\s*\(|\\\n|&&|\|\|").unwrap(),
                "Shell metacharacters and command chaining are not allowed",
            ),
            // Newline injection (multi-statement payload smuggled in a single string)
            (
                Regex::new(r"[\r\n]").unwrap(),
                "Multi-line commands are not allowed",
            ),
            // Vendor-specific shell escapes that drop into a Linux/BSD shell
            (
                Regex::new(r"(?m)^\s*(start\s+shell|bash|run\s+(?:start\s+)?shell|run\s+bash|enable\s+shell|shell|cli|cgi|kshell)\b").unwrap(),
                "Shell escapes drop into a vendor shell with full command access",
            ),
            // `do <privileged-verb>` lets you reach exec-mode from config-mode on Cisco
            (
                Regex::new(r"(?m)^\s*do\s+(reload|reset|delete|erase|clear|copy|format|write|debug|enable)\b").unwrap(),
                "`do` invokes privileged commands from config mode",
            ),
            // Configuration mode and configuration mutation
            (
                Regex::new(r"(?m)^\s*conf(?:ig(?:ure)?)?(?:\s+t(?:erminal)?)?\b").unwrap(),
                "Configuration mode commands are not allowed",
            ),
            (
                Regex::new(r"(?m)^\s*write(?:\s+(?:mem(?:ory)?|erase|file|terminal))?\b").unwrap(),
                "Write commands modify device configuration",
            ),
            (
                Regex::new(r"(?m)^\s*copy\s+(?:run(?:ning)?|start(?:up)?|tftp|ftp|http|scp|usb|flash|disk|nvram)\b").unwrap(),
                "Copy commands can overwrite configuration or move files",
            ),
            (
                Regex::new(r"(?m)^\s*reload\b").unwrap(),
                "Reload commands restart the device",
            ),
            (
                Regex::new(r"(?m)^\s*request\s+(?:system\s+(?:reboot|halt|power-off|zeroize)|chassis\s+(?:cb|routing-engine)|firmware|software)\b").unwrap(),
                "`request` commands trigger administrative actions on Juniper devices",
            ),
            (
                Regex::new(r"(?m)^\s*system\s+(?:reset|reboot|halt|shutdown)\b").unwrap(),
                "System commands restart or halt the device",
            ),
            (
                Regex::new(r"(?m)^\s*factory-reset\b").unwrap(),
                "Factory-reset wipes the device configuration",
            ),
            (
                Regex::new(r"(?m)^\s*format\s+(?:flash|disk|bootflash|nvram|usb)").unwrap(),
                "Format erases device storage",
            ),
            (
                Regex::new(r"(?m)^\s*boot\s+system\b").unwrap(),
                "Boot system changes the boot image",
            ),
            (
                Regex::new(r"(?m)^\s*(?:archive|software)\s+(?:download|install|commit|activate)").unwrap(),
                "Archive/software install changes device firmware",
            ),
            (
                Regex::new(r"(?m)^\s*install\s+(?:commit|activate|add|remove)\b").unwrap(),
                "Install commands modify the active firmware",
            ),
            (
                Regex::new(r"(?m)^\s*no\s+\S+").unwrap(),
                "No commands delete configuration",
            ),
            (
                Regex::new(r"(?m)^\s*(?:delete|erase|destroy|wipe)\b").unwrap(),
                "Delete/erase commands remove files or configurations",
            ),
            (
                Regex::new(r"(?m)^\s*clear\s+(?:line|logging|ip|ipv6|arp|mac|counters?|interface|configuration|crypto|isis|ospf|bgp|mpls|route|nd)\b").unwrap(),
                "Clear commands remove operational data",
            ),
            (
                Regex::new(r"(?m)^\s*clear\s+configuration\b").unwrap(),
                "Clear configuration is a Juniper factory-reset equivalent",
            ),
            (
                Regex::new(r"(?m)^\s*set\s+\S+").unwrap(),
                "Set commands modify Juniper configuration",
            ),
            (
                Regex::new(r"(?m)^\s*commit(?:\s+(?:confirmed|check|and-quit|synchronize))?\b").unwrap(),
                "Commit applies configuration changes",
            ),
            (
                Regex::new(r"(?m)^\s*(?:edit|top|exit|update|annotate)\b").unwrap(),
                "Configuration-mode navigation commands are not allowed",
            ),
            (
                Regex::new(r"(?m)^\s*rollback\b").unwrap(),
                "Rollback reverts configuration changes",
            ),
            (
                Regex::new(r"(?m)^\s*(?:load|replace)\s+(?:merge|override|set|patch|update|pattern|terminal)").unwrap(),
                "Load/replace commands inject configuration",
            ),
            (
                Regex::new(r"(?m)^\s*verify\s+(?:md5|sha)").unwrap(),
                "verify md5/sha can be combined with copy/install workflows",
            ),
            (
                Regex::new(r"(?m)^\s*hw-module\s+(?:reset|reload)").unwrap(),
                "hw-module reset reboots a line card",
            ),
        ]
    })
}

impl CommandFilter {
    /// Create a new command filter with default safe prefixes
    pub fn new() -> Self {
        let patterns = get_blocked_patterns();
        let blocked_patterns = patterns
            .iter()
            .map(|(regex, reason)| BlockedPattern {
                regex: regex.clone(),
                reason,
            })
            .collect();

        Self {
            allowed_prefixes: vec![
                "show",
                "display",
                "get",
                "list",
                "ping",
                "traceroute",
                "trace",
            ],
            blocked_patterns,
            bypass: false,
        }
    }

    /// Check if a command is allowed for execution
    ///
    /// AUDIT FIX (EXEC-006): trimming is done before lowercasing so the
    /// allow-prefix test sees the same string the deny patterns do, and the
    /// deny patterns now use multi-line anchors so a leading newline cannot
    /// evade them. The first-token allow-list compares the first whitespace-
    /// delimited token only — substrings like `"display interfaces; halt"`
    /// previously passed because `starts_with("display")` was true; now the
    /// metacharacter pattern catches the `;` separately, but the prefix check
    /// is also tightened to require an exact-token match.
    ///
    /// # Returns
    /// - `Ok(())` if the command is safe to execute
    /// - `Err(CommandFilterError)` if the command is blocked or not allowed
    pub fn is_allowed(&self, command: &str) -> Result<(), CommandFilterError> {
        if self.bypass {
            return Ok(());
        }
        let normalized = command.trim().to_lowercase();

        // Check blocked patterns first (explicit deny)
        for pattern in &self.blocked_patterns {
            if pattern.regex.is_match(&normalized) {
                return Err(CommandFilterError::BlockedCommand {
                    command: command.to_string(),
                    reason: pattern.reason.to_string(),
                });
            }
        }

        // Allow-list: compare against the first whitespace-delimited token.
        let first_token = normalized.split_whitespace().next().unwrap_or("");
        let is_allowed = self
            .allowed_prefixes
            .iter()
            .any(|prefix| first_token == *prefix);

        if is_allowed {
            Ok(())
        } else {
            Err(CommandFilterError::NotAllowed {
                command: command.to_string(),
                allowed_prefixes: self.allowed_prefixes.iter().map(|s| s.to_string()).collect(),
            })
        }
    }
}

impl Default for CommandFilter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allowed_commands() {
        let filter = CommandFilter::new();
        assert!(filter.is_allowed("show version").is_ok());
        assert!(filter.is_allowed("show running-config").is_ok());
        assert!(filter.is_allowed("display interface brief").is_ok());
        assert!(filter.is_allowed("ping 8.8.8.8").is_ok());
        assert!(filter.is_allowed("traceroute 1.1.1.1").is_ok());
        assert!(filter.is_allowed("SHOW VERSION").is_ok()); // case insensitive
    }

    #[test]
    fn test_blocked_config_commands() {
        let filter = CommandFilter::new();
        assert!(filter.is_allowed("configure terminal").is_err());
        assert!(filter.is_allowed("conf t").is_err());
        assert!(filter.is_allowed("config t").is_err());
        assert!(filter.is_allowed("write memory").is_err());
        assert!(filter.is_allowed("write mem").is_err());
        assert!(filter.is_allowed("copy running-config startup-config").is_err());
    }

    #[test]
    fn test_blocked_destructive_commands() {
        let filter = CommandFilter::new();
        assert!(filter.is_allowed("no ip route").is_err());
        assert!(filter.is_allowed("reload").is_err());
        assert!(filter.is_allowed("delete flash:config.txt").is_err());
        assert!(filter.is_allowed("clear line vty 0").is_err());
        assert!(filter.is_allowed("clear counters").is_err());
    }

    #[test]
    fn test_blocked_juniper_commands() {
        let filter = CommandFilter::new();
        assert!(filter.is_allowed("set interfaces").is_err());
        assert!(filter.is_allowed("commit").is_err());
        assert!(filter.is_allowed("edit protocols").is_err());
        assert!(filter.is_allowed("rollback 1").is_err());
    }

    #[test]
    fn test_unlisted_commands_blocked() {
        let filter = CommandFilter::new();
        assert!(filter.is_allowed("debug all").is_err());
        assert!(filter.is_allowed("test interfaces").is_err());
        assert!(filter.is_allowed("enable").is_err());
    }
}
