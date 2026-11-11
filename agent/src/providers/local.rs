//! Local data provider using SQLite and encrypted credentials
//!
//! This provider is used for the Single User edition of NetStacks.
//! Sessions and folders are stored in SQLite, credentials are encrypted
//! with a master password using AES-256-GCM.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::{FromRow, Row};
// parking_lot replaces std::sync for the vault path: a panic inside a
// critical section won't poison the lock, so one bug doesn't permanently
// brick credential unlock for the rest of the process lifetime.
use parking_lot::{Mutex, RwLock};
use uuid::Uuid;

use crate::crypto::{self, EncryptedData};
use crate::models::*;
use crate::providers::{DataProvider, NewDiscoveredDevice, ProviderError};
use netstacks_credential_vault::CredentialVault;

/// Verification string used to validate master password
const VAULT_VERIFICATION: &str = "COCKPIT_VAULT_OK";

/// Minimum master-password length (AUDIT FIX CRYPTO-009).
///
/// 12 chars is the floor; the frontend's `VaultUnlockGate` previously enforced
/// only 8 chars client-side and the backend enforced nothing, so a malicious
/// caller (or a misuse during scripted setup) could downgrade the vault to a
/// single character. This is enforced server-side in `set_master_password`.
const MIN_MASTER_PASSWORD_LEN: usize = 12;

/// Sliding-window failed-unlock tracker (AUDIT FIX CRYPTO-007).
///
/// Counts failed unlock attempts and forces an exponential-backoff sleep on
/// the calling task. After `MAX_FAILS_BEFORE_COOLDOWN` failures within the
/// window, the cooldown enters a fixed long sleep until the window expires.
#[derive(Debug, Default)]
struct UnlockAttempts {
    failures: u32,
    /// Unix-epoch seconds at which the next attempt is allowed.
    next_allowed_at_epoch: i64,
}

const MAX_FAILS_BEFORE_COOLDOWN: u32 = 5;
const COOLDOWN_SECS: i64 = 60;

/// Run the Argon2id vault derivation on Tokio's blocking pool.
///
/// Argon2id is deliberately CPU/memory-hard; running it inline in an async
/// provider method stalls every other task scheduled on that worker. The
/// closure needs `'static`, so the password is copied into it. The outer
/// `Err` is a KDF task failure (panic/cancel); the inner result is the
/// derivation itself so each caller keeps its existing error mapping.
async fn derive_vault_off_worker(
    password: &str,
    salt: [u8; crypto::SALT_SIZE],
) -> Result<Result<CredentialVault, crypto::CryptoError>, ProviderError> {
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || crypto::derive_vault(&password, &salt))
        .await
        .map_err(|e| ProviderError::Encryption(format!("key derivation task failed: {e}")))
}

/// True when `vault` decrypts the stored verification record to
/// `VAULT_VERIFICATION`. Any decrypt failure (the normal wrong-password
/// outcome under AES-GCM) is a mismatch. The compare is constant-time
/// (AUDIT FIX CRYPTO-014): a short-circuiting `!=` leaks timing info.
fn vault_matches_verification(vault: &CredentialVault, verification: &EncryptedData) -> bool {
    use subtle::ConstantTimeEq;
    match crypto::decrypt_with_vault(verification, vault) {
        Ok(decrypted) => decrypted
            .as_bytes()
            .ct_eq(VAULT_VERIFICATION.as_bytes())
            .into(),
        Err(_) => false,
    }
}

/// Local data provider using SQLite
pub struct LocalDataProvider {
    pool: SqlitePool,
    /// Cached vault derived on unlock — `None` means locked.
    /// `CredentialVault` wraps `Aes256Gcm`, which zeroizes its internal key on drop
    /// (aes-gcm 0.10 default features), so dropping the cache wipes the key.
    master_vault: RwLock<Option<CredentialVault>>,
    master_salt: RwLock<Option<[u8; 32]>>,
    unlock_attempts: Mutex<UnlockAttempts>,
}

/// Console access is either fully configured (host AND port, plus a
/// terminal-server profile when the console is reached over SSH) or absent.
/// Every writer (settings dialog, JSON/CSV import, NetBox import, API) goes
/// through here, so "Open Console" can rely on a configured console being
/// connectable.
fn validate_console_access(
    host: Option<&str>,
    port: Option<u16>,
    protocol: &Protocol,
    profile_id: Option<&str>,
) -> Result<(), ProviderError> {
    match (host.map(str::trim).filter(|h| !h.is_empty()), port) {
        (None, None) => Ok(()),
        (Some(_), Some(p)) if p > 0 => {
            if *protocol == Protocol::Ssh
                && profile_id
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .is_none()
            {
                return Err(ProviderError::Validation(
                    "Console access over SSH needs a credential profile for the terminal server login".to_string(),
                ));
            }
            Ok(())
        }
        (Some(_), Some(_)) => Err(ProviderError::Validation(
            "Console port must be between 1 and 65535".to_string(),
        )),
        (Some(_), None) => Err(ProviderError::Validation(
            "Console access needs a port on the terminal server".to_string(),
        )),
        (None, Some(_)) => Err(ProviderError::Validation(
            "Console access needs a terminal server host".to_string(),
        )),
    }
}

/// Columns to select for SessionRow (avoiding SELECT * which includes deprecated columns)
const SESSION_COLUMNS: &str = "id, name, folder_id, host, port, color, icon, sort_order, \
    last_connected_at, created_at, updated_at, auto_reconnect, reconnect_delay, \
    scrollback_lines, local_echo, font_size_override, font_family, profile_id, \
    netbox_device_id, netbox_source_id, cli_flavor, terminal_theme, jump_host_id, jump_session_id, \
    port_forwards, auto_commands, legacy_ssh, protocol, sftp_start_path, \
    console_host, console_port, console_protocol, console_profile_id, console_legacy_ssh";

/// Internal row type for sessions from SQLite
#[derive(Debug, FromRow)]
struct SessionRow {
    id: String,
    name: String,
    folder_id: Option<String>,
    host: String,
    port: i32,
    color: Option<String>,
    icon: Option<String>,
    sort_order: i32,
    last_connected_at: Option<String>,
    created_at: String,
    updated_at: String,
    // Session-specific settings
    auto_reconnect: Option<i32>,
    reconnect_delay: Option<i32>,
    scrollback_lines: Option<i32>,
    local_echo: Option<i32>,
    font_size_override: Option<i32>,
    font_family: Option<String>,
    // Profile integration - all auth comes from profile
    profile_id: String,
    netbox_device_id: Option<i64>,
    netbox_source_id: Option<String>,
    // AI features
    cli_flavor: Option<String>,
    // Terminal appearance
    terminal_theme: Option<String>,
    // Jump host reference (global jump hosts)
    jump_host_id: Option<String>,
    // Session-as-jump alternative
    jump_session_id: Option<String>,
    // Port forwarding (Phase 06.3)
    port_forwards: Option<String>,
    // Auto commands on connect
    auto_commands: Option<String>,
    // Legacy SSH support
    legacy_ssh: Option<i32>,
    // Connection protocol
    protocol: Option<String>,
    // SFTP starting directory
    sftp_start_path: Option<String>,
    // OOB console access
    console_host: Option<String>,
    console_port: Option<i32>,
    console_protocol: Option<String>,
    console_profile_id: Option<String>,
    console_legacy_ssh: Option<i32>,
}

impl SessionRow {
    fn into_session(self) -> Result<Session, ProviderError> {
        let last_connected_at = self
            .last_connected_at
            .map(|s| parse_datetime(&s))
            .transpose()?;

        Ok(Session {
            id: self.id,
            name: self.name,
            folder_id: self.folder_id,
            host: self.host,
            port: self.port as u16,
            color: self.color,
            icon: self.icon,
            sort_order: self.sort_order,
            last_connected_at,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
            // Session-specific settings with defaults
            auto_reconnect: self.auto_reconnect.map(|v| v != 0).unwrap_or(true),
            reconnect_delay: self.reconnect_delay.map(|v| v as u32).unwrap_or(5),
            scrollback_lines: self.scrollback_lines.map(|v| v as u32).unwrap_or(10000),
            local_echo: self.local_echo.map(|v| v != 0).unwrap_or(false),
            font_size_override: self.font_size_override.map(|v| v as u32),
            font_family: self.font_family,
            // Profile integration - all auth comes from profile
            profile_id: self.profile_id,
            netbox_device_id: self.netbox_device_id,
            netbox_source_id: self.netbox_source_id,
            // AI features
            cli_flavor: match self.cli_flavor.as_deref() {
                Some("linux") => CliFlavor::Linux,
                Some("cisco-ios") => CliFlavor::CiscoIos,
                Some("cisco-xr") | Some("cisco-iosxr") | Some("cisco-ios-xr") => {
                    CliFlavor::CiscoIosXr
                }
                Some("cisco-nxos") => CliFlavor::CiscoNxos,
                Some("juniper") => CliFlavor::Juniper,
                Some("arista") => CliFlavor::Arista,
                Some("paloalto") => CliFlavor::Paloalto,
                Some("fortinet") => CliFlavor::Fortinet,
                _ => CliFlavor::Auto,
            },
            // Terminal appearance
            terminal_theme: self.terminal_theme,
            // Jump host reference (global jump hosts)
            jump_host_id: self.jump_host_id,
            // Session-as-jump alternative (mutually exclusive with jump_host_id)
            jump_session_id: self.jump_session_id,
            // Port forwarding (Phase 06.3)
            port_forwards: self
                .port_forwards
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default(),
            // Auto commands on connect
            auto_commands: self
                .auto_commands
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default(),
            // Legacy SSH support
            legacy_ssh: self.legacy_ssh.map(|v| v != 0).unwrap_or(false),
            // Connection protocol
            protocol: Protocol::from_db(self.protocol.as_deref()),
            // SFTP starting directory
            sftp_start_path: self.sftp_start_path,
            // OOB console access
            console_host: self.console_host,
            console_port: self.console_port.and_then(|v| u16::try_from(v).ok()),
            console_protocol: Protocol::from_db(self.console_protocol.as_deref()),
            console_profile_id: self.console_profile_id,
            console_legacy_ssh: self.console_legacy_ssh.map(|v| v != 0).unwrap_or(false),
        })
    }
}

/// Internal row type for mapped keys from SQLite
#[derive(Debug, FromRow)]
struct MappedKeyRow {
    id: String,
    key_combo: String,
    command: String,
    description: Option<String>,
    is_secret: bool,
    command_encrypted: Option<Vec<u8>>,
    created_at: String,
}

impl MappedKeyRow {
    /// Convert to the public model. The plaintext of a secret key is never
    /// surfaced here — `command` is stored empty for secret rows, so this
    /// naturally masks it. Use `reveal_mapped_key` to decrypt on demand.
    fn into_mapped_key(self) -> Result<MappedKey, ProviderError> {
        Ok(MappedKey {
            id: self.id,
            key_combo: self.key_combo,
            command: self.command,
            description: self.description,
            is_secret: self.is_secret,
            created_at: parse_datetime(&self.created_at)?,
        })
    }
}

/// Internal row type for custom commands from SQLite
#[derive(Debug, FromRow)]
struct CustomCommandRow {
    id: String,
    name: String,
    command: String,
    detection_types: Option<String>,
    sort_order: i32,
    enabled: bool,
    created_at: String,
    action_type: String,
    quick_action_id: Option<String>,
    quick_action_variable: Option<String>,
    script_id: Option<String>,
    show_in_force_click: bool,
}

impl CustomCommandRow {
    fn into_custom_command(self) -> Result<CustomCommand, ProviderError> {
        Ok(CustomCommand {
            id: self.id,
            name: self.name,
            command: self.command,
            detection_types: self.detection_types,
            sort_order: self.sort_order,
            enabled: self.enabled,
            created_at: parse_datetime(&self.created_at)?,
            action_type: self.action_type,
            quick_action_id: self.quick_action_id,
            quick_action_variable: self.quick_action_variable,
            script_id: self.script_id,
            show_in_force_click: self.show_in_force_click,
        })
    }
}

#[derive(Debug, FromRow)]
struct AiConversationRow {
    id: String,
    title: String,
    messages: String,
    agent_type: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AiConversationRow {
    fn into_conversation(self) -> Result<AiConversation, ProviderError> {
        Ok(AiConversation {
            id: self.id,
            title: self.title,
            messages: serde_json::from_str(&self.messages)
                .unwrap_or_else(|_| serde_json::Value::Array(Vec::new())),
            agent_type: self.agent_type,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

#[derive(Debug, FromRow)]
struct AiConversationSummaryRow {
    id: String,
    title: String,
    agent_type: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AiConversationSummaryRow {
    fn into_summary(self) -> Result<AiConversationSummary, ProviderError> {
        Ok(AiConversationSummary {
            id: self.id,
            title: self.title,
            agent_type: self.agent_type,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for snippets from SQLite
#[derive(Debug, FromRow)]
struct SnippetRow {
    id: String,
    session_id: Option<String>,
    name: String,
    command: String,
    sort_order: i32,
    created_at: String,
}

impl SnippetRow {
    fn into_snippet(self) -> Result<Snippet, ProviderError> {
        Ok(Snippet {
            id: self.id,
            session_id: self.session_id,
            name: self.name,
            command: self.command,
            sort_order: self.sort_order,
            created_at: parse_datetime(&self.created_at)?,
        })
    }
}

/// Internal row type for clipboard history from SQLite
#[derive(Debug, FromRow)]
struct ClipRow {
    id: String,
    text: String,
    created_at: String,
    provenance: String,
    pinned: bool,
    line_ending: String,
    bytes: i64,
    lines: i64,
    redacted: bool,
}

impl ClipRow {
    fn into_clip(self) -> Result<Clip, ProviderError> {
        Ok(Clip {
            id: self.id,
            text: self.text,
            created_at: parse_datetime(&self.created_at)?,
            provenance: serde_json::from_str(&self.provenance)
                .unwrap_or_else(|_| serde_json::Value::Object(Default::default())),
            pinned: self.pinned,
            line_ending: self.line_ending,
            bytes: self.bytes,
            lines: self.lines,
            redacted: self.redacted,
        })
    }
}

/// Lines as a terminal would paste them: CRLF/CR normalised, a trailing
/// newline does not add a line. Mirrors `countLines` in the frontend.
fn clip_line_count(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut n = normalized.split('\n').count() as i64;
    if normalized.ends_with('\n') {
        n -= 1;
    }
    n
}

/// Internal row type for connection history from SQLite
#[derive(Debug, FromRow)]
struct ConnectionHistoryRow {
    id: String,
    session_id: Option<String>,
    host: String,
    port: i32,
    username: String,
    connected_at: String,
    disconnected_at: Option<String>,
    duration_seconds: Option<i32>,
}

impl ConnectionHistoryRow {
    fn into_history(self) -> Result<ConnectionHistory, ProviderError> {
        let disconnected_at = self
            .disconnected_at
            .map(|s| parse_datetime(&s))
            .transpose()?;

        Ok(ConnectionHistory {
            id: self.id,
            session_id: self.session_id,
            host: self.host,
            port: self.port as u16,
            username: self.username,
            connected_at: parse_datetime(&self.connected_at)?,
            disconnected_at,
            duration_seconds: self.duration_seconds,
        })
    }
}

/// Internal row type for folders from SQLite
#[derive(Debug, FromRow)]
struct FolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    scope: String,
    sort_order: i32,
    created_at: String,
    updated_at: String,
}

impl FolderRow {
    fn into_folder(self) -> Result<Folder, ProviderError> {
        Ok(Folder {
            id: self.id,
            name: self.name,
            parent_id: self.parent_id,
            scope: self.scope,
            sort_order: self.sort_order,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Stored profile credential in JSON format for encryption
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProfileCredential {
    password: Option<String>,
    key_passphrase: Option<String>,
    /// SNMP community strings (added in Phase 06)
    /// serde(default) ensures old encrypted data without this field deserializes as None
    #[serde(default)]
    snmp_communities: Option<Vec<String>>,
}

/// Internal row type for credential profiles from SQLite
#[derive(Debug, FromRow)]
struct CredentialProfileRow {
    id: String,
    name: String,
    username: String,
    auth_type: String,
    key_path: Option<String>,
    port: i32,
    keepalive_interval: i32,
    connection_timeout: i32,
    terminal_theme: Option<String>,
    default_font_size: Option<i32>,
    default_font_family: Option<String>,
    scrollback_lines: i32,
    local_echo: i32,
    auto_reconnect: i32,
    reconnect_delay: i32,
    cli_flavor: String,
    auto_commands: Option<String>,
    jump_host_id: Option<String>,
    jump_session_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl CredentialProfileRow {
    fn into_profile(self) -> Result<CredentialProfile, ProviderError> {
        let auth_type = match self.auth_type.as_str() {
            "password" => AuthType::Password,
            "key" => AuthType::Key,
            _ => AuthType::Password,
        };

        let cli_flavor =
            serde_json::from_value::<CliFlavor>(serde_json::Value::String(self.cli_flavor.clone()))
                .unwrap_or_default();

        let auto_commands: Vec<String> = self
            .auto_commands
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        Ok(CredentialProfile {
            id: self.id,
            name: self.name,
            username: self.username,
            auth_type,
            key_path: self.key_path,
            port: self.port as u16,
            keepalive_interval: self.keepalive_interval as u32,
            connection_timeout: self.connection_timeout as u32,
            terminal_theme: self.terminal_theme,
            default_font_size: self.default_font_size.map(|v| v as u32),
            default_font_family: self.default_font_family,
            scrollback_lines: self.scrollback_lines as u32,
            local_echo: self.local_echo != 0,
            auto_reconnect: self.auto_reconnect != 0,
            reconnect_delay: self.reconnect_delay as u32,
            cli_flavor,
            auto_commands,
            jump_host_id: self.jump_host_id,
            jump_session_id: self.jump_session_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for jump hosts from SQLite
#[derive(Debug, FromRow)]
struct JumpHostRow {
    id: String,
    name: String,
    host: String,
    port: i32,
    profile_id: String,
    created_at: String,
    updated_at: String,
}

impl JumpHostRow {
    fn into_jump_host(self) -> Result<JumpHost, ProviderError> {
        Ok(JumpHost {
            id: self.id,
            name: self.name,
            host: self.host,
            port: self.port as u16,
            profile_id: self.profile_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for NetBox sources from SQLite
#[derive(Debug, FromRow)]
struct NetBoxSourceRow {
    id: String,
    name: String,
    api_resource_id: String,
    default_profile_id: Option<String>,
    profile_mappings: Option<String>,
    cli_flavor_mappings: Option<String>,
    device_filters: Option<String>,
    console_profile_id: Option<String>,
    console_protocol_mappings: Option<String>,
    last_sync_at: Option<String>,
    last_sync_filters: Option<String>,
    last_sync_result: Option<String>,
    created_at: String,
    updated_at: String,
}

/// Internal row type for recordings from SQLite
#[derive(Debug, FromRow)]
struct RecordingRow {
    id: String,
    session_id: Option<String>,
    name: String,
    terminal_cols: i32,
    terminal_rows: i32,
    duration_ms: i64,
    file_path: String,
    created_at: String,
    updated_at: String,
}

impl RecordingRow {
    fn into_recording(self) -> Result<Recording, ProviderError> {
        Ok(Recording {
            id: self.id,
            session_id: self.session_id,
            name: self.name,
            terminal_cols: self.terminal_cols as u32,
            terminal_rows: self.terminal_rows as u32,
            duration_ms: self.duration_ms as u64,
            file_path: self.file_path,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for highlight rules from SQLite
#[derive(Debug, FromRow)]
struct HighlightRuleRow {
    id: String,
    name: String,
    pattern: String,
    is_regex: i32,
    case_sensitive: i32,
    whole_word: i32,
    foreground: Option<String>,
    background: Option<String>,
    bold: i32,
    italic: i32,
    underline: i32,
    category: String,
    priority: i32,
    enabled: i32,
    session_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl HighlightRuleRow {
    fn into_highlight_rule(self) -> Result<HighlightRule, ProviderError> {
        Ok(HighlightRule {
            id: self.id,
            name: self.name,
            pattern: self.pattern,
            is_regex: self.is_regex != 0,
            case_sensitive: self.case_sensitive != 0,
            whole_word: self.whole_word != 0,
            foreground: self.foreground,
            background: self.background,
            bold: self.bold != 0,
            italic: self.italic != 0,
            underline: self.underline != 0,
            category: self.category,
            priority: self.priority,
            enabled: self.enabled != 0,
            session_id: self.session_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for changes from SQLite
#[derive(Debug, FromRow)]
struct ChangeRow {
    id: String,
    session_id: Option<String>,
    name: String,
    description: Option<String>,
    status: String,
    mop_steps: String,
    pre_snapshot_id: Option<String>,
    post_snapshot_id: Option<String>,
    ai_analysis: Option<String>,
    created_by: String,
    created_at: String,
    updated_at: String,
    executed_at: Option<String>,
    completed_at: Option<String>,
    device_overrides: Option<String>,
    document_id: Option<String>,
    risk_level: Option<String>,
    change_ticket: Option<String>,
    tags: Option<String>,
    session_ids: Option<String>,
    variables: Option<String>,
    device_variables: Option<String>,
}

/// Parse a persisted `MopStep[]` JSON array, keeping every element that
/// parses. One malformed element (the AI mop tool writes raw JSON) used to
/// `unwrap_or_default()` the whole plan to zero steps; now it is logged and
/// dropped on its own.
pub(crate) fn parse_mop_steps_lenient(json: &str, context: &str) -> Vec<MopStep> {
    match serde_json::from_str::<Vec<MopStep>>(json) {
        Ok(steps) => steps,
        Err(strict_err) => {
            let raw: Vec<serde_json::Value> = match serde_json::from_str(json) {
                Ok(v) => v,
                Err(_) => {
                    tracing::warn!(
                        "{}: mop_steps is not a JSON array ({}); treating as empty",
                        context,
                        strict_err
                    );
                    return Vec::new();
                }
            };
            raw.into_iter()
                .enumerate()
                .filter_map(|(i, v)| match serde_json::from_value::<MopStep>(v) {
                    Ok(step) => Some(step),
                    Err(e) => {
                        tracing::warn!("{}: dropping unparseable mop_steps[{}]: {}", context, i, e);
                        None
                    }
                })
                .collect()
        }
    }
}

fn parse_string_list(json: Option<&str>) -> Vec<String> {
    json.and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default()
}

/// `mop_execution_devices.variables`: NULL → None, bad JSON → None (logged).
fn parse_device_variables(json: Option<&str>) -> Option<std::collections::HashMap<String, String>> {
    let raw = json.map(str::trim).filter(|j| !j.is_empty())?;
    match serde_json::from_str(raw) {
        Ok(map) => Some(map),
        Err(e) => {
            tracing::warn!(
                "mop_execution_device variables: unreadable JSON ({}); ignoring",
                e
            );
            None
        }
    }
}

/// Parse an optional JSON column into `T`, logging (not failing) on bad data.
fn parse_json_column<T: serde::de::DeserializeOwned + Default>(
    json: Option<&str>,
    context: &str,
) -> T {
    match json.map(str::trim).filter(|j| !j.is_empty()) {
        Some(j) => serde_json::from_str(j).unwrap_or_else(|e| {
            tracing::warn!("{}: unreadable JSON ({}); treating as empty", context, e);
            T::default()
        }),
        None => T::default(),
    }
}

impl ChangeRow {
    fn into_change(self) -> Result<Change, ProviderError> {
        let status = ChangeStatus::from_str(&self.status).unwrap_or(ChangeStatus::Draft);

        let mop_steps = parse_mop_steps_lenient(&self.mop_steps, &format!("change {}", self.id));

        let device_overrides = self.device_overrides.as_deref().and_then(|raw| {
            let map: std::collections::HashMap<String, serde_json::Value> =
                serde_json::from_str(raw).ok()?;
            Some(
                map.into_iter()
                    .map(|(k, v)| {
                        let steps = parse_mop_steps_lenient(
                            &v.to_string(),
                            &format!("change {} override {}", self.id, k),
                        );
                        (k, steps)
                    })
                    .collect::<std::collections::HashMap<String, Vec<MopStep>>>(),
            )
        });
        let tags = parse_string_list(self.tags.as_deref());
        let session_ids = parse_string_list(self.session_ids.as_deref());
        let variables: Vec<MopVariable> = parse_json_column(
            self.variables.as_deref(),
            &format!("change {} variables", self.id),
        );
        let device_variables: DeviceVariableMap = parse_json_column(
            self.device_variables.as_deref(),
            &format!("change {} device_variables", self.id),
        );

        let executed_at = self.executed_at.map(|s| parse_datetime(&s)).transpose()?;

        let completed_at = self.completed_at.map(|s| parse_datetime(&s)).transpose()?;

        Ok(Change {
            id: self.id,
            session_id: self.session_id,
            name: self.name,
            description: self.description,
            status,
            mop_steps,
            device_overrides,
            variables,
            device_variables,
            pre_snapshot_id: self.pre_snapshot_id,
            post_snapshot_id: self.post_snapshot_id,
            ai_analysis: self.ai_analysis,
            document_id: self.document_id,
            risk_level: self.risk_level,
            change_ticket: self.change_ticket,
            tags,
            session_ids,
            created_by: self.created_by,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
            executed_at,
            completed_at,
        })
    }
}

/// Internal row type for snapshots from SQLite
#[derive(Debug, FromRow)]
struct SnapshotRow {
    id: String,
    change_id: Option<String>,
    execution_id: Option<String>,
    snapshot_type: String,
    commands: String,
    output: String,
    captured_at: String,
}

impl SnapshotRow {
    fn into_snapshot(self) -> Result<Snapshot, ProviderError> {
        let commands: Vec<String> = serde_json::from_str(&self.commands).unwrap_or_default();

        Ok(Snapshot {
            id: self.id,
            change_id: self.change_id,
            execution_id: self.execution_id,
            snapshot_type: self.snapshot_type,
            commands,
            output: self.output,
            captured_at: parse_datetime(&self.captured_at)?,
        })
    }
}

/// Internal row type for session context from SQLite
#[derive(Debug, FromRow)]
struct SessionContextRow {
    id: String,
    session_id: String,
    issue: String,
    root_cause: Option<String>,
    resolution: Option<String>,
    commands: Option<String>,
    ticket_ref: Option<String>,
    author: String,
    created_at: String,
    updated_at: String,
}

impl SessionContextRow {
    fn into_session_context(self) -> Result<SessionContext, ProviderError> {
        Ok(SessionContext {
            id: self.id,
            session_id: self.session_id,
            issue: self.issue,
            root_cause: self.root_cause,
            resolution: self.resolution,
            commands: self.commands,
            ticket_ref: self.ticket_ref,
            author: self.author,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

#[derive(Debug, FromRow)]
struct DeviceMemoryRow {
    id: String,
    session_id: String,
    role: Option<String>,
    criticality: Option<String>,
    standing_instructions: Option<String>,
    notes: Option<String>,
    created_at: String,
    updated_at: String,
}

impl DeviceMemoryRow {
    fn into_device_memory(self) -> Result<DeviceMemory, ProviderError> {
        Ok(DeviceMemory {
            id: self.id,
            session_id: self.session_id,
            role: self.role,
            criticality: self.criticality,
            standing_instructions: self.standing_instructions,
            notes: self.notes,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

#[derive(Debug, FromRow)]
struct DeviceMemoryEntryRow {
    id: String,
    device_memory_id: String,
    date: String,
    source: String,
    author: String,
    content: String,
    created_at: String,
    updated_at: String,
}

impl DeviceMemoryEntryRow {
    fn into_entry(self) -> Result<DeviceMemoryEntry, ProviderError> {
        Ok(DeviceMemoryEntry {
            id: self.id,
            device_memory_id: self.device_memory_id,
            date: self.date,
            source: self.source,
            author: self.author,
            content: self.content,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for saved topologies from SQLite (Phase 20.1)
#[derive(Debug, FromRow)]
struct SavedTopologyRow {
    id: String,
    name: String,
    folder_id: Option<String>,
    sort_order: f64,
    shared: i64,
    created_at: String,
    updated_at: String,
}

impl SavedTopologyRow {
    fn into_saved_topology(self) -> Result<SavedTopology, ProviderError> {
        Ok(SavedTopology {
            id: self.id,
            name: self.name,
            folder_id: self.folder_id,
            sort_order: self.sort_order,
            shared: self.shared != 0,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for topology devices from SQLite (Phase 20.1)
#[derive(Debug, FromRow)]
struct TopologyDeviceRow {
    id: String,
    topology_id: String,
    session_id: Option<String>,
    x: f64,
    y: f64,
    device_type: String,
    name: String,
    host: String,
    created_at: String,
    updated_at: String,
    // Enrichment fields
    platform: Option<String>,
    version: Option<String>,
    model: Option<String>,
    serial: Option<String>,
    vendor: Option<String>,
    primary_ip: Option<String>,
    uptime: Option<String>,
    status: Option<String>,
    site: Option<String>,
    role: Option<String>,
    notes: Option<String>,
    // Added via ALTER TABLE migration - must be at end to match DB column order
    profile_id: Option<String>,
    snmp_profile_id: Option<String>,
}

impl TopologyDeviceRow {
    fn into_topology_device(self) -> Result<TopologyDevice, ProviderError> {
        Ok(TopologyDevice {
            id: self.id,
            topology_id: self.topology_id,
            session_id: self.session_id,
            profile_id: self.profile_id,
            snmp_profile_id: self.snmp_profile_id,
            x: self.x,
            y: self.y,
            device_type: self.device_type,
            name: self.name,
            host: self.host,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
            // Enrichment fields
            platform: self.platform,
            version: self.version,
            model: self.model,
            serial: self.serial,
            vendor: self.vendor,
            primary_ip: self.primary_ip,
            uptime: self.uptime,
            status: self.status,
            site: self.site,
            role: self.role,
            notes: self.notes,
        })
    }
}

/// Internal row type for topology connections from SQLite (Phase 20.1, enhanced 27-02)
#[derive(Debug, FromRow)]
struct TopologyConnectionRow {
    id: String,
    topology_id: String,
    source_device_id: String,
    target_device_id: String,
    source_interface: Option<String>,
    target_interface: Option<String>,
    protocol: String,
    label: Option<String>,
    created_at: String,
    // Enhanced routing and styling (Phase 27-02)
    waypoints: Option<String>,
    curve_style: Option<String>,
    bundle_id: Option<String>,
    bundle_index: Option<i32>,
    color: Option<String>,
    line_style: Option<String>,
    line_width: Option<i32>,
    notes: Option<String>,
}

impl TopologyConnectionRow {
    fn into_topology_connection(self) -> Result<TopologyConnection, ProviderError> {
        Ok(TopologyConnection {
            id: self.id,
            topology_id: self.topology_id,
            source_device_id: self.source_device_id,
            target_device_id: self.target_device_id,
            source_interface: self.source_interface,
            target_interface: self.target_interface,
            protocol: self.protocol,
            label: self.label,
            created_at: parse_datetime(&self.created_at)?,
            // Enhanced routing and styling (Phase 27-02)
            waypoints: self.waypoints,
            curve_style: self.curve_style,
            bundle_id: self.bundle_id,
            bundle_index: self.bundle_index,
            color: self.color,
            line_style: self.line_style,
            line_width: self.line_width,
            notes: self.notes,
        })
    }
}

/// Internal row type for LibreNMS sources from SQLite (Phase 22)
#[derive(Debug, FromRow)]
struct LibreNmsSourceRow {
    id: String,
    name: String,
    api_resource_id: String,
    created_at: String,
    updated_at: String,
}

impl LibreNmsSourceRow {
    fn into_source(self) -> Result<LibreNmsSource, ProviderError> {
        Ok(LibreNmsSource {
            id: self.id,
            name: self.name,
            api_resource_id: self.api_resource_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for Netdisco sources from SQLite (Phase 22)
#[derive(Debug, FromRow)]
struct NetStacksCrawlerSourceRow {
    id: String,
    name: String,
    api_resource_id: String,
    created_at: String,
    updated_at: String,
}

impl NetStacksCrawlerSourceRow {
    fn into_source(self) -> Result<NetStacksCrawlerSource, ProviderError> {
        Ok(NetStacksCrawlerSource {
            id: self.id,
            name: self.name,
            api_resource_id: self.api_resource_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for layouts from SQLite (Phase 25)
#[derive(Debug, FromRow)]
struct LayoutRow {
    id: String,
    name: String,
    session_ids: String,  // JSON array (legacy)
    tabs: Option<String>, // JSON array of LayoutTab objects
    orientation: String,
    sizes: Option<String>, // JSON array
    created_at: String,
    updated_at: String,
}

impl LayoutRow {
    fn into_layout(self) -> Result<Layout, ProviderError> {
        let session_ids: Vec<String> = serde_json::from_str(&self.session_ids)
            .map_err(|e| ProviderError::Database(format!("Failed to parse session_ids: {}", e)))?;
        let tabs: Option<Vec<LayoutTab>> = self
            .tabs
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to parse tabs: {}", e)))?;
        let sizes: Option<Vec<f64>> = self
            .sizes
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to parse sizes: {}", e)))?;

        Ok(Layout {
            id: self.id,
            name: self.name,
            session_ids,
            tabs,
            orientation: self.orientation,
            sizes,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for API resources from SQLite
#[derive(Debug, FromRow)]
struct ApiResourceRow {
    id: String,
    name: String,
    base_url: String,
    auth_type: String,
    auth_header_name: Option<String>,
    auth_header_prefix: Option<String>,
    auth_flow: Option<String>,
    default_headers: String,
    custom_headers: String,
    verify_ssl: i32,
    timeout_secs: i32,
    test_path: Option<String>,
    created_at: String,
    updated_at: String,
    /// Whether credentials exist in api_resource_credentials table (from LEFT JOIN)
    has_credentials: i32,
}

impl ApiResourceRow {
    fn into_api_resource(self) -> Result<ApiResource, ProviderError> {
        let auth_type: ApiResourceAuthType = self
            .auth_type
            .parse()
            .map_err(|e: String| ProviderError::Database(e))?;
        let auth_flow: Option<Vec<AuthFlowStep>> = self
            .auth_flow
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to parse auth_flow: {}", e)))?;
        let default_headers: serde_json::Value =
            serde_json::from_str(&self.default_headers).unwrap_or_else(|_| serde_json::json!({}));
        let custom_headers: serde_json::Value =
            serde_json::from_str(&self.custom_headers).unwrap_or_else(|_| serde_json::json!([]));

        Ok(ApiResource {
            id: self.id,
            name: self.name,
            base_url: self.base_url,
            auth_type,
            auth_header_name: self.auth_header_name,
            auth_header_prefix: self.auth_header_prefix,
            auth_flow,
            default_headers,
            custom_headers,
            verify_ssl: self.verify_ssl != 0,
            timeout_secs: self.timeout_secs,
            has_credentials: self.has_credentials != 0,
            test_path: self.test_path,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for quick actions from SQLite
#[derive(Debug, FromRow)]
struct QuickActionRow {
    id: String,
    name: String,
    description: Option<String>,
    api_resource_id: String,
    method: String,
    path: String,
    headers: String,
    body: Option<String>,
    json_extract_path: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    sort_order: i32,
    category: Option<String>,
    created_at: String,
    updated_at: String,
}

impl QuickActionRow {
    fn into_quick_action(self) -> Result<QuickAction, ProviderError> {
        let headers: serde_json::Value =
            serde_json::from_str(&self.headers).unwrap_or_else(|_| serde_json::json!({}));

        Ok(QuickAction {
            id: self.id,
            name: self.name,
            description: self.description,
            api_resource_id: self.api_resource_id,
            method: self.method,
            path: self.path,
            headers,
            body: self.body,
            json_extract_path: self.json_extract_path,
            icon: self.icon,
            color: self.color,
            sort_order: self.sort_order,
            category: self.category,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for quick prompts from SQLite
#[derive(Debug, FromRow)]
struct QuickPromptRow {
    id: String,
    name: String,
    prompt: String,
    is_favorite: i32,
    created_at: String,
    updated_at: String,
}

impl QuickPromptRow {
    fn into_quick_prompt(self) -> Result<QuickPrompt, ProviderError> {
        Ok(QuickPrompt {
            id: self.id,
            name: self.name,
            prompt: self.prompt,
            is_favorite: self.is_favorite != 0,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for agent definitions from SQLite
#[derive(Debug, FromRow)]
struct AgentDefinitionRow {
    id: String,
    name: String,
    description: Option<String>,
    system_prompt: String,
    provider: Option<String>,
    model: Option<String>,
    temperature: Option<f64>,
    max_iterations: i32,
    max_tokens: i32,
    enabled: i32,
    created_at: String,
    updated_at: String,
}

impl AgentDefinitionRow {
    fn into_agent_definition(self) -> Result<AgentDefinition, ProviderError> {
        Ok(AgentDefinition {
            id: self.id,
            name: self.name,
            description: self.description,
            system_prompt: self.system_prompt,
            provider: self.provider,
            model: self.model,
            temperature: self.temperature,
            max_iterations: self.max_iterations,
            max_tokens: self.max_tokens,
            enabled: self.enabled != 0,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for topology annotations from SQLite
#[derive(Debug, FromRow)]
struct AnnotationRow {
    id: String,
    topology_id: String,
    annotation_type: String,
    element_data: String,
    z_index: i32,
    created_at: String,
    updated_at: String,
}

impl AnnotationRow {
    fn into_annotation(self) -> Result<TopologyAnnotation, ProviderError> {
        let annotation_type = AnnotationType::from_str(&self.annotation_type).ok_or_else(|| {
            ProviderError::Database(format!("Invalid annotation type: {}", self.annotation_type))
        })?;

        let element_data: serde_json::Value = serde_json::from_str(&self.element_data)
            .map_err(|e| ProviderError::Database(format!("Failed to parse element_data: {}", e)))?;

        Ok(TopologyAnnotation {
            id: self.id,
            topology_id: self.topology_id,
            annotation_type,
            element_data,
            z_index: self.z_index,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

impl NetBoxSourceRow {
    fn into_source(self) -> Result<NetBoxSource, ProviderError> {
        let profile_mappings: ProfileMappings = self
            .profile_mappings
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        let cli_flavor_mappings: CliFlavorMappings = self
            .cli_flavor_mappings
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        let device_filters: Option<DeviceFilters> = self
            .device_filters
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let console_protocol_mappings: ConsoleProtocolMappings = self
            .console_protocol_mappings
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        let last_sync_at = self.last_sync_at.map(|s| parse_datetime(&s)).transpose()?;

        let last_sync_filters: Option<SyncFilters> = self
            .last_sync_filters
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let last_sync_result: Option<SyncResult> = self
            .last_sync_result
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(NetBoxSource {
            id: self.id,
            name: self.name,
            api_resource_id: self.api_resource_id,
            default_profile_id: self.default_profile_id,
            profile_mappings,
            cli_flavor_mappings,
            device_filters,
            console_profile_id: self.console_profile_id,
            console_protocol_mappings,
            last_sync_at,
            last_sync_filters,
            last_sync_result,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Parse a datetime string from SQLite
fn parse_datetime(s: &str) -> Result<DateTime<Utc>, ProviderError> {
    // Try RFC3339 format first (with timezone)
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&Utc));
    }

    // Try SQLite default format (without timezone, assume UTC)
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Ok(dt.and_utc());
    }

    Err(ProviderError::Database(format!(
        "Failed to parse datetime: {}",
        s
    )))
}

/// Format a datetime for SQLite storage
fn format_datetime(dt: &DateTime<Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Row shape for `SELECT id, name, tabs, topology_id, default_launch_action,
/// created_at, updated_at, last_used_at FROM groups`.
type GroupRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
);

/// Convert a groups table row into a Group model
fn row_to_group(row: GroupRow) -> Group {
    let (id, name, tabs_json, topology_id, action_str, created_at, updated_at, last_used_at) = row;
    let tabs: Vec<crate::models::GroupTab> = serde_json::from_str(&tabs_json).unwrap_or_default();
    let default_launch_action = action_str.and_then(|s| {
        serde_json::from_str::<crate::models::LaunchAction>(&format!("\"{}\"", s)).ok()
    });
    Group {
        id,
        name,
        tabs,
        topology_id,
        default_launch_action,
        created_at,
        updated_at,
        last_used_at,
    }
}

impl LocalDataProvider {
    /// Create a new LocalDataProvider with the given database pool
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            master_vault: RwLock::new(None),
            master_salt: RwLock::new(None),
            unlock_attempts: Mutex::new(UnlockAttempts::default()),
        }
    }

    /// Record a failed unlock attempt and update the rate-limit cooldown.
    ///
    /// AUDIT FIX (CRYPTO-007): once `MAX_FAILS_BEFORE_COOLDOWN` consecutive
    /// failures accumulate, every subsequent attempt blocks for
    /// `COOLDOWN_SECS` before checking the password. This bounds offline
    /// brute-force speed even if the attacker has the bearer token.
    fn record_unlock_failure(&self) {
        let mut attempts = self.unlock_attempts.lock();
        attempts.failures = attempts.failures.saturating_add(1);
        if attempts.failures >= MAX_FAILS_BEFORE_COOLDOWN {
            attempts.next_allowed_at_epoch = Utc::now().timestamp() + COOLDOWN_SECS;
            tracing::warn!(
                target: "audit",
                failures = attempts.failures,
                cooldown_secs = COOLDOWN_SECS,
                "vault unlock cooldown engaged after {} failed attempts",
                attempts.failures
            );
        }
    }

    /// Get a clone of the current master vault (if unlocked)
    fn get_vault(&self) -> Result<CredentialVault, ProviderError> {
        self.master_vault
            .read()
            .clone()
            .ok_or(ProviderError::VaultLocked)
    }

    /// Get the current salt (if set)
    fn get_salt(&self) -> Result<[u8; 32], ProviderError> {
        self.master_salt.read().ok_or(ProviderError::VaultLocked)
    }

    /// Decrypt and deserialize a value from encrypted vault storage.
    /// T must implement Deserialize.
    fn vault_get<T: serde::de::DeserializeOwned>(
        &self,
        encrypted_data: &[u8],
    ) -> Result<T, ProviderError> {
        let vault = self.get_vault()?;
        let encrypted = EncryptedData::from_bytes(encrypted_data)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        let decrypted = crypto::decrypt_with_vault(&encrypted, &vault)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        serde_json::from_str(&decrypted)
            .map_err(|e| ProviderError::Encryption(format!("Failed to parse vault data: {}", e)))
    }

    /// Serialize and encrypt a value for vault storage.
    /// T must implement Serialize.
    fn vault_store<T: serde::Serialize>(&self, value: &T) -> Result<Vec<u8>, ProviderError> {
        let vault = self.get_vault()?;
        let salt = self.get_salt()?;
        let json = serde_json::to_string(value)
            .map_err(|e| ProviderError::Encryption(format!("Failed to serialize: {}", e)))?;
        let encrypted = crypto::encrypt_with_vault(&json, &vault, &salt)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        Ok(encrypted.to_bytes())
    }

    /// Decrypt a plain string from encrypted vault storage (for API tokens).
    fn vault_get_string(&self, encrypted_data: &[u8]) -> Result<String, ProviderError> {
        let vault = self.get_vault()?;
        let encrypted = EncryptedData::from_bytes(encrypted_data)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        crypto::decrypt_with_vault(&encrypted, &vault)
            .map_err(|e| ProviderError::Encryption(e.to_string()))
    }

    /// Encrypt a plain string for vault storage (for API tokens).
    fn vault_store_string(&self, value: &str) -> Result<Vec<u8>, ProviderError> {
        let vault = self.get_vault()?;
        let salt = self.get_salt()?;
        let encrypted = crypto::encrypt_with_vault(value, &vault, &salt)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        Ok(encrypted.to_bytes())
    }

    /// Convert a Session into an ExportSession, looking up profile name and jump host name.
    async fn session_to_export(
        &self,
        session: &Session,
        folder_name: Option<String>,
    ) -> Result<ExportSession, ProviderError> {
        // Four independent reads per session; run them together.
        let (snippets, profile, jump_host, console_profile) = tokio::join!(
            self.list_snippets(Some(&session.id)),
            self.get_profile(&session.profile_id),
            async {
                match &session.jump_host_id {
                    Some(id) => self.get_jump_host(id).await.ok(),
                    None => None,
                }
            },
            async {
                match &session.console_profile_id {
                    Some(id) => self.get_profile(id).await.ok(),
                    None => None,
                }
            },
        );
        let snippets = snippets?;
        let profile_name = profile.ok().map(|p| p.name);
        let jump_host_name = jump_host.map(|jh| jh.name);
        let console_profile_name = console_profile.map(|p| p.name);

        Ok(ExportSession {
            name: session.name.clone(),
            folder_name,
            host: session.host.clone(),
            port: session.port,
            profile_name,
            color: session.color.clone(),
            icon: session.icon.clone(),
            auto_reconnect: session.auto_reconnect,
            reconnect_delay: session.reconnect_delay,
            scrollback_lines: session.scrollback_lines,
            local_echo: session.local_echo,
            font_size_override: session.font_size_override,
            mapped_keys: vec![],
            snippets: snippets
                .into_iter()
                .map(|s| NewSnippet {
                    name: s.name,
                    command: s.command,
                    sort_order: s.sort_order,
                })
                .collect(),
            jump_host_name,
            port_forwards: session.port_forwards.clone(),
            console_host: session.console_host.clone(),
            console_port: session.console_port,
            console_protocol: session.console_protocol.clone(),
            console_profile_name,
            console_legacy_ssh: session.console_legacy_ssh,
        })
    }

    /// Generic delete-by-id for simple CRUD tables.
    /// Executes DELETE FROM {table} WHERE {id_column} = ? and returns NotFound if no rows affected.
    async fn delete_by_id(
        &self,
        table: &str,
        id_column: &str,
        id: &str,
        entity_name: &str,
    ) -> Result<(), ProviderError> {
        let query = format!("DELETE FROM {} WHERE {} = ?", table, id_column);
        let result = sqlx::query(&query)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "{} not found: {}",
                entity_name, id
            )));
        }

        Ok(())
    }

    /// Get a reference to the database pool for direct queries
    pub fn _get_pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Validate that setting `new_jump_host_id` on profile `profile_id`
    /// would not create a jump-host chain. Returns an error with a
    /// user-facing message naming the artifacts involved.
    async fn validate_profile_jump_host_chain(
        pool: &SqlitePool,
        profile_id: &str,
        profile_name: &str,
        new_jump_host_id: Option<&str>,
    ) -> Result<(), ProviderError> {
        let Some(new_jh_id) = new_jump_host_id else {
            return Ok(()); // clearing is always fine
        };

        // Check 1: this profile is already used as a jump host's auth profile.
        // If so, setting any jump_host_id on this profile would chain.
        let consuming: Vec<(String, String)> =
            sqlx::query_as("SELECT id, name FROM jump_hosts WHERE profile_id = ?")
                .bind(profile_id)
                .fetch_all(pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        if !consuming.is_empty() {
            let names = consuming
                .iter()
                .map(|(_, n)| n.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ProviderError::Validation(format!(
                "Cannot set a jump host on profile '{}' — this profile is used as the auth profile \
                 for jump host(s): {}. Jump hosts cannot be chained. Remove the jump host setting \
                 from this profile, or detach this profile from those jump hosts first.",
                profile_name, names
            )));
        }

        // Check 2: the chosen jump's profile must itself be a leaf (no jump_host_id).
        // Row: (jump_name, jump_profile_id, jump_profile_jh_id, jump_profile_name, inner_jump_name)
        type ChosenJumpRow = (String, String, Option<String>, String, Option<String>);
        let chosen: Option<ChosenJumpRow> = sqlx::query_as(
            "SELECT jh.name, jh.profile_id, p.jump_host_id, p.name, \
                    (SELECT name FROM jump_hosts WHERE id = p.jump_host_id) \
             FROM jump_hosts jh JOIN credential_profiles p ON p.id = jh.profile_id \
             WHERE jh.id = ?",
        )
        .bind(new_jh_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some((
            jump_name,
            _jump_profile_id,
            jump_profile_jh_id,
            jump_profile_name,
            inner_jump_name,
        )) = chosen
        else {
            return Err(ProviderError::Validation(format!(
                "Cannot set jump host on profile '{}' — the chosen jump host '{}' no longer exists.",
                profile_name, new_jh_id
            )));
        };

        if jump_profile_jh_id.is_some() {
            let inner = inner_jump_name.unwrap_or_else(|| "<unknown>".into());
            return Err(ProviderError::Validation(format!(
                "Cannot set jump host on profile '{}' — the chosen jump host '{}' uses profile '{}' \
                 which itself has a jump host configured ('{}'). Jump hosts cannot be chained. \
                 Clear the jump host on profile '{}' first.",
                profile_name, jump_name, jump_profile_name, inner, jump_profile_name
            )));
        }

        Ok(())
    }

    /// Validate that creating/updating a jump host whose auth profile is
    /// `profile_id` won't form a chain. Fails if the profile already has its
    /// own `jump_host_id` set.
    async fn validate_jump_host_profile_is_leaf(
        pool: &SqlitePool,
        new_jump_name: &str,
        profile_id: &str,
    ) -> Result<(), ProviderError> {
        let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT p.name, p.jump_host_id, \
                    (SELECT name FROM jump_hosts WHERE id = p.jump_host_id) \
             FROM credential_profiles p WHERE p.id = ?",
        )
        .bind(profile_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some((profile_name, profile_jh_id, inner_jump_name)) = row else {
            return Err(ProviderError::Validation(format!(
                "Cannot configure jump host '{}' — auth profile '{}' does not exist.",
                new_jump_name, profile_id
            )));
        };

        if profile_jh_id.is_some() {
            let inner = inner_jump_name.unwrap_or_else(|| "<unknown>".into());
            return Err(ProviderError::Validation(format!(
                "Cannot configure jump host '{}' — its auth profile '{}' itself has a jump host \
                 configured ('{}'). Jump hosts cannot be chained. \
                 Clear the jump host on profile '{}' first.",
                new_jump_name, profile_name, inner, profile_name
            )));
        }

        Ok(())
    }
}

/// Internal row type for enrichment matchers from SQLite. Source assignments
/// are loaded separately (join table) and passed to `into_matcher`.
#[derive(Debug, FromRow)]
struct EnrichmentMatcherRow {
    id: String,
    name: String,
    description: String,
    patterns: String,
    cli_flavors: String,
    priority: i32,
    is_builtin: i32,
    created_at: String,
    updated_at: String,
}

impl EnrichmentMatcherRow {
    fn into_matcher(self, source_ids: Vec<String>) -> Result<EnrichmentMatcher, ProviderError> {
        Ok(EnrichmentMatcher {
            id: self.id,
            name: self.name,
            description: self.description,
            patterns: serde_json::from_str(&self.patterns).unwrap_or_default(),
            cli_flavors: serde_json::from_str(&self.cli_flavors).unwrap_or_default(),
            priority: self.priority,
            is_builtin: self.is_builtin != 0,
            source_ids,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for enrichment sources from SQLite.
#[derive(Debug, FromRow)]
struct EnrichmentSourceRow {
    id: String,
    name: String,
    description: String,
    kind: String,
    api_resource_id: Option<String>,
    method: String,
    path_template: String,
    response_unwrap: String,
    picked_fields: String,
    is_builtin: i32,
    created_at: String,
    updated_at: String,
}

impl EnrichmentSourceRow {
    fn into_source(self) -> Result<EnrichmentSource, ProviderError> {
        Ok(EnrichmentSource {
            id: self.id,
            name: self.name,
            description: self.description,
            kind: self.kind,
            api_resource_id: self.api_resource_id,
            method: self.method,
            path_template: self.path_template,
            response_unwrap: self.response_unwrap,
            picked_fields: serde_json::from_str(&self.picked_fields).unwrap_or_default(),
            is_builtin: self.is_builtin != 0,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

impl LocalDataProvider {
    /// Wipe every vault-encrypted store and drop the master-password marker in
    /// one transaction, then zeroize the in-memory key and clear the unlock
    /// cooldown. Shared by `wipe_vault` (password-verified) and `reset_vault`
    /// (forgot-password path). Does NOT verify any password itself.
    async fn wipe_vault_data(&self) -> Result<(), ProviderError> {
        // Wipe every vault-encrypted table + the master-password record,
        // all in one transaction so a mid-wipe failure doesn't leave a
        // half-wiped vault.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        // The schema drifts over time (tables get dropped, columns renamed).
        // Rather than hard-code statements that abort the whole transaction with
        // "no such table/column" on any drift, introspect the live schema and
        // only wipe what actually exists. All table/column names below are fixed
        // constants (no user input), so string-formatting them is injection-safe.

        // Dedicated secret tables — delete every row when the table exists.
        for table in [
            "credentials",              // per-session SSH credentials
            "profile_credentials",      // SSH passwords / key passphrases
            "api_keys",                 // AI provider keys, etc.
            "api_resource_credentials", // integration tokens (NetBox/LibreNMS/…)
            "cert_auth_state",          // SSH-cert CA private key (master-pw encrypted)
        ] {
            let exists: Option<(i64,)> =
                sqlx::query_as("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
                    .bind(table)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            if exists.is_some() {
                sqlx::query(&format!("DELETE FROM {table}"))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            }
        }

        // Inline encrypted columns — null the secret, preserve the owning row.
        // (table, guard column, SET clause)
        let col_wipes: &[(&str, &str, &str)] = &[
            ("documents", "encrypted_content", "encrypted_content = NULL"),
            (
                "document_versions",
                "encrypted_content",
                "encrypted_content = NULL",
            ),
            (
                "mcp_servers",
                "auth_token_encrypted",
                "auth_token_encrypted = NULL",
            ),
            ("mcp_servers", "auth_token", "auth_token = NULL"),
            (
                "mapped_keys",
                "command_encrypted",
                "command_encrypted = NULL, is_secret = 0",
            ),
        ];
        for (table, column, set_clause) in col_wipes {
            let col_exists: Option<(i64,)> = sqlx::query_as(&format!(
                "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?"
            ))
            .bind(column)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
            if col_exists.is_some() {
                sqlx::query(&format!(
                    "UPDATE {table} SET {set_clause} WHERE {column} IS NOT NULL"
                ))
                .execute(&mut *tx)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
            }
        }

        // Drop the master-password marker so vault_status reports
        // has_master_password=false and the UI re-prompts for a fresh setup.
        sqlx::query("DELETE FROM vault_config WHERE id = 1")
            .execute(&mut *tx)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Zeroize the in-memory key.
        *self.master_vault.write() = None;
        *self.master_salt.write() = None;
        // Reset the unlock-attempts cooldown so the user can immediately set
        // a fresh master password.
        let mut attempts = self.unlock_attempts.lock();
        attempts.failures = 0;
        attempts.next_allowed_at_epoch = 0;

        Ok(())
    }
}

#[async_trait]
impl DataProvider for LocalDataProvider {
    // === Hover Enrichment — Matchers ===

    async fn list_enrichment_matchers(&self) -> Result<Vec<EnrichmentMatcher>, ProviderError> {
        let rows: Vec<EnrichmentMatcherRow> = sqlx::query_as(
            "SELECT id, name, description, patterns, cli_flavors, priority, is_builtin, created_at, updated_at \
             FROM enrichment_matchers ORDER BY priority DESC, name ASC"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Load source assignments for all matchers in one query
        let assignments: Vec<(String, String)> = sqlx::query_as(
            "SELECT matcher_id, source_id FROM enrichment_matcher_sources ORDER BY matcher_id, sort_order"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let source_ids: Vec<String> = assignments
                .iter()
                .filter(|(m, _)| m == &row.id)
                .map(|(_, s)| s.clone())
                .collect();
            out.push(row.into_matcher(source_ids)?);
        }
        Ok(out)
    }

    async fn get_enrichment_matcher(
        &self,
        id: &str,
    ) -> Result<Option<EnrichmentMatcher>, ProviderError> {
        let row: Option<EnrichmentMatcherRow> = sqlx::query_as(
            "SELECT id, name, description, patterns, cli_flavors, priority, is_builtin, created_at, updated_at \
             FROM enrichment_matchers WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some(row) = row else { return Ok(None) };
        let source_ids: Vec<String> = sqlx::query_scalar(
            "SELECT source_id FROM enrichment_matcher_sources WHERE matcher_id = ? ORDER BY sort_order"
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(Some(row.into_matcher(source_ids)?))
    }

    async fn create_enrichment_matcher(
        &self,
        req: &CreateEnrichmentMatcherRequest,
    ) -> Result<EnrichmentMatcher, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let patterns = serde_json::to_string(&req.patterns)
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        let flavors = serde_json::to_string(&req.cli_flavors)
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        sqlx::query(
            "INSERT INTO enrichment_matchers (id, name, description, patterns, cli_flavors, priority, is_builtin, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)"
        )
        .bind(&id).bind(&req.name).bind(&req.description)
        .bind(&patterns).bind(&flavors).bind(req.priority)
        .bind(&now).bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_enrichment_matcher(&id)
            .await?
            .ok_or_else(|| ProviderError::Database("Failed to retrieve created matcher".into()))
    }

    async fn update_enrichment_matcher(
        &self,
        id: &str,
        req: &UpdateEnrichmentMatcherRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now)];

        if let Some(name) = &req.name {
            set_clauses.push("name = ?");
            params.push(Some(name.clone()));
        }
        if let Some(desc) = &req.description {
            set_clauses.push("description = ?");
            params.push(Some(desc.clone()));
        }
        if let Some(patterns) = &req.patterns {
            set_clauses.push("patterns = ?");
            params.push(Some(
                serde_json::to_string(patterns)
                    .map_err(|e| ProviderError::Database(e.to_string()))?,
            ));
        }
        if let Some(flavors) = &req.cli_flavors {
            set_clauses.push("cli_flavors = ?");
            params.push(Some(
                serde_json::to_string(flavors)
                    .map_err(|e| ProviderError::Database(e.to_string()))?,
            ));
        }
        if let Some(prio) = req.priority {
            set_clauses.push("priority = ?");
            params.push(Some(prio.to_string()));
        }

        let query = format!(
            "UPDATE enrichment_matchers SET {} WHERE id = ?",
            set_clauses.join(", ")
        );
        let mut q = sqlx::query(&query);
        for p in &params {
            q = q.bind(p);
        }
        q = q.bind(id);
        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Enrichment matcher not found: {}",
                id
            )));
        }
        Ok(())
    }

    async fn delete_enrichment_matcher(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("enrichment_matchers", "id", id, "Enrichment matcher")
            .await
    }

    // === Hover Enrichment — Sources ===

    async fn list_enrichment_sources(&self) -> Result<Vec<EnrichmentSource>, ProviderError> {
        let rows: Vec<EnrichmentSourceRow> = sqlx::query_as(
            "SELECT id, name, description, kind, api_resource_id, method, path_template, response_unwrap, picked_fields, is_builtin, created_at, updated_at \
             FROM enrichment_sources ORDER BY is_builtin DESC, name ASC"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        rows.into_iter().map(|r| r.into_source()).collect()
    }

    async fn get_enrichment_source(
        &self,
        id: &str,
    ) -> Result<Option<EnrichmentSource>, ProviderError> {
        let row: Option<EnrichmentSourceRow> = sqlx::query_as(
            "SELECT id, name, description, kind, api_resource_id, method, path_template, response_unwrap, picked_fields, is_builtin, created_at, updated_at \
             FROM enrichment_sources WHERE id = ?"
        )
        .bind(id).fetch_optional(&self.pool).await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        match row {
            Some(r) => Ok(Some(r.into_source()?)),
            None => Ok(None),
        }
    }

    async fn create_enrichment_source(
        &self,
        req: &CreateEnrichmentSourceRequest,
    ) -> Result<EnrichmentSource, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let fields_json = serde_json::to_string(&req.picked_fields)
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        sqlx::query(
            "INSERT INTO enrichment_sources \
             (id, name, description, kind, api_resource_id, method, path_template, response_unwrap, picked_fields, is_builtin, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
        )
        .bind(&id).bind(&req.name).bind(&req.description).bind(&req.kind)
        .bind(&req.api_resource_id).bind(&req.method).bind(&req.path_template)
        .bind(&req.response_unwrap).bind(&fields_json)
        .bind(&now).bind(&now)
        .execute(&self.pool).await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_enrichment_source(&id)
            .await?
            .ok_or_else(|| ProviderError::Database("Failed to retrieve created source".into()))
    }

    async fn update_enrichment_source(
        &self,
        id: &str,
        req: &UpdateEnrichmentSourceRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now)];

        if let Some(name) = &req.name {
            set_clauses.push("name = ?");
            params.push(Some(name.clone()));
        }
        if let Some(desc) = &req.description {
            set_clauses.push("description = ?");
            params.push(Some(desc.clone()));
        }
        if let Some(api) = &req.api_resource_id {
            set_clauses.push("api_resource_id = ?");
            params.push(api.clone()); // double-Option: Some(None) clears, Some(Some(x)) sets
        }
        if let Some(m) = &req.method {
            set_clauses.push("method = ?");
            params.push(Some(m.clone()));
        }
        if let Some(p) = &req.path_template {
            set_clauses.push("path_template = ?");
            params.push(Some(p.clone()));
        }
        if let Some(u) = &req.response_unwrap {
            set_clauses.push("response_unwrap = ?");
            params.push(Some(u.clone()));
        }
        if let Some(fields) = &req.picked_fields {
            set_clauses.push("picked_fields = ?");
            params.push(Some(
                serde_json::to_string(fields)
                    .map_err(|e| ProviderError::Database(e.to_string()))?,
            ));
        }

        let query = format!(
            "UPDATE enrichment_sources SET {} WHERE id = ?",
            set_clauses.join(", ")
        );
        let mut q = sqlx::query(&query);
        for p in &params {
            q = q.bind(p);
        }
        q = q.bind(id);
        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Enrichment source not found: {}",
                id
            )));
        }
        Ok(())
    }

    async fn delete_enrichment_source(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("enrichment_sources", "id", id, "Enrichment source")
            .await
    }

    async fn replace_matcher_sources(
        &self,
        matcher_id: &str,
        source_ids: &[String],
    ) -> Result<(), ProviderError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        sqlx::query("DELETE FROM enrichment_matcher_sources WHERE matcher_id = ?")
            .bind(matcher_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        for (i, sid) in source_ids.iter().enumerate() {
            sqlx::query(
                "INSERT INTO enrichment_matcher_sources (matcher_id, source_id, sort_order) VALUES (?, ?, ?)"
            )
            .bind(matcher_id).bind(sid).bind(i as i64)
            .execute(&mut *tx).await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        }
        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    // === OUI Vendor Database ===

    async fn oui_lookup(&self, prefix: &str) -> Result<Option<String>, ProviderError> {
        let row: Option<String> =
            sqlx::query_scalar("SELECT vendor FROM oui_vendors WHERE prefix = ?")
                .bind(prefix.to_uppercase())
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(row)
    }

    async fn oui_count(&self) -> Result<i64, ProviderError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oui_vendors")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(count)
    }

    async fn oui_bulk_upsert(
        &self,
        entries: &[(String, String, String)],
    ) -> Result<usize, ProviderError> {
        // Batch in a transaction for atomicity + speed. ~30k rows takes <1s.
        let now = format_datetime(&Utc::now());
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        let mut count = 0usize;
        for (prefix, vendor, registry) in entries {
            sqlx::query(
                "INSERT INTO oui_vendors (prefix, vendor, registry, updated_at) \
                 VALUES (?, ?, ?, ?) \
                 ON CONFLICT(prefix) DO UPDATE SET vendor = excluded.vendor, registry = excluded.registry, updated_at = excluded.updated_at"
            )
            .bind(prefix.to_uppercase())
            .bind(vendor)
            .bind(registry)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
            count += 1;
        }
        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(count)
    }

    async fn oui_cache_one(&self, prefix: &str, vendor: &str) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());
        sqlx::query(
            "INSERT INTO oui_vendors (prefix, vendor, registry, updated_at) VALUES (?, ?, 'API', ?) \
             ON CONFLICT(prefix) DO UPDATE SET vendor = excluded.vendor, updated_at = excluded.updated_at"
        )
        .bind(prefix.to_uppercase())
        .bind(vendor)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    // === Sessions ===

    async fn list_sessions(&self) -> Result<Vec<Session>, ProviderError> {
        let query = format!(
            "SELECT {} FROM sessions ORDER BY sort_order, name",
            SESSION_COLUMNS
        );
        let rows: Vec<SessionRow> = sqlx::query_as(&query)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_session()).collect()
    }

    async fn get_session(&self, id: &str) -> Result<Session, ProviderError> {
        let query = format!("SELECT {} FROM sessions WHERE id = ?", SESSION_COLUMNS);
        let row: SessionRow = sqlx::query_as(&query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Session not found: {}", id)))?;

        row.into_session()
    }

    async fn create_session(&self, session: NewSession) -> Result<Session, ProviderError> {
        // Check for duplicate session name
        let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM sessions WHERE name = ?1")
            .bind(&session.name)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if existing.is_some() {
            return Err(ProviderError::Conflict(format!(
                "A session named '{}' already exists",
                session.name
            )));
        }

        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let cli_flavor = match session.cli_flavor {
            CliFlavor::Auto => "auto",
            CliFlavor::Linux => "linux",
            CliFlavor::CiscoIos => "cisco-ios",
            CliFlavor::CiscoIosXr => "cisco-xr",
            CliFlavor::CiscoNxos => "cisco-nxos",
            CliFlavor::Juniper => "juniper",
            CliFlavor::Arista => "arista",
            CliFlavor::Paloalto => "paloalto",
            CliFlavor::Fortinet => "fortinet",
        };

        // Serialize port_forwards to JSON
        let port_forwards_json = if session.port_forwards.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&session.port_forwards).unwrap_or_default())
        };

        // Serialize auto_commands to JSON
        let auto_commands_json = if session.auto_commands.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&session.auto_commands).unwrap_or_default())
        };

        // Note: username and auth_type are deprecated but still required by the schema (NOT NULL)
        // We provide empty defaults since all auth now comes from profiles
        // Validate jump references before insert.
        crate::db::validate_entity_jump_refs(
            &self.pool,
            "session",
            None,
            &session.name,
            session.jump_host_id.as_deref(),
            session.jump_session_id.as_deref(),
        )
        .await
        .map_err(|e| ProviderError::Validation(e.to_string()))?;

        validate_console_access(
            session.console_host.as_deref(),
            session.console_port,
            &session.console_protocol,
            session.console_profile_id.as_deref(),
        )?;

        sqlx::query(
            r#"
            INSERT INTO sessions (id, name, folder_id, host, port, username, auth_type, color, sort_order, profile_id, netbox_device_id, netbox_source_id, cli_flavor, terminal_theme, font_family, font_size_override, jump_host_id, jump_session_id, port_forwards, auto_commands, legacy_ssh, protocol, sftp_start_path, auto_reconnect, reconnect_delay, scrollback_lines, local_echo, icon, console_host, console_port, console_protocol, console_profile_id, console_legacy_ssh, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, '', 'password', ?,
                    COALESCE((SELECT MAX(sort_order) FROM sessions WHERE folder_id IS ?), -1000) + 1000,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&session.name)
        .bind(&session.folder_id)
        .bind(&session.host)
        .bind(session.port as i32)
        .bind(&session.color)
        // sort_order: append after the current last sibling so drag-reorder has
        // room to move items between neighbours (NS-SESS-4). Previously every
        // row was inserted with 0, which made "move up" a no-op.
        .bind(&session.folder_id)
        .bind(&session.profile_id)
        .bind(session.netbox_device_id)
        .bind(&session.netbox_source_id)
        .bind(cli_flavor)
        .bind(&session.terminal_theme)
        .bind(&session.font_family)
        .bind(session.font_size_override.map(|v| v as i32))
        .bind(&session.jump_host_id)
        .bind(&session.jump_session_id)
        .bind(&port_forwards_json)
        .bind(&auto_commands_json)
        .bind(session.legacy_ssh)
        .bind(session.protocol.as_str())
        .bind(&session.sftp_start_path)
        .bind(session.auto_reconnect)
        .bind(session.reconnect_delay as i32)
        .bind(session.scrollback_lines as i32)
        .bind(session.local_echo)
        .bind(&session.icon)
        .bind(&session.console_host)
        .bind(session.console_port.map(i32::from))
        .bind(session.console_protocol.as_str())
        .bind(&session.console_profile_id)
        .bind(session.console_legacy_ssh)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_session(&id).await
    }

    async fn update_session(
        &self,
        id: &str,
        update: UpdateSession,
    ) -> Result<Session, ProviderError> {
        // Verify session exists
        let _existing = self.get_session(id).await?;

        let now = format_datetime(&Utc::now());

        // No "did anything change" gate here: it only tracked a subset of
        // fields, so an update touching just profile_id / protocol /
        // cli_flavor / port_forwards / legacy_ssh was silently dropped
        // (NS-SESS-16). The UPDATE below merges every column from
        // current + update, so always run it.
        let current = self.get_session(id).await?;

        let name = update.name.unwrap_or(current.name);
        let folder_id = update.folder_id.unwrap_or(current.folder_id);
        let host = update.host.unwrap_or(current.host);
        let port = update.port.unwrap_or(current.port) as i32;
        let color = update.color.unwrap_or(current.color);
        let icon = update.icon.unwrap_or(current.icon);
        let sort_order = update.sort_order.unwrap_or(current.sort_order);
        let auto_reconnect = update.auto_reconnect.unwrap_or(current.auto_reconnect);
        let reconnect_delay = update.reconnect_delay.unwrap_or(current.reconnect_delay) as i32;
        let scrollback_lines = update.scrollback_lines.unwrap_or(current.scrollback_lines) as i32;
        let local_echo = update.local_echo.unwrap_or(current.local_echo);
        let font_size_override = update
            .font_size_override
            .unwrap_or(current.font_size_override);
        // Profile integration - all auth comes from profile (required)
        let profile_id = update.profile_id.unwrap_or(current.profile_id);
        let netbox_device_id = update.netbox_device_id.unwrap_or(current.netbox_device_id);
        let netbox_source_id = update.netbox_source_id.unwrap_or(current.netbox_source_id);
        let cli_flavor = match update.cli_flavor.unwrap_or(current.cli_flavor) {
            CliFlavor::Auto => "auto",
            CliFlavor::Linux => "linux",
            CliFlavor::CiscoIos => "cisco-ios",
            CliFlavor::CiscoIosXr => "cisco-xr",
            CliFlavor::CiscoNxos => "cisco-nxos",
            CliFlavor::Juniper => "juniper",
            CliFlavor::Arista => "arista",
            CliFlavor::Paloalto => "paloalto",
            CliFlavor::Fortinet => "fortinet",
        };
        let terminal_theme = update.terminal_theme.unwrap_or(current.terminal_theme);
        let font_family = update.font_family.unwrap_or(current.font_family);
        // Jump host reference (global jump hosts)
        let jump_host_id = update.jump_host_id.unwrap_or(current.jump_host_id);
        // Session-as-jump alternative
        let jump_session_id = update.jump_session_id.unwrap_or(current.jump_session_id);

        // Validate the resulting jump refs before writing.
        crate::db::validate_entity_jump_refs(
            &self.pool,
            "session",
            Some(id),
            &name,
            jump_host_id.as_deref(),
            jump_session_id.as_deref(),
        )
        .await
        .map_err(|e| ProviderError::Validation(e.to_string()))?;

        // Symmetric: if this session is currently used as someone else's
        // jump, it must remain a leaf — reject adding any jump to it.
        crate::db::validate_session_not_used_as_jump(
            &self.pool,
            id,
            jump_host_id.as_deref(),
            jump_session_id.as_deref(),
        )
        .await
        .map_err(|e| ProviderError::Validation(e.to_string()))?;

        // Port forwarding (Phase 06.3)
        let port_forwards = update.port_forwards.unwrap_or(current.port_forwards);
        let port_forwards_json = if port_forwards.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&port_forwards).unwrap_or_default())
        };
        // Auto commands on connect
        let auto_commands = update.auto_commands.unwrap_or(current.auto_commands);
        let auto_commands_json = if auto_commands.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&auto_commands).unwrap_or_default())
        };
        // Legacy SSH support
        let legacy_ssh = update.legacy_ssh.unwrap_or(current.legacy_ssh);
        // Connection protocol
        let protocol = update.protocol.unwrap_or(current.protocol);
        // SFTP starting directory
        let sftp_start_path = update.sftp_start_path.unwrap_or(current.sftp_start_path);
        // OOB console access
        let console_host = update
            .console_host
            .unwrap_or(current.console_host)
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty());
        let console_port = update.console_port.unwrap_or(current.console_port);
        let console_protocol = update.console_protocol.unwrap_or(current.console_protocol);
        let console_profile_id = update
            .console_profile_id
            .unwrap_or(current.console_profile_id)
            .filter(|p| !p.is_empty());
        let console_legacy_ssh = update
            .console_legacy_ssh
            .unwrap_or(current.console_legacy_ssh);
        validate_console_access(
            console_host.as_deref(),
            console_port,
            &console_protocol,
            console_profile_id.as_deref(),
        )?;

        sqlx::query(
            r#"
            UPDATE sessions
            SET name = ?, folder_id = ?, host = ?, port = ?,
                color = ?, icon = ?, sort_order = ?,
                auto_reconnect = ?, reconnect_delay = ?, scrollback_lines = ?,
                local_echo = ?, font_size_override = ?, font_family = ?,
                profile_id = ?, netbox_device_id = ?, netbox_source_id = ?,
                cli_flavor = ?, terminal_theme = ?, jump_host_id = ?, jump_session_id = ?,
                port_forwards = ?, auto_commands = ?, legacy_ssh = ?, protocol = ?, sftp_start_path = ?,
                console_host = ?, console_port = ?, console_protocol = ?, console_profile_id = ?, console_legacy_ssh = ?,
                updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&folder_id)
        .bind(&host)
        .bind(port)
        .bind(&color)
        .bind(&icon)
        .bind(sort_order)
        .bind(auto_reconnect as i32)
        .bind(reconnect_delay)
        .bind(scrollback_lines)
        .bind(local_echo as i32)
        .bind(font_size_override.map(|v| v as i32))
        .bind(&font_family)
        .bind(&profile_id)
        .bind(netbox_device_id)
        .bind(&netbox_source_id)
        .bind(cli_flavor)
        .bind(&terminal_theme)
        .bind(&jump_host_id)
        .bind(&jump_session_id)
        .bind(&port_forwards_json)
        .bind(&auto_commands_json)
        .bind(legacy_ssh as i32)
        .bind(protocol.as_str())
        .bind(&sftp_start_path)
        .bind(&console_host)
        .bind(console_port.map(i32::from))
        .bind(console_protocol.as_str())
        .bind(&console_profile_id)
        .bind(console_legacy_ssh as i32)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_session(id).await
    }

    async fn delete_session(&self, id: &str) -> Result<(), ProviderError> {
        // sessions.jump_session_id / tunnels / profiles are ON DELETE SET NULL,
        // so deleting a bastion session silently turned its dependents into
        // direct connections (NS-SESS-6). Refuse until they are re-pointed.
        let deps = self.find_session_jump_dependents(id).await?;
        if !deps.sessions.is_empty() || !deps.tunnels.is_empty() || !deps.profiles.is_empty() {
            return Err(ProviderError::Validation(format!(
                "Cannot delete session: it is the jump host for {} session(s), {} tunnel(s) and {} profile(s). Re-point them first.",
                deps.sessions.len(), deps.tunnels.len(), deps.profiles.len()
            )));
        }
        self.delete_by_id("sessions", "id", id, "Session").await
    }

    /// Atomic bulk delete — wraps the loop in a single sqlx transaction
    /// so a mid-loop failure rolls back everything instead of leaving
    /// the table half-deleted. The caller (api.rs::bulk_delete_sessions)
    /// surfaces (deleted, 0) on success or an error on rollback; partial
    /// failure is not possible here by design.
    async fn bulk_delete_sessions(&self, ids: &[String]) -> Result<(usize, usize), ProviderError> {
        if ids.is_empty() {
            return Ok((0, 0));
        }
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut deleted = 0usize;
        for id in ids {
            let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
            if result.rows_affected() > 0 {
                deleted += 1;
            }
            // Rows_affected == 0 just means the id wasn't there — we
            // treat that as a no-op rather than an error since bulk
            // delete is idempotent (re-clicking shouldn't fail).
        }

        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok((deleted, 0))
    }

    async fn touch_session(&self, id: &str) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        let result = sqlx::query("UPDATE sessions SET last_connected_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Session not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn find_session_jump_dependents(
        &self,
        session_id: &str,
    ) -> Result<crate::models::JumpDependents, ProviderError> {
        let sessions: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, name FROM sessions WHERE jump_session_id = ? AND id <> ? ORDER BY name",
        )
        .bind(session_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let tunnels: Vec<(String, String)> =
            sqlx::query_as("SELECT id, name FROM tunnels WHERE jump_session_id = ? ORDER BY name")
                .bind(session_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        let profiles: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, name FROM credential_profiles WHERE jump_session_id = ? ORDER BY name",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let to_refs = |rows: Vec<(String, String)>| -> Vec<crate::models::JumpDependentRef> {
            rows.into_iter()
                .map(|(id, name)| crate::models::JumpDependentRef { id, name })
                .collect()
        };

        Ok(crate::models::JumpDependents {
            sessions: to_refs(sessions),
            tunnels: to_refs(tunnels),
            profiles: to_refs(profiles),
        })
    }

    // === Folders ===

    async fn list_folders(&self, scope: Option<&str>) -> Result<Vec<Folder>, ProviderError> {
        let filter_scope = scope.unwrap_or("session");
        let rows: Vec<FolderRow> =
            sqlx::query_as("SELECT * FROM folders WHERE scope = ? ORDER BY sort_order, name")
                .bind(filter_scope)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_folder()).collect()
    }

    async fn get_folder(&self, id: &str) -> Result<Folder, ProviderError> {
        let row: FolderRow = sqlx::query_as("SELECT * FROM folders WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Folder not found: {}", id)))?;

        row.into_folder()
    }

    async fn create_folder(&self, folder: NewFolder) -> Result<Folder, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let scope = folder.scope.as_deref().unwrap_or("session");

        sqlx::query(
            r#"
            INSERT INTO folders (id, name, parent_id, scope, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?,
                    COALESCE((SELECT MAX(sort_order) FROM folders WHERE parent_id IS ?), -1000) + 1000,
                    ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&folder.name)
        .bind(&folder.parent_id)
        .bind(scope)
        .bind(&folder.parent_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_folder(&id).await
    }

    async fn update_folder(&self, id: &str, update: UpdateFolder) -> Result<Folder, ProviderError> {
        // Verify folder exists
        let current = self.get_folder(id).await?;

        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let parent_id = update.parent_id.unwrap_or(current.parent_id);
        let sort_order = update.sort_order.unwrap_or(current.sort_order);

        sqlx::query(
            r#"
            UPDATE folders
            SET name = ?, parent_id = ?, sort_order = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&parent_id)
        .bind(sort_order)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_folder(id).await
    }

    async fn delete_folder(&self, id: &str) -> Result<(), ProviderError> {
        // Sessions in this folder will have their folder_id set to NULL (via ON DELETE SET NULL)
        self.delete_by_id("folders", "id", id, "Folder").await
    }

    // === Credentials ===

    fn is_unlocked(&self) -> bool {
        self.master_vault.read().is_some()
    }

    async fn has_master_password(&self) -> Result<bool, ProviderError> {
        let row: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM vault_config WHERE id = 1")
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(row.is_some())
    }

    async fn set_master_password(&self, password: &str) -> Result<(), ProviderError> {
        // AUDIT FIX (CRYPTO-009): enforce a minimum master-password length on
        // the backend so a misuse (frontend bypass, scripted setup, direct
        // API call) cannot establish a 1-character vault password.
        if password.len() < MIN_MASTER_PASSWORD_LEN {
            return Err(ProviderError::Validation(format!(
                "Master password must be at least {} characters",
                MIN_MASTER_PASSWORD_LEN
            )));
        }

        // Check if already set
        if self.has_master_password().await? {
            return Err(ProviderError::Validation(
                "Master password already set".to_string(),
            ));
        }

        // Derive the vault once (off the async workers) and encrypt the
        // verification string with it. The same vault + salt are cached
        // below, so setup costs one Argon2id derivation instead of three
        // (encrypt, then unlock's decrypt + re-derive).
        let salt = crypto::generate_salt();
        let vault = derive_vault_off_worker(password, salt)
            .await?
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        let encrypted = crypto::encrypt_with_vault(VAULT_VERIFICATION, &vault, &salt)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;

        let data = encrypted.to_bytes();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            "INSERT INTO vault_config (id, verification_data, created_at) VALUES (1, ?, ?)",
        )
        .bind(&data)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Leave the vault unlocked with the new password, exactly as a
        // successful unlock() would: clear the failure counter and cache the
        // vault derived above (it is the one unlock would derive — same
        // password, same salt).
        {
            let mut attempts = self.unlock_attempts.lock();
            attempts.failures = 0;
            attempts.next_allowed_at_epoch = 0;
        }
        *self.master_vault.write() = Some(vault);
        *self.master_salt.write() = Some(salt);

        Ok(())
    }

    async fn unlock(&self, password: &str) -> Result<(), ProviderError> {
        // AUDIT FIX (CRYPTO-007): rate-limit unlock attempts. The agent
        // listens on loopback only, but any same-user process that can read
        // the bearer token can hammer this endpoint. After
        // MAX_FAILS_BEFORE_COOLDOWN consecutive failures we sleep the calling
        // task for COOLDOWN_SECS before even attempting decryption, and any
        // additional failure during the cooldown extends it.
        //
        // The MutexGuard cannot be held across the .await (Send), so we
        // compute the wait inside a tight scope and release the lock first.
        let wait_secs: i64 = {
            let attempts = self.unlock_attempts.lock();
            let now_epoch = Utc::now().timestamp();
            (attempts.next_allowed_at_epoch - now_epoch).max(0)
        };
        if wait_secs > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(wait_secs as u64)).await;
        }

        // Get the verification data
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT verification_data FROM vault_config WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        let verification_data = row
            .ok_or_else(|| ProviderError::Validation("No master password set".to_string()))?
            .0;

        // Try to decrypt
        let encrypted = EncryptedData::from_bytes(&verification_data)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;

        // Derive once (off the async workers) and verify with that vault;
        // on success the same vault is cached, so an unlock costs a single
        // Argon2id derivation. A KDF error counts as a wrong password, as it
        // did when this went through crypto::decrypt.
        let vault = match derive_vault_off_worker(password, encrypted.salt).await? {
            Ok(v) => v,
            Err(_) => {
                self.record_unlock_failure();
                return Err(ProviderError::InvalidPassword);
            }
        };
        if !vault_matches_verification(&vault, &encrypted) {
            self.record_unlock_failure();
            return Err(ProviderError::InvalidPassword);
        }

        // Successful unlock — reset the attempts counter.
        {
            let mut attempts = self.unlock_attempts.lock();
            attempts.failures = 0;
            attempts.next_allowed_at_epoch = 0;
        }

        // Cache the derived vault in memory. CredentialVault wraps Aes256Gcm
        // which zeroizes its internal key on drop, so lock() effectively wipes
        // the key from memory (AUDIT FIX CRYPTO-005).
        *self.master_vault.write() = Some(vault);
        *self.master_salt.write() = Some(encrypted.salt);

        Ok(())
    }

    fn lock(&self) {
        // Dropping the cached CredentialVault zeroizes its internal AES key
        // (aes-gcm 0.10 default features include zeroize-on-drop).
        *self.master_vault.write() = None;
        *self.master_salt.write() = None;
    }

    async fn change_master_password(
        &self,
        old_password: &str,
        new_password: &str,
    ) -> Result<(), ProviderError> {
        if new_password.len() < MIN_MASTER_PASSWORD_LEN {
            return Err(ProviderError::Validation(format!(
                "New master password must be at least {} characters",
                MIN_MASTER_PASSWORD_LEN
            )));
        }
        if old_password == new_password {
            return Err(ProviderError::Validation(
                "New password must differ from the old password".to_string(),
            ));
        }

        // Vault must be unlocked — we need the cached old vault to decrypt
        // existing blobs without an extra Argon2id per row.
        let old_vault = self.get_vault()?;

        // Verify the old password against the stored verification record
        // before touching any data. unlock() does this with rate-limiting
        // built in; do it inline here so we don't double-toggle lock state.
        let verification_row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT verification_data FROM vault_config WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
        let verification_data = verification_row
            .ok_or_else(|| ProviderError::Validation("No master password set".to_string()))?
            .0;
        let verification = EncryptedData::from_bytes(&verification_data)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        let verify_vault = derive_vault_off_worker(old_password, verification.salt)
            .await?
            .map_err(|_| ProviderError::InvalidPassword)?;
        if !vault_matches_verification(&verify_vault, &verification) {
            return Err(ProviderError::InvalidPassword);
        }
        drop(verify_vault);

        // Derive the new vault + salt up front so any KDF failure aborts
        // before we open the transaction.
        let new_salt = crypto::generate_salt();
        let new_vault = derive_vault_off_worker(new_password, new_salt)
            .await?
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;

        // Re-encrypt every BLOB column that holds vault-encrypted data, all
        // in one transaction. The list mirrors the `encrypted_data` columns
        // in schema.sql plus `documents.encrypted_content` (Secure Notes)
        // and `quick_actions.private_key_encrypted`.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        // (table, id-column, blob-column)
        let table_specs: &[(&str, &str, &str)] = &[
            ("profile_credentials", "profile_id", "encrypted_data"),
            ("netbox_tokens", "source_id", "encrypted_data"),
            ("librenms_tokens", "source_id", "encrypted_data"),
            ("api_keys", "key_type", "encrypted_data"),
            (
                "api_resource_credentials",
                "api_resource_id",
                "encrypted_data",
            ),
            ("quick_actions", "id", "private_key_encrypted"),
        ];
        for (table, id_col, blob_col) in table_specs {
            // This rotation list predates some schema changes: the legacy
            // netbox_tokens/librenms_tokens tables were dropped by
            // migrate_centralize_api_resources, and quick_actions no longer
            // has a private_key_encrypted column. Skip any entry whose table or
            // blob column no longer exists — there is nothing to rotate — so a
            // password change is resilient to schema drift on both fresh and
            // legacy databases.
            let table_exists: Option<(String,)> =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .bind(table)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            if table_exists.is_none() {
                continue;
            }
            let columns: Vec<(i32, String, String, i32, Option<String>, i32)> =
                sqlx::query_as(&format!("PRAGMA table_info({})", table))
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            if !columns.iter().any(|c| &c.1 == blob_col) {
                continue;
            }

            let select_sql = format!("SELECT {}, {} FROM {}", id_col, blob_col, table);
            let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(&select_sql)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
            for (row_id, blob) in rows {
                if blob.is_empty() {
                    continue; // private_key_encrypted is nullable on quick_actions
                }
                let encrypted = EncryptedData::from_bytes(&blob).map_err(|e| {
                    ProviderError::Encryption(format!(
                        "{} row {}: bad blob format: {}",
                        table, row_id, e
                    ))
                })?;
                let plaintext =
                    crypto::decrypt_with_vault(&encrypted, &old_vault).map_err(|e| {
                        ProviderError::Encryption(format!(
                            "{} row {}: decrypt failed: {}",
                            table, row_id, e
                        ))
                    })?;
                let re_encrypted = crypto::encrypt_with_vault(&plaintext, &new_vault, &new_salt)
                    .map_err(|e| {
                        ProviderError::Encryption(format!(
                            "{} row {}: re-encrypt failed: {}",
                            table, row_id, e
                        ))
                    })?;
                let update_sql =
                    format!("UPDATE {} SET {} = ? WHERE {} = ?", table, blob_col, id_col);
                sqlx::query(&update_sql)
                    .bind(re_encrypted.to_bytes())
                    .bind(&row_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            }
        }

        // Secure Notes — documents.encrypted_content is nullable; rotate
        // only the rows that have a non-null blob. The same handling for
        // document_versions (Secure Note revision history).
        for (table, blob_col) in &[
            ("documents", "encrypted_content"),
            ("document_versions", "encrypted_content"),
            ("mapped_keys", "command_encrypted"),
        ] {
            let select_sql = format!(
                "SELECT id, {} FROM {} WHERE {} IS NOT NULL",
                blob_col, table, blob_col
            );
            let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(&select_sql)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
            for (row_id, blob) in rows {
                let encrypted = EncryptedData::from_bytes(&blob).map_err(|e| {
                    ProviderError::Encryption(format!(
                        "{} row {}: bad blob format: {}",
                        table, row_id, e
                    ))
                })?;
                let plaintext =
                    crypto::decrypt_with_vault(&encrypted, &old_vault).map_err(|e| {
                        ProviderError::Encryption(format!(
                            "{} row {}: decrypt failed: {}",
                            table, row_id, e
                        ))
                    })?;
                let re_encrypted = crypto::encrypt_with_vault(&plaintext, &new_vault, &new_salt)
                    .map_err(|e| {
                        ProviderError::Encryption(format!(
                            "{} row {}: re-encrypt failed: {}",
                            table, row_id, e
                        ))
                    })?;
                let update_sql = format!("UPDATE {} SET {} = ? WHERE id = ?", table, blob_col);
                sqlx::query(&update_sql)
                    .bind(re_encrypted.to_bytes())
                    .bind(&row_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            }
        }

        // Replace the verification record with one encrypted under the new
        // vault + salt. unlock() derives the vault from the verification
        // record's salt, so it must be `new_salt` — the salt every rotated
        // blob was encrypted under. (A fresh crypto::encrypt here picked a
        // random salt, so after the next lock/unlock the cached vault could
        // no longer decrypt the rotated data.)
        let new_verification =
            crypto::encrypt_with_vault(VAULT_VERIFICATION, &new_vault, &new_salt)
                .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        sqlx::query("UPDATE vault_config SET verification_data = ? WHERE id = 1")
            .bind(new_verification.to_bytes())
            .execute(&mut *tx)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Swap in-memory state to the new vault. Failure mode if this point
        // is ever reached with a panic is benign: the on-disk vault is
        // already under the new password, and the next unlock will rebuild
        // master_vault/master_salt from new_password.
        *self.master_vault.write() = Some(new_vault);
        *self.master_salt.write() = Some(new_salt);

        Ok(())
    }

    async fn wipe_vault(&self, confirm_password: &str) -> Result<(), ProviderError> {
        // Verify the password against the verification record before
        // destroying any data. Avoids going through unlock() so we don't
        // hit the unlock cooldown counter for a confirmed admin action.
        let verification_row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT verification_data FROM vault_config WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
        let verification_data = verification_row
            .ok_or_else(|| ProviderError::Validation("No master password set".to_string()))?
            .0;
        let verification = EncryptedData::from_bytes(&verification_data)
            .map_err(|e| ProviderError::Encryption(e.to_string()))?;
        let verify_vault = derive_vault_off_worker(confirm_password, verification.salt)
            .await?
            .map_err(|_| ProviderError::InvalidPassword)?;
        if !vault_matches_verification(&verify_vault, &verification) {
            return Err(ProviderError::InvalidPassword);
        }
        drop(verify_vault);

        self.wipe_vault_data().await
    }

    async fn reset_vault(&self) -> Result<(), ProviderError> {
        // Forgot-password path: wipe the vault WITHOUT verifying the old
        // password (the user is locked out of it). The API layer takes a DB
        // backup before calling this and clears biometric enrollment after.
        self.wipe_vault_data().await
    }

    fn vault_encrypt_string(&self, value: &str) -> Result<Vec<u8>, ProviderError> {
        self.vault_store_string(value)
    }

    fn vault_decrypt_string(&self, encrypted: &[u8]) -> Result<String, ProviderError> {
        self.vault_get_string(encrypted)
    }

    async fn _get_credential(
        &self,
        session_id: &str,
    ) -> Result<Option<_Credential>, ProviderError> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT encrypted_data FROM credentials WHERE session_id = ?")
                .bind(session_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some((encrypted_data,)) = row else {
            return Ok(None);
        };

        let stored: StoredProfileCredential = self.vault_get(&encrypted_data)?;

        Ok(Some(_Credential {
            password: stored.password,
            key_passphrase: stored.key_passphrase,
        }))
    }

    async fn store_credential(
        &self,
        session_id: &str,
        credential: NewCredential,
    ) -> Result<(), ProviderError> {
        let stored = StoredProfileCredential {
            password: credential.password,
            key_passphrase: credential.key_passphrase,
            snmp_communities: None,
        };
        let data = self.vault_store(&stored)?;
        let now = format_datetime(&Utc::now());

        // Upsert
        sqlx::query(
            r#"
            INSERT INTO credentials (session_id, encrypted_data, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET encrypted_data = ?, updated_at = ?
            "#,
        )
        .bind(session_id)
        .bind(&data)
        .bind(&now)
        .bind(&now)
        .bind(&data)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    async fn delete_credential(&self, session_id: &str) -> Result<(), ProviderError> {
        sqlx::query("DELETE FROM credentials WHERE session_id = ?")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    // === Mapped Keys (Global) ===

    async fn list_mapped_keys(&self) -> Result<Vec<MappedKey>, ProviderError> {
        let rows: Vec<MappedKeyRow> =
            sqlx::query_as("SELECT * FROM mapped_keys ORDER BY key_combo")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_mapped_key()).collect()
    }

    async fn create_mapped_key(&self, key: NewMappedKey) -> Result<MappedKey, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        // Secret keys store an empty `command` and the encrypted value in
        // `command_encrypted`; non-secret keys keep the plaintext `command`.
        let (command, command_encrypted): (String, Option<Vec<u8>>) = if key.is_secret {
            (
                String::new(),
                Some(self.vault_encrypt_string(&key.command)?),
            )
        } else {
            (key.command.clone(), None)
        };

        sqlx::query(
            r#"
            INSERT INTO mapped_keys (id, key_combo, command, description, is_secret, command_encrypted, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&key.key_combo)
        .bind(&command)
        .bind(&key.description)
        .bind(key.is_secret)
        .bind(&command_encrypted)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: MappedKeyRow = sqlx::query_as("SELECT * FROM mapped_keys WHERE id = ?")
            .bind(&id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_mapped_key()
    }

    async fn update_mapped_key(
        &self,
        key_id: &str,
        update: UpdateMappedKey,
    ) -> Result<MappedKey, ProviderError> {
        // Load the current row so we can compute final values for every column.
        let current: MappedKeyRow = sqlx::query_as("SELECT * FROM mapped_keys WHERE id = ?")
            .bind(key_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| match e {
                sqlx::Error::RowNotFound => {
                    ProviderError::NotFound(format!("Mapped key not found: {}", key_id))
                }
                other => ProviderError::Database(other.to_string()),
            })?;

        let want_secret = update.is_secret.unwrap_or(current.is_secret);
        let command_changing = update.command.is_some();
        let secrecy_toggling = want_secret != current.is_secret;

        // Only re-derive the command columns when the command text changes or
        // the secret flag flips. A combo/description-only edit leaves the
        // (possibly encrypted) command untouched — so renaming a combo does
        // not require an unlock.
        let (command, command_encrypted): (String, Option<Vec<u8>>) =
            if command_changing || secrecy_toggling {
                // The effective plaintext: the new command if supplied, else
                // the current value (decrypting if the current row is secret).
                let effective = if let Some(ref c) = update.command {
                    c.clone()
                } else if current.is_secret {
                    let blob = current.command_encrypted.as_deref().ok_or_else(|| {
                        ProviderError::Encryption(
                            "secret mapped key missing encrypted command".to_string(),
                        )
                    })?;
                    self.vault_decrypt_string(blob)?
                } else {
                    current.command.clone()
                };
                if want_secret {
                    (String::new(), Some(self.vault_encrypt_string(&effective)?))
                } else {
                    (effective, None)
                }
            } else {
                (current.command.clone(), current.command_encrypted.clone())
            };

        let key_combo = update.key_combo.clone().unwrap_or(current.key_combo);
        let description = match update.description {
            Some(d) => d,
            None => current.description,
        };

        sqlx::query(
            r#"
            UPDATE mapped_keys
            SET key_combo = ?, command = ?, description = ?, is_secret = ?, command_encrypted = ?
            WHERE id = ?
            "#,
        )
        .bind(&key_combo)
        .bind(&command)
        .bind(&description)
        .bind(want_secret)
        .bind(&command_encrypted)
        .bind(key_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: MappedKeyRow = sqlx::query_as("SELECT * FROM mapped_keys WHERE id = ?")
            .bind(key_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_mapped_key()
    }

    async fn delete_mapped_key(&self, key_id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("mapped_keys", "id", key_id, "Mapped key")
            .await
    }

    async fn reveal_mapped_key(&self, key_id: &str) -> Result<String, ProviderError> {
        let row: MappedKeyRow = sqlx::query_as("SELECT * FROM mapped_keys WHERE id = ?")
            .bind(key_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| match e {
                sqlx::Error::RowNotFound => {
                    ProviderError::NotFound(format!("Mapped key not found: {}", key_id))
                }
                other => ProviderError::Database(other.to_string()),
            })?;

        if row.is_secret {
            let blob = row.command_encrypted.as_deref().ok_or_else(|| {
                ProviderError::Encryption("secret mapped key missing encrypted command".to_string())
            })?;
            self.vault_decrypt_string(blob)
        } else {
            Ok(row.command)
        }
    }

    // === Custom Commands ===

    async fn list_custom_commands(&self) -> Result<Vec<CustomCommand>, ProviderError> {
        let rows: Vec<CustomCommandRow> =
            sqlx::query_as("SELECT * FROM custom_commands ORDER BY sort_order, name")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_custom_command()).collect()
    }

    async fn create_custom_command(
        &self,
        cmd: NewCustomCommand,
    ) -> Result<CustomCommand, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO custom_commands (id, name, command, detection_types, sort_order, enabled, created_at, action_type, quick_action_id, quick_action_variable, script_id, show_in_force_click)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&cmd.name)
        .bind(&cmd.command)
        .bind(&cmd.detection_types)
        .bind(cmd.sort_order)
        .bind(cmd.enabled)
        .bind(&now)
        .bind(&cmd.action_type)
        .bind(&cmd.quick_action_id)
        .bind(&cmd.quick_action_variable)
        .bind(&cmd.script_id)
        .bind(cmd.show_in_force_click)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: CustomCommandRow = sqlx::query_as("SELECT * FROM custom_commands WHERE id = ?")
            .bind(&id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_custom_command()
    }

    async fn update_custom_command(
        &self,
        id: &str,
        update: UpdateCustomCommand,
    ) -> Result<CustomCommand, ProviderError> {
        let mut sets = Vec::new();
        let mut str_binds: Vec<String> = Vec::new();
        let mut int_binds: Vec<(usize, i32)> = Vec::new();
        let mut bool_binds: Vec<(usize, bool)> = Vec::new();

        if let Some(ref name) = update.name {
            sets.push("name = ?");
            str_binds.push(name.clone());
        }
        if let Some(ref command) = update.command {
            sets.push("command = ?");
            str_binds.push(command.clone());
        }
        if let Some(ref action_type) = update.action_type {
            sets.push("action_type = ?");
            str_binds.push(action_type.clone());
        }

        let detection_types_update = update.detection_types.clone();
        if detection_types_update.is_some() {
            sets.push("detection_types = ?");
        }
        let quick_action_id_update = update.quick_action_id.clone();
        if quick_action_id_update.is_some() {
            sets.push("quick_action_id = ?");
        }
        let quick_action_variable_update = update.quick_action_variable.clone();
        if quick_action_variable_update.is_some() {
            sets.push("quick_action_variable = ?");
        }
        let script_id_update = update.script_id.clone();
        if script_id_update.is_some() {
            sets.push("script_id = ?");
        }
        if let Some(sort_order) = update.sort_order {
            let idx = sets.len();
            sets.push("sort_order = ?");
            int_binds.push((idx, sort_order));
        }
        if let Some(enabled) = update.enabled {
            let idx = sets.len();
            sets.push("enabled = ?");
            bool_binds.push((idx, enabled));
        }
        if let Some(show_in_force_click) = update.show_in_force_click {
            let idx = sets.len();
            sets.push("show_in_force_click = ?");
            bool_binds.push((idx, show_in_force_click));
        }

        if sets.is_empty() {
            let row: CustomCommandRow =
                sqlx::query_as("SELECT * FROM custom_commands WHERE id = ?")
                    .bind(id)
                    .fetch_one(&self.pool)
                    .await
                    .map_err(|e| ProviderError::Database(e.to_string()))?;
            return row.into_custom_command();
        }

        let sql = format!(
            "UPDATE custom_commands SET {} WHERE id = ?",
            sets.join(", ")
        );
        let mut query = sqlx::query(&sql);

        for val in &str_binds {
            query = query.bind(val);
        }
        if let Some(ref dt) = detection_types_update {
            query = query.bind(dt.as_deref());
        }
        if let Some(ref qa_id) = quick_action_id_update {
            query = query.bind(qa_id.as_deref());
        }
        if let Some(ref qa_var) = quick_action_variable_update {
            query = query.bind(qa_var.as_deref());
        }
        if let Some(ref sid) = script_id_update {
            query = query.bind(sid.as_deref());
        }
        for (_, val) in &int_binds {
            query = query.bind(val);
        }
        for (_, val) in &bool_binds {
            query = query.bind(val);
        }
        query = query.bind(id);

        let result = query
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Custom command not found: {}",
                id
            )));
        }

        let row: CustomCommandRow = sqlx::query_as("SELECT * FROM custom_commands WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_custom_command()
    }

    async fn delete_custom_command(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("custom_commands", "id", id, "Custom command")
            .await
    }

    // === AI Conversations (chat history) ===

    async fn list_ai_conversations(&self) -> Result<Vec<AiConversationSummary>, ProviderError> {
        let rows: Vec<AiConversationSummaryRow> = sqlx::query_as(
            "SELECT id, title, agent_type, created_at, updated_at \
             FROM ai_conversations ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        rows.into_iter().map(|r| r.into_summary()).collect()
    }

    async fn get_ai_conversation(&self, id: &str) -> Result<AiConversation, ProviderError> {
        let row: AiConversationRow = sqlx::query_as("SELECT * FROM ai_conversations WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Conversation not found: {}", id)))?;
        row.into_conversation()
    }

    async fn create_ai_conversation(
        &self,
        conv: NewAiConversation,
    ) -> Result<AiConversation, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let title = conv.title.unwrap_or_else(|| "New chat".to_string());
        let messages = conv
            .messages
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new()))
            .to_string();

        sqlx::query(
            "INSERT INTO ai_conversations (id, title, messages, agent_type, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&title)
        .bind(&messages)
        .bind(&conv.agent_type)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_ai_conversation(&id).await
    }

    async fn update_ai_conversation(
        &self,
        id: &str,
        update: UpdateAiConversation,
    ) -> Result<AiConversation, ProviderError> {
        let now = format_datetime(&Utc::now());
        let mut sets: Vec<&str> = vec!["updated_at = ?"];
        if update.title.is_some() {
            sets.push("title = ?");
        }
        let messages_str = update.messages.as_ref().map(|m| m.to_string());
        if messages_str.is_some() {
            sets.push("messages = ?");
        }

        let sql = format!(
            "UPDATE ai_conversations SET {} WHERE id = ?",
            sets.join(", ")
        );
        let mut query = sqlx::query(&sql).bind(&now);
        if let Some(ref title) = update.title {
            query = query.bind(title);
        }
        if let Some(ref ms) = messages_str {
            query = query.bind(ms);
        }
        query = query.bind(id);

        let result = query
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Conversation not found: {}",
                id
            )));
        }

        self.get_ai_conversation(id).await
    }

    async fn delete_ai_conversation(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("ai_conversations", "id", id, "Conversation")
            .await
    }

    // === Snippets ===

    async fn list_snippets(&self, session_id: Option<&str>) -> Result<Vec<Snippet>, ProviderError> {
        let rows: Vec<SnippetRow> = if let Some(sid) = session_id {
            // Verify session exists
            let _ = self.get_session(sid).await?;
            sqlx::query_as("SELECT * FROM snippets WHERE session_id = ? ORDER BY sort_order, name")
                .bind(sid)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
        } else {
            // Global snippets (session_id IS NULL)
            sqlx::query_as(
                "SELECT * FROM snippets WHERE session_id IS NULL ORDER BY sort_order, name",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
        };

        rows.into_iter().map(|r| r.into_snippet()).collect()
    }

    async fn create_snippet(
        &self,
        session_id: Option<&str>,
        snippet: NewSnippet,
    ) -> Result<Snippet, ProviderError> {
        // Verify session exists if provided
        if let Some(sid) = session_id {
            let _ = self.get_session(sid).await?;
        }

        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO snippets (id, session_id, name, command, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(session_id)
        .bind(&snippet.name)
        .bind(&snippet.command)
        .bind(snippet.sort_order)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: SnippetRow = sqlx::query_as("SELECT * FROM snippets WHERE id = ?")
            .bind(&id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_snippet()
    }

    async fn delete_snippet(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("snippets", "id", id, "Snippet").await
    }

    async fn update_snippet(
        &self,
        id: &str,
        update: UpdateSnippet,
    ) -> Result<Snippet, ProviderError> {
        // Fetch current row, apply Option-Some fields, write back. Snippets
        // are single-user / single-writer so the read-modify-write race is
        // acceptable here.
        let row: SnippetRow = sqlx::query_as("SELECT * FROM snippets WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Snippet {} not found", id)))?;

        let mut snippet = row.into_snippet()?;
        if let Some(name) = update.name {
            snippet.name = name;
        }
        if let Some(command) = update.command {
            snippet.command = command;
        }
        if let Some(order) = update.sort_order {
            snippet.sort_order = order;
        }

        sqlx::query("UPDATE snippets SET name = ?, command = ?, sort_order = ? WHERE id = ?")
            .bind(&snippet.name)
            .bind(&snippet.command)
            .bind(snippet.sort_order)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(snippet)
    }

    // === Clipboard History ===

    async fn list_clips(&self, limit: i64) -> Result<Vec<Clip>, ProviderError> {
        let rows: Vec<ClipRow> =
            sqlx::query_as("SELECT * FROM clips ORDER BY created_at DESC, rowid DESC LIMIT ?")
                .bind(limit.max(1))
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
        rows.into_iter().map(|r| r.into_clip()).collect()
    }

    async fn create_clip(&self, clip: NewClip, redacted: bool) -> Result<Clip, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let provenance = serde_json::to_string(&clip.provenance)
            .map_err(|e| ProviderError::Database(format!("provenance is not JSON: {}", e)))?;

        sqlx::query(
            r#"
            INSERT INTO clips (id, text, created_at, provenance, pinned, line_ending, bytes, lines, redacted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&clip.text)
        .bind(format_datetime(&now))
        .bind(&provenance)
        .bind(clip.pinned)
        .bind(&clip.line_ending)
        .bind(clip.text.len() as i64)
        .bind(clip_line_count(&clip.text))
        .bind(redacted)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Retention: unpinned rows only. Pinned clips always survive.
        let retain_hours = clip.retain_hours.filter(|h| *h > 0).unwrap_or(24);
        let retain_max = clip.retain_max.filter(|m| *m > 0).unwrap_or(500);
        let cutoff = format_datetime(&(now - chrono::Duration::hours(retain_hours)));
        sqlx::query("DELETE FROM clips WHERE pinned = 0 AND created_at < ?")
            .bind(&cutoff)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        sqlx::query(
            r#"
            DELETE FROM clips WHERE pinned = 0 AND id NOT IN (
                SELECT id FROM clips WHERE pinned = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?
            )
            "#,
        )
        .bind(retain_max)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Every stored field is already known here — no read-back needed.
        Ok(Clip {
            id,
            bytes: clip.text.len() as i64,
            lines: clip_line_count(&clip.text),
            text: clip.text,
            created_at: now,
            provenance: clip.provenance,
            pinned: clip.pinned,
            line_ending: clip.line_ending,
            redacted,
        })
    }

    async fn update_clip(&self, id: &str, update: UpdateClip) -> Result<Clip, ProviderError> {
        if let Some(pinned) = update.pinned {
            let result = sqlx::query("UPDATE clips SET pinned = ? WHERE id = ?")
                .bind(pinned)
                .bind(id)
                .execute(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
            if result.rows_affected() == 0 {
                return Err(ProviderError::NotFound(format!("Clip {} not found", id)));
            }
        }
        let row: ClipRow = sqlx::query_as("SELECT * FROM clips WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Clip {} not found", id)))?;
        row.into_clip()
    }

    async fn delete_clip(&self, id: &str) -> Result<(), ProviderError> {
        let result = sqlx::query("DELETE FROM clips WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!("Clip {} not found", id)));
        }
        Ok(())
    }

    async fn clear_unpinned_clips(&self) -> Result<u64, ProviderError> {
        let result = sqlx::query("DELETE FROM clips WHERE pinned = 0")
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(result.rows_affected())
    }

    // === Connection Mode ===

    fn connection_mode(&self) -> ConnectionMode {
        ConnectionMode::Local
    }

    fn get_pool(&self) -> &SqlitePool {
        &self.pool
    }

    // === Connection History ===

    async fn list_history(&self, limit: i32) -> Result<Vec<ConnectionHistory>, ProviderError> {
        let rows: Vec<ConnectionHistoryRow> = sqlx::query_as(
            "SELECT id, session_id, host, port, username, connected_at, disconnected_at, duration_seconds FROM connection_history ORDER BY connected_at DESC LIMIT ?"
        )
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_history()).collect()
    }

    async fn create_history(
        &self,
        entry: NewConnectionHistory,
    ) -> Result<ConnectionHistory, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO connection_history (id, session_id, host, port, username, connected_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&entry.session_id)
        .bind(&entry.host)
        .bind(entry.port as i32)
        .bind(&entry.username)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: ConnectionHistoryRow = sqlx::query_as(
            "SELECT id, session_id, host, port, username, connected_at, disconnected_at, duration_seconds FROM connection_history WHERE id = ?"
        )
            .bind(&id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_history()
    }

    async fn delete_history(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("connection_history", "id", id, "History entry")
            .await
    }

    // === Export/Import ===

    async fn export_all(&self) -> Result<ExportData, ProviderError> {
        let sessions = self.list_sessions().await?;
        let folders = self.list_folders(None).await?;

        // Build folder name lookup
        let folder_names: std::collections::HashMap<String, String> = folders
            .iter()
            .map(|f| (f.id.clone(), f.name.clone()))
            .collect();

        // Build parent folder name lookup
        let parent_names: std::collections::HashMap<String, Option<String>> = folders
            .iter()
            .map(|f| {
                let parent_name = f
                    .parent_id
                    .as_ref()
                    .and_then(|pid| folder_names.get(pid).cloned());
                (f.id.clone(), parent_name)
            })
            .collect();

        let mut export_sessions = Vec::new();
        for session in &sessions {
            let folder_name = session
                .folder_id
                .as_ref()
                .and_then(|fid| folder_names.get(fid).cloned());
            export_sessions.push(self.session_to_export(session, folder_name).await?);
        }

        let export_folders: Vec<ExportFolder> = folders
            .into_iter()
            .map(|f| ExportFolder {
                name: f.name,
                parent_name: parent_names.get(&f.id).cloned().flatten(),
            })
            .collect();

        Ok(ExportData {
            version: "1.0".to_string(),
            format: "netstacks-sessions".to_string(),
            exported_at: Utc::now(),
            sessions: export_sessions,
            folders: export_folders,
        })
    }

    async fn export_folder(&self, folder_id: &str) -> Result<ExportData, ProviderError> {
        let _folder = self.get_folder(folder_id).await?;
        let all_folders = self.list_folders(None).await?;
        let all_sessions = self.list_sessions().await?;

        // Build folder name lookup
        let folder_names: std::collections::HashMap<String, String> = all_folders
            .iter()
            .map(|f| (f.id.clone(), f.name.clone()))
            .collect();

        // Find all descendant folder IDs
        let mut folder_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        folder_ids.insert(folder_id.to_string());

        // Recursively find subfolders
        loop {
            let mut added = false;
            for f in &all_folders {
                if let Some(pid) = &f.parent_id {
                    if folder_ids.contains(pid) && !folder_ids.contains(&f.id) {
                        folder_ids.insert(f.id.clone());
                        added = true;
                    }
                }
            }
            if !added {
                break;
            }
        }

        // Filter sessions to those in these folders
        let filtered_sessions: Vec<Session> = all_sessions
            .into_iter()
            .filter(|s| {
                s.folder_id
                    .as_ref()
                    .map(|fid| folder_ids.contains(fid))
                    .unwrap_or(false)
            })
            .collect();

        // Filter folders
        let filtered_folders: Vec<Folder> = all_folders
            .into_iter()
            .filter(|f| folder_ids.contains(&f.id))
            .collect();

        let mut export_sessions = Vec::new();
        for session in &filtered_sessions {
            let folder_name = session
                .folder_id
                .as_ref()
                .and_then(|fid| folder_names.get(fid).cloned());
            export_sessions.push(self.session_to_export(session, folder_name).await?);
        }

        // Build parent names for filtered folders
        let export_folders: Vec<ExportFolder> = filtered_folders
            .into_iter()
            .map(|f| ExportFolder {
                name: f.name,
                parent_name: f
                    .parent_id
                    .as_ref()
                    .and_then(|pid| folder_names.get(pid).cloned()),
            })
            .collect();

        Ok(ExportData {
            version: "1.0".to_string(),
            format: "netstacks-sessions".to_string(),
            exported_at: Utc::now(),
            sessions: export_sessions,
            folders: export_folders,
        })
    }

    async fn export_session(&self, session_id: &str) -> Result<ExportData, ProviderError> {
        let session = self.get_session(session_id).await?;
        let folders = self.list_folders(None).await?;

        // Get folder name if session is in a folder
        let folder_name = session.folder_id.as_ref().and_then(|fid| {
            folders
                .iter()
                .find(|f| &f.id == fid)
                .map(|f| f.name.clone())
        });

        let export_session = self
            .session_to_export(&session, folder_name.clone())
            .await?;

        // Include the folder if session is in one
        let export_folders = if let Some(name) = folder_name {
            vec![ExportFolder {
                name,
                parent_name: None,
            }]
        } else {
            vec![]
        };

        Ok(ExportData {
            version: "1.0".to_string(),
            format: "netstacks-sessions".to_string(),
            exported_at: Utc::now(),
            sessions: vec![export_session],
            folders: export_folders,
        })
    }

    async fn import_data(&self, data: ExportData) -> Result<ImportResult, ProviderError> {
        let mut sessions_created = 0;
        let mut folders_created = 0;
        let mut warnings: Vec<String> = Vec::new();

        // Build folder name to ID map for existing folders
        let existing_folders = self.list_folders(None).await?;
        let mut folder_name_to_id: std::collections::HashMap<String, String> = existing_folders
            .iter()
            .map(|f| (f.name.clone(), f.id.clone()))
            .collect();

        // First pass: create folders without parents
        for folder in &data.folders {
            if folder.parent_name.is_none() && !folder_name_to_id.contains_key(&folder.name) {
                let new_folder = NewFolder {
                    name: folder.name.clone(),
                    parent_id: None,
                    scope: None,
                };
                match self.create_folder(new_folder).await {
                    Ok(created) => {
                        folder_name_to_id.insert(folder.name.clone(), created.id);
                        folders_created += 1;
                    }
                    Err(e) => {
                        warnings.push(format!("Failed to create folder '{}': {}", folder.name, e));
                    }
                }
            }
        }

        // Second pass: create folders with parents
        for folder in &data.folders {
            if folder.parent_name.is_some() && !folder_name_to_id.contains_key(&folder.name) {
                let parent_id = folder
                    .parent_name
                    .as_ref()
                    .and_then(|pn| folder_name_to_id.get(pn).cloned());
                let new_folder = NewFolder {
                    name: folder.name.clone(),
                    parent_id,
                    scope: None,
                };
                match self.create_folder(new_folder).await {
                    Ok(created) => {
                        folder_name_to_id.insert(folder.name.clone(), created.id);
                        folders_created += 1;
                    }
                    Err(e) => {
                        warnings.push(format!("Failed to create folder '{}': {}", folder.name, e));
                    }
                }
            }
        }

        // Name → id lookups shared by every imported session (login profile,
        // console profile, jump host): one query each, not one per session.
        let profiles = self.list_profiles().await.unwrap_or_default();
        let profile_id_by_name = |name: &str| {
            profiles
                .iter()
                .find(|p| p.name == name)
                .map(|p| p.id.clone())
        };
        let jump_hosts = self.list_jump_hosts().await.unwrap_or_default();

        // Create sessions
        for session in data.sessions {
            let folder_id = session
                .folder_name
                .as_ref()
                .and_then(|fn_| folder_name_to_id.get(fn_).cloned());

            // Look up profile by name if provided
            let profile_id = session.profile_name.as_deref().and_then(profile_id_by_name);

            // Skip session if profile is required but not found
            let Some(profile_id) = profile_id else {
                warnings.push(format!(
                    "Skipped session '{}': profile '{}' not found (create matching profile first)",
                    session.name,
                    session.profile_name.as_deref().unwrap_or("<none>")
                ));
                continue;
            };

            // Look up jump host by name if provided
            let jump_host_id = session.jump_host_name.as_ref().and_then(|jhn| {
                jump_hosts
                    .iter()
                    .find(|jh| &jh.name == jhn)
                    .map(|jh| jh.id.clone())
            });

            // Console profile is optional; an unknown name imports the console
            // host/port without a login and warns rather than skipping.
            let console_profile_id = session
                .console_profile_name
                .as_deref()
                .and_then(profile_id_by_name);
            let console_missing_login = session.console_host.is_some()
                && session.console_protocol == Protocol::Ssh
                && console_profile_id.is_none();
            if console_missing_login {
                warnings.push(format!(
                    "Session '{}': console profile '{}' not found; SSH console access needs a terminal-server login, so it was not imported",
                    session.name,
                    session.console_profile_name.as_deref().unwrap_or("<none>")
                ));
            }
            let (console_host, console_port) = if console_missing_login {
                (None, None)
            } else {
                (session.console_host.clone(), session.console_port)
            };

            let new_session = NewSession {
                name: session.name.clone(),
                folder_id,
                host: session.host.clone(),
                port: session.port,
                color: session.color.clone(),
                profile_id,
                netbox_device_id: None,
                netbox_source_id: None,
                cli_flavor: CliFlavor::Auto,
                terminal_theme: None,
                font_family: None,
                font_size_override: session.font_size_override,
                // Jump host reference (global jump hosts)
                jump_host_id,
                // Session-as-jump alternative (not used by import path)
                jump_session_id: None,
                // Port forwarding (Phase 06.3)
                port_forwards: session.port_forwards.clone(),
                // Auto commands on connect
                auto_commands: Vec::new(),
                // Legacy SSH support (default off for imports)
                legacy_ssh: false,
                protocol: Protocol::Ssh,
                sftp_start_path: None,
                console_host,
                console_port,
                console_protocol: session.console_protocol.clone(),
                console_profile_id,
                console_legacy_ssh: session.console_legacy_ssh,
                auto_reconnect: session.auto_reconnect,
                reconnect_delay: session.reconnect_delay,
                scrollback_lines: session.scrollback_lines,
                local_echo: session.local_echo,
                icon: session.icon.clone(),
            };

            match self.create_session(new_session).await {
                Ok(created) => {
                    // Import mapped keys as global (legacy per-session format)
                    for key in session.mapped_keys {
                        if let Err(e) = self.create_mapped_key(key).await {
                            // Silently ignore duplicate key_combo (UNIQUE constraint)
                            if !e.to_string().contains("UNIQUE") {
                                warnings.push(format!(
                                    "Failed to create mapped key for '{}': {}",
                                    session.name, e
                                ));
                            }
                        }
                    }

                    // Create snippets
                    for snippet in session.snippets {
                        if let Err(e) = self.create_snippet(Some(&created.id), snippet).await {
                            warnings.push(format!(
                                "Failed to create snippet for '{}': {}",
                                session.name, e
                            ));
                        }
                    }

                    sessions_created += 1;
                }
                Err(e) => {
                    warnings.push(format!(
                        "Failed to create session '{}': {}",
                        session.name, e
                    ));
                }
            }
        }

        Ok(ImportResult {
            sessions_created,
            folders_created,
            warnings,
        })
    }

    // === Settings ===

    async fn get_setting(&self, key: &str) -> Result<serde_json::Value, ProviderError> {
        let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some((value,)) => serde_json::from_str(&value)
                .map_err(|e| ProviderError::Database(format!("Failed to parse setting: {}", e))),
            None => Ok(serde_json::Value::Null),
        }
    }

    async fn set_setting(&self, key: &str, value: serde_json::Value) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());
        let value_str = serde_json::to_string(&value)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize setting: {}", e)))?;

        sqlx::query(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
            "#,
        )
        .bind(key)
        .bind(&value_str)
        .bind(&now)
        .bind(&value_str)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    async fn delete_setting(&self, key: &str) -> Result<(), ProviderError> {
        sqlx::query("DELETE FROM settings WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    // === Credential Profiles ===

    async fn list_profiles(&self) -> Result<Vec<CredentialProfile>, ProviderError> {
        let rows: Vec<CredentialProfileRow> =
            sqlx::query_as("SELECT * FROM credential_profiles ORDER BY name")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_profile()).collect()
    }

    async fn get_profile(&self, id: &str) -> Result<CredentialProfile, ProviderError> {
        let row: CredentialProfileRow =
            sqlx::query_as("SELECT * FROM credential_profiles WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
                .ok_or_else(|| ProviderError::NotFound(format!("Profile not found: {}", id)))?;

        row.into_profile()
    }

    async fn create_profile(
        &self,
        profile: NewCredentialProfile,
    ) -> Result<CredentialProfile, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let auth_type = match profile.auth_type {
            AuthType::Password => "password",
            AuthType::Key => "key",
        };

        let cli_flavor_str = serde_json::to_value(&profile.cli_flavor)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "auto".to_string());
        let auto_commands_json =
            serde_json::to_string(&profile.auto_commands).unwrap_or_else(|_| "[]".to_string());

        // Validate jump host chain (existing) and the new mutual-exclusion +
        // session-as-jump leaf rules before creating profile.
        Self::validate_profile_jump_host_chain(
            &self.pool,
            "",
            &profile.name,
            profile.jump_host_id.as_deref(),
        )
        .await?;
        crate::db::validate_entity_jump_refs(
            &self.pool,
            "profile",
            None,
            &profile.name,
            profile.jump_host_id.as_deref(),
            profile.jump_session_id.as_deref(),
        )
        .await
        .map_err(|e| ProviderError::Validation(e.to_string()))?;

        sqlx::query(
            r#"
            INSERT INTO credential_profiles (
                id, name, username, auth_type, key_path, port, keepalive_interval,
                connection_timeout, terminal_theme, default_font_size, default_font_family,
                scrollback_lines, local_echo, auto_reconnect, reconnect_delay,
                cli_flavor, auto_commands, jump_host_id, jump_session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&profile.name)
        .bind(&profile.username)
        .bind(auth_type)
        .bind(&profile.key_path)
        .bind(profile.port as i32)
        .bind(profile.keepalive_interval as i32)
        .bind(profile.connection_timeout as i32)
        .bind(&profile.terminal_theme)
        .bind(profile.default_font_size.map(|v| v as i32))
        .bind(&profile.default_font_family)
        .bind(profile.scrollback_lines as i32)
        .bind(profile.local_echo as i32)
        .bind(profile.auto_reconnect as i32)
        .bind(profile.reconnect_delay as i32)
        .bind(&cli_flavor_str)
        .bind(&auto_commands_json)
        .bind(&profile.jump_host_id)
        .bind(&profile.jump_session_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_profile(&id).await
    }

    async fn update_profile(
        &self,
        id: &str,
        update: UpdateCredentialProfile,
    ) -> Result<CredentialProfile, ProviderError> {
        // Verify profile exists
        let current = self.get_profile(id).await?;

        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let username = update.username.unwrap_or(current.username);
        let auth_type = match update.auth_type.unwrap_or(current.auth_type) {
            AuthType::Password => "password",
            AuthType::Key => "key",
        };
        let key_path = update.key_path.unwrap_or(current.key_path);
        let port = update.port.unwrap_or(current.port) as i32;
        let keepalive_interval = update
            .keepalive_interval
            .unwrap_or(current.keepalive_interval) as i32;
        let connection_timeout = update
            .connection_timeout
            .unwrap_or(current.connection_timeout) as i32;
        let terminal_theme = update
            .terminal_theme
            .unwrap_or(Some(current.terminal_theme).flatten());
        let default_font_size = update
            .default_font_size
            .unwrap_or(Some(current.default_font_size).flatten());
        let default_font_family = update
            .default_font_family
            .unwrap_or(Some(current.default_font_family).flatten());
        let scrollback_lines = update.scrollback_lines.unwrap_or(current.scrollback_lines) as i32;
        let local_echo = update.local_echo.unwrap_or(current.local_echo) as i32;
        let auto_reconnect_val = update.auto_reconnect.unwrap_or(current.auto_reconnect) as i32;
        let reconnect_delay_val = update.reconnect_delay.unwrap_or(current.reconnect_delay) as i32;
        let cli_flavor = update.cli_flavor.unwrap_or(current.cli_flavor);
        let cli_flavor_str = serde_json::to_value(&cli_flavor)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "auto".to_string());
        let auto_commands = update.auto_commands.unwrap_or(current.auto_commands);
        let auto_commands_json =
            serde_json::to_string(&auto_commands).unwrap_or_else(|_| "[]".to_string());
        let jump_host_id = match update.jump_host_id {
            Some(v) => v,
            None => current.jump_host_id.clone(),
        };
        let jump_session_id = match update.jump_session_id {
            Some(v) => v,
            None => current.jump_session_id.clone(),
        };

        // Validate jump host chain (existing) and new mutual-exclusion +
        // session-as-jump leaf rules before updating profile.
        Self::validate_profile_jump_host_chain(&self.pool, id, &name, jump_host_id.as_deref())
            .await?;
        crate::db::validate_entity_jump_refs(
            &self.pool,
            "profile",
            Some(id),
            &name,
            jump_host_id.as_deref(),
            jump_session_id.as_deref(),
        )
        .await
        .map_err(|e| ProviderError::Validation(e.to_string()))?;

        sqlx::query(
            r#"
            UPDATE credential_profiles SET
                name = ?, username = ?, auth_type = ?, key_path = ?, port = ?,
                keepalive_interval = ?, connection_timeout = ?,
                terminal_theme = ?, default_font_size = ?, default_font_family = ?,
                scrollback_lines = ?, local_echo = ?, auto_reconnect = ?, reconnect_delay = ?,
                cli_flavor = ?, auto_commands = ?, jump_host_id = ?, jump_session_id = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&username)
        .bind(auth_type)
        .bind(&key_path)
        .bind(port)
        .bind(keepalive_interval)
        .bind(connection_timeout)
        .bind(&terminal_theme)
        .bind(default_font_size.map(|v| v as i32))
        .bind(&default_font_family)
        .bind(scrollback_lines)
        .bind(local_echo)
        .bind(auto_reconnect_val)
        .bind(reconnect_delay_val)
        .bind(&cli_flavor_str)
        .bind(&auto_commands_json)
        .bind(&jump_host_id)
        .bind(&jump_session_id)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_profile(id).await
    }

    async fn delete_profile(&self, id: &str) -> Result<(), ProviderError> {
        // Check if any sessions use this profile (as login or console login)
        let count: (i32,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sessions WHERE profile_id = ? OR console_profile_id = ?",
        )
        .bind(id)
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        if count.0 > 0 {
            return Err(ProviderError::Validation(format!(
                "Cannot delete profile: {} session(s) are using it",
                count.0
            )));
        }

        // jump_hosts.profile_id and tunnels.profile_id are ON DELETE CASCADE, so
        // without this check deleting a profile silently removed the jump host
        // and every session that used it fell back to a direct connection (NS-SESS-5).
        let jump_hosts: (i32,) =
            sqlx::query_as("SELECT COUNT(*) FROM jump_hosts WHERE profile_id = ?")
                .bind(id)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
        let tunnels: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM tunnels WHERE profile_id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        if jump_hosts.0 > 0 || tunnels.0 > 0 {
            return Err(ProviderError::Validation(format!(
                "Cannot delete profile: {} jump host(s) and {} tunnel(s) are using it",
                jump_hosts.0, tunnels.0
            )));
        }

        // Delete profile credential from vault first
        let _ = self.delete_profile_credential(id).await;

        let result = sqlx::query("DELETE FROM credential_profiles WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Profile not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn get_profile_credential(
        &self,
        profile_id: &str,
    ) -> Result<Option<ProfileCredential>, ProviderError> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT encrypted_data FROM profile_credentials WHERE profile_id = ?")
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some((encrypted_data,)) = row else {
            return Ok(None);
        };

        let stored: StoredProfileCredential = self.vault_get(&encrypted_data)?;

        Ok(Some(ProfileCredential {
            password: stored.password,
            key_passphrase: stored.key_passphrase,
            snmp_communities: stored.snmp_communities,
        }))
    }

    async fn store_profile_credential(
        &self,
        profile_id: &str,
        credential: ProfileCredential,
    ) -> Result<(), ProviderError> {
        // Merge with existing credential: only overwrite fields that are Some in the request
        let existing = self.get_profile_credential(profile_id).await?;
        let stored = if let Some(existing) = existing {
            StoredProfileCredential {
                password: credential.password.or(existing.password),
                key_passphrase: credential.key_passphrase.or(existing.key_passphrase),
                snmp_communities: credential.snmp_communities.or(existing.snmp_communities),
            }
        } else {
            StoredProfileCredential {
                password: credential.password,
                key_passphrase: credential.key_passphrase,
                snmp_communities: credential.snmp_communities,
            }
        };
        let data = self.vault_store(&stored)?;
        let now = format_datetime(&Utc::now());

        // Upsert
        sqlx::query(
            r#"
            INSERT INTO profile_credentials (profile_id, encrypted_data, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET encrypted_data = ?, updated_at = ?
            "#,
        )
        .bind(profile_id)
        .bind(&data)
        .bind(&now)
        .bind(&now)
        .bind(&data)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    async fn delete_profile_credential(&self, profile_id: &str) -> Result<(), ProviderError> {
        sqlx::query("DELETE FROM profile_credentials WHERE profile_id = ?")
            .bind(profile_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    // === Jump Hosts (Global Proxy Configuration) ===

    async fn list_jump_hosts(&self) -> Result<Vec<JumpHost>, ProviderError> {
        let rows: Vec<JumpHostRow> = sqlx::query_as("SELECT * FROM jump_hosts ORDER BY name")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_jump_host()).collect()
    }

    async fn get_jump_host(&self, id: &str) -> Result<JumpHost, ProviderError> {
        let row: JumpHostRow = sqlx::query_as("SELECT * FROM jump_hosts WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Jump host not found: {}", id)))?;

        row.into_jump_host()
    }

    async fn create_jump_host(&self, jump_host: NewJumpHost) -> Result<JumpHost, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        // Validate that the auth profile is a leaf (no jump_host_id)
        Self::validate_jump_host_profile_is_leaf(
            &self.pool,
            &jump_host.name,
            &jump_host.profile_id,
        )
        .await?;

        // Verify profile exists
        let _ = self.get_profile(&jump_host.profile_id).await?;

        sqlx::query(
            r#"
            INSERT INTO jump_hosts (id, name, host, port, profile_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&jump_host.name)
        .bind(&jump_host.host)
        .bind(jump_host.port as i32)
        .bind(&jump_host.profile_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_jump_host(&id).await
    }

    async fn update_jump_host(
        &self,
        id: &str,
        update: UpdateJumpHost,
    ) -> Result<JumpHost, ProviderError> {
        // Verify jump host exists
        let current = self.get_jump_host(id).await?;
        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let host = update.host.unwrap_or(current.host);
        let port = update.port.unwrap_or(current.port) as i32;
        let profile_id = update.profile_id.unwrap_or(current.profile_id);

        // Validate that the auth profile is a leaf (no jump_host_id)
        Self::validate_jump_host_profile_is_leaf(&self.pool, &name, &profile_id).await?;

        // Verify profile exists if updated
        let _ = self.get_profile(&profile_id).await?;

        sqlx::query(
            r#"
            UPDATE jump_hosts SET name = ?, host = ?, port = ?, profile_id = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&host)
        .bind(port)
        .bind(&profile_id)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_jump_host(id).await
    }

    async fn delete_jump_host(&self, id: &str) -> Result<(), ProviderError> {
        // Check if any sessions use this jump host
        let count: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM sessions WHERE jump_host_id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if count.0 > 0 {
            return Err(ProviderError::Validation(format!(
                "Cannot delete jump host: {} session(s) are using it",
                count.0
            )));
        }

        let result = sqlx::query("DELETE FROM jump_hosts WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Jump host not found: {}",
                id
            )));
        }

        Ok(())
    }

    // === NetBox Sources ===

    async fn list_netbox_sources(&self) -> Result<Vec<NetBoxSource>, ProviderError> {
        let rows: Vec<NetBoxSourceRow> =
            sqlx::query_as("SELECT * FROM netbox_sources ORDER BY name")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_source()).collect()
    }

    async fn get_netbox_source(&self, id: &str) -> Result<NetBoxSource, ProviderError> {
        let row: NetBoxSourceRow = sqlx::query_as("SELECT * FROM netbox_sources WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("NetBox source not found: {}", id)))?;

        row.into_source()
    }

    async fn create_netbox_source(
        &self,
        source: NewNetBoxSource,
    ) -> Result<NetBoxSource, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        let profile_mappings_json =
            serde_json::to_string(&source.profile_mappings).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize profile_mappings: {}", e))
            })?;

        let cli_flavor_mappings_json =
            serde_json::to_string(&source.cli_flavor_mappings).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize cli_flavor_mappings: {}", e))
            })?;

        let device_filters_json = source
            .device_filters
            .map(|f| serde_json::to_string(&f))
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize device_filters: {}", e))
            })?;

        let console_protocol_mappings_json =
            serde_json::to_string(&source.console_protocol_mappings).map_err(|e| {
                ProviderError::Database(format!(
                    "Failed to serialize console_protocol_mappings: {}",
                    e
                ))
            })?;

        sqlx::query(
            r#"
            INSERT INTO netbox_sources (id, name, api_resource_id, default_profile_id, profile_mappings, cli_flavor_mappings, device_filters, console_profile_id, console_protocol_mappings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&source.name)
        .bind(&source.api_resource_id)
        .bind(&source.default_profile_id)
        .bind(&profile_mappings_json)
        .bind(&cli_flavor_mappings_json)
        .bind(&device_filters_json)
        .bind(&source.console_profile_id)
        .bind(&console_protocol_mappings_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_netbox_source(&id).await
    }

    async fn update_netbox_source(
        &self,
        id: &str,
        update: UpdateNetBoxSource,
    ) -> Result<NetBoxSource, ProviderError> {
        // Verify source exists
        let current = self.get_netbox_source(id).await?;

        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let api_resource_id = update.api_resource_id.unwrap_or(current.api_resource_id);
        let default_profile_id = update
            .default_profile_id
            .unwrap_or(current.default_profile_id);
        let profile_mappings = update.profile_mappings.unwrap_or(current.profile_mappings);
        let cli_flavor_mappings = update
            .cli_flavor_mappings
            .unwrap_or(current.cli_flavor_mappings);
        let device_filters = update.device_filters.unwrap_or(current.device_filters);
        let console_profile_id = update
            .console_profile_id
            .unwrap_or(current.console_profile_id);
        let console_protocol_mappings = update
            .console_protocol_mappings
            .unwrap_or(current.console_protocol_mappings);
        let last_sync_at = update.last_sync_at.unwrap_or(current.last_sync_at);
        let last_sync_filters = update
            .last_sync_filters
            .unwrap_or(current.last_sync_filters);
        let last_sync_result = update.last_sync_result.unwrap_or(current.last_sync_result);

        let profile_mappings_json = serde_json::to_string(&profile_mappings).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize profile_mappings: {}", e))
        })?;
        let cli_flavor_mappings_json =
            serde_json::to_string(&cli_flavor_mappings).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize cli_flavor_mappings: {}", e))
            })?;
        let device_filters_json = device_filters
            .map(|f| serde_json::to_string(&f))
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize device_filters: {}", e))
            })?;
        let console_protocol_mappings_json = serde_json::to_string(&console_protocol_mappings)
            .map_err(|e| {
                ProviderError::Database(format!(
                    "Failed to serialize console_protocol_mappings: {}",
                    e
                ))
            })?;
        let last_sync_at_str = last_sync_at.map(|dt| format_datetime(&dt));
        let last_sync_filters_json = last_sync_filters
            .map(|f| serde_json::to_string(&f))
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize last_sync_filters: {}", e))
            })?;
        let last_sync_result_json = last_sync_result
            .map(|r| serde_json::to_string(&r))
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize last_sync_result: {}", e))
            })?;

        sqlx::query(
            r#"
            UPDATE netbox_sources SET
                name = ?, api_resource_id = ?, default_profile_id = ?, profile_mappings = ?, cli_flavor_mappings = ?,
                device_filters = ?, console_profile_id = ?, console_protocol_mappings = ?,
                last_sync_at = ?, last_sync_filters = ?, last_sync_result = ?,
                updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&api_resource_id)
        .bind(&default_profile_id)
        .bind(&profile_mappings_json)
        .bind(&cli_flavor_mappings_json)
        .bind(&device_filters_json)
        .bind(&console_profile_id)
        .bind(&console_protocol_mappings_json)
        .bind(&last_sync_at_str)
        .bind(&last_sync_filters_json)
        .bind(&last_sync_result_json)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_netbox_source(id).await
    }

    async fn delete_netbox_source(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("netbox_sources", "id", id, "NetBox source")
            .await
    }

    // === LibreNMS Sources (Phase 22) ===

    async fn list_librenms_sources(&self) -> Result<Vec<LibreNmsSource>, ProviderError> {
        let rows: Vec<LibreNmsSourceRow> =
            sqlx::query_as("SELECT * FROM librenms_sources ORDER BY name")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_source()).collect()
    }

    async fn get_librenms_source(&self, id: &str) -> Result<LibreNmsSource, ProviderError> {
        let row: LibreNmsSourceRow = sqlx::query_as("SELECT * FROM librenms_sources WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("LibreNMS source not found: {}", id)))?;

        row.into_source()
    }

    async fn create_librenms_source(
        &self,
        source: NewLibreNmsSource,
    ) -> Result<LibreNmsSource, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO librenms_sources (id, name, api_resource_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&source.name)
        .bind(&source.api_resource_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_librenms_source(&id).await
    }

    async fn update_librenms_source(
        &self,
        id: &str,
        update: UpdateLibreNmsSource,
    ) -> Result<LibreNmsSource, ProviderError> {
        let current = self.get_librenms_source(id).await?;
        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let api_resource_id = update.api_resource_id.unwrap_or(current.api_resource_id);

        sqlx::query(
            r#"
            UPDATE librenms_sources SET name = ?, api_resource_id = ?, updated_at = ? WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&api_resource_id)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_librenms_source(id).await
    }

    async fn delete_librenms_source(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("librenms_sources", "id", id, "LibreNMS source")
            .await
    }

    // === NetStacks-Crawler Sources (Phase 22) ===

    async fn list_netstacks_crawler_sources(
        &self,
    ) -> Result<Vec<NetStacksCrawlerSource>, ProviderError> {
        let rows: Vec<NetStacksCrawlerSourceRow> =
            sqlx::query_as("SELECT * FROM netstacks_crawler_sources ORDER BY name")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_source()).collect()
    }

    async fn get_netstacks_crawler_source(
        &self,
        id: &str,
    ) -> Result<NetStacksCrawlerSource, ProviderError> {
        let row: NetStacksCrawlerSourceRow =
            sqlx::query_as("SELECT * FROM netstacks_crawler_sources WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
                .ok_or_else(|| {
                    ProviderError::NotFound(format!("NetStacks-Crawler source not found: {}", id))
                })?;

        row.into_source()
    }

    async fn create_netstacks_crawler_source(
        &self,
        source: NewNetStacksCrawlerSource,
    ) -> Result<NetStacksCrawlerSource, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO netstacks_crawler_sources (id, name, api_resource_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&source.name)
        .bind(&source.api_resource_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_netstacks_crawler_source(&id).await
    }

    async fn update_netstacks_crawler_source(
        &self,
        id: &str,
        update: UpdateNetStacksCrawlerSource,
    ) -> Result<NetStacksCrawlerSource, ProviderError> {
        let current = self.get_netstacks_crawler_source(id).await?;
        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let api_resource_id = update.api_resource_id.unwrap_or(current.api_resource_id);

        sqlx::query(
            r#"
            UPDATE netstacks_crawler_sources SET
                name = ?, api_resource_id = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&api_resource_id)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_netstacks_crawler_source(id).await
    }

    async fn delete_netstacks_crawler_source(&self, id: &str) -> Result<(), ProviderError> {
        let result = sqlx::query("DELETE FROM netstacks_crawler_sources WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "NetStacks-Crawler source not found: {}",
                id
            )));
        }

        Ok(())
    }

    // === API Keys (Vault-stored) ===

    async fn get_api_key(&self, key_type: &str) -> Result<Option<String>, ProviderError> {
        let row: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT encrypted_data FROM api_keys WHERE key_type = ?")
                .bind(key_type)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some((encrypted_data,)) = row else {
            return Ok(None);
        };

        Ok(Some(self.vault_get_string(&encrypted_data)?))
    }

    async fn store_api_key(&self, key_type: &str, api_key: &str) -> Result<(), ProviderError> {
        let data = self.vault_store_string(api_key)?;
        let now = format_datetime(&Utc::now());

        // Upsert
        sqlx::query(
            r#"
            INSERT INTO api_keys (key_type, encrypted_data, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key_type) DO UPDATE SET encrypted_data = ?, updated_at = ?
            "#,
        )
        .bind(key_type)
        .bind(&data)
        .bind(&now)
        .bind(&now)
        .bind(&data)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    async fn delete_api_key(&self, key_type: &str) -> Result<(), ProviderError> {
        sqlx::query("DELETE FROM api_keys WHERE key_type = ?")
            .bind(key_type)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(())
    }

    async fn has_api_key(&self, key_type: &str) -> Result<bool, ProviderError> {
        // Note: This check doesn't require vault to be unlocked
        let row: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM api_keys WHERE key_type = ?")
            .bind(key_type)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(row.is_some())
    }

    // === MCP Auth Tokens (AUDIT FIX CRYPTO-002) ===

    async fn store_mcp_auth_token(
        &self,
        server_id: &str,
        token: &str,
    ) -> Result<(), ProviderError> {
        let data = self.vault_store_string(token)?;
        sqlx::query(
            "UPDATE mcp_servers SET auth_token_encrypted = ?, auth_token = NULL WHERE id = ?",
        )
        .bind(&data)
        .bind(server_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    async fn get_mcp_auth_token(&self, server_id: &str) -> Result<Option<String>, ProviderError> {
        let row: Option<(Option<Vec<u8>>, Option<String>)> =
            sqlx::query_as("SELECT auth_token_encrypted, auth_token FROM mcp_servers WHERE id = ?")
                .bind(server_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        let Some((encrypted, plaintext)) = row else {
            return Ok(None);
        };

        if let Some(blob) = encrypted {
            return Ok(Some(self.vault_get_string(&blob)?));
        }
        if let Some(p) = plaintext {
            // Legacy plaintext path. Log once per call so the operator notices.
            tracing::warn!(
                target: "audit",
                server_id = %server_id,
                "MCP server has a legacy plaintext auth_token; recommend re-saving \
                 it via the Settings UI to migrate to vault encryption"
            );
            return Ok(Some(p));
        }
        Ok(None)
    }

    async fn delete_mcp_auth_token(&self, server_id: &str) -> Result<(), ProviderError> {
        sqlx::query(
            "UPDATE mcp_servers SET auth_token_encrypted = NULL, auth_token = NULL WHERE id = ?",
        )
        .bind(server_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    async fn mcp_server_has_token(&self, server_id: &str) -> Result<bool, ProviderError> {
        let row: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM mcp_servers WHERE id = ? AND \
             (auth_token IS NOT NULL OR auth_token_encrypted IS NOT NULL)",
        )
        .bind(server_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(row.is_some())
    }

    // === Recordings ===

    async fn list_recordings(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<Recording>, ProviderError> {
        let rows: Vec<RecordingRow> = if let Some(sid) = session_id {
            sqlx::query_as("SELECT * FROM recordings WHERE session_id = ? ORDER BY created_at DESC")
                .bind(sid)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
        } else {
            sqlx::query_as("SELECT * FROM recordings ORDER BY created_at DESC")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
        };

        rows.into_iter().map(|r| r.into_recording()).collect()
    }

    async fn get_recording(&self, id: &str) -> Result<Recording, ProviderError> {
        let row: RecordingRow = sqlx::query_as("SELECT * FROM recordings WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Recording not found: {}", id)))?;

        row.into_recording()
    }

    async fn create_recording(&self, recording: NewRecording) -> Result<Recording, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        // Generate the recording file path
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        let recordings_dir = std::path::PathBuf::from(&home)
            .join("Documents")
            .join("NetStacks")
            .join("recordings");

        // Create directory if it doesn't exist
        if !recordings_dir.exists() {
            std::fs::create_dir_all(&recordings_dir).map_err(|e| {
                ProviderError::Database(format!("Failed to create recordings directory: {}", e))
            })?;
        }

        let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
        let file_path = recordings_dir
            .join(format!("{}_{}.cast", id, timestamp))
            .to_string_lossy()
            .to_string();

        // Create the initial asciicast v2 header
        let header = serde_json::json!({
            "version": 2,
            "width": recording.terminal_cols,
            "height": recording.terminal_rows,
            "timestamp": Utc::now().timestamp(),
            "title": recording.name,
            "env": {
                "SHELL": std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
                "TERM": "xterm-256color"
            }
        });

        // Write the header to the file
        let header_line = serde_json::to_string(&header)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize header: {}", e)))?;
        std::fs::write(&file_path, format!("{}\n", header_line)).map_err(|e| {
            ProviderError::Database(format!("Failed to create recording file: {}", e))
        })?;

        sqlx::query(
            r#"
            INSERT INTO recordings (id, session_id, name, terminal_cols, terminal_rows, duration_ms, file_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&recording.session_id)
        .bind(&recording.name)
        .bind(recording.terminal_cols as i32)
        .bind(recording.terminal_rows as i32)
        .bind(&file_path)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_recording(&id).await
    }

    async fn update_recording(
        &self,
        id: &str,
        update: UpdateRecording,
    ) -> Result<Recording, ProviderError> {
        // Verify recording exists
        let current = self.get_recording(id).await?;

        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let duration_ms = update.duration_ms.unwrap_or(current.duration_ms) as i64;

        sqlx::query(
            r#"
            UPDATE recordings SET
                name = ?, duration_ms = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(duration_ms)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_recording(id).await
    }

    async fn delete_recording(&self, id: &str) -> Result<(), ProviderError> {
        // Get the recording to delete the file
        let recording = self.get_recording(id).await?;

        // Delete the file
        if std::path::Path::new(&recording.file_path).exists() {
            std::fs::remove_file(&recording.file_path).map_err(|e| {
                ProviderError::Database(format!("Failed to delete recording file: {}", e))
            })?;
        }

        let result = sqlx::query("DELETE FROM recordings WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Recording not found: {}",
                id
            )));
        }

        Ok(())
    }

    // === Highlight Rules ===

    async fn list_highlight_rules(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<HighlightRule>, ProviderError> {
        let rows: Vec<HighlightRuleRow> = if let Some(sid) = session_id {
            // List rules for a specific session
            sqlx::query_as(
                "SELECT * FROM highlight_rules WHERE session_id = ? ORDER BY priority, name",
            )
            .bind(sid)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
        } else {
            // List all rules (both global and session-specific)
            sqlx::query_as("SELECT * FROM highlight_rules ORDER BY priority, name")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
        };

        rows.into_iter().map(|r| r.into_highlight_rule()).collect()
    }

    async fn get_highlight_rule(&self, id: &str) -> Result<HighlightRule, ProviderError> {
        let row: HighlightRuleRow = sqlx::query_as("SELECT * FROM highlight_rules WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Highlight rule not found: {}", id)))?;

        row.into_highlight_rule()
    }

    async fn create_highlight_rule(
        &self,
        rule: NewHighlightRule,
    ) -> Result<HighlightRule, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO highlight_rules (
                id, name, pattern, is_regex, case_sensitive, whole_word,
                foreground, background, bold, italic, underline,
                category, priority, enabled, session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&rule.name)
        .bind(&rule.pattern)
        .bind(rule.is_regex as i32)
        .bind(rule.case_sensitive as i32)
        .bind(rule.whole_word as i32)
        .bind(&rule.foreground)
        .bind(&rule.background)
        .bind(rule.bold as i32)
        .bind(rule.italic as i32)
        .bind(rule.underline as i32)
        .bind(&rule.category)
        .bind(rule.priority)
        .bind(rule.enabled as i32)
        .bind(&rule.session_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_highlight_rule(&id).await
    }

    async fn update_highlight_rule(
        &self,
        id: &str,
        update: UpdateHighlightRule,
    ) -> Result<HighlightRule, ProviderError> {
        // Verify rule exists
        let current = self.get_highlight_rule(id).await?;

        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let pattern = update.pattern.unwrap_or(current.pattern);
        let is_regex = update.is_regex.unwrap_or(current.is_regex) as i32;
        let case_sensitive = update.case_sensitive.unwrap_or(current.case_sensitive) as i32;
        let whole_word = update.whole_word.unwrap_or(current.whole_word) as i32;
        let foreground = update.foreground.unwrap_or(current.foreground);
        let background = update.background.unwrap_or(current.background);
        let bold = update.bold.unwrap_or(current.bold) as i32;
        let italic = update.italic.unwrap_or(current.italic) as i32;
        let underline = update.underline.unwrap_or(current.underline) as i32;
        let category = update.category.unwrap_or(current.category);
        let priority = update.priority.unwrap_or(current.priority);
        let enabled = update.enabled.unwrap_or(current.enabled) as i32;
        let session_id = update.session_id.unwrap_or(current.session_id);

        sqlx::query(
            r#"
            UPDATE highlight_rules SET
                name = ?, pattern = ?, is_regex = ?, case_sensitive = ?, whole_word = ?,
                foreground = ?, background = ?, bold = ?, italic = ?, underline = ?,
                category = ?, priority = ?, enabled = ?, session_id = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&pattern)
        .bind(is_regex)
        .bind(case_sensitive)
        .bind(whole_word)
        .bind(&foreground)
        .bind(&background)
        .bind(bold)
        .bind(italic)
        .bind(underline)
        .bind(&category)
        .bind(priority)
        .bind(enabled)
        .bind(&session_id)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_highlight_rule(id).await
    }

    async fn delete_highlight_rule(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("highlight_rules", "id", id, "Highlight rule")
            .await
    }

    async fn get_effective_highlight_rules(
        &self,
        session_id: &str,
    ) -> Result<Vec<HighlightRule>, ProviderError> {
        // Get both global rules (session_id IS NULL) and session-specific rules
        // Session rules override global rules with the same name
        let rows: Vec<HighlightRuleRow> = sqlx::query_as(
            r#"
            SELECT * FROM highlight_rules
            WHERE (session_id IS NULL OR session_id = ?) AND enabled = 1
            ORDER BY priority, name
            "#,
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Convert to HighlightRule and deduplicate by name (session rules take precedence)
        let mut rules: Vec<HighlightRule> = Vec::new();
        let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

        // First pass: add session-specific rules
        for row in &rows {
            if row.session_id.is_some() {
                let rule = HighlightRuleRow {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    pattern: row.pattern.clone(),
                    is_regex: row.is_regex,
                    case_sensitive: row.case_sensitive,
                    whole_word: row.whole_word,
                    foreground: row.foreground.clone(),
                    background: row.background.clone(),
                    bold: row.bold,
                    italic: row.italic,
                    underline: row.underline,
                    category: row.category.clone(),
                    priority: row.priority,
                    enabled: row.enabled,
                    session_id: row.session_id.clone(),
                    created_at: row.created_at.clone(),
                    updated_at: row.updated_at.clone(),
                }
                .into_highlight_rule()?;
                seen_names.insert(rule.name.clone());
                rules.push(rule);
            }
        }

        // Second pass: add global rules that weren't overridden
        for row in rows {
            if row.session_id.is_none() && !seen_names.contains(&row.name) {
                rules.push(row.into_highlight_rule()?);
            }
        }

        // Sort by priority
        rules.sort_by_key(|a| a.priority);

        Ok(rules)
    }

    // === Change Control (Phase 15) ===

    async fn list_changes(&self, session_id: Option<&str>) -> Result<Vec<Change>, ProviderError> {
        let rows: Vec<ChangeRow> = if let Some(sid) = session_id {
            sqlx::query_as("SELECT * FROM changes WHERE session_id = ? ORDER BY created_at DESC")
                .bind(sid)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
        } else {
            sqlx::query_as("SELECT * FROM changes ORDER BY created_at DESC")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
        };

        rows.into_iter().map(|r| r.into_change()).collect()
    }

    async fn get_change(&self, id: &str) -> Result<Change, ProviderError> {
        let row: ChangeRow = sqlx::query_as("SELECT * FROM changes WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Change not found: {}", id)))?;

        row.into_change()
    }

    async fn create_change(&self, change: NewChange) -> Result<Change, ProviderError> {
        // Verify session exists (only if session_id is provided)
        if let Some(ref sid) = change.session_id {
            let _ = self.get_session(sid).await?;
        }

        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let mop_steps_json = serde_json::to_string(&change.mop_steps).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize mop_steps: {}", e))
        })?;
        let device_overrides_json = change
            .device_overrides
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize device_overrides: {}", e))
            })?;
        let tags_json = serde_json::to_string(&change.tags)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize tags: {}", e)))?;
        let session_ids_json = serde_json::to_string(&change.session_ids).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize session_ids: {}", e))
        })?;
        let variables_json = serde_json::to_string(&change.variables).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize variables: {}", e))
        })?;
        let device_variables_json =
            serde_json::to_string(&change.device_variables).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize device_variables: {}", e))
            })?;

        // Empty author → the OS account the agent runs as (NS-FEAT-28).
        let created_by = if change.created_by.trim().is_empty() {
            local_os_user()
        } else {
            change.created_by.clone()
        };
        sqlx::query(
            r#"
            INSERT INTO changes (
                id, session_id, name, description, status, mop_steps,
                device_overrides, document_id, risk_level, change_ticket, tags, session_ids,
                variables, device_variables,
                created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&change.session_id)
        .bind(&change.name)
        .bind(&change.description)
        .bind(&mop_steps_json)
        .bind(&device_overrides_json)
        .bind(&change.document_id)
        .bind(&change.risk_level)
        .bind(&change.change_ticket)
        .bind(&tags_json)
        .bind(&session_ids_json)
        .bind(&variables_json)
        .bind(&device_variables_json)
        .bind(&created_by)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_change(&id).await
    }

    async fn update_change(&self, id: &str, update: UpdateChange) -> Result<Change, ProviderError> {
        // Verify change exists
        let current = self.get_change(id).await?;

        let now = format_datetime(&Utc::now());

        let name = update.name.unwrap_or(current.name);
        let description = update.description.unwrap_or(current.description);
        let status = update.status.unwrap_or(current.status);
        let mop_steps = update.mop_steps.unwrap_or(current.mop_steps);
        let device_overrides = update.device_overrides.unwrap_or(current.device_overrides);
        let pre_snapshot_id = update.pre_snapshot_id.unwrap_or(current.pre_snapshot_id);
        let post_snapshot_id = update.post_snapshot_id.unwrap_or(current.post_snapshot_id);
        let ai_analysis = update.ai_analysis.unwrap_or(current.ai_analysis);
        let document_id = update.document_id.unwrap_or(current.document_id);
        let session_id = update.session_id.unwrap_or(current.session_id);
        let executed_at = update.executed_at.unwrap_or(current.executed_at);
        let completed_at = update.completed_at.unwrap_or(current.completed_at);
        let risk_level = update.risk_level.unwrap_or(current.risk_level);
        let change_ticket = update.change_ticket.unwrap_or(current.change_ticket);
        let tags = update.tags.unwrap_or(current.tags);
        let session_ids = update.session_ids.unwrap_or(current.session_ids);
        let variables = update.variables.unwrap_or(current.variables);
        let device_variables = update.device_variables.unwrap_or(current.device_variables);
        let tags_json = serde_json::to_string(&tags)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize tags: {}", e)))?;
        let session_ids_json = serde_json::to_string(&session_ids).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize session_ids: {}", e))
        })?;
        let variables_json = serde_json::to_string(&variables).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize variables: {}", e))
        })?;
        let device_variables_json = serde_json::to_string(&device_variables).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize device_variables: {}", e))
        })?;

        let mop_steps_json = serde_json::to_string(&mop_steps).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize mop_steps: {}", e))
        })?;
        let device_overrides_json = device_overrides
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize device_overrides: {}", e))
            })?;
        let executed_at_str = executed_at.map(|dt| format_datetime(&dt));
        let completed_at_str = completed_at.map(|dt| format_datetime(&dt));

        sqlx::query(
            r#"
            UPDATE changes SET
                name = ?, description = ?, status = ?, mop_steps = ?,
                device_overrides = ?, document_id = ?, session_id = ?,
                pre_snapshot_id = ?, post_snapshot_id = ?,
                ai_analysis = ?, executed_at = ?, completed_at = ?,
                risk_level = ?, change_ticket = ?, tags = ?, session_ids = ?,
                variables = ?, device_variables = ?,
                updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&description)
        .bind(status.as_str())
        .bind(&mop_steps_json)
        .bind(&device_overrides_json)
        .bind(&document_id)
        .bind(&session_id)
        .bind(&pre_snapshot_id)
        .bind(&post_snapshot_id)
        .bind(&ai_analysis)
        .bind(&executed_at_str)
        .bind(&completed_at_str)
        .bind(&risk_level)
        .bind(&change_ticket)
        .bind(&tags_json)
        .bind(&session_ids_json)
        .bind(&variables_json)
        .bind(&device_variables_json)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_change(id).await
    }

    async fn delete_change(&self, id: &str) -> Result<(), ProviderError> {
        // Get the change to check status
        let change = self.get_change(id).await?;

        // Only allow deletion of draft changes
        if !matches!(change.status, ChangeStatus::Draft) {
            return Err(ProviderError::Validation(
                "Can only delete changes in draft status".to_string(),
            ));
        }

        let result = sqlx::query("DELETE FROM changes WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!("Change not found: {}", id)));
        }

        Ok(())
    }

    // === Snapshots ===

    async fn list_snapshots(&self, change_id: &str) -> Result<Vec<Snapshot>, ProviderError> {
        // Verify change exists
        let _ = self.get_change(change_id).await?;

        let rows: Vec<SnapshotRow> =
            sqlx::query_as("SELECT * FROM snapshots WHERE change_id = ? ORDER BY captured_at")
                .bind(change_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_snapshot()).collect()
    }

    async fn get_snapshot(&self, id: &str) -> Result<Snapshot, ProviderError> {
        let row: SnapshotRow = sqlx::query_as("SELECT * FROM snapshots WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            .ok_or_else(|| ProviderError::NotFound(format!("Snapshot not found: {}", id)))?;

        row.into_snapshot()
    }

    async fn create_snapshot(&self, snapshot: NewSnapshot) -> Result<Snapshot, ProviderError> {
        // Verify whichever owner is set (NS-MOP-1: execution-owned snapshots
        // used to be checked against `changes` and always 404'd).
        match (&snapshot.change_id, &snapshot.execution_id) {
            (None, None) => {
                return Err(ProviderError::Validation(
                    "snapshot requires change_id or execution_id".to_string(),
                ))
            }
            (Some(change_id), _) => {
                let _ = self.get_change(change_id).await?;
            }
            (None, Some(execution_id)) => {
                let _ = self.get_mop_execution(execution_id).await?;
            }
        }

        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let commands_json = serde_json::to_string(&snapshot.commands)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize commands: {}", e)))?;

        sqlx::query(
            r#"
            INSERT INTO snapshots (id, change_id, execution_id, snapshot_type, commands, output, captured_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&snapshot.change_id)
        .bind(&snapshot.execution_id)
        .bind(&snapshot.snapshot_type)
        .bind(&commands_json)
        .bind(&snapshot.output)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_snapshot(&id).await
    }

    async fn delete_snapshot(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("snapshots", "id", id, "Snapshot").await
    }

    // === Session Context (Phase 14) ===

    async fn list_session_context(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionContext>, ProviderError> {
        let rows: Vec<SessionContextRow> = sqlx::query_as(
            "SELECT id, session_id, issue, root_cause, resolution, commands, ticket_ref, author, created_at, updated_at
             FROM session_context
             WHERE session_id = ?
             ORDER BY created_at DESC"
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|row| row.into_session_context())
            .collect()
    }

    async fn get_session_context(&self, id: &str) -> Result<SessionContext, ProviderError> {
        let row: SessionContextRow = sqlx::query_as(
            "SELECT id, session_id, issue, root_cause, resolution, commands, ticket_ref, author, created_at, updated_at
             FROM session_context
             WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("Session context not found: {}", id)))?;

        row.into_session_context()
    }

    async fn create_session_context(
        &self,
        context: NewSessionContext,
    ) -> Result<SessionContext, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            "INSERT INTO session_context (id, session_id, issue, root_cause, resolution, commands, ticket_ref, author, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(&context.session_id)
        .bind(&context.issue)
        .bind(&context.root_cause)
        .bind(&context.resolution)
        .bind(&context.commands)
        .bind(&context.ticket_ref)
        .bind(&context.author)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_session_context(&id).await
    }

    async fn update_session_context(
        &self,
        id: &str,
        update: UpdateSessionContext,
    ) -> Result<SessionContext, ProviderError> {
        // Get existing to verify it exists
        let mut context = self.get_session_context(id).await?;
        context.apply_update(update);
        let now = format_datetime(&Utc::now());

        sqlx::query(
            "UPDATE session_context SET issue = ?, root_cause = ?, resolution = ?, commands = ?, ticket_ref = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&context.issue)
        .bind(&context.root_cause)
        .bind(&context.resolution)
        .bind(&context.commands)
        .bind(&context.ticket_ref)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_session_context(id).await
    }

    async fn delete_session_context(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("session_context", "id", id, "Session context")
            .await
    }

    // === Device Memory ===

    async fn get_or_create_device_memory(
        &self,
        session_id: &str,
    ) -> Result<DeviceMemoryWithEntries, ProviderError> {
        let existing: Option<DeviceMemoryRow> = sqlx::query_as(
            "SELECT id, session_id, role, criticality, standing_instructions, notes, created_at, updated_at FROM device_memory WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let memory = match existing {
            Some(row) => row.into_device_memory()?,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                sqlx::query(
                    "INSERT INTO device_memory (id, session_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
                )
                .bind(&id)
                .bind(session_id)
                .execute(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

                let row: DeviceMemoryRow = sqlx::query_as(
                    "SELECT id, session_id, role, criticality, standing_instructions, notes, created_at, updated_at FROM device_memory WHERE id = ?",
                )
                .bind(&id)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
                row.into_device_memory()?
            }
        };

        let entry_rows: Vec<DeviceMemoryEntryRow> = sqlx::query_as(
            "SELECT id, device_memory_id, date, source, author, content, created_at, updated_at FROM device_memory_entries WHERE device_memory_id = ? ORDER BY date DESC, created_at DESC",
        )
        .bind(&memory.id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let entries: Vec<DeviceMemoryEntry> = entry_rows
            .into_iter()
            .map(|r| r.into_entry())
            .collect::<Result<Vec<_>, _>>()?;

        Ok(DeviceMemoryWithEntries { memory, entries })
    }

    async fn update_device_memory(
        &self,
        id: &str,
        update: UpdateDeviceMemory,
    ) -> Result<DeviceMemory, ProviderError> {
        let current: DeviceMemoryRow = sqlx::query_as(
            "SELECT id, session_id, role, criticality, standing_instructions, notes, created_at, updated_at FROM device_memory WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("Device memory not found: {}", id)))?;

        let role = update.role.unwrap_or(current.role);
        let criticality = update.criticality.unwrap_or(current.criticality);
        let standing_instructions = update
            .standing_instructions
            .unwrap_or(current.standing_instructions);
        let notes = update.notes.unwrap_or(current.notes);

        sqlx::query(
            "UPDATE device_memory SET role = ?, criticality = ?, standing_instructions = ?, notes = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&role)
        .bind(&criticality)
        .bind(&standing_instructions)
        .bind(&notes)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: DeviceMemoryRow = sqlx::query_as(
            "SELECT id, session_id, role, criticality, standing_instructions, notes, created_at, updated_at FROM device_memory WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_device_memory()
    }

    async fn create_device_memory_entry(
        &self,
        device_memory_id: &str,
        entry: NewDeviceMemoryEntry,
    ) -> Result<DeviceMemoryEntry, ProviderError> {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO device_memory_entries (id, device_memory_id, date, source, author, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(&id)
        .bind(device_memory_id)
        .bind(&entry.date)
        .bind(&entry.source)
        .bind(&entry.author)
        .bind(&entry.content)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: DeviceMemoryEntryRow = sqlx::query_as(
            "SELECT id, device_memory_id, date, source, author, content, created_at, updated_at FROM device_memory_entries WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_entry()
    }

    async fn update_device_memory_entry(
        &self,
        id: &str,
        update: UpdateDeviceMemoryEntry,
    ) -> Result<DeviceMemoryEntry, ProviderError> {
        let current: DeviceMemoryEntryRow = sqlx::query_as(
            "SELECT id, device_memory_id, date, source, author, content, created_at, updated_at FROM device_memory_entries WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("Device memory entry not found: {}", id)))?;

        let date = update.date.unwrap_or(current.date);
        let content = update.content.unwrap_or(current.content);

        sqlx::query(
            "UPDATE device_memory_entries SET date = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&date)
        .bind(&content)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let row: DeviceMemoryEntryRow = sqlx::query_as(
            "SELECT id, device_memory_id, date, source, author, content, created_at, updated_at FROM device_memory_entries WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_entry()
    }

    async fn delete_device_memory_entry(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("device_memory_entries", "id", id, "Device memory entry")
            .await
    }

    // === Saved Topologies (Phase 20.1) ===

    async fn list_topologies(&self) -> Result<Vec<SavedTopology>, ProviderError> {
        let rows: Vec<SavedTopologyRow> = sqlx::query_as(
            "SELECT id, name, folder_id, sort_order, shared, created_at, updated_at FROM topologies ORDER BY sort_order, name"
        )
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_saved_topology()).collect()
    }

    async fn get_topology(&self, id: &str) -> Result<Option<SavedTopology>, ProviderError> {
        let row: Option<SavedTopologyRow> = sqlx::query_as(
            "SELECT id, name, folder_id, sort_order, shared, created_at, updated_at FROM topologies WHERE id = ?"
        )
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some(r) => Ok(Some(r.into_saved_topology()?)),
            None => Ok(None),
        }
    }

    async fn create_topology(&self, name: &str) -> Result<SavedTopology, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            "INSERT INTO topologies (id, name, folder_id, sort_order, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)"
        )
        .bind(&id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_topology(&id).await?.ok_or_else(|| {
            ProviderError::Database("Failed to retrieve created topology".to_string())
        })
    }

    async fn update_topology(&self, id: &str, name: &str) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        let result = sqlx::query("UPDATE topologies SET name = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Topology not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn share_topology(&self, id: &str, shared: bool) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        let result = sqlx::query("UPDATE topologies SET shared = ?, updated_at = ? WHERE id = ?")
            .bind(shared as i64)
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Topology not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn delete_topology(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("topologies", "id", id, "Topology").await
    }

    async fn move_topology(
        &self,
        id: &str,
        folder_id: Option<String>,
        sort_order: f64,
    ) -> Result<(), ProviderError> {
        sqlx::query("UPDATE topologies SET folder_id = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(&folder_id)
            .bind(sort_order)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    async fn bulk_delete_topologies(&self, ids: &[String]) -> Result<(i32, i32), ProviderError> {
        if ids.is_empty() {
            return Ok((0, 0));
        }
        // Atomic: single transaction so a mid-batch failure rolls back
        // the whole set instead of leaving the topologies table
        // partially deleted. Matches bulk_delete_sessions semantics.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut deleted: i32 = 0;
        for id in ids {
            let result = sqlx::query("DELETE FROM topologies WHERE id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
            if result.rows_affected() > 0 {
                deleted += 1;
            }
            // Missing ids are no-ops, not failures — bulk delete is
            // idempotent so re-clicking after a partial UI refresh
            // doesn't surface false errors.
        }

        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok((deleted, 0))
    }

    async fn get_topology_devices(
        &self,
        topology_id: &str,
    ) -> Result<Vec<TopologyDevice>, ProviderError> {
        let rows: Vec<TopologyDeviceRow> = sqlx::query_as(
            "SELECT id, topology_id, session_id, x, y, device_type, name, host, created_at, updated_at, platform, version, model, serial, vendor, primary_ip, uptime, status, site, role, notes, profile_id, snmp_profile_id FROM topology_devices WHERE topology_id = ? ORDER BY name"
        )
            .bind(topology_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_topology_device()).collect()
    }

    async fn add_topology_device(
        &self,
        topology_id: &str,
        session: &Session,
    ) -> Result<TopologyDevice, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        // Default position in the center of the canvas
        let x = 500.0;
        let y = 500.0;

        sqlx::query(
            r#"
            INSERT INTO topology_devices (id, topology_id, session_id, profile_id, x, y, device_type, name, host, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#
        )
        .bind(&id)
        .bind(topology_id)
        .bind(&session.id)
        .bind(&session.profile_id)
        .bind(x)
        .bind(y)
        .bind("unknown")
        .bind(&session.name)
        .bind(&session.host)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Update topology timestamp
        sqlx::query("UPDATE topologies SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(topology_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(TopologyDevice {
            id,
            topology_id: topology_id.to_string(),
            session_id: Some(session.id.clone()),
            profile_id: Some(session.profile_id.clone()),
            snmp_profile_id: None,
            x,
            y,
            device_type: "unknown".to_string(),
            name: session.name.clone(),
            host: session.host.clone(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            // Enrichment fields (not set for new devices)
            platform: None,
            version: None,
            model: None,
            serial: None,
            vendor: None,
            primary_ip: None,
            uptime: None,
            status: None,
            site: None,
            role: None,
            notes: None,
        })
    }

    async fn add_discovered_device(
        &self,
        topology_id: &str,
        device: NewDiscoveredDevice<'_>,
    ) -> Result<TopologyDevice, ProviderError> {
        let NewDiscoveredDevice {
            name,
            host,
            device_type,
            x,
            y,
            profile_id,
            snmp_profile_id,
        } = device;
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO topology_devices (id, topology_id, session_id, profile_id, snmp_profile_id, x, y, device_type, name, host, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#
        )
        .bind(&id)
        .bind(topology_id)
        .bind(profile_id)
        .bind(snmp_profile_id)
        .bind(x)
        .bind(y)
        .bind(device_type)
        .bind(name)
        .bind(host)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Update topology timestamp
        sqlx::query("UPDATE topologies SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(topology_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(TopologyDevice {
            id,
            topology_id: topology_id.to_string(),
            session_id: None,
            profile_id: profile_id.map(|s| s.to_string()),
            snmp_profile_id: snmp_profile_id.map(|s| s.to_string()),
            x,
            y,
            device_type: device_type.to_string(),
            name: name.to_string(),
            host: host.to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            platform: None,
            version: None,
            model: None,
            serial: None,
            vendor: None,
            primary_ip: None,
            uptime: None,
            status: None,
            site: None,
            role: None,
            notes: None,
        })
    }

    async fn update_topology_device_position(
        &self,
        device_id: &str,
        x: f64,
        y: f64,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        let result =
            sqlx::query("UPDATE topology_devices SET x = ?, y = ?, updated_at = ? WHERE id = ?")
                .bind(x)
                .bind(y)
                .bind(&now)
                .bind(device_id)
                .execute(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Topology device not found: {}",
                device_id
            )));
        }

        // Update topology timestamp
        sqlx::query(
            "UPDATE topologies SET updated_at = ? WHERE id = (SELECT topology_id FROM topology_devices WHERE id = ?)"
        )
        .bind(&now)
        .bind(device_id)
        .execute(&self.pool)
        .await
        .ok(); // Ignore errors on timestamp update

        Ok(())
    }

    async fn update_topology_device_type(
        &self,
        device_id: &str,
        device_type: &str,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        let result =
            sqlx::query("UPDATE topology_devices SET device_type = ?, updated_at = ? WHERE id = ?")
                .bind(device_type)
                .bind(&now)
                .bind(device_id)
                .execute(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Topology device not found: {}",
                device_id
            )));
        }

        Ok(())
    }

    async fn update_topology_device_details(
        &self,
        device_id: &str,
        details: &crate::models::UpdateTopologyDeviceDetails,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        // Build dynamic UPDATE query based on which fields are set
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now.clone())];

        if details.device_type.is_some() {
            set_clauses.push("device_type = ?");
            params.push(details.device_type.clone());
        }
        if details.platform.is_some() {
            set_clauses.push("platform = ?");
            params.push(details.platform.clone());
        }
        if details.version.is_some() {
            set_clauses.push("version = ?");
            params.push(details.version.clone());
        }
        if details.model.is_some() {
            set_clauses.push("model = ?");
            params.push(details.model.clone());
        }
        if details.serial.is_some() {
            set_clauses.push("serial = ?");
            params.push(details.serial.clone());
        }
        if details.vendor.is_some() {
            set_clauses.push("vendor = ?");
            params.push(details.vendor.clone());
        }
        if details.primary_ip.is_some() {
            set_clauses.push("primary_ip = ?");
            params.push(details.primary_ip.clone());
        }
        if details.uptime.is_some() {
            set_clauses.push("uptime = ?");
            params.push(details.uptime.clone());
        }
        if details.status.is_some() {
            set_clauses.push("status = ?");
            params.push(details.status.clone());
        }
        if details.site.is_some() {
            set_clauses.push("site = ?");
            params.push(details.site.clone());
        }
        if details.role.is_some() {
            set_clauses.push("role = ?");
            params.push(details.role.clone());
        }
        if details.notes.is_some() {
            set_clauses.push("notes = ?");
            params.push(details.notes.clone());
        }
        if details.profile_id.is_some() {
            set_clauses.push("profile_id = ?");
            params.push(details.profile_id.clone());
        }
        if details.snmp_profile_id.is_some() {
            set_clauses.push("snmp_profile_id = ?");
            params.push(details.snmp_profile_id.clone());
        }

        let query = format!(
            "UPDATE topology_devices SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        // Build and execute the query
        let mut q = sqlx::query(&query);
        for param in &params {
            q = q.bind(param);
        }
        q = q.bind(device_id);

        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Topology device not found: {}",
                device_id
            )));
        }

        // Update parent topology timestamp
        sqlx::query(
            "UPDATE topologies SET updated_at = ? WHERE id = (SELECT topology_id FROM topology_devices WHERE id = ?)"
        )
        .bind(&now)
        .bind(device_id)
        .execute(&self.pool)
        .await
        .ok(); // Ignore errors on timestamp update

        Ok(())
    }

    async fn delete_topology_device(&self, device_id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("topology_devices", "id", device_id, "Topology device")
            .await
    }

    async fn get_topology_connections(
        &self,
        topology_id: &str,
    ) -> Result<Vec<TopologyConnection>, ProviderError> {
        let rows: Vec<TopologyConnectionRow> = sqlx::query_as(
            "SELECT * FROM topology_connections WHERE topology_id = ? ORDER BY created_at",
        )
        .bind(topology_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|r| r.into_topology_connection())
            .collect()
    }

    async fn create_topology_connection(
        &self,
        topology_id: &str,
        req: &CreateConnectionRequest,
    ) -> Result<TopologyConnection, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            r#"
            INSERT INTO topology_connections (
                id, topology_id, source_device_id, target_device_id,
                source_interface, target_interface, protocol, label, created_at,
                waypoints, curve_style, bundle_id, bundle_index, color, line_style, line_width, notes
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#
        )
        .bind(&id)
        .bind(topology_id)
        .bind(&req.source_device_id)
        .bind(&req.target_device_id)
        .bind(&req.source_interface)
        .bind(&req.target_interface)
        .bind("manual")
        .bind(&req.label)
        .bind(&now)
        .bind(&req.waypoints)
        .bind(&req.curve_style)
        .bind(&req.bundle_id)
        .bind(req.bundle_index)
        .bind(&req.color)
        .bind(&req.line_style)
        .bind(req.line_width)
        .bind(&req.notes)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Update topology timestamp
        sqlx::query("UPDATE topologies SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(topology_id)
            .execute(&self.pool)
            .await
            .ok(); // Ignore errors on timestamp update

        Ok(TopologyConnection {
            id,
            topology_id: topology_id.to_string(),
            source_device_id: req.source_device_id.clone(),
            target_device_id: req.target_device_id.clone(),
            source_interface: req.source_interface.clone(),
            target_interface: req.target_interface.clone(),
            protocol: "manual".to_string(),
            label: req.label.clone(),
            created_at: Utc::now(),
            // Enhanced routing and styling (Phase 27-02)
            waypoints: req.waypoints.clone(),
            curve_style: req.curve_style.clone(),
            bundle_id: req.bundle_id.clone(),
            bundle_index: req.bundle_index,
            color: req.color.clone(),
            line_style: req.line_style.clone(),
            line_width: req.line_width,
            notes: req.notes.clone(),
        })
    }

    async fn update_topology_connection(
        &self,
        connection_id: &str,
        req: &UpdateConnectionRequest,
    ) -> Result<TopologyConnection, ProviderError> {
        // Fetch existing row, apply Option-Some fields, write full row back.
        // Topology editing is single-user so the read-modify-write race is
        // acceptable; the alternative (dynamic SET clause) is much messier.
        let row: TopologyConnectionRow =
            sqlx::query_as("SELECT * FROM topology_connections WHERE id = ?")
                .bind(connection_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?
                .ok_or_else(|| {
                    ProviderError::NotFound(format!(
                        "Topology connection {} not found",
                        connection_id
                    ))
                })?;

        let mut conn = row.into_topology_connection()?;
        let topology_id = conn.topology_id.clone();

        if let Some(v) = req.source_interface.clone() {
            conn.source_interface = v;
        }
        if let Some(v) = req.target_interface.clone() {
            conn.target_interface = v;
        }
        if let Some(v) = req.label.clone() {
            conn.label = v;
        }
        if let Some(v) = req.waypoints.clone() {
            conn.waypoints = v;
        }
        if let Some(v) = req.curve_style.clone() {
            conn.curve_style = v;
        }
        if let Some(v) = req.bundle_id.clone() {
            conn.bundle_id = v;
        }
        if let Some(v) = req.bundle_index {
            conn.bundle_index = v;
        }
        if let Some(v) = req.color.clone() {
            conn.color = v;
        }
        if let Some(v) = req.line_style.clone() {
            conn.line_style = v;
        }
        if let Some(v) = req.line_width {
            conn.line_width = v;
        }
        if let Some(v) = req.notes.clone() {
            conn.notes = v;
        }

        sqlx::query(
            r#"
            UPDATE topology_connections SET
                source_interface = ?, target_interface = ?, label = ?,
                waypoints = ?, curve_style = ?, bundle_id = ?, bundle_index = ?,
                color = ?, line_style = ?, line_width = ?, notes = ?
            WHERE id = ?
            "#,
        )
        .bind(&conn.source_interface)
        .bind(&conn.target_interface)
        .bind(&conn.label)
        .bind(&conn.waypoints)
        .bind(&conn.curve_style)
        .bind(&conn.bundle_id)
        .bind(conn.bundle_index)
        .bind(&conn.color)
        .bind(&conn.line_style)
        .bind(conn.line_width)
        .bind(&conn.notes)
        .bind(connection_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Bump topology updated_at so the frontend sees a freshness change
        let now = format_datetime(&Utc::now());
        sqlx::query("UPDATE topologies SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&topology_id)
            .execute(&self.pool)
            .await
            .ok();

        Ok(conn)
    }

    async fn delete_topology_connection(&self, connection_id: &str) -> Result<(), ProviderError> {
        self.delete_by_id(
            "topology_connections",
            "id",
            connection_id,
            "Topology connection",
        )
        .await
    }

    // === Layouts (Phase 25) ===
    // Stub implementations - will be fully implemented in 25-02

    async fn list_layouts(&self) -> Result<Vec<Layout>, ProviderError> {
        let rows: Vec<LayoutRow> = sqlx::query_as("SELECT * FROM layouts ORDER BY updated_at DESC")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_layout()).collect()
    }

    async fn get_layout(&self, id: &str) -> Result<Option<Layout>, ProviderError> {
        let row: Option<LayoutRow> = sqlx::query_as("SELECT * FROM layouts WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some(r) => Ok(Some(r.into_layout()?)),
            None => Ok(None),
        }
    }

    async fn create_layout(&self, layout: Layout) -> Result<Layout, ProviderError> {
        let now = format_datetime(&Utc::now());
        let session_ids_json = serde_json::to_string(&layout.session_ids).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize session_ids: {}", e))
        })?;
        let tabs_json = layout
            .tabs
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to serialize tabs: {}", e)))?;
        let sizes_json = layout
            .sizes
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to serialize sizes: {}", e)))?;

        sqlx::query(
            "INSERT INTO layouts (id, name, session_ids, tabs, orientation, sizes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&layout.id)
        .bind(&layout.name)
        .bind(&session_ids_json)
        .bind(&tabs_json)
        .bind(&layout.orientation)
        .bind(&sizes_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_layout(&layout.id)
            .await?
            .ok_or_else(|| ProviderError::Database("Failed to retrieve created layout".to_string()))
    }

    async fn update_layout(&self, layout: Layout) -> Result<Layout, ProviderError> {
        let now = format_datetime(&Utc::now());
        let session_ids_json = serde_json::to_string(&layout.session_ids).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize session_ids: {}", e))
        })?;
        let tabs_json = layout
            .tabs
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to serialize tabs: {}", e)))?;
        let sizes_json = layout
            .sizes
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| ProviderError::Database(format!("Failed to serialize sizes: {}", e)))?;

        let result = sqlx::query(
            "UPDATE layouts SET name = ?, session_ids = ?, tabs = ?, orientation = ?, sizes = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&layout.name)
        .bind(&session_ids_json)
        .bind(&tabs_json)
        .bind(&layout.orientation)
        .bind(&sizes_json)
        .bind(&now)
        .bind(&layout.id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Layout not found: {}",
                layout.id
            )));
        }

        self.get_layout(&layout.id)
            .await?
            .ok_or_else(|| ProviderError::Database("Failed to retrieve updated layout".to_string()))
    }

    async fn delete_layout(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("layouts", "id", id, "Layout").await
    }

    // === Tab Groups (Plan 1: Tab Groups Redesign) ===

    async fn list_groups(&self) -> Result<Vec<Group>, ProviderError> {
        let rows: Vec<(String, String, String, Option<String>, Option<String>, String, String, Option<String>)> =
            sqlx::query_as("SELECT id, name, tabs, topology_id, default_launch_action, created_at, updated_at, last_used_at FROM groups ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(rows.into_iter().map(row_to_group).collect())
    }

    async fn get_group(&self, id: &str) -> Result<Option<Group>, ProviderError> {
        let row: Option<(String, String, String, Option<String>, Option<String>, String, String, Option<String>)> =
            sqlx::query_as("SELECT id, name, tabs, topology_id, default_launch_action, created_at, updated_at, last_used_at FROM groups WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(row.map(row_to_group))
    }

    async fn create_group(&self, group: Group) -> Result<Group, ProviderError> {
        let tabs_json = serde_json::to_string(&group.tabs)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize tabs: {}", e)))?;
        let action = group
            .default_launch_action
            .as_ref()
            .map(|a| serde_json::to_string(a).map(|s| s.trim_matches('"').to_string()))
            .transpose()
            .map_err(|e| ProviderError::Database(format!("serialize launch action: {}", e)))?;

        sqlx::query(
            "INSERT INTO groups (id, name, tabs, topology_id, default_launch_action, created_at, updated_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&group.id)
        .bind(&group.name)
        .bind(&tabs_json)
        .bind(&group.topology_id)
        .bind(&action)
        .bind(&group.created_at)
        .bind(&group.updated_at)
        .bind(&group.last_used_at)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(group)
    }

    async fn update_group(&self, group: Group) -> Result<Group, ProviderError> {
        let tabs_json = serde_json::to_string(&group.tabs)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize tabs: {}", e)))?;
        let action = group
            .default_launch_action
            .as_ref()
            .map(|a| serde_json::to_string(a).map(|s| s.trim_matches('"').to_string()))
            .transpose()
            .map_err(|e| ProviderError::Database(format!("serialize launch action: {}", e)))?;

        sqlx::query(
            "UPDATE groups SET name = ?, tabs = ?, topology_id = ?, default_launch_action = ?, updated_at = ?, last_used_at = ? WHERE id = ?",
        )
        .bind(&group.name)
        .bind(&tabs_json)
        .bind(&group.topology_id)
        .bind(&action)
        .bind(&group.updated_at)
        .bind(&group.last_used_at)
        .bind(&group.id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(group)
    }

    async fn delete_group(&self, id: &str) -> Result<(), ProviderError> {
        sqlx::query("DELETE FROM groups WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(())
    }

    // === API Resources ===

    async fn list_api_resources(&self) -> Result<Vec<ApiResource>, ProviderError> {
        let rows: Vec<ApiResourceRow> = sqlx::query_as(
            "SELECT r.id, r.name, r.base_url, r.auth_type, r.auth_header_name, r.auth_header_prefix, r.auth_flow, r.default_headers, r.custom_headers, r.verify_ssl, r.timeout_secs, r.test_path, r.created_at, r.updated_at, CASE WHEN c.api_resource_id IS NOT NULL THEN 1 ELSE 0 END AS has_credentials FROM api_resources r LEFT JOIN api_resource_credentials c ON r.id = c.api_resource_id ORDER BY r.name ASC"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_api_resource()).collect()
    }

    async fn get_api_resource(&self, id: &str) -> Result<Option<ApiResource>, ProviderError> {
        let row: Option<ApiResourceRow> = sqlx::query_as(
            "SELECT r.id, r.name, r.base_url, r.auth_type, r.auth_header_name, r.auth_header_prefix, r.auth_flow, r.default_headers, r.custom_headers, r.verify_ssl, r.timeout_secs, r.test_path, r.created_at, r.updated_at, CASE WHEN c.api_resource_id IS NOT NULL THEN 1 ELSE 0 END AS has_credentials FROM api_resources r LEFT JOIN api_resource_credentials c ON r.id = c.api_resource_id WHERE r.id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some(r) => Ok(Some(r.into_api_resource()?)),
            None => Ok(None),
        }
    }

    async fn create_api_resource(
        &self,
        req: &CreateApiResourceRequest,
    ) -> Result<ApiResource, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let auth_type_str = req.auth_type.to_string();
        let auth_flow_json = req
            .auth_flow
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize auth_flow: {}", e))
            })?;
        let headers_json = serde_json::to_string(&req.default_headers)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize headers: {}", e)))?;
        let custom_headers_json = serde_json::to_string(&req.custom_headers).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize custom_headers: {}", e))
        })?;

        sqlx::query(
            "INSERT INTO api_resources (id, name, base_url, auth_type, auth_header_name, auth_header_prefix, auth_flow, default_headers, custom_headers, verify_ssl, timeout_secs, test_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(&req.name)
        .bind(&req.base_url)
        .bind(&auth_type_str)
        .bind(&req.auth_header_name)
        .bind(&req.auth_header_prefix)
        .bind(&auth_flow_json)
        .bind(&headers_json)
        .bind(&custom_headers_json)
        .bind(if req.verify_ssl { 1 } else { 0 })
        .bind(req.timeout_secs)
        .bind(&req.test_path)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Store credentials in vault if any are provided
        let cred = StoredApiResourceCredential {
            token: req.auth_token.clone(),
            username: req.auth_username.clone(),
            password: req.auth_password.clone(),
        };
        if cred.token.is_some() || cred.username.is_some() || cred.password.is_some() {
            let encrypted = self.vault_store(&cred)?;
            sqlx::query(
                "INSERT INTO api_resource_credentials (api_resource_id, encrypted_data, created_at, updated_at) VALUES (?, ?, ?, ?)"
            )
            .bind(&id)
            .bind(&encrypted)
            .bind(&now)
            .bind(&now)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        }

        self.get_api_resource(&id).await?.ok_or_else(|| {
            ProviderError::Database("Failed to retrieve created API resource".to_string())
        })
    }

    async fn update_api_resource(
        &self,
        id: &str,
        req: &UpdateApiResourceRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now.clone())];

        if let Some(name) = &req.name {
            set_clauses.push("name = ?");
            params.push(Some(name.clone()));
        }
        if let Some(base_url) = &req.base_url {
            set_clauses.push("base_url = ?");
            params.push(Some(base_url.clone()));
        }
        if let Some(auth_type) = &req.auth_type {
            set_clauses.push("auth_type = ?");
            params.push(Some(auth_type.to_string()));
        }
        if let Some(auth_header_name) = &req.auth_header_name {
            set_clauses.push("auth_header_name = ?");
            params.push(auth_header_name.clone()); // Some(None) clears the column
        }
        if let Some(auth_header_prefix) = &req.auth_header_prefix {
            set_clauses.push("auth_header_prefix = ?");
            params.push(auth_header_prefix.clone()); // Some(None) clears the column
        }
        if let Some(auth_flow) = &req.auth_flow {
            set_clauses.push("auth_flow = ?");
            let json = serde_json::to_string(auth_flow).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize auth_flow: {}", e))
            })?;
            params.push(Some(json));
        }
        if let Some(default_headers) = &req.default_headers {
            set_clauses.push("default_headers = ?");
            let json = serde_json::to_string(default_headers).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize headers: {}", e))
            })?;
            params.push(Some(json));
        }
        if let Some(custom_headers) = &req.custom_headers {
            set_clauses.push("custom_headers = ?");
            let json = serde_json::to_string(custom_headers).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize custom_headers: {}", e))
            })?;
            params.push(Some(json));
        }
        if let Some(verify_ssl) = req.verify_ssl {
            set_clauses.push("verify_ssl = ?");
            params.push(Some(if verify_ssl {
                "1".to_string()
            } else {
                "0".to_string()
            }));
        }
        if let Some(timeout_secs) = req.timeout_secs {
            set_clauses.push("timeout_secs = ?");
            params.push(Some(timeout_secs.to_string()));
        }
        if let Some(test_path) = &req.test_path {
            set_clauses.push("test_path = ?");
            params.push(test_path.clone()); // Some(None) clears the column
        }

        let query = format!(
            "UPDATE api_resources SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        let mut q = sqlx::query(&query);
        for param in &params {
            q = q.bind(param);
        }
        q = q.bind(id);

        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "API resource not found: {}",
                id
            )));
        }

        // Update credentials in vault if any credential fields are provided
        if req.auth_token.is_some() || req.auth_username.is_some() || req.auth_password.is_some() {
            // Fetch existing credentials to merge with updates
            let existing = self
                .get_api_resource_credentials(id)
                .await?
                .unwrap_or_default();
            let updated_cred = StoredApiResourceCredential {
                token: req.auth_token.clone().or(existing.token),
                username: req.auth_username.clone().or(existing.username),
                password: req.auth_password.clone().or(existing.password),
            };
            let encrypted = self.vault_store(&updated_cred)?;
            sqlx::query(
                "INSERT OR REPLACE INTO api_resource_credentials (api_resource_id, encrypted_data, created_at, updated_at) VALUES (?, ?, ?, ?)"
            )
            .bind(id)
            .bind(&encrypted)
            .bind(&now)
            .bind(&now)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        }

        Ok(())
    }

    async fn delete_api_resource(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("api_resources", "id", id, "API resource")
            .await
    }

    async fn get_api_resource_credentials(
        &self,
        id: &str,
    ) -> Result<Option<StoredApiResourceCredential>, ProviderError> {
        let row: Option<(Vec<u8>,)> = sqlx::query_as(
            "SELECT encrypted_data FROM api_resource_credentials WHERE api_resource_id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some((encrypted,)) => Ok(Some(self.vault_get(&encrypted)?)),
            None => Ok(None),
        }
    }

    // === Quick Actions ===

    async fn list_quick_actions(&self) -> Result<Vec<QuickAction>, ProviderError> {
        let rows: Vec<QuickActionRow> =
            sqlx::query_as("SELECT * FROM quick_actions ORDER BY sort_order ASC, name ASC")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_quick_action()).collect()
    }

    async fn get_quick_action(&self, id: &str) -> Result<Option<QuickAction>, ProviderError> {
        let row: Option<QuickActionRow> =
            sqlx::query_as("SELECT * FROM quick_actions WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some(r) => Ok(Some(r.into_quick_action()?)),
            None => Ok(None),
        }
    }

    async fn create_quick_action(
        &self,
        req: &CreateQuickActionRequest,
    ) -> Result<QuickAction, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let headers_json = serde_json::to_string(&req.headers)
            .map_err(|e| ProviderError::Database(format!("Failed to serialize headers: {}", e)))?;

        sqlx::query(
            "INSERT INTO quick_actions (id, name, description, api_resource_id, method, path, headers, body, json_extract_path, icon, color, sort_order, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(&req.name)
        .bind(&req.description)
        .bind(&req.api_resource_id)
        .bind(&req.method)
        .bind(&req.path)
        .bind(&headers_json)
        .bind(&req.body)
        .bind(&req.json_extract_path)
        .bind(&req.icon)
        .bind(&req.color)
        .bind(req.sort_order)
        .bind(&req.category)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_quick_action(&id).await?.ok_or_else(|| {
            ProviderError::Database("Failed to retrieve created quick action".to_string())
        })
    }

    async fn update_quick_action(
        &self,
        id: &str,
        req: &UpdateQuickActionRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now)];

        if let Some(name) = &req.name {
            set_clauses.push("name = ?");
            params.push(Some(name.clone()));
        }
        if let Some(description) = &req.description {
            set_clauses.push("description = ?");
            params.push(description.clone()); // Some(None) clears the column
        }
        if let Some(api_resource_id) = &req.api_resource_id {
            set_clauses.push("api_resource_id = ?");
            params.push(Some(api_resource_id.clone()));
        }
        if let Some(method) = &req.method {
            set_clauses.push("method = ?");
            params.push(Some(method.clone()));
        }
        if let Some(path) = &req.path {
            set_clauses.push("path = ?");
            params.push(Some(path.clone()));
        }
        if let Some(headers) = &req.headers {
            set_clauses.push("headers = ?");
            let json = serde_json::to_string(headers).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize headers: {}", e))
            })?;
            params.push(Some(json));
        }
        if let Some(body) = &req.body {
            set_clauses.push("body = ?");
            params.push(body.clone()); // Some(None) clears the column
        }
        if let Some(json_extract_path) = &req.json_extract_path {
            set_clauses.push("json_extract_path = ?");
            params.push(json_extract_path.clone()); // Some(None) clears the column
        }
        if let Some(icon) = &req.icon {
            set_clauses.push("icon = ?");
            params.push(icon.clone()); // Some(None) clears the column
        }
        if let Some(color) = &req.color {
            set_clauses.push("color = ?");
            params.push(color.clone()); // Some(None) clears the column
        }
        if let Some(sort_order) = req.sort_order {
            set_clauses.push("sort_order = ?");
            params.push(Some(sort_order.to_string()));
        }
        if let Some(category) = &req.category {
            set_clauses.push("category = ?");
            params.push(category.clone()); // Some(None) clears the column
        }

        let query = format!(
            "UPDATE quick_actions SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        let mut q = sqlx::query(&query);
        for param in &params {
            q = q.bind(param);
        }
        q = q.bind(id);

        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Quick action not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn delete_quick_action(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("quick_actions", "id", id, "Quick action")
            .await
    }

    // === Quick Prompts ===

    async fn list_quick_prompts(&self) -> Result<Vec<QuickPrompt>, ProviderError> {
        let rows: Vec<QuickPromptRow> =
            sqlx::query_as("SELECT * FROM quick_prompts ORDER BY is_favorite DESC, name ASC")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_quick_prompt()).collect()
    }

    async fn get_quick_prompt(&self, id: &str) -> Result<Option<QuickPrompt>, ProviderError> {
        let row: Option<QuickPromptRow> =
            sqlx::query_as("SELECT * FROM quick_prompts WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some(r) => Ok(Some(r.into_quick_prompt()?)),
            None => Ok(None),
        }
    }

    async fn create_quick_prompt(
        &self,
        req: &CreateQuickPromptRequest,
    ) -> Result<QuickPrompt, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());

        sqlx::query(
            "INSERT INTO quick_prompts (id, name, prompt, is_favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(&req.name)
        .bind(&req.prompt)
        .bind(if req.is_favorite { 1 } else { 0 })
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_quick_prompt(&id)
            .await?
            .ok_or_else(|| ProviderError::Database("Failed to retrieve created prompt".to_string()))
    }

    async fn update_quick_prompt(
        &self,
        id: &str,
        req: &UpdateQuickPromptRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        // Build dynamic UPDATE query
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now)];

        if let Some(name) = &req.name {
            set_clauses.push("name = ?");
            params.push(Some(name.clone()));
        }
        if let Some(prompt) = &req.prompt {
            set_clauses.push("prompt = ?");
            params.push(Some(prompt.clone()));
        }
        if let Some(is_favorite) = req.is_favorite {
            set_clauses.push("is_favorite = ?");
            params.push(Some(if is_favorite {
                "1".to_string()
            } else {
                "0".to_string()
            }));
        }

        let query = format!(
            "UPDATE quick_prompts SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        let mut q = sqlx::query(&query);
        for param in &params {
            q = q.bind(param);
        }
        q = q.bind(id);

        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Quick prompt not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn delete_quick_prompt(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("quick_prompts", "id", id, "Quick prompt")
            .await
    }

    // === Agent Definitions ===

    async fn list_agent_definitions(&self) -> Result<Vec<AgentDefinition>, ProviderError> {
        let rows: Vec<AgentDefinitionRow> =
            sqlx::query_as("SELECT * FROM agent_definitions ORDER BY enabled DESC, name ASC")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter()
            .map(|r| r.into_agent_definition())
            .collect()
    }

    async fn get_agent_definition(
        &self,
        id: &str,
    ) -> Result<Option<AgentDefinition>, ProviderError> {
        let row: Option<AgentDefinitionRow> =
            sqlx::query_as("SELECT * FROM agent_definitions WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;

        match row {
            Some(r) => Ok(Some(r.into_agent_definition()?)),
            None => Ok(None),
        }
    }

    async fn create_agent_definition(
        &self,
        req: &CreateAgentDefinitionRequest,
    ) -> Result<AgentDefinition, ProviderError> {
        // Reject duplicate names with a typed Conflict (-> HTTP 409) instead of
        // surfacing the raw UNIQUE-constraint failure as an opaque 500.
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM agent_definitions WHERE name = ?1")
                .bind(&req.name)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ProviderError::Database(e.to_string()))?;
        if existing.is_some() {
            return Err(ProviderError::Conflict(format!(
                "An agent definition named '{}' already exists",
                req.name
            )));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = format_datetime(&chrono::Utc::now());

        sqlx::query(
            "INSERT INTO agent_definitions (id, name, description, system_prompt, provider, model, temperature, max_iterations, max_tokens, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
        )
        .bind(&id)
        .bind(&req.name)
        .bind(&req.description)
        .bind(&req.system_prompt)
        .bind(&req.provider)
        .bind(&req.model)
        .bind(req.temperature)
        .bind(req.max_iterations)
        .bind(req.max_tokens)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        self.get_agent_definition(&id).await?.ok_or_else(|| {
            ProviderError::Database("Failed to retrieve created agent definition".to_string())
        })
    }

    async fn update_agent_definition(
        &self,
        id: &str,
        req: &UpdateAgentDefinitionRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&chrono::Utc::now());

        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<Option<String>> = vec![Some(now)];

        if let Some(name) = &req.name {
            set_clauses.push("name = ?");
            params.push(Some(name.clone()));
        }
        if let Some(description) = &req.description {
            set_clauses.push("description = ?");
            params.push(Some(description.clone()));
        }
        if let Some(system_prompt) = &req.system_prompt {
            set_clauses.push("system_prompt = ?");
            params.push(Some(system_prompt.clone()));
        }
        if let Some(provider) = &req.provider {
            set_clauses.push("provider = ?");
            params.push(Some(provider.clone()));
        }
        if let Some(model) = &req.model {
            set_clauses.push("model = ?");
            params.push(Some(model.clone()));
        }
        if let Some(temperature) = req.temperature {
            set_clauses.push("temperature = ?");
            params.push(Some(temperature.to_string()));
        }
        if let Some(max_iterations) = req.max_iterations {
            set_clauses.push("max_iterations = ?");
            params.push(Some(max_iterations.to_string()));
        }
        if let Some(max_tokens) = req.max_tokens {
            set_clauses.push("max_tokens = ?");
            params.push(Some(max_tokens.to_string()));
        }
        if let Some(enabled) = req.enabled {
            set_clauses.push("enabled = ?");
            params.push(Some(if enabled {
                "1".to_string()
            } else {
                "0".to_string()
            }));
        }

        let query = format!(
            "UPDATE agent_definitions SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        let mut q = sqlx::query(&query);
        for param in &params {
            q = q.bind(param);
        }
        q = q.bind(id);

        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Agent definition not found: {}",
                id
            )));
        }

        Ok(())
    }

    async fn delete_agent_definition(&self, id: &str) -> Result<(), ProviderError> {
        // Null out FK references in agent_tasks before deleting
        sqlx::query(
            "UPDATE agent_tasks SET agent_definition_id = NULL WHERE agent_definition_id = ?",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let result = sqlx::query("DELETE FROM agent_definitions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Agent definition not found: {}",
                id
            )));
        }

        Ok(())
    }

    // === Topology Annotations (Phase 27-03) ===

    async fn get_topology_annotations(
        &self,
        topology_id: &str,
    ) -> Result<Vec<TopologyAnnotation>, ProviderError> {
        let rows: Vec<AnnotationRow> = sqlx::query_as(
            "SELECT * FROM topology_annotations WHERE topology_id = ? ORDER BY z_index ASC",
        )
        .bind(topology_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        rows.into_iter().map(|r| r.into_annotation()).collect()
    }

    async fn create_topology_annotation(
        &self,
        topology_id: &str,
        req: &crate::models::CreateAnnotationRequest,
    ) -> Result<TopologyAnnotation, ProviderError> {
        let id = Uuid::new_v4().to_string();
        let now = format_datetime(&Utc::now());
        let annotation_type = req.annotation_type.as_str();
        let element_data = serde_json::to_string(&req.element_data).map_err(|e| {
            ProviderError::Database(format!("Failed to serialize element_data: {}", e))
        })?;

        sqlx::query(
            "INSERT INTO topology_annotations (id, topology_id, annotation_type, element_data, z_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(topology_id)
        .bind(annotation_type)
        .bind(&element_data)
        .bind(req.z_index)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        // Update topology timestamp
        sqlx::query("UPDATE topologies SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(topology_id)
            .execute(&self.pool)
            .await
            .ok(); // Ignore errors on timestamp update

        // Fetch and return the created annotation
        let row: AnnotationRow = sqlx::query_as("SELECT * FROM topology_annotations WHERE id = ?")
            .bind(&id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        row.into_annotation()
    }

    async fn update_topology_annotation(
        &self,
        annotation_id: &str,
        req: &crate::models::UpdateAnnotationRequest,
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        // Build dynamic UPDATE query
        let mut set_clauses = vec!["updated_at = ?"];
        let mut params: Vec<String> = vec![now.clone()];

        if let Some(element_data) = &req.element_data {
            // Merge the patch over the stored blob instead of replacing it.
            // Callers send partial updates (`{position}` on drag, `{size}` on
            // resize, `{content}` on retype); replacing the whole JSON dropped
            // every other key and left shapes without a `size` (NS-FEAT-1).
            let merged = match sqlx::query_scalar::<_, String>(
                "SELECT element_data FROM topology_annotations WHERE id = ?",
            )
            .bind(annotation_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?
            {
                Some(existing) => merge_annotation_element_data(&existing, element_data),
                None => element_data.clone(),
            };
            set_clauses.push("element_data = ?");
            let json_str = serde_json::to_string(&merged).map_err(|e| {
                ProviderError::Database(format!("Failed to serialize element_data: {}", e))
            })?;
            params.push(json_str);
        }
        if let Some(z_index) = req.z_index {
            set_clauses.push("z_index = ?");
            params.push(z_index.to_string());
        }

        let query = format!(
            "UPDATE topology_annotations SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        let mut q = sqlx::query(&query);
        for param in &params {
            q = q.bind(param);
        }
        q = q.bind(annotation_id);

        let result = q
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(ProviderError::NotFound(format!(
                "Annotation not found: {}",
                annotation_id
            )));
        }

        Ok(())
    }

    async fn delete_topology_annotation(&self, annotation_id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("topology_annotations", "id", annotation_id, "Annotation")
            .await
    }

    async fn reorder_topology_annotations(
        &self,
        topology_id: &str,
        id_order: &[String],
    ) -> Result<(), ProviderError> {
        let now = format_datetime(&Utc::now());

        // Update z_index for each annotation in order
        for (z_index, id) in id_order.iter().enumerate() {
            sqlx::query(
                "UPDATE topology_annotations SET z_index = ?, updated_at = ? WHERE id = ? AND topology_id = ?"
            )
            .bind(z_index as i32)
            .bind(&now)
            .bind(id)
            .bind(topology_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        }

        // Update topology timestamp
        sqlx::query("UPDATE topologies SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(topology_id)
            .execute(&self.pool)
            .await
            .ok(); // Ignore errors on timestamp update

        Ok(())
    }

    // === MOP Templates (Phase 30) ===

    async fn list_mop_templates(&self) -> Result<Vec<MopTemplate>, ProviderError> {
        let rows = sqlx::query(
            "SELECT id, name, description, mop_steps, created_by, created_at, updated_at
             FROM mop_templates ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut templates = Vec::new();
        for row in rows {
            let steps_json: String = row.get("mop_steps");
            let id: String = row.get("id");
            let mop_steps = parse_mop_steps_lenient(&steps_json, &format!("mop_template {}", id));

            templates.push(MopTemplate {
                id: row.get("id"),
                name: row.get("name"),
                description: row.get("description"),
                mop_steps,
                created_by: row.get("created_by"),
                created_at: parse_datetime(row.get("created_at"))?,
                updated_at: parse_datetime(row.get("updated_at"))?,
            });
        }
        Ok(templates)
    }

    async fn get_mop_template(&self, id: &str) -> Result<MopTemplate, ProviderError> {
        let row = sqlx::query(
            "SELECT id, name, description, mop_steps, created_by, created_at, updated_at
             FROM mop_templates WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("MOP template not found: {}", id)))?;

        let steps_json: String = row.get("mop_steps");
        let mop_steps = parse_mop_steps_lenient(&steps_json, &format!("mop_template {}", id));

        Ok(MopTemplate {
            id: row.get("id"),
            name: row.get("name"),
            description: row.get("description"),
            mop_steps,
            created_by: row.get("created_by"),
            created_at: parse_datetime(row.get("created_at"))?,
            updated_at: parse_datetime(row.get("updated_at"))?,
        })
    }

    async fn create_mop_template(
        &self,
        data: NewMopTemplate,
    ) -> Result<MopTemplate, ProviderError> {
        let template = MopTemplate::new(data);
        let now = format_datetime(&template.created_at);
        let steps_json = serde_json::to_string(&template.mop_steps)
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        sqlx::query(
            "INSERT INTO mop_templates (id, name, description, mop_steps, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&template.id)
        .bind(&template.name)
        .bind(&template.description)
        .bind(&steps_json)
        .bind(&template.created_by)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(template)
    }

    async fn update_mop_template(
        &self,
        id: &str,
        update: UpdateMopTemplate,
    ) -> Result<MopTemplate, ProviderError> {
        let mut template = self.get_mop_template(id).await?;
        template.apply_update(update);

        let now = format_datetime(&template.updated_at);
        let steps_json = serde_json::to_string(&template.mop_steps)
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        sqlx::query(
            "UPDATE mop_templates SET name = ?, description = ?, mop_steps = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&template.name)
        .bind(&template.description)
        .bind(&steps_json)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(template)
    }

    async fn delete_mop_template(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("mop_templates", "id", id, "MOP template")
            .await
    }

    // === MOP Executions (Phase 30) ===

    async fn list_mop_executions(&self) -> Result<Vec<MopExecution>, ProviderError> {
        let rows = sqlx::query(
            "SELECT id, template_id, plan_id, plan_revision, name, description, execution_strategy, control_mode,
                    status, current_phase, ai_analysis, ai_analysis_meta, ai_autonomy_level, on_failure,
                    pause_after_pre_checks, pause_after_changes, pause_after_post_checks,
                    created_by, created_at, updated_at,
                    started_at, completed_at, last_checkpoint
             FROM mop_executions ORDER BY created_at DESC"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut executions = Vec::new();
        for row in rows {
            let strategy_str: String = row.get("execution_strategy");
            let mode_str: String = row.get("control_mode");
            let status_str: String = row.get("status");

            let started_at = match row.get::<Option<String>, _>("started_at") {
                Some(s) => Some(parse_datetime(&s)?),
                None => None,
            };
            let completed_at = match row.get::<Option<String>, _>("completed_at") {
                Some(s) => Some(parse_datetime(&s)?),
                None => None,
            };

            executions.push(MopExecution {
                id: row.get("id"),
                template_id: row.get("template_id"),
                plan_id: row.get("plan_id"),
                plan_revision: row.get::<Option<i64>, _>("plan_revision").unwrap_or(1),
                name: row.get("name"),
                description: row.get("description"),
                execution_strategy: strategy_str.parse().unwrap_or_default(),
                control_mode: mode_str.parse().unwrap_or_default(),
                status: status_str.parse().unwrap_or_default(),
                current_phase: row.get("current_phase"),
                ai_analysis: row.get("ai_analysis"),
                ai_analysis_meta: parse_json_column(
                    row.get::<Option<String>, _>("ai_analysis_meta").as_deref(),
                    "mop_execution ai_analysis_meta",
                ),
                ai_autonomy_level: row.get::<Option<i32>, _>("ai_autonomy_level"),
                on_failure: row
                    .get::<Option<String>, _>("on_failure")
                    .unwrap_or_else(|| "pause".to_string()),
                pause_after_pre_checks: row.get::<i32, _>("pause_after_pre_checks") != 0,
                pause_after_changes: row.get::<i32, _>("pause_after_changes") != 0,
                pause_after_post_checks: row.get::<i32, _>("pause_after_post_checks") != 0,
                created_by: row.get("created_by"),
                created_at: parse_datetime(row.get("created_at"))?,
                updated_at: parse_datetime(row.get("updated_at"))?,
                started_at,
                completed_at,
                last_checkpoint: row.get("last_checkpoint"),
            });
        }
        Ok(executions)
    }

    async fn get_mop_execution(&self, id: &str) -> Result<MopExecution, ProviderError> {
        let row = sqlx::query(
            "SELECT id, template_id, plan_id, plan_revision, name, description, execution_strategy, control_mode,
                    status, current_phase, ai_analysis, ai_analysis_meta, ai_autonomy_level, on_failure,
                    pause_after_pre_checks, pause_after_changes, pause_after_post_checks,
                    created_by, created_at, updated_at,
                    started_at, completed_at, last_checkpoint
             FROM mop_executions WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("MOP execution not found: {}", id)))?;

        let strategy_str: String = row.get("execution_strategy");
        let mode_str: String = row.get("control_mode");
        let status_str: String = row.get("status");

        let started_at = match row.get::<Option<String>, _>("started_at") {
            Some(s) => Some(parse_datetime(&s)?),
            None => None,
        };
        let completed_at = match row.get::<Option<String>, _>("completed_at") {
            Some(s) => Some(parse_datetime(&s)?),
            None => None,
        };

        Ok(MopExecution {
            id: row.get("id"),
            template_id: row.get("template_id"),
            plan_id: row.get("plan_id"),
            plan_revision: row.get::<Option<i64>, _>("plan_revision").unwrap_or(1),
            name: row.get("name"),
            description: row.get("description"),
            execution_strategy: strategy_str.parse().unwrap_or_default(),
            control_mode: mode_str.parse().unwrap_or_default(),
            status: status_str.parse().unwrap_or_default(),
            current_phase: row.get("current_phase"),
            ai_analysis: row.get("ai_analysis"),
            ai_analysis_meta: parse_json_column(
                row.get::<Option<String>, _>("ai_analysis_meta").as_deref(),
                "mop_execution ai_analysis_meta",
            ),
            ai_autonomy_level: row.get::<Option<i32>, _>("ai_autonomy_level"),
            on_failure: row
                .get::<Option<String>, _>("on_failure")
                .unwrap_or_else(|| "pause".to_string()),
            pause_after_pre_checks: row.get::<i32, _>("pause_after_pre_checks") != 0,
            pause_after_changes: row.get::<i32, _>("pause_after_changes") != 0,
            pause_after_post_checks: row.get::<i32, _>("pause_after_post_checks") != 0,
            created_by: row.get("created_by"),
            created_at: parse_datetime(row.get("created_at"))?,
            updated_at: parse_datetime(row.get("updated_at"))?,
            started_at,
            completed_at,
            last_checkpoint: row.get("last_checkpoint"),
        })
    }

    async fn create_mop_execution(
        &self,
        data: NewMopExecution,
    ) -> Result<MopExecution, ProviderError> {
        // Unknown template / plan must be a 404, not a foreign-key 500 or a
        // dangling reference (`plan_id` is a plain TEXT column → `changes.id`).
        if let Some(ref template_id) = data.template_id {
            let _ = self.get_mop_template(template_id).await?;
        }
        if let Some(ref plan_id) = data.plan_id {
            let _ = self.get_change(plan_id).await?;
        }
        let execution = MopExecution::new(data);
        let now = format_datetime(&execution.created_at);

        sqlx::query(
            "INSERT INTO mop_executions (id, template_id, plan_id, name, description, execution_strategy,
                                         control_mode, status, current_phase, ai_analysis, ai_autonomy_level,
                                         on_failure, pause_after_pre_checks, pause_after_changes,
                                         pause_after_post_checks,
                                         created_by, created_at, updated_at, started_at,
                                         completed_at, last_checkpoint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&execution.id)
        .bind(&execution.template_id)
        .bind(&execution.plan_id) // plain TEXT column (no FK) — lets executions trace back to their plan
        .bind(&execution.name)
        .bind(&execution.description)
        .bind(execution.execution_strategy.to_string())
        .bind(execution.control_mode.to_string())
        .bind(execution.status.to_string())
        .bind(&execution.current_phase)
        .bind(&execution.ai_analysis)
        .bind(execution.ai_autonomy_level)
        .bind(&execution.on_failure)
        .bind(if execution.pause_after_pre_checks { 1 } else { 0 })
        .bind(if execution.pause_after_changes { 1 } else { 0 })
        .bind(if execution.pause_after_post_checks { 1 } else { 0 })
        .bind(&execution.created_by)
        .bind(&now)
        .bind(&now)
        .bind::<Option<String>>(None)
        .bind::<Option<String>>(None)
        .bind(&execution.last_checkpoint)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(execution)
    }

    async fn update_mop_execution(
        &self,
        id: &str,
        update: UpdateMopExecution,
    ) -> Result<MopExecution, ProviderError> {
        let mut execution = self.get_mop_execution(id).await?;
        execution.apply_update(update);

        let now = format_datetime(&execution.updated_at);
        let started_at = execution.started_at.map(|dt| format_datetime(&dt));
        let completed_at = execution.completed_at.map(|dt| format_datetime(&dt));
        let ai_analysis_meta = execution
            .ai_analysis_meta
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize ai_analysis_meta: {}", e))
            })?;

        sqlx::query(
            "UPDATE mop_executions SET
                name = ?, description = ?, execution_strategy = ?, control_mode = ?,
                status = ?, current_phase = ?, ai_analysis = ?, ai_analysis_meta = ?, ai_autonomy_level = ?,
                on_failure = ?,
                pause_after_pre_checks = ?, pause_after_changes = ?, pause_after_post_checks = ?,
                updated_at = ?,
                started_at = ?, completed_at = ?, last_checkpoint = ?
             WHERE id = ?"
        )
        .bind(&execution.name)
        .bind(&execution.description)
        .bind(execution.execution_strategy.to_string())
        .bind(execution.control_mode.to_string())
        .bind(execution.status.to_string())
        .bind(&execution.current_phase)
        .bind(&execution.ai_analysis)
        .bind(&ai_analysis_meta)
        .bind(execution.ai_autonomy_level)
        .bind(&execution.on_failure)
        .bind(if execution.pause_after_pre_checks { 1 } else { 0 })
        .bind(if execution.pause_after_changes { 1 } else { 0 })
        .bind(if execution.pause_after_post_checks { 1 } else { 0 })
        .bind(&now)
        .bind(&started_at)
        .bind(&completed_at)
        .bind(&execution.last_checkpoint)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(execution)
    }

    async fn delete_mop_execution(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("mop_executions", "id", id, "MOP execution")
            .await
    }

    // === MOP Execution Devices (Phase 30) ===

    async fn list_mop_execution_devices(
        &self,
        execution_id: &str,
    ) -> Result<Vec<MopExecutionDevice>, ProviderError> {
        let rows = sqlx::query(
            "SELECT id, execution_id, session_id, device_id, credential_id, device_name, device_host, role,
                    cli_flavor, variables, device_order, status, current_step_id,
                    pre_snapshot_id, post_snapshot_id, ai_analysis, started_at, completed_at, error_message
             FROM mop_execution_devices WHERE execution_id = ? ORDER BY device_order"
        )
        .bind(execution_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut devices = Vec::new();
        for row in rows {
            let status_str: String = row.get("status");

            let started_at = match row.get::<Option<String>, _>("started_at") {
                Some(s) => Some(parse_datetime(&s)?),
                None => None,
            };
            let completed_at = match row.get::<Option<String>, _>("completed_at") {
                Some(s) => Some(parse_datetime(&s)?),
                None => None,
            };

            let session_id: Option<String> = row.get("session_id");
            let device_id: Option<String> = row.get("device_id");
            let fallback_name = device_id
                .clone()
                .or_else(|| session_id.clone())
                .unwrap_or_else(|| "unknown".to_string());
            let device_name: String = row
                .get::<Option<String>, _>("device_name")
                .unwrap_or_else(|| fallback_name.clone());
            let device_host: String = row
                .get::<Option<String>, _>("device_host")
                .unwrap_or(fallback_name);
            devices.push(MopExecutionDevice {
                id: row.get("id"),
                execution_id: row.get("execution_id"),
                session_id,
                device_id,
                credential_id: row.get("credential_id"),
                device_name,
                device_host,
                role: row.get("role"),
                cli_flavor: row.get("cli_flavor"),
                variables: parse_device_variables(
                    row.get::<Option<String>, _>("variables").as_deref(),
                ),
                device_order: row.get("device_order"),
                status: status_str.parse().unwrap_or_default(),
                current_step_id: row.get("current_step_id"),
                pre_snapshot_id: row.get("pre_snapshot_id"),
                post_snapshot_id: row.get("post_snapshot_id"),
                ai_analysis: row.get("ai_analysis"),
                started_at,
                completed_at,
                error_message: row.get("error_message"),
            });
        }
        Ok(devices)
    }

    async fn get_mop_execution_device(
        &self,
        id: &str,
    ) -> Result<MopExecutionDevice, ProviderError> {
        let row = sqlx::query(
            "SELECT id, execution_id, session_id, device_id, credential_id, device_name, device_host, role,
                    cli_flavor, variables, device_order, status, current_step_id,
                    pre_snapshot_id, post_snapshot_id, ai_analysis, started_at, completed_at, error_message
             FROM mop_execution_devices WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("MOP execution device not found: {}", id)))?;

        let status_str: String = row.get("status");

        let started_at = match row.get::<Option<String>, _>("started_at") {
            Some(s) => Some(parse_datetime(&s)?),
            None => None,
        };
        let completed_at = match row.get::<Option<String>, _>("completed_at") {
            Some(s) => Some(parse_datetime(&s)?),
            None => None,
        };

        let session_id: Option<String> = row.get("session_id");
        let device_id: Option<String> = row.get("device_id");
        let fallback_name = device_id
            .clone()
            .or_else(|| session_id.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let device_name: String = row
            .get::<Option<String>, _>("device_name")
            .unwrap_or_else(|| fallback_name.clone());
        let device_host: String = row
            .get::<Option<String>, _>("device_host")
            .unwrap_or(fallback_name);
        Ok(MopExecutionDevice {
            id: row.get("id"),
            execution_id: row.get("execution_id"),
            session_id,
            device_id,
            credential_id: row.get("credential_id"),
            device_name,
            device_host,
            role: row.get("role"),
            cli_flavor: row.get("cli_flavor"),
            variables: parse_device_variables(row.get::<Option<String>, _>("variables").as_deref()),
            device_order: row.get("device_order"),
            status: status_str.parse().unwrap_or_default(),
            current_step_id: row.get("current_step_id"),
            pre_snapshot_id: row.get("pre_snapshot_id"),
            post_snapshot_id: row.get("post_snapshot_id"),
            ai_analysis: row.get("ai_analysis"),
            started_at,
            completed_at,
            error_message: row.get("error_message"),
        })
    }

    async fn create_mop_execution_device(
        &self,
        mut data: NewMopExecutionDevice,
    ) -> Result<MopExecutionDevice, ProviderError> {
        // Referential errors as 404/409 instead of a foreign-key / UNIQUE 500.
        let _ = self.get_mop_execution(&data.execution_id).await?;
        if let Some(ref session_id) = data.session_id {
            let session = self.get_session(session_id).await?;
            let duplicate: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM mop_execution_devices WHERE execution_id = ? AND session_id = ?",
            )
            .bind(&data.execution_id)
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
            if duplicate.is_some() {
                return Err(ProviderError::Conflict(format!(
                    "Session {} is already part of execution {}",
                    session_id, data.execution_id
                )));
            }
            // Resolve display name / host / CLI flavor from the session so a
            // device never shows (or is analysed as) a bare UUID.
            if data
                .device_name
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                data.device_name = Some(session.name.clone());
            }
            if data
                .device_host
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                data.device_host = Some(session.host.clone());
            }
            if data
                .cli_flavor
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                data.cli_flavor = Some(session.cli_flavor.as_str().to_string());
            }
        }
        let device = MopExecutionDevice::new(data);
        let variables_json = device
            .variables
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize variables: {}", e))
            })?;

        sqlx::query(
            "INSERT INTO mop_execution_devices (id, execution_id, session_id, device_id, credential_id,
                                                device_name, device_host, role, cli_flavor, variables, device_order, status,
                                                current_step_id, pre_snapshot_id, post_snapshot_id,
                                                ai_analysis, started_at, completed_at, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&device.id)
        .bind(&device.execution_id)
        .bind(&device.session_id)
        .bind(&device.device_id)
        .bind(&device.credential_id)
        .bind(&device.device_name)
        .bind(&device.device_host)
        .bind(&device.role)
        .bind(&device.cli_flavor)
        .bind(&variables_json)
        .bind(device.device_order)
        .bind(device.status.to_string())
        .bind(&device.current_step_id)
        .bind(&device.pre_snapshot_id)
        .bind(&device.post_snapshot_id)
        .bind(&device.ai_analysis)
        .bind::<Option<String>>(None)
        .bind::<Option<String>>(None)
        .bind(&device.error_message)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(device)
    }

    async fn update_mop_execution_device(
        &self,
        id: &str,
        update: UpdateMopExecutionDevice,
    ) -> Result<MopExecutionDevice, ProviderError> {
        let mut device = self.get_mop_execution_device(id).await?;
        device.apply_update(update);

        let started_at = device.started_at.map(|dt| format_datetime(&dt));
        let completed_at = device.completed_at.map(|dt| format_datetime(&dt));

        sqlx::query(
            "UPDATE mop_execution_devices SET
                device_order = ?, device_name = ?, device_host = ?, cli_flavor = ?,
                status = ?, current_step_id = ?, pre_snapshot_id = ?,
                post_snapshot_id = ?, ai_analysis = ?, started_at = ?, completed_at = ?, error_message = ?
             WHERE id = ?"
        )
        .bind(device.device_order)
        .bind(&device.device_name)
        .bind(&device.device_host)
        .bind(&device.cli_flavor)
        .bind(device.status.to_string())
        .bind(&device.current_step_id)
        .bind(&device.pre_snapshot_id)
        .bind(&device.post_snapshot_id)
        .bind(&device.ai_analysis)
        .bind(&started_at)
        .bind(&completed_at)
        .bind(&device.error_message)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(device)
    }

    async fn _delete_mop_execution_device(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("mop_execution_devices", "id", id, "MOP execution device")
            .await
    }

    // === MOP Execution Steps (Phase 30) ===

    async fn list_mop_execution_steps(
        &self,
        execution_device_id: &str,
    ) -> Result<Vec<MopExecutionStep>, ProviderError> {
        let rows = sqlx::query(
            "SELECT id, execution_device_id, step_order, step_type, command, description,
                    expected_output, mock_enabled, mock_output, status, output, ai_feedback,
                    started_at, completed_at, duration_ms,
                    execution_source, quick_action_id, quick_action_variables,
                    script_id, script_args, paired_step_id, output_format,
                    assertion_results, error_message
             FROM mop_execution_steps WHERE execution_device_id = ? ORDER BY step_order",
        )
        .bind(execution_device_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut steps = Vec::new();
        for row in rows {
            let step_type_str: String = row.get("step_type");
            let status_str: String = row.get("status");
            let mock_enabled: i32 = row.get("mock_enabled");

            let started_at = match row.get::<Option<String>, _>("started_at") {
                Some(s) => Some(parse_datetime(&s)?),
                None => None,
            };
            let completed_at = match row.get::<Option<String>, _>("completed_at") {
                Some(s) => Some(parse_datetime(&s)?),
                None => None,
            };

            let quick_action_variables: Option<serde_json::Value> = row
                .get::<Option<String>, _>("quick_action_variables")
                .and_then(|s| serde_json::from_str(&s).ok());
            let script_args: Option<serde_json::Value> = row
                .get::<Option<String>, _>("script_args")
                .and_then(|s| serde_json::from_str(&s).ok());

            steps.push(MopExecutionStep {
                id: row.get("id"),
                execution_device_id: row.get("execution_device_id"),
                step_order: row.get("step_order"),
                step_type: step_type_str.parse().unwrap_or(MopStepType::Change),
                command: row.get("command"),
                description: row.get("description"),
                expected_output: row.get("expected_output"),
                mock_enabled: mock_enabled != 0,
                mock_output: row.get("mock_output"),
                status: status_str.parse().unwrap_or_default(),
                output: row.get("output"),
                ai_feedback: row.get("ai_feedback"),
                started_at,
                completed_at,
                duration_ms: row.get("duration_ms"),
                execution_source: row
                    .get::<Option<String>, _>("execution_source")
                    .unwrap_or_else(|| "cli".to_string()),
                quick_action_id: row.get("quick_action_id"),
                quick_action_variables,
                script_id: row.get("script_id"),
                script_args,
                paired_step_id: row.get("paired_step_id"),
                output_format: row.get("output_format"),
                assertion_results: row
                    .get::<Option<String>, _>("assertion_results")
                    .and_then(|s| serde_json::from_str(&s).ok()),
                error_message: row.get("error_message"),
            });
        }
        Ok(steps)
    }

    async fn get_mop_execution_step(&self, id: &str) -> Result<MopExecutionStep, ProviderError> {
        let row = sqlx::query(
            "SELECT id, execution_device_id, step_order, step_type, command, description,
                    expected_output, mock_enabled, mock_output, status, output, ai_feedback,
                    started_at, completed_at, duration_ms,
                    execution_source, quick_action_id, quick_action_variables,
                    script_id, script_args, paired_step_id, output_format,
                    assertion_results, error_message
             FROM mop_execution_steps WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?
        .ok_or_else(|| ProviderError::NotFound(format!("MOP execution step not found: {}", id)))?;

        let step_type_str: String = row.get("step_type");
        let status_str: String = row.get("status");
        let mock_enabled: i32 = row.get("mock_enabled");

        let started_at = match row.get::<Option<String>, _>("started_at") {
            Some(s) => Some(parse_datetime(&s)?),
            None => None,
        };
        let completed_at = match row.get::<Option<String>, _>("completed_at") {
            Some(s) => Some(parse_datetime(&s)?),
            None => None,
        };

        // Parse JSON columns
        let quick_action_variables: Option<serde_json::Value> = row
            .get::<Option<String>, _>("quick_action_variables")
            .and_then(|s| serde_json::from_str(&s).ok());
        let script_args: Option<serde_json::Value> = row
            .get::<Option<String>, _>("script_args")
            .and_then(|s| serde_json::from_str(&s).ok());

        Ok(MopExecutionStep {
            id: row.get("id"),
            execution_device_id: row.get("execution_device_id"),
            step_order: row.get("step_order"),
            step_type: step_type_str.parse().unwrap_or(MopStepType::Change),
            command: row.get("command"),
            description: row.get("description"),
            expected_output: row.get("expected_output"),
            mock_enabled: mock_enabled != 0,
            mock_output: row.get("mock_output"),
            status: status_str.parse().unwrap_or_default(),
            output: row.get("output"),
            ai_feedback: row.get("ai_feedback"),
            started_at,
            completed_at,
            duration_ms: row.get("duration_ms"),
            execution_source: row
                .get::<Option<String>, _>("execution_source")
                .unwrap_or_else(|| "cli".to_string()),
            quick_action_id: row.get("quick_action_id"),
            quick_action_variables,
            script_id: row.get("script_id"),
            script_args,
            paired_step_id: row.get("paired_step_id"),
            output_format: row.get("output_format"),
            assertion_results: row
                .get::<Option<String>, _>("assertion_results")
                .and_then(|s| serde_json::from_str(&s).ok()),
            error_message: row.get("error_message"),
        })
    }

    async fn _create_mop_execution_step(
        &self,
        data: NewMopExecutionStep,
    ) -> Result<MopExecutionStep, ProviderError> {
        let step = MopExecutionStep::new(data);

        let qa_vars_json = step.quick_action_variables.as_ref().map(|v| v.to_string());
        let script_args_json = step.script_args.as_ref().map(|v| v.to_string());

        sqlx::query(
            "INSERT INTO mop_execution_steps (id, execution_device_id, step_order, step_type, command,
                                              description, expected_output, mock_enabled, mock_output,
                                              status, output, ai_feedback, started_at, completed_at, duration_ms,
                                              execution_source, quick_action_id, quick_action_variables,
                                              script_id, script_args, paired_step_id, output_format,
                                              assertion_results, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&step.id)
        .bind(&step.execution_device_id)
        .bind(step.step_order)
        .bind(step.step_type.to_string())
        .bind(&step.command)
        .bind(&step.description)
        .bind(&step.expected_output)
        .bind(if step.mock_enabled { 1 } else { 0 })
        .bind(&step.mock_output)
        .bind(step.status.to_string())
        .bind(&step.output)
        .bind(&step.ai_feedback)
        .bind::<Option<String>>(None)
        .bind::<Option<String>>(None)
        .bind(step.duration_ms)
        .bind(&step.execution_source)
        .bind(&step.quick_action_id)
        .bind(&qa_vars_json)
        .bind(&step.script_id)
        .bind(&script_args_json)
        .bind(&step.paired_step_id)
        .bind(&step.output_format)
        .bind::<Option<String>>(None)
        .bind(&step.error_message)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(step)
    }

    async fn update_mop_execution_step(
        &self,
        id: &str,
        update: UpdateMopExecutionStep,
    ) -> Result<MopExecutionStep, ProviderError> {
        let mut step = self.get_mop_execution_step(id).await?;
        step.apply_update(update);

        let started_at = step.started_at.map(|dt| format_datetime(&dt));
        let completed_at = step.completed_at.map(|dt| format_datetime(&dt));

        let qa_vars_json = step.quick_action_variables.as_ref().map(|v| v.to_string());
        let script_args_json = step.script_args.as_ref().map(|v| v.to_string());
        let assertion_results_json = step
            .assertion_results
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| {
                ProviderError::Database(format!("Failed to serialize assertion_results: {}", e))
            })?;

        sqlx::query(
            "UPDATE mop_execution_steps SET
                step_order = ?, step_type = ?, command = ?, description = ?, expected_output = ?,
                mock_enabled = ?, mock_output = ?, status = ?, output = ?, ai_feedback = ?,
                started_at = ?, completed_at = ?, duration_ms = ?,
                execution_source = ?, quick_action_id = ?, quick_action_variables = ?,
                script_id = ?, script_args = ?, paired_step_id = ?, output_format = ?,
                assertion_results = ?, error_message = ?
             WHERE id = ?",
        )
        .bind(step.step_order)
        .bind(step.step_type.to_string())
        .bind(&step.command)
        .bind(&step.description)
        .bind(&step.expected_output)
        .bind(if step.mock_enabled { 1 } else { 0 })
        .bind(&step.mock_output)
        .bind(step.status.to_string())
        .bind(&step.output)
        .bind(&step.ai_feedback)
        .bind(&started_at)
        .bind(&completed_at)
        .bind(step.duration_ms)
        .bind(&step.execution_source)
        .bind(&step.quick_action_id)
        .bind(&qa_vars_json)
        .bind(&step.script_id)
        .bind(&script_args_json)
        .bind(&step.paired_step_id)
        .bind(&step.output_format)
        .bind(&assertion_results_json)
        .bind(&step.error_message)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| ProviderError::Database(e.to_string()))?;

        Ok(step)
    }

    async fn _delete_mop_execution_step(&self, id: &str) -> Result<(), ProviderError> {
        self.delete_by_id("mop_execution_steps", "id", id, "MOP execution step")
            .await
    }

    async fn bulk_create_mop_execution_steps(
        &self,
        steps_data: Vec<NewMopExecutionStep>,
    ) -> Result<Vec<MopExecutionStep>, ProviderError> {
        if steps_data.is_empty() {
            return Ok(Vec::new());
        }
        // Unknown device → 404 (not a foreign-key 500); blank command → 400.
        let mut checked_devices: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for data in &steps_data {
            if data.command.trim().is_empty() {
                return Err(ProviderError::Validation(
                    "step command must be non-empty".to_string(),
                ));
            }
            if checked_devices.insert(data.execution_device_id.as_str()) {
                let _ = self
                    .get_mop_execution_device(&data.execution_device_id)
                    .await?;
            }
        }

        // Atomic: insert all-or-nothing in a single transaction. The old
        // implementation called create_mop_execution_step in a loop with
        // independent connections, so a failure on step 5 of 10 left the
        // first 4 committed and the MOP execution permanently incomplete.
        // We inline the INSERT here against the tx connection instead of
        // refactoring the trait method to take &mut Transaction.
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

        let mut steps = Vec::with_capacity(steps_data.len());
        for data in steps_data {
            let step = MopExecutionStep::new(data);
            let qa_vars_json = step.quick_action_variables.as_ref().map(|v| v.to_string());
            let script_args_json = step.script_args.as_ref().map(|v| v.to_string());

            sqlx::query(
                "INSERT INTO mop_execution_steps (id, execution_device_id, step_order, step_type, command,
                                                  description, expected_output, mock_enabled, mock_output,
                                                  status, output, ai_feedback, started_at, completed_at, duration_ms,
                                                  execution_source, quick_action_id, quick_action_variables,
                                                  script_id, script_args, paired_step_id, output_format,
                                                  assertion_results, error_message)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&step.id)
            .bind(&step.execution_device_id)
            .bind(step.step_order)
            .bind(step.step_type.to_string())
            .bind(&step.command)
            .bind(&step.description)
            .bind(&step.expected_output)
            .bind(if step.mock_enabled { 1 } else { 0 })
            .bind(&step.mock_output)
            .bind(step.status.to_string())
            .bind(&step.output)
            .bind(&step.ai_feedback)
            .bind::<Option<String>>(None)
            .bind::<Option<String>>(None)
            .bind(step.duration_ms)
            .bind(&step.execution_source)
            .bind(&step.quick_action_id)
            .bind(&qa_vars_json)
            .bind(&step.script_id)
            .bind(&script_args_json)
            .bind(&step.paired_step_id)
            .bind(&step.output_format)
            .bind::<Option<String>>(None)
            .bind(&step.error_message)
            .execute(&mut *tx)
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;

            steps.push(step);
        }

        tx.commit()
            .await
            .map_err(|e| ProviderError::Database(e.to_string()))?;
        Ok(steps)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::init_db;
    use tempfile::tempdir;

    pub(crate) async fn setup_provider() -> LocalDataProvider {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_db(&db_path).await.unwrap();

        // Keep the tempdir alive by leaking it (for test purposes)
        std::mem::forget(dir);

        LocalDataProvider::new(pool)
    }

    #[tokio::test]
    async fn clips_retention_keeps_pinned_and_caps_unpinned() {
        let provider = setup_provider().await;
        let new = |text: &str, pinned: bool| NewClip {
            text: text.to_string(),
            provenance: serde_json::json!({"source": "app-copy"}),
            line_ending: "lf".to_string(),
            pinned,
            retain_max: Some(2),
            retain_hours: Some(24),
        };
        let keep = provider
            .create_clip(new("pinned one\n", true), false)
            .await
            .unwrap();
        assert_eq!(keep.lines, 1);
        assert_eq!(keep.bytes, 11);
        provider.create_clip(new("a", false), false).await.unwrap();
        provider.create_clip(new("b", false), false).await.unwrap();
        // Third unpinned insert evicts the oldest unpinned ("a"); the pinned row survives.
        let c = provider
            .create_clip(new("c\r\nd", false), true)
            .await
            .unwrap();
        assert_eq!(c.lines, 2);
        assert!(c.redacted);
        let clips = provider.list_clips(50).await.unwrap();
        let texts: Vec<&str> = clips.iter().map(|c| c.text.as_str()).collect();
        assert!(texts.contains(&"pinned one\n"));
        assert!(!texts.contains(&"a"));
        assert!(texts.contains(&"b") && texts.contains(&"c\r\nd"));
        assert_eq!(clips.len(), 3);

        // Pin toggling, deletion, and clearing unpinned rows.
        provider
            .update_clip(&c.id, UpdateClip { pinned: Some(true) })
            .await
            .unwrap();
        assert_eq!(provider.clear_unpinned_clips().await.unwrap(), 1);
        let remaining = provider.list_clips(50).await.unwrap();
        assert_eq!(remaining.len(), 2);
        provider.delete_clip(&c.id).await.unwrap();
        assert!(matches!(
            provider.delete_clip(&c.id).await,
            Err(ProviderError::NotFound(_))
        ));
        assert_eq!(clip_line_count(""), 0);
        assert_eq!(clip_line_count("x\ny\n"), 2);
    }

    #[tokio::test]
    async fn test_master_password_setup_caches_vault_matching_unlock() {
        let provider = setup_provider().await;

        // Too-short passwords are still rejected before any KDF work.
        assert!(matches!(
            provider.set_master_password("short").await,
            Err(ProviderError::Validation(_))
        ));
        assert!(!provider.has_master_password().await.unwrap());

        provider
            .set_master_password("secret-password-123")
            .await
            .unwrap();
        assert!(provider.has_master_password().await.unwrap());
        assert!(provider.is_unlocked());

        // A second setup is refused and leaves the vault as it was.
        assert!(matches!(
            provider.set_master_password("other-password-456").await,
            Err(ProviderError::Validation(_))
        ));

        // Written with the vault cached by setup...
        provider
            .store_api_key("ai.anthropic", "sk-setup-cached")
            .await
            .unwrap();

        // ...readable with the vault a fresh unlock derives.
        provider.lock();
        assert!(matches!(
            provider.unlock("wrong-password-xyz").await,
            Err(ProviderError::InvalidPassword)
        ));
        assert!(!provider.is_unlocked());
        provider.unlock("secret-password-123").await.unwrap();
        assert_eq!(
            provider.get_api_key("ai.anthropic").await.unwrap().as_deref(),
            Some("sk-setup-cached")
        );

        // Wrong password for a confirmed wipe is rejected; nothing is wiped.
        assert!(matches!(
            provider.wipe_vault("wrong-password-xyz").await,
            Err(ProviderError::InvalidPassword)
        ));
        assert!(provider.has_master_password().await.unwrap());
        provider.wipe_vault("secret-password-123").await.unwrap();
        assert!(!provider.has_master_password().await.unwrap());
        assert!(!provider.is_unlocked());
    }

    #[tokio::test]
    async fn test_unlock_failures_engage_cooldown_and_success_resets() {
        let provider = setup_provider().await;
        provider
            .set_master_password("secret-password-123")
            .await
            .unwrap();
        provider.lock();

        for _ in 0..MAX_FAILS_BEFORE_COOLDOWN {
            assert!(matches!(
                provider.unlock("wrong-password-xyz").await,
                Err(ProviderError::InvalidPassword)
            ));
        }
        {
            let mut attempts = provider.unlock_attempts.lock();
            assert_eq!(attempts.failures, MAX_FAILS_BEFORE_COOLDOWN);
            assert!(attempts.next_allowed_at_epoch > Utc::now().timestamp());
            // Clear only the deadline so the test doesn't sleep
            // COOLDOWN_SECS; the failure count stays in place.
            attempts.next_allowed_at_epoch = 0;
        }

        provider.unlock("secret-password-123").await.unwrap();
        assert!(provider.is_unlocked());
        let attempts = provider.unlock_attempts.lock();
        assert_eq!(attempts.failures, 0);
        assert_eq!(attempts.next_allowed_at_epoch, 0);
    }

    #[tokio::test]
    async fn test_change_master_password_survives_relock() {
        let provider = setup_provider().await;
        provider
            .set_master_password("secret-password-123")
            .await
            .unwrap();
        provider
            .store_api_key("ai.anthropic", "sk-rotated")
            .await
            .unwrap();

        // Wrong old password is rejected and the vault keeps working.
        assert!(matches!(
            provider
                .change_master_password("wrong-password-xyz", "another-password-456")
                .await,
            Err(ProviderError::InvalidPassword)
        ));

        provider
            .change_master_password("secret-password-123", "another-password-456")
            .await
            .unwrap();
        assert_eq!(
            provider.get_api_key("ai.anthropic").await.unwrap().as_deref(),
            Some("sk-rotated")
        );

        // The rotated data must still decrypt after a lock/unlock cycle,
        // i.e. the verification record and the data share one salt.
        provider.lock();
        assert!(matches!(
            provider.unlock("secret-password-123").await,
            Err(ProviderError::InvalidPassword)
        ));
        provider.unlock("another-password-456").await.unwrap();
        assert_eq!(
            provider.get_api_key("ai.anthropic").await.unwrap().as_deref(),
            Some("sk-rotated")
        );
    }

    #[tokio::test]
    async fn test_reset_vault_wipes_secrets_keeps_db() {
        let provider = setup_provider().await;
        provider
            .set_master_password("secret-password-123")
            .await
            .unwrap();

        // A secret in a dedicated secret table.
        provider
            .store_api_key("ai.anthropic", "sk-secret-xyz")
            .await
            .unwrap();
        assert!(provider.has_api_key("ai.anthropic").await.unwrap());

        // A non-secret row that must survive the reset.
        let keep = provider
            .create_mapped_key(NewMappedKey {
                key_combo: "Ctrl+K".to_string(),
                command: "show version".to_string(),
                description: Some("keep me".to_string()),
                is_secret: false,
            })
            .await
            .unwrap();

        assert!(provider.has_master_password().await.unwrap());

        // Forgot-password reset — no password supplied.
        provider.reset_vault().await.unwrap();

        // Master-password marker gone and vault locked.
        assert!(!provider.has_master_password().await.unwrap());
        assert!(!provider.is_unlocked());

        // Secret row was deleted.
        assert!(!provider.has_api_key("ai.anthropic").await.unwrap());

        // Non-secret row survived with its command intact.
        let listed = provider.list_mapped_keys().await.unwrap();
        let row = listed
            .iter()
            .find(|k| k.id == keep.id)
            .expect("non-secret row should survive vault reset");
        assert_eq!(row.command, "show version");

        // A fresh master password can be set after the reset.
        provider
            .set_master_password("new-password-456")
            .await
            .unwrap();
        assert!(provider.has_master_password().await.unwrap());
    }

    #[tokio::test]
    async fn test_secret_mapped_key() {
        let provider = setup_provider().await;
        provider
            .set_master_password("secret-password-123")
            .await
            .unwrap();

        // Create a secret mapped key
        let created = provider
            .create_mapped_key(NewMappedKey {
                key_combo: "Ctrl+E".to_string(),
                command: "enable\nsupersecret".to_string(),
                description: Some("enable seq".to_string()),
                is_secret: true,
            })
            .await
            .unwrap();
        assert!(created.is_secret);
        // list/create must never return the plaintext of a secret key
        assert_eq!(created.command, "");

        // list masks it too
        let listed = provider.list_mapped_keys().await.unwrap();
        let row = listed.iter().find(|k| k.id == created.id).unwrap();
        assert!(row.is_secret);
        assert_eq!(row.command, "");

        // reveal decrypts the real value
        let revealed = provider.reveal_mapped_key(&created.id).await.unwrap();
        assert_eq!(revealed, "enable\nsupersecret");

        // toggle secret -> plaintext: command becomes visible in list
        let updated = provider
            .update_mapped_key(
                &created.id,
                UpdateMappedKey {
                    key_combo: None,
                    command: None,
                    description: None,
                    is_secret: Some(false),
                },
            )
            .await
            .unwrap();
        assert!(!updated.is_secret);
        assert_eq!(updated.command, "enable\nsupersecret");

        // toggle back plaintext -> secret with a new command
        let re = provider
            .update_mapped_key(
                &created.id,
                UpdateMappedKey {
                    key_combo: None,
                    command: Some("conf t\npassword hunter2".to_string()),
                    description: None,
                    is_secret: Some(true),
                },
            )
            .await
            .unwrap();
        assert!(re.is_secret);
        assert_eq!(re.command, "");
        assert_eq!(
            provider.reveal_mapped_key(&created.id).await.unwrap(),
            "conf t\npassword hunter2"
        );

        // rotating the master password keeps the secret decryptable
        provider
            .change_master_password("secret-password-123", "another-password-456")
            .await
            .unwrap();
        assert_eq!(
            provider.reveal_mapped_key(&created.id).await.unwrap(),
            "conf t\npassword hunter2"
        );
    }

    #[tokio::test]
    async fn test_session_crud() {
        let provider = setup_provider().await;

        // Create a profile first (required for sessions)
        let new_profile = NewCredentialProfile {
            name: "Test Profile".to_string(),
            username: "admin".to_string(),
            auth_type: AuthType::Password,
            key_path: None,
            port: 22,
            keepalive_interval: 30,
            connection_timeout: 30,
            terminal_theme: None,
            default_font_size: None,
            default_font_family: None,
            scrollback_lines: 10000,
            local_echo: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            cli_flavor: CliFlavor::Auto,
            auto_commands: vec![],
            jump_host_id: None,
            jump_session_id: None,
        };
        let profile = provider.create_profile(new_profile).await.unwrap();

        // Create session using the profile
        let new_session = NewSession {
            name: "Test Server".to_string(),
            folder_id: None,
            host: "192.168.1.100".to_string(),
            port: 22,
            color: Some("#ff0000".to_string()),
            profile_id: profile.id.clone(),
            netbox_device_id: None,
            netbox_source_id: None,
            cli_flavor: CliFlavor::Auto,
            terminal_theme: None,
            font_family: None,
            font_size_override: None,
            jump_host_id: None,
            jump_session_id: None,
            port_forwards: vec![],
            auto_commands: vec![],
            legacy_ssh: false,
            protocol: Protocol::Ssh,
            sftp_start_path: None,
            console_host: None,
            console_port: None,
            console_protocol: Protocol::Ssh,
            console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        };

        let created = provider.create_session(new_session).await.unwrap();
        assert_eq!(created.name, "Test Server");
        assert_eq!(created.host, "192.168.1.100");
        assert_eq!(created.port, 22);
        assert_eq!(created.profile_id, profile.id);
        assert_eq!(created.color, Some("#ff0000".to_string()));

        // Read
        let fetched = provider.get_session(&created.id).await.unwrap();
        assert_eq!(fetched.name, "Test Server");

        // List
        let sessions = provider.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);

        // Update
        let update = UpdateSession {
            name: Some("Updated Server".to_string()),
            host: Some("10.0.0.1".to_string()),
            ..Default::default()
        };
        let updated = provider.update_session(&created.id, update).await.unwrap();
        assert_eq!(updated.name, "Updated Server");
        assert_eq!(updated.host, "10.0.0.1");

        // An update touching ONLY profile_id must persist (NS-SESS-16: the
        // old has_update gate ignored it and returned the unchanged row).
        let other_profile = provider
            .create_profile(NewCredentialProfile {
                name: "Other Profile".to_string(),
                username: "ops".to_string(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 30,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 10000,
                local_echo: false,
                auto_reconnect: true,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::Auto,
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let updated = provider
            .update_session(
                &created.id,
                UpdateSession {
                    profile_id: Some(other_profile.id.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.profile_id, other_profile.id);
        assert_eq!(
            provider.get_session(&created.id).await.unwrap().profile_id,
            other_profile.id
        );
        // Same for a protocol-only update.
        let updated = provider
            .update_session(
                &created.id,
                UpdateSession {
                    protocol: Some(Protocol::Telnet),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.protocol, Protocol::Telnet);

        // Touch
        provider.touch_session(&created.id).await.unwrap();
        let touched = provider.get_session(&created.id).await.unwrap();
        assert!(touched.last_connected_at.is_some());

        // Delete
        provider.delete_session(&created.id).await.unwrap();
        let result = provider.get_session(&created.id).await;
        assert!(matches!(result, Err(ProviderError::NotFound(_))));
    }

    #[tokio::test]
    async fn test_credential_vault() {
        let provider = setup_provider().await;

        // Initially no master password
        assert!(!provider.has_master_password().await.unwrap());
        assert!(!provider.is_unlocked());

        // Set master password
        provider
            .set_master_password("secret-password-123")
            .await
            .unwrap();
        assert!(provider.has_master_password().await.unwrap());
        assert!(provider.is_unlocked()); // Automatically unlocked after setting

        // Create a profile first (required for sessions)
        let new_profile = NewCredentialProfile {
            name: "Test Profile".to_string(),
            username: "admin".to_string(),
            auth_type: AuthType::Password,
            key_path: None,
            port: 22,
            keepalive_interval: 30,
            connection_timeout: 30,
            terminal_theme: None,
            default_font_size: None,
            default_font_family: None,
            scrollback_lines: 10000,
            local_echo: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            cli_flavor: CliFlavor::Auto,
            auto_commands: vec![],
            jump_host_id: None,
            jump_session_id: None,
        };
        let profile = provider.create_profile(new_profile).await.unwrap();

        // Create a session for the credential
        let new_session = NewSession {
            name: "Test Server".to_string(),
            folder_id: None,
            host: "192.168.1.100".to_string(),
            port: 22,
            color: None,
            profile_id: profile.id,
            netbox_device_id: None,
            netbox_source_id: None,
            cli_flavor: CliFlavor::Auto,
            terminal_theme: None,
            font_family: None,
            font_size_override: None,
            jump_host_id: None,
            jump_session_id: None,
            port_forwards: vec![],
            auto_commands: vec![],
            legacy_ssh: false,
            protocol: Protocol::Ssh,
            sftp_start_path: None,
            console_host: None,
            console_port: None,
            console_protocol: Protocol::Ssh,
            console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        };
        let session = provider.create_session(new_session).await.unwrap();

        // Store credential
        let new_cred = NewCredential {
            password: Some("serverpass".to_string()),
            key_passphrase: None,
        };
        provider
            .store_credential(&session.id, new_cred)
            .await
            .unwrap();

        // Get credential
        let cred = provider
            ._get_credential(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cred.password, Some("serverpass".to_string()));
        assert_eq!(cred.key_passphrase, None);

        // Lock
        provider.lock();
        assert!(!provider.is_unlocked());

        // Should fail when locked
        let result = provider._get_credential(&session.id).await;
        assert!(matches!(result, Err(ProviderError::VaultLocked)));

        // Unlock with wrong password should fail
        let result = provider.unlock("wrongpassword").await;
        assert!(matches!(result, Err(ProviderError::InvalidPassword)));

        // Unlock with correct password
        provider.unlock("secret-password-123").await.unwrap();
        assert!(provider.is_unlocked());

        // Should be able to get credential again
        let cred = provider
            ._get_credential(&session.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cred.password, Some("serverpass".to_string()));
    }

    #[tokio::test]
    async fn test_group_crud() {
        let provider = setup_provider().await;

        // CREATE
        let group = Group {
            id: "test-group-1".to_string(),
            name: "Site-12 Outage".to_string(),
            tabs: vec![GroupTab {
                r#type: "terminal".to_string(),
                session_id: Some("sess-1".to_string()),
                topology_id: None,
                document_id: None,
                document_name: None,
            }],
            topology_id: None,
            default_launch_action: None,
            created_at: "2026-04-22T12:00:00Z".to_string(),
            updated_at: "2026-04-22T12:00:00Z".to_string(),
            last_used_at: None,
        };
        let created = provider.create_group(group.clone()).await.expect("create");
        assert_eq!(created.id, "test-group-1");
        assert_eq!(created.name, "Site-12 Outage");
        assert_eq!(created.tabs.len(), 1);
        assert_eq!(created.tabs[0].r#type, "terminal");
        assert_eq!(created.tabs[0].session_id, Some("sess-1".to_string()));

        // LIST
        let listed = provider.list_groups().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "test-group-1");
        assert_eq!(listed[0].name, "Site-12 Outage");

        // GET
        let fetched = provider
            .get_group("test-group-1")
            .await
            .expect("get")
            .expect("present");
        assert_eq!(fetched.id, "test-group-1");
        assert_eq!(fetched.name, "Site-12 Outage");
        assert_eq!(fetched.tabs.len(), 1);

        // UPDATE
        let mut updated = fetched;
        updated.name = "Renamed Group".to_string();
        updated.updated_at = "2026-04-22T13:00:00Z".to_string();
        updated.tabs.push(GroupTab {
            r#type: "topology".to_string(),
            session_id: None,
            topology_id: Some("topo-1".to_string()),
            document_id: None,
            document_name: None,
        });
        provider.update_group(updated).await.expect("update");

        let after_update = provider
            .get_group("test-group-1")
            .await
            .expect("get2")
            .expect("present2");
        assert_eq!(after_update.name, "Renamed Group");
        assert_eq!(after_update.tabs.len(), 2);
        assert_eq!(after_update.tabs[1].r#type, "topology");
        assert_eq!(after_update.tabs[1].topology_id, Some("topo-1".to_string()));

        // DELETE
        provider.delete_group("test-group-1").await.expect("delete");
        let after_delete = provider.get_group("test-group-1").await.expect("get3");
        assert!(after_delete.is_none());

        // Verify list is empty
        let final_list = provider.list_groups().await.expect("final list");
        assert_eq!(final_list.len(), 0);
    }

    #[tokio::test]
    async fn create_profile_persists_jump_host_id_none_by_default() {
        let p = setup_provider().await;
        let np = NewCredentialProfile {
            name: "p1".into(),
            username: "admin".into(),
            auth_type: AuthType::Password,
            key_path: None,
            port: 22,
            keepalive_interval: 30,
            connection_timeout: 10,
            terminal_theme: None,
            default_font_size: None,
            default_font_family: None,
            scrollback_lines: 1000,
            local_echo: false,
            auto_reconnect: false,
            reconnect_delay: 5,
            cli_flavor: CliFlavor::default(),
            auto_commands: vec![],
            jump_host_id: None,
            jump_session_id: None,
        };
        let created = p.create_profile(np).await.unwrap();
        let got = p.get_profile(&created.id).await.unwrap();
        assert!(got.jump_host_id.is_none());
    }

    #[tokio::test]
    async fn update_profile_sets_jump_host_id() {
        let p = setup_provider().await;
        let backing = p
            .create_profile(NewCredentialProfile {
                name: "backing".into(),
                username: "bastion".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let jh = p
            .create_jump_host(NewJumpHost {
                name: "edge".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: backing.id.clone(),
            })
            .await
            .unwrap();
        let target = p
            .create_profile(NewCredentialProfile {
                name: "target".into(),
                username: "admin".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();

        let updated = p
            .update_profile(
                &target.id,
                UpdateCredentialProfile {
                    jump_host_id: Some(Some(jh.id.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.jump_host_id.as_deref(), Some(jh.id.as_str()));

        let cleared = p
            .update_profile(
                &target.id,
                UpdateCredentialProfile {
                    jump_host_id: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(cleared.jump_host_id.is_none());
    }

    #[tokio::test]
    async fn cannot_set_jump_on_profile_used_as_jump_auth() {
        let p = setup_provider().await;
        let auth_profile = p
            .create_profile(NewCredentialProfile {
                name: "bastion-creds".into(),
                username: "bastion".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let _jh = p
            .create_jump_host(NewJumpHost {
                name: "edge-bastion".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: auth_profile.id.clone(),
            })
            .await
            .unwrap();
        // Now try to set ANOTHER jump on bastion-creds — should fail.
        let other_backing = p
            .create_profile(NewCredentialProfile {
                name: "other-backing".into(),
                username: "x".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let other_jh = p
            .create_jump_host(NewJumpHost {
                name: "inner-bastion".into(),
                host: "10.0.0.2".into(),
                port: 22,
                profile_id: other_backing.id.clone(),
            })
            .await
            .unwrap();

        let err = p
            .update_profile(
                &auth_profile.id,
                UpdateCredentialProfile {
                    jump_host_id: Some(Some(other_jh.id.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("bastion-creds"),
            "msg should name profile: {msg}"
        );
        assert!(
            msg.contains("edge-bastion"),
            "msg should name consuming jump: {msg}"
        );
        assert!(
            msg.contains("Jump hosts cannot be chained"),
            "msg should explain rule: {msg}"
        );
    }

    #[tokio::test]
    async fn cannot_set_jump_pointing_to_jump_whose_profile_is_chained() {
        let p = setup_provider().await;
        // Build: target_profile -> jump1 -> jump1_profile (which has its own jump2)
        let inner_backing = p
            .create_profile(NewCredentialProfile {
                name: "inner-backing".into(),
                username: "x".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let jump2 = p
            .create_jump_host(NewJumpHost {
                name: "inner-bastion".into(),
                host: "10.0.0.2".into(),
                port: 22,
                profile_id: inner_backing.id.clone(),
            })
            .await
            .unwrap();
        // Create jump1's auth profile WITHOUT chain (so jump1 can be created).
        let jump1_profile = p
            .create_profile(NewCredentialProfile {
                name: "bastion-creds".into(),
                username: "bastion".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let jump1 = p
            .create_jump_host(NewJumpHost {
                name: "edge-bastion".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: jump1_profile.id.clone(),
            })
            .await
            .unwrap();

        // Bypass profile validation via direct DB UPDATE to simulate legacy data,
        // then verify that updating target_profile through the API fails.
        sqlx::query("UPDATE credential_profiles SET jump_host_id = ? WHERE id = ?")
            .bind(&jump2.id)
            .bind(&jump1_profile.id)
            .execute(p.get_pool())
            .await
            .unwrap();

        let target_profile = p
            .create_profile(NewCredentialProfile {
                name: "corp-routers".into(),
                username: "admin".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();

        let err = p
            .update_profile(
                &target_profile.id,
                UpdateCredentialProfile {
                    jump_host_id: Some(Some(jump1.id.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("corp-routers"),
            "msg should name target profile: {msg}"
        );
        assert!(
            msg.contains("edge-bastion"),
            "msg should name chosen jump: {msg}"
        );
        assert!(
            msg.contains("bastion-creds"),
            "msg should name jump's profile: {msg}"
        );
        assert!(
            msg.contains("inner-bastion"),
            "msg should name inner jump: {msg}"
        );
    }

    #[tokio::test]
    async fn cannot_create_jump_host_pointing_at_chained_profile() {
        let p = setup_provider().await;
        // Build a leaf profile to back an inner jump.
        let inner_backing = p
            .create_profile(NewCredentialProfile {
                name: "inner-backing".into(),
                username: "x".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        let inner_jh = p
            .create_jump_host(NewJumpHost {
                name: "inner-bastion".into(),
                host: "10.0.0.2".into(),
                port: 22,
                profile_id: inner_backing.id.clone(),
            })
            .await
            .unwrap();
        // Profile that has its own jump (legacy / direct-DB to skip profile validator).
        let chained_profile = p
            .create_profile(NewCredentialProfile {
                name: "bastion-creds".into(),
                username: "bastion".into(),
                auth_type: AuthType::Password,
                key_path: None,
                port: 22,
                keepalive_interval: 30,
                connection_timeout: 10,
                terminal_theme: None,
                default_font_size: None,
                default_font_family: None,
                scrollback_lines: 1000,
                local_echo: false,
                auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: CliFlavor::default(),
                auto_commands: vec![],
                jump_host_id: None,
                jump_session_id: None,
            })
            .await
            .unwrap();
        sqlx::query("UPDATE credential_profiles SET jump_host_id = ? WHERE id = ?")
            .bind(&inner_jh.id)
            .bind(&chained_profile.id)
            .execute(p.get_pool())
            .await
            .unwrap();

        // Now try to create a jump host that uses chained_profile — must fail.
        let err = p
            .create_jump_host(NewJumpHost {
                name: "edge-bastion".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: chained_profile.id.clone(),
            })
            .await
            .unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("edge-bastion"),
            "msg should name new jump: {msg}"
        );
        assert!(
            msg.contains("bastion-creds"),
            "msg should name profile: {msg}"
        );
        assert!(
            msg.contains("inner-bastion"),
            "msg should name inner jump: {msg}"
        );
        assert!(
            msg.contains("Jump hosts cannot be chained"),
            "msg should explain rule: {msg}"
        );
    }

    // === T1 (sessions-as-jump-hosts): validation tests ===

    /// Compact NewCredentialProfile builder for the validation tests.
    fn ncp(name: &str) -> NewCredentialProfile {
        NewCredentialProfile {
            name: name.into(),
            username: "u".into(),
            auth_type: AuthType::Password,
            key_path: None,
            port: 22,
            keepalive_interval: 30,
            connection_timeout: 10,
            terminal_theme: None,
            default_font_size: None,
            default_font_family: None,
            scrollback_lines: 1000,
            local_echo: false,
            auto_reconnect: false,
            reconnect_delay: 5,
            cli_flavor: CliFlavor::default(),
            auto_commands: vec![],
            jump_host_id: None,
            jump_session_id: None,
        }
    }

    // --- OOB console access -------------------------------------------------

    #[test]
    fn console_access_validation_is_all_or_nothing() {
        let v = |h: Option<&str>, p: Option<u16>| {
            validate_console_access(h, p, &Protocol::Telnet, None)
        };
        assert!(v(None, None).is_ok());
        assert!(v(Some("  "), None).is_ok(), "blank host counts as unset");
        assert!(v(Some("ts.example"), Some(3001)).is_ok());
        assert!(v(Some("ts.example"), None).is_err());
        assert!(v(None, Some(3001)).is_err());
        assert!(v(Some("ts.example"), Some(0)).is_err());
        // SSH consoles need a terminal-server login; telnet lines may have none.
        assert!(validate_console_access(Some("ts"), Some(3001), &Protocol::Ssh, None).is_err());
        assert!(validate_console_access(Some("ts"), Some(3001), &Protocol::Ssh, Some("")).is_err());
        assert!(
            validate_console_access(Some("ts"), Some(3001), &Protocol::Ssh, Some("p1")).is_ok()
        );
    }

    #[tokio::test]
    async fn console_fields_round_trip_and_clear() {
        let p = setup_provider().await;
        let prof = p.create_profile(ncp("device")).await.unwrap();
        let ts_prof = p.create_profile(ncp("opengear")).await.unwrap();

        // Create with console access over telnet and no console profile.
        let mut ns = nsess("edge-1", &prof.id);
        ns.console_host = Some("oob-den1.example".into());
        ns.console_port = Some(2007);
        ns.console_protocol = Protocol::Telnet;
        let created = p.create_session(ns).await.unwrap();
        assert_eq!(created.console_host.as_deref(), Some("oob-den1.example"));
        assert_eq!(created.console_port, Some(2007));
        assert_eq!(created.console_protocol, Protocol::Telnet);
        assert_eq!(created.console_profile_id, None);
        assert!(!created.console_legacy_ssh);

        // Re-read from the DB (exercises SESSION_COLUMNS + row mapping).
        let fetched = p.get_session(&created.id).await.unwrap();
        assert_eq!(fetched.console_host, created.console_host);
        assert_eq!(fetched.console_port, created.console_port);
        assert_eq!(fetched.console_protocol, Protocol::Telnet);

        // Switch to SSH with a terminal-server profile + legacy algorithms.
        let updated = p
            .update_session(
                &created.id,
                UpdateSession {
                    console_port: Some(Some(3007)),
                    console_protocol: Some(Protocol::Ssh),
                    console_profile_id: Some(Some(ts_prof.id.clone())),
                    console_legacy_ssh: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            updated.console_host.as_deref(),
            Some("oob-den1.example"),
            "untouched field survives a partial update"
        );
        assert_eq!(updated.console_port, Some(3007));
        assert_eq!(updated.console_protocol, Protocol::Ssh);
        assert_eq!(
            updated.console_profile_id.as_deref(),
            Some(ts_prof.id.as_str())
        );
        assert!(updated.console_legacy_ssh);

        // The console profile is now in use: deleting it must be refused.
        assert!(p.delete_profile(&ts_prof.id).await.is_err());

        // Half-clearing is rejected …
        let err = p
            .update_session(
                &created.id,
                UpdateSession {
                    console_host: Some(None),
                    ..Default::default()
                },
            )
            .await;
        assert!(
            matches!(err, Err(ProviderError::Validation(_))),
            "host without port must be rejected"
        );

        // … clearing both is fine and drops the profile reference too.
        let cleared = p
            .update_session(
                &created.id,
                UpdateSession {
                    console_host: Some(None),
                    console_port: Some(None),
                    console_profile_id: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(cleared.console_host, None);
        assert_eq!(cleared.console_port, None);
        assert_eq!(cleared.console_profile_id, None);
        assert!(p.delete_profile(&ts_prof.id).await.is_ok());
    }

    #[tokio::test]
    async fn console_fields_survive_export_import_by_profile_name() {
        let p = setup_provider().await;
        let prof = p.create_profile(ncp("device")).await.unwrap();
        let ts_prof = p.create_profile(ncp("opengear-admin")).await.unwrap();

        let mut ns = nsess("edge-2", &prof.id);
        ns.console_host = Some("oob.example".into());
        ns.console_port = Some(3002);
        ns.console_profile_id = Some(ts_prof.id.clone());
        ns.console_legacy_ssh = true;
        let created = p.create_session(ns).await.unwrap();

        let exported = p.export_session(&created.id).await.unwrap();
        let es = &exported.sessions[0];
        assert_eq!(es.console_host.as_deref(), Some("oob.example"));
        assert_eq!(es.console_port, Some(3002));
        assert_eq!(es.console_profile_name.as_deref(), Some("opengear-admin"));
        assert!(es.console_legacy_ssh);

        // Import into a fresh provider that has the profiles but not the session.
        let q = setup_provider().await;
        q.create_profile(ncp("device")).await.unwrap();
        let q_ts = q.create_profile(ncp("opengear-admin")).await.unwrap();
        let result = q.import_data(exported.clone()).await.unwrap();
        assert_eq!(result.sessions_created, 1);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let imported = q
            .list_sessions()
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.name == "edge-2")
            .unwrap();
        assert_eq!(imported.console_host.as_deref(), Some("oob.example"));
        assert_eq!(imported.console_port, Some(3002));
        assert_eq!(
            imported.console_profile_id.as_deref(),
            Some(q_ts.id.as_str())
        );
        assert!(imported.console_legacy_ssh);

        // Unknown console profile on an SSH console: the session imports
        // without console access (it could not connect anyway) and warns.
        let r = setup_provider().await;
        r.create_profile(ncp("device")).await.unwrap();
        let result = r.import_data(exported).await.unwrap();
        assert_eq!(result.sessions_created, 1);
        assert!(
            result.warnings.iter().any(|w| w.contains("opengear-admin")),
            "{:?}",
            result.warnings
        );
        let imported = r
            .list_sessions()
            .await
            .unwrap()
            .into_iter()
            .find(|s| s.name == "edge-2")
            .unwrap();
        assert_eq!(imported.console_host, None);
        assert_eq!(imported.console_port, None);
        assert_eq!(imported.console_profile_id, None);
    }

    /// Compact NewSession builder for the validation tests.
    fn nsess(name: &str, profile_id: &str) -> NewSession {
        NewSession {
            name: name.into(),
            folder_id: None,
            host: "1.1.1.1".into(),
            port: 22,
            color: None,
            profile_id: profile_id.into(),
            netbox_device_id: None,
            netbox_source_id: None,
            cli_flavor: CliFlavor::Auto,
            terminal_theme: None,
            font_family: None,
            font_size_override: None,
            jump_host_id: None,
            jump_session_id: None,
            port_forwards: vec![],
            auto_commands: vec![],
            legacy_ssh: false,
            protocol: Protocol::Ssh,
            sftp_start_path: None,
            console_host: None,
            console_port: None,
            console_protocol: Protocol::Ssh,
            console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        }
    }

    #[tokio::test]
    async fn session_jump_refs_mutually_exclusive() {
        let p = setup_provider().await;
        let prof = p.create_profile(ncp("p")).await.unwrap();
        let leaf = p.create_session(nsess("leaf", &prof.id)).await.unwrap();
        let jh_prof = p.create_profile(ncp("jh-prof")).await.unwrap();
        let jh = p
            .create_jump_host(NewJumpHost {
                name: "jh".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: jh_prof.id.clone(),
            })
            .await
            .unwrap();

        // Try to create a session with BOTH set — must fail.
        let mut bad = nsess("bad", &prof.id);
        bad.jump_host_id = Some(jh.id.clone());
        bad.jump_session_id = Some(leaf.id.clone());
        let err = p.create_session(bad).await.unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("both") && msg.contains("pick one"),
            "msg should explain mutual exclusion: {msg}"
        );
    }

    #[tokio::test]
    async fn profile_jump_refs_mutually_exclusive() {
        let p = setup_provider().await;
        let target_prof = p.create_profile(ncp("target")).await.unwrap();
        let leaf = p
            .create_session(nsess("leaf", &target_prof.id))
            .await
            .unwrap();
        let jh_prof = p.create_profile(ncp("jh-prof")).await.unwrap();
        let jh = p
            .create_jump_host(NewJumpHost {
                name: "jh".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: jh_prof.id.clone(),
            })
            .await
            .unwrap();

        // Profile with both jump kinds set on create — must fail.
        let mut bad = ncp("bad");
        bad.jump_host_id = Some(jh.id.clone());
        bad.jump_session_id = Some(leaf.id.clone());
        let err = p.create_profile(bad).await.unwrap_err();
        assert!(format!("{}", err).contains("pick one"));
    }

    #[tokio::test]
    async fn session_cannot_jump_to_itself() {
        let p = setup_provider().await;
        let prof = p.create_profile(ncp("p")).await.unwrap();
        let s = p.create_session(nsess("s", &prof.id)).await.unwrap();
        let err = p
            .update_session(
                &s.id,
                UpdateSession {
                    jump_session_id: Some(Some(s.id.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(
            format!("{}", err).contains("itself"),
            "self-reference must be rejected: {err}"
        );
    }

    #[tokio::test]
    async fn session_as_jump_must_be_leaf() {
        let p = setup_provider().await;
        let p_a = p.create_profile(ncp("p_a")).await.unwrap();
        let p_b = p.create_profile(ncp("p_b")).await.unwrap();

        // Build a real chain: jump host record exists for p_b's jumping needs.
        let real_jh_prof = p.create_profile(ncp("real-jh-prof")).await.unwrap();
        let real_jh = p
            .create_jump_host(NewJumpHost {
                name: "real-jh".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: real_jh_prof.id.clone(),
            })
            .await
            .unwrap();

        // Session A already has a jump configured (not a leaf).
        let mut a_init = nsess("A", &p_a.id);
        a_init.jump_host_id = Some(real_jh.id.clone());
        let session_a = p.create_session(a_init).await.unwrap();

        // Session B trying to use A as its jump → must fail (A isn't a leaf).
        let mut b = nsess("B", &p_b.id);
        b.jump_session_id = Some(session_a.id.clone());
        let err = p.create_session(b).await.unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("Multi-hop") && msg.contains("'A'"),
            "msg should explain leaf rule and name session A: {msg}"
        );
    }

    #[tokio::test]
    async fn session_as_jump_profile_must_be_leaf() {
        let p = setup_provider().await;
        // Backing profile for the real jump host
        let backing_prof = p.create_profile(ncp("backing")).await.unwrap();
        let real_jh = p
            .create_jump_host(NewJumpHost {
                name: "real-jh".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: backing_prof.id.clone(),
            })
            .await
            .unwrap();
        // Profile that itself has a jump configured (not a leaf).
        let mut chain_prof = ncp("chain-prof");
        chain_prof.jump_host_id = Some(real_jh.id.clone());
        let chain_prof = p.create_profile(chain_prof).await.unwrap();

        // Session A uses the chain profile (so its profile is non-leaf).
        let session_a = p.create_session(nsess("A", &chain_prof.id)).await.unwrap();

        // Session B trying to use A as its jump → must fail (A's profile isn't a leaf).
        let other = p.create_profile(ncp("other")).await.unwrap();
        let mut b = nsess("B", &other.id);
        b.jump_session_id = Some(session_a.id.clone());
        let err = p.create_session(b).await.unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("auth profile") && msg.contains("chain-prof"),
            "msg should explain profile-leaf rule and name profile: {msg}"
        );
    }

    #[tokio::test]
    async fn session_in_use_as_jump_cannot_add_a_jump() {
        let p = setup_provider().await;
        let p_a = p.create_profile(ncp("p_a")).await.unwrap();
        let p_b = p.create_profile(ncp("p_b")).await.unwrap();
        let session_a = p.create_session(nsess("A", &p_a.id)).await.unwrap();

        // Session B uses A as its jump (legal: A is a leaf).
        let mut b = nsess("B", &p_b.id);
        b.jump_session_id = Some(session_a.id.clone());
        p.create_session(b).await.unwrap();

        // Now try to add a jump_host_id to A → must be rejected by the
        // symmetric check (A is in use as a jump).
        let backing = p.create_profile(ncp("backing")).await.unwrap();
        let real_jh = p
            .create_jump_host(NewJumpHost {
                name: "real-jh".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: backing.id.clone(),
            })
            .await
            .unwrap();

        let err = p
            .update_session(
                &session_a.id,
                UpdateSession {
                    jump_host_id: Some(Some(real_jh.id.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("used as a jump"),
            "msg should explain symmetric block: {msg}"
        );
        assert!(
            msg.contains("'B'"),
            "msg should name dependent session B: {msg}"
        );
    }

    #[tokio::test]
    async fn find_session_jump_dependents_lists_sessions_tunnels_profiles() {
        let p = setup_provider().await;
        let p_root = p.create_profile(ncp("root")).await.unwrap();
        let root_session = p.create_session(nsess("root", &p_root.id)).await.unwrap();

        // Two sessions use root as jump.
        let p_a = p.create_profile(ncp("p_a")).await.unwrap();
        let mut a = nsess("dep-A", &p_a.id);
        a.jump_session_id = Some(root_session.id.clone());
        let a = p.create_session(a).await.unwrap();

        let p_b = p.create_profile(ncp("p_b")).await.unwrap();
        let mut b = nsess("dep-B", &p_b.id);
        b.jump_session_id = Some(root_session.id.clone());
        let b = p.create_session(b).await.unwrap();

        // A profile uses root as jump too.
        let mut chain_prof = ncp("chain-prof");
        chain_prof.jump_session_id = Some(root_session.id.clone());
        let chain_prof = p.create_profile(chain_prof).await.unwrap();

        // A tunnel uses root as jump.
        let p_t = p.create_profile(ncp("p_t")).await.unwrap();
        let new_tunnel = crate::models::NewTunnel {
            name: "dep-T".into(),
            host: "10.0.0.99".into(),
            port: 22,
            profile_id: p_t.id.clone(),
            jump_host_id: None,
            jump_session_id: Some(root_session.id.clone()),
            forward_type: crate::models::PortForwardType::Local,
            local_port: 8080,
            bind_address: "127.0.0.1".into(),
            remote_host: Some("10.10.10.10".into()),
            remote_port: Some(80),
            auto_start: false,
            auto_reconnect: false,
            max_retries: 0,
        };
        let t = crate::db::create_tunnel(p.get_pool(), new_tunnel)
            .await
            .unwrap();

        let deps = p
            .find_session_jump_dependents(&root_session.id)
            .await
            .unwrap();

        let session_ids: Vec<_> = deps.sessions.iter().map(|d| d.id.as_str()).collect();
        assert!(
            session_ids.contains(&a.id.as_str()) && session_ids.contains(&b.id.as_str()),
            "expected both A and B in session deps, got {session_ids:?}"
        );
        assert_eq!(deps.tunnels.len(), 1);
        assert_eq!(deps.tunnels[0].id, t.id);
        assert_eq!(deps.profiles.len(), 1);
        assert_eq!(deps.profiles[0].id, chain_prof.id);

        // No dependents on a fresh leaf.
        let leaf = p.create_session(nsess("leaf", &p_root.id)).await.unwrap();
        let deps = p.find_session_jump_dependents(&leaf.id).await.unwrap();
        assert!(deps.sessions.is_empty() && deps.tunnels.is_empty() && deps.profiles.is_empty());
    }

    #[tokio::test]
    async fn session_as_jump_happy_path_persists() {
        let p = setup_provider().await;
        let p_a = p.create_profile(ncp("p_a")).await.unwrap();
        let p_b = p.create_profile(ncp("p_b")).await.unwrap();
        let session_a = p.create_session(nsess("A", &p_a.id)).await.unwrap();

        let mut b = nsess("B", &p_b.id);
        b.jump_session_id = Some(session_a.id.clone());
        let created_b = p.create_session(b).await.unwrap();

        assert_eq!(
            created_b.jump_session_id.as_deref(),
            Some(session_a.id.as_str())
        );
        assert!(created_b.jump_host_id.is_none());

        // Round-trip via DB.
        let reread = p.get_session(&created_b.id).await.unwrap();
        assert_eq!(
            reread.jump_session_id.as_deref(),
            Some(session_a.id.as_str())
        );
    }

    #[tokio::test]
    async fn test_update_librenms_source() {
        let provider = setup_provider().await;

        // Set up vault
        provider.set_master_password("test-password").await.unwrap();

        // Create an API resource first
        let api_resource = provider
            .create_api_resource(&CreateApiResourceRequest {
                name: "LibreNMS API".to_string(),
                base_url: "https://librenms.example.com".to_string(),
                auth_type: ApiResourceAuthType::BearerToken,
                auth_token: Some("test-token".to_string()),
                auth_username: None,
                auth_password: None,
                auth_header_name: None,
                auth_header_prefix: None,
                auth_flow: None,
                default_headers: serde_json::json!({}),
                custom_headers: serde_json::json!({}),
                verify_ssl: true,
                timeout_secs: 30,
                test_path: None,
            })
            .await
            .unwrap();

        // Create a LibreNMS source
        let source = provider
            .create_librenms_source(NewLibreNmsSource {
                name: "Old Name".to_string(),
                api_resource_id: api_resource.id.clone(),
            })
            .await
            .unwrap();

        // Update the name
        let update = UpdateLibreNmsSource {
            name: Some("New Name".to_string()),
            api_resource_id: None,
        };
        let updated = provider
            .update_librenms_source(&source.id, update)
            .await
            .unwrap();

        assert_eq!(updated.name, "New Name");
        assert_eq!(updated.api_resource_id, api_resource.id);

        // Verify persistence
        let fetched = provider.get_librenms_source(&source.id).await.unwrap();
        assert_eq!(fetched.name, "New Name");
    }
}

/// Shallow-merge an annotation `element_data` patch over the stored value.
///
/// Top-level keys in `patch` win; keys absent from `patch` are preserved.
/// Nested objects are replaced wholesale (a `position` patch carries both
/// `x` and `y`), which matches what every caller sends. If either side is
/// not a JSON object the patch is returned unchanged.
pub fn merge_annotation_element_data(
    existing: &str,
    patch: &serde_json::Value,
) -> serde_json::Value {
    let Ok(serde_json::Value::Object(mut base)) =
        serde_json::from_str::<serde_json::Value>(existing)
    else {
        return patch.clone();
    };
    let serde_json::Value::Object(overlay) = patch else {
        return patch.clone();
    };
    for (k, v) in overlay {
        base.insert(k.clone(), v.clone());
    }
    serde_json::Value::Object(base)
}

#[cfg(test)]
mod annotation_merge_tests {
    use super::merge_annotation_element_data;
    use serde_json::json;

    #[test]
    fn partial_patch_preserves_other_keys() {
        let existing =
            r#"{"position":{"x":1,"y":2},"size":{"width":100,"height":50},"content":"hi"}"#;
        let merged =
            merge_annotation_element_data(existing, &json!({"position": {"x": 10, "y": 20}}));
        assert_eq!(merged["position"], json!({"x": 10, "y": 20}));
        assert_eq!(merged["size"], json!({"width": 100, "height": 50}));
        assert_eq!(merged["content"], json!("hi"));
    }

    #[test]
    fn non_object_existing_is_replaced() {
        let merged = merge_annotation_element_data("not json", &json!({"a": 1}));
        assert_eq!(merged, json!({"a": 1}));
    }
}

/// The OS user account this agent runs as — used as the default author stamp
/// for records created from the standalone UI, which has no signed-in user.
fn local_os_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "local".to_string())
}
