//! Shared helpers for AI write tools (write_file, edit_file, patch_file).
//!
//! Provides pure functions for filepath validation, command building, and
//! content manipulation. Also provides a shared SSH execution function that
//! bypasses the read-only CommandFilter, for use by write tools that generate
//! their own safe commands.

use std::path::Path;

use base64::Engine as _;
use sqlx::sqlite::SqlitePool;
use std::time::Duration;
use tracing::info;
use uuid::Uuid;

use crate::ssh::{execute_command_on_session, CommandStatus, SshAuth, SshConfig};

const SHELL_METACHARACTERS: &[char] = &[
    ';', '|', '&', '$', '`', '\n', '\r', '\'', '"', '(', ')', '{', '}',
];

/// Maximum file size for edit operations (1 MB).
pub const MAX_EDIT_FILE_SIZE: usize = 1_048_576;

/// Row from session + profile join query (mirrors SshCommandTool's SessionConfigRow).
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

/// Paths the AI is never allowed to overwrite — system credential stores,
/// boot/firmware/configuration paths on common network OSes, kernel/proc
/// pseudo-filesystems, and platform-specific package metadata.
///
/// AUDIT FIX (EXEC-003): the original `validate_filepath` only rejected shell
/// metacharacters and required an absolute path, with no allow/deny list. The
/// AI could therefore overwrite `~/.ssh/authorized_keys`, `/etc/shadow`,
/// `/etc/sudoers`, `/mnt/flash/startup-config`, etc. on the SSH-target. This
/// list is a defense-in-depth deny list; ideally remote writes should also
/// require an explicit per-call user confirmation.
const FORBIDDEN_PATH_PREFIXES: &[&str] = &[
    "/etc/passwd",
    "/etc/shadow",
    "/etc/gshadow",
    "/etc/sudoers",
    "/etc/sudoers.d/",
    "/etc/ssh/",
    "/etc/pam.d/",
    "/etc/security/",
    "/etc/cron.d/",
    "/etc/cron.daily/",
    "/etc/cron.hourly/",
    "/etc/cron.monthly/",
    "/etc/cron.weekly/",
    "/etc/crontab",
    "/etc/systemd/",
    "/etc/init.d/",
    "/etc/rc.d/",
    "/etc/profile",
    "/etc/profile.d/",
    "/etc/bashrc",
    "/etc/zshrc",
    "/root/",
    "/boot/",
    "/dev/",
    "/proc/",
    "/sys/",
    "/var/lib/dpkg/",
    "/var/lib/rpm/",
    "/var/run/",
    "/run/",
    // Network-OS specific config / firmware paths
    "/mnt/flash/startup-config",
    "/mnt/flash/.extensions/",
    "/var/db/juniper/",
    "/config/juniper.conf",
    "/config/db/",
    "/var/log/messages",
    "/var/log/auth.log",
];

/// Substrings (anywhere in the path) that are also forbidden — primarily SSH
/// authorized_keys files in any user's home, and shell rc files.
const FORBIDDEN_PATH_SUBSTRINGS: &[&str] = &[
    "/.ssh/authorized_keys",
    "/.ssh/id_",
    "/.ssh/known_hosts",
    "/.bash_profile",
    "/.bashrc",
    "/.zshrc",
    "/.profile",
    "/.kshrc",
    "/.cshrc",
];

/// Validate and normalize a remote filepath.
///
/// Rejects empty paths, paths containing shell metacharacters, non-absolute
/// paths, paths whose components include `..`, and any path on the
/// destructive-target deny list.
pub fn validate_filepath(filepath: &str) -> Result<String, String> {
    let trimmed = filepath.trim();
    if trimmed.is_empty() {
        return Err("filepath must not be empty".to_string());
    }

    // Reject shell metacharacters
    for ch in SHELL_METACHARACTERS {
        if trimmed.contains(*ch) {
            return Err(format!(
                "filepath contains disallowed character '{}'",
                ch.escape_default()
            ));
        }
    }

    // Reject `..` components — collapsing them would silently change the
    // intended target. The caller must supply the exact path it means.
    let path = Path::new(trimmed);
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(
                "filepath must not contain '..' components — supply the exact absolute path"
                    .to_string(),
            );
        }
    }

    let mut normalized = std::path::PathBuf::new();
    for component in path.components() {
        normalized.push(component);
    }

    let result = normalized.to_string_lossy().to_string();
    if !result.starts_with('/') {
        return Err("filepath must be an absolute path (start with '/')".to_string());
    }

    // Deny-list check
    for forbidden in FORBIDDEN_PATH_PREFIXES {
        if result == *forbidden || result.starts_with(forbidden) {
            return Err(format!(
                "filepath '{}' targets a protected system path; AI write is not permitted",
                result
            ));
        }
    }
    for forbidden in FORBIDDEN_PATH_SUBSTRINGS {
        if result.contains(forbidden) {
            return Err(format!(
                "filepath '{}' contains a protected substring; AI write is not permitted",
                result
            ));
        }
    }

    Ok(result)
}

/// Build a shell command that writes `content` to `filepath` atomically.
///
/// The command base64-encodes the content, writes to a temporary file in the
/// same directory, then atomically moves it into place.
///
/// Returns a shell command string like:
/// ```text
/// printf '%s' '<b64>' | base64 -d > '<tmp>' && mv '<tmp>' '<filepath>'
/// ```
pub fn build_write_command(filepath: &str, content: &str) -> Result<String, String> {
    let filepath = validate_filepath(filepath)?;

    let dir = Path::new(&filepath)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());

    let tmp_name = format!(".netstacks_tmp_{}", Uuid::new_v4());
    let tmp_path = format!("{}/{}", dir, tmp_name);

    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

    Ok(format!(
        "printf '%s' '{}' | base64 -d > '{}' && mv '{}' '{}'",
        b64, tmp_path, tmp_path, filepath
    ))
}

/// Build a command to read a file from the remote device.
///
/// Returns: `cat '<filepath>'`
pub fn build_read_file_command(filepath: &str) -> Result<String, String> {
    let filepath = validate_filepath(filepath)?;
    Ok(format!("cat '{}'", filepath))
}

/// Build a sed in-place edit command.
///
/// AUDIT FIX (EXEC-005): the previous implementation only blocked single
/// quotes, leaving the GNU sed `e` (execute), `w` (write), and `r` (read)
/// flags as direct RCE primitives, plus newline/`;`-separated multi-statement
/// programs and addresses. This validator now accepts ONLY a single
/// substitution of the form `s<sep>PATTERN<sep>REPLACEMENT<sep>FLAGS` where:
///   * the separator is `/`, `#`, `|`, or `,`
///   * `PATTERN` and `REPLACEMENT` may not contain newlines
///   * `FLAGS` is a (possibly empty) subset of `g`, `i`, `I`, `p`, plus an
///     optional decimal occurrence count (e.g. `2g`)
/// All other sed features — `e`/`w`/`r` flags, `;`, newline-separated
/// programs, `d`/`a`/`c`/`i`/`p` standalone commands, address ranges, branch
/// labels, hold-space ops — are rejected.
///
/// Returns: `sed -i '<expr>' '<filepath>'`
pub fn build_sed_command(filepath: &str, sed_expression: &str) -> Result<String, String> {
    let filepath = validate_filepath(filepath)?;

    // Cheap pre-checks: shell-breaking characters and multi-statement payloads.
    if sed_expression.contains('\'') {
        return Err("sed expression must not contain single quotes".to_string());
    }
    if sed_expression.contains('\n') || sed_expression.contains('\r') {
        return Err("sed expression must not contain newlines".to_string());
    }
    if sed_expression.contains(';') {
        return Err("sed expression must not contain ';' (multi-statement)".to_string());
    }

    let trimmed = sed_expression.trim();
    let mut chars = trimmed.chars();
    let s_char = chars.next().ok_or_else(|| "sed expression must not be empty".to_string())?;
    if s_char != 's' {
        return Err("only 's///' substitutions are allowed".to_string());
    }
    let sep = chars.next().ok_or_else(|| "sed expression must include a separator after 's'".to_string())?;
    if !matches!(sep, '/' | '#' | '|' | ',') {
        return Err(format!("unsupported sed separator '{}'", sep));
    }

    // Split the rest by the chosen separator, respecting backslash-escapes.
    let rest: String = chars.collect();
    let mut parts: Vec<String> = Vec::with_capacity(3);
    let mut current = String::new();
    let mut escape = false;
    for ch in rest.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' {
            current.push(ch);
            escape = true;
            continue;
        }
        if ch == sep {
            parts.push(std::mem::take(&mut current));
            continue;
        }
        current.push(ch);
    }
    parts.push(current);

    if parts.len() != 3 {
        return Err(format!(
            "sed expression must be exactly 's{sep}PATTERN{sep}REPLACEMENT{sep}FLAGS' (got {} parts)",
            parts.len()
        ));
    }

    let flags = &parts[2];
    for ch in flags.chars() {
        match ch {
            'g' | 'i' | 'I' | 'p' => {}
            d if d.is_ascii_digit() => {}
            'e' => return Err("sed flag 'e' (execute) is not allowed — would yield RCE".to_string()),
            'w' => return Err("sed flag 'w' (write) is not allowed".to_string()),
            'r' => return Err("sed flag 'r' (read) is not allowed".to_string()),
            'M' | 'm' => return Err("sed flag 'M'/'m' is not allowed".to_string()),
            other => return Err(format!("sed flag '{}' is not allowed", other)),
        }
    }

    Ok(format!("sed -i '{}' '{}'", trimmed, filepath))
}

/// Apply a search-and-replace edit to file content.
///
/// `old_text` must appear exactly once in `content`. If it appears zero
/// times or more than once, an error is returned.
pub fn apply_edit(content: &str, old_text: &str, new_text: &str) -> Result<String, String> {
    if old_text.is_empty() {
        return Err("old_text must not be empty".to_string());
    }

    let count = content.matches(old_text).count();
    match count {
        0 => Err("old_text not found in file content".to_string()),
        1 => Ok(content.replacen(old_text, new_text, 1)),
        n => Err(format!(
            "old_text found {} times in file content — must match exactly once",
            n
        )),
    }
}

/// Execute a command on a remote device via SSH (no CommandFilter).
///
/// Used by write tools that generate their own safe commands. This mirrors
/// the SSH execution path in `SshCommandTool` but skips read-only command
/// filtering.
///
/// # Arguments
/// * `pool` - SQLite connection pool for looking up session/credential data
/// * `session_id` - The session ID to connect to
/// * `command` - The shell command to execute
/// * `timeout` - Maximum time to wait for the command to complete
///
/// # Returns
/// The command's stdout output on success, or an error message string.
pub async fn execute_ssh_for_session(
    pool: &SqlitePool,
    session_id: &str,
    command: &str,
    timeout: Duration,
) -> Result<String, String> {
    // Look up session + credential profile from SQLite
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
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("DB query failed: {}", e))?
    .ok_or_else(|| format!("Session '{}' not found or has no profile", session_id))?;

    // Build auth config
    let auth = match row.auth_type.as_str() {
        "password" => {
            let password = row
                .password
                .ok_or_else(|| "Password not set in profile - unlock vault first".to_string())?;
            SshAuth::Password(password)
        }
        "key" => {
            let path = row
                .key_path
                .ok_or_else(|| "Key path not set in profile".to_string())?;
            SshAuth::KeyFile {
                path,
                passphrase: row.key_passphrase,
            }
        }
        other => return Err(format!("Unknown auth type: {}", other)),
    };

    let config = SshConfig {
        host: row.host.clone(),
        port: row.port as u16,
        username: row.username,
        auth,
        legacy_ssh: row.legacy_ssh,
        skip_keyboard_interactive: false,
    };

    info!(
        session_id = %session_id,
        host = %row.host,
        command_len = command.len(),
        "write_helpers: executing SSH command"
    );

    // Execute via the shared SSH execution function
    let result = execute_command_on_session(
        config,
        session_id.to_string(),
        row.name,
        command.to_string(),
        timeout,
    )
    .await;

    match result.status {
        CommandStatus::Success => Ok(result.output),
        CommandStatus::AuthFailed => Err(format!(
            "SSH authentication failed for {}: {}",
            row.host,
            result.error.unwrap_or_default()
        )),
        CommandStatus::Timeout => Err(format!(
            "SSH command timed out after {}s on {}",
            timeout.as_secs(),
            row.host
        )),
        CommandStatus::Error => Err(format!(
            "SSH command failed on {}: {}",
            row.host,
            result.error.unwrap_or_default()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_filepath_valid() {
        assert_eq!(validate_filepath("/etc/config.txt").unwrap(), "/etc/config.txt");
        assert_eq!(validate_filepath("/home/user/file").unwrap(), "/home/user/file");
    }

    #[test]
    fn test_validate_filepath_rejects_empty() {
        assert!(validate_filepath("").is_err());
        assert!(validate_filepath("   ").is_err());
    }

    #[test]
    fn test_validate_filepath_rejects_relative() {
        assert!(validate_filepath("relative/path").is_err());
    }

    #[test]
    fn test_validate_filepath_rejects_metacharacters() {
        assert!(validate_filepath("/etc/foo;bar").is_err());
        assert!(validate_filepath("/etc/foo|bar").is_err());
        assert!(validate_filepath("/etc/foo$(cmd)").is_err());
        assert!(validate_filepath("/etc/foo`cmd`").is_err());
        assert!(validate_filepath("/etc/foo&bar").is_err());
    }

    #[test]
    fn test_build_write_command() {
        let cmd = build_write_command("/tmp/test.txt", "hello").unwrap();
        assert!(cmd.contains("base64 -d"));
        assert!(cmd.contains("/tmp/test.txt"));
        assert!(cmd.contains(".netstacks_tmp_"));
    }

    #[test]
    fn test_build_read_file_command() {
        let cmd = build_read_file_command("/etc/hosts").unwrap();
        assert_eq!(cmd, "cat '/etc/hosts'");
    }

    #[test]
    fn test_build_sed_command() {
        let cmd = build_sed_command("/etc/config", "s/old/new/g").unwrap();
        assert_eq!(cmd, "sed -i 's/old/new/g' '/etc/config'");
    }

    #[test]
    fn test_build_sed_command_rejects_single_quotes() {
        assert!(build_sed_command("/etc/config", "s/old/'new'/g").is_err());
    }

    #[test]
    fn test_apply_edit_single_match() {
        let result = apply_edit("hello world", "world", "rust").unwrap();
        assert_eq!(result, "hello rust");
    }

    #[test]
    fn test_apply_edit_no_match() {
        assert!(apply_edit("hello world", "missing", "rust").is_err());
    }

    #[test]
    fn test_apply_edit_multiple_matches() {
        assert!(apply_edit("aaa", "a", "b").is_err());
    }

    #[test]
    fn test_apply_edit_empty_old_text() {
        assert!(apply_edit("hello", "", "world").is_err());
    }
}
