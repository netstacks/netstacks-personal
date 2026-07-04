//! Data models for NetStacks sessions, folders, and credentials

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// === Datetime Utilities ===

/// Parse a datetime string from SQLite storage format.
/// Handles both RFC3339 format (with timezone) and SQLite default format (without timezone).
pub fn parse_datetime(s: &str) -> Result<DateTime<Utc>, String> {
    // Try RFC3339 format first (with timezone)
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&Utc));
    }

    // Try SQLite default format (without timezone, assume UTC)
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Ok(dt.and_utc());
    }

    Err(format!("Failed to parse datetime: {}", s))
}

/// Format a datetime for SQLite storage.
pub fn format_datetime(dt: &DateTime<Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Determines where SSH connections originate
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[derive(Default)]
pub enum ConnectionMode {
    /// SSH from this machine (Single User edition)
    #[default]
    Local,
    /// SSH from Controller, terminal streamed to client (Enterprise)
    Controller { url: String },
}


fn default_folder_scope() -> String {
    "session".to_string()
}

/// Folder for organizing sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default = "default_folder_scope")]
    pub scope: String,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// SSH session configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub folder_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub last_connected_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // Session-specific settings
    #[serde(default = "default_auto_reconnect")]
    pub auto_reconnect: bool,
    #[serde(default = "default_reconnect_delay")]
    pub reconnect_delay: u32,
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: u32,
    #[serde(default)]
    pub local_echo: bool,
    pub font_size_override: Option<u32>,
    /// Terminal font family (null = use default)
    pub font_family: Option<String>,
    // Profile integration - all authentication comes from the profile
    /// Reference to credential profile (required - all auth comes from profile)
    pub profile_id: String,
    /// NetBox device ID for resync matching
    #[serde(default)]
    pub netbox_device_id: Option<i64>,
    /// NetBox source ID that imported this session
    #[serde(default)]
    pub netbox_source_id: Option<String>,
    /// CLI flavor for AI command suggestions
    #[serde(default)]
    pub cli_flavor: CliFlavor,
    /// Terminal color theme ID (null = use default)
    pub terminal_theme: Option<String>,
    // Jump host / proxy support (refactored to global jump hosts)
    /// Reference to a global jump host configuration
    #[serde(default)]
    pub jump_host_id: Option<String>,
    /// Alternative: reference to another Session used as the jump endpoint.
    /// Mutually exclusive with `jump_host_id` (provider rejects setting both).
    #[serde(default)]
    pub jump_session_id: Option<String>,
    // Port forwarding (Phase 06.3)
    /// SSH port forwards (local, remote, dynamic)
    #[serde(default)]
    pub port_forwards: Vec<PortForward>,
    // Auto commands on connect
    /// Commands to run automatically after SSH connection establishes
    #[serde(default)]
    pub auto_commands: Vec<String>,
    // Legacy SSH support for older devices
    /// Enable legacy/insecure SSH algorithms for older devices
    #[serde(default)]
    pub legacy_ssh: bool,
    /// Connection protocol (ssh or telnet)
    #[serde(default)]
    pub protocol: Protocol,
    /// SFTP starting directory override (null = use cli_flavor default)
    #[serde(default)]
    pub sftp_start_path: Option<String>,
}

fn default_auto_reconnect() -> bool {
    true
}

fn default_reconnect_delay() -> u32 {
    5
}

fn default_scrollback_lines() -> u32 {
    10000
}

/// Authentication method for SSH
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum AuthType {
    #[default]
    Password,
    Key,
}


/// Connection protocol for sessions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Protocol {
    #[default]
    Ssh,
    Telnet,
}


impl Protocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Protocol::Ssh => "ssh",
            Protocol::Telnet => "telnet",
        }
    }
}

/// CLI flavor for AI command suggestions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum CliFlavor {
    #[default]
    Auto,
    Linux,
    CiscoIos,
    /// Cisco IOS-XR — separate flavor from IOS/IOS-XE because the CLI semantics
    /// differ (commit-based config, different show commands, BGP / routing
    /// hierarchy structured more like Junos than IOS).
    CiscoIosXr,
    CiscoNxos,
    Juniper,
    Arista,
    Paloalto,
    Fortinet,
}


/// Decrypted credential (only exists in memory)
#[derive(Debug, Clone)]
pub struct _Credential {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

/// Request to create a new session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSession {
    pub name: String,
    pub folder_id: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub color: Option<String>,
    // Profile integration - all auth comes from profile
    /// Reference to credential profile (required)
    pub profile_id: String,
    /// NetBox device ID for resync matching
    #[serde(default)]
    pub netbox_device_id: Option<i64>,
    /// NetBox source ID that imported this session
    #[serde(default)]
    pub netbox_source_id: Option<String>,
    /// CLI flavor for AI command suggestions
    #[serde(default)]
    pub cli_flavor: CliFlavor,
    /// Terminal color theme ID (null = use default)
    pub terminal_theme: Option<String>,
    /// Terminal font family (null = use default)
    pub font_family: Option<String>,
    /// Terminal font size override (null = use default)
    pub font_size_override: Option<u32>,
    // Jump host / proxy support (refactored to global jump hosts)
    /// Reference to a global jump host configuration
    #[serde(default)]
    pub jump_host_id: Option<String>,
    /// Alternative: a Session used as the jump endpoint (mutually exclusive
    /// with jump_host_id).
    #[serde(default)]
    pub jump_session_id: Option<String>,
    // Port forwarding (Phase 06.3)
    /// SSH port forwards (local, remote, dynamic)
    #[serde(default)]
    pub port_forwards: Vec<PortForward>,
    // Auto commands on connect
    /// Commands to run automatically after SSH connection establishes
    #[serde(default)]
    pub auto_commands: Vec<String>,
    // Legacy SSH support for older devices
    /// Enable legacy/insecure SSH algorithms for older devices
    #[serde(default)]
    pub legacy_ssh: bool,
    /// Connection protocol (ssh or telnet)
    #[serde(default)]
    pub protocol: Protocol,
    /// SFTP starting directory override
    #[serde(default)]
    pub sftp_start_path: Option<String>,
}

fn default_port() -> u16 {
    22
}

/// Request to update a session
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateSession {
    pub name: Option<String>,
    pub folder_id: Option<Option<String>>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub color: Option<Option<String>>,
    pub icon: Option<Option<String>>,
    pub sort_order: Option<i32>,
    // Session-specific settings
    pub auto_reconnect: Option<bool>,
    pub reconnect_delay: Option<u32>,
    pub scrollback_lines: Option<u32>,
    pub local_echo: Option<bool>,
    pub font_size_override: Option<Option<u32>>,
    /// Terminal font family (Option<Option<>> to allow clearing)
    pub font_family: Option<Option<String>>,
    // Profile integration - all auth comes from profile
    /// Reference to credential profile (required - can update but not clear)
    pub profile_id: Option<String>,
    /// NetBox device ID (Option<Option<>> to allow clearing)
    pub netbox_device_id: Option<Option<i64>>,
    /// NetBox source ID (Option<Option<>> to allow clearing)
    pub netbox_source_id: Option<Option<String>>,
    /// CLI flavor for AI command suggestions
    pub cli_flavor: Option<CliFlavor>,
    /// Terminal color theme ID (Option<Option<>> to allow clearing)
    pub terminal_theme: Option<Option<String>>,
    // Jump host / proxy support (refactored to global jump hosts)
    /// Reference to a global jump host configuration (Option<Option<>> to allow clearing)
    pub jump_host_id: Option<Option<String>>,
    /// Reference to another Session used as the jump endpoint (Option<Option<>> to allow clearing)
    pub jump_session_id: Option<Option<String>>,
    // Port forwarding (Phase 06.3)
    /// SSH port forwards (replaces entire list when provided)
    pub port_forwards: Option<Vec<PortForward>>,
    // Auto commands on connect
    /// Commands to run automatically after SSH connection (replaces entire list when provided)
    pub auto_commands: Option<Vec<String>>,
    // Legacy SSH support for older devices
    /// Enable legacy/insecure SSH algorithms for older devices
    pub legacy_ssh: Option<bool>,
    /// Connection protocol (ssh or telnet)
    pub protocol: Option<Protocol>,
    /// SFTP starting directory override (Option<Option<>> to allow clearing)
    pub sftp_start_path: Option<Option<String>>,
}

/// Request to create a new folder
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewFolder {
    pub name: String,
    pub parent_id: Option<String>,
    pub scope: Option<String>,
}

/// Request to update a folder
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateFolder {
    pub name: Option<String>,
    pub parent_id: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

/// Credential to store (will be encrypted)
#[derive(Clone, Serialize, Deserialize)]
pub struct NewCredential {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

impl std::fmt::Debug for NewCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewCredential")
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("key_passphrase", &self.key_passphrase.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

/// Vault status response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStatus {
    pub unlocked: bool,
    pub has_master_password: bool,
}

/// Global mapped key (keyboard shortcut to command mapping)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappedKey {
    pub id: String,
    pub key_combo: String,
    pub command: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Request to create a new mapped key
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMappedKey {
    pub key_combo: String,
    pub command: String,
    pub description: Option<String>,
}

/// Request to update a mapped key
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMappedKey {
    pub key_combo: Option<String>,
    pub command: Option<String>,
    pub description: Option<Option<String>>,
}

/// Snippet (command snippet for a session or global)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub command: String,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
}

/// Request to create a new snippet
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSnippet {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub sort_order: i32,
}

/// Request to update an existing snippet. Every field optional — only
/// fields that are `Some` will be written.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateSnippet {
    pub name: Option<String>,
    pub command: Option<String>,
    pub sort_order: Option<i32>,
}

// === Custom Commands ===

/// Custom right-click command (static quick test or dynamic detection command)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    pub detection_types: Option<String>,
    pub sort_order: i32,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub action_type: String,
    pub quick_action_id: Option<String>,
    pub quick_action_variable: Option<String>,
    pub script_id: Option<String>,
    pub show_in_force_click: bool,
}

/// Request to create a new custom command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCustomCommand {
    pub name: String,
    pub command: String,
    pub detection_types: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_action_type")]
    pub action_type: String,
    pub quick_action_id: Option<String>,
    pub quick_action_variable: Option<String>,
    pub script_id: Option<String>,
    #[serde(default)]
    pub show_in_force_click: bool,
}

fn default_action_type() -> String {
    "terminal".to_string()
}

fn default_enabled() -> bool {
    true
}

/// Request to update a custom command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCustomCommand {
    pub name: Option<String>,
    pub command: Option<String>,
    pub detection_types: Option<Option<String>>,
    pub sort_order: Option<i32>,
    pub enabled: Option<bool>,
    pub action_type: Option<String>,
    pub quick_action_id: Option<Option<String>>,
    pub quick_action_variable: Option<Option<String>>,
    pub script_id: Option<Option<String>>,
    pub show_in_force_click: Option<bool>,
}

// === AI Conversations (chat history) ===

/// A saved AI side-panel conversation. `messages` is an opaque JSON array of
/// the frontend's message objects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub messages: serde_json::Value,
    pub agent_type: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Lightweight conversation row for the history list (no message bodies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversationSummary {
    pub id: String,
    pub title: String,
    pub agent_type: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewAiConversation {
    pub title: Option<String>,
    pub messages: Option<serde_json::Value>,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateAiConversation {
    pub title: Option<String>,
    pub messages: Option<serde_json::Value>,
}

// === Scripts ===

/// Python script for automation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub id: String,
    pub name: String,
    pub content: String,
    pub is_template: bool,
    pub last_run_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Provenance — `"user"` (default), `"ai"`, or `"template"`. Set by the
    /// API surface that created the row. Used by `run_script` to refuse to
    /// execute AI-authored scripts that the user hasn't explicitly approved.
    /// AUDIT FIX (EXEC-014).
    #[serde(default = "default_script_created_by")]
    pub created_by: String,
    /// True once the user has explicitly approved an AI-authored script for
    /// execution via `POST /api/scripts/:id/approve`. Always true for
    /// `created_by=user` and `created_by=template` rows.
    #[serde(default = "default_script_approved")]
    pub approved: bool,
}

fn default_script_created_by() -> String { "user".to_string() }
fn default_script_approved() -> bool { true }

/// Request to create a new script
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewScript {
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_template: bool,
    /// Optional caller-supplied provenance. Only `"user"` is honoured from
    /// API callers (default if omitted); the `"ai"` value is set internally
    /// when an AI tool authors the script via `/api/ai/generate-script`.
    #[serde(default)]
    pub created_by: Option<String>,
}

/// Request to update a script
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateScript {
    pub name: Option<String>,
    pub content: Option<String>,
    pub is_template: Option<bool>,
}

/// Script execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

// === Connection History ===

/// Connection history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionHistory {
    pub id: String,
    pub session_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected_at: DateTime<Utc>,
    pub disconnected_at: Option<DateTime<Utc>>,
    pub duration_seconds: Option<i32>,
}

/// Request to create a new connection history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewConnectionHistory {
    pub session_id: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
}

// === Export/Import ===

/// Export format for sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportData {
    pub version: String,
    pub format: String,
    pub exported_at: DateTime<Utc>,
    pub sessions: Vec<ExportSession>,
    pub folders: Vec<ExportFolder>,
}

/// Session data for export (no credentials)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSession {
    pub name: String,
    pub folder_name: Option<String>,
    pub host: String,
    pub port: u16,
    /// Profile name (for export - matched by name on import)
    pub profile_name: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    // Session-specific settings
    pub auto_reconnect: bool,
    pub reconnect_delay: u32,
    pub scrollback_lines: u32,
    pub local_echo: bool,
    pub font_size_override: Option<u32>,
    pub mapped_keys: Vec<NewMappedKey>,
    pub snippets: Vec<NewSnippet>,
    // Jump host / proxy support (refactored to global jump hosts)
    /// Jump host name (for export - matched by name on import)
    pub jump_host_name: Option<String>,
    // Port forwarding (Phase 06.3)
    pub port_forwards: Vec<PortForward>,
}

/// Folder data for export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportFolder {
    pub name: String,
    pub parent_name: Option<String>,
}

/// Import result summary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub sessions_created: i32,
    pub folders_created: i32,
    pub warnings: Vec<String>,
}

// === Documents ===

/// Document category for organization
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentCategory {
    Outputs,
    Templates,
    Notes,
    Backups,
    History,
    Troubleshooting,
    Mops,
}

impl DocumentCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Outputs => "outputs",
            Self::Templates => "templates",
            Self::Notes => "notes",
            Self::Backups => "backups",
            Self::History => "history",
            Self::Troubleshooting => "troubleshooting",
            Self::Mops => "mops",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "outputs" => Some(Self::Outputs),
            "templates" => Some(Self::Templates),
            "notes" => Some(Self::Notes),
            "backups" => Some(Self::Backups),
            "history" => Some(Self::History),
            "troubleshooting" => Some(Self::Troubleshooting),
            "mops" => Some(Self::Mops),
            _ => None,
        }
    }
}

/// Document content type for smart rendering
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    Csv,
    Json,
    Jinja,
    Config,
    Text,
    Markdown,
    Recording,
}

impl ContentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
            Self::Jinja => "jinja",
            Self::Config => "config",
            Self::Text => "text",
            Self::Markdown => "markdown",
            Self::Recording => "recording",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "csv" => Some(Self::Csv),
            "json" => Some(Self::Json),
            "jinja" => Some(Self::Jinja),
            "config" => Some(Self::Config),
            "text" => Some(Self::Text),
            "markdown" | "md" => Some(Self::Markdown),
            "recording" => Some(Self::Recording),
            _ => None,
        }
    }
}

/// Document for storing outputs, templates, backups, and history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub name: String,
    pub category: DocumentCategory,
    pub content_type: ContentType,
    pub content: String,
    pub parent_folder: Option<String>,
    pub session_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// True if this document is encrypted at rest (Secure Notes).
    /// When true and the vault is locked, `content` is empty in API responses.
    #[serde(default)]
    pub encrypted: bool,
    /// True if this document is encrypted but the vault was locked when read,
    /// so `content` could not be decrypted and is returned empty.
    #[serde(default)]
    pub locked: bool,
}

/// Request to create a new document
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewDocument {
    pub name: String,
    pub category: DocumentCategory,
    pub content_type: ContentType,
    pub content: String,
    pub parent_folder: Option<String>,
    pub session_id: Option<String>,
}

/// Request to update a document
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateDocument {
    pub name: Option<String>,
    pub category: Option<DocumentCategory>,
    pub content_type: Option<ContentType>,
    pub content: Option<String>,
    pub parent_folder: Option<Option<String>>,
    pub session_id: Option<Option<String>>,
}

/// Document version for version history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentVersion {
    pub id: String,
    pub document_id: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

/// Document version metadata (without content for list responses)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentVersionMeta {
    pub id: String,
    pub document_id: String,
    pub created_at: DateTime<Utc>,
}

// === Credential Profiles ===

fn default_profile_port() -> u16 {
    22
}

fn default_keepalive_interval() -> u32 {
    30
}

fn default_connection_timeout() -> u32 {
    30
}

/// Credential profile for reusable auth and connection settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialProfile {
    pub id: String,
    pub name: String,

    // Identity & Auth
    pub username: String,
    pub auth_type: AuthType,
    pub key_path: Option<String>,

    // Connection Defaults
    #[serde(default = "default_profile_port")]
    pub port: u16,
    #[serde(default = "default_keepalive_interval")]
    pub keepalive_interval: u32,
    #[serde(default = "default_connection_timeout")]
    pub connection_timeout: u32,

    pub terminal_theme: Option<String>,
    pub default_font_size: Option<u32>,
    pub default_font_family: Option<String>,
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: u32,
    #[serde(default)]
    pub local_echo: bool,
    #[serde(default = "default_auto_reconnect")]
    pub auto_reconnect: bool,
    #[serde(default = "default_reconnect_delay")]
    pub reconnect_delay: u32,
    #[serde(default)]
    pub cli_flavor: CliFlavor,
    #[serde(default)]
    pub auto_commands: Vec<String>,

    /// Optional default jump host for sessions/tunnels using this profile.
    /// `None` means direct connection. Sessions/tunnels can override by
    /// setting their own `jump_host_id` to a different value.
    #[serde(default)]
    pub jump_host_id: Option<String>,

    /// Alternative default jump: a Session used as the jump endpoint
    /// (mutually exclusive with jump_host_id).
    #[serde(default)]
    pub jump_session_id: Option<String>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new credential profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCredentialProfile {
    pub name: String,
    pub username: String,
    #[serde(default)]
    pub auth_type: AuthType,
    pub key_path: Option<String>,
    #[serde(default = "default_profile_port")]
    pub port: u16,
    #[serde(default = "default_keepalive_interval")]
    pub keepalive_interval: u32,
    #[serde(default = "default_connection_timeout")]
    pub connection_timeout: u32,
    pub terminal_theme: Option<String>,
    pub default_font_size: Option<u32>,
    pub default_font_family: Option<String>,
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: u32,
    #[serde(default)]
    pub local_echo: bool,
    #[serde(default = "default_auto_reconnect")]
    pub auto_reconnect: bool,
    #[serde(default = "default_reconnect_delay")]
    pub reconnect_delay: u32,
    #[serde(default)]
    pub cli_flavor: CliFlavor,
    #[serde(default)]
    pub auto_commands: Vec<String>,
    #[serde(default)]
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub jump_session_id: Option<String>,
}

/// Request to update a credential profile (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateCredentialProfile {
    pub name: Option<String>,
    pub username: Option<String>,
    pub auth_type: Option<AuthType>,
    pub key_path: Option<Option<String>>,
    pub port: Option<u16>,
    pub keepalive_interval: Option<u32>,
    pub connection_timeout: Option<u32>,
    pub terminal_theme: Option<Option<String>>,
    pub default_font_size: Option<Option<u32>>,
    pub default_font_family: Option<Option<String>>,
    pub scrollback_lines: Option<u32>,
    pub local_echo: Option<bool>,
    pub auto_reconnect: Option<bool>,
    pub reconnect_delay: Option<u32>,
    pub cli_flavor: Option<CliFlavor>,
    pub auto_commands: Option<Vec<String>>,
    pub jump_host_id: Option<Option<String>>,
    pub jump_session_id: Option<Option<String>>,
}

/// Credential for a profile (stored encrypted in vault)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileCredential {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
    /// SNMP community strings for this profile (e.g., ["public", "private"])
    /// Stored encrypted alongside password/key_passphrase in the vault.
    /// Option<Vec> with serde(default) means old data without this field
    /// deserializes correctly as None.
    #[serde(default)]
    pub snmp_communities: Option<Vec<String>>,
}

/// Reference to a single artifact (session/tunnel/profile) that uses
/// some other session as its jump endpoint. Used by the dependents endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpDependentRef {
    pub id: String,
    pub name: String,
}

/// All artifacts that depend on a given session as their jump endpoint.
/// Returned by `GET /api/sessions/:id/jump-dependents`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpDependents {
    pub sessions: Vec<JumpDependentRef>,
    pub tunnels: Vec<JumpDependentRef>,
    pub profiles: Vec<JumpDependentRef>,
}

// === Jump Hosts (Global Proxy Configuration) ===

/// Jump host configuration for SSH proxy connections
/// Configured globally in Settings, referenced by sessions via jump_host_id
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpHost {
    pub id: String,
    pub name: String,
    /// Jump host hostname/IP
    pub host: String,
    /// SSH port (default 22)
    #[serde(default = "default_port")]
    pub port: u16,
    /// Reference to credential profile for authentication
    pub profile_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new jump host
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewJumpHost {
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub profile_id: String,
}

/// Request to update a jump host (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateJumpHost {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub profile_id: Option<String>,
}

// === NetBox Sources ===

/// Profile mappings for NetBox source (maps site/role slugs to profile IDs)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileMappings {
    /// Map of site slug -> credential profile ID
    #[serde(default)]
    pub by_site: std::collections::HashMap<String, String>,
    /// Map of role slug -> credential profile ID
    #[serde(default)]
    pub by_role: std::collections::HashMap<String, String>,
}

/// CLI flavor mappings for NetBox source (maps manufacturer/platform slugs to CLI flavor)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CliFlavorMappings {
    /// Map of manufacturer slug -> CLI flavor
    #[serde(default)]
    pub by_manufacturer: std::collections::HashMap<String, CliFlavor>,
    /// Map of platform slug -> CLI flavor
    #[serde(default)]
    pub by_platform: std::collections::HashMap<String, CliFlavor>,
}

/// Sync filters for NetBox import (legacy, single-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFilters {
    pub site: Option<String>,
    pub role: Option<String>,
}

/// Device filters for NetBox import (multi-select)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeviceFilters {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sites: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub manufacturers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub platforms: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// Result of a NetBox sync operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub sessions_created: i32,
    pub sessions_updated: i32,
    pub skipped: i32,
}

/// NetBox source configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetBoxSource {
    pub id: String,
    pub name: String,
    /// FK to api_resources.id — replaces inline url + vault-stored token
    pub api_resource_id: String,
    pub default_profile_id: Option<String>,
    #[serde(default)]
    pub profile_mappings: ProfileMappings,
    #[serde(default)]
    pub cli_flavor_mappings: CliFlavorMappings,
    #[serde(default)]
    pub device_filters: Option<DeviceFilters>,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_sync_filters: Option<SyncFilters>,
    pub last_sync_result: Option<SyncResult>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new NetBox source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNetBoxSource {
    pub name: String,
    /// FK to api_resources.id — replaces inline url + api_token
    pub api_resource_id: String,
    pub default_profile_id: Option<String>,
    #[serde(default)]
    pub profile_mappings: ProfileMappings,
    #[serde(default)]
    pub cli_flavor_mappings: CliFlavorMappings,
    #[serde(default)]
    pub device_filters: Option<DeviceFilters>,
}

/// Request to update a NetBox source (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateNetBoxSource {
    pub name: Option<String>,
    /// New API resource binding
    pub api_resource_id: Option<String>,
    pub default_profile_id: Option<Option<String>>,
    pub profile_mappings: Option<ProfileMappings>,
    pub cli_flavor_mappings: Option<CliFlavorMappings>,
    /// Device filters for import (multi-select)
    pub device_filters: Option<Option<DeviceFilters>>,
    /// Updated sync timestamp (set by sync-complete endpoint)
    pub last_sync_at: Option<Option<DateTime<Utc>>>,
    /// Sync filters used in the last sync
    pub last_sync_filters: Option<Option<SyncFilters>>,
    /// Result of the last sync
    pub last_sync_result: Option<Option<SyncResult>>,
}

// === LibreNMS Sources (Phase 22) ===

/// LibreNMS source configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibreNmsSource {
    pub id: String,
    pub name: String,
    /// FK to api_resources.id — replaces inline url + vault-stored token
    pub api_resource_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new LibreNMS source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewLibreNmsSource {
    pub name: String,
    /// FK to api_resources.id — replaces inline url + api_token
    pub api_resource_id: String,
}

/// Request to update a LibreNMS source (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateLibreNmsSource {
    pub name: Option<String>,
    pub api_resource_id: Option<String>,
}

/// LibreNMS device from API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibreNmsDevice {
    pub device_id: i64,
    pub hostname: String,
    #[serde(rename = "sysName")]
    pub sys_name: Option<String>,
    pub ip: String,
    #[serde(rename = "type")]
    pub device_type: Option<String>,
    pub hardware: Option<String>,
    pub os: Option<String>,
    pub status: i32,
}

/// LibreNMS link/neighbor from API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibreNmsLink {
    pub id: i64,
    pub local_device_id: i64,
    pub local_port_id: i64,
    pub local_port: String,
    pub remote_hostname: String,
    pub remote_port: String,
    pub protocol: String,
    // Optional port statistics, populated when the links endpoint is
    // queried with ?stats=true. Default to None on deserialize so the
    // existing /devices/{hostname}/links response (no stats) keeps working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port_in_rate_bps: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port_out_rate_bps: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port_speed_bps: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port_in_errors: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port_out_errors: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port_oper_status: Option<String>,
}

/// Per-port statistics fetched from LibreNMS /api/v0/ports/{port_id}.
/// Used internally when enriching links — flattened into LibreNmsLink fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibreNmsPortStats {
    pub in_rate_bps: Option<i64>,
    pub out_rate_bps: Option<i64>,
    pub speed_bps: Option<i64>,
    pub in_errors: Option<i64>,
    pub out_errors: Option<i64>,
    pub oper_status: Option<String>,
}


// === NetStacks-Crawler (Netdisco) Models ===

/// NetStacks-Crawler device from /api/v1/device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetStacksCrawlerDevice {
    pub ip: String,
    pub dns: Option<String>,
    pub name: Option<String>,
    pub model: Option<String>,
    pub os: Option<String>,
    pub os_ver: Option<String>,
    pub vendor: Option<String>,
    pub serial: Option<String>,
    pub uptime: Option<i64>,
    pub last_discover: Option<String>,
}

/// NetStacks-Crawler neighbor from /api/v1/device/{ip}/neighbors
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetStacksCrawlerNeighbor {
    pub port: String,
    pub remote_ip: Option<String>,
    pub remote_dns: Option<String>,
    pub remote_port: Option<String>,
    pub remote_type: Option<String>,
    pub remote_model: Option<String>,
    pub remote_os: Option<String>,
    pub protocol: Option<String>,
}

/// NetStacks-Crawler device link from /api/v1/report/devicelinks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetStacksCrawlerDeviceLink {
    pub left_ip: String,
    pub left_dns: Option<String>,
    pub left_port: Option<String>,
    pub right_ip: String,
    pub right_dns: Option<String>,
    pub right_port: Option<String>,
    pub speed: Option<String>,
    pub protocol: Option<String>,
}

/// NetStacks-Crawler search result from /api/v1/search/device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetStacksCrawlerSearchResult {
    pub ip: String,
    pub dns: Option<String>,
    pub name: Option<String>,
    pub vendor: Option<String>,
    pub model: Option<String>,
    pub os: Option<String>,
}

// === Recordings ===

/// Terminal session recording metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub terminal_cols: u32,
    pub terminal_rows: u32,
    pub duration_ms: u64,
    pub file_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new recording
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewRecording {
    pub session_id: Option<String>,
    pub name: String,
    #[serde(default = "default_terminal_cols")]
    pub terminal_cols: u32,
    #[serde(default = "default_terminal_rows")]
    pub terminal_rows: u32,
}

fn default_terminal_cols() -> u32 {
    80
}

fn default_terminal_rows() -> u32 {
    24
}

/// Request to update a recording (on stop)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateRecording {
    pub name: Option<String>,
    pub duration_ms: Option<u64>,
}

// === Port Forwarding (Phase 06.3) ===

/// Port forward type for SSH tunneling
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum PortForwardType {
    /// Local forwarding (-L): Access remote service through local port
    #[default]
    Local,
    /// Remote forwarding (-R): Expose local service to remote
    Remote,
    /// Dynamic SOCKS proxy (-D)
    Dynamic,
}


/// Port forward configuration for SSH sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub id: String,
    #[serde(default)]
    pub forward_type: PortForwardType,
    pub local_port: u16,
    /// Remote host (not needed for dynamic SOCKS proxy)
    pub remote_host: Option<String>,
    /// Remote port (not needed for dynamic SOCKS proxy)
    pub remote_port: Option<u16>,
    /// Bind address (default 127.0.0.1)
    pub bind_address: Option<String>,
    /// Whether this forward is enabled
    #[serde(default = "default_port_forward_enabled")]
    pub enabled: bool,
}

fn default_port_forward_enabled() -> bool {
    true
}

// === Persistent Tunnel Manager ===

/// Status of a managed tunnel
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TunnelStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}


/// Persistent tunnel definition (stored in SQLite)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    // SSH connection
    pub host: String,
    pub port: u16,
    pub profile_id: String,
    pub jump_host_id: Option<String>,
    /// Alternative jump: a Session used as the jump endpoint (mutually
    /// exclusive with jump_host_id).
    #[serde(default)]
    pub jump_session_id: Option<String>,
    // Forward config
    pub forward_type: PortForwardType,
    pub local_port: u16,
    pub bind_address: String,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    // Behavior
    pub auto_start: bool,
    pub auto_reconnect: bool,
    pub max_retries: u32,
    pub enabled: bool,
    // Metadata
    pub created_at: String,
    pub updated_at: String,
}

/// Request to create a new tunnel
#[derive(Debug, Clone, Deserialize)]
pub struct NewTunnel {
    pub name: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub profile_id: String,
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub jump_session_id: Option<String>,
    #[serde(default)]
    pub forward_type: PortForwardType,
    pub local_port: u16,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
}

/// Request to update a tunnel
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTunnel {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub profile_id: Option<String>,
    pub jump_host_id: Option<Option<String>>,
    pub jump_session_id: Option<Option<String>>,
    pub forward_type: Option<PortForwardType>,
    pub local_port: Option<u16>,
    pub bind_address: Option<String>,
    pub remote_host: Option<Option<String>>,
    pub remote_port: Option<Option<u16>>,
    pub auto_start: Option<bool>,
    pub auto_reconnect: Option<bool>,
    pub max_retries: Option<u32>,
    pub enabled: Option<bool>,
}

/// Runtime state of a tunnel (not persisted)
#[derive(Debug, Clone, Serialize)]
pub struct TunnelRuntimeState {
    pub id: String,
    pub status: TunnelStatus,
    pub uptime_secs: Option<u64>,
    pub bytes_tx: u64,
    pub bytes_rx: u64,
    pub last_error: Option<String>,
    pub retry_count: u32,
}

/// Combined tunnel definition + runtime state for API responses
#[derive(Debug, Clone, Serialize)]
pub struct TunnelWithState {
    #[serde(flatten)]
    pub tunnel: Tunnel,
    #[serde(flatten)]
    pub state: TunnelRuntimeState,
}

fn default_ssh_port() -> u16 { 22 }
fn default_bind_address() -> String { "127.0.0.1".to_string() }
fn default_true() -> bool { true }
fn default_max_retries() -> u32 { 10 }

// === Highlight Rules (Phase 11) ===

/// Highlight rule for keyword highlighting in terminal output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRule {
    pub id: String,
    /// User-friendly name for the rule
    pub name: String,
    /// Pattern to match (regex or literal string)
    pub pattern: String,
    /// True if pattern is regex, false if literal
    #[serde(default)]
    pub is_regex: bool,
    /// Whether pattern matching is case sensitive
    #[serde(default)]
    pub case_sensitive: bool,
    /// Whether to match whole words only
    #[serde(default)]
    pub whole_word: bool,
    /// Foreground color as hex (#RRGGBB)
    pub foreground: Option<String>,
    /// Background color as hex (#RRGGBB)
    pub background: Option<String>,
    /// Bold text style
    #[serde(default)]
    pub bold: bool,
    /// Italic text style
    #[serde(default)]
    pub italic: bool,
    /// Underline text style
    #[serde(default)]
    pub underline: bool,
    /// Category for organization (Network, Status, Security, Custom)
    #[serde(default = "default_highlight_category")]
    pub category: String,
    /// Priority for rule ordering (lower = higher priority)
    #[serde(default)]
    pub priority: i32,
    /// Whether the rule is enabled
    #[serde(default = "default_highlight_enabled")]
    pub enabled: bool,
    /// Session ID for session-specific rules (None = global rule)
    pub session_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_highlight_category() -> String {
    "Custom".to_string()
}

fn default_highlight_enabled() -> bool {
    true
}

/// Request to create a new highlight rule
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewHighlightRule {
    pub name: String,
    pub pattern: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    pub foreground: Option<String>,
    pub background: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default = "default_highlight_category")]
    pub category: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default = "default_highlight_enabled")]
    pub enabled: bool,
    /// Session ID for session-specific rules (None = global rule)
    pub session_id: Option<String>,
}

/// Request to update a highlight rule (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateHighlightRule {
    pub name: Option<String>,
    pub pattern: Option<String>,
    pub is_regex: Option<bool>,
    pub case_sensitive: Option<bool>,
    pub whole_word: Option<bool>,
    pub foreground: Option<Option<String>>,
    pub background: Option<Option<String>>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub category: Option<String>,
    pub priority: Option<i32>,
    pub enabled: Option<bool>,
    /// Session ID (Option<Option<>> to allow clearing to make global)
    pub session_id: Option<Option<String>>,
}

// === Change Control Models (Phase 15) ===

/// Status for a change control record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ChangeStatus {
    #[default]
    Draft,
    Executing,
    Validating,
    Complete,
    Failed,
    RolledBack,
    PendingReview,
    Approved,
    Rejected,
}


impl ChangeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Executing => "executing",
            Self::Validating => "validating",
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::RolledBack => "rolled_back",
            Self::PendingReview => "pending_review",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(Self::Draft),
            "executing" => Some(Self::Executing),
            "validating" => Some(Self::Validating),
            "complete" => Some(Self::Complete),
            "failed" => Some(Self::Failed),
            "rolled_back" => Some(Self::RolledBack),
            "pending_review" => Some(Self::PendingReview),
            "approved" => Some(Self::Approved),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

/// A step in a Method of Procedure (MOP)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopStep {
    pub id: String,
    pub order: i32,
    pub step_type: String,        // "pre_check" | "change" | "post_check" | "rollback"
    pub command: String,
    pub description: Option<String>,
    pub expected_output: Option<String>,
    pub status: String,           // "pending" | "running" | "passed" | "failed" | "skipped"
    pub output: Option<String>,   // Captured output when executed
    pub executed_at: Option<DateTime<Utc>>,
    // Execution source routing
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<String>, // "cli" | "quick_action" | "script"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_action_variables: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>, // "text" | "json"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_feedback: Option<String>,
    // Device targeting: which devices in the change session this step runs on.
    // Absent / "all" → all devices. "specific" → restricted to device_ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_ids: Option<Vec<String>>,
    // Config-deploy source payload: { template_id, deployment_id, instance_id, variables }.
    // Opaque to the backend; round-tripped so the UI can re-hydrate the deploy-template card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deploy_metadata: Option<serde_json::Value>,
}

/// A change control record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub status: ChangeStatus,
    pub mop_steps: Vec<MopStep>,
    /// Per-device step overrides keyed by session ID (JSON)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_overrides: Option<std::collections::HashMap<String, Vec<MopStep>>>,
    pub pre_snapshot_id: Option<String>,
    pub post_snapshot_id: Option<String>,
    pub ai_analysis: Option<String>,
    pub document_id: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub executed_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

/// Request to create a new change
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewChange {
    #[serde(default)]
    pub session_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub mop_steps: Vec<MopStep>,
    #[serde(default)]
    pub device_overrides: Option<std::collections::HashMap<String, Vec<MopStep>>>,
    #[serde(default)]
    pub document_id: Option<String>,
    pub created_by: String,
}

/// Request to update a change (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateChange {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub status: Option<ChangeStatus>,
    pub mop_steps: Option<Vec<MopStep>>,
    pub device_overrides: Option<Option<std::collections::HashMap<String, Vec<MopStep>>>>,
    pub document_id: Option<Option<String>>,
    pub session_id: Option<Option<String>>,
    pub pre_snapshot_id: Option<Option<String>>,
    pub post_snapshot_id: Option<Option<String>>,
    pub ai_analysis: Option<Option<String>>,
    pub executed_at: Option<Option<DateTime<Utc>>>,
    pub completed_at: Option<Option<DateTime<Utc>>>,
}

impl Change {
    pub fn _new(data: NewChange) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: data.session_id,
            name: data.name,
            description: data.description,
            status: ChangeStatus::Draft,
            mop_steps: data.mop_steps,
            device_overrides: data.device_overrides,
            pre_snapshot_id: None,
            post_snapshot_id: None,
            ai_analysis: None,
            document_id: data.document_id,
            created_by: data.created_by,
            created_at: now,
            updated_at: now,
            executed_at: None,
            completed_at: None,
        }
    }

    pub fn _apply_update(&mut self, update: UpdateChange) {
        if let Some(name) = update.name {
            self.name = name;
        }
        if let Some(desc) = update.description {
            self.description = desc;
        }
        if let Some(status) = update.status {
            self.status = status;
        }
        if let Some(steps) = update.mop_steps {
            self.mop_steps = steps;
        }
        if let Some(overrides) = update.device_overrides {
            self.device_overrides = overrides;
        }
        if let Some(pre_id) = update.pre_snapshot_id {
            self.pre_snapshot_id = pre_id;
        }
        if let Some(post_id) = update.post_snapshot_id {
            self.post_snapshot_id = post_id;
        }
        if let Some(analysis) = update.ai_analysis {
            self.ai_analysis = analysis;
        }
        if let Some(doc_id) = update.document_id {
            self.document_id = doc_id;
        }
        if let Some(sid) = update.session_id {
            self.session_id = sid;
        }
        if let Some(exec_at) = update.executed_at {
            self.executed_at = exec_at;
        }
        if let Some(comp_at) = update.completed_at {
            self.completed_at = comp_at;
        }
        self.updated_at = Utc::now();
    }
}

/// A snapshot of system state before or after a change
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub change_id: String,
    pub snapshot_type: String,    // "pre" | "post"
    pub commands: Vec<String>,    // Commands that were run to capture state
    pub output: String,           // Captured output (combined)
    pub captured_at: DateTime<Utc>,
}

/// Request to create a new snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSnapshot {
    pub change_id: String,
    pub snapshot_type: String,
    pub commands: Vec<String>,
    pub output: String,
}

impl Snapshot {
    pub fn _new(data: NewSnapshot) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            change_id: data.change_id,
            snapshot_type: data.snapshot_type,
            commands: data.commands,
            output: data.output,
            captured_at: Utc::now(),
        }
    }
}

// === Session Context Models (Phase 14) ===

// === Saved Topologies (Phase 20.1) ===

/// Saved topology - a named collection of devices and connections
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTopology {
    pub id: String,
    pub name: String,
    pub folder_id: Option<String>,
    pub sort_order: f64,
    pub shared: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to move a topology to a folder and/or reorder
#[derive(Debug, Deserialize)]
pub struct MoveTopologyRequest {
    pub folder_id: Option<String>,
    pub sort_order: f64,
}

/// Request to bulk delete topologies
#[derive(Debug, Deserialize)]
pub struct BulkDeleteTopologiesRequest {
    pub ids: Vec<String>,
}

/// Response from bulk delete topologies
#[derive(Debug, Serialize)]
pub struct BulkDeleteTopologiesResponse {
    pub deleted: i32,
    pub failed: i32,
}

/// Request to create a new topology
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTopologyRequest {
    pub name: String,
    /// Sessions to add as devices (optional on creation)
    #[serde(default)]
    pub session_ids: Vec<String>,
}

/// Request to update topology name
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTopologyRequest {
    pub name: String,
}

/// Request to set topology sharing state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareTopologyRequest {
    pub shared: bool,
}

/// Connection between two devices in a topology
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyConnection {
    pub id: String,
    pub topology_id: String,
    pub source_device_id: String,
    pub target_device_id: String,
    pub source_interface: Option<String>,
    pub target_interface: Option<String>,
    /// Protocol: "manual", "cdp", "lldp"
    pub protocol: String,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,

    // === Enhanced routing and styling (Phase 27-02) ===

    /// Waypoints for connection routing (JSON array of {x, y})
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waypoints: Option<String>,
    /// Curve style: "straight", "curved", "orthogonal"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve_style: Option<String>,

    /// Bundle ID for grouping multiple connections
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// Position in bundle for offset calculation
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_index: Option<i32>,

    /// Custom color (overrides status color)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Line style: "solid", "dashed", "dotted"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_style: Option<String>,
    /// Line width in pixels (default 2)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_width: Option<i32>,

    /// Embedded notes for documentation
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Request to update an existing topology connection. Every field is
/// optional — only fields that are `Some` will be written.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateConnectionRequest {
    pub source_interface: Option<Option<String>>,
    pub target_interface: Option<Option<String>>,
    pub label: Option<Option<String>>,
    pub waypoints: Option<Option<String>>,
    pub curve_style: Option<Option<String>>,
    pub bundle_id: Option<Option<String>>,
    pub bundle_index: Option<Option<i32>>,
    pub color: Option<Option<String>>,
    pub line_style: Option<Option<String>>,
    pub line_width: Option<Option<i32>>,
    pub notes: Option<Option<String>>,
}

/// Request to create a connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConnectionRequest {
    pub source_device_id: String,
    pub target_device_id: String,
    pub source_interface: Option<String>,
    pub target_interface: Option<String>,
    pub label: Option<String>,

    // === Enhanced routing and styling (Phase 27-02) ===

    /// Waypoints for connection routing (JSON array of {x, y})
    #[serde(default)]
    pub waypoints: Option<String>,
    /// Curve style: "straight", "curved", "orthogonal"
    #[serde(default)]
    pub curve_style: Option<String>,
    /// Bundle ID for grouping multiple connections
    #[serde(default)]
    pub bundle_id: Option<String>,
    /// Position in bundle for offset calculation
    #[serde(default)]
    pub bundle_index: Option<i32>,
    /// Custom color (overrides status color)
    #[serde(default)]
    pub color: Option<String>,
    /// Line style: "solid", "dashed", "dotted"
    #[serde(default)]
    pub line_style: Option<String>,
    /// Line width in pixels (default 2)
    #[serde(default)]
    pub line_width: Option<i32>,
    /// Embedded notes for documentation
    #[serde(default)]
    pub notes: Option<String>,
}

/// Topology device for canvas positioning
/// Links sessions to positions on the topology canvas
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyDevice {
    pub id: String,
    /// Parent topology ID
    pub topology_id: String,
    /// Link to session (nullable - device persists if session deleted)
    pub session_id: Option<String>,
    /// Profile used for SSH/discovery (nullable - resolved from session or set explicitly)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// SNMP profile for interface stats polling (nullable - may differ from SSH profile)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snmp_profile_id: Option<String>,
    /// Canvas position X (0-1000 coordinate space)
    pub x: f64,
    /// Canvas position Y (0-1000 coordinate space)
    pub y: f64,
    /// Device type: "router", "switch", "firewall", "server", "cloud", "access-point", "unknown"
    pub device_type: String,
    /// Denormalized device name from session
    pub name: String,
    /// Denormalized host from session
    pub host: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,

    // === Enrichment fields (populated by AI discovery) ===
    /// Platform/OS (e.g., "Arista EOS", "Cisco IOS-XE", "Juniper Junos")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// Software version (e.g., "4.28.0F", "17.3.4")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Hardware model (e.g., "cEOSLab", "C9300-48P")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Serial number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// Vendor (e.g., "Arista", "Cisco", "Juniper")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// Primary/management IP address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_ip: Option<String>,
    /// Device uptime string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<String>,
    /// Device status: "online", "offline", "warning", "unknown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Site/location
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    /// Device role
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Free-form notes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Request to update topology device position
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTopologyPosition {
    pub x: f64,
    pub y: f64,
}

/// Request to update topology device type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTopologyDeviceType {
    pub device_type: String,
}

/// Request to update topology device details (enrichment)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTopologyDeviceDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snmp_profile_id: Option<String>,
}

/// Full topology response with devices and connections
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyWithDetails {
    pub id: String,
    pub name: String,
    pub folder_id: Option<String>,
    pub sort_order: f64,
    pub devices: Vec<TopologyDevice>,
    pub connections: Vec<TopologyConnection>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Context entry for a session - captures tribal knowledge about devices
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionContext {
    pub id: String,
    pub session_id: String,
    pub issue: String,              // What was the problem
    pub root_cause: Option<String>, // Why it happened
    pub resolution: Option<String>, // How it was fixed
    pub commands: Option<String>,   // Helpful commands (newline separated)
    pub ticket_ref: Option<String>, // Ticket number reference
    pub author: String,             // Who added this context
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// === NetStacks-Crawler Sources (Phase 22) ===

/// NetStacks-Crawler source configuration for L2 topology discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetStacksCrawlerSource {
    pub id: String,
    pub name: String,
    /// FK to api_resources.id — replaces inline url + auth_type + username + credential
    pub api_resource_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new NetStacks-Crawler source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNetStacksCrawlerSource {
    pub name: String,
    /// FK to api_resources.id
    pub api_resource_id: String,
}

/// Request to update a NetStacks-Crawler source (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateNetStacksCrawlerSource {
    pub name: Option<String>,
    pub api_resource_id: Option<String>,
}

/// Request to create a new session context entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSessionContext {
    pub session_id: String,
    pub issue: String,
    pub root_cause: Option<String>,
    pub resolution: Option<String>,
    pub commands: Option<String>,
    pub ticket_ref: Option<String>,
    pub author: String,
}

/// Request to update a session context entry (all fields optional for partial updates)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateSessionContext {
    pub issue: Option<String>,
    pub root_cause: Option<Option<String>>,
    pub resolution: Option<Option<String>>,
    pub commands: Option<Option<String>>,
    pub ticket_ref: Option<Option<String>>,
}

impl SessionContext {
    pub fn _new(data: NewSessionContext) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: data.session_id,
            issue: data.issue,
            root_cause: data.root_cause,
            resolution: data.resolution,
            commands: data.commands,
            ticket_ref: data.ticket_ref,
            author: data.author,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn apply_update(&mut self, update: UpdateSessionContext) {
        if let Some(issue) = update.issue {
            self.issue = issue;
        }
        if let Some(root_cause) = update.root_cause {
            self.root_cause = root_cause;
        }
        if let Some(resolution) = update.resolution {
            self.resolution = resolution;
        }
        if let Some(commands) = update.commands {
            self.commands = commands;
        }
        if let Some(ticket_ref) = update.ticket_ref {
            self.ticket_ref = ticket_ref;
        }
        self.updated_at = Utc::now();
    }
}

// === Device Memory ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceMemory {
    pub id: String,
    pub session_id: String,
    pub role: Option<String>,
    pub criticality: Option<String>,
    pub standing_instructions: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceMemoryEntry {
    pub id: String,
    pub device_memory_id: String,
    pub date: String,
    pub source: String,
    pub author: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceMemoryWithEntries {
    #[serde(flatten)]
    pub memory: DeviceMemory,
    pub entries: Vec<DeviceMemoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewDeviceMemoryEntry {
    pub date: String,
    pub source: String,
    pub author: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateDeviceMemory {
    pub role: Option<Option<String>>,
    pub criticality: Option<Option<String>>,
    pub standing_instructions: Option<Option<String>>,
    pub notes: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateDeviceMemoryEntry {
    pub date: Option<String>,
    pub content: Option<String>,
}

// === Saved Tab Layouts (Phase 25) ===

/// Tab reference in a layout - supports mixed tab types (terminal, topology, document)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutTab {
    #[serde(rename = "type")]
    pub tab_type: String, // "terminal", "topology", "document"
    pub session_id: Option<String>,
    pub topology_id: Option<String>,
    pub document_id: Option<String>,
    pub document_name: Option<String>,
}

/// Saved tab layout configuration for split-view arrangements
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub session_ids: Vec<String>,       // Legacy: terminal-only (stored as JSON in DB)
    pub tabs: Option<Vec<LayoutTab>>,   // New: mixed tab types (stored as JSON in DB)
    pub orientation: String,             // "horizontal" or "vertical"
    pub sizes: Option<Vec<f64>>,        // Pane percentages, stored as JSON
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// === Topology Annotations (Phase 27) ===

/// Annotation type discriminator
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationType {
    Text,
    Shape,
    Line,
    Group,
}

impl AnnotationType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Shape => "shape",
            Self::Line => "line",
            Self::Group => "group",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Self::Text),
            "shape" => Some(Self::Shape),
            "line" => Some(Self::Line),
            "group" => Some(Self::Group),
            _ => None,
        }
    }
}

/// Topology annotation - visual documentation overlay
/// Stores type-specific data as JSON in element_data field
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyAnnotation {
    pub id: String,
    pub topology_id: String,
    pub annotation_type: AnnotationType,
    /// JSON blob with type-specific fields
    pub element_data: serde_json::Value,
    /// Z-index for layering (higher = in front)
    pub z_index: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a new topology annotation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAnnotationRequest {
    pub annotation_type: AnnotationType,
    pub element_data: serde_json::Value,
    #[serde(default)]
    pub z_index: i32,
}

/// Request to update a topology annotation
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateAnnotationRequest {
    pub element_data: Option<serde_json::Value>,
    pub z_index: Option<i32>,
}

/// Request to reorder annotations by z-index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderAnnotationsRequest {
    /// Ordered list of annotation IDs (first = lowest z-index)
    pub id_order: Vec<String>,
}

// === API Resources & Quick Actions ===

/// Auth type for API resources
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ApiResourceAuthType {
    None,
    BearerToken,
    Basic,
    ApiKeyHeader,
    CustomHeader,
    MultiStep,
}

impl std::fmt::Display for ApiResourceAuthType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "none"),
            Self::BearerToken => write!(f, "bearer_token"),
            Self::Basic => write!(f, "basic"),
            Self::ApiKeyHeader => write!(f, "api_key_header"),
            Self::CustomHeader => write!(f, "custom_header"),
            Self::MultiStep => write!(f, "multi_step"),
        }
    }
}

impl std::str::FromStr for ApiResourceAuthType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "none" => Ok(Self::None),
            "bearer_token" => Ok(Self::BearerToken),
            "basic" => Ok(Self::Basic),
            "api_key_header" => Ok(Self::ApiKeyHeader),
            "custom_header" => Ok(Self::CustomHeader),
            "multi_step" => Ok(Self::MultiStep),
            _ => Err(format!("Unknown auth type: {}", s)),
        }
    }
}

/// A step in a multi-step authentication flow
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthFlowStep {
    pub method: String,          // GET, POST, etc.
    pub path: String,            // e.g. "/api/v1/login"
    pub body: Option<String>,    // JSON body template with {{variables}}
    /// Per-step request headers (templated), e.g. {"Accept":"application/json"}.
    /// Defaults to empty for backward compatibility with existing rows.
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    /// When true, this step sends an `Authorization: Basic base64(user:pass)`
    /// header derived from the resource's stored username/password. Lets the
    /// step act like a Basic-Auth login that returns a token in the response.
    #[serde(default)]
    pub use_basic_auth: bool,
    pub extract_path: String,    // JSON path to extract from response
    pub store_as: String,        // Variable name to store extracted value
}

/// Encrypted credential bundle for an API resource.
/// Stored as encrypted JSON blob in api_resource_credentials table.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoredApiResourceCredential {
    pub token: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// API Resource - external API endpoint with auth configuration
/// Credentials (token, username, password) are stored encrypted in api_resource_credentials table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResource {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub auth_type: ApiResourceAuthType,
    pub auth_header_name: Option<String>,
    pub auth_header_prefix: Option<String>,
    pub auth_flow: Option<Vec<AuthFlowStep>>,
    pub default_headers: serde_json::Value,
    pub custom_headers: serde_json::Value,
    pub verify_ssl: bool,
    pub timeout_secs: i32,
    pub has_credentials: bool,
    pub test_path: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create an API resource
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateApiResourceRequest {
    pub name: String,
    pub base_url: String,
    #[serde(default = "default_auth_type")]
    pub auth_type: ApiResourceAuthType,
    pub auth_token: Option<String>,
    pub auth_username: Option<String>,
    pub auth_password: Option<String>,
    pub auth_header_name: Option<String>,
    pub auth_header_prefix: Option<String>,
    pub auth_flow: Option<Vec<AuthFlowStep>>,
    #[serde(default = "default_headers")]
    pub default_headers: serde_json::Value,
    #[serde(default = "default_custom_headers")]
    pub custom_headers: serde_json::Value,
    #[serde(default = "default_verify_ssl")]
    pub verify_ssl: bool,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i32,
    pub test_path: Option<String>,
}

fn default_auth_type() -> ApiResourceAuthType { ApiResourceAuthType::None }
fn default_headers() -> serde_json::Value { serde_json::json!({}) }
fn default_custom_headers() -> serde_json::Value { serde_json::json!([]) }
fn default_verify_ssl() -> bool { true }
fn default_timeout() -> i32 { 30 }

/// Request to update an API resource
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateApiResourceRequest {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub auth_type: Option<ApiResourceAuthType>,
    pub auth_token: Option<String>,
    pub auth_username: Option<String>,
    pub auth_password: Option<String>,
    pub auth_header_name: Option<String>,
    pub auth_header_prefix: Option<String>,
    pub auth_flow: Option<Vec<AuthFlowStep>>,
    pub default_headers: Option<serde_json::Value>,
    pub custom_headers: Option<serde_json::Value>,
    pub verify_ssl: Option<bool>,
    pub timeout_secs: Option<i32>,
    pub test_path: Option<String>,
}

/// Quick Action - saved one-click HTTP call
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAction {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub api_resource_id: String,
    pub method: String,
    pub path: String,
    pub headers: serde_json::Value,
    pub body: Option<String>,
    pub json_extract_path: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub sort_order: i32,
    pub category: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a quick action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateQuickActionRequest {
    pub name: String,
    pub description: Option<String>,
    pub api_resource_id: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default = "default_headers")]
    pub headers: serde_json::Value,
    pub body: Option<String>,
    pub json_extract_path: Option<String>,
    #[serde(default = "default_icon")]
    pub icon: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub category: Option<String>,
}

fn default_method() -> String { "GET".to_string() }
fn default_path() -> String { "/".to_string() }
fn default_icon() -> Option<String> { Some("zap".to_string()) }

/// Request to update a quick action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateQuickActionRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub api_resource_id: Option<String>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub headers: Option<serde_json::Value>,
    pub body: Option<String>,
    pub json_extract_path: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub sort_order: Option<i32>,
    pub category: Option<String>,
}

/// Result of executing a quick action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickActionResult {
    pub success: bool,
    pub status_code: u16,
    pub extracted_value: Option<serde_json::Value>,
    pub raw_body: Option<serde_json::Value>,
    pub error: Option<String>,
    pub duration_ms: u64,
    /// Final URL the request was sent to (after variable substitution).
    /// Surfaced in the UI for debugging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_url: Option<String>,
    /// Headers actually sent on the wire, with secret-looking values
    /// redacted to the last 4 characters. Surfaced in the UI for debugging
    /// auth issues; never includes the raw token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_headers: Option<Vec<(String, String)>>,
    /// Non-fatal advisory shown when a test "succeeded" but didn't really
    /// validate anything meaningful — e.g. only the base URL was reached
    /// because no Test Path is configured. The UI renders this as a warning
    /// (amber) rather than success (green).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Request to execute a quick action inline (without saving)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteInlineQuickActionRequest {
    pub api_resource_id: String,
    pub method: String,
    pub path: String,
    #[serde(default = "default_headers")]
    pub headers: serde_json::Value,
    pub body: Option<String>,
    pub json_extract_path: Option<String>,
    /// Test-time template variables (e.g. {"node_lookup": "ac:a0:..."}).
    /// Empty by default for backward compatibility.
    #[serde(default)]
    pub variables: std::collections::HashMap<String, String>,
}

/// Request to execute a quick action with user-provided template variables
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExecuteQuickActionRequest {
    #[serde(default)]
    pub variables: std::collections::HashMap<String, String>,
}

// === Quick Prompts (AI saved prompts) ===

/// Quick Prompt - user-saved AI prompts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickPrompt {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub is_favorite: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a quick prompt
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateQuickPromptRequest {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub is_favorite: bool,
}

/// Request to update a quick prompt
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateQuickPromptRequest {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub is_favorite: Option<bool>,
}

// === Agent Definitions (named agent configurations) ===

/// Named agent definition with custom system prompt and settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_iterations: i32,
    pub max_tokens: i32,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create an agent definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentDefinitionRequest {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: i32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i32,
}

fn default_max_iterations() -> i32 { 15 }
fn default_max_tokens() -> i32 { 4096 }

/// Request to update an agent definition (all fields optional for partial update)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateAgentDefinitionRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_iterations: Option<i32>,
    pub max_tokens: Option<i32>,
    pub enabled: Option<bool>,
}

// === MOP Execution Wizard (Phase 30) ===

/// Execution strategy for multi-device MOP execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStrategy {
    /// Execute on devices one at a time
    #[default]
    Sequential,
    /// Execute phases in parallel across devices
    ParallelByPhase,
}

impl std::fmt::Display for ExecutionStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sequential => write!(f, "sequential"),
            Self::ParallelByPhase => write!(f, "parallel_by_phase"),
        }
    }
}

impl std::str::FromStr for ExecutionStrategy {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "sequential" => Ok(Self::Sequential),
            "parallel_by_phase" => Ok(Self::ParallelByPhase),
            _ => Err(format!("Unknown execution strategy: {}", s)),
        }
    }
}

/// Control mode for MOP execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ControlMode {
    /// Approve each step individually
    #[serde(alias = "step_by_step")]
    Manual,
    /// Runs through automatically, pausing at phase boundaries
    #[serde(alias = "phase_based")]
    #[default]
    AutoRun,
    /// AI monitors and auto-approves unless issues detected
    #[serde(alias = "ai_supervised")]
    AiPilot,
}

impl std::fmt::Display for ControlMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Manual => write!(f, "manual"),
            Self::AutoRun => write!(f, "auto_run"),
            Self::AiPilot => write!(f, "ai_pilot"),
        }
    }
}

impl std::str::FromStr for ControlMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "manual" | "step_by_step" => Ok(Self::Manual),
            "auto_run" | "phase_based" => Ok(Self::AutoRun),
            "ai_pilot" | "ai_supervised" => Ok(Self::AiPilot),
            _ => Err(format!("Unknown control mode: {}", s)),
        }
    }
}

/// Overall execution status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    #[default]
    Pending,
    Running,
    Paused,
    Complete,
    Failed,
    Aborted,
}

impl std::fmt::Display for ExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Paused => write!(f, "paused"),
            Self::Complete => write!(f, "complete"),
            Self::Failed => write!(f, "failed"),
            Self::Aborted => write!(f, "aborted"),
        }
    }
}

impl std::str::FromStr for ExecutionStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "complete" => Ok(Self::Complete),
            "failed" => Ok(Self::Failed),
            "aborted" => Ok(Self::Aborted),
            _ => Err(format!("Unknown execution status: {}", s)),
        }
    }
}

/// Per-device execution status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeviceExecutionStatus {
    #[default]
    Pending,
    Running,
    Waiting,
    Complete,
    Failed,
    Skipped,
}

impl std::fmt::Display for DeviceExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Waiting => write!(f, "waiting"),
            Self::Complete => write!(f, "complete"),
            Self::Failed => write!(f, "failed"),
            Self::Skipped => write!(f, "skipped"),
        }
    }
}

impl std::str::FromStr for DeviceExecutionStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "complete" => Ok(Self::Complete),
            "failed" => Ok(Self::Failed),
            "skipped" => Ok(Self::Skipped),
            _ => Err(format!("Unknown device execution status: {}", s)),
        }
    }
}

/// Per-step execution status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StepExecutionStatus {
    #[default]
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
    Mocked,
}

impl std::fmt::Display for StepExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Passed => write!(f, "passed"),
            Self::Failed => write!(f, "failed"),
            Self::Skipped => write!(f, "skipped"),
            Self::Mocked => write!(f, "mocked"),
        }
    }
}

impl std::str::FromStr for StepExecutionStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "passed" => Ok(Self::Passed),
            "failed" => Ok(Self::Failed),
            "skipped" => Ok(Self::Skipped),
            "mocked" => Ok(Self::Mocked),
            _ => Err(format!("Unknown step execution status: {}", s)),
        }
    }
}

/// MOP Template - reusable MOP definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopTemplate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// JSON-encoded template steps with mock defaults
    pub mop_steps: Vec<MopStep>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Request to create a MOP template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMopTemplate {
    pub name: String,
    pub description: Option<String>,
    pub mop_steps: Vec<MopStep>,
    pub created_by: String,
}

/// Request to update a MOP template
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateMopTemplate {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub mop_steps: Option<Vec<MopStep>>,
}

impl MopTemplate {
    pub fn new(data: NewMopTemplate) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: data.name,
            description: data.description,
            mop_steps: data.mop_steps,
            created_by: data.created_by,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn apply_update(&mut self, update: UpdateMopTemplate) {
        if let Some(name) = update.name {
            self.name = name;
        }
        if let Some(desc) = update.description {
            self.description = desc;
        }
        if let Some(steps) = update.mop_steps {
            self.mop_steps = steps;
        }
        self.updated_at = Utc::now();
    }
}

fn default_plan_revision() -> i64 {
    1
}

/// MOP Execution - an instance of executing a MOP template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopExecution {
    pub id: String,
    pub template_id: Option<String>,
    pub plan_id: Option<String>,
    #[serde(default = "default_plan_revision")]
    pub plan_revision: i64,
    pub name: String,
    pub description: Option<String>,
    pub execution_strategy: ExecutionStrategy,
    pub control_mode: ControlMode,
    pub status: ExecutionStatus,
    pub current_phase: Option<String>,
    pub ai_analysis: Option<String>,
    pub ai_autonomy_level: Option<i32>,
    pub on_failure: String,
    pub pause_after_pre_checks: bool,
    pub pause_after_changes: bool,
    pub pause_after_post_checks: bool,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    /// JSON-encoded checkpoint for resume capability
    pub last_checkpoint: Option<String>,
}

fn default_created_by() -> String {
    "local".to_string()
}

fn default_on_failure() -> String {
    "pause".to_string()
}

/// Request to create a MOP execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMopExecution {
    pub template_id: Option<String>,
    pub plan_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub execution_strategy: ExecutionStrategy,
    pub control_mode: ControlMode,
    #[serde(default = "default_created_by")]
    pub created_by: String,
    #[serde(default = "default_on_failure")]
    pub on_failure: String,
    #[serde(default)]
    pub ai_autonomy_level: Option<i32>,
    #[serde(default)]
    pub pause_after_pre_checks: Option<bool>,
    #[serde(default)]
    pub pause_after_changes: Option<bool>,
    #[serde(default)]
    pub pause_after_post_checks: Option<bool>,
}

/// Request to update a MOP execution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateMopExecution {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub execution_strategy: Option<ExecutionStrategy>,
    pub control_mode: Option<ControlMode>,
    pub status: Option<ExecutionStatus>,
    pub current_phase: Option<Option<String>>,
    pub ai_analysis: Option<Option<String>>,
    pub ai_autonomy_level: Option<Option<i32>>,
    pub on_failure: Option<String>,
    pub pause_after_pre_checks: Option<bool>,
    pub pause_after_changes: Option<bool>,
    pub pause_after_post_checks: Option<bool>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub completed_at: Option<Option<DateTime<Utc>>>,
    pub last_checkpoint: Option<Option<String>>,
}

impl MopExecution {
    pub fn new(data: NewMopExecution) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            template_id: data.template_id,
            plan_id: data.plan_id,
            plan_revision: 1,
            name: data.name,
            description: data.description,
            execution_strategy: data.execution_strategy,
            control_mode: data.control_mode,
            status: ExecutionStatus::Pending,
            current_phase: None,
            ai_analysis: None,
            ai_autonomy_level: data.ai_autonomy_level,
            on_failure: data.on_failure,
            pause_after_pre_checks: data.pause_after_pre_checks.unwrap_or(true),
            pause_after_changes: data.pause_after_changes.unwrap_or(true),
            pause_after_post_checks: data.pause_after_post_checks.unwrap_or(true),
            created_by: data.created_by,
            created_at: now,
            updated_at: now,
            started_at: None,
            completed_at: None,
            last_checkpoint: None,
        }
    }

    pub fn apply_update(&mut self, update: UpdateMopExecution) {
        if let Some(name) = update.name {
            self.name = name;
        }
        if let Some(desc) = update.description {
            self.description = desc;
        }
        if let Some(strategy) = update.execution_strategy {
            self.execution_strategy = strategy;
        }
        if let Some(mode) = update.control_mode {
            self.control_mode = mode;
        }
        if let Some(status) = update.status {
            self.status = status;
        }
        if let Some(phase) = update.current_phase {
            self.current_phase = phase;
        }
        if let Some(analysis) = update.ai_analysis {
            self.ai_analysis = analysis;
        }
        if let Some(autonomy) = update.ai_autonomy_level {
            self.ai_autonomy_level = autonomy;
        }
        if let Some(on_failure) = update.on_failure {
            self.on_failure = on_failure;
        }
        if let Some(pause) = update.pause_after_pre_checks {
            self.pause_after_pre_checks = pause;
        }
        if let Some(pause) = update.pause_after_changes {
            self.pause_after_changes = pause;
        }
        if let Some(pause) = update.pause_after_post_checks {
            self.pause_after_post_checks = pause;
        }
        if let Some(started) = update.started_at {
            self.started_at = started;
        }
        if let Some(completed) = update.completed_at {
            self.completed_at = completed;
        }
        if let Some(checkpoint) = update.last_checkpoint {
            self.last_checkpoint = checkpoint;
        }
        self.updated_at = Utc::now();
    }
}

/// MOP Execution Device - per-device execution state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopExecutionDevice {
    pub id: String,
    pub execution_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    /// Display name — always populated. Falls back to device_id/session_id/"unknown".
    pub device_name: String,
    /// Display host — always populated. Falls back to device_id/session_id/"unknown".
    pub device_host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub device_order: i32,
    pub status: DeviceExecutionStatus,
    pub current_step_id: Option<String>,
    pub pre_snapshot_id: Option<String>,
    pub post_snapshot_id: Option<String>,
    pub ai_analysis: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
}

/// Request to create a MOP execution device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMopExecutionDevice {
    pub execution_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub device_order: i32,
}

/// Request to update a MOP execution device
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateMopExecutionDevice {
    pub device_order: Option<i32>,
    pub status: Option<DeviceExecutionStatus>,
    pub current_step_id: Option<Option<String>>,
    pub pre_snapshot_id: Option<Option<String>>,
    pub post_snapshot_id: Option<Option<String>>,
    pub ai_analysis: Option<Option<String>>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub completed_at: Option<Option<DateTime<Utc>>>,
    pub error_message: Option<Option<String>>,
}

impl MopExecutionDevice {
    pub fn new(data: NewMopExecutionDevice) -> Self {
        let fallback = data
            .device_id
            .clone()
            .or_else(|| data.session_id.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let device_name = data.device_name.clone().unwrap_or_else(|| fallback.clone());
        let device_host = data.device_host.clone().unwrap_or(fallback);
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            execution_id: data.execution_id,
            session_id: data.session_id,
            device_id: data.device_id,
            credential_id: data.credential_id,
            device_name,
            device_host,
            role: data.role,
            device_order: data.device_order,
            status: DeviceExecutionStatus::Pending,
            current_step_id: None,
            pre_snapshot_id: None,
            post_snapshot_id: None,
            ai_analysis: None,
            started_at: None,
            completed_at: None,
            error_message: None,
        }
    }

    pub fn apply_update(&mut self, update: UpdateMopExecutionDevice) {
        if let Some(order) = update.device_order {
            self.device_order = order;
        }
        if let Some(status) = update.status {
            self.status = status;
        }
        if let Some(step_id) = update.current_step_id {
            self.current_step_id = step_id;
        }
        if let Some(pre_id) = update.pre_snapshot_id {
            self.pre_snapshot_id = pre_id;
        }
        if let Some(post_id) = update.post_snapshot_id {
            self.post_snapshot_id = post_id;
        }
        if let Some(analysis) = update.ai_analysis {
            self.ai_analysis = analysis;
        }
        if let Some(started) = update.started_at {
            self.started_at = started;
        }
        if let Some(completed) = update.completed_at {
            self.completed_at = completed;
        }
        if let Some(error) = update.error_message {
            self.error_message = error;
        }
    }
}

/// Step type in a MOP execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MopStepType {
    PreCheck,
    Change,
    PostCheck,
    Rollback,
    ApiAction,
}

impl std::fmt::Display for MopStepType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PreCheck => write!(f, "pre_check"),
            Self::Change => write!(f, "change"),
            Self::PostCheck => write!(f, "post_check"),
            Self::Rollback => write!(f, "rollback"),
            Self::ApiAction => write!(f, "api_action"),
        }
    }
}

impl std::str::FromStr for MopStepType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pre_check" => Ok(Self::PreCheck),
            "change" => Ok(Self::Change),
            "post_check" => Ok(Self::PostCheck),
            "rollback" => Ok(Self::Rollback),
            "api_action" => Ok(Self::ApiAction),
            _ => Err(format!("Unknown MOP step type: {}", s)),
        }
    }
}

// === MOP Package Export/Import ===

/// Portable MOP step (strips instance-specific data like id, status, output)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopPackageStep {
    pub order: i32,
    pub step_type: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_action_variables: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
}

/// Embedded document in a MOP package
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopPackageDocument {
    pub name: String,
    pub content_type: String,
    pub content: String,
}

/// MOP procedure definition (portable)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopPackageProcedure {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub author: String,
    pub steps: Vec<MopPackageStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_overrides: Option<std::collections::HashMap<String, Vec<MopPackageStep>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<MopPackageDocument>,
}

/// Lineage tracking for enterprise version history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopPackageLineage {
    #[serde(default = "default_revision")]
    pub revision: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<String>,
}

fn default_revision() -> i32 { 1 }

impl Default for MopPackageLineage {
    fn default() -> Self {
        Self { revision: 1, parent_id: None, forked_from: None }
    }
}

/// Review state placeholder for enterprise peer review workflows
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MopPackageReview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub reviewers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
    #[serde(default)]
    pub comments: Vec<String>,
}

/// Enterprise-ready metadata envelope
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopPackageMetadata {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<String>,
    #[serde(default)]
    pub platform_hints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_duration_minutes: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_ticket: Option<String>,
    #[serde(default)]
    pub lineage: MopPackageLineage,
    #[serde(default)]
    pub review: MopPackageReview,
    #[serde(default)]
    pub custom: serde_json::Value,
}

impl Default for MopPackageMetadata {
    fn default() -> Self {
        Self {
            tags: Vec::new(),
            risk_level: None,
            platform_hints: Vec::new(),
            estimated_duration_minutes: None,
            change_ticket: None,
            lineage: MopPackageLineage::default(),
            review: MopPackageReview::default(),
            custom: serde_json::Value::Object(serde_json::Map::new()),
        }
    }
}

/// Top-level MOP package format for export/import
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopPackage {
    pub format: String,
    pub version: String,
    pub exported_at: String,
    pub source: String,
    pub mop: MopPackageProcedure,
    #[serde(default)]
    pub metadata: MopPackageMetadata,
}

/// Result returned from MOP package import
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopImportResult {
    pub change_id: String,
    pub name: String,
    pub steps_imported: usize,
    pub overrides_imported: usize,
    pub document_created: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// MOP Execution Step - per-step, per-device execution state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MopExecutionStep {
    pub id: String,
    pub execution_device_id: String,
    pub step_order: i32,
    pub step_type: MopStepType,
    pub command: String,
    pub description: Option<String>,
    pub expected_output: Option<String>,
    pub mock_enabled: bool,
    pub mock_output: Option<String>,
    pub status: StepExecutionStatus,
    pub output: Option<String>,
    pub ai_feedback: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    // Execution source routing
    #[serde(default = "default_execution_source")]
    pub execution_source: String, // "cli" | "quick_action" | "script"
    pub quick_action_id: Option<String>,
    pub quick_action_variables: Option<serde_json::Value>, // Record<string, string>
    pub script_id: Option<String>,
    pub script_args: Option<serde_json::Value>, // Record<string, unknown>
    pub paired_step_id: Option<String>,
    pub output_format: Option<String>, // "text" | "json"
}

fn default_execution_source() -> String {
    "cli".to_string()
}

/// Request to create a MOP execution step
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMopExecutionStep {
    pub execution_device_id: String,
    pub step_order: i32,
    pub step_type: MopStepType,
    pub command: String,
    pub description: Option<String>,
    pub expected_output: Option<String>,
    pub mock_enabled: bool,
    pub mock_output: Option<String>,
    // Execution source routing
    #[serde(default = "default_execution_source")]
    pub execution_source: String,
    pub quick_action_id: Option<String>,
    pub quick_action_variables: Option<serde_json::Value>,
    pub script_id: Option<String>,
    pub script_args: Option<serde_json::Value>,
    pub paired_step_id: Option<String>,
    pub output_format: Option<String>,
}

/// Request to update a MOP execution step
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateMopExecutionStep {
    pub step_order: Option<i32>,
    pub command: Option<String>,
    pub description: Option<Option<String>>,
    pub expected_output: Option<Option<String>>,
    pub mock_enabled: Option<bool>,
    pub mock_output: Option<Option<String>>,
    pub status: Option<StepExecutionStatus>,
    pub output: Option<Option<String>>,
    pub ai_feedback: Option<Option<String>>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub completed_at: Option<Option<DateTime<Utc>>>,
    pub duration_ms: Option<Option<i64>>,
    // Execution source routing
    pub execution_source: Option<String>,
    pub quick_action_id: Option<Option<String>>,
    pub quick_action_variables: Option<Option<serde_json::Value>>,
    pub script_id: Option<Option<String>>,
    pub script_args: Option<Option<serde_json::Value>>,
    pub paired_step_id: Option<Option<String>>,
    pub output_format: Option<Option<String>>,
}

impl MopExecutionStep {
    pub fn new(data: NewMopExecutionStep) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            execution_device_id: data.execution_device_id,
            step_order: data.step_order,
            step_type: data.step_type,
            command: data.command,
            description: data.description,
            expected_output: data.expected_output,
            mock_enabled: data.mock_enabled,
            mock_output: data.mock_output,
            status: StepExecutionStatus::Pending,
            output: None,
            ai_feedback: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            execution_source: data.execution_source,
            quick_action_id: data.quick_action_id,
            quick_action_variables: data.quick_action_variables,
            script_id: data.script_id,
            script_args: data.script_args,
            paired_step_id: data.paired_step_id,
            output_format: data.output_format,
        }
    }

    pub fn apply_update(&mut self, update: UpdateMopExecutionStep) {
        if let Some(order) = update.step_order {
            self.step_order = order;
        }
        if let Some(cmd) = update.command {
            self.command = cmd;
        }
        if let Some(desc) = update.description {
            self.description = desc;
        }
        if let Some(expected) = update.expected_output {
            self.expected_output = expected;
        }
        if let Some(mock) = update.mock_enabled {
            self.mock_enabled = mock;
        }
        if let Some(mock_out) = update.mock_output {
            self.mock_output = mock_out;
        }
        if let Some(status) = update.status {
            self.status = status;
        }
        if let Some(output) = update.output {
            self.output = output;
        }
        if let Some(feedback) = update.ai_feedback {
            self.ai_feedback = feedback;
        }
        if let Some(started) = update.started_at {
            self.started_at = started;
        }
        if let Some(completed) = update.completed_at {
            self.completed_at = completed;
        }
        if let Some(duration) = update.duration_ms {
            self.duration_ms = duration;
        }
        if let Some(source) = update.execution_source {
            self.execution_source = source;
        }
        if let Some(qa_id) = update.quick_action_id {
            self.quick_action_id = qa_id;
        }
        if let Some(qa_vars) = update.quick_action_variables {
            self.quick_action_variables = qa_vars;
        }
        if let Some(sid) = update.script_id {
            self.script_id = sid;
        }
        if let Some(sargs) = update.script_args {
            self.script_args = sargs;
        }
        if let Some(paired) = update.paired_step_id {
            self.paired_step_id = paired;
        }
        if let Some(fmt) = update.output_format {
            self.output_format = fmt;
        }
    }
}

// === Groups (Plan 1: Tab Groups Redesign) ===

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LaunchAction {
    Alongside,
    Replace,
    NewWindow,
    Ask,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GroupTab {
    pub r#type: String, // "terminal" | "topology" | "document"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub tabs: Vec<GroupTab>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_launch_action: Option<LaunchAction>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub tabs: Vec<GroupTab>,
    #[serde(default)]
    pub topology_id: Option<String>,
    #[serde(default)]
    pub default_launch_action: Option<LaunchAction>,
}

#[derive(Debug, serde::Deserialize)]
pub struct UpdateGroupRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tabs: Option<Vec<GroupTab>>,
    #[serde(default)]
    pub topology_id: Option<Option<String>>, // explicit `null` clears
    #[serde(default)]
    pub default_launch_action: Option<Option<LaunchAction>>,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_profile_serde_round_trip_includes_jump_host_id() {
        let json = r#"{
            "id": "p1",
            "name": "Test",
            "username": "admin",
            "auth_type": "password",
            "key_path": null,
            "port": 22,
            "keepalive_interval": 30,
            "connection_timeout": 10,
            "terminal_theme": null,
            "default_font_size": null,
            "default_font_family": null,
            "scrollback_lines": 1000,
            "local_echo": false,
            "auto_reconnect": false,
            "reconnect_delay": 5,
            "cli_flavor": "auto",
            "auto_commands": [],
            "jump_host_id": "jh-1",
            "created_at": "2026-05-02T00:00:00Z",
            "updated_at": "2026-05-02T00:00:00Z"
        }"#;
        let p: CredentialProfile = serde_json::from_str(json).unwrap();
        assert_eq!(p.jump_host_id.as_deref(), Some("jh-1"));
    }

    #[test]
    fn credential_profile_jump_host_id_defaults_to_none_when_missing() {
        let json = r#"{
            "id": "p1", "name": "Test", "username": "admin",
            "auth_type": "password", "key_path": null,
            "port": 22, "keepalive_interval": 30, "connection_timeout": 10,
            "terminal_theme": null, "default_font_size": null, "default_font_family": null,
            "scrollback_lines": 1000, "local_echo": false, "auto_reconnect": false,
            "reconnect_delay": 5, "cli_flavor": "auto", "auto_commands": [],
            "created_at": "2026-05-02T00:00:00Z",
            "updated_at": "2026-05-02T00:00:00Z"
        }"#;
        let p: CredentialProfile = serde_json::from_str(json).unwrap();
        assert!(p.jump_host_id.is_none());
    }

    #[test]
    fn auth_type_custom_header_serializes_as_snake_case_string() {
        let v = ApiResourceAuthType::CustomHeader;
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, "\"custom_header\"");
        let back: ApiResourceAuthType = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ApiResourceAuthType::CustomHeader);
    }

    #[test]
    fn auth_type_custom_header_round_trips_via_fromstr() {
        use std::str::FromStr;
        assert_eq!(
            ApiResourceAuthType::from_str("custom_header").unwrap(),
            ApiResourceAuthType::CustomHeader
        );
        assert_eq!(ApiResourceAuthType::CustomHeader.to_string(), "custom_header");
    }

    #[test]
    fn librenms_link_deserializes_without_stat_fields() {
        // Existing /devices/{hostname}/links response shape — port stats absent.
        let json = r#"{
            "id": 42,
            "local_device_id": 7,
            "local_port_id": 101,
            "local_port": "GigabitEthernet0/1",
            "remote_hostname": "sw2",
            "remote_port": "Gi0/3",
            "protocol": "cdp"
        }"#;
        let link: LibreNmsLink = serde_json::from_str(json).unwrap();
        assert_eq!(link.id, 42);
        assert_eq!(link.local_port, "GigabitEthernet0/1");
        assert!(link.local_port_in_rate_bps.is_none());
        assert!(link.local_port_out_rate_bps.is_none());
        assert!(link.local_port_speed_bps.is_none());
        assert!(link.local_port_in_errors.is_none());
        assert!(link.local_port_out_errors.is_none());
        assert!(link.local_port_oper_status.is_none());
    }

    #[test]
    fn librenms_link_deserializes_with_stat_fields() {
        // Enriched response shape — ?stats=true populates the optional fields.
        let json = r#"{
            "id": 42,
            "local_device_id": 7,
            "local_port_id": 101,
            "local_port": "Gi0/1",
            "remote_hostname": "sw2",
            "remote_port": "Gi0/3",
            "protocol": "lldp",
            "local_port_in_rate_bps": 250000000,
            "local_port_out_rate_bps": 100000000,
            "local_port_speed_bps": 1000000000,
            "local_port_in_errors": 0,
            "local_port_out_errors": 3,
            "local_port_oper_status": "up"
        }"#;
        let link: LibreNmsLink = serde_json::from_str(json).unwrap();
        assert_eq!(link.local_port_in_rate_bps, Some(250_000_000));
        assert_eq!(link.local_port_out_rate_bps, Some(100_000_000));
        assert_eq!(link.local_port_speed_bps, Some(1_000_000_000));
        assert_eq!(link.local_port_in_errors, Some(0));
        assert_eq!(link.local_port_out_errors, Some(3));
        assert_eq!(link.local_port_oper_status.as_deref(), Some("up"));
    }

    #[test]
    fn librenms_link_round_trip_with_stats_skips_none_on_serialize() {
        // None-valued stat fields should be omitted on serialize so the
        // structural-only response matches the legacy shape.
        let bare = LibreNmsLink {
            id: 1,
            local_device_id: 2,
            local_port_id: 3,
            local_port: "eth0".to_string(),
            remote_hostname: "host".to_string(),
            remote_port: "eth1".to_string(),
            protocol: "lldp".to_string(),
            local_port_in_rate_bps: None,
            local_port_out_rate_bps: None,
            local_port_speed_bps: None,
            local_port_in_errors: None,
            local_port_out_errors: None,
            local_port_oper_status: None,
        };
        let json = serde_json::to_string(&bare).unwrap();
        assert!(!json.contains("local_port_in_rate_bps"), "bare link should not emit stat keys: {}", json);
        let back: LibreNmsLink = serde_json::from_str(&json).unwrap();
        assert_eq!(back.local_port, "eth0");
    }
}

// === Hover Enrichment (Settings-UI managed) ===

/// One picked field from a source's HTTP response — surfaced in the hover popup.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PickedField {
    /// Dotted path inside the unwrapped response (e.g. "device.name").
    pub key: String,
    /// Human label shown in the popup row.
    pub label: String,
    /// One of: "string" | "datetime" | "uptime" | "bytes" | "status_pill".
    #[serde(default = "default_field_format")]
    pub format: String,
}
fn default_field_format() -> String { "string".into() }

/// A matcher recognises tokens in terminal output. Each matcher has one or
/// more regex patterns and a list of source assignments (which HTTP calls
/// to run when a token matches).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentMatcher {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub patterns: Vec<String>,
    #[serde(default)]
    pub cli_flavors: Vec<String>,
    #[serde(default = "default_matcher_priority")]
    pub priority: i32,
    #[serde(default)]
    pub is_builtin: bool,
    /// Source IDs assigned to this matcher (joined from enrichment_matcher_sources).
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
fn default_matcher_priority() -> i32 { 10 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEnrichmentMatcherRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub patterns: Vec<String>,
    #[serde(default)]
    pub cli_flavors: Vec<String>,
    #[serde(default = "default_matcher_priority")]
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateEnrichmentMatcherRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub patterns: Option<Vec<String>>,
    pub cli_flavors: Option<Vec<String>>,
    pub priority: Option<i32>,
}

/// A source is one HTTP call (or built-in) that produces enrichment data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichmentSource {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// "api_resource" — uses an API resource for HTTP. "builtin" — dns_ptr / oui_vendor.
    #[serde(default = "default_source_kind")]
    pub kind: String,
    pub api_resource_id: Option<String>,
    #[serde(default = "default_http_method")]
    pub method: String,
    #[serde(default)]
    pub path_template: String,
    #[serde(default)]
    pub response_unwrap: String,
    #[serde(default)]
    pub picked_fields: Vec<PickedField>,
    #[serde(default)]
    pub is_builtin: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
fn default_source_kind() -> String { "api_resource".into() }
fn default_http_method() -> String { "GET".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEnrichmentSourceRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_source_kind")]
    pub kind: String,
    pub api_resource_id: Option<String>,
    #[serde(default = "default_http_method")]
    pub method: String,
    #[serde(default)]
    pub path_template: String,
    #[serde(default)]
    pub response_unwrap: String,
    #[serde(default)]
    pub picked_fields: Vec<PickedField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateEnrichmentSourceRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub api_resource_id: Option<Option<String>>,  // double-Option so caller can clear
    pub method: Option<String>,
    pub path_template: Option<String>,
    pub response_unwrap: Option<String>,
    pub picked_fields: Option<Vec<PickedField>>,
}
