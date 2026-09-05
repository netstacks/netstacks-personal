//! API route handlers for NetStacks
//!
//! Exposes the DataProvider via REST API endpoints.

use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::error::Error as StdError;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio_stream::wrappers::ReceiverStream;

use crate::ai;
use crate::models::*;
use crate::providers::{DataProvider, ProviderError};
use crate::secret::SecretString;
use crate::sftp::{FileEntry, SftpAuth, SftpConfig, SftpError, SftpManager};
use crate::ssh::{
    self, build_ssh_config_from_session, BulkCommandRequest, BulkCommandResponse, SshConfig,
};

/// Server-side state for AI "config mode" (AUDIT FIX EXEC-002).
///
/// Previously the AI's `agent-chat` request body carried an
/// `allow_config_changes: bool` that lifted the in-prompt safety rules. That
/// is a self-asserted toggle from a (potentially XSS-compromised) frontend.
/// We now require the user to call `POST /api/ai/config-mode/enable` with
/// the current master password; that flips a short-lived server-side flag
/// (default 5 min) that the chat handler consults instead of trusting the
/// request body.
#[derive(Debug, Clone, Copy)]
pub struct ConfigModeState {
    /// Wall-clock instant after which the state must be treated as off.
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// Shared application state
pub struct AppState {
    pub provider: Arc<dyn DataProvider>,
    pub auth_token: String,
    /// Cached sanitizer for AI data scrubbing (None = needs rebuild from settings)
    pub sanitizer: Arc<tokio::sync::RwLock<Option<ai::sanitizer::Sanitizer>>>,
    /// Credentials-only sanitizer for clipboard history (built lazily, cleared
    /// with `sanitizer` whenever `ai.sanitization_config` changes).
    pub clip_sanitizer: Arc<tokio::sync::RwLock<Option<ai::sanitizer::Sanitizer>>>,
    // Phase 02: Task management
    pub task_store: crate::tasks::TaskStore,
    pub task_registry: Arc<crate::tasks::TaskRegistry>,
    pub task_executor: Arc<crate::tasks::AgentTaskExecutor>,
    pub progress_broadcaster: crate::tasks::ProgressBroadcaster,
    // Phase 06: MCP client management (wrapped in RwLock for task executor access)
    pub mcp_client_manager: Arc<tokio::sync::RwLock<crate::integrations::McpClientManager>>,
    // SSH certificate authentication
    pub cert_manager: Option<Arc<crate::cert_manager::CertManager>>,
    // Database pool for direct queries (docs creation from logging/recording)
    pub pool: sqlx::sqlite::SqlitePool,
    // SSH tunnel manager
    pub tunnel_manager: Arc<crate::tunnels::TunnelManager>,
    /// AI config-mode override (AUDIT FIX EXEC-002).
    pub config_mode: Arc<tokio::sync::RwLock<Option<ConfigModeState>>>,
    /// AUDIT FIX (REMOTE-001): pending host-key fingerprint prompts. When
    /// the SSH handshake hits an unknown or changed host key, the russh
    /// `check_server_key` callback inserts a pending entry here and blocks
    /// on a oneshot channel waiting for the user to click Accept or
    /// Reject in the modal. The frontend polls
    /// `GET /api/host-keys/prompts` and resolves via the approve/reject
    /// endpoints below.
    pub host_key_approvals: Arc<crate::ssh::approvals::HostKeyApprovalService>,
    /// Shared per-process cache of extracted multi-step auth variables, keyed
    /// by API resource id. Lets a sequence of Quick Action calls reuse one
    /// login session instead of re-running the auth flow per request. Backed
    /// by `tokio::sync::RwLock` because we're in an async context.
    pub auth_cache: crate::api_resource_client::AuthCache,
    pub remote_agent_manager: Arc<crate::remote_agents::RemoteAgentManager>,
    pub output_cache: Arc<tokio::sync::RwLock<OutputCache>>,
    /// Hover-enrichment matcher registry (token patterns → source assignments).
    /// Rebuilt from DB on `POST /enrichment/reload`.
    pub enrichment: Arc<tokio::sync::RwLock<crate::enrich::MatcherRegistry>>,
    /// Per-(host, token) enrichment result cache (TTL-based).
    pub enrichment_cache: Arc<tokio::sync::RwLock<crate::enrich::EnrichmentCache>>,
    /// Enrichment sources keyed by name, used by the pipeline to resolve a
    /// matcher's source list into runnable HTTP calls / built-ins.
    pub enrichment_sources: Arc<
        tokio::sync::RwLock<std::collections::HashMap<String, crate::models::EnrichmentSource>>,
    >,
    /// MOP execution devices with a phase / step / rollback currently running
    /// (execution-device id). A second request for the same device gets
    /// 409 `PHASE_IN_PROGRESS` instead of typing into the same shell twice.
    pub mop_phase_locks: std::sync::Mutex<std::collections::HashSet<String>>,
}

pub struct OutputCache {
    entries: std::collections::HashMap<String, CachedOutput>,
}

struct CachedOutput {
    full_output: String,
    created_at: std::time::Instant,
}

impl OutputCache {
    pub fn new() -> Self {
        Self {
            entries: std::collections::HashMap::new(),
        }
    }

    pub fn insert(&mut self, request_id: String, output: String) {
        self.entries
            .retain(|_, v| v.created_at.elapsed() < std::time::Duration::from_secs(300));
        // Hard cap: keep at most 200 entries and 256 MB total to prevent unbounded growth.
        const MAX_ENTRIES: usize = 200;
        const MAX_BYTES: usize = 256 * 1024 * 1024;
        let total_bytes: usize = self.entries.values().map(|v| v.full_output.len()).sum();
        if self.entries.len() >= MAX_ENTRIES || total_bytes + output.len() > MAX_BYTES {
            // Evict the oldest entry.
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.created_at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }
        self.entries.insert(
            request_id,
            CachedOutput {
                full_output: output,
                created_at: std::time::Instant::now(),
            },
        );
    }

    pub fn get_page(&self, request_id: &str, offset: usize, limit: usize) -> Option<OutputPage> {
        let entry = self.entries.get(request_id)?;
        if entry.created_at.elapsed() > std::time::Duration::from_secs(300) {
            return None;
        }
        let total = entry.full_output.len();
        let start = offset.min(total);
        let end = (start + limit).min(total);
        let safe_start = entry.full_output.floor_char_boundary(start);
        let safe_end = entry.full_output.floor_char_boundary(end);
        Some(OutputPage {
            content: entry.full_output[safe_start..safe_end].to_string(),
            offset: safe_start,
            length: safe_end - safe_start,
            total_bytes: total,
            has_more: safe_end < total,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct OutputPage {
    pub content: String,
    pub offset: usize,
    pub length: usize,
    pub total_bytes: usize,
    pub has_more: bool,
}

/// Default duration the config-mode override stays active after the user
/// re-authenticates. Picked to be long enough for an interactive conversation
/// but short enough that an unattended app does not stay in a destructive
/// state for hours.
pub const CONFIG_MODE_TTL_SECS: i64 = 300;

/// Check whether AI config mode is currently active.
///
/// Read-locks the state, expires it lazily if the deadline has passed, and
/// returns true only when both the flag is set AND `expires_at > now()`.
pub async fn is_config_mode_active(state: &AppState) -> bool {
    let now = chrono::Utc::now();
    let snapshot = *state.config_mode.read().await;
    match snapshot {
        Some(s) if s.expires_at > now => true,
        Some(_) => {
            // Expired — clear lazily so the next caller sees the cleared
            // state without paying the lazy-clear cost again.
            let mut w = state.config_mode.write().await;
            if let Some(s) = *w {
                if s.expires_at <= chrono::Utc::now() {
                    *w = None;
                }
            }
            false
        }
        None => false,
    }
}

/// Auth middleware that validates Bearer token on all API routes (except /api/health).
///
/// Extracts the `Authorization: Bearer <token>` header and compares it to the
/// per-session auth token stored in AppState using a constant-time comparison.
/// Returns 401 for missing or invalid tokens.
///
/// AUDIT FIX (AUTH-001): The exemption is an exact-path match on `/api/health`.
/// The previous `ends_with("/health")` test let any parameterized route ending
/// in the literal string `health` (e.g. `PUT /api/settings/health`,
/// `DELETE /api/sessions/health`, `GET /api/lookup/dns/health`) bypass auth.
///
/// AUDIT FIX (CRYPTO-007 partial / AUTH-006 partial): token comparison uses
/// `subtle::ConstantTimeEq` to avoid timing-based byte-by-byte leaks.
pub async fn auth_middleware(
    State(app_state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    use subtle::ConstantTimeEq;

    // Exempt health endpoint from auth — exact match only.
    if request.uri().path() == "/api/health" {
        return next.run(request).await;
    }

    // Extract Authorization header
    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(header) if header.starts_with("Bearer ") => {
            let token = &header[7..];
            if token
                .as_bytes()
                .ct_eq(app_state.auth_token.as_bytes())
                .into()
            {
                next.run(request).await
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "unauthorized"})),
                )
                    .into_response()
            }
        }
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "unauthorized"})),
        )
            .into_response(),
    }
}

/// API error response
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
    pub code: String,
}

/// Convert ProviderError to HTTP response
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (status_for_error_code(&self.code), Json(self)).into_response()
    }
}

/// Map an `ApiError.code` to its HTTP status.
///
/// Every code a handler can emit must be listed here, otherwise a client
/// mistake (bad path, bad input, missing row) is reported to the UI as an
/// internal server error and the message is treated as a crash rather than
/// something the engineer can act on. Unknown codes still fall to 500 so a
/// new code shows up in testing as a loud 500 rather than a silent 400.
pub fn status_for_error_code(code: &str) -> StatusCode {
    match code {
        "NOT_FOUND" | "SESSION_NOT_FOUND" | "SHELL_NOT_FOUND" => StatusCode::NOT_FOUND,
        "GONE" | "SESSION_CLOSED" => StatusCode::GONE,
        "VAULT_LOCKED" | "ACCESS_DENIED" | "PERMISSION_DENIED" | "FS_PATH_DENIED"
        | "APPROVAL_REQUIRED" => StatusCode::FORBIDDEN,
        "INVALID_PASSWORD" | "AUTH_FAILED" | "AUTH_MISSING" | "KEY_ERROR" => {
            StatusCode::UNAUTHORIZED
        }
        "VALIDATION"
        | "VALIDATION_ERROR"
        | "INVALID_INPUT"
        | "INVALID_PATH"
        | "INVALID_URL"
        | "INVALID_FORMAT"
        | "INVALID_STEP"
        | "UNSUPPORTED_VERSION"
        | "NOT_CONFIGURED" => StatusCode::BAD_REQUEST,
        "CONFLICT" | "INVALID_STATE" | "PHASE_IN_PROGRESS" => StatusCode::CONFLICT,
        "GIT_CMD_FAILED" => StatusCode::UNPROCESSABLE_ENTITY,
        "CONNECTION_FAILED" | "CHANNEL_ERROR" => StatusCode::BAD_GATEWAY,
        "RATE_LIMITED" => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl From<crate::db::DbError> for ApiError {
    fn from(err: crate::db::DbError) -> Self {
        // Match structurally: `DbError::Sqlx` displays as "Database error: no rows
        // returned…", so the old `to_string().contains("RowNotFound")` check (which
        // only matched the Debug form) never fired and every missing row was a 500.
        let code = match &err {
            crate::db::DbError::Sqlx(sqlx::Error::RowNotFound) => "NOT_FOUND",
            _ => "DATABASE_ERROR",
        };
        ApiError {
            error: err.to_string(),
            code: code.to_string(),
        }
    }
}

impl From<ProviderError> for ApiError {
    fn from(err: ProviderError) -> Self {
        let (code, error) = match &err {
            ProviderError::NotFound(msg) => ("NOT_FOUND".to_string(), msg.clone()),
            ProviderError::VaultLocked => (
                "VAULT_LOCKED".to_string(),
                "Vault is locked - unlock with master password first".to_string(),
            ),
            ProviderError::InvalidPassword => (
                "INVALID_PASSWORD".to_string(),
                "Invalid master password".to_string(),
            ),
            ProviderError::_AccessDenied => {
                ("ACCESS_DENIED".to_string(), "Access denied".to_string())
            }
            ProviderError::Validation(msg) => ("VALIDATION".to_string(), msg.clone()),
            ProviderError::Conflict(msg) => ("CONFLICT".to_string(), msg.clone()),
            ProviderError::Database(msg) => ("DATABASE_ERROR".to_string(), msg.clone()),
            ProviderError::Encryption(msg) => ("ENCRYPTION_ERROR".to_string(), msg.clone()),
        };

        ApiError { error, code }
    }
}

/// Lift an `ApiResourceClient` error into an `ApiError`. Centralizes the code
/// string so handlers don't each invent one.
fn api_resource_client_err(err: crate::api_resource_client::ApiResourceClientError) -> ApiError {
    use crate::api_resource_client::ApiResourceClientError;
    let code = match &err {
        ApiResourceClientError::ResourceNotFound(_) => "NOT_FOUND",
        ApiResourceClientError::Provider(_) => "PROVIDER_ERROR",
        ApiResourceClientError::Http(_) => "HTTP_CLIENT",
        ApiResourceClientError::AuthFlow(_) => "AUTH_FLOW",
    };
    ApiError {
        error: err.to_string(),
        code: code.to_string(),
    }
}

// === Health & Info Endpoints ===

/// Health check endpoint
pub async fn health() -> &'static str {
    "ok"
}

/// Application info
#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub mode: String,
}

pub async fn app_info(State(state): State<Arc<AppState>>) -> Json<AppInfo> {
    let mode = match state.provider.connection_mode() {
        ConnectionMode::Local => "Local",
        ConnectionMode::Controller { .. } => "Controller",
    };

    Json(AppInfo {
        name: "NetStacks".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        mode: mode.to_string(),
    })
}

// === Session Endpoints ===

/// List all sessions
pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Session>>, ApiError> {
    let sessions = state.provider.list_sessions().await?;
    Ok(Json(sessions))
}

/// Get a single session
pub async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Session>, ApiError> {
    let session = state.provider.get_session(&id).await?;
    Ok(Json(session))
}

/// Create a new session
pub async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(new_session): Json<NewSession>,
) -> Result<(StatusCode, Json<Session>), ApiError> {
    let session = state.provider.create_session(new_session).await?;
    Ok((StatusCode::CREATED, Json(session)))
}

/// Update an existing session
pub async fn update_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateSession>,
) -> Result<Json<Session>, ApiError> {
    let session = state.provider.update_session(&id, update).await?;
    Ok(Json(session))
}

/// List every session/tunnel/profile that uses this session as its jump.
/// Used by the SessionSettingsDialog to render a "Used as jump by N" hint.
pub async fn get_session_jump_dependents(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<crate::models::JumpDependents>, ApiError> {
    // Confirm session exists so a typo'd id surfaces a 404, not an empty list.
    let _ = state.provider.get_session(&id).await?;
    let deps = state.provider.find_session_jump_dependents(&id).await?;
    Ok(Json(deps))
}

/// Delete a session
pub async fn delete_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_session(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Bulk delete request
#[derive(Debug, Deserialize)]
pub struct BulkDeleteRequest {
    pub ids: Vec<String>,
}

/// Bulk delete response
#[derive(Debug, Serialize)]
pub struct BulkDeleteResponse {
    pub deleted: usize,
    pub failed: usize,
}

/// Bulk delete multiple sessions. Wrapped in a single DB transaction
/// (see LocalProvider::bulk_delete_sessions) so a mid-batch failure
/// rolls back the whole set rather than leaving the table half-deleted
/// with an opaque (deleted=4, failed=1) response.
pub async fn bulk_delete_sessions(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BulkDeleteRequest>,
) -> Result<Json<BulkDeleteResponse>, ApiError> {
    let (deleted, failed) = state.provider.bulk_delete_sessions(&req.ids).await?;
    Ok(Json(BulkDeleteResponse { deleted, failed }))
}

// === Folder Endpoints ===

/// List all folders
pub async fn list_folders(
    State(state): State<Arc<AppState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<Folder>>, ApiError> {
    let scope = params.get("scope").map(|s| s.as_str());
    let folders = state.provider.list_folders(scope).await?;
    Ok(Json(folders))
}

/// Get a single folder
pub async fn get_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Folder>, ApiError> {
    let folder = state.provider.get_folder(&id).await?;
    Ok(Json(folder))
}

/// Create a new folder
pub async fn create_folder(
    State(state): State<Arc<AppState>>,
    Json(new_folder): Json<NewFolder>,
) -> Result<(StatusCode, Json<Folder>), ApiError> {
    let folder = state.provider.create_folder(new_folder).await?;
    Ok((StatusCode::CREATED, Json(folder)))
}

/// Update an existing folder
pub async fn update_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateFolder>,
) -> Result<Json<Folder>, ApiError> {
    let folder = state.provider.update_folder(&id, update).await?;
    Ok(Json(folder))
}

/// Delete a folder
pub async fn delete_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_folder(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Vault/Credential Endpoints ===

/// Get vault status
pub async fn vault_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<VaultStatus>, ApiError> {
    let has_master_password = state.provider.has_master_password().await?;
    let unlocked = state.provider.is_unlocked();

    Ok(Json(VaultStatus {
        unlocked,
        has_master_password,
    }))
}

/// Request body for setting master password
#[derive(Debug, Deserialize)]
pub struct SetPasswordRequest {
    pub password: SecretString,
}

/// Set master password (first time setup)
pub async fn set_master_password(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SetPasswordRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .set_master_password(req.password.expose())
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Request body for unlocking vault
#[derive(Debug, Deserialize)]
pub struct UnlockRequest {
    pub password: SecretString,
}

/// Unlock the vault
pub async fn unlock_vault(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UnlockRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.unlock(req.password.expose()).await?;
    crate::docs::migrate_unencrypted_notes_in_background(
        state.pool.clone(),
        state.provider.clone(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Lock the vault
pub async fn lock_vault(State(state): State<Arc<AppState>>) -> StatusCode {
    state.provider.lock();
    StatusCode::NO_CONTENT
}

/// Request body for changing the master password
#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: SecretString,
    pub new_password: SecretString,
}

/// Rotate the master password. Vault must be unlocked. Re-encrypts every
/// stored credential / token / API key / secure note under the new key in
/// a single transaction.
pub async fn change_master_password(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .change_master_password(req.old_password.expose(), req.new_password.expose())
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Request body for wiping the vault
#[derive(Debug, Deserialize)]
pub struct WipeVaultRequest {
    pub confirm_password: SecretString,
}

/// Wipe every vault-encrypted value and reset the master-password record.
/// Caller must supply the current password as confirmation.
pub async fn wipe_vault(
    State(state): State<Arc<AppState>>,
    Json(req): Json<WipeVaultRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .wipe_vault(req.confirm_password.expose())
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Forgot-password reset: back up the DB, then wipe the vault WITHOUT the old
/// password and clear biometric enrollment. Everything non-secret is kept.
/// Callable while the vault is locked; still gated by the agent bearer token.
pub async fn reset_vault(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Back up the current DB (including vault) first so a mistaken reset is
    // recoverable manually.
    let db_path = crate::db::resolve_db_path();
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let backup = {
        let mut p = db_path.as_os_str().to_owned();
        p.push(format!(".bak-vault-reset-{ts}"));
        std::path::PathBuf::from(p)
    };
    let backup_str = backup.to_string_lossy().to_string();
    crate::db_backup::export_db(&state.pool, &backup_str, true)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to back up database before reset: {e}"),
            code: "INTERNAL_ERROR".to_string(),
        })?;

    // Wipe the vault (no password verification).
    state.provider.reset_vault().await?;

    // Clear biometric enrollment — the keychain entry holds the now-defunct old
    // password, so Touch ID must not auto-unlock with a stale secret. Best-effort.
    let _ = crate::biometric::BiometricVaultStore::delete().await;
    let _ = state
        .provider
        .set_setting("vault.biometric_enabled", serde_json::json!(false))
        .await;

    Ok(Json(
        serde_json::json!({ "ok": true, "backup": backup_str }),
    ))
}

// === Vault Biometric (Touch ID) Endpoints — macOS-only meaningful ===

/// Status of biometric vault unlock for the current device.
#[derive(Serialize)]
pub struct BiometricStatus {
    /// Whether the agent build supports biometric unlock at all (macOS today).
    pub supported: bool,
    /// Whether a keychain entry currently exists.
    pub enrolled: bool,
    /// Whether the user has flipped the toggle on (UI gating; may diverge
    /// from `enrolled` if the keychain entry was wiped externally).
    pub enabled: bool,
}

/// GET `/vault/biometric/status` — does NOT trigger Touch ID.
pub async fn biometric_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BiometricStatus>, ApiError> {
    let supported = crate::biometric::BiometricVaultStore::is_supported();
    let enrolled = supported && crate::biometric::BiometricVaultStore::is_enrolled();
    let enabled_setting = state
        .provider
        .get_setting("vault.biometric_enabled")
        .await
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(Json(BiometricStatus {
        supported,
        enrolled,
        enabled: enabled_setting && enrolled,
    }))
}

/// Request body for enabling biometric unlock — carries the master password
/// to verify before enrolling.
#[derive(Debug, Deserialize)]
pub struct EnableBiometricRequest {
    pub password: SecretString,
}

fn biometric_err_to_api(e: crate::biometric::BiometricError) -> ApiError {
    use crate::biometric::BiometricError;
    let code = match &e {
        #[cfg(not(target_os = "macos"))]
        BiometricError::Unsupported => "BIOMETRIC_UNSUPPORTED",
        #[cfg(target_os = "macos")]
        BiometricError::NotEnrolled => "BIOMETRIC_NOT_ENROLLED",
        #[cfg(target_os = "macos")]
        BiometricError::UserCancelled => "BIOMETRIC_CANCELLED",
        #[cfg(target_os = "macos")]
        BiometricError::Other(_) => "BIOMETRIC_ERROR",
    };
    ApiError {
        error: e.to_string(),
        code: code.to_string(),
    }
}

/// POST `/vault/biometric/enable` — verify password, store in keychain, flip setting.
pub async fn enable_biometric(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EnableBiometricRequest>,
) -> Result<StatusCode, ApiError> {
    if !crate::biometric::BiometricVaultStore::is_supported() {
        return Err(ApiError {
            error: "Biometric unlock is not supported on this platform".to_string(),
            code: "BIOMETRIC_UNSUPPORTED".to_string(),
        });
    }
    // Verify the password is correct by unlocking. (Idempotent if already unlocked.)
    state.provider.unlock(req.password.expose()).await?;
    crate::docs::migrate_unencrypted_notes_in_background(
        state.pool.clone(),
        state.provider.clone(),
    )
    .await;
    crate::biometric::BiometricVaultStore::store(req.password.expose().to_string())
        .await
        .map_err(biometric_err_to_api)?;
    state
        .provider
        .set_setting("vault.biometric_enabled", serde_json::json!(true))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST `/vault/biometric/unlock` — Touch ID prompt then unlock vault.
pub async fn unlock_with_biometric(
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let password = crate::biometric::BiometricVaultStore::retrieve()
        .await
        .map_err(biometric_err_to_api)?;
    match state.provider.unlock(&password).await {
        Ok(_) => {
            crate::docs::migrate_unencrypted_notes_in_background(
                state.pool.clone(),
                state.provider.clone(),
            )
            .await;
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) => {
            // Stored password no longer matches the vault — most likely the
            // master password was changed somewhere else. Wipe the stale entry
            // and clear the toggle so the user gets a clean re-enrollment path.
            let _ = crate::biometric::BiometricVaultStore::delete().await;
            let _ = state
                .provider
                .set_setting("vault.biometric_enabled", serde_json::json!(false))
                .await;
            Err(e.into())
        }
    }
}

/// DELETE `/vault/biometric` — remove keychain entry, clear setting.
pub async fn disable_biometric(State(state): State<Arc<AppState>>) -> Result<StatusCode, ApiError> {
    crate::biometric::BiometricVaultStore::delete()
        .await
        .map_err(biometric_err_to_api)?;
    state
        .provider
        .set_setting("vault.biometric_enabled", serde_json::json!(false))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Store credential for a session
pub async fn store_credential(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(credential): Json<NewCredential>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .store_credential(&session_id, credential)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete credential for a session
pub async fn delete_credential(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_credential(&session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Mapped Keys Endpoints (Global) ===

/// List all mapped keys
pub async fn list_mapped_keys(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<MappedKey>>, ApiError> {
    let keys = state.provider.list_mapped_keys().await?;
    Ok(Json(keys))
}

/// Create a mapped key
pub async fn create_mapped_key(
    State(state): State<Arc<AppState>>,
    Json(new_key): Json<NewMappedKey>,
) -> Result<(StatusCode, Json<MappedKey>), ApiError> {
    let key = state.provider.create_mapped_key(new_key).await?;
    Ok((StatusCode::CREATED, Json(key)))
}

/// Update a mapped key
pub async fn update_mapped_key(
    State(state): State<Arc<AppState>>,
    Path(key_id): Path<String>,
    Json(update): Json<UpdateMappedKey>,
) -> Result<Json<MappedKey>, ApiError> {
    let key = state.provider.update_mapped_key(&key_id, update).await?;
    Ok(Json(key))
}

/// Delete a mapped key
pub async fn delete_mapped_key(
    State(state): State<Arc<AppState>>,
    Path(key_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_mapped_key(&key_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Reveal (decrypt) a secret mapped key's command. Requires the vault to be
/// unlocked; returns 403 VAULT_LOCKED otherwise.
#[derive(Serialize)]
pub struct RevealMappedKeyResponse {
    pub command: String,
}

pub async fn reveal_mapped_key(
    State(state): State<Arc<AppState>>,
    Path(key_id): Path<String>,
) -> Result<Json<RevealMappedKeyResponse>, ApiError> {
    let command = state.provider.reveal_mapped_key(&key_id).await?;
    Ok(Json(RevealMappedKeyResponse { command }))
}

// === Custom Command Endpoints ===

/// List all custom commands
pub async fn list_custom_commands(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<CustomCommand>>, ApiError> {
    let cmds = state.provider.list_custom_commands().await?;
    Ok(Json(cmds))
}

/// Create a custom command
pub async fn create_custom_command(
    State(state): State<Arc<AppState>>,
    Json(new_cmd): Json<NewCustomCommand>,
) -> Result<(StatusCode, Json<CustomCommand>), ApiError> {
    let cmd = state.provider.create_custom_command(new_cmd).await?;
    Ok((StatusCode::CREATED, Json(cmd)))
}

/// Update a custom command
pub async fn update_custom_command(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateCustomCommand>,
) -> Result<Json<CustomCommand>, ApiError> {
    let cmd = state.provider.update_custom_command(&id, update).await?;
    Ok(Json(cmd))
}

/// Delete a custom command
pub async fn delete_custom_command(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_custom_command(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === AI Conversation Endpoints (chat history) ===

/// List saved AI conversations (newest first, summaries only)
pub async fn list_ai_conversations(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AiConversationSummary>>, ApiError> {
    let convs = state.provider.list_ai_conversations().await?;
    Ok(Json(convs))
}

/// Get a single conversation with full message history
pub async fn get_ai_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<AiConversation>, ApiError> {
    let conv = state.provider.get_ai_conversation(&id).await?;
    Ok(Json(conv))
}

/// Create a conversation
pub async fn create_ai_conversation(
    State(state): State<Arc<AppState>>,
    Json(new_conv): Json<NewAiConversation>,
) -> Result<(StatusCode, Json<AiConversation>), ApiError> {
    let conv = state.provider.create_ai_conversation(new_conv).await?;
    Ok((StatusCode::CREATED, Json(conv)))
}

/// Update a conversation (title and/or messages)
pub async fn update_ai_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateAiConversation>,
) -> Result<Json<AiConversation>, ApiError> {
    let conv = state.provider.update_ai_conversation(&id, update).await?;
    Ok(Json(conv))
}

/// Delete a conversation
pub async fn delete_ai_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_ai_conversation(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Snippet Endpoints ===

/// List snippets for a session
pub async fn list_session_snippets(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<Snippet>>, ApiError> {
    let snippets = state.provider.list_snippets(Some(&session_id)).await?;
    Ok(Json(snippets))
}

/// Create a snippet for a session
pub async fn create_session_snippet(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(new_snippet): Json<NewSnippet>,
) -> Result<(StatusCode, Json<Snippet>), ApiError> {
    let snippet = state
        .provider
        .create_snippet(Some(&session_id), new_snippet)
        .await?;
    Ok((StatusCode::CREATED, Json(snippet)))
}

/// Delete a snippet from a session
pub async fn delete_session_snippet(
    State(state): State<Arc<AppState>>,
    Path((_session_id, snippet_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_snippet(&snippet_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// List global snippets
pub async fn list_global_snippets(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Snippet>>, ApiError> {
    let snippets = state.provider.list_snippets(None).await?;
    Ok(Json(snippets))
}

/// Create a global snippet
pub async fn create_global_snippet(
    State(state): State<Arc<AppState>>,
    Json(new_snippet): Json<NewSnippet>,
) -> Result<(StatusCode, Json<Snippet>), ApiError> {
    let snippet = state.provider.create_snippet(None, new_snippet).await?;
    Ok((StatusCode::CREATED, Json(snippet)))
}

/// Delete a global snippet
pub async fn delete_global_snippet(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_snippet(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Update a snippet (global or session-scoped — id is unique either way)
pub async fn update_snippet(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateSnippet>,
) -> Result<Json<Snippet>, ApiError> {
    let snippet = state.provider.update_snippet(&id, update).await?;
    Ok(Json(snippet))
}

// === Clipboard History Endpoints ===

#[derive(Debug, Deserialize)]
pub struct ListClipsQuery {
    pub limit: Option<i64>,
}

/// GET /api/clips?limit=N — newest first.
pub async fn list_clips(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListClipsQuery>,
) -> Result<Json<Vec<Clip>>, ApiError> {
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);
    Ok(Json(state.provider.list_clips(limit).await?))
}

/// POST /api/clips — record a copy. Credential patterns (the sanitizer's
/// mandatory set plus the user's custom patterns) are scrubbed from the
/// stored text; network identifiers (IPs, MACs, hostnames) are kept because
/// history is local and those are exactly what an engineer re-pastes.
pub async fn create_clip(
    State(state): State<Arc<AppState>>,
    Json(mut new_clip): Json<NewClip>,
) -> Result<(StatusCode, Json<Clip>), ApiError> {
    if new_clip.text.is_empty() {
        return Err(ApiError {
            error: "Clip text cannot be empty".to_string(),
            code: "VALIDATION".to_string(),
        });
    }
    // Compiled once and cached; copy-on-select can insert on every mouseup.
    let scrubbed = {
        let cached = state.clip_sanitizer.read().await;
        match cached.as_ref() {
            Some(s) => s.sanitize(&new_clip.text),
            None => {
                drop(cached);
                let cfg = ai::sanitizer::load_sanitization_config(state.provider.as_ref())
                    .await
                    .credentials_only();
                let sanitizer = ai::sanitizer::Sanitizer::from_config(&cfg);
                let out = sanitizer.sanitize(&new_clip.text);
                *state.clip_sanitizer.write().await = Some(sanitizer);
                out
            }
        }
    };
    let redacted = scrubbed.redaction_count > 0;
    if redacted {
        new_clip.text = scrubbed.sanitized;
    }
    let clip = state.provider.create_clip(new_clip, redacted).await?;
    Ok((StatusCode::CREATED, Json(clip)))
}

/// PUT /api/clips/:id — pin / unpin.
pub async fn update_clip(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateClip>,
) -> Result<Json<Clip>, ApiError> {
    Ok(Json(state.provider.update_clip(&id, update).await?))
}

/// DELETE /api/clips/:id
pub async fn delete_clip(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_clip(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/clips — clear every unpinned clip.
pub async fn clear_clips(State(state): State<Arc<AppState>>) -> Result<StatusCode, ApiError> {
    state.provider.clear_unpinned_clips().await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Connection History Endpoints ===

/// List recent connection history
pub async fn list_history(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ConnectionHistory>>, ApiError> {
    let history = state.provider.list_history(10).await?;
    Ok(Json(history))
}

/// Create a connection history entry
pub async fn create_history(
    State(state): State<Arc<AppState>>,
    Json(entry): Json<NewConnectionHistory>,
) -> Result<(StatusCode, Json<ConnectionHistory>), ApiError> {
    let history = state.provider.create_history(entry).await?;
    Ok((StatusCode::CREATED, Json(history)))
}

/// Delete a connection history entry
pub async fn delete_history(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_history(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Export/Import Endpoints ===

/// Export all sessions and folders
pub async fn export_all(State(state): State<Arc<AppState>>) -> Result<Json<ExportData>, ApiError> {
    let data = state.provider.export_all().await?;
    Ok(Json(data))
}

/// Export a folder and its contents
pub async fn export_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ExportData>, ApiError> {
    let data = state.provider.export_folder(&id).await?;
    Ok(Json(data))
}

/// Export a single session
pub async fn export_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ExportData>, ApiError> {
    let data = state.provider.export_session(&id).await?;
    Ok(Json(data))
}

/// Import sessions and folders
pub async fn import_sessions(
    State(state): State<Arc<AppState>>,
    Json(data): Json<ExportData>,
) -> Result<Json<ImportResult>, ApiError> {
    let result = state.provider.import_data(data).await?;
    Ok(Json(result))
}

// === Move/Reorder Endpoints ===

/// Request body for moving a session
#[derive(Debug, Deserialize)]
pub struct MoveSessionRequest {
    pub folder_id: Option<String>,
    pub sort_order: f64,
}

/// Move a session (change folder and/or sort order)
pub async fn move_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<MoveSessionRequest>,
) -> Result<Json<Session>, ApiError> {
    let update = UpdateSession {
        folder_id: Some(req.folder_id),
        sort_order: Some(clamp_sort_order(req.sort_order)),
        ..Default::default()
    };
    let session = state.provider.update_session(&id, update).await?;
    Ok(Json(session))
}

/// Clamp a JSON `f64` sort_order to a safe `i32` for SQLite storage.
///
/// Frontend hands us a double; sort_order is stored as INTEGER. A bare
/// `as i32` saturates (correct in modern Rust) but silently swallows NaN
/// → 0, which can wreck ordering. We coerce NaN to 0 and clamp finite
/// values to `i32::MIN..=i32::MAX` so the cast is unambiguous.
fn clamp_sort_order(v: f64) -> i32 {
    if v.is_nan() {
        return 0;
    }
    v.clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

/// Request body for moving a folder
#[derive(Debug, Deserialize)]
pub struct MoveFolderRequest {
    pub parent_id: Option<String>,
    pub sort_order: f64,
}

/// Move a folder (change parent and/or sort order)
pub async fn move_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<MoveFolderRequest>,
) -> Result<Json<Folder>, ApiError> {
    // First, validate that we're not creating a cycle
    // (folder can't be moved into itself or its descendants)
    if let Some(ref parent_id) = req.parent_id {
        // Check if the target parent is the folder itself
        if parent_id == &id {
            return Err(ApiError {
                error: "Cannot move folder into itself".to_string(),
                code: "VALIDATION".to_string(),
            });
        }

        // Check if the target parent is a descendant of this folder
        let all_folders = state.provider.list_folders(None).await?;
        let mut descendants = std::collections::HashSet::new();

        // Build set of descendant IDs
        fn collect_descendants(
            folder_id: &str,
            folders: &[Folder],
            descendants: &mut std::collections::HashSet<String>,
        ) {
            for folder in folders {
                if folder.parent_id.as_deref() == Some(folder_id) {
                    descendants.insert(folder.id.clone());
                    collect_descendants(&folder.id, folders, descendants);
                }
            }
        }

        collect_descendants(&id, &all_folders, &mut descendants);

        if descendants.contains(parent_id) {
            return Err(ApiError {
                error: "Cannot move folder into its own descendant".to_string(),
                code: "VALIDATION".to_string(),
            });
        }
    }

    let update = UpdateFolder {
        name: None,
        parent_id: Some(req.parent_id),
        sort_order: Some(clamp_sort_order(req.sort_order)),
    };
    let folder = state.provider.update_folder(&id, update).await?;
    Ok(Json(folder))
}

// === Settings Endpoints ===

/// Get a setting value by key
pub async fn get_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let value = state.provider.get_setting(&key).await?;
    Ok(Json(value))
}

/// Delete a setting value ("reset to default"). 204 whether or not it existed.
pub async fn delete_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_setting(&key).await?;
    if key == "ai.sanitization_config" {
        *state.sanitizer.write().await = None;
        *state.clip_sanitizer.write().await = None;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Set a setting value
pub async fn set_setting(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(value): Json<serde_json::Value>,
) -> Result<StatusCode, ApiError> {
    // AUDIT FIX (REMOTE-002): the `ssh.hostKeyChecking` key is rejected.
    // It used to flip a global "disable strict host-key checking" flag
    // for every SSH/SFTP/MOP connection; that flag is gone. Per-session
    // opt-in is the only remaining escape hatch.
    if key == "ssh.hostKeyChecking" {
        return Err(ApiError {
            error: "ssh.hostKeyChecking is no longer configurable — strict host-key \
                    checking is always on. Per-session opt-in is the only escape hatch."
                .to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    state.provider.set_setting(&key, value.clone()).await?;

    // Invalidate sanitizer cache when sanitization config changes
    if key == "ai.sanitization_config" {
        *state.sanitizer.write().await = None;
        *state.clip_sanitizer.write().await = None;
    }

    Ok(StatusCode::NO_CONTENT)
}

// === Docs KB (bundled NetStacks usage documentation) ===

#[derive(Serialize)]
pub struct KbIndexEntry {
    pub slug: String,
    pub title: String,
}

/// GET /docs-kb — list bundled documentation topics.
pub async fn docs_kb_index() -> Json<Vec<KbIndexEntry>> {
    Json(
        crate::docs_kb::index()
            .into_iter()
            .map(|(slug, title)| KbIndexEntry {
                slug: slug.to_string(),
                title: title.to_string(),
            })
            .collect(),
    )
}

#[derive(Serialize)]
pub struct KbSearchHit {
    pub slug: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Deserialize)]
pub struct KbSearchQuery {
    pub q: Option<String>,
}

/// GET /docs-kb/search?q= — keyword search over bundled docs.
pub async fn docs_kb_search(Query(query): Query<KbSearchQuery>) -> Json<Vec<KbSearchHit>> {
    let q = query.q.unwrap_or_default();
    Json(
        crate::docs_kb::search(&q)
            .into_iter()
            .map(|h| KbSearchHit {
                slug: h.slug.to_string(),
                title: h.title.to_string(),
                snippet: h.snippet,
            })
            .collect(),
    )
}

#[derive(Serialize)]
pub struct KbDocResponse {
    pub slug: String,
    pub title: String,
    pub content: String,
}

/// GET /docs-kb/:slug — fetch one bundled doc's full content.
pub async fn docs_kb_get(Path(slug): Path<String>) -> Result<Json<KbDocResponse>, ApiError> {
    match crate::docs_kb::get(&slug) {
        Some(d) => Ok(Json(KbDocResponse {
            slug: d.slug.to_string(),
            title: d.title.to_string(),
            content: d.content.to_string(),
        })),
        None => Err(ApiError {
            error: format!("No bundled doc '{}'", slug),
            code: "NOT_FOUND".to_string(),
        }),
    }
}

// === Terminal Logging Endpoints ===

/// Request body for starting logging
#[derive(Debug, Deserialize)]
pub struct StartLogRequest {
    pub format: String, // "raw", "plain", "html"
    // Handled client-side; accepted for API compat but not read here. The `_`
    // prefix silences dead_code; serde(rename) preserves the wire field name.
    #[serde(rename = "timestamps", default)]
    pub _timestamps: bool,
    pub path: Option<String>,
}

/// Returns the canonical directory under which all terminal-log files must
/// live. Ensures the directory exists.
fn terminal_logs_root() -> Result<std::path::PathBuf, ApiError> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let logs_dir = std::path::PathBuf::from(&home)
        .join("Documents")
        .join("NetStacks")
        .join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| ApiError {
        error: format!("Failed to ensure logs directory: {}", e),
        code: "IO_ERROR".to_string(),
    })?;
    logs_dir.canonicalize().map_err(|e| ApiError {
        error: format!("Failed to canonicalize logs directory: {}", e),
        code: "IO_ERROR".to_string(),
    })
}

/// AUDIT FIX (DATA-002): confine log-file paths to the NetStacks logs
/// directory. Without this, the write/append/read endpoints accept arbitrary
/// user-supplied paths and become arbitrary file primitives — a compromised
/// webview could overwrite ~/.bashrc, drop Launch Agents, etc.
///
/// The validation accepts both existing files (write/append/read) and
/// not-yet-created files (start with a custom path) by canonicalizing the
/// parent in the latter case.
fn validate_log_path(supplied: &str) -> Result<std::path::PathBuf, ApiError> {
    let logs_root = terminal_logs_root()?;
    let supplied_path = std::path::PathBuf::from(supplied);

    let canonical = if supplied_path.exists() {
        supplied_path.canonicalize().map_err(|e| ApiError {
            error: format!("Invalid log path: {}", e),
            code: "INVALID_PATH".to_string(),
        })?
    } else {
        let parent = supplied_path.parent().ok_or_else(|| ApiError {
            error: "Log path has no parent directory".to_string(),
            code: "INVALID_PATH".to_string(),
        })?;
        let parent_canon = parent.canonicalize().map_err(|e| ApiError {
            error: format!("Invalid log path parent: {}", e),
            code: "INVALID_PATH".to_string(),
        })?;
        let file_name = supplied_path.file_name().ok_or_else(|| ApiError {
            error: "Log path has no file name".to_string(),
            code: "INVALID_PATH".to_string(),
        })?;
        parent_canon.join(file_name)
    };

    if !canonical.starts_with(&logs_root) {
        return Err(ApiError {
            error: "Log path must be within the NetStacks logs directory".to_string(),
            code: "INVALID_PATH".to_string(),
        });
    }

    Ok(canonical)
}

/// Response for starting logging
#[derive(Debug, Serialize)]
pub struct StartLogResponse {
    pub path: String,
}

/// Request body for writing log content
#[derive(Debug, Deserialize)]
pub struct WriteLogRequest {
    pub path: String,
    pub content: String,
}

/// Start logging for a terminal
pub async fn start_terminal_log(
    Path(terminal_id): Path<String>,
    Json(req): Json<StartLogRequest>,
) -> Result<Json<StartLogResponse>, ApiError> {
    let logs_root = terminal_logs_root()?;

    // If the caller supplied a path, confine it to the logs directory.
    // Otherwise generate a default path inside the logs directory.
    let path = if let Some(p) = req.path {
        let validated = validate_log_path(&p)?;
        validated.to_string_lossy().to_string()
    } else {
        let now = chrono::Utc::now();
        let extension = match req.format.as_str() {
            "raw" => "raw",
            "html" => "html",
            _ => "log",
        };
        logs_root
            .join(format!(
                "terminal-{}_{}.{}",
                terminal_id,
                now.format("%Y%m%d_%H%M%S"),
                extension
            ))
            .to_string_lossy()
            .to_string()
    };

    // Create the log file
    tokio::fs::File::create(&path).await.map_err(|e| ApiError {
        error: format!("Failed to create log file: {}", e),
        code: "IO_ERROR".to_string(),
    })?;

    Ok(Json(StartLogResponse { path }))
}

/// Write content to a log file
pub async fn write_terminal_log(
    Path(terminal_id): Path<String>,
    Json(req): Json<WriteLogRequest>,
) -> Result<StatusCode, ApiError> {
    use tokio::io::AsyncWriteExt;

    let safe_path = validate_log_path(&req.path)?;

    tracing::debug!(
        "Writing log for terminal {}: {} bytes to {}",
        terminal_id,
        req.content.len(),
        safe_path.display()
    );

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&safe_path)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to open log file '{}': {}", safe_path.display(), e),
            code: "IO_ERROR".to_string(),
        })?;

    file.write_all(req.content.as_bytes())
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to write to log file: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Request body for stopping a terminal log
#[derive(Debug, Deserialize)]
pub struct StopLogRequest {
    pub path: Option<String>,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
}

/// Response from stopping a terminal log
#[derive(Debug, Serialize)]
pub struct StopLogResponse {
    pub document_id: Option<String>,
}

/// Stop logging for a terminal and save log content to docs
pub async fn stop_terminal_log(
    State(state): State<Arc<AppState>>,
    Path(terminal_id): Path<String>,
    body: Option<Json<StopLogRequest>>,
) -> Result<Json<StopLogResponse>, ApiError> {
    tracing::debug!("Stopping log for terminal {}", terminal_id);

    let req = body.map(|b| b.0);

    // If a log file path was provided, read it and create a document
    if let Some(ref req) = req {
        if let Some(ref path) = req.path {
            // AUDIT FIX (DATA-002): confine reads to the logs directory.
            let safe_path = match validate_log_path(path) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("Refusing to read log at '{}': {}", path, e.error);
                    return Ok(Json(StopLogResponse { document_id: None }));
                }
            };
            match tokio::fs::read_to_string(&safe_path).await {
                Ok(content) if !content.is_empty() => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let now = crate::models::format_datetime(&chrono::Utc::now());
                    let name = format!(
                        "Session Log - {} - {}",
                        req.session_name.as_deref().unwrap_or(&terminal_id),
                        chrono::Utc::now().format("%Y-%m-%d %H:%M")
                    );

                    let result = sqlx::query(
                        r#"INSERT INTO documents (id, name, category, content_type, content, parent_folder, session_id, created_at, updated_at)
                           VALUES (?, ?, 'outputs', 'text', ?, 'logs', ?, ?, ?)"#,
                    )
                    .bind(&id)
                    .bind(&name)
                    .bind(&content)
                    .bind(req.session_id.as_deref())
                    .bind(&now)
                    .bind(&now)
                    .execute(&state.pool)
                    .await;

                    match result {
                        Ok(_) => {
                            tracing::info!("Created log document '{}' (id: {})", name, id);
                            return Ok(Json(StopLogResponse {
                                document_id: Some(id),
                            }));
                        }
                        Err(e) => {
                            tracing::warn!("Failed to create log document: {}", e);
                        }
                    }
                }
                Ok(_) => {
                    tracing::debug!("Log file is empty, skipping doc creation");
                }
                Err(e) => {
                    tracing::warn!("Failed to read log file '{}': {}", path, e);
                }
            }
        }
    }

    Ok(Json(StopLogResponse { document_id: None }))
}

/// Append to log file
#[derive(Debug, Deserialize)]
pub struct AppendLogRequest {
    pub path: String,
    pub content: String,
}

/// Append content to an existing log file
pub async fn append_to_log(Json(req): Json<AppendLogRequest>) -> Result<StatusCode, ApiError> {
    use tokio::io::AsyncWriteExt;

    let safe_path = validate_log_path(&req.path)?;

    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&safe_path)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to open log file: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    file.write_all(req.content.as_bytes())
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to write to log file: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

// === Credential Profile Endpoints ===

/// List all credential profiles
pub async fn list_profiles(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<CredentialProfile>>, ApiError> {
    let profiles = state.provider.list_profiles().await?;
    Ok(Json(profiles))
}

/// Get a single credential profile
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<CredentialProfile>, ApiError> {
    let profile = state.provider.get_profile(&id).await?;
    Ok(Json(profile))
}

/// Create a new credential profile
pub async fn create_profile(
    State(state): State<Arc<AppState>>,
    Json(new_profile): Json<NewCredentialProfile>,
) -> Result<(StatusCode, Json<CredentialProfile>), ApiError> {
    let profile = state.provider.create_profile(new_profile).await?;
    Ok((StatusCode::CREATED, Json(profile)))
}

/// Update an existing credential profile
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateCredentialProfile>,
) -> Result<Json<CredentialProfile>, ApiError> {
    let profile = state.provider.update_profile(&id, update).await?;
    Ok(Json(profile))
}

/// Delete a credential profile
pub async fn delete_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_profile(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Get credential metadata for a profile (non-secret summary)
pub async fn get_profile_credential_meta(
    State(state): State<Arc<AppState>>,
    Path(profile_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let credential = state.provider.get_profile_credential(&profile_id).await?;
    match credential {
        Some(cred) => {
            let snmp_count = cred.snmp_communities.as_ref().map_or(0, |c| c.len());
            let has_password = cred.password.is_some();
            let has_key_passphrase = cred.key_passphrase.is_some();
            Ok(Json(serde_json::json!({
                "has_password": has_password,
                "has_key_passphrase": has_key_passphrase,
                "snmp_community_count": snmp_count,
            })))
        }
        None => Ok(Json(serde_json::json!({
            "has_password": false,
            "has_key_passphrase": false,
            "snmp_community_count": 0,
        }))),
    }
}

/// Store credential for a profile
pub async fn store_profile_credential(
    State(state): State<Arc<AppState>>,
    Path(profile_id): Path<String>,
    Json(credential): Json<ProfileCredential>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .store_profile_credential(&profile_id, credential)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete credential for a profile
pub async fn delete_profile_credential(
    State(state): State<Arc<AppState>>,
    Path(profile_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .delete_profile_credential(&profile_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Jump Hosts Endpoints ===

/// List all jump hosts
pub async fn list_jump_hosts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<JumpHost>>, ApiError> {
    let jump_hosts = state.provider.list_jump_hosts().await?;
    Ok(Json(jump_hosts))
}

/// Get a single jump host
pub async fn get_jump_host(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<JumpHost>, ApiError> {
    let jump_host = state.provider.get_jump_host(&id).await?;
    Ok(Json(jump_host))
}

/// Create a new jump host
pub async fn create_jump_host(
    State(state): State<Arc<AppState>>,
    Json(new_jump_host): Json<NewJumpHost>,
) -> Result<(StatusCode, Json<JumpHost>), ApiError> {
    let jump_host = state.provider.create_jump_host(new_jump_host).await?;
    Ok((StatusCode::CREATED, Json(jump_host)))
}

/// Update a jump host
pub async fn update_jump_host(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateJumpHost>,
) -> Result<Json<JumpHost>, ApiError> {
    let jump_host = state.provider.update_jump_host(&id, update).await?;
    Ok(Json(jump_host))
}

/// Delete a jump host
pub async fn delete_jump_host(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_jump_host(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Bulk Command Endpoints ===

// === NetBox Sources Endpoints ===

/// List all NetBox sources
pub async fn list_netbox_sources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<NetBoxSource>>, ApiError> {
    let sources = state.provider.list_netbox_sources().await?;
    Ok(Json(sources))
}

/// Get a single NetBox source
pub async fn get_netbox_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<NetBoxSource>, ApiError> {
    let source = state.provider.get_netbox_source(&id).await?;
    Ok(Json(source))
}

/// Create a new NetBox source
pub async fn create_netbox_source(
    State(state): State<Arc<AppState>>,
    Json(new_source): Json<NewNetBoxSource>,
) -> Result<(StatusCode, Json<NetBoxSource>), ApiError> {
    let source = state.provider.create_netbox_source(new_source).await?;
    Ok((StatusCode::CREATED, Json(source)))
}

/// Update an existing NetBox source
pub async fn update_netbox_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateNetBoxSource>,
) -> Result<Json<NetBoxSource>, ApiError> {
    let source = state.provider.update_netbox_source(&id, update).await?;
    Ok(Json(source))
}

/// Delete a NetBox source
pub async fn delete_netbox_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_netbox_source(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Request body for testing NetBox connection (with source ID).
///
/// Older clients sent `url` / `api_token` here; those fields are now
/// ignored (connection settings come from the linked api_resource) but
/// the body is still accepted so legacy callers don't fail. Serde
/// ignores unknown fields by default, so an empty struct suffices.
#[derive(Debug, Deserialize)]
pub struct TestNetBoxRequest {}

/// Request body for testing NetBox connection directly (no source required)
#[derive(Debug, Deserialize)]
pub struct TestNetBoxDirectRequest {
    /// URL to test
    pub url: String,
    /// API token to test
    pub token: String,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
}

fn default_proxy_verify_ssl() -> bool {
    true
}

/// Response from testing NetBox connection
#[derive(Debug, Serialize)]
pub struct TestNetBoxResponse {
    pub success: bool,
    pub message: String,
    pub version: Option<String>,
}

/// Test NetBox connection using the source's linked API Resource
///
/// Body fields `url` / `api_token` are accepted for backward compatibility but
/// ignored — connection settings come from the linked api_resource.
pub async fn test_netbox_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(_req): Json<TestNetBoxRequest>,
) -> Result<Json<TestNetBoxResponse>, ApiError> {
    let source = state.provider.get_netbox_source(&id).await?;
    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &source.api_resource_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(api_resource_client_err)?;

    match client
        .send_authed(reqwest::Method::GET, "/api/status/")
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                let version = response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| {
                        v.get("netbox-version")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });

                Ok(Json(TestNetBoxResponse {
                    success: true,
                    message: "Connection successful".to_string(),
                    version,
                }))
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(Json(TestNetBoxResponse {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                    version: None,
                }))
            }
        }
        Err(e) => Ok(Json(TestNetBoxResponse {
            success: false,
            message: format!("Connection failed: {}", e),
            version: None,
        })),
    }
}

/// Test NetBox connection directly (no source required)
pub async fn test_netbox_direct(
    Json(req): Json<TestNetBoxDirectRequest>,
) -> Result<Json<TestNetBoxResponse>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let api_url = format!("{}/api/status/", req.url.trim_end_matches('/'));

    match client
        .get(&api_url)
        .header("Authorization", format!("Token {}", req.token))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                let version = response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| {
                        v.get("netbox-version")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });

                Ok(Json(TestNetBoxResponse {
                    success: true,
                    message: "Connection successful".to_string(),
                    version,
                }))
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(Json(TestNetBoxResponse {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                    version: None,
                }))
            }
        }
        Err(e) => {
            // Log detailed error for debugging
            let mut error_details = format!("{}", e);
            let err: &dyn StdError = &e;
            if let Some(source) = err.source() {
                error_details.push_str(&format!(" (caused by: {})", source));
                if let Some(inner) = source.source() {
                    error_details.push_str(&format!(" (inner: {})", inner));
                }
            }
            Ok(Json(TestNetBoxResponse {
                success: false,
                message: format!("Connection failed: {}", error_details),
                version: None,
            }))
        }
    }
}

/// Request body for completing a NetBox sync
#[derive(Debug, Deserialize)]
pub struct SyncCompleteRequest {
    pub filters: SyncFilters,
    pub result: SyncResult,
}

/// Response from completing a NetBox sync
#[derive(Debug, Serialize)]
pub struct SyncCompleteResponse {
    pub source: NetBoxSource,
}

/// Mark a NetBox sync as complete, updating sync metadata
pub async fn sync_complete_netbox_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SyncCompleteRequest>,
) -> Result<Json<SyncCompleteResponse>, ApiError> {
    // Get the source first to verify it exists
    let _source = state.provider.get_netbox_source(&id).await?;

    // Update the source with sync metadata
    let update = UpdateNetBoxSource {
        last_sync_at: Some(Some(chrono::Utc::now())),
        last_sync_filters: Some(Some(req.filters)),
        last_sync_result: Some(Some(req.result)),
        ..Default::default()
    };

    let updated_source = state.provider.update_netbox_source(&id, update).await?;
    Ok(Json(SyncCompleteResponse {
        source: updated_source,
    }))
}

/// Get API token for a NetBox source (used by frontend for imports)
///
/// Tokens now live on the linked api_resource's credentials row; we hop to
/// `get_api_resource_credentials` to surface it in the same response shape.
pub async fn get_netbox_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<GetNetBoxTokenResponse>, ApiError> {
    let source = state.provider.get_netbox_source(&id).await?;
    let token = state
        .provider
        .get_api_resource_credentials(&source.api_resource_id)
        .await?
        .and_then(|c| c.token);
    Ok(Json(GetNetBoxTokenResponse { token }))
}

/// Response from getting a NetBox token
#[derive(Debug, Serialize)]
pub struct GetNetBoxTokenResponse {
    pub token: Option<String>,
}

/// Validate that a user-supplied proxy URL uses http/https and does not target
/// known cloud-metadata or unspecified addresses (SSRF mitigation).
/// RFC1918 addresses are intentionally allowed — NetBox/LibreNMS instances
/// are commonly deployed on private networks.
fn validate_proxy_url(url: &str) -> Result<(), ApiError> {
    let trimmed = url.trim();
    let after_scheme = if let Some(rest) = trimmed.strip_prefix("https://") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        rest
    } else {
        return Err(ApiError {
            error: "Proxy URL must use http:// or https:// scheme".to_string(),
            code: "INVALID_URL".to_string(),
        });
    };
    // Extract host portion (stop at '/', ':', '?', '#')
    let host = after_scheme
        .split(['/', ':', '?', '#'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    if host.is_empty() {
        return Err(ApiError {
            error: "Proxy URL must include a hostname".to_string(),
            code: "INVALID_URL".to_string(),
        });
    }
    // Block link-local addresses used by cloud metadata services
    // (AWS/Azure/OpenStack IMDS: 169.254.169.254, link-local range: 169.254.x.x)
    if host.starts_with("169.254.") {
        return Err(ApiError {
            error: "Proxy URL host is not allowed".to_string(),
            code: "INVALID_URL".to_string(),
        });
    }
    // Block GCP metadata endpoints
    if host == "metadata.google.internal" || host == "metadata.goog" {
        return Err(ApiError {
            error: "Proxy URL host is not allowed".to_string(),
            code: "INVALID_URL".to_string(),
        });
    }
    // Block unspecified / any-address
    if host == "0.0.0.0" || host == "[::]" || host == "[::0]" {
        return Err(ApiError {
            error: "Proxy URL host is not allowed".to_string(),
            code: "INVALID_URL".to_string(),
        });
    }
    Ok(())
}

// === NetBox Proxy Endpoints (for filter options with SSL bypass) ===

/// Request body for NetBox proxy calls
#[derive(Debug, Deserialize)]
pub struct NetBoxProxyRequest {
    pub url: String,
    pub token: String,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
}

/// NetBox site response
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxSite {
    pub id: i64,
    pub slug: String,
    pub name: String,
}

/// NetBox role response
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxRole {
    pub id: i64,
    pub slug: String,
    pub name: String,
}

/// NetBox manufacturer response
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxManufacturer {
    pub id: i64,
    pub slug: String,
    pub name: String,
}

/// NetBox platform response
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxPlatform {
    pub id: i64,
    pub slug: String,
    pub name: String,
}

/// NetBox tag response
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxTag {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub color: String,
}

/// NetBox paginated response wrapper
#[derive(Debug, Deserialize)]
pub struct NetBoxPaginatedResponse<T> {
    pub count: i64,
    pub next: Option<String>,
    pub results: Vec<T>,
}

/// Request body for NetBox device count
#[derive(Debug, Deserialize)]
pub struct NetBoxCountDevicesRequest {
    pub url: String,
    pub token: String,
    pub name: Option<String>,
    pub sites: Option<Vec<String>>,
    pub roles: Option<Vec<String>>,
    pub manufacturers: Option<Vec<String>>,
    pub platforms: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
}

/// Response for NetBox device count
#[derive(Debug, Serialize)]
pub struct NetBoxCountDevicesResponse {
    pub count: i64,
}

/// Helper to build NetBox API URL with array params
fn build_netbox_url(base_url: &str, path: &str, params: &[(&str, &[String])]) -> String {
    let clean_base = base_url.trim_end_matches('/');
    let mut url = format!("{}/api{}", clean_base, path);

    let mut query_parts: Vec<String> = vec![];
    for (key, values) in params {
        for value in *values {
            query_parts.push(format!("{}={}", key, urlencoding::encode(value)));
        }
    }

    if !query_parts.is_empty() {
        url.push('?');
        url.push_str(&query_parts.join("&"));
    }

    url
}

/// Internal helper for NetBox "fetch a paginated list of T from <path>" endpoints.
///
/// All netbox_proxy_* endpoints that take only a `NetBoxProxyRequest` and
/// hit a fixed path with no filters shared an identical request/response
/// shape — `Authorization: Token`, JSON Accept, 30s timeout, parse the
/// paginated wrapper, error-map to PARSE_ERROR / NETBOX_ERROR / REQUEST_ERROR.
/// Endpoints that need filter params (devices, count, ip-addresses) keep
/// their dedicated impls — the helper would obscure their differences.
async fn netbox_proxy_list<T: serde::de::DeserializeOwned>(
    req: &NetBoxProxyRequest,
    path: &str,
) -> Result<Json<Vec<T>>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let api_url = format!("{}{}", req.url.trim_end_matches('/'), path);

    let response = client
        .get(&api_url)
        .header("Authorization", format!("Token {}", req.token))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "REQUEST_ERROR".to_string(),
        })?;

    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("NetBox API error: {}", response.status()),
            code: "NETBOX_ERROR".to_string(),
        });
    }

    let data: NetBoxPaginatedResponse<T> = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;
    Ok(Json(data.results))
}

/// Fetch sites from NetBox (proxied through backend for SSL bypass)
pub async fn netbox_proxy_sites(
    Json(req): Json<NetBoxProxyRequest>,
) -> Result<Json<Vec<NetBoxSite>>, ApiError> {
    netbox_proxy_list(&req, "/api/dcim/sites/?limit=1000").await
}

/// Fetch device roles from NetBox
pub async fn netbox_proxy_roles(
    Json(req): Json<NetBoxProxyRequest>,
) -> Result<Json<Vec<NetBoxRole>>, ApiError> {
    netbox_proxy_list(&req, "/api/dcim/device-roles/?limit=100").await
}

/// Fetch manufacturers from NetBox
pub async fn netbox_proxy_manufacturers(
    Json(req): Json<NetBoxProxyRequest>,
) -> Result<Json<Vec<NetBoxManufacturer>>, ApiError> {
    netbox_proxy_list(&req, "/api/dcim/manufacturers/?limit=500").await
}

/// Fetch platforms from NetBox
pub async fn netbox_proxy_platforms(
    Json(req): Json<NetBoxProxyRequest>,
) -> Result<Json<Vec<NetBoxPlatform>>, ApiError> {
    netbox_proxy_list(&req, "/api/dcim/platforms/?limit=500").await
}

/// Fetch tags from NetBox
pub async fn netbox_proxy_tags(
    Json(req): Json<NetBoxProxyRequest>,
) -> Result<Json<Vec<NetBoxTag>>, ApiError> {
    netbox_proxy_list(&req, "/api/extras/tags/?limit=500").await
}

/// Count devices from NetBox with filters
pub async fn netbox_proxy_count_devices(
    Json(req): Json<NetBoxCountDevicesRequest>,
) -> Result<Json<NetBoxCountDevicesResponse>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Build URL with filter params
    let mut params: Vec<(&str, &[String])> = vec![];

    let name_vec = req.name.map(|n| vec![n]).unwrap_or_default();
    let sites = req.sites.unwrap_or_default();
    let roles = req.roles.unwrap_or_default();
    let manufacturers = req.manufacturers.unwrap_or_default();
    let platforms = req.platforms.unwrap_or_default();
    let statuses = req.statuses.unwrap_or_default();
    let tags = req.tags.unwrap_or_default();

    if !name_vec.is_empty() {
        params.push(("name", &name_vec));
    }
    if !sites.is_empty() {
        params.push(("site", &sites));
    }
    if !roles.is_empty() {
        params.push(("role", &roles));
    }
    if !manufacturers.is_empty() {
        params.push(("manufacturer", &manufacturers));
    }
    if !platforms.is_empty() {
        params.push(("platform", &platforms));
    }
    if !statuses.is_empty() {
        params.push(("status", &statuses));
    }
    if !tags.is_empty() {
        params.push(("tag", &tags));
    }

    let limit_vec = vec!["1".to_string()];
    params.push(("limit", &limit_vec));

    let api_url = build_netbox_url(&req.url, "/dcim/devices/", &params);

    match client
        .get(&api_url)
        .header("Authorization", format!("Token {}", req.token))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response
                    .json::<NetBoxPaginatedResponse<serde_json::Value>>()
                    .await
                {
                    Ok(data) => Ok(Json(NetBoxCountDevicesResponse { count: data.count })),
                    Err(e) => Err(ApiError {
                        error: format!("Failed to parse response: {}", e),
                        code: "PARSE_ERROR".to_string(),
                    }),
                }
            } else {
                Err(ApiError {
                    error: format!("NetBox API error: {}", response.status()),
                    code: "NETBOX_ERROR".to_string(),
                })
            }
        }
        Err(e) => Err(ApiError {
            error: format!("Request failed: {}", e),
            code: "REQUEST_ERROR".to_string(),
        }),
    }
}

/// Request body for NetBox device fetch
#[derive(Debug, Deserialize)]
pub struct NetBoxFetchDevicesRequest {
    pub url: String,
    pub token: String,
    pub name: Option<String>,
    pub sites: Option<Vec<String>>,
    pub roles: Option<Vec<String>>,
    pub manufacturers: Option<Vec<String>>,
    pub platforms: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
}

/// NetBox device interface
#[derive(Debug, Serialize, Deserialize)]
pub struct _NetBoxDeviceInterface {
    pub id: i64,
    pub name: String,
}

/// NetBox device primary IP
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxDevicePrimaryIp {
    pub id: i64,
    /// The IP address (e.g., "192.168.1.1/24") - may not be present in all NetBox versions
    pub address: Option<String>,
    /// Display string (e.g., "192.168.1.1/24") - fallback if address is not present
    pub display: Option<String>,
}

/// NetBox device response (full device details)
#[derive(Debug, Serialize, Deserialize)]
pub struct NetBoxDevice {
    pub id: i64,
    pub name: String,
    pub display: Option<String>,
    pub device_type: Option<serde_json::Value>,
    pub role: Option<serde_json::Value>,
    /// NetBox < 4.0 name for `role`. Passed through so the frontend's
    /// role-based profile mapping works against either server version
    /// (NS-API-6); serde used to drop it because the field didn't exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_role: Option<serde_json::Value>,
    pub tenant: Option<serde_json::Value>,
    pub platform: Option<serde_json::Value>,
    pub serial: Option<String>,
    pub asset_tag: Option<String>,
    pub site: Option<serde_json::Value>,
    pub location: Option<serde_json::Value>,
    pub rack: Option<serde_json::Value>,
    pub position: Option<f64>,
    pub face: Option<serde_json::Value>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub status: Option<serde_json::Value>,
    pub primary_ip: Option<NetBoxDevicePrimaryIp>,
    pub primary_ip4: Option<NetBoxDevicePrimaryIp>,
    pub primary_ip6: Option<NetBoxDevicePrimaryIp>,
    pub oob_ip: Option<serde_json::Value>,
    pub cluster: Option<serde_json::Value>,
    pub virtual_chassis: Option<serde_json::Value>,
    pub vc_position: Option<i32>,
    pub vc_priority: Option<i32>,
    pub description: Option<String>,
    pub comments: Option<String>,
    pub config_template: Option<serde_json::Value>,
    pub local_context_data: Option<serde_json::Value>,
    pub tags: Option<Vec<serde_json::Value>>,
    pub custom_fields: Option<serde_json::Value>,
    pub created: Option<String>,
    pub last_updated: Option<String>,
    pub console_port_count: Option<i32>,
    pub console_server_port_count: Option<i32>,
    pub power_port_count: Option<i32>,
    pub power_outlet_count: Option<i32>,
    pub interface_count: Option<i32>,
    pub front_port_count: Option<i32>,
    pub rear_port_count: Option<i32>,
    pub device_bay_count: Option<i32>,
    pub module_bay_count: Option<i32>,
    pub inventory_item_count: Option<i32>,
}

/// Fetch devices from NetBox with filters (proxied for SSL bypass)
/// Handles pagination to fetch ALL devices, not just the first page
/// Cap on NetBox pagination so a NetBox that returns a self-referential
/// `next` chain (misconfigured or malicious) can't OOM the agent. At
/// limit=1000 per page, 200 pages = 200k objects — well past anything a
/// real network ops user has.
const MAX_NETBOX_PAGES: u32 = 200;

pub async fn netbox_proxy_devices(
    Json(req): Json<NetBoxFetchDevicesRequest>,
) -> Result<Json<Vec<NetBoxDevice>>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Build URL with filter params
    let mut params: Vec<(&str, &[String])> = vec![];

    let name_vec = req.name.map(|n| vec![n]).unwrap_or_default();
    let sites = req.sites.unwrap_or_default();
    let roles = req.roles.unwrap_or_default();
    let manufacturers = req.manufacturers.unwrap_or_default();
    let platforms = req.platforms.unwrap_or_default();
    let statuses = req.statuses.unwrap_or_default();
    let tags = req.tags.unwrap_or_default();

    if !name_vec.is_empty() {
        params.push(("name", &name_vec));
    }
    if !sites.is_empty() {
        params.push(("site", &sites));
    }
    if !roles.is_empty() {
        params.push(("role", &roles));
    }
    if !manufacturers.is_empty() {
        params.push(("manufacturer", &manufacturers));
    }
    if !platforms.is_empty() {
        params.push(("platform", &platforms));
    }
    if !statuses.is_empty() {
        params.push(("status", &statuses));
    }
    if !tags.is_empty() {
        params.push(("tag", &tags));
    }

    let limit_vec = vec!["1000".to_string()];
    params.push(("limit", &limit_vec));

    let initial_url = build_netbox_url(&req.url, "/dcim/devices/", &params);
    let token = req.token.clone();

    let all_devices: Vec<NetBoxDevice> =
        netbox_fetch_all_pages(&client, &token, initial_url).await?;

    let with_ip = all_devices
        .iter()
        .filter(|d| d.primary_ip.is_some())
        .count();
    tracing::debug!(
        "Total NetBox devices fetched: {} (with primary_ip: {})",
        all_devices.len(),
        with_ip
    );

    Ok(Json(all_devices))
}

// === NetBox console access (OOB console import) ===

/// Request body for the console-access join: the devices being imported.
#[derive(Debug, Deserialize)]
pub struct NetBoxConsoleAccessRequest {
    pub url: String,
    pub token: String,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
    pub device_ids: Vec<i64>,
}

/// The console server a device's console port is cabled to.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetBoxConsoleServerRef {
    pub id: i64,
    pub name: String,
    /// primary_ip4 → primary_ip → oob_ip, CIDR stripped; `None` = no IP
    pub host: Option<String>,
    pub manufacturer_slug: Option<String>,
}

/// Why NetBox does not describe a usable console path for a device.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsoleSkip {
    NoConsolePort,
    NotCabled,
    NoTcpPort,
    ServerNoIp,
}

/// Console access resolved for one imported device. `skip` (with the
/// human-readable `skip_reason`) is set when NetBox does not describe a
/// usable console path; the importer reports the reason rather than guessing.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetBoxConsoleAccess {
    pub device_id: i64,
    pub console_port_name: Option<String>,
    pub tcp_port: Option<u16>,
    pub console_server: Option<NetBoxConsoleServerRef>,
    pub skip: Option<ConsoleSkip>,
    pub skip_reason: Option<String>,
}

/// Custom field on `dcim.consoleport` that carries the terminal-server TCP
/// port for that line. Documented at netstacks.net/docs (NetBox console access).
pub const NETBOX_CONSOLE_PORT_CF: &str = "device_console";

/// NetBox `device_id` filters per request; keeps URLs well under proxy limits.
const NETBOX_ID_CHUNK: usize = 100;

/// What one `dcim.consoleport` record tells us, before the console server
/// device is looked up.
#[derive(Debug, Clone, PartialEq)]
struct ParsedConsolePort {
    device_id: i64,
    name: String,
    /// `(console server device id, console server name)` when cabled to a
    /// `dcim.consoleserverport`
    server: Option<(i64, String)>,
    /// `device_console` custom field: `Ok(port)`, `Err(reason)` when absent/invalid
    tcp_port: Result<u16, String>,
}

/// Parse a NetBox console-port object. Handles both the ≥3.3 plural
/// `connected_endpoints[]` and the older singular `connected_endpoint`.
fn parse_console_port(v: &serde_json::Value) -> Option<ParsedConsolePort> {
    let device_id = v.get("device")?.get("id")?.as_i64()?;
    let name = v
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();

    let endpoint_type = v
        .get("connected_endpoints_type")
        .or_else(|| v.get("connected_endpoint_type"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let endpoint = v
        .get("connected_endpoints")
        .and_then(|e| e.as_array())
        .and_then(|a| a.first())
        .or_else(|| v.get("connected_endpoint").filter(|e| e.is_object()));
    let server = if endpoint_type == "dcim.consoleserverport" {
        endpoint.and_then(|e| {
            let dev = e.get("device")?;
            let id = dev.get("id")?.as_i64()?;
            let name = dev
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            Some((id, name))
        })
    } else {
        None
    };

    let cf = v
        .get("custom_fields")
        .and_then(|c| c.get(NETBOX_CONSOLE_PORT_CF));
    let tcp_port = match cf {
        None | Some(serde_json::Value::Null) => Err(format!(
            "no `{}` custom field (TCP port) on console port",
            NETBOX_CONSOLE_PORT_CF
        )),
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
            .ok_or_else(|| {
                format!(
                    "`{}` must be a TCP port 1-65535, got {}",
                    NETBOX_CONSOLE_PORT_CF, n
                )
            }),
        Some(serde_json::Value::String(t)) => t
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or_else(|| {
                format!(
                    "`{}` must be a TCP port 1-65535, got \"{}\"",
                    NETBOX_CONSOLE_PORT_CF, t
                )
            }),
        Some(other) => Err(format!(
            "`{}` must be a TCP port 1-65535, got {}",
            NETBOX_CONSOLE_PORT_CF, other
        )),
    };

    Some(ParsedConsolePort {
        device_id,
        name,
        server,
        tcp_port,
    })
}

/// Console server reachability from a NetBox device object.
fn parse_console_server(v: &serde_json::Value) -> Option<NetBoxConsoleServerRef> {
    let id = v.get("id")?.as_i64()?;
    let name = v
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let host = ["primary_ip4", "primary_ip", "oob_ip"]
        .iter()
        .find_map(|key| {
            v.get(*key)
                .and_then(|ip| ip.get("address"))
                .and_then(|a| a.as_str())
                .map(|a| a.split('/').next().unwrap_or(a).to_string())
                .filter(|a| !a.is_empty())
        });
    let manufacturer_slug = v
        .get("device_type")
        .and_then(|dt| dt.get("manufacturer"))
        .and_then(|m| m.get("slug"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_lowercase());
    Some(NetBoxConsoleServerRef {
        id,
        name,
        host,
        manufacturer_slug,
    })
}

/// Pick the console path for a device from its console ports: the first
/// port that is cabled to a console server *and* carries a TCP port wins;
/// otherwise the most specific skip reason seen.
fn resolve_console_access(
    device_id: i64,
    ports: &[ParsedConsolePort],
    servers: &std::collections::HashMap<i64, NetBoxConsoleServerRef>,
) -> NetBoxConsoleAccess {
    let skipped =
        |port_name: Option<String>, skip: ConsoleSkip, reason: String| NetBoxConsoleAccess {
            device_id,
            console_port_name: port_name,
            tcp_port: None,
            console_server: None,
            skip: Some(skip),
            skip_reason: Some(reason),
        };
    if ports.is_empty() {
        return skipped(
            None,
            ConsoleSkip::NoConsolePort,
            "no console port in NetBox".to_string(),
        );
    }
    let mut best_reason: Option<(String, ConsoleSkip, String)> = None;
    for port in ports {
        let (server_id, server_name) = match &port.server {
            Some(s) => s.clone(),
            None => {
                best_reason.get_or_insert((
                    port.name.clone(),
                    ConsoleSkip::NotCabled,
                    "console port is not cabled to a console server".to_string(),
                ));
                continue;
            }
        };
        let tcp_port = match &port.tcp_port {
            Ok(p) => *p,
            Err(reason) => {
                best_reason = Some((port.name.clone(), ConsoleSkip::NoTcpPort, reason.clone()));
                continue;
            }
        };
        let Some(server) = servers.get(&server_id).filter(|s| s.host.is_some()) else {
            best_reason = Some((
                port.name.clone(),
                ConsoleSkip::ServerNoIp,
                format!(
                    "console server \"{}\" has no primary or OOB IP",
                    server_name
                ),
            ));
            continue;
        };
        return NetBoxConsoleAccess {
            device_id,
            console_port_name: Some(port.name.clone()),
            tcp_port: Some(tcp_port),
            console_server: Some(server.clone()),
            skip: None,
            skip_reason: None,
        };
    }
    let (port_name, skip, reason) = best_reason.expect("non-empty ports always record a reason");
    skipped(Some(port_name), skip, reason)
}

/// Fetch every page of a NetBox list endpoint, following `next` up to
/// `MAX_NETBOX_PAGES`.
async fn netbox_fetch_all_pages<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    token: &str,
    initial_url: String,
) -> Result<Vec<T>, ApiError> {
    let mut results: Vec<T> = vec![];
    let mut next_url: Option<String> = Some(initial_url);
    let mut page_count: u32 = 0;
    while let Some(api_url) = next_url {
        page_count += 1;
        if page_count > MAX_NETBOX_PAGES {
            return Err(ApiError {
                error: format!(
                    "NetBox returned more than {} pages — aborting to prevent runaway memory use",
                    MAX_NETBOX_PAGES
                ),
                code: "NETBOX_TOO_MANY_PAGES".to_string(),
            });
        }
        let response = client
            .get(&api_url)
            .header("Authorization", format!("Token {}", token))
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| ApiError {
                error: format!("Request failed: {}", e),
                code: "REQUEST_ERROR".to_string(),
            })?;
        if !response.status().is_success() {
            return Err(ApiError {
                error: format!("NetBox API error: {}", response.status()),
                code: "NETBOX_ERROR".to_string(),
            });
        }
        let data: NetBoxPaginatedResponse<T> = response.json().await.map_err(|e| ApiError {
            error: format!("Failed to parse response: {}", e),
            code: "PARSE_ERROR".to_string(),
        })?;
        results.extend(data.results);
        next_url = data.next;
    }
    Ok(results)
}

/// Requests in flight at once when a lookup is split into id chunks.
const NETBOX_CONCURRENT_REQUESTS: usize = 4;

/// List `path` filtered by `key=<id>` for every id, `NETBOX_ID_CHUNK` ids per
/// request, requests overlapped `NETBOX_CONCURRENT_REQUESTS` at a time.
async fn netbox_fetch_by_ids(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    path: &str,
    key: &str,
    ids: &[i64],
) -> Result<Vec<serde_json::Value>, ApiError> {
    use futures::{StreamExt, TryStreamExt};
    let limit_vec = vec!["1000".to_string()];
    let urls: Vec<String> = ids
        .chunks(NETBOX_ID_CHUNK)
        .map(|chunk| {
            let chunk_ids: Vec<String> = chunk.iter().map(|id| id.to_string()).collect();
            build_netbox_url(base_url, path, &[(key, &chunk_ids), ("limit", &limit_vec)])
        })
        .collect();
    let pages: Vec<Vec<serde_json::Value>> = futures::stream::iter(urls)
        .map(|url| netbox_fetch_all_pages::<serde_json::Value>(client, token, url))
        .buffer_unordered(NETBOX_CONCURRENT_REQUESTS)
        .try_collect()
        .await?;
    Ok(pages.into_iter().flatten().collect())
}

/// POST /netbox/proxy/console-access — resolve OOB console access for the
/// given devices from NetBox: each device's console port, the console
/// server it is cabled to, that server's IP, and the `device_console`
/// custom field (TCP port). One entry per requested device.
pub async fn netbox_proxy_console_access(
    Json(req): Json<NetBoxConsoleAccessRequest>,
) -> Result<Json<Vec<NetBoxConsoleAccess>>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // 1. Console ports of the requested devices.
    let mut ports_by_device: std::collections::HashMap<i64, Vec<ParsedConsolePort>> =
        std::collections::HashMap::new();
    for raw in netbox_fetch_by_ids(
        &client,
        &req.url,
        &req.token,
        "/dcim/console-ports/",
        "device_id",
        &req.device_ids,
    )
    .await?
    {
        if let Some(port) = parse_console_port(&raw) {
            ports_by_device
                .entry(port.device_id)
                .or_default()
                .push(port);
        }
    }

    // 2. The console servers those ports are cabled to (for IP + manufacturer).
    let mut server_ids: Vec<i64> = ports_by_device
        .values()
        .flatten()
        .filter_map(|p| p.server.as_ref().map(|(id, _)| *id))
        .collect();
    server_ids.sort_unstable();
    server_ids.dedup();
    let mut servers: std::collections::HashMap<i64, NetBoxConsoleServerRef> =
        std::collections::HashMap::new();
    for raw in netbox_fetch_by_ids(
        &client,
        &req.url,
        &req.token,
        "/dcim/devices/",
        "id",
        &server_ids,
    )
    .await?
    {
        if let Some(server) = parse_console_server(&raw) {
            servers.insert(server.id, server);
        }
    }

    // 3. One verdict per requested device.
    let empty: Vec<ParsedConsolePort> = vec![];
    let results = req
        .device_ids
        .iter()
        .map(|id| resolve_console_access(*id, ports_by_device.get(id).unwrap_or(&empty), &servers))
        .collect();
    Ok(Json(results))
}

/// GET /netbox-sources/:id/devices — list all devices for a saved NetBox source.
/// Returns the raw NetBox paginated payload so the frontend can read `data.results`
/// the same way it does when talking to NetBox directly.
pub async fn netbox_source_list_devices(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let source = state.provider.get_netbox_source(&id).await?;
    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &source.api_resource_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(api_resource_client_err)?;

    let response = client
        .send_authed(reqwest::Method::GET, "/api/dcim/devices/?limit=1000")
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "REQUEST_ERROR".to_string(),
        })?;

    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("NetBox API error: {}", response.status()),
            code: "NETBOX_ERROR".to_string(),
        });
    }

    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse NetBox response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;

    Ok(Json(data))
}

/// GET /netbox-sources/:id/devices/:device_id/neighbors — derive connected
/// neighbors for a NetBox device by walking its interfaces and reading the
/// `connected_endpoints` populated by NetBox when cables exist.
///
/// Returns `{ "neighbors": [{ deviceId, deviceName, localInterface, remoteInterface, cableId?, cableLabel? }, ...] }`
/// to match the frontend's `NetBoxNeighbor` shape (frontend/src/api/netbox.ts:77).
pub async fn netbox_source_device_neighbors(
    State(state): State<Arc<AppState>>,
    Path((id, device_id)): Path<(String, i64)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let source = state.provider.get_netbox_source(&id).await?;
    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &source.api_resource_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(api_resource_client_err)?;

    let path = format!("/api/dcim/interfaces/?device_id={}&limit=1000", device_id);
    let response = client
        .send_authed(reqwest::Method::GET, &path)
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "REQUEST_ERROR".to_string(),
        })?;

    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("NetBox API error: {}", response.status()),
            code: "NETBOX_ERROR".to_string(),
        });
    }

    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse NetBox response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;

    // Walk interfaces, extract connected_endpoints into NetBoxNeighbor shape.
    // Matches Approach 1 from frontend/src/api/netbox.ts:445-469.
    let mut neighbors = Vec::new();
    let mut seen_pairs = std::collections::HashSet::new();
    if let Some(interfaces) = data.get("results").and_then(|v| v.as_array()) {
        for iface in interfaces {
            let local_name = iface.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let cable_id = iface
                .get("cable")
                .and_then(|c| c.get("id"))
                .and_then(|v| v.as_i64());
            let cable_label = iface
                .get("cable")
                .and_then(|c| c.get("label"))
                .and_then(|v| v.as_str())
                .map(String::from);
            if let Some(endpoints) = iface.get("connected_endpoints").and_then(|v| v.as_array()) {
                for endpoint in endpoints {
                    let device = endpoint.get("device");
                    let (Some(dev_id), Some(dev_name)) = (
                        device.and_then(|d| d.get("id")).and_then(|v| v.as_i64()),
                        device.and_then(|d| d.get("name")).and_then(|v| v.as_str()),
                    ) else {
                        continue;
                    };
                    let remote_name = endpoint.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let pair_key =
                        format!("{}-{}-{}-{}", device_id, dev_id, local_name, remote_name);
                    if !seen_pairs.insert(pair_key) {
                        continue;
                    }
                    let mut n = serde_json::json!({
                        "deviceId": dev_id,
                        "deviceName": dev_name,
                        "localInterface": local_name,
                        "remoteInterface": remote_name,
                    });
                    if let Some(cid) = cable_id {
                        n["cableId"] = serde_json::json!(cid);
                    }
                    if let Some(cl) = &cable_label {
                        n["cableLabel"] = serde_json::json!(cl);
                    }
                    neighbors.push(n);
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "neighbors": neighbors })))
}

/// Request body for NetBox IP address search
#[derive(Debug, Deserialize)]
pub struct NetBoxSearchIpRequest {
    pub url: String,
    pub token: String,
    pub address: String,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
}

/// Search NetBox IPAM for an IP address (proxied for SSL bypass)
/// Returns the IP address record with assigned device/interface info
pub async fn netbox_proxy_ip_addresses(
    Json(req): Json<NetBoxSearchIpRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Strip CIDR mask if present, NetBox search by host address
    let address = req.address.split('/').next().unwrap_or(&req.address);
    let address_vec = vec![address.to_string()];
    let params: Vec<(&str, &[String])> = vec![("address", &address_vec)];
    let api_url = build_netbox_url(&req.url, "/ipam/ip-addresses/", &params);

    tracing::debug!("NetBox IP address search: {}", api_url);

    let response = client
        .get(&api_url)
        .header("Authorization", format!("Token {}", req.token))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "REQUEST_ERROR".to_string(),
        })?;

    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("NetBox API error: {}", response.status()),
            code: "NETBOX_ERROR".to_string(),
        });
    }

    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;

    // Return the first result if any
    if let Some(results) = data.get("results").and_then(|r| r.as_array()) {
        if let Some(first) = results.first() {
            return Ok(Json(first.clone()));
        }
    }

    // Return null/empty if no results
    Ok(Json(serde_json::Value::Null))
}

// === LibreNMS Sources Endpoints (Phase 22) ===

/// List all LibreNMS sources
pub async fn list_librenms_sources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<LibreNmsSource>>, ApiError> {
    let sources = state.provider.list_librenms_sources().await?;
    Ok(Json(sources))
}

/// Get a single LibreNMS source
pub async fn get_librenms_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<LibreNmsSource>, ApiError> {
    let source = state.provider.get_librenms_source(&id).await?;
    Ok(Json(source))
}

/// Create a new LibreNMS source
pub async fn create_librenms_source(
    State(state): State<Arc<AppState>>,
    Json(new_source): Json<NewLibreNmsSource>,
) -> Result<(StatusCode, Json<LibreNmsSource>), ApiError> {
    let source = state.provider.create_librenms_source(new_source).await?;
    Ok((StatusCode::CREATED, Json(source)))
}

/// Update an existing LibreNMS source
pub async fn update_librenms_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateLibreNmsSource>,
) -> Result<Json<LibreNmsSource>, ApiError> {
    let source = state.provider.update_librenms_source(&id, update).await?;
    Ok(Json(source))
}

/// Delete a LibreNMS source
pub async fn delete_librenms_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_librenms_source(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Request body for testing LibreNMS connection directly
#[derive(Debug, Deserialize)]
pub struct TestLibreNmsDirectRequest {
    pub url: String,
    pub token: String,
}

/// Response from testing LibreNMS connection
#[derive(Debug, Serialize)]
pub struct TestLibreNmsResponse {
    pub success: bool,
    pub message: String,
    pub version: Option<String>,
}

/// Test LibreNMS connection (using stored source)
pub async fn test_librenms_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<TestLibreNmsResponse>, ApiError> {
    let source = state.provider.get_librenms_source(&id).await?;
    let resource = state
        .provider
        .get_api_resource(&source.api_resource_id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("API resource {} not found", source.api_resource_id),
            code: "NOT_FOUND".to_string(),
        })?;
    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &source.api_resource_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(api_resource_client_err)?;

    // Use the resource's configured test_path if set; otherwise fall back to
    // LibreNMS's standard system-info endpoint.
    let test_path = resource.test_path.as_deref().unwrap_or("/api/v0/system");
    match client.send_authed(reqwest::Method::GET, test_path).await {
        Ok(response) => {
            if response.status().is_success() {
                let version = response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| {
                        v.get("system")
                            .and_then(|s| s.get(0))
                            .and_then(|s| s.get("local_ver"))
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });
                Ok(Json(TestLibreNmsResponse {
                    success: true,
                    message: "Connection successful".to_string(),
                    version,
                }))
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(Json(TestLibreNmsResponse {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                    version: None,
                }))
            }
        }
        Err(e) => Ok(Json(TestLibreNmsResponse {
            success: false,
            message: format!("Connection failed: {}", e),
            version: None,
        })),
    }
}

/// Test LibreNMS connection directly (no source required)
pub async fn test_librenms_direct(
    Json(req): Json<TestLibreNmsDirectRequest>,
) -> Result<Json<TestLibreNmsResponse>, ApiError> {
    test_librenms_api(&req.url, &req.token).await
}

/// Helper function to test LibreNMS API connectivity
async fn test_librenms_api(url: &str, token: &str) -> Result<Json<TestLibreNmsResponse>, ApiError> {
    let client = reqwest::Client::new();
    // LibreNMS API v0 uses /api/v0/system endpoint for basic info
    let api_url = format!("{}/api/v0/system", url.trim_end_matches('/'));

    match client
        .get(&api_url)
        .header("X-Auth-Token", token)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                let version = response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| {
                        v.get("system")
                            .and_then(|s| s.get(0))
                            .and_then(|s| s.get("local_ver"))
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });

                Ok(Json(TestLibreNmsResponse {
                    success: true,
                    message: "Connection successful".to_string(),
                    version,
                }))
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(Json(TestLibreNmsResponse {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                    version: None,
                }))
            }
        }
        Err(e) => Ok(Json(TestLibreNmsResponse {
            success: false,
            message: format!("Connection failed: {}", e),
            version: None,
        })),
    }
}

/// Response from LibreNMS devices endpoint
#[derive(Debug, Serialize)]
pub struct LibreNmsDevicesApiResponse {
    pub devices: Vec<LibreNmsDevice>,
}

/// Response from LibreNMS links endpoint
#[derive(Debug, Serialize)]
pub struct LibreNmsLinksApiResponse {
    pub links: Vec<LibreNmsLink>,
}

/// Helper: build a LibreNMS API client from a source id.
async fn librenms_client_for_source(
    state: &AppState,
    source_id: &str,
) -> Result<crate::api_resource_client::ApiResourceClient, ApiError> {
    let source = state.provider.get_librenms_source(source_id).await?;
    crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &source.api_resource_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(api_resource_client_err)
}

/// Get all devices from a LibreNMS source
pub async fn get_librenms_devices(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<LibreNmsDevicesApiResponse>, ApiError> {
    let client = librenms_client_for_source(&state, &id).await?;

    let response = client
        .send_authed(reqwest::Method::GET, "/api/v0/devices")
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to connect to LibreNMS: {}", e),
            code: "CONNECTION".to_string(),
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ApiError {
            error: format!("LibreNMS API error ({}): {}", status, body),
            code: "API_ERROR".to_string(),
        });
    }

    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse LibreNMS response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;

    let devices: Vec<LibreNmsDevice> = data
        .get("devices")
        .and_then(|d| serde_json::from_value(d.clone()).ok())
        .unwrap_or_default();

    Ok(Json(LibreNmsDevicesApiResponse { devices }))
}

/// Query params for the device links handler.
#[derive(Debug, Deserialize, Default)]
pub struct LibreNmsLinksQuery {
    /// When true, enrich each link with port-level statistics (utilization,
    /// errors, speed, operStatus) by hitting /api/v0/ports/{port_id} for
    /// every link's local_port_id. Defaults to false to preserve fast load.
    #[serde(default)]
    pub stats: bool,
}

/// Parse a single LibreNMS port object into our normalized PortStats.
/// Returns None when the value is not an object. Field names follow the
/// LibreNMS schema (see /api/v0/ports/{port_id}):
///   ifInOctets_rate  / ifOutOctets_rate  — bytes/sec (we convert to bits/sec ×8)
///   ifInErrors / ifOutErrors             — packet error counts
///   ifSpeed                              — bits/sec
///   ifOperStatus                         — string ("up", "down", ...)
pub fn parse_librenms_port_stats(value: &serde_json::Value) -> Option<LibreNmsPortStats> {
    let obj = value.as_object()?;
    let bytes_to_bits = |v: Option<i64>| v.map(|b| b.saturating_mul(8));
    // Numbers may arrive as either ints or strings — handle both.
    let i64_field = |key: &str| -> Option<i64> {
        let v = obj.get(key)?;
        if let Some(n) = v.as_i64() {
            return Some(n);
        }
        if let Some(f) = v.as_f64() {
            return Some(f as i64);
        }
        if let Some(s) = v.as_str() {
            return s
                .parse::<i64>()
                .ok()
                .or_else(|| s.parse::<f64>().ok().map(|f| f as i64));
        }
        None
    };
    let str_field = |key: &str| -> Option<String> {
        obj.get(key).and_then(|v| v.as_str().map(|s| s.to_string()))
    };
    Some(LibreNmsPortStats {
        in_rate_bps: bytes_to_bits(i64_field("ifInOctets_rate")),
        out_rate_bps: bytes_to_bits(i64_field("ifOutOctets_rate")),
        speed_bps: i64_field("ifSpeed"),
        in_errors: i64_field("ifInErrors"),
        out_errors: i64_field("ifOutErrors"),
        oper_status: str_field("ifOperStatus"),
    })
}

/// Fetch port statistics for a single port_id. Returns None on any failure
/// (HTTP error, parse error, deleted port) so callers can continue with
/// the rest of the link list.
async fn fetch_librenms_port_stats(
    client: &crate::api_resource_client::ApiResourceClient,
    port_id: i64,
) -> Option<LibreNmsPortStats> {
    let path = format!("/api/v0/ports/{}", port_id);
    let response = client.send_authed(reqwest::Method::GET, &path).await.ok()?;
    if !response.status().is_success() {
        tracing::warn!(
            target: "librenms",
            port_id = port_id,
            status = %response.status(),
            "fetch_librenms_port_stats: non-success status"
        );
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    // LibreNMS returns { "port": [ { ...fields... } ] } per port_id
    let port_obj = body
        .get("port")
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())
        .or_else(|| body.get("port"))?;
    parse_librenms_port_stats(port_obj)
}

/// Get links/neighbors for a specific device. With ?stats=true, enriches
/// each link with port-level statistics from /api/v0/ports/{port_id}.
pub async fn get_librenms_device_links(
    State(state): State<Arc<AppState>>,
    Path((id, hostname)): Path<(String, String)>,
    Query(query): Query<LibreNmsLinksQuery>,
) -> Result<Json<LibreNmsLinksApiResponse>, ApiError> {
    let client = librenms_client_for_source(&state, &id).await?;

    let path = format!("/api/v0/devices/{}/links", hostname);
    let response = client
        .send_authed(reqwest::Method::GET, &path)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to connect to LibreNMS: {}", e),
            code: "CONNECTION".to_string(),
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ApiError {
            error: format!("LibreNMS API error ({}): {}", status, body),
            code: "API_ERROR".to_string(),
        });
    }

    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse LibreNMS response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;

    let mut links: Vec<LibreNmsLink> = data
        .get("links")
        .and_then(|l| serde_json::from_value(l.clone()).ok())
        .unwrap_or_default();

    if query.stats && !links.is_empty() {
        // Parallel fan-out — limited concurrency to avoid overwhelming
        // small LibreNMS instances when a switch has 100+ links.
        use futures::stream::{self, StreamExt};
        const CONCURRENCY: usize = 8;
        let port_ids: Vec<i64> = links.iter().map(|l| l.local_port_id).collect();
        let stats_results: Vec<Option<LibreNmsPortStats>> = stream::iter(port_ids)
            .map(|pid| {
                let client = &client;
                async move { fetch_librenms_port_stats(client, pid).await }
            })
            .buffered(CONCURRENCY)
            .collect()
            .await;
        for (link, stats_opt) in links.iter_mut().zip(stats_results) {
            if let Some(stats) = stats_opt {
                link.local_port_in_rate_bps = stats.in_rate_bps;
                link.local_port_out_rate_bps = stats.out_rate_bps;
                link.local_port_speed_bps = stats.speed_bps;
                link.local_port_in_errors = stats.in_errors;
                link.local_port_out_errors = stats.out_errors;
                link.local_port_oper_status = stats.oper_status;
            }
        }
    }

    Ok(Json(LibreNmsLinksApiResponse { links }))
}

/// Get all links from a LibreNMS source
pub async fn get_librenms_all_links(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<LibreNmsLinksApiResponse>, ApiError> {
    let client = librenms_client_for_source(&state, &id).await?;

    let response = client
        .send_authed(reqwest::Method::GET, "/api/v0/links")
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to connect to LibreNMS: {}", e),
            code: "CONNECTION".to_string(),
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ApiError {
            error: format!("LibreNMS API error ({}): {}", status, body),
            code: "API_ERROR".to_string(),
        });
    }

    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse LibreNMS response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;

    let links: Vec<LibreNmsLink> = data
        .get("links")
        .and_then(|l| serde_json::from_value(l.clone()).ok())
        .unwrap_or_default();

    Ok(Json(LibreNmsLinksApiResponse { links }))
}

// === API Key Vault Endpoints ===

/// Request body for storing an API key
#[derive(Deserialize)]
pub struct StoreApiKeyRequest {
    pub api_key: String,
}

impl std::fmt::Debug for StoreApiKeyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreApiKeyRequest")
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

/// Response from checking if API key exists
#[derive(Debug, Serialize)]
pub struct HasApiKeyResponse {
    pub exists: bool,
}

/// Response from getting API key
#[derive(Debug, Serialize)]
pub struct GetApiKeyResponse {
    pub api_key: Option<String>,
}

/// Reject the three typed key names that have been centralized into the
/// API Resources framework. Frontend code should use the API Resource +
/// `api_resource_credentials` endpoints instead.
fn reject_centralized_vault_key(key_type: &str) -> Result<(), ApiError> {
    match key_type {
        "netbox" | "librenms" | "netdisco" | "netstacks-crawler" => Err(ApiError {
            error: format!(
                "vault key type '{}' is no longer supported — use an API Resource instead",
                key_type
            ),
            code: "GONE".to_string(),
        }),
        _ => Ok(()),
    }
}

/// Check if an API key exists in vault
pub async fn has_api_key(
    State(state): State<Arc<AppState>>,
    Path(key_type): Path<String>,
) -> Result<Json<HasApiKeyResponse>, ApiError> {
    reject_centralized_vault_key(&key_type)?;
    let exists = state.provider.has_api_key(&key_type).await?;
    Ok(Json(HasApiKeyResponse { exists }))
}

/// Get an API key from vault
pub async fn get_api_key(
    State(state): State<Arc<AppState>>,
    Path(key_type): Path<String>,
) -> Result<Json<GetApiKeyResponse>, ApiError> {
    reject_centralized_vault_key(&key_type)?;
    let api_key = state.provider.get_api_key(&key_type).await?;
    Ok(Json(GetApiKeyResponse { api_key }))
}

/// Store an API key in vault
pub async fn store_api_key(
    State(state): State<Arc<AppState>>,
    Path(key_type): Path<String>,
    Json(req): Json<StoreApiKeyRequest>,
) -> Result<StatusCode, ApiError> {
    reject_centralized_vault_key(&key_type)?;
    state
        .provider
        .store_api_key(&key_type, &req.api_key)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete an API key from vault
pub async fn delete_api_key(
    State(state): State<Arc<AppState>>,
    Path(key_type): Path<String>,
) -> Result<StatusCode, ApiError> {
    reject_centralized_vault_key(&key_type)?;
    state.provider.delete_api_key(&key_type).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Recording Endpoints ===

/// Optional query params for listing recordings
#[derive(Debug, Deserialize)]
pub struct ListRecordingsQuery {
    /// Filter by session ID
    pub session_id: Option<String>,
}

/// List all recordings
pub async fn list_recordings(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListRecordingsQuery>,
) -> Result<Json<Vec<Recording>>, ApiError> {
    let recordings = state
        .provider
        .list_recordings(query.session_id.as_deref())
        .await?;
    Ok(Json(recordings))
}

/// Get a single recording
pub async fn get_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Recording>, ApiError> {
    let recording = state.provider.get_recording(&id).await?;
    Ok(Json(recording))
}

/// Create a new recording
pub async fn create_recording(
    State(state): State<Arc<AppState>>,
    Json(new_recording): Json<NewRecording>,
) -> Result<(StatusCode, Json<Recording>), ApiError> {
    let recording = state.provider.create_recording(new_recording).await?;
    Ok((StatusCode::CREATED, Json(recording)))
}

/// Update a recording
pub async fn update_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateRecording>,
) -> Result<Json<Recording>, ApiError> {
    let recording = state.provider.update_recording(&id, update).await?;
    Ok(Json(recording))
}

/// Delete a recording
pub async fn delete_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_recording(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Get recording data (stream the asciicast file)
pub async fn get_recording_data(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let recording = state.provider.get_recording(&id).await?;

    // Read the recording file
    let content = tokio::fs::read_to_string(&recording.file_path)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to read recording file: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/x-asciicast")],
        content,
    ))
}

/// Append data to a recording file
#[derive(Debug, Deserialize)]
pub struct AppendRecordingRequest {
    pub data: String,
}

/// Append data to a recording
pub async fn append_recording_data(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<AppendRecordingRequest>,
) -> Result<StatusCode, ApiError> {
    let recording = state.provider.get_recording(&id).await?;

    // Append to the recording file
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&recording.file_path)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to open recording file: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    file.write_all(req.data.as_bytes())
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to write to recording file: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Request body for saving a recording to docs
#[derive(Debug, Deserialize)]
pub struct SaveRecordingToDocsRequest {
    pub session_id: Option<String>,
}

/// Response from saving a recording to docs
#[derive(Debug, Serialize)]
pub struct SaveRecordingToDocsResponse {
    pub document_id: String,
}

/// Save a recording reference as a document in the docs system
pub async fn save_recording_to_docs(
    State(state): State<Arc<AppState>>,
    Path(recording_id): Path<String>,
    Json(req): Json<SaveRecordingToDocsRequest>,
) -> Result<(StatusCode, Json<SaveRecordingToDocsResponse>), ApiError> {
    // Get the recording metadata
    let recording = state.provider.get_recording(&recording_id).await?;

    let doc_id = uuid::Uuid::new_v4().to_string();
    let now = crate::models::format_datetime(&chrono::Utc::now());

    // Create JSON content referencing the recording
    let content = serde_json::json!({
        "recording_id": recording.id,
        "name": recording.name,
        "duration_ms": recording.duration_ms,
        "terminal_cols": recording.terminal_cols,
        "terminal_rows": recording.terminal_rows,
    })
    .to_string();

    sqlx::query(
        r#"INSERT INTO documents (id, name, category, content_type, content, parent_folder, session_id, created_at, updated_at)
           VALUES (?, ?, 'outputs', 'recording', ?, 'recordings', ?, ?, ?)"#,
    )
    .bind(&doc_id)
    .bind(&recording.name)
    .bind(&content)
    .bind(req.session_id.as_deref().or(recording.session_id.as_deref()))
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Failed to create recording document: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    tracing::info!(
        "Created recording document '{}' (doc_id: {}, recording_id: {})",
        recording.name,
        doc_id,
        recording_id
    );

    Ok((
        StatusCode::CREATED,
        Json(SaveRecordingToDocsResponse {
            document_id: doc_id,
        }),
    ))
}

// === Highlight Rules Endpoints ===

/// Optional query params for listing highlight rules
#[derive(Debug, Deserialize)]
pub struct ListHighlightRulesQuery {
    /// Filter by session ID (optional)
    pub session_id: Option<String>,
}

/// List all highlight rules
pub async fn list_highlight_rules(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListHighlightRulesQuery>,
) -> Result<Json<Vec<HighlightRule>>, ApiError> {
    let rules = state
        .provider
        .list_highlight_rules(query.session_id.as_deref())
        .await?;
    Ok(Json(rules))
}

/// Get a single highlight rule
pub async fn get_highlight_rule(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<HighlightRule>, ApiError> {
    let rule = state.provider.get_highlight_rule(&id).await?;
    Ok(Json(rule))
}

/// Create a new highlight rule
pub async fn create_highlight_rule(
    State(state): State<Arc<AppState>>,
    Json(new_rule): Json<NewHighlightRule>,
) -> Result<(StatusCode, Json<HighlightRule>), ApiError> {
    let rule = state.provider.create_highlight_rule(new_rule).await?;
    Ok((StatusCode::CREATED, Json(rule)))
}

/// Update a highlight rule
pub async fn update_highlight_rule(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateHighlightRule>,
) -> Result<Json<HighlightRule>, ApiError> {
    let rule = state.provider.update_highlight_rule(&id, update).await?;
    Ok(Json(rule))
}

/// Delete a highlight rule
pub async fn delete_highlight_rule(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_highlight_rule(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Get effective highlight rules for a session (merged global + session-specific)
pub async fn get_effective_highlight_rules(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<HighlightRule>>, ApiError> {
    let rules = state
        .provider
        .get_effective_highlight_rules(&session_id)
        .await?;
    Ok(Json(rules))
}

// === Bulk Command Endpoints ===

/// Execute a command on multiple SSH sessions
pub async fn bulk_command(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BulkCommandRequest>,
) -> Result<Json<BulkCommandResponse>, ApiError> {
    // Validate request
    if req.session_ids.is_empty() {
        return Err(ApiError {
            error: "session_ids must not be empty".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    if req.command.is_empty() {
        return Err(ApiError {
            error: "command must not be empty".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    // AUDIT FIX (EXEC-018): emit a warn-level audit log for every bulk
    // command. The endpoint is not an AI tool surface today, but it has
    // fleet-wide blast radius; an audit trail is the minimum viable defence.
    tracing::warn!(
        target: "audit",
        session_count = req.session_ids.len(),
        command_len = req.command.len(),
        command_first_token = %req.command.split_whitespace().next().unwrap_or(""),
        "bulk_command issued across {} session(s)",
        req.session_ids.len()
    );

    let timeout_secs = req.timeout_secs.unwrap_or(30);
    if !(1..=300).contains(&timeout_secs) {
        return Err(ApiError {
            error: "timeout_secs must be between 1 and 300".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    // Build SSH configs for each session. Sessions we cannot prepare are
    // reported as failed results rather than silently dropped, so the
    // success/error counts the UI shows cover every session requested (NS-AGENT-7).
    let mut configs: Vec<(SshConfig, String, String)> = Vec::new();
    let mut skipped: Vec<ssh::CommandResult> = Vec::new();
    let skip = |session_id: &str, name: &str, host: &str, reason: String| ssh::CommandResult {
        session_id: session_id.to_string(),
        session_name: name.to_string(),
        host: host.to_string(),
        status: ssh::CommandStatus::Error,
        output: String::new(),
        error: Some(reason),
        execution_time_ms: 0,
        exit_code: None,
    };

    for session_id in &req.session_ids {
        // Get session from provider
        let session = match state.provider.get_session(session_id).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Failed to get session {}: {}", session_id, e);
                skipped.push(skip(
                    session_id,
                    session_id,
                    "",
                    format!("Session not found: {}", e),
                ));
                continue;
            }
        };

        // Get the profile for this session (required)
        let profile = match state.provider.get_profile(&session.profile_id).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(
                    "Failed to get profile for session {} ({}): {}",
                    session_id,
                    session.name,
                    e
                );
                skipped.push(skip(
                    session_id,
                    &session.name,
                    &session.host,
                    format!("Profile not found: {}", e),
                ));
                continue;
            }
        };

        // Get credentials from vault (profile credentials)
        let credential = state
            .provider
            .get_profile_credential(&session.profile_id)
            .await?;

        // Build SSH config from session + profile + credential
        let config = match build_ssh_config_from_session(&session, &profile, credential.as_ref()) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Skipping session {} ({}): {}", session_id, session.name, e);
                skipped.push(skip(session_id, &session.name, &session.host, e));
                continue;
            }
        };

        configs.push((config, session_id.clone(), session.name.clone()));
    }

    if configs.is_empty() {
        let detail = skipped
            .iter()
            .map(|r| {
                format!(
                    "{}: {}",
                    r.session_name,
                    r.error.as_deref().unwrap_or("unknown")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(ApiError {
            error: format!("No valid sessions for bulk command execution ({})", detail),
            code: "VALIDATION".to_string(),
        });
    }

    // Execute bulk command
    let mut response = ssh::execute_bulk_command(configs, req.command, timeout_secs).await;
    response.error_count += skipped.len() as u32;
    response.results.extend(skipped);

    Ok(Json(response))
}

// === AI SSH Execute Endpoint ===

/// Request for AI to execute one or more commands on a session.
///
/// Accepts either `command` (single, back-compat) or `commands` (batch, max 10).
/// Exactly one must be present. Batch mode keeps a single SSH connection open
/// and runs each command sequentially through the same shell session — ~10x
/// faster than N separate ai_ssh_execute calls because it avoids per-command
/// SSH handshake / auth / channel-open overhead.
#[derive(Debug, Deserialize)]
pub struct AiSshExecuteRequest {
    pub session_id: String,
    /// Single command (mutually exclusive with `commands`).
    #[serde(default)]
    pub command: Option<String>,
    /// Batch of commands to run sequentially on a single SSH connection.
    /// Max 10 to keep AI tool turns bounded.
    #[serde(default)]
    pub commands: Option<Vec<String>>,
    /// In batch mode, stop the remaining commands when one fails. Default false.
    #[serde(default)]
    pub stop_on_error: Option<bool>,
    #[serde(default = "default_ai_timeout")]
    pub timeout_secs: Option<u64>,
}

fn default_ai_timeout() -> Option<u64> {
    Some(30)
}

/// Per-command result returned in batch mode.
#[derive(Debug, Serialize)]
pub struct AiSshCommandResult {
    pub command: String,
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub execution_time_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Response from AI SSH execute.
///
/// Single-command callers see the legacy fields populated as before.
/// Batch callers ALSO get the legacy aggregate fields (`output` is the
/// per-command outputs joined with separators; `success` is true iff every
/// command succeeded; `execution_time_ms` is the total wall time) PLUS a
/// `results` array with structured per-command data.
#[derive(Debug, Serialize)]
pub struct AiSshExecuteResponse {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub execution_time_ms: u64,
    /// Present only in batch mode (when the request used the `commands` field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<AiSshCommandResult>>,
    /// Numeric exit code from the last command (Linux sessions only).
    /// Network CLI flavors (Cisco, Juniper, etc.) do not expose exit codes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Present when output was truncated. Use with GET /ai/ssh-output/{request_id}
    /// to paginate remaining output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Request to authorize AI commands headed for an OPEN terminal (PTY) session.
#[derive(Debug, Deserialize)]
pub struct AiCommandCheckRequest {
    /// Commands the AI intends to run on the live terminal via `run_command`.
    pub commands: Vec<String>,
}

/// Verdict for [`check_ai_commands`].
#[derive(Debug, Serialize)]
pub struct AiCommandCheckResponse {
    pub allowed: bool,
    /// First command that was rejected (set only when `allowed == false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected_command: Option<String>,
    /// Why the command was rejected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Whether server-side config mode was active at check time (so the caller
    /// can explain why a normally-blocked command was permitted).
    pub config_mode_active: bool,
}

/// Server-authoritative read-only gate for the `run_command` tool.
///
/// `run_command` executes on the live PTY entirely client-side, so — unlike
/// [`ai_ssh_execute`] — it never reaches a `CommandFilter`. That left a hole:
/// with config mode OFF, the read-only floor held only by the model's goodwill
/// (the system prompt claims "configuration commands will be rejected", but
/// nothing on the PTY path enforced it). This endpoint closes it — the frontend
/// MUST call it before writing to the terminal and refuse anything it rejects.
///
/// Read-only is enforced UNLESS server-side config mode is active — the same
/// master-password-gated, TTL'd state that governs every other write path — in
/// which case configuration commands are permitted (the intended opt-in).
pub async fn check_ai_commands(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiCommandCheckRequest>,
) -> Result<Json<AiCommandCheckResponse>, ApiError> {
    // Config mode on → the user explicitly opted into changes; allow.
    if is_config_mode_active(&state).await {
        return Ok(Json(AiCommandCheckResponse {
            allowed: true,
            rejected_command: None,
            reason: None,
            config_mode_active: true,
        }));
    }

    // Config mode off → enforce the same read-only CommandFilter the SSH tools
    // use. Reject the whole batch on the first disallowed command (fail closed).
    let filter = crate::tasks::tools::filter::CommandFilter::new();
    for cmd in &req.commands {
        if let Err(e) = filter.is_allowed(cmd) {
            tracing::warn!(
                target: "audit",
                command = %cmd,
                "run_command blocked by read-only CommandFilter ({})",
                e
            );
            return Ok(Json(AiCommandCheckResponse {
                allowed: false,
                rejected_command: Some(cmd.clone()),
                reason: Some(e.to_string()),
                config_mode_active: false,
            }));
        }
    }

    Ok(Json(AiCommandCheckResponse {
        allowed: true,
        rejected_command: None,
        reason: None,
        config_mode_active: false,
    }))
}

/// Execute a command on a single SSH session for AI enrichment
///
/// This endpoint allows the AI to SSH directly to devices using their
/// saved session credentials, without requiring an open terminal tab.
///
/// AUDIT FIX (EXEC-001): every command is checked against the read-only
/// `CommandFilter` before reaching the device. The previous implementation
/// dispatched the command unfiltered, which made this endpoint a one-call
/// device-takeover for any prompt-injected AI response. The same filter is
/// used by the agent ReAct loop's `SshCommandTool`.
pub async fn ai_ssh_execute(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiSshExecuteRequest>,
) -> Result<Json<AiSshExecuteResponse>, ApiError> {
    use crate::tasks::tools::filter::CommandFilter;

    // Resolve `command` / `commands` into a single Vec<String>.
    let command_list: Vec<String> = match (&req.command, &req.commands) {
        (Some(cmd), None) => {
            if cmd.is_empty() {
                return Err(ApiError {
                    error: "command must not be empty".to_string(),
                    code: "VALIDATION".to_string(),
                });
            }
            vec![cmd.clone()]
        }
        (None, Some(cmds)) => {
            if cmds.is_empty() {
                return Err(ApiError {
                    error: "commands must not be empty".to_string(),
                    code: "VALIDATION".to_string(),
                });
            }
            if cmds.len() > 10 {
                return Err(ApiError {
                    error: "commands array must have at most 10 entries".to_string(),
                    code: "VALIDATION".to_string(),
                });
            }
            cmds.clone()
        }
        (Some(_), Some(_)) => {
            return Err(ApiError {
                error: "Cannot specify both 'command' and 'commands' — use one".to_string(),
                code: "VALIDATION".to_string(),
            });
        }
        (None, None) => {
            return Err(ApiError {
                error: "Must specify either 'command' (string) or 'commands' (array)".to_string(),
                code: "VALIDATION".to_string(),
            });
        }
    };
    let is_batch = command_list.len() > 1;
    let stop_on_error = req.stop_on_error.unwrap_or(false);

    // Read-only command filter — apply to EVERY command BEFORE any device contact.
    // Mirrors what the backend ReAct SshCommandTool does.
    let filter = CommandFilter::new();
    for cmd in &command_list {
        if let Err(e) = filter.is_allowed(cmd) {
            tracing::warn!(
                session_id = %req.session_id,
                command = %cmd,
                "ai_ssh_execute: blocked by CommandFilter ({})",
                e
            );
            return Err(ApiError {
                error: format!("Command rejected by read-only filter: {} — `{}`", e, cmd),
                code: "VALIDATION".to_string(),
            });
        }
    }

    let timeout_secs = req.timeout_secs.unwrap_or(30);
    if !(1..=300).contains(&timeout_secs) {
        return Err(ApiError {
            error: "timeout_secs must be between 1 and 300".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    // Get session from provider
    let session = state
        .provider
        .get_session(&req.session_id)
        .await
        .map_err(|e| ApiError {
            error: format!("Session not found: {}", e),
            code: "NOT_FOUND".to_string(),
        })?;

    // Get the profile for this session (required)
    let profile = state
        .provider
        .get_profile(&session.profile_id)
        .await
        .map_err(|e| ApiError {
            error: format!("Profile not found for session '{}': {}", session.name, e),
            code: "NOT_FOUND".to_string(),
        })?;

    // Get credentials from vault (profile credentials)
    let credential = state
        .provider
        .get_profile_credential(&session.profile_id)
        .await?;

    // Build SSH config from session + profile + credential
    let config =
        build_ssh_config_from_session(&session, &profile, credential.as_ref()).map_err(|e| {
            ApiError {
                error: e,
                code: "AUTH_MISSING".to_string(),
            }
        })?;

    // Single-command path: existing behavior, returns the same legacy shape.
    if !is_batch {
        let cmd = command_list.into_iter().next().unwrap();
        let result = ssh::execute_command_on_session_with_approvals(
            config,
            req.session_id.clone(),
            session.name.clone(),
            cmd,
            std::time::Duration::from_secs(timeout_secs),
            Some(state.host_key_approvals.clone()),
        )
        .await;
        let success = result.status == ssh::CommandStatus::Success;
        return Ok(Json(AiSshExecuteResponse {
            success,
            output: result.output,
            error: result.error,
            execution_time_ms: result.execution_time_ms,
            results: None,
            exit_code: result.exit_code,
            request_id: None,
        }));
    }

    // Batch path: open ONE shell session and run all commands sequentially
    // through it, then return per-command results plus an aggregate transcript.
    let stepped: Vec<(String, String)> = command_list
        .iter()
        .enumerate()
        .map(|(i, cmd)| (format!("c{}", i), cmd.clone()))
        .collect();

    let shell_results = ssh::execute_commands_via_shell(
        config,
        req.session_id.clone(),
        session.name.clone(),
        ssh::ShellCommandBatch {
            auto_commands: Vec::new(), // paging-disable is the AI's job
            commands: stepped,
            post_commands: Vec::new(),
            timeout_per_command: std::time::Duration::from_secs(timeout_secs),
            ..Default::default()
        },
        false, // never auto-accept changed host keys here
    )
    .await;

    let mut results: Vec<AiSshCommandResult> = Vec::with_capacity(command_list.len());
    let mut all_success = true;
    let mut total_time_ms: u64 = 0;
    let mut aggregated_output = String::new();

    for (i, (cmd, r)) in command_list
        .iter()
        .zip(shell_results.commands.iter())
        .enumerate()
    {
        let success = r.status == ssh::CommandStatus::Success;
        if !success {
            all_success = false;
        }
        total_time_ms += r.execution_time_ms;

        // Aggregated output uses a clear per-command header so the AI can read
        // a single string and still know which command produced which lines.
        if !aggregated_output.is_empty() {
            aggregated_output.push('\n');
        }
        aggregated_output.push_str(&format!("=== [{}] {} ===\n", i + 1, cmd));
        aggregated_output.push_str(&r.output);

        results.push(AiSshCommandResult {
            command: cmd.clone(),
            success,
            output: r.output.clone(),
            error: r.error.clone(),
            execution_time_ms: r.execution_time_ms,
            exit_code: None,
        });

        if stop_on_error && !success {
            break;
        }
    }

    const MAX_INLINE_BYTES: usize = 8000;
    let (final_output, req_id) = if aggregated_output.len() > MAX_INLINE_BYTES {
        let request_id = uuid::Uuid::new_v4().to_string();
        state
            .output_cache
            .write()
            .await
            .insert(request_id.clone(), aggregated_output.clone());
        let truncated =
            &aggregated_output[..aggregated_output.floor_char_boundary(MAX_INLINE_BYTES)];
        let remaining = aggregated_output.len() - truncated.len();
        (
            format!("{}\n\n[OUTPUT TRUNCATED — {} more bytes. Use get_ssh_output with request_id=\"{}\" to fetch remaining.]", truncated, remaining, request_id),
            Some(request_id),
        )
    } else {
        (aggregated_output, None)
    };

    Ok(Json(AiSshExecuteResponse {
        success: all_success,
        output: final_output,
        error: if all_success {
            None
        } else {
            Some("One or more commands failed".to_string())
        },
        execution_time_ms: total_time_ms,
        results: Some(results),
        exit_code: None,
        request_id: req_id,
    }))
}

// === AI Bash Execution Endpoint ===

#[derive(Debug, Deserialize)]
pub struct AiBashExecuteRequest {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub commands: Option<Vec<String>>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default = "default_ai_timeout")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct AiBashExecuteResponse {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub execution_time_ms: u64,
}

/// Execute a bash command on the local system for the AI assistant.
///
/// Every command is validated by `BashCommandFilter` before execution.
/// The filter is enforced at the execution level — the AI cannot override it.
pub async fn ai_bash_execute(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiBashExecuteRequest>,
) -> Result<Json<AiBashExecuteResponse>, ApiError> {
    use crate::tasks::tools::bash_filter::BashCommandFilter;
    use std::time::Instant;
    use tokio::process::Command;

    // Resolve command/commands into Vec<String> (same pattern as ai_ssh_execute)
    let command_list: Vec<String> = match (&req.command, &req.commands) {
        (Some(cmd), None) => {
            if cmd.trim().is_empty() {
                return Err(ApiError {
                    error: "command must not be empty".to_string(),
                    code: "VALIDATION".to_string(),
                });
            }
            vec![cmd.clone()]
        }
        (None, Some(cmds)) => {
            if cmds.is_empty() {
                return Err(ApiError {
                    error: "commands must not be empty".to_string(),
                    code: "VALIDATION".to_string(),
                });
            }
            if cmds.len() > 10 {
                return Err(ApiError {
                    error: "commands array must have at most 10 entries".to_string(),
                    code: "VALIDATION".to_string(),
                });
            }
            cmds.clone()
        }
        (Some(_), Some(_)) => {
            return Err(ApiError {
                error: "Cannot specify both 'command' and 'commands' — use one".to_string(),
                code: "VALIDATION".to_string(),
            });
        }
        (None, None) => {
            return Err(ApiError {
                error: "Must specify either 'command' (string) or 'commands' (array)".to_string(),
                code: "VALIDATION".to_string(),
            });
        }
    };

    let timeout_secs = req.timeout_secs.unwrap_or(30).clamp(1, 300);

    // Load user-configured extra deny patterns from settings
    let extra_denied: Vec<String> = state
        .provider
        .get_setting("ai.bash.deniedCommands")
        .await
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let filter = BashCommandFilter::new().with_extra_denied(extra_denied);

    // Validate EVERY command before execution
    for cmd in &command_list {
        if let Err(e) = filter.is_allowed(cmd) {
            tracing::warn!(command = %cmd, "ai_bash_execute: blocked by BashCommandFilter ({})", e);
            return Err(ApiError {
                error: format!("Command rejected by bash filter: {}", e),
                code: "VALIDATION".to_string(),
            });
        }
    }

    // Detect available shell
    let shell = detect_shell();
    if shell.is_empty() {
        return Err(ApiError {
            error: "No bash shell available. On Windows, install WSL or Git Bash.".to_string(),
            code: "SHELL_NOT_FOUND".to_string(),
        });
    }

    let working_dir = req.working_directory.clone().unwrap_or_else(|| {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| "/tmp".to_string())
    });

    // Execute commands sequentially
    let start = Instant::now();
    let mut all_output = Vec::new();
    let mut last_exit_code: Option<i32> = None;
    let mut all_success = true;

    for (i, cmd) in command_list.iter().enumerate() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            Command::new(&shell)
                .arg("-c")
                .arg(cmd)
                .current_dir(&working_dir)
                .output(),
        )
        .await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_exit_code = output.status.code();

                let mut section = String::new();
                if command_list.len() > 1 {
                    section.push_str(&format!("=== [{}] {} ===\n", i + 1, cmd));
                }
                if !stdout.is_empty() {
                    section.push_str(&stdout);
                }
                if !stderr.is_empty() {
                    if !stdout.is_empty() {
                        section.push('\n');
                    }
                    section.push_str(&format!("[stderr] {}", stderr));
                }
                if !output.status.success() {
                    all_success = false;
                }
                all_output.push(section);
            }
            Ok(Err(e)) => {
                all_success = false;
                let msg = if command_list.len() > 1 {
                    format!("=== [{}] {} ===\n[error] {}", i + 1, cmd, e)
                } else {
                    format!("[error] {}", e)
                };
                all_output.push(msg);
                break;
            }
            Err(_) => {
                all_success = false;
                let msg = if command_list.len() > 1 {
                    format!(
                        "=== [{}] {} ===\n[error] Command timed out after {}s",
                        i + 1,
                        cmd,
                        timeout_secs
                    )
                } else {
                    format!("[error] Command timed out after {}s", timeout_secs)
                };
                all_output.push(msg);
                break;
            }
        }
    }

    let execution_time_ms = start.elapsed().as_millis() as u64;
    let combined_output = all_output.join("\n\n");

    Ok(Json(AiBashExecuteResponse {
        success: all_success,
        output: combined_output,
        error: if all_success {
            None
        } else {
            Some("One or more commands failed".to_string())
        },
        exit_code: last_exit_code,
        execution_time_ms,
    }))
}

/// Detect available shell on the system
fn detect_shell() -> String {
    #[cfg(not(target_os = "windows"))]
    {
        // Prefer bash, fall back to sh
        for shell in &["/bin/bash", "/usr/bin/bash", "/bin/sh"] {
            if std::path::Path::new(shell).exists() {
                return shell.to_string();
            }
        }
        String::new()
    }

    #[cfg(target_os = "windows")]
    {
        // Try WSL first, then Git Bash
        if std::process::Command::new("wsl.exe")
            .arg("--list")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return "wsl.exe".to_string();
        }

        let git_bash = r"C:\Program Files\Git\bin\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            return git_bash.to_string();
        }

        String::new()
    }
}

// === AI File Operation Endpoints ===

/// Request for AI write_file operation
#[derive(Debug, Deserialize)]
pub struct AiWriteFileRequest {
    pub session_id: String,
    pub filepath: String,
    pub content: String,
}

/// Request for AI edit_file operation
#[derive(Debug, Deserialize)]
pub struct AiEditFileRequest {
    pub session_id: String,
    pub filepath: String,
    pub old_text: String,
    pub new_text: String,
}

/// Request for AI patch_file operation
#[derive(Debug, Deserialize)]
pub struct AiPatchFileRequest {
    pub session_id: String,
    pub filepath: String,
    pub sed_expression: String,
}

/// Write a file on a remote server via SSH
pub async fn ai_write_file(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiWriteFileRequest>,
) -> Result<Json<AiSshExecuteResponse>, ApiError> {
    use crate::tasks::tools::write_helpers::{build_write_command, validate_filepath};

    let filepath = validate_filepath(&req.filepath).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let write_cmd = build_write_command(&filepath, &req.content).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let config = build_ssh_config_for_ai(&state, &req.session_id).await?;
    let session_name = get_session_name(&state, &req.session_id).await;

    let result = ssh::execute_command_on_session(
        config,
        req.session_id,
        session_name,
        write_cmd,
        std::time::Duration::from_secs(30),
    )
    .await;

    let success = result.status == ssh::CommandStatus::Success;
    Ok(Json(AiSshExecuteResponse {
        success,
        output: if success {
            format!(
                "Successfully wrote {} bytes to {}",
                req.content.len(),
                filepath
            )
        } else {
            result.output
        },
        error: result.error,
        execution_time_ms: result.execution_time_ms,
        results: None,
        exit_code: result.exit_code,
        request_id: None,
    }))
}

/// Edit a file on a remote server via SSH (find and replace)
pub async fn ai_edit_file(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiEditFileRequest>,
) -> Result<Json<AiSshExecuteResponse>, ApiError> {
    use crate::tasks::tools::write_helpers::{
        apply_edit, build_read_file_command, build_write_command, validate_filepath,
        MAX_EDIT_FILE_SIZE,
    };

    let filepath = validate_filepath(&req.filepath).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let config = build_ssh_config_for_ai(&state, &req.session_id).await?;
    let session_name = get_session_name(&state, &req.session_id).await;

    // Read the file
    let read_cmd = build_read_file_command(&filepath).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let read_result = ssh::execute_command_on_session(
        config.clone(),
        req.session_id.clone(),
        session_name.clone(),
        read_cmd,
        std::time::Duration::from_secs(30),
    )
    .await;

    if read_result.status != ssh::CommandStatus::Success {
        return Ok(Json(AiSshExecuteResponse {
            success: false,
            output: read_result.output,
            error: read_result.error,
            execution_time_ms: read_result.execution_time_ms,
            results: None,
            exit_code: read_result.exit_code,
            request_id: None,
        }));
    }

    if read_result.output.len() > MAX_EDIT_FILE_SIZE {
        return Err(ApiError {
            error: format!(
                "File is too large ({} bytes, max {} bytes)",
                read_result.output.len(),
                MAX_EDIT_FILE_SIZE
            ),
            code: "VALIDATION".to_string(),
        });
    }

    // Apply edit
    let new_content =
        apply_edit(&read_result.output, &req.old_text, &req.new_text).map_err(|e| ApiError {
            error: e,
            code: "VALIDATION".to_string(),
        })?;

    // Write back
    let write_cmd = build_write_command(&filepath, &new_content).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let result = ssh::execute_command_on_session(
        config,
        req.session_id,
        session_name,
        write_cmd,
        std::time::Duration::from_secs(30),
    )
    .await;

    let success = result.status == ssh::CommandStatus::Success;
    Ok(Json(AiSshExecuteResponse {
        success,
        output: if success {
            format!("Successfully edited {}", filepath)
        } else {
            result.output
        },
        error: result.error,
        execution_time_ms: result.execution_time_ms,
        results: None,
        exit_code: result.exit_code,
        request_id: None,
    }))
}

/// Patch a file on a remote server via sed
pub async fn ai_patch_file(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AiPatchFileRequest>,
) -> Result<Json<AiSshExecuteResponse>, ApiError> {
    use crate::tasks::tools::write_helpers::{build_sed_command, validate_filepath};

    let filepath = validate_filepath(&req.filepath).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let sed_cmd = build_sed_command(&filepath, &req.sed_expression).map_err(|e| ApiError {
        error: e,
        code: "VALIDATION".to_string(),
    })?;

    let config = build_ssh_config_for_ai(&state, &req.session_id).await?;
    let session_name = get_session_name(&state, &req.session_id).await;

    let result = ssh::execute_command_on_session(
        config,
        req.session_id,
        session_name,
        sed_cmd,
        std::time::Duration::from_secs(30),
    )
    .await;

    let success = result.status == ssh::CommandStatus::Success;
    Ok(Json(AiSshExecuteResponse {
        success,
        output: if success {
            format!("Successfully patched {}", filepath)
        } else {
            result.output
        },
        error: result.error,
        execution_time_ms: result.execution_time_ms,
        results: None,
        exit_code: result.exit_code,
        request_id: None,
    }))
}

/// Build SSH config for AI file operations (reuses ai_ssh_execute pattern)
async fn build_ssh_config_for_ai(
    state: &Arc<AppState>,
    session_id: &str,
) -> Result<ssh::SshConfig, ApiError> {
    let session = state
        .provider
        .get_session(session_id)
        .await
        .map_err(|e| ApiError {
            error: format!("Session not found: {}", e),
            code: "NOT_FOUND".to_string(),
        })?;

    let profile = state
        .provider
        .get_profile(&session.profile_id)
        .await
        .map_err(|e| ApiError {
            error: format!("Profile not found: {}", e),
            code: "NOT_FOUND".to_string(),
        })?;

    let credential = state
        .provider
        .get_profile_credential(&session.profile_id)
        .await?;

    build_ssh_config_from_session(&session, &profile, credential.as_ref()).map_err(|e| ApiError {
        error: e,
        code: "AUTH_MISSING".to_string(),
    })
}

/// Get session name for logging
async fn get_session_name(state: &Arc<AppState>, session_id: &str) -> String {
    state
        .provider
        .get_session(session_id)
        .await
        .map(|s| s.name)
        .unwrap_or_else(|_| session_id.to_string())
}

// === SFTP Endpoints ===

/// Shared SFTP state
pub struct SftpState {
    pub manager: SftpManager,
    pub app_state: Arc<AppState>,
}

/// SFTP error response
impl From<SftpError> for ApiError {
    fn from(err: SftpError) -> Self {
        let (code, error) = match &err {
            SftpError::ConnectionFailed(msg) => ("CONNECTION_FAILED".to_string(), msg.clone()),
            SftpError::AuthFailed(msg) => ("AUTH_FAILED".to_string(), msg.clone()),
            SftpError::KeyError(msg) => ("KEY_ERROR".to_string(), msg.clone()),
            SftpError::ChannelError(msg) => ("CHANNEL_ERROR".to_string(), msg.clone()),
            SftpError::Protocol(msg) => ("SFTP_ERROR".to_string(), msg.clone()),
            SftpError::_NotFound(msg) => ("NOT_FOUND".to_string(), msg.clone()),
            SftpError::_PermissionDenied(msg) => ("PERMISSION_DENIED".to_string(), msg.clone()),
            SftpError::SessionNotFound => (
                "SESSION_NOT_FOUND".to_string(),
                "SFTP session not found".to_string(),
            ),
            SftpError::_SessionClosed => (
                "SESSION_CLOSED".to_string(),
                "SFTP session closed".to_string(),
            ),
        };

        ApiError { error, code }
    }
}

/// Request to connect SFTP to a session
#[derive(Debug, Deserialize)]
pub struct SftpConnectRequest {
    /// Optional session ID - if provided, uses vault credentials
    pub session_id: Option<String>,
}

/// Response from SFTP connect
#[derive(Debug, Serialize)]
pub struct SftpConnectResponse {
    pub connected: bool,
    pub home_dir: Option<String>,
}

/// Connect to SFTP for a session
pub async fn sftp_connect(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    Json(req): Json<SftpConnectRequest>,
) -> Result<Json<SftpConnectResponse>, ApiError> {
    // Get session info if session_id provided
    let session_id = req.session_id.as_ref().unwrap_or(&sftp_id);

    let session = state.app_state.provider.get_session(session_id).await?;

    // Get the profile for this session (required)
    let profile = state
        .app_state
        .provider
        .get_profile(&session.profile_id)
        .await
        .map_err(|e| ApiError {
            error: format!("Profile not found for session: {}", e),
            code: "NOT_FOUND".to_string(),
        })?;

    // Get credentials from vault (profile credentials)
    let credential = state
        .app_state
        .provider
        .get_profile_credential(&session.profile_id)
        .await?;

    // Build SFTP auth from profile
    let auth = match profile.auth_type {
        AuthType::Password => {
            let password = credential
                .as_ref()
                .and_then(|c| c.password.clone())
                .ok_or_else(|| ApiError {
                    error: format!(
                        "No password found for session via profile '{}'",
                        profile.name
                    ),
                    code: "AUTH_FAILED".to_string(),
                })?;
            SftpAuth::Password(password)
        }
        AuthType::Key => {
            let key_path = profile.key_path.clone().ok_or_else(|| ApiError {
                error: format!(
                    "No key path found for session via profile '{}'",
                    profile.name
                ),
                code: "AUTH_FAILED".to_string(),
            })?;
            let passphrase = credential.as_ref().and_then(|c| c.key_passphrase.clone());
            SftpAuth::KeyFile {
                path: key_path,
                passphrase,
            }
        }
    };

    let config = SftpConfig {
        host: session.host.clone(),
        port: session.port,
        username: profile.username.clone(),
        auth,
    };

    // Connect
    state
        .manager
        .create_session(sftp_id.clone(), config)
        .await?;

    // Get home directory
    let home_dir = if let Some(sftp_session) = state.manager.get_session(&sftp_id).await {
        let session = sftp_session.lock().await;
        session.pwd().await.ok()
    } else {
        None
    };

    Ok(Json(SftpConnectResponse {
        connected: true,
        home_dir,
    }))
}

/// Disconnect SFTP session
pub async fn sftp_disconnect(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.manager.remove_session(&sftp_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Query params for listing directory
#[derive(Debug, Deserialize)]
pub struct SftpLsQuery {
    pub path: Option<String>,
}

/// Response from directory listing
#[derive(Debug, Serialize)]
pub struct SftpLsResponse {
    pub entries: Vec<FileEntry>,
    pub path: String,
}

/// List directory contents
pub async fn sftp_ls(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpLsQuery>,
) -> Result<Json<SftpLsResponse>, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let path = query.path.unwrap_or_else(|| "/".to_string());
    let session = sftp_session.lock().await;
    let entries = session.list_dir(&path).await?;

    Ok(Json(SftpLsResponse { entries, path }))
}

/// Query params for download
#[derive(Debug, Deserialize)]
pub struct SftpDownloadQuery {
    pub path: String,
}

/// Download a file
pub async fn sftp_download(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpDownloadQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let session = sftp_session.lock().await;
    let data = session.download(&query.path).await?;

    // Get filename for Content-Disposition. Filename is user-controlled
    // (the SFTP path basename), so it can contain quotes, CR/LF, or
    // non-ASCII characters. Build a safe header value: sanitized ASCII for
    // the legacy `filename=` parameter plus an RFC 6266 `filename*=UTF-8''`
    // percent-encoded form for full fidelity.
    let filename = std::path::Path::new(&query.path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());

    let ascii_fallback: String = filename
        .chars()
        .map(|c| {
            // Allow visible ASCII except characters that would break a quoted
            // header value or attempt header injection. Everything else
            // becomes an underscore.
            if c.is_ascii_graphic() && !matches!(c, '"' | '\\' | '\r' | '\n') {
                c
            } else if c == ' ' {
                ' '
            } else {
                '_'
            }
        })
        .collect();
    let ascii_fallback = if ascii_fallback.trim().is_empty() {
        "download".to_string()
    } else {
        ascii_fallback
    };

    // Percent-encode the full UTF-8 filename per RFC 5987 (filename*).
    // Allowed unreserved chars: ALPHA / DIGIT / "-" / "." / "_" / "~"
    let mut utf8_encoded = String::with_capacity(filename.len());
    for byte in filename.as_bytes() {
        let b = *byte;
        let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            utf8_encoded.push(b as char);
        } else {
            utf8_encoded.push_str(&format!("%{:02X}", b));
        }
    }

    let header_value_str = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        ascii_fallback, utf8_encoded
    );

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/octet-stream"),
    );
    // The sanitization above guarantees a valid header value; treat any
    // residual parse failure as a server-side bug and serve the file with
    // a generic disposition rather than panicking the request thread.
    let disposition = axum::http::HeaderValue::from_str(&header_value_str).unwrap_or_else(|_| {
        axum::http::HeaderValue::from_static("attachment; filename=\"download\"")
    });
    headers.insert(axum::http::header::CONTENT_DISPOSITION, disposition);

    Ok((headers, data))
}

/// Request for upload
#[derive(Debug, Deserialize)]
pub struct SftpUploadQuery {
    pub path: String,
}

/// Upload a file
pub async fn sftp_upload(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpUploadQuery>,
    body: axum::body::Body,
) -> Result<StatusCode, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    // Stream the request body straight into the remote file instead of
    // buffering it under the global body limit (NS-FEAT-13). The route
    // opts out of `DefaultBodyLimit` in main.rs.
    let session = sftp_session.lock().await;
    session
        .upload_from_stream(&query.path, body.into_data_stream())
        .await?;

    Ok(StatusCode::CREATED)
}

/// Query params for mkdir
#[derive(Debug, Deserialize)]
pub struct SftpMkdirQuery {
    pub path: String,
}

/// Create a directory
pub async fn sftp_mkdir(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpMkdirQuery>,
) -> Result<StatusCode, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let session = sftp_session.lock().await;
    session.mkdir(&query.path).await?;

    Ok(StatusCode::CREATED)
}

/// Query params for rm
#[derive(Debug, Deserialize)]
pub struct SftpRmQuery {
    pub path: String,
    /// If true, remove directory (rmdir), else remove file (rm)
    #[serde(default)]
    pub is_dir: bool,
}

/// Remove a file or directory
pub async fn sftp_rm(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpRmQuery>,
) -> Result<StatusCode, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let session = sftp_session.lock().await;
    if query.is_dir {
        session.rmdir(&query.path).await?;
    } else {
        session.rm(&query.path).await?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Query params for rename
#[derive(Debug, Deserialize)]
pub struct SftpRenameQuery {
    pub from: String,
    pub to: String,
}

/// Rename a file or directory
pub async fn sftp_rename(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpRenameQuery>,
) -> Result<StatusCode, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let session = sftp_session.lock().await;
    session.rename(&query.from, &query.to).await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Query params for stat
#[derive(Debug, Deserialize)]
pub struct SftpStatQuery {
    pub path: String,
}

/// Get file/directory info
pub async fn sftp_stat(
    State(state): State<Arc<SftpState>>,
    Path(sftp_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<SftpStatQuery>,
) -> Result<Json<FileEntry>, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let session = sftp_session.lock().await;
    let entry = session.stat(&query.path).await?;

    Ok(Json(entry))
}

// === Remote Agent Endpoints ===

pub async fn remote_agent_deploy(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::remote_agents::DeployRequest>,
) -> Result<Json<crate::remote_agents::DeployResponse>, ApiError> {
    let result = state.remote_agent_manager.deploy(&state, req).await?;
    Ok(Json(result))
}

pub async fn remote_agent_status(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
) -> Result<Json<crate::remote_agents::AgentStatusResponse>, ApiError> {
    let result = state.remote_agent_manager.status(&agent_id).await?;
    Ok(Json(result))
}

pub async fn remote_agent_stop(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.remote_agent_manager.stop(&state, &agent_id).await?;
    Ok(Json(serde_json::json!({ "stopped": true })))
}

// === Change Control Endpoints ===

/// Query params for listing changes
#[derive(Debug, Deserialize)]
pub struct ListChangesQuery {
    pub session_id: Option<String>,
}

/// List changes (optionally filtered by session)
pub async fn list_changes(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<ListChangesQuery>,
) -> Result<Json<Vec<Change>>, ApiError> {
    let changes = state
        .provider
        .list_changes(query.session_id.as_deref())
        .await?;
    Ok(Json(changes))
}

/// Get a single change
pub async fn get_change(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Change>, ApiError> {
    let change = state.provider.get_change(&id).await?;
    Ok(Json(change))
}

/// Create a new change
pub async fn create_change(
    State(state): State<Arc<AppState>>,
    Json(new_change): Json<NewChange>,
) -> Result<(StatusCode, Json<Change>), ApiError> {
    require_name(&new_change.name, "change")?;
    validate_change_steps(
        Some(&new_change.mop_steps),
        new_change.device_overrides.as_ref(),
    )?;
    validate_change_variables(&new_change.variables, &new_change.device_variables)?;
    let change = state.provider.create_change(new_change).await?;
    Ok((StatusCode::CREATED, Json(change)))
}

/// Update an existing change
pub async fn update_change(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateChange>,
) -> Result<Json<Change>, ApiError> {
    if let Some(ref name) = update.name {
        require_name(name, "change")?;
    }
    validate_change_steps(
        update.mop_steps.as_deref(),
        update.device_overrides.as_ref().and_then(|o| o.as_ref()),
    )?;
    if update.variables.is_some() || update.device_variables.is_some() {
        // Overrides sent without the declaration list are checked against
        // the stored declarations.
        let current = match (&update.variables, &update.device_variables) {
            (Some(_), Some(_)) => None,
            _ => Some(state.provider.get_change(&id).await?),
        };
        let variables = update
            .variables
            .as_deref()
            .or(current.as_ref().map(|c| c.variables.as_slice()))
            .unwrap_or(&[]);
        let empty = DeviceVariableMap::new();
        let device_variables = update
            .device_variables
            .as_ref()
            .or(current.as_ref().map(|c| &c.device_variables))
            .unwrap_or(&empty);
        validate_change_variables(variables, device_variables)?;
    }
    let change = state.provider.update_change(&id, update).await?;
    Ok(Json(change))
}

/// Delete a change
pub async fn delete_change(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_change(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === MOP Package Export/Import ===

/// Resolve a "name (host)" key to a session ID using cascade matching
fn resolve_session_from_key(key: &str, sessions: &[Session]) -> Option<String> {
    // Parse "name (host)" format
    let (name, host) = if let Some(paren_start) = key.rfind('(') {
        let name_part = key[..paren_start].trim();
        let host_part = key[paren_start + 1..].trim_end_matches(')').trim();
        (name_part, host_part)
    } else {
        // No parens - treat as name only
        (key.trim(), "")
    };

    // Try exact match on both name and host
    if !host.is_empty() {
        if let Some(s) = sessions.iter().find(|s| s.name == name && s.host == host) {
            return Some(s.id.clone());
        }
    }

    // Try host-only match
    if !host.is_empty() {
        if let Some(s) = sessions.iter().find(|s| s.host == host) {
            return Some(s.id.clone());
        }
    }

    // Try name-only match
    if let Some(s) = sessions.iter().find(|s| s.name == name) {
        return Some(s.id.clone());
    }

    None
}

/// Export a MOP (Change) as a portable .mop.json package
pub async fn export_mop_package(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopPackage>, ApiError> {
    let change = state.provider.get_change(&id).await?;
    let sessions = state.provider.list_sessions().await?;

    // Build session_id → "name (host)" map
    let session_map: std::collections::HashMap<String, String> = sessions
        .iter()
        .map(|s| (s.id.clone(), format!("{} ({})", s.name, s.host)))
        .collect();

    // Convert MopStep → MopPackageStep (strip instance data)
    let steps: Vec<MopPackageStep> = change
        .mop_steps
        .iter()
        .map(|s| MopPackageStep {
            order: s.order,
            step_type: s.step_type.clone(),
            command: s.command.clone(),
            description: s.description.clone(),
            expected_output: s.expected_output.clone(),
            execution_source: s.execution_source.clone(),
            quick_action_id: s.quick_action_id.clone(),
            quick_action_variables: s.quick_action_variables.clone(),
            script_id: s.script_id.clone(),
            script_args: s.script_args.clone(),
            paired_step_id: s.paired_step_id.clone(),
            output_format: s.output_format.clone(),
            device_scope: s.device_scope.clone(),
            device_ids: s.device_ids.clone(),
            deploy_metadata: s.deploy_metadata.clone(),
        })
        .collect();

    // Resolve device_overrides keys from session IDs to "name (host)"
    let device_overrides = change.device_overrides.map(|overrides| {
        overrides
            .into_iter()
            .map(|(session_id, steps)| {
                let key = session_map.get(&session_id).cloned().unwrap_or(session_id);
                let pkg_steps: Vec<MopPackageStep> = steps
                    .iter()
                    .map(|s| MopPackageStep {
                        order: s.order,
                        step_type: s.step_type.clone(),
                        command: s.command.clone(),
                        description: s.description.clone(),
                        expected_output: s.expected_output.clone(),
                        execution_source: s.execution_source.clone(),
                        quick_action_id: s.quick_action_id.clone(),
                        quick_action_variables: s.quick_action_variables.clone(),
                        script_id: s.script_id.clone(),
                        script_args: s.script_args.clone(),
                        paired_step_id: s.paired_step_id.clone(),
                        output_format: s.output_format.clone(),
                        device_scope: s.device_scope.clone(),
                        device_ids: s.device_ids.clone(),
                        deploy_metadata: s.deploy_metadata.clone(),
                    })
                    .collect();
                (key, pkg_steps)
            })
            .collect()
    });

    // Same re-keying for the per-device variable overrides.
    let device_variables: DeviceVariableMap = change
        .device_variables
        .iter()
        .map(|(session_id, vars)| {
            let key = session_map
                .get(session_id)
                .cloned()
                .unwrap_or_else(|| session_id.clone());
            (key, vars.clone())
        })
        .collect();

    // Fetch embedded document if linked
    let document = if let Some(ref doc_id) = change.document_id {
        let row = sqlx::query_as::<_, (String, String, String)>(
            "SELECT name, content_type, content FROM documents WHERE id = ?",
        )
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to fetch document: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

        row.map(|(name, content_type, content)| MopPackageDocument {
            name,
            content_type,
            content,
        })
    } else {
        None
    };

    let package = MopPackage {
        format: "netstacks-mop".to_string(),
        version: "1.0".to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        source: "NetStacks Terminal v0.0.2".to_string(),
        mop: MopPackageProcedure {
            name: change.name.clone(),
            description: change.description.clone(),
            author: change.created_by.clone(),
            steps,
            device_overrides,
            variables: change.variables.clone(),
            device_variables,
            document,
        },
        metadata: MopPackageMetadata {
            tags: change.tags.clone(),
            risk_level: change.risk_level.clone(),
            change_ticket: change.change_ticket.clone(),
            ..MopPackageMetadata::default()
        },
    };

    // Save to Documents under "mops" category
    let pkg_json = serde_json::to_string_pretty(&package).map_err(|e| ApiError {
        error: format!("Failed to serialize package: {}", e),
        code: "SERIALIZATION_ERROR".to_string(),
    })?;

    let doc_id = uuid::Uuid::new_v4().to_string();
    let now = crate::models::format_datetime(&chrono::Utc::now());
    let doc_name = format!("{}.mop.json", change.name);

    sqlx::query(
        r#"INSERT INTO documents (id, name, category, content_type, content, parent_folder, session_id, created_at, updated_at)
           VALUES (?, ?, 'mops', 'json', ?, NULL, NULL, ?, ?)"#,
    )
    .bind(&doc_id)
    .bind(&doc_name)
    .bind(&pkg_json)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Failed to save MOP document: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    Ok(Json(package))
}

/// A package step becomes a fresh plan step: new id, `pending`, no output.
fn package_step_to_mop_step(s: &MopPackageStep) -> MopStep {
    MopStep {
        id: uuid::Uuid::new_v4().to_string(),
        order: s.order,
        step_type: s.step_type.clone(),
        command: s.command.clone(),
        description: s.description.clone(),
        expected_output: s.expected_output.clone(),
        status: "pending".to_string(),
        output: None,
        executed_at: None,
        execution_source: s.execution_source.clone(),
        quick_action_id: s.quick_action_id.clone(),
        quick_action_variables: s.quick_action_variables.clone(),
        script_id: s.script_id.clone(),
        script_args: s.script_args.clone(),
        paired_step_id: s.paired_step_id.clone(),
        output_format: s.output_format.clone(),
        ai_feedback: None,
        device_scope: s.device_scope.clone(),
        device_ids: s.device_ids.clone(),
        deploy_metadata: s.deploy_metadata.clone(),
    }
}

/// Import a MOP package and create a new Change
pub async fn import_mop_package(
    State(state): State<Arc<AppState>>,
    Json(pkg): Json<MopPackage>,
) -> Result<(StatusCode, Json<MopImportResult>), ApiError> {
    let mut warnings: Vec<String> = Vec::new();

    // Validate format
    if pkg.format != "netstacks-mop" {
        return Err(ApiError {
            error: format!("Unknown format: '{}', expected 'netstacks-mop'", pkg.format),
            code: "INVALID_FORMAT".to_string(),
        });
    }

    // Validate version (accept 1.x)
    // 2.x packages only add optional fields (all `#[serde(default)]` here), so
    // they import fine; the frontend validator already accepts them (NS-API-15).
    let version_ok = ["1", "2"].contains(&pkg.version.as_str())
        || pkg.version.starts_with("1.")
        || pkg.version.starts_with("2.");
    if !version_ok {
        return Err(ApiError {
            error: format!(
                "Unsupported version: '{}', expected 1.x or 2.x",
                pkg.version
            ),
            code: "UNSUPPORTED_VERSION".to_string(),
        });
    }

    // Convert MopPackageStep → MopStep (new UUIDs, status=pending) and apply
    // the same validation as `POST /changes` (400 VALIDATION with the index).
    let mop_steps: Vec<MopStep> = pkg.mop.steps.iter().map(package_step_to_mop_step).collect();
    validate_mop_steps("mop.steps", &mop_steps)?;
    let steps_imported = mop_steps.len();

    // Resolve device override keys from "name (host)" → session IDs
    let sessions = state.provider.list_sessions().await?;
    let mut overrides_imported = 0usize;
    // Device hints: the only per-device references a package carries are the
    // override keys; the ones that resolve seed `session_ids`.
    let mut resolved_session_ids: Vec<String> = Vec::new();
    let mut device_overrides: Option<std::collections::HashMap<String, Vec<MopStep>>> = None;
    if let Some(overrides) = pkg.mop.device_overrides {
        let mut resolved: std::collections::HashMap<String, Vec<MopStep>> =
            std::collections::HashMap::new();
        for (key, pkg_steps) in overrides {
            let steps: Vec<MopStep> = pkg_steps.iter().map(package_step_to_mop_step).collect();
            validate_mop_steps(&format!("mop.device_overrides[{}]", key), &steps)?;
            if let Some(session_id) = resolve_session_from_key(&key, &sessions) {
                resolved_session_ids.push(session_id.clone());
                overrides_imported += 1;
                resolved.insert(session_id, steps);
            } else {
                warnings.push(format!(
                    "No matching session for device '{}', overrides skipped",
                    key
                ));
            }
        }
        device_overrides = Some(resolved);
    }

    // Plan variables round-trip; override keys are re-keyed like device_overrides.
    validate_change_variables(&pkg.mop.variables, &DeviceVariableMap::new())?;
    let mut device_variables = DeviceVariableMap::new();
    for (key, vars) in &pkg.mop.device_variables {
        if let Some(session_id) = resolve_session_from_key(key, &sessions) {
            resolved_session_ids.push(session_id.clone());
            device_variables.insert(session_id, vars.clone());
        } else {
            warnings.push(format!(
                "No matching session for device '{}', variable overrides skipped",
                key
            ));
        }
    }
    validate_change_variables(&pkg.mop.variables, &device_variables)?;
    let variables_json = serde_json::to_string(&pkg.mop.variables).map_err(|e| ApiError {
        error: format!("Failed to serialize variables: {}", e),
        code: "SERIALIZATION_ERROR".to_string(),
    })?;
    let device_variables_json = serde_json::to_string(&device_variables).map_err(|e| ApiError {
        error: format!("Failed to serialize device_variables: {}", e),
        code: "SERIALIZATION_ERROR".to_string(),
    })?;

    // Create embedded document if present
    let mut document_created = false;
    let document_id = if let Some(doc) = &pkg.mop.document {
        let doc_id = uuid::Uuid::new_v4().to_string();
        let now = crate::models::format_datetime(&chrono::Utc::now());

        sqlx::query(
            r#"INSERT INTO documents (id, name, category, content_type, content, parent_folder, session_id, created_at, updated_at)
               VALUES (?, ?, 'mops', ?, ?, NULL, NULL, ?, ?)"#,
        )
        .bind(&doc_id)
        .bind(&doc.name)
        .bind(&doc.content_type)
        .bind(&doc.content)
        .bind(&now)
        .bind(&now)
        .execute(&state.pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to create document: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

        document_created = true;
        Some(doc_id)
    } else {
        None
    };

    // Insert Change directly (bypass provider.create_change which requires valid session_id)
    let change_id = uuid::Uuid::new_v4().to_string();
    let now = crate::models::format_datetime(&chrono::Utc::now());
    let mop_steps_json = serde_json::to_string(&mop_steps).map_err(|e| ApiError {
        error: format!("Failed to serialize mop_steps: {}", e),
        code: "SERIALIZATION_ERROR".to_string(),
    })?;
    let device_overrides_json = device_overrides
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| ApiError {
            error: format!("Failed to serialize device_overrides: {}", e),
            code: "SERIALIZATION_ERROR".to_string(),
        })?;

    resolved_session_ids.sort();
    resolved_session_ids.dedup();
    let tags_json = serde_json::to_string(&pkg.metadata.tags).unwrap_or_else(|_| "[]".to_string());
    let session_ids_json =
        serde_json::to_string(&resolved_session_ids).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        r#"INSERT INTO changes (
            id, session_id, name, description, status, mop_steps,
            device_overrides, document_id, risk_level, change_ticket, tags, session_ids,
            variables, device_variables,
            created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&change_id)
    .bind(None::<String>) // session-unbound for imported MOPs
    .bind(&pkg.mop.name)
    .bind(&pkg.mop.description)
    .bind(&mop_steps_json)
    .bind(&device_overrides_json)
    .bind(&document_id)
    .bind(&pkg.metadata.risk_level)
    .bind(&pkg.metadata.change_ticket)
    .bind(&tags_json)
    .bind(&session_ids_json)
    .bind(&variables_json)
    .bind(&device_variables_json)
    .bind(&pkg.mop.author)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Failed to create change: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    Ok((
        StatusCode::CREATED,
        Json(MopImportResult {
            change_id,
            name: pkg.mop.name,
            steps_imported,
            overrides_imported,
            document_created,
            warnings,
        }),
    ))
}

/// List snapshots for a change
pub async fn list_snapshots(
    State(state): State<Arc<AppState>>,
    Path(change_id): Path<String>,
) -> Result<Json<Vec<Snapshot>>, ApiError> {
    let snapshots = state.provider.list_snapshots(&change_id).await?;
    Ok(Json(snapshots))
}

/// Get a single snapshot
pub async fn get_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, ApiError> {
    let snapshot = state.provider.get_snapshot(&id).await?;
    Ok(Json(snapshot))
}

/// Create a new snapshot
pub async fn create_snapshot(
    State(state): State<Arc<AppState>>,
    Json(new_snapshot): Json<NewSnapshot>,
) -> Result<(StatusCode, Json<Snapshot>), ApiError> {
    let snapshot = state.provider.create_snapshot(new_snapshot).await?;
    Ok((StatusCode::CREATED, Json(snapshot)))
}

/// Delete a snapshot
pub async fn delete_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_snapshot(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Session Context Endpoints (Phase 14) ===

/// List context entries for a session
pub async fn list_session_context(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<SessionContext>>, ApiError> {
    let contexts = state.provider.list_session_context(&session_id).await?;
    Ok(Json(contexts))
}

/// Get a single session context entry
pub async fn get_session_context(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SessionContext>, ApiError> {
    let context = state.provider.get_session_context(&id).await?;
    Ok(Json(context))
}

/// Create a new session context entry
pub async fn create_session_context(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(mut new_context): Json<NewSessionContext>,
) -> Result<(StatusCode, Json<SessionContext>), ApiError> {
    // Ensure session_id in path is used
    new_context.session_id = session_id;
    let context = state.provider.create_session_context(new_context).await?;
    Ok((StatusCode::CREATED, Json(context)))
}

/// Update a session context entry
pub async fn update_session_context(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateSessionContext>,
) -> Result<Json<SessionContext>, ApiError> {
    let context = state.provider.update_session_context(&id, update).await?;
    Ok(Json(context))
}

/// Delete a session context entry
pub async fn delete_session_context(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_session_context(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Output Pagination Endpoint ===

#[derive(Debug, Deserialize)]
pub struct GetSshOutputQuery {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

pub async fn get_ssh_output(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<String>,
    Query(query): Query<GetSshOutputQuery>,
) -> Result<Json<OutputPage>, ApiError> {
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(8000).min(32000);

    let cache = state.output_cache.read().await;
    match cache.get_page(&request_id, offset, limit) {
        Some(page) => Ok(Json(page)),
        None => Err(ApiError {
            error: "Output not found or expired (5-minute TTL)".to_string(),
            code: "NOT_FOUND".to_string(),
        }),
    }
}

// === Device Memory Endpoints ===

pub async fn get_device_memory(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<DeviceMemoryWithEntries>, ApiError> {
    let memory = state
        .provider
        .get_or_create_device_memory(&session_id)
        .await?;
    Ok(Json(memory))
}

pub async fn update_device_memory_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(update): Json<UpdateDeviceMemory>,
) -> Result<Json<DeviceMemory>, ApiError> {
    let existing = state
        .provider
        .get_or_create_device_memory(&session_id)
        .await?;
    let memory = state
        .provider
        .update_device_memory(&existing.memory.id, update)
        .await?;
    Ok(Json(memory))
}

pub async fn create_device_memory_entry_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(entry): Json<NewDeviceMemoryEntry>,
) -> Result<(StatusCode, Json<DeviceMemoryEntry>), ApiError> {
    let existing = state
        .provider
        .get_or_create_device_memory(&session_id)
        .await?;
    let new_entry = state
        .provider
        .create_device_memory_entry(&existing.memory.id, entry)
        .await?;
    Ok((StatusCode::CREATED, Json(new_entry)))
}

pub async fn update_device_memory_entry_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateDeviceMemoryEntry>,
) -> Result<Json<DeviceMemoryEntry>, ApiError> {
    let entry = state
        .provider
        .update_device_memory_entry(&id, update)
        .await?;
    Ok(Json(entry))
}

pub async fn delete_device_memory_entry_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_device_memory_entry(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================================
// Network Lookup Endpoints (Phase 19)
// ============================================

/// OUI Lookup Response
#[derive(Debug, Serialize)]
pub struct OuiLookupResponse {
    pub mac: String,
    pub vendor: Option<String>,
    pub error: Option<String>,
}

/// OUI lookup - get vendor from MAC address
pub async fn lookup_oui(Path(mac): Path<String>) -> Json<OuiLookupResponse> {
    // Normalize MAC - extract first 6 hex chars (OUI portion)
    let normalized: String = mac
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(6)
        .collect::<String>()
        .to_uppercase();

    if normalized.len() < 6 {
        return Json(OuiLookupResponse {
            mac: mac.clone(),
            vendor: None,
            error: Some("Invalid MAC address format".to_string()),
        });
    }

    // Format as XX:XX:XX for API
    let oui = format!(
        "{}:{}:{}",
        &normalized[0..2],
        &normalized[2..4],
        &normalized[4..6]
    );

    // Call macvendors.io API (free, no key required)
    let client = reqwest::Client::new();
    let url = format!("https://api.macvendors.com/{}", mac);

    match client
        .get(&url)
        .header("User-Agent", "NetStacks/1.0")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                match response.text().await {
                    Ok(vendor) => Json(OuiLookupResponse {
                        mac: mac.clone(),
                        vendor: Some(vendor.trim().to_string()),
                        error: None,
                    }),
                    Err(e) => Json(OuiLookupResponse {
                        mac: mac.clone(),
                        vendor: None,
                        error: Some(format!("Failed to read response: {}", e)),
                    }),
                }
            } else if response.status().as_u16() == 404 {
                Json(OuiLookupResponse {
                    mac: mac.clone(),
                    vendor: Some(format!("Unknown vendor (OUI: {})", oui)),
                    error: None,
                })
            } else {
                Json(OuiLookupResponse {
                    mac: mac.clone(),
                    vendor: None,
                    error: Some(format!("API error: {}", response.status())),
                })
            }
        }
        Err(e) => Json(OuiLookupResponse {
            mac: mac.clone(),
            vendor: None,
            error: Some(format!("Network error: {}", e)),
        }),
    }
}

/// DNS Lookup Response
#[derive(Debug, Serialize)]
pub struct DnsLookupResponse {
    pub query: String,
    pub query_type: String,
    pub results: Vec<String>,
    pub error: Option<String>,
}

/// Validate a host/IP query string for the lookup endpoints.
///
/// AUDIT FIX (DATA-005): the lookup_* endpoints previously accepted any path
/// parameter and shelled out (via `Command::arg`, so no shell-injection, but
/// every input flowed straight to upstream public DNS/WHOIS infrastructure
/// regardless of garbage). This validator restricts inputs to the union of
/// IPv4/IPv6 literals and hostnames matching RFC1035 syntax.
fn validate_lookup_host(query: &str) -> Result<(), String> {
    let q = query.trim();
    if q.is_empty() || q.len() > 253 {
        return Err("query must be 1-253 characters".to_string());
    }
    if q.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    let valid = q.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    });
    if valid {
        Ok(())
    } else {
        Err("query must be an IP address or RFC1035 hostname".to_string())
    }
}

/// Process-wide DNS resolver. Initialized lazily on first use; reused for
/// every subsequent lookup so we don't re-parse system DNS config or
/// reopen sockets per request.
///
/// `tokio_from_system_conf()` reads `/etc/resolv.conf` on Unix and the
/// Win32 IP Helper API on Windows. If that fails for any reason we fall
/// back to the crate defaults (Google + Cloudflare) so the agent stays
/// functional rather than 500-ing on every hover.
pub(crate) fn dns_resolver() -> &'static hickory_resolver::TokioAsyncResolver {
    use hickory_resolver::config::{ResolverConfig, ResolverOpts};
    use hickory_resolver::TokioAsyncResolver;
    use std::sync::OnceLock;
    static RESOLVER: OnceLock<TokioAsyncResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| {
        TokioAsyncResolver::tokio_from_system_conf().unwrap_or_else(|e| {
            tracing::warn!(
                "DNS: falling back to default resolvers — system config unreadable: {}",
                e
            );
            TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default())
        })
    })
}

/// DNS lookup - forward or reverse
pub async fn lookup_dns(Path(query): Path<String>) -> Json<DnsLookupResponse> {
    use std::net::ToSocketAddrs;

    if let Err(e) = validate_lookup_host(&query) {
        return Json(DnsLookupResponse {
            query: query.clone(),
            query_type: "rejected".to_string(),
            results: vec![],
            error: Some(e),
        });
    }

    // Detect if it's an IP (reverse lookup) or hostname (forward lookup)
    let parsed_ip = query.parse::<std::net::IpAddr>().ok();
    let query_type = if parsed_ip.is_some() {
        "PTR (reverse)"
    } else {
        "A/AAAA (forward)"
    };

    if let Some(ip) = parsed_ip {
        // Reverse DNS via hickory-resolver — pure-Rust, cross-platform.
        // Previously this shelled out to the `host` BIND utility, which
        // does not exist on Windows.
        use hickory_resolver::error::ResolveErrorKind;
        match dns_resolver().reverse_lookup(ip).await {
            Ok(response) => {
                let results: Vec<String> = response
                    .iter()
                    .map(|name| name.to_utf8().trim_end_matches('.').to_string())
                    .collect();

                if results.is_empty() {
                    Json(DnsLookupResponse {
                        query: query.clone(),
                        query_type: query_type.to_string(),
                        results: vec!["No PTR record found".to_string()],
                        error: None,
                    })
                } else {
                    Json(DnsLookupResponse {
                        query: query.clone(),
                        query_type: query_type.to_string(),
                        results,
                        error: None,
                    })
                }
            }
            Err(e) if matches!(e.kind(), ResolveErrorKind::NoRecordsFound { .. }) => {
                // NXDOMAIN / empty PTR — present as the same "No PTR record
                // found" string the legacy `host` path returned, so the
                // hover tooltip looks identical.
                Json(DnsLookupResponse {
                    query: query.clone(),
                    query_type: query_type.to_string(),
                    results: vec!["No PTR record found".to_string()],
                    error: None,
                })
            }
            Err(e) => Json(DnsLookupResponse {
                query: query.clone(),
                query_type: query_type.to_string(),
                results: vec![],
                error: Some(format!("DNS lookup failed: {}", e)),
            }),
        }
    } else {
        // Forward DNS lookup
        match format!("{}:0", query).to_socket_addrs() {
            Ok(addrs) => {
                let results: Vec<String> = addrs.map(|addr| addr.ip().to_string()).collect();

                if results.is_empty() {
                    Json(DnsLookupResponse {
                        query: query.clone(),
                        query_type: query_type.to_string(),
                        results: vec!["No records found".to_string()],
                        error: None,
                    })
                } else {
                    Json(DnsLookupResponse {
                        query: query.clone(),
                        query_type: query_type.to_string(),
                        results,
                        error: None,
                    })
                }
            }
            Err(e) => Json(DnsLookupResponse {
                query: query.clone(),
                query_type: query_type.to_string(),
                results: vec![],
                error: Some(format!("DNS lookup failed: {}", e)),
            }),
        }
    }
}

/// Whois Lookup Response
#[derive(Debug, Serialize)]
pub struct WhoisLookupResponse {
    pub query: String,
    pub summary: Option<WhoisSummary>,
    pub raw: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WhoisSummary {
    pub organization: Option<String>,
    pub country: Option<String>,
    pub network_name: Option<String>,
    pub cidr: Option<String>,
    pub description: Option<String>,
}

/// Whois lookup for IP addresses
pub async fn lookup_whois(Path(query): Path<String>) -> Json<WhoisLookupResponse> {
    if let Err(e) = validate_lookup_host(&query) {
        return Json(WhoisLookupResponse {
            query: query.clone(),
            summary: None,
            raw: None,
            error: Some(e),
        });
    }

    // Run whois command
    let output = tokio::process::Command::new("whois")
        .arg(&query)
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();

            // Parse common fields from whois output
            let mut summary = WhoisSummary {
                organization: None,
                country: None,
                network_name: None,
                cidr: None,
                description: None,
            };

            for line in stdout.lines() {
                let lower = line.to_lowercase();
                if lower.starts_with("orgname:")
                    || lower.starts_with("org-name:")
                    || lower.starts_with("organization:")
                {
                    summary.organization =
                        Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("country:") {
                    summary.country = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("netname:") {
                    summary.network_name =
                        Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("cidr:") {
                    summary.cidr = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("descr:") && summary.description.is_none() {
                    summary.description =
                        Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                }
            }

            Json(WhoisLookupResponse {
                query: query.clone(),
                summary: Some(summary),
                raw: Some(stdout),
                error: None,
            })
        }
        Err(e) => Json(WhoisLookupResponse {
            query: query.clone(),
            summary: None,
            raw: None,
            error: Some(format!("Whois lookup failed: {}", e)),
        }),
    }
}

/// ASN Lookup Response
#[derive(Debug, Serialize)]
pub struct AsnLookupResponse {
    pub asn: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub country: Option<String>,
    pub error: Option<String>,
}

/// ASN lookup
pub async fn lookup_asn(Path(asn): Path<String>) -> Json<AsnLookupResponse> {
    // Extract just the number if prefixed with AS
    let asn_num = asn.trim_start_matches("AS").trim_start_matches("as");

    // AUDIT FIX (DATA-005): require numeric ASN. Without this the path was
    // `whois "AS<arbitrary string>"` and we leaked any user-supplied tail to
    // the upstream WHOIS server.
    if asn_num.is_empty() || !asn_num.chars().all(|c| c.is_ascii_digit()) {
        return Json(AsnLookupResponse {
            asn: asn.clone(),
            name: None,
            description: None,
            country: None,
            error: Some("ASN must be numeric (e.g. '15169' or 'AS15169')".to_string()),
        });
    }

    // Run whois on the ASN
    let output = tokio::process::Command::new("whois")
        .arg(format!("AS{}", asn_num))
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();

            let mut name: Option<String> = None;
            let mut description: Option<String> = None;
            let mut country: Option<String> = None;

            for line in stdout.lines() {
                let lower = line.to_lowercase();
                if lower.starts_with("as-name:") || lower.starts_with("asname:") {
                    name = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("descr:") && description.is_none() {
                    description = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("country:") {
                    country = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("orgname:") && name.is_none() {
                    name = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                }
            }

            Json(AsnLookupResponse {
                asn: format!("AS{}", asn_num),
                name,
                description,
                country,
                error: None,
            })
        }
        Err(e) => Json(AsnLookupResponse {
            asn: format!("AS{}", asn_num),
            name: None,
            description: None,
            country: None,
            error: Some(format!("ASN lookup failed: {}", e)),
        }),
    }
}

// === Saved Topologies Endpoints (Phase 20.1) ===

/// Request to add a device to a topology
#[derive(Debug, Deserialize)]
pub struct AddDeviceRequest {
    /// Session ID - if provided, device is linked to this session
    #[serde(default)]
    pub session_id: Option<String>,
    /// Device name (required if no session_id)
    #[serde(default)]
    pub name: Option<String>,
    /// Device host/IP (required if no session_id)
    #[serde(default)]
    pub host: Option<String>,
    /// Device type (router, switch, etc.)
    #[serde(default)]
    pub device_type: Option<String>,
    /// X position on canvas
    #[serde(default)]
    pub x: Option<f64>,
    /// Y position on canvas
    #[serde(default)]
    pub y: Option<f64>,
    /// Profile ID for SSH/credentials (used for discovered devices)
    #[serde(default)]
    pub profile_id: Option<String>,
    /// SNMP profile ID for interface stats polling (may differ from SSH profile)
    #[serde(default)]
    pub snmp_profile_id: Option<String>,
}

// === Topology Folder Endpoints ===

/// List topology folders
pub async fn list_topology_folders(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Folder>>, ApiError> {
    let folders = state.provider.list_folders(Some("topology")).await?;
    Ok(Json(folders))
}

/// Get a single topology folder
pub async fn get_topology_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Folder>, ApiError> {
    let folder = state.provider.get_folder(&id).await?;
    Ok(Json(folder))
}

/// Create a new topology folder
pub async fn create_topology_folder(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NewFolder>,
) -> Result<(StatusCode, Json<Folder>), ApiError> {
    let folder = state
        .provider
        .create_folder(NewFolder {
            name: req.name,
            parent_id: req.parent_id,
            scope: Some("topology".into()),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(folder)))
}

/// Update a topology folder
pub async fn update_topology_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateFolder>,
) -> Result<Json<Folder>, ApiError> {
    let folder = state.provider.update_folder(&id, update).await?;
    Ok(Json(folder))
}

/// Delete a topology folder
pub async fn delete_topology_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_folder(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Move a topology folder (change parent and/or sort order)
pub async fn move_topology_folder(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<MoveFolderRequest>,
) -> Result<Json<Folder>, ApiError> {
    if let Some(ref parent_id) = req.parent_id {
        if parent_id == &id {
            return Err(ApiError {
                error: "Cannot move folder into itself".to_string(),
                code: "VALIDATION".to_string(),
            });
        }

        let all_folders = state.provider.list_folders(Some("topology")).await?;
        let mut descendants = std::collections::HashSet::new();
        fn collect_descendants(
            folder_id: &str,
            folders: &[Folder],
            descendants: &mut std::collections::HashSet<String>,
        ) {
            for folder in folders {
                if folder.parent_id.as_deref() == Some(folder_id) {
                    descendants.insert(folder.id.clone());
                    collect_descendants(&folder.id, folders, descendants);
                }
            }
        }
        collect_descendants(&id, &all_folders, &mut descendants);
        if descendants.contains(parent_id) {
            return Err(ApiError {
                error: "Cannot move folder into its own descendant".to_string(),
                code: "VALIDATION".to_string(),
            });
        }
    }

    let update = UpdateFolder {
        parent_id: Some(req.parent_id),
        sort_order: Some(req.sort_order as i32),
        ..Default::default()
    };
    let folder = state.provider.update_folder(&id, update).await?;
    Ok(Json(folder))
}

/// List all topologies
pub async fn list_topologies(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SavedTopology>>, ApiError> {
    let topologies = state.provider.list_topologies().await?;
    Ok(Json(topologies))
}

/// Create a new topology
pub async fn create_topology(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateTopologyRequest>,
) -> Result<(StatusCode, Json<SavedTopology>), ApiError> {
    // Create the topology
    let topology = state.provider.create_topology(&req.name).await?;

    // Add devices from session_ids if provided
    for session_id in &req.session_ids {
        if let Ok(session) = state.provider.get_session(session_id).await {
            // Ignore errors adding devices - they may have invalid session IDs
            state
                .provider
                .add_topology_device(&topology.id, &session)
                .await
                .ok();
        }
    }

    Ok((StatusCode::CREATED, Json(topology)))
}

/// Get a single topology with its devices and connections
pub async fn get_topology(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<TopologyWithDetails>, ApiError> {
    let topology = state
        .provider
        .get_topology(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Topology not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    let devices = state.provider.get_topology_devices(&id).await?;
    let connections = state.provider.get_topology_connections(&id).await?;

    Ok(Json(TopologyWithDetails {
        id: topology.id,
        name: topology.name,
        folder_id: topology.folder_id,
        sort_order: topology.sort_order,
        devices,
        connections,
        created_at: topology.created_at,
        updated_at: topology.updated_at,
    }))
}

/// Update a topology name
pub async fn update_topology(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTopologyRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_topology(&id, &req.name).await?;
    Ok(StatusCode::OK)
}

/// Set topology sharing state
pub async fn share_topology(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<ShareTopologyRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.share_topology(&id, req.shared).await?;
    Ok(StatusCode::OK)
}

/// Delete a topology
pub async fn delete_topology(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_topology(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Move a topology to a folder and/or reorder
pub async fn move_topology(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<MoveTopologyRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .move_topology(&id, req.folder_id, req.sort_order)
        .await?;
    Ok(StatusCode::OK)
}

/// Bulk delete multiple topologies
pub async fn bulk_delete_topologies(
    State(state): State<Arc<AppState>>,
    Json(req): Json<BulkDeleteTopologiesRequest>,
) -> Result<Json<BulkDeleteTopologiesResponse>, ApiError> {
    let (deleted, failed) = state.provider.bulk_delete_topologies(&req.ids).await?;
    Ok(Json(BulkDeleteTopologiesResponse { deleted, failed }))
}

/// Add a device to a topology
pub async fn add_topology_device(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
    Json(req): Json<AddDeviceRequest>,
) -> Result<(StatusCode, Json<TopologyDevice>), ApiError> {
    tracing::debug!(
        "add_topology_device called: topology_id={}, req={:?}",
        topology_id,
        req
    );

    // Validate topology exists
    state
        .provider
        .get_topology(&topology_id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Topology not found: {}", topology_id),
            code: "NOT_FOUND".to_string(),
        })?;

    // If session_id is provided, link device to session
    if let Some(session_id) = &req.session_id {
        let session = state.provider.get_session(session_id).await?;
        let device = state
            .provider
            .add_topology_device(&topology_id, &session)
            .await?;
        return Ok((StatusCode::CREATED, Json(device)));
    }

    // Otherwise, create a discovered device with provided fields
    let name = req.name.ok_or_else(|| ApiError {
        error: "name is required when session_id is not provided".to_string(),
        code: "VALIDATION_ERROR".to_string(),
    })?;

    let device = state
        .provider
        .add_discovered_device(
            &topology_id,
            crate::providers::NewDiscoveredDevice {
                name: &name,
                host: req.host.as_deref().unwrap_or(""),
                device_type: req.device_type.as_deref().unwrap_or("unknown"),
                x: req.x.unwrap_or(500.0),
                y: req.y.unwrap_or(300.0),
                profile_id: req.profile_id.as_deref(),
                snmp_profile_id: req.snmp_profile_id.as_deref(),
            },
        )
        .await?;

    Ok((StatusCode::CREATED, Json(device)))
}

/// Update device position within a topology
pub async fn update_topology_device_position(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
    Json(update): Json<UpdateTopologyPosition>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .update_topology_device_position(&device_id, update.x, update.y)
        .await?;
    Ok(StatusCode::OK)
}

/// Update device type within a topology
pub async fn update_topology_device_type(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
    Json(update): Json<UpdateTopologyDeviceType>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .update_topology_device_type(&device_id, &update.device_type)
        .await?;
    Ok(StatusCode::OK)
}

/// Update device details (AI enrichment)
pub async fn update_topology_device_details(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
    Json(update): Json<UpdateTopologyDeviceDetails>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .update_topology_device_details(&device_id, &update)
        .await?;
    Ok(StatusCode::OK)
}

/// Delete a device from a topology
pub async fn delete_topology_device(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_topology_device(&device_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Create a connection between devices
pub async fn create_topology_connection(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
    Json(req): Json<CreateConnectionRequest>,
) -> Result<(StatusCode, Json<TopologyConnection>), ApiError> {
    let connection = state
        .provider
        .create_topology_connection(&topology_id, &req)
        .await?;
    Ok((StatusCode::CREATED, Json(connection)))
}

/// Delete a connection
pub async fn delete_topology_connection(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, connection_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .delete_topology_connection(&connection_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Update a connection (waypoints, label, color, line_style, etc.)
pub async fn update_topology_connection(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, connection_id)): Path<(String, String)>,
    Json(req): Json<UpdateConnectionRequest>,
) -> Result<Json<TopologyConnection>, ApiError> {
    let conn = state
        .provider
        .update_topology_connection(&connection_id, &req)
        .await?;
    Ok(Json(conn))
}

// === Topology Annotations Endpoints (Phase 27-03) ===

/// List all annotations for a topology
pub async fn list_topology_annotations(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
) -> Result<Json<Vec<TopologyAnnotation>>, ApiError> {
    let annotations = state
        .provider
        .get_topology_annotations(&topology_id)
        .await?;
    Ok(Json(annotations))
}

/// Create a new annotation
pub async fn create_topology_annotation(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
    Json(req): Json<CreateAnnotationRequest>,
) -> Result<(StatusCode, Json<TopologyAnnotation>), ApiError> {
    let annotation = state
        .provider
        .create_topology_annotation(&topology_id, &req)
        .await?;
    Ok((StatusCode::CREATED, Json(annotation)))
}

/// Update an annotation
pub async fn update_topology_annotation(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, annotation_id)): Path<(String, String)>,
    Json(req): Json<UpdateAnnotationRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .update_topology_annotation(&annotation_id, &req)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete an annotation
pub async fn delete_topology_annotation(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, annotation_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .delete_topology_annotation(&annotation_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Reorder annotations by z-index
pub async fn reorder_topology_annotations(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
    Json(req): Json<ReorderAnnotationsRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .reorder_topology_annotations(&topology_id, &req.id_order)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Netdisco Sources Endpoints (Phase 22) ===

/// Response shape for Netdisco source — mirrors the source row 1:1; URL +
/// credentials now live on the linked api_resource.
#[derive(Debug, Serialize)]
pub struct NetStacksCrawlerSourceResponse {
    pub id: String,
    pub name: String,
    pub api_resource_id: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<NetStacksCrawlerSource> for NetStacksCrawlerSourceResponse {
    fn from(source: NetStacksCrawlerSource) -> Self {
        Self {
            id: source.id,
            name: source.name,
            api_resource_id: source.api_resource_id,
            created_at: source.created_at.to_rfc3339(),
            updated_at: source.updated_at.to_rfc3339(),
        }
    }
}

/// List all NetStacks-Crawler sources
pub async fn list_netstacks_crawler_sources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<NetStacksCrawlerSourceResponse>>, ApiError> {
    let sources = state.provider.list_netstacks_crawler_sources().await?;
    Ok(Json(sources.into_iter().map(Into::into).collect()))
}

/// Get a single NetStacks-Crawler source
pub async fn get_netstacks_crawler_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<NetStacksCrawlerSourceResponse>, ApiError> {
    let source = state.provider.get_netstacks_crawler_source(&id).await?;
    Ok(Json(source.into()))
}

/// Create a new NetStacks-Crawler source
pub async fn create_netstacks_crawler_source(
    State(state): State<Arc<AppState>>,
    Json(new_source): Json<NewNetStacksCrawlerSource>,
) -> Result<(StatusCode, Json<NetStacksCrawlerSourceResponse>), ApiError> {
    let source = state
        .provider
        .create_netstacks_crawler_source(new_source)
        .await?;
    Ok((StatusCode::CREATED, Json(source.into())))
}

/// Update an existing NetStacks-Crawler source
pub async fn update_netstacks_crawler_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateNetStacksCrawlerSource>,
) -> Result<Json<NetStacksCrawlerSourceResponse>, ApiError> {
    let source = state
        .provider
        .update_netstacks_crawler_source(&id, update)
        .await?;
    Ok(Json(source.into()))
}

/// Delete a NetStacks-Crawler source
pub async fn delete_netstacks_crawler_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_netstacks_crawler_source(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Response from testing NetStacks-Crawler connection
#[derive(Debug, Serialize)]
pub struct TestNetStacksCrawlerResponse {
    pub success: bool,
    pub message: String,
}

/// Helper: build a NetStacks-Crawler API client from a source id. Auth (basic vs
/// api-key) and credentials all live on the linked api_resource.
async fn netstacks_crawler_client_for_source(
    state: &AppState,
    source_id: &str,
) -> Result<crate::api_resource_client::ApiResourceClient, ApiError> {
    let source = state
        .provider
        .get_netstacks_crawler_source(source_id)
        .await?;
    crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &source.api_resource_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(api_resource_client_err)
}

/// Test NetStacks-Crawler connection for an existing source
pub async fn test_netstacks_crawler_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<TestNetStacksCrawlerResponse>, ApiError> {
    let source = state.provider.get_netstacks_crawler_source(&id).await?;
    let resource = state
        .provider
        .get_api_resource(&source.api_resource_id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("API resource {} not found", source.api_resource_id),
            code: "NOT_FOUND".to_string(),
        })?;
    let client = netstacks_crawler_client_for_source(&state, &id).await?;

    // Honor the resource's configured test_path (e.g. "/api/v1/queue/backends")
    // if set; otherwise try the conventional Netdisco device endpoint.
    let test_path = resource.test_path.as_deref().unwrap_or("/api/v1/device");
    match client.send_authed(reqwest::Method::GET, test_path).await {
        Ok(response) => {
            if response.status().is_success() {
                Ok(Json(TestNetStacksCrawlerResponse {
                    success: true,
                    message: "Connection successful".to_string(),
                }))
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(Json(TestNetStacksCrawlerResponse {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                }))
            }
        }
        Err(e) => Ok(Json(TestNetStacksCrawlerResponse {
            success: false,
            message: format!("Connection failed: {}", e),
        })),
    }
}

/// Request body for testing Netdisco connection directly
#[derive(Debug, Deserialize)]
pub struct TestNetdiscoDirectRequest {
    pub url: String,
    pub auth_type: String,
    pub username: Option<String>,
    pub credential: String,
    #[serde(default = "default_proxy_verify_ssl")]
    pub verify_ssl: bool,
}

/// Test Netdisco connection directly (no source required)
pub async fn test_netstacks_crawler_direct(
    Json(req): Json<TestNetdiscoDirectRequest>,
) -> Result<Json<TestNetStacksCrawlerResponse>, ApiError> {
    validate_proxy_url(&req.url)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!req.verify_ssl)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let api_url = format!("{}/api/v1/device", req.url.trim_end_matches('/'));

    let request = if req.auth_type == "api_key" {
        client
            .get(&api_url)
            .header("X-API-Key", &req.credential)
            .header("Accept", "application/json")
    } else {
        // Basic auth
        let username = req.username.clone().unwrap_or_default();
        client
            .get(&api_url)
            .basic_auth(&username, Some(&req.credential))
            .header("Accept", "application/json")
    };

    match request
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                Ok(Json(TestNetStacksCrawlerResponse {
                    success: true,
                    message: "Connection successful".to_string(),
                }))
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                Ok(Json(TestNetStacksCrawlerResponse {
                    success: false,
                    message: format!("HTTP {}: {}", status, body),
                }))
            }
        }
        Err(e) => Ok(Json(TestNetStacksCrawlerResponse {
            success: false,
            message: format!("Connection failed: {}", e),
        })),
    }
}

/// Proxy request to Netdisco API - devices list
pub async fn netstacks_crawler_proxy_devices(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<NetStacksCrawlerDevice>>, ApiError> {
    let client = netstacks_crawler_client_for_source(&state, &id).await?;
    let response = client
        .send_authed(reqwest::Method::GET, "/api/v1/device")
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("Netdisco API error: {}", response.status()),
            code: "PROXY_ERROR".to_string(),
        });
    }
    let devices: Vec<NetStacksCrawlerDevice> = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PROXY_ERROR".to_string(),
    })?;
    Ok(Json(devices))
}

/// Proxy request to Netdisco API - device neighbors
pub async fn netstacks_crawler_proxy_neighbors(
    State(state): State<Arc<AppState>>,
    Path((id, device_ip)): Path<(String, String)>,
) -> Result<Json<Vec<NetStacksCrawlerNeighbor>>, ApiError> {
    let client = netstacks_crawler_client_for_source(&state, &id).await?;
    let path = format!("/api/v1/device/{}/neighbors", device_ip);
    let response = client
        .send_authed(reqwest::Method::GET, &path)
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("Netdisco API error: {}", response.status()),
            code: "PROXY_ERROR".to_string(),
        });
    }
    let neighbors: Vec<NetStacksCrawlerNeighbor> = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PROXY_ERROR".to_string(),
    })?;
    Ok(Json(neighbors))
}

/// Proxy request to Netdisco API - device links report
pub async fn netstacks_crawler_proxy_devicelinks(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<NetStacksCrawlerDeviceLink>>, ApiError> {
    let client = netstacks_crawler_client_for_source(&state, &id).await?;
    let response = client
        .send_authed(reqwest::Method::GET, "/api/v1/report/devicelinks")
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("Netdisco API error: {}", response.status()),
            code: "PROXY_ERROR".to_string(),
        });
    }
    let links: Vec<NetStacksCrawlerDeviceLink> = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PROXY_ERROR".to_string(),
    })?;
    Ok(Json(links))
}

/// Search devices in Netdisco
#[derive(Debug, Deserialize)]
pub struct NetdiscoSearchQuery {
    pub q: String,
}

pub async fn netstacks_crawler_proxy_search(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<NetdiscoSearchQuery>,
) -> Result<Json<Vec<NetStacksCrawlerSearchResult>>, ApiError> {
    let client = netstacks_crawler_client_for_source(&state, &id).await?;
    let path = format!("/api/v1/search/device?q={}", urlencoding::encode(&query.q));
    let response = client
        .send_authed(reqwest::Method::GET, &path)
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("Netdisco API error: {}", response.status()),
            code: "PROXY_ERROR".to_string(),
        });
    }
    let results: Vec<NetStacksCrawlerSearchResult> =
        response.json().await.map_err(|e| ApiError {
            error: format!("Failed to parse response: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    Ok(Json(results))
}

// ============================================================================
// Bulk topology import (Phase 4 — mirrors NetBox import_topology)
// ============================================================================

/// Heuristic device-type classifier. Best-effort — returns "unknown" rather
/// than guessing wrong. Inputs are typically LibreNMS `hardware` / `os` or
/// NetStacks-Crawler `model` / `os`. All matching is case-insensitive.
pub fn classify_device_type(hardware: Option<&str>, os: Option<&str>) -> String {
    let blob = format!(
        "{} {}",
        hardware.unwrap_or("").to_lowercase(),
        os.unwrap_or("").to_lowercase()
    );

    if blob.contains("asa")
        || blob.contains("fortinet")
        || blob.contains("fortigate")
        || blob.contains("palo")
        || blob.contains("pan-os")
        || blob.contains("firewall")
        || blob.contains("checkpoint")
    {
        return "firewall".to_string();
    }
    if blob.contains("catalyst")
        || blob.contains("nexus")
        || blob.contains("switch")
        || blob.contains("arista")
        || blob.contains("eos")
        || blob.contains("c9300")
        || blob.contains("c9500")
        || blob.contains("c9200")
    {
        return "switch".to_string();
    }
    if blob.contains("isr")
        || blob.contains("asr")
        || blob.contains("router")
        || blob.contains("ios-xr")
        || blob.contains("junos")
        || blob.contains("mx")
        || blob.contains("vmx")
    {
        return "router".to_string();
    }
    if blob.contains("access point") || blob.contains("aironet") || blob.contains("wlc") {
        return "access-point".to_string();
    }
    "unknown".to_string()
}

/// Best-effort vendor extraction from LibreNMS `os` / `hardware` strings.
pub fn infer_vendor(hardware: Option<&str>, os: Option<&str>) -> Option<String> {
    let blob = format!(
        "{} {}",
        hardware.unwrap_or("").to_lowercase(),
        os.unwrap_or("").to_lowercase()
    );
    if blob.contains("cisco")
        || blob.contains("ios")
        || blob.contains("nx-os")
        || blob.contains("catalyst")
        || blob.contains("nexus")
        || blob.contains("asa")
    {
        return Some("Cisco".to_string());
    }
    if blob.contains("arista") || blob.contains("eos") {
        return Some("Arista".to_string());
    }
    if blob.contains("juniper") || blob.contains("junos") {
        return Some("Juniper".to_string());
    }
    if blob.contains("fortinet") || blob.contains("fortigate") {
        return Some("Fortinet".to_string());
    }
    if blob.contains("palo") || blob.contains("pan-os") {
        return Some("Palo Alto".to_string());
    }
    if blob.contains("hp ") || blob.contains("aruba") || blob.contains("procurve") {
        return Some("HPE/Aruba".to_string());
    }
    if blob.contains("mikrotik") || blob.contains("routeros") {
        return Some("MikroTik".to_string());
    }
    None
}

/// Normalize hostname for dedup / link matching. Lowercases and also tracks
/// the short form (everything before the first dot) so we can match LibreNMS
/// FQDN ↔ short name variants.
pub fn hostname_variants(raw: &str) -> Vec<String> {
    let lower = raw.trim().to_lowercase();
    let mut out = vec![lower.clone()];
    if let Some((short, _)) = lower.split_once('.') {
        if !short.is_empty() && short != lower {
            out.push(short.to_string());
        }
    }
    out
}

#[derive(Debug, serde::Deserialize)]
pub struct LibreNmsImportTopologyRequest {
    pub topology_id: String,
    #[serde(default = "default_import_true")]
    pub include_connections: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct NetStacksCrawlerImportTopologyRequest {
    pub topology_id: String,
    #[serde(default = "default_import_true")]
    pub include_connections: bool,
}

fn default_import_true() -> bool {
    true
}

#[derive(Debug, serde::Serialize)]
pub struct ImportTopologyResponse {
    pub devices_created: i64,
    pub connections_created: i64,
    pub devices_skipped: i64,
    pub connections_skipped: i64,
}

/// Fetch LibreNMS devices for the given source using the same logic as
/// `get_librenms_devices`. Returned as a plain Vec for internal use.
async fn fetch_librenms_devices_internal(
    state: &AppState,
    source_id: &str,
) -> Result<Vec<LibreNmsDevice>, ApiError> {
    let client = librenms_client_for_source(state, source_id).await?;
    let response = client
        .send_authed(reqwest::Method::GET, "/api/v0/devices")
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to connect to LibreNMS: {}", e),
            code: "CONNECTION".to_string(),
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ApiError {
            error: format!("LibreNMS API error ({}): {}", status, body),
            code: "API_ERROR".to_string(),
        });
    }
    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse LibreNMS response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;
    Ok(data
        .get("devices")
        .and_then(|d| serde_json::from_value(d.clone()).ok())
        .unwrap_or_default())
}

async fn fetch_librenms_all_links_internal(
    state: &AppState,
    source_id: &str,
) -> Result<Vec<LibreNmsLink>, ApiError> {
    let client = librenms_client_for_source(state, source_id).await?;
    let response = client
        .send_authed(reqwest::Method::GET, "/api/v0/links")
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to connect to LibreNMS: {}", e),
            code: "CONNECTION".to_string(),
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(ApiError {
            error: format!("LibreNMS API error ({}): {}", status, body),
            code: "API_ERROR".to_string(),
        });
    }
    let data: serde_json::Value = response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse LibreNMS response: {}", e),
        code: "PARSE_ERROR".to_string(),
    })?;
    Ok(data
        .get("links")
        .and_then(|l| serde_json::from_value(l.clone()).ok())
        .unwrap_or_default())
}

async fn fetch_crawler_devices_internal(
    state: &AppState,
    source_id: &str,
) -> Result<Vec<NetStacksCrawlerDevice>, ApiError> {
    let client = netstacks_crawler_client_for_source(state, source_id).await?;
    let response = client
        .send_authed(reqwest::Method::GET, "/api/v1/device")
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("NetStacks-Crawler API error: {}", response.status()),
            code: "PROXY_ERROR".to_string(),
        });
    }
    response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PROXY_ERROR".to_string(),
    })
}

async fn fetch_crawler_links_internal(
    state: &AppState,
    source_id: &str,
) -> Result<Vec<NetStacksCrawlerDeviceLink>, ApiError> {
    let client = netstacks_crawler_client_for_source(state, source_id).await?;
    let response = client
        .send_authed(reqwest::Method::GET, "/api/v1/report/devicelinks")
        .await
        .map_err(|e| ApiError {
            error: format!("Request failed: {}", e),
            code: "PROXY_ERROR".to_string(),
        })?;
    if !response.status().is_success() {
        return Err(ApiError {
            error: format!("NetStacks-Crawler API error: {}", response.status()),
            code: "PROXY_ERROR".to_string(),
        });
    }
    response.json().await.map_err(|e| ApiError {
        error: format!("Failed to parse response: {}", e),
        code: "PROXY_ERROR".to_string(),
    })
}

/// Pure-input form of librenms_import_topology — accepts already-fetched
/// devices/links and a provider. Used by both the live handler and unit tests.
pub async fn import_librenms_into_topology(
    provider: &dyn crate::providers::DataProvider,
    topology_id: &str,
    devices: Vec<LibreNmsDevice>,
    links: Vec<LibreNmsLink>,
    include_connections: bool,
) -> Result<ImportTopologyResponse, ApiError> {
    let existing = provider.get_topology_devices(topology_id).await?;
    let mut name_index: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut ip_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for d in &existing {
        for v in hostname_variants(&d.name) {
            name_index.entry(v).or_insert_with(|| d.id.clone());
        }
        // Index by both primary_ip (enriched) and host (raw connect target)
        // since older devices may only have host populated.
        if let Some(ip) = &d.primary_ip {
            ip_index
                .entry(ip.to_lowercase())
                .or_insert_with(|| d.id.clone());
        }
        if !d.host.is_empty() {
            ip_index
                .entry(d.host.to_lowercase())
                .or_insert_with(|| d.id.clone());
        }
    }

    let mut devices_created: i64 = 0;
    let mut devices_skipped: i64 = 0;
    let row_y_start = existing.iter().map(|d| d.y as i32).max().unwrap_or(200) as f64 + 100.0;
    let cols = 8usize;
    let dx = 110.0f64;
    let dy = 110.0f64;
    let mut placed = 0usize;
    let mut lib_id_to_topo_id: std::collections::HashMap<i64, String> =
        std::collections::HashMap::new();

    for dev in &devices {
        let display_name = dev.sys_name.clone().unwrap_or_else(|| dev.hostname.clone());
        let lname_variants = hostname_variants(&display_name);
        let alt_hostname_variants = hostname_variants(&dev.hostname);
        let ip_lower = dev.ip.to_lowercase();

        let existing_id = lname_variants
            .iter()
            .find_map(|n| name_index.get(n).cloned())
            .or_else(|| {
                alt_hostname_variants
                    .iter()
                    .find_map(|n| name_index.get(n).cloned())
            })
            .or_else(|| {
                if !ip_lower.is_empty() {
                    ip_index.get(&ip_lower).cloned()
                } else {
                    None
                }
            });

        if let Some(eid) = existing_id {
            lib_id_to_topo_id.insert(dev.device_id, eid);
            devices_skipped += 1;
            continue;
        }

        let device_type = classify_device_type(dev.hardware.as_deref(), dev.os.as_deref());
        let vendor = infer_vendor(dev.hardware.as_deref(), dev.os.as_deref());

        let col = placed % cols;
        let row = placed / cols;
        let x = 100.0 + (col as f64) * dx;
        let y = row_y_start + (row as f64) * dy;
        placed += 1;

        let created = provider
            .add_discovered_device(
                topology_id,
                crate::providers::NewDiscoveredDevice {
                    name: &display_name,
                    host: &dev.ip,
                    device_type: &device_type,
                    x,
                    y,
                    profile_id: None,
                    snmp_profile_id: None,
                },
            )
            .await?;

        let details = UpdateTopologyDeviceDetails {
            device_type: Some(device_type),
            platform: dev.os.clone(),
            version: None,
            model: dev.hardware.clone(),
            serial: None,
            vendor,
            primary_ip: Some(dev.ip.clone()),
            uptime: None,
            status: None,
            site: None,
            role: None,
            notes: Some("Imported from LibreNMS".to_string()),
            profile_id: None,
            snmp_profile_id: None,
        };
        let _ = provider
            .update_topology_device_details(&created.id, &details)
            .await;

        for v in &lname_variants {
            name_index
                .entry(v.clone())
                .or_insert_with(|| created.id.clone());
        }
        for v in &alt_hostname_variants {
            name_index
                .entry(v.clone())
                .or_insert_with(|| created.id.clone());
        }
        if !ip_lower.is_empty() {
            ip_index
                .entry(ip_lower)
                .or_insert_with(|| created.id.clone());
        }
        lib_id_to_topo_id.insert(dev.device_id, created.id.clone());
        devices_created += 1;
    }

    let mut connections_created: i64 = 0;
    let mut connections_skipped: i64 = 0;
    if include_connections {
        let all_devices = provider.get_topology_devices(topology_id).await?;
        let mut tdev_by_name: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for d in &all_devices {
            for v in hostname_variants(&d.name) {
                tdev_by_name.entry(v).or_insert_with(|| d.id.clone());
            }
        }

        let mut seen_edges: std::collections::HashSet<(String, String, String, String)> =
            std::collections::HashSet::new();
        for link in links {
            let local_id = lib_id_to_topo_id.get(&link.local_device_id).cloned();
            let remote_id = hostname_variants(&link.remote_hostname)
                .into_iter()
                .find_map(|v| tdev_by_name.get(&v).cloned());
            let (src, dst) = match (local_id, remote_id) {
                (Some(s), Some(d)) if s != d => (s, d),
                _ => {
                    connections_skipped += 1;
                    continue;
                }
            };
            let key = if src < dst {
                (
                    src.clone(),
                    link.local_port.clone(),
                    dst.clone(),
                    link.remote_port.clone(),
                )
            } else {
                (
                    dst.clone(),
                    link.remote_port.clone(),
                    src.clone(),
                    link.local_port.clone(),
                )
            };
            if !seen_edges.insert(key) {
                connections_skipped += 1;
                continue;
            }
            let req_conn = CreateConnectionRequest {
                source_device_id: src,
                target_device_id: dst,
                source_interface: Some(link.local_port.clone()),
                target_interface: Some(link.remote_port.clone()),
                label: Some(link.protocol.clone()),
                waypoints: None,
                curve_style: None,
                bundle_id: None,
                bundle_index: None,
                color: None,
                line_style: None,
                line_width: None,
                notes: None,
            };
            match provider
                .create_topology_connection(topology_id, &req_conn)
                .await
            {
                Ok(_) => connections_created += 1,
                Err(_) => connections_skipped += 1,
            }
        }
    }

    Ok(ImportTopologyResponse {
        devices_created,
        connections_created,
        devices_skipped,
        connections_skipped,
    })
}

/// Pure-input form of netstacks_crawler_import_topology.
pub async fn import_crawler_into_topology(
    provider: &dyn crate::providers::DataProvider,
    topology_id: &str,
    devices: Vec<NetStacksCrawlerDevice>,
    links: Vec<NetStacksCrawlerDeviceLink>,
    include_connections: bool,
) -> Result<ImportTopologyResponse, ApiError> {
    let existing = provider.get_topology_devices(topology_id).await?;
    let mut name_index: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut ip_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for d in &existing {
        for v in hostname_variants(&d.name) {
            name_index.entry(v).or_insert_with(|| d.id.clone());
        }
        // Index by both primary_ip (enriched) and host (raw connect target)
        // since older devices may only have host populated.
        if let Some(ip) = &d.primary_ip {
            ip_index
                .entry(ip.to_lowercase())
                .or_insert_with(|| d.id.clone());
        }
        if !d.host.is_empty() {
            ip_index
                .entry(d.host.to_lowercase())
                .or_insert_with(|| d.id.clone());
        }
    }

    let mut devices_created: i64 = 0;
    let mut devices_skipped: i64 = 0;
    let row_y_start = existing.iter().map(|d| d.y as i32).max().unwrap_or(200) as f64 + 100.0;
    let cols = 8usize;
    let dx = 110.0f64;
    let dy = 110.0f64;
    let mut placed = 0usize;

    for dev in devices {
        let display_name = dev
            .name
            .clone()
            .or_else(|| dev.dns.clone())
            .unwrap_or_else(|| dev.ip.clone());
        let lname_variants = hostname_variants(&display_name);
        let dns_variants = dev
            .dns
            .as_deref()
            .map(hostname_variants)
            .unwrap_or_default();
        let ip_lower = dev.ip.to_lowercase();

        let dup_by_name = lname_variants.iter().any(|n| name_index.contains_key(n))
            || dns_variants.iter().any(|n| name_index.contains_key(n));
        let dup_by_ip = !ip_lower.is_empty() && ip_index.contains_key(&ip_lower);

        if dup_by_name || dup_by_ip {
            devices_skipped += 1;
            continue;
        }

        let device_type = classify_device_type(dev.model.as_deref(), dev.os.as_deref());
        let vendor = dev
            .vendor
            .clone()
            .or_else(|| infer_vendor(dev.model.as_deref(), dev.os.as_deref()));

        let col = placed % cols;
        let row = placed / cols;
        let x = 100.0 + (col as f64) * dx;
        let y = row_y_start + (row as f64) * dy;
        placed += 1;

        let created = provider
            .add_discovered_device(
                topology_id,
                crate::providers::NewDiscoveredDevice {
                    name: &display_name,
                    host: &dev.ip,
                    device_type: &device_type,
                    x,
                    y,
                    profile_id: None,
                    snmp_profile_id: None,
                },
            )
            .await?;

        let details = UpdateTopologyDeviceDetails {
            device_type: Some(device_type),
            platform: dev.os.clone(),
            version: dev.os_ver.clone(),
            model: dev.model.clone(),
            serial: dev.serial.clone(),
            vendor,
            primary_ip: Some(dev.ip.clone()),
            uptime: dev.uptime.map(|u| u.to_string()),
            status: None,
            site: None,
            role: None,
            notes: Some("Imported from NetStacks-Crawler".to_string()),
            profile_id: None,
            snmp_profile_id: None,
        };
        let _ = provider
            .update_topology_device_details(&created.id, &details)
            .await;

        for v in &lname_variants {
            name_index
                .entry(v.clone())
                .or_insert_with(|| created.id.clone());
        }
        for v in &dns_variants {
            name_index
                .entry(v.clone())
                .or_insert_with(|| created.id.clone());
        }
        if !ip_lower.is_empty() {
            ip_index
                .entry(ip_lower)
                .or_insert_with(|| created.id.clone());
        }
        devices_created += 1;
    }

    let mut connections_created: i64 = 0;
    let mut connections_skipped: i64 = 0;
    if include_connections {
        let all_devices = provider.get_topology_devices(topology_id).await?;
        let mut tdev_by_ip: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut tdev_by_name: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for d in &all_devices {
            if let Some(ip) = &d.primary_ip {
                tdev_by_ip
                    .entry(ip.to_lowercase())
                    .or_insert_with(|| d.id.clone());
            }
            for v in hostname_variants(&d.name) {
                tdev_by_name.entry(v).or_insert_with(|| d.id.clone());
            }
        }
        let mut seen_edges: std::collections::HashSet<(String, String, String, String)> =
            std::collections::HashSet::new();
        for link in links {
            let left = tdev_by_ip
                .get(&link.left_ip.to_lowercase())
                .cloned()
                .or_else(|| {
                    link.left_dns.as_deref().and_then(|d| {
                        hostname_variants(d)
                            .into_iter()
                            .find_map(|v| tdev_by_name.get(&v).cloned())
                    })
                });
            let right = tdev_by_ip
                .get(&link.right_ip.to_lowercase())
                .cloned()
                .or_else(|| {
                    link.right_dns.as_deref().and_then(|d| {
                        hostname_variants(d)
                            .into_iter()
                            .find_map(|v| tdev_by_name.get(&v).cloned())
                    })
                });
            let (src, dst) = match (left, right) {
                (Some(s), Some(d)) if s != d => (s, d),
                _ => {
                    connections_skipped += 1;
                    continue;
                }
            };
            let lport = link.left_port.clone().unwrap_or_default();
            let rport = link.right_port.clone().unwrap_or_default();
            let key = if src < dst {
                (src.clone(), lport.clone(), dst.clone(), rport.clone())
            } else {
                (dst.clone(), rport.clone(), src.clone(), lport.clone())
            };
            if !seen_edges.insert(key) {
                connections_skipped += 1;
                continue;
            }
            let req_conn = CreateConnectionRequest {
                source_device_id: src,
                target_device_id: dst,
                source_interface: link.left_port.clone(),
                target_interface: link.right_port.clone(),
                label: link.protocol.clone(),
                waypoints: None,
                curve_style: None,
                bundle_id: None,
                bundle_index: None,
                color: None,
                line_style: None,
                line_width: None,
                notes: link.speed.clone().map(|s| format!("speed: {}", s)),
            };
            match provider
                .create_topology_connection(topology_id, &req_conn)
                .await
            {
                Ok(_) => connections_created += 1,
                Err(_) => connections_skipped += 1,
            }
        }
    }

    Ok(ImportTopologyResponse {
        devices_created,
        connections_created,
        devices_skipped,
        connections_skipped,
    })
}

/// Import all devices + L2 links from a LibreNMS source into a topology.
/// Dedupes by lowercase name OR primary_ip. Connections are skipped when
/// either endpoint can't be resolved to an existing topology device.
pub async fn librenms_import_topology(
    State(state): State<Arc<AppState>>,
    Path(source_id): Path<String>,
    Json(req): Json<LibreNmsImportTopologyRequest>,
) -> Result<Json<ImportTopologyResponse>, ApiError> {
    // 1. Verify topology exists.
    state
        .provider
        .get_topology(&req.topology_id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Topology not found: {}", req.topology_id),
            code: "NOT_FOUND".to_string(),
        })?;

    let devices = fetch_librenms_devices_internal(&state, &source_id).await?;
    let links = if req.include_connections {
        fetch_librenms_all_links_internal(&state, &source_id).await?
    } else {
        Vec::new()
    };
    let resp = import_librenms_into_topology(
        &*state.provider,
        &req.topology_id,
        devices,
        links,
        req.include_connections,
    )
    .await?;
    Ok(Json(resp))
}

/// Import all devices + L2 links from a NetStacks-Crawler source into a topology.
pub async fn netstacks_crawler_import_topology(
    State(state): State<Arc<AppState>>,
    Path(source_id): Path<String>,
    Json(req): Json<NetStacksCrawlerImportTopologyRequest>,
) -> Result<Json<ImportTopologyResponse>, ApiError> {
    state
        .provider
        .get_topology(&req.topology_id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Topology not found: {}", req.topology_id),
            code: "NOT_FOUND".to_string(),
        })?;
    let devices = fetch_crawler_devices_internal(&state, &source_id).await?;
    let links = if req.include_connections {
        fetch_crawler_links_internal(&state, &source_id).await?
    } else {
        Vec::new()
    };
    let resp = import_crawler_into_topology(
        &*state.provider,
        &req.topology_id,
        devices,
        links,
        req.include_connections,
    )
    .await?;
    Ok(Json(resp))
}

// ============================================================================
// Layout handlers (Phase 25)
// ============================================================================

/// List all saved layouts
pub async fn list_layouts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<Layout>>, ApiError> {
    let layouts = state.provider.list_layouts().await?;
    Ok(Json(layouts))
}

/// Get a single layout by ID
pub async fn get_layout(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Layout>, ApiError> {
    let layout = state
        .provider
        .get_layout(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Layout not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;
    Ok(Json(layout))
}

/// Request to create or update a layout
#[derive(Debug, Deserialize)]
pub struct CreateLayoutRequest {
    pub name: String,
    pub session_ids: Vec<String>,
    pub tabs: Option<Vec<LayoutTab>>,
    pub orientation: String,
    pub sizes: Option<Vec<f64>>,
}

/// Create a new layout
pub async fn create_layout(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateLayoutRequest>,
) -> Result<(StatusCode, Json<Layout>), ApiError> {
    let layout = Layout {
        id: uuid::Uuid::new_v4().to_string(),
        name: req.name,
        session_ids: req.session_ids,
        tabs: req.tabs,
        orientation: req.orientation,
        sizes: req.sizes,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };

    let created = state.provider.create_layout(layout).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Request to update a layout
#[derive(Debug, Deserialize)]
pub struct UpdateLayoutRequest {
    pub name: Option<String>,
    pub session_ids: Option<Vec<String>>,
    pub tabs: Option<Vec<LayoutTab>>,
    pub orientation: Option<String>,
    pub sizes: Option<Vec<f64>>,
}

/// Update an existing layout
pub async fn update_layout(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateLayoutRequest>,
) -> Result<Json<Layout>, ApiError> {
    // Get existing layout
    let existing = state
        .provider
        .get_layout(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Layout not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    // Merge updates
    let updated = Layout {
        id: existing.id,
        name: req.name.unwrap_or(existing.name),
        session_ids: req.session_ids.unwrap_or(existing.session_ids),
        tabs: req.tabs.or(existing.tabs),
        orientation: req.orientation.unwrap_or(existing.orientation),
        sizes: req.sizes.or(existing.sizes),
        created_at: existing.created_at,
        updated_at: chrono::Utc::now(),
    };

    let result = state.provider.update_layout(updated).await?;
    Ok(Json(result))
}

/// Delete a layout
pub async fn delete_layout(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_layout(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Groups (Plan 1: Tab Groups Redesign) ===

/// List all saved groups
pub async fn list_groups(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::models::Group>>, ApiError> {
    let groups = state.provider.list_groups().await?;
    Ok(Json(groups))
}

/// Get a single group by ID
pub async fn get_group(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<crate::models::Group>, ApiError> {
    let group = state
        .provider
        .get_group(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Group not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;
    Ok(Json(group))
}

/// Create a new group
pub async fn create_group(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::models::CreateGroupRequest>,
) -> Result<(StatusCode, Json<crate::models::Group>), ApiError> {
    let now = chrono::Utc::now().to_rfc3339();
    let group = crate::models::Group {
        id: uuid::Uuid::new_v4().to_string(),
        name: req.name,
        tabs: req.tabs,
        topology_id: req.topology_id,
        default_launch_action: req.default_launch_action,
        created_at: now.clone(),
        updated_at: now,
        last_used_at: None,
    };
    let created = state.provider.create_group(group).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Update an existing group
pub async fn update_group(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<crate::models::UpdateGroupRequest>,
) -> Result<Json<crate::models::Group>, ApiError> {
    let mut existing = state
        .provider
        .get_group(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Group not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    if let Some(name) = req.name {
        existing.name = name;
    }
    if let Some(tabs) = req.tabs {
        existing.tabs = tabs;
    }
    if let Some(topology_id) = req.topology_id {
        existing.topology_id = topology_id;
    }
    if let Some(default_action) = req.default_launch_action {
        existing.default_launch_action = default_action;
    }
    if let Some(last_used) = req.last_used_at {
        existing.last_used_at = Some(last_used);
    }
    existing.updated_at = chrono::Utc::now().to_rfc3339();

    let updated = state.provider.update_group(existing).await?;
    Ok(Json(updated))
}

/// Delete a group
pub async fn delete_group(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_group(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === API Resources API ===

/// List all API resources
pub async fn list_api_resources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ApiResource>>, ApiError> {
    let resources = state.provider.list_api_resources().await?;
    Ok(Json(resources))
}

/// Get a single API resource
pub async fn get_api_resource(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ApiResource>, ApiError> {
    let resource = state
        .provider
        .get_api_resource(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("API resource not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;
    Ok(Json(resource))
}

/// Create a new API resource
pub async fn create_api_resource(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateApiResourceRequest>,
) -> Result<(StatusCode, Json<ApiResource>), ApiError> {
    let resource = state.provider.create_api_resource(&req).await?;
    Ok((StatusCode::CREATED, Json(resource)))
}

/// Update an API resource
pub async fn update_api_resource(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateApiResourceRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_api_resource(&id, &req).await?;
    Ok(StatusCode::OK)
}

/// Delete an API resource
pub async fn delete_api_resource(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_api_resource(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Test an API resource connection
/// Advisory shown when a connection test "succeeds" but only because it reached
/// the base URL — no Test Path was configured, so no real/authenticated endpoint
/// was validated. Prevents a misleading green result (e.g. Netdisco's open `/`
/// landing page returning 200 while the API itself requires auth).
const NO_TEST_PATH_WARNING: &str = "Reached the base URL, but no API endpoint or authentication was verified. Set a Test Path (e.g. api/v1/device) to validate a real endpoint.";

pub async fn test_api_resource(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<QuickActionResult>, ApiError> {
    let resource = state
        .provider
        .get_api_resource(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("API resource not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;
    let credentials = state
        .provider
        .get_api_resource_credentials(&id)
        .await
        .ok()
        .flatten();

    let has_test_path = resource
        .test_path
        .as_deref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    let test_path = resource.test_path.as_deref().unwrap_or("/");
    let empty_vars = std::collections::HashMap::new();
    let mut result = crate::quick_actions::execute_action(
        &resource,
        credentials.as_ref(),
        crate::api_resource_client::RequestSpec {
            method: "GET",
            path: test_path,
            headers: &serde_json::json!({}),
            body: None,
            json_extract_path: None,
            user_variables: &empty_vars,
        },
        Some(&state.auth_cache),
    )
    .await;

    if result.success && !has_test_path {
        result.warning = Some(NO_TEST_PATH_WARNING.to_string());
    }

    Ok(Json(result))
}

/// Test an API resource connection using an inline (unsaved) configuration.
/// Lets the UI run Test Connection against the in-progress form state
/// without forcing a save-close-reopen cycle. No cache attached — inline
/// tests always re-run the auth flow.
#[derive(Debug, serde::Deserialize)]
pub struct TestApiResourceInlineRequest {
    pub resource: crate::models::ApiResource,
    #[serde(default)]
    pub credentials: Option<crate::models::StoredApiResourceCredential>,
}

pub async fn test_api_resource_inline(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TestApiResourceInlineRequest>,
) -> Result<Json<QuickActionResult>, ApiError> {
    // Re-test of an already-saved resource: the form's credential fields are
    // intentionally left blank ("unchanged"), so `req.credentials` is None.
    // Reload the stored vault credentials by id so the test runs with the
    // existing token/creds instead of failing a resource that already worked.
    // The user only typed new creds when they actually want to change them.
    let is_saved = !req.resource.id.is_empty() && req.resource.id != "inline-test";
    let credentials = match req.credentials {
        Some(c) => Some(c),
        None if is_saved => state
            .provider
            .get_api_resource_credentials(&req.resource.id)
            .await
            .ok()
            .flatten(),
        None => None,
    };

    let has_test_path = req
        .resource
        .test_path
        .as_deref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    let test_path = req.resource.test_path.as_deref().unwrap_or("/").to_string();
    let empty_vars = std::collections::HashMap::new();
    let mut result = crate::quick_actions::execute_action(
        &req.resource,
        credentials.as_ref(),
        crate::api_resource_client::RequestSpec {
            method: "GET",
            path: &test_path,
            headers: &serde_json::json!({}),
            body: None,
            json_extract_path: None,
            user_variables: &empty_vars,
        },
        None, // no cache for inline tests
    )
    .await;

    if result.success && !has_test_path {
        result.warning = Some(NO_TEST_PATH_WARNING.to_string());
    }

    Ok(Json(result))
}

/// Body for the per-step auth-flow test endpoint. Carries any extra
/// `{{var}}` substitutions the user wants to feed in (typically empty —
/// step 1 uses creds; later steps inherit from earlier-step extractions).
#[derive(Debug, serde::Deserialize)]
pub struct TestAuthStepRequest {
    #[serde(default)]
    pub variables: std::collections::HashMap<String, String>,
}

/// Run a single step of an API resource's multi-step auth flow and return a
/// detailed result so the user can debug the step in isolation.
pub async fn test_auth_flow_step(
    State(state): State<Arc<AppState>>,
    Path((id, step_index)): Path<(String, usize)>,
    body: Option<Json<TestAuthStepRequest>>,
) -> Result<Json<crate::quick_actions::AuthStepTestResult>, ApiError> {
    let resource = state
        .provider
        .get_api_resource(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("API resource not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    let steps = resource.auth_flow.as_deref().unwrap_or(&[]);
    let step = steps.get(step_index).ok_or_else(|| ApiError {
        error: format!(
            "Step index {} is out of range (resource has {} step(s))",
            step_index,
            steps.len()
        ),
        code: "VALIDATION".to_string(),
    })?;

    let credentials = state
        .provider
        .get_api_resource_credentials(&id)
        .await
        .ok()
        .flatten();
    let extra = body.map(|b| b.0.variables).unwrap_or_default();

    let result =
        crate::quick_actions::test_auth_step(&resource, credentials.as_ref(), step, &extra).await;
    Ok(Json(result))
}

/// Body for the inline per-step auth-flow test endpoint. Used by the
/// frontend when the user clicks "Test" on an unsaved (or edited) API
/// resource — we don't have an id yet, so the entire resource shape +
/// credentials come over the wire instead of being looked up.
#[derive(Debug, serde::Deserialize)]
pub struct TestAuthStepInlineRequest {
    pub resource: crate::models::ApiResource,
    pub credentials: Option<crate::models::StoredApiResourceCredential>,
    pub step_index: usize,
    #[serde(default)]
    pub variables: std::collections::HashMap<String, String>,
}

/// Run a single auth-flow step against an in-flight (unsaved) resource
/// configuration. Lets users debug auth flow steps without first saving
/// the resource, closing the round-trip between "edit a step" and "see
/// what it does on the wire".
pub async fn test_auth_flow_step_inline(
    Json(req): Json<TestAuthStepInlineRequest>,
) -> Result<Json<crate::quick_actions::AuthStepTestResult>, ApiError> {
    let steps = req.resource.auth_flow.as_deref().unwrap_or(&[]);
    let step = steps.get(req.step_index).ok_or_else(|| ApiError {
        error: format!(
            "Step index {} is out of range ({} step(s) provided)",
            req.step_index,
            steps.len()
        ),
        code: "VALIDATION".to_string(),
    })?;
    let result = crate::quick_actions::test_auth_step(
        &req.resource,
        req.credentials.as_ref(),
        step,
        &req.variables,
    )
    .await;
    Ok(Json(result))
}

// === Quick Actions API ===

/// List all quick actions
pub async fn list_quick_actions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<QuickAction>>, ApiError> {
    let actions = state.provider.list_quick_actions().await?;
    Ok(Json(actions))
}

/// Get a single quick action
pub async fn get_quick_action(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<QuickAction>, ApiError> {
    let action = state
        .provider
        .get_quick_action(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Quick action not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;
    Ok(Json(action))
}

/// Create a new quick action
pub async fn create_quick_action(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateQuickActionRequest>,
) -> Result<(StatusCode, Json<QuickAction>), ApiError> {
    match state.provider.create_quick_action(&req).await {
        Ok(action) => Ok((StatusCode::CREATED, Json(action))),
        Err(e) => {
            tracing::warn!(
                "create_quick_action FAILED: name={} api_resource_id={} method={} path={} error={:?}",
                req.name, req.api_resource_id, req.method, req.path, e
            );
            Err(e.into())
        }
    }
}

/// Update a quick action
pub async fn update_quick_action(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateQuickActionRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_quick_action(&id, &req).await?;
    Ok(StatusCode::OK)
}

/// Delete a quick action
pub async fn delete_quick_action(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_quick_action(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Execute a saved quick action
pub async fn execute_quick_action(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: Option<Json<ExecuteQuickActionRequest>>,
) -> Result<Json<QuickActionResult>, ApiError> {
    let user_variables = body.map(|b| b.0.variables).unwrap_or_default();
    let action = state
        .provider
        .get_quick_action(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Quick action not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;
    let resource = state
        .provider
        .get_api_resource(&action.api_resource_id)
        .await?
        .ok_or_else(|| ApiError {
            error: "Referenced API resource not found".to_string(),
            code: "NOT_FOUND".to_string(),
        })?;
    let credentials = state
        .provider
        .get_api_resource_credentials(&action.api_resource_id)
        .await
        .ok()
        .flatten();

    let result = crate::quick_actions::execute_action(
        &resource,
        credentials.as_ref(),
        crate::api_resource_client::RequestSpec {
            method: &action.method,
            path: &action.path,
            headers: &action.headers,
            body: action.body.as_deref(),
            json_extract_path: action.json_extract_path.as_deref(),
            user_variables: &user_variables,
        },
        Some(&state.auth_cache),
    )
    .await;

    Ok(Json(result))
}

/// Execute a quick action inline (without saving)
pub async fn execute_inline_quick_action(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExecuteInlineQuickActionRequest>,
) -> Result<Json<QuickActionResult>, ApiError> {
    tracing::debug!(
        "execute_inline_quick_action: api_resource_id={} method={} path={} variables={:?}",
        req.api_resource_id,
        req.method,
        req.path,
        req.variables.keys().collect::<Vec<_>>()
    );
    let resource = state
        .provider
        .get_api_resource(&req.api_resource_id)
        .await?
        .ok_or_else(|| {
            tracing::warn!(
                "execute_inline_quick_action: api_resource_id '{}' not found in DB",
                req.api_resource_id
            );
            ApiError {
                error: format!("API resource '{}' not found", req.api_resource_id),
                code: "NOT_FOUND".to_string(),
            }
        })?;
    let credentials = state
        .provider
        .get_api_resource_credentials(&req.api_resource_id)
        .await
        .ok()
        .flatten();

    let result = crate::quick_actions::execute_action(
        &resource,
        credentials.as_ref(),
        crate::api_resource_client::RequestSpec {
            method: &req.method,
            path: &req.path,
            headers: &req.headers,
            body: req.body.as_deref(),
            json_extract_path: req.json_extract_path.as_deref(),
            user_variables: &req.variables,
        },
        Some(&state.auth_cache),
    )
    .await;

    Ok(Json(result))
}

// === Quick Prompts API ===

/// List all quick prompts
pub async fn list_quick_prompts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<QuickPrompt>>, ApiError> {
    let prompts = state.provider.list_quick_prompts().await?;
    Ok(Json(prompts))
}

/// Create a new quick prompt
pub async fn create_quick_prompt(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateQuickPromptRequest>,
) -> Result<(StatusCode, Json<QuickPrompt>), ApiError> {
    let prompt = state.provider.create_quick_prompt(&req).await?;
    Ok((StatusCode::CREATED, Json(prompt)))
}

/// Update a quick prompt
pub async fn update_quick_prompt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateQuickPromptRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_quick_prompt(&id, &req).await?;
    Ok(StatusCode::OK)
}

/// Delete a quick prompt
pub async fn delete_quick_prompt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_quick_prompt(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === Agent Definitions API ===

/// List all agent definitions
pub async fn list_agent_definitions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AgentDefinition>>, ApiError> {
    let definitions = state.provider.list_agent_definitions().await?;
    Ok(Json(definitions))
}

/// Get a single agent definition
pub async fn get_agent_definition(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<AgentDefinition>, ApiError> {
    let definition = state
        .provider
        .get_agent_definition(&id)
        .await?
        .ok_or_else(|| {
            ApiError::from(ProviderError::NotFound(format!(
                "Agent definition not found: {}",
                id
            )))
        })?;
    Ok(Json(definition))
}

/// Create a new agent definition
pub async fn create_agent_definition(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAgentDefinitionRequest>,
) -> Result<(StatusCode, Json<AgentDefinition>), ApiError> {
    let definition = state.provider.create_agent_definition(&req).await?;
    Ok((StatusCode::CREATED, Json(definition)))
}

/// Update an agent definition
pub async fn update_agent_definition(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAgentDefinitionRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_agent_definition(&id, &req).await?;
    Ok(StatusCode::OK)
}

/// Delete an agent definition
pub async fn delete_agent_definition(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_agent_definition(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Run an agent definition (creates and executes a task using the agent's config)
#[derive(Debug, Deserialize)]
pub struct RunAgentRequest {
    pub prompt: String,
}

pub async fn run_agent_definition(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<RunAgentRequest>,
) -> Result<Response, (StatusCode, String)> {
    // Verify agent definition exists and is enabled (Feature A safety fix:
    // a disabled definition must not run via the API).
    let definition = state
        .provider
        .get_agent_definition(&id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Agent definition not found: {}", id),
            )
        })?;
    if !definition.enabled {
        return Err((
            StatusCode::CONFLICT,
            format!("Agent definition '{}' is disabled", id),
        ));
    }

    // Create task with agent_definition_id
    let task = state
        .task_store
        .create_task_with_agent(
            crate::tasks::CreateTaskRequest {
                prompt: req.prompt,
                _failure_policy: None,
            },
            Some(id),
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Spawn for background execution (returns immediately; a full pool
    // queues the task inside the executor — NS-API-8).
    let queued = state.task_registry.semaphore().available_permits() == 0;
    if let Err(e) = state.task_executor.spawn_task(task.id.clone()).await {
        tracing::warn!("Failed to spawn agent task {}: {}", task.id, e);
    }

    Ok(spawned_task_response(task, queued))
}

// === MOP Templates API (Phase 30) ===

/// Step types a plan-level `MopStep.step_type` may carry.
const MOP_STEP_TYPES: [&str; 5] = [
    "pre_check",
    "change",
    "post_check",
    "rollback",
    "api_action",
];
/// Statuses a plan-level `MopStep.status` may carry.
const MOP_STEP_STATUSES: [&str; 5] = ["pending", "running", "passed", "failed", "skipped"];

fn validation_error(msg: impl Into<String>) -> ApiError {
    ApiError {
        error: msg.into(),
        code: "VALIDATION".to_string(),
    }
}

fn not_found_error(msg: impl Into<String>) -> ApiError {
    ApiError {
        error: msg.into(),
        code: "NOT_FOUND".to_string(),
    }
}

/// 409 for an execution/device that is not in a state where the request makes sense.
fn invalid_state_error(msg: impl Into<String>) -> ApiError {
    ApiError {
        error: msg.into(),
        code: "INVALID_STATE".to_string(),
    }
}

fn require_name(name: &str, what: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(validation_error(format!("{} name must be non-empty", what)));
    }
    Ok(())
}

/// Validate plan-level steps on write (templates, changes, import): known
/// step_type / status, non-blank command. `label` names the array in the
/// error ("mop_steps", "device_overrides[<key>]").
fn validate_mop_steps(label: &str, steps: &[MopStep]) -> Result<(), ApiError> {
    for (i, step) in steps.iter().enumerate() {
        if !MOP_STEP_TYPES.contains(&step.step_type.as_str()) {
            return Err(validation_error(format!(
                "{}[{}].step_type '{}' is not one of {}",
                label,
                i,
                step.step_type,
                MOP_STEP_TYPES.join(", ")
            )));
        }
        if !MOP_STEP_STATUSES.contains(&step.status.as_str()) {
            return Err(validation_error(format!(
                "{}[{}].status '{}' is not one of {}",
                label,
                i,
                step.status,
                MOP_STEP_STATUSES.join(", ")
            )));
        }
        if step.command.trim().is_empty() {
            return Err(validation_error(format!(
                "{}[{}].command must be non-empty",
                label, i
            )));
        }
    }
    Ok(())
}

/// `POST /changes` / `PUT /changes/:id`: the plan steps and every device
/// override list obey the same rules as template steps. Override keys are
/// checked in sorted order so the reported index is deterministic.
fn validate_change_steps(
    mop_steps: Option<&[MopStep]>,
    device_overrides: Option<&std::collections::HashMap<String, Vec<MopStep>>>,
) -> Result<(), ApiError> {
    if let Some(steps) = mop_steps {
        validate_mop_steps("mop_steps", steps)?;
    }
    if let Some(overrides) = device_overrides {
        let mut keys: Vec<&String> = overrides.keys().collect();
        keys.sort();
        for key in keys {
            validate_mop_steps(&format!("device_overrides[{}]", key), &overrides[key])?;
        }
    }
    Ok(())
}

/// Plan variables on write (create / update change, import): valid, unique
/// names that cannot shadow the `device.*` built-ins, and every per-device
/// override refers to a declared variable. Override keys are checked in
/// sorted order so the reported entry is deterministic.
fn validate_change_variables(
    variables: &[MopVariable],
    device_variables: &DeviceVariableMap,
) -> Result<(), ApiError> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (i, var) in variables.iter().enumerate() {
        if !MopVariable::is_valid_name(&var.name) {
            return Err(validation_error(format!(
                "variables[{}].name '{}' is invalid (use letters, digits and '_', not starting with a digit or 'device.')",
                i, var.name
            )));
        }
        if !seen.insert(var.name.as_str()) {
            return Err(validation_error(format!(
                "variables[{}].name '{}' is declared more than once",
                i, var.name
            )));
        }
    }
    let mut sessions: Vec<&String> = device_variables.keys().collect();
    sessions.sort();
    for session in sessions {
        let mut names: Vec<&String> = device_variables[session].keys().collect();
        names.sort();
        for name in names {
            if !seen.contains(name.as_str()) {
                return Err(validation_error(format!(
                    "device_variables[{}].{} is not a declared variable",
                    session, name
                )));
            }
        }
    }
    Ok(())
}

/// The variable map an execution device starts with: plan defaults, then
/// the plan's per-session overrides (a blank override inherits the default).
/// The `device.*` built-ins are derived at run time and never stored.
fn plan_device_variables(
    plan: &Change,
    session_id: Option<&str>,
) -> std::collections::HashMap<String, String> {
    let mut map: std::collections::HashMap<String, String> = plan
        .variables
        .iter()
        .map(|v| (v.name.clone(), v.value.clone()))
        .collect();
    if let Some(overrides) = session_id.and_then(|sid| plan.device_variables.get(sid)) {
        for (name, value) in overrides {
            if !value.trim().is_empty() {
                map.insert(name.clone(), value.clone());
            }
        }
    }
    map
}

/// Every `required` plan variable must have a non-empty value for the device.
fn require_plan_variables(
    plan: &Change,
    variables: &std::collections::HashMap<String, String>,
    device_label: &str,
) -> Result<(), ApiError> {
    for var in plan.variables.iter().filter(|v| v.required) {
        if variables
            .get(&var.name)
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
        {
            return Err(validation_error(format!(
                "Required variable '{}' has no value for device {}",
                var.name, device_label
            )));
        }
    }
    Ok(())
}

/// List all MOP templates
pub async fn list_mop_templates(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<MopTemplate>>, ApiError> {
    let templates = state.provider.list_mop_templates().await?;
    Ok(Json(templates))
}

/// Get a MOP template by ID
pub async fn get_mop_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopTemplate>, ApiError> {
    let template = state.provider.get_mop_template(&id).await?;
    Ok(Json(template))
}

/// Create a new MOP template
pub async fn create_mop_template(
    State(state): State<Arc<AppState>>,
    Json(template): Json<NewMopTemplate>,
) -> Result<(StatusCode, Json<MopTemplate>), ApiError> {
    require_name(&template.name, "template")?;
    validate_mop_steps("mop_steps", &template.mop_steps)?;
    let created = state.provider.create_mop_template(template).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Update a MOP template
pub async fn update_mop_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateMopTemplate>,
) -> Result<Json<MopTemplate>, ApiError> {
    if let Some(ref name) = update.name {
        require_name(name, "template")?;
    }
    if let Some(ref steps) = update.mop_steps {
        validate_mop_steps("mop_steps", steps)?;
    }
    let updated = state.provider.update_mop_template(&id, update).await?;
    Ok(Json(updated))
}

/// Delete a MOP template
pub async fn delete_mop_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_mop_template(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === MOP Executions API (Phase 30) ===

/// Execution state machine. `PUT` with a status and the control endpoints
/// (`/start`, `/pause`, `/resume`, `/complete`, `/abort`) all go through this
/// table; anything else is 409 `INVALID_STATE`.
fn execution_transition_allowed(from: &ExecutionStatus, to: &ExecutionStatus) -> bool {
    use ExecutionStatus::*;
    matches!(
        (from, to),
        (Pending, Running)
            | (Running, Paused)
            | (Paused, Running)
            | (Running, Complete)
            | (Paused, Complete)
            | (Running, Failed)
            | (Paused, Failed)
            | (Pending, Aborted)
            | (Running, Aborted)
            | (Paused, Aborted)
    )
}

/// Executions whose abort has been accepted while a phase may still be in
/// flight. `/abort` raises the flag; `run_device_phase` / `execute_step`
/// poll it between steps (no provider round-trip) on top of re-reading the
/// execution before every write. Process-global rather than an `AppState`
/// field so the struct literal in main.rs stays untouched. Keyed by
/// execution id; aborted is terminal, so a flag only ever goes away with the
/// execution itself (`delete_mop_execution`).
fn mop_abort_flags() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static FLAGS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    FLAGS.get_or_init(Default::default)
}

fn set_mop_abort_flag(exec_id: &str) {
    mop_abort_flags()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(exec_id.to_string());
}

fn clear_mop_abort_flag(exec_id: &str) {
    mop_abort_flags()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(exec_id);
}

fn mop_abort_flag_set(exec_id: &str) -> bool {
    mop_abort_flags()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(exec_id)
}

/// Watches for the execution leaving the state a phase / step / rollback was
/// started under (abort cascade, pause, complete, PUT status). Checked before
/// every persistent write so a phase that outlives `/abort` never overwrites
/// the cascade's failed / skipped rows with its own verdicts.
struct PhaseGuard<'a> {
    provider: &'a dyn DataProvider,
    exec_id: &'a str,
    /// Execution status when the phase started (`running` for phases and
    /// steps; whatever the execution was in for a rollback).
    expected: ExecutionStatus,
}

impl PhaseGuard<'_> {
    /// `None` while the execution is still in its start state; otherwise the
    /// status it moved to.
    async fn interrupted_by(&self) -> Result<Option<ExecutionStatus>, ApiError> {
        if self.expected != ExecutionStatus::Aborted && mop_abort_flag_set(self.exec_id) {
            return Ok(Some(ExecutionStatus::Aborted));
        }
        let current = self.provider.get_mop_execution(self.exec_id).await?.status;
        Ok(if current == self.expected {
            None
        } else {
            Some(current)
        })
    }
}

/// A step this phase marked `running` whose verdict must not be written
/// because the execution moved on. Only a row still in `running` (i.e. one
/// the abort cascade has not re-labelled) is closed, as failed, so nothing
/// spins forever after a pause / complete either.
async fn close_interrupted_step(
    provider: &dyn DataProvider,
    step_id: &str,
    status: &ExecutionStatus,
) -> Result<(), ApiError> {
    let step = provider.get_mop_execution_step(step_id).await?;
    if step.status != StepExecutionStatus::Running {
        return Ok(());
    }
    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Failed),
        error_message: Some(Some(format!(
            "execution {} while the step was running; result discarded",
            status
        ))),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    provider.update_mop_execution_step(step_id, update).await?;
    Ok(())
}

/// Device counterpart of `close_interrupted_step`.
async fn close_interrupted_device(
    provider: &dyn DataProvider,
    device_id: &str,
    status: &ExecutionStatus,
) -> Result<(), ApiError> {
    let device = provider.get_mop_execution_device(device_id).await?;
    if device.status != DeviceExecutionStatus::Running {
        return Ok(());
    }
    let update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Failed),
        error_message: Some(Some(format!(
            "execution {} while the phase was running",
            status
        ))),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    provider
        .update_mop_execution_device(device_id, update)
        .await?;
    Ok(())
}

/// Apply a status transition after checking the state machine.
async fn transition_execution(
    state: &AppState,
    id: &str,
    to: ExecutionStatus,
    mut update: UpdateMopExecution,
) -> Result<MopExecution, ApiError> {
    let current = state.provider.get_mop_execution(id).await?;
    if !execution_transition_allowed(&current.status, &to) {
        return Err(invalid_state_error(format!(
            "execution {} is {}; cannot move to {}",
            id, current.status, to
        )));
    }
    update.status = Some(to);
    Ok(state.provider.update_mop_execution(id, update).await?)
}

/// List all MOP executions
pub async fn list_mop_executions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<MopExecution>>, ApiError> {
    let executions = state.provider.list_mop_executions().await?;
    Ok(Json(executions))
}

/// Get a MOP execution by ID
pub async fn get_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let execution = state.provider.get_mop_execution(&id).await?;
    Ok(Json(execution))
}

/// Create a new MOP execution
pub async fn create_mop_execution(
    State(state): State<Arc<AppState>>,
    Json(execution): Json<NewMopExecution>,
) -> Result<(StatusCode, Json<MopExecution>), ApiError> {
    require_name(&execution.name, "execution")?;
    let created = state.provider.create_mop_execution(execution).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Update a MOP execution
pub async fn update_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateMopExecution>,
) -> Result<Json<MopExecution>, ApiError> {
    if let Some(ref name) = update.name {
        require_name(name, "execution")?;
    }
    if let Some(ref to) = update.status {
        let current = state.provider.get_mop_execution(&id).await?;
        if current.status != *to && !execution_transition_allowed(&current.status, to) {
            return Err(invalid_state_error(format!(
                "execution {} is {}; cannot move to {}",
                id, current.status, to
            )));
        }
    }
    let updated = state.provider.update_mop_execution(&id, update).await?;
    if updated.status == ExecutionStatus::Aborted {
        set_mop_abort_flag(&id);
    }
    Ok(Json(updated))
}

/// Delete a MOP execution
pub async fn delete_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_mop_execution(&id).await?;
    clear_mop_abort_flag(&id);
    Ok(StatusCode::NO_CONTENT)
}

// === MOP Execution Control API (Phase 30) ===

/// Start a MOP execution (pending → running)
pub async fn start_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let update = UpdateMopExecution {
        started_at: Some(Some(chrono::Utc::now())),
        current_phase: Some(Some("pre_check".to_string())),
        ..Default::default()
    };
    let execution = transition_execution(&state, &id, ExecutionStatus::Running, update).await?;
    Ok(Json(execution))
}

/// Pause a MOP execution (running → paused)
pub async fn pause_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    // Small resume checkpoint — never the serialized execution (which used
    // to nest itself through `last_checkpoint` on every pause).
    let current = state.provider.get_mop_execution(&id).await?;
    let checkpoint = serde_json::json!({
        "phase": current.current_phase,
        "paused_at": chrono::Utc::now(),
    })
    .to_string();

    let update = UpdateMopExecution {
        last_checkpoint: Some(Some(checkpoint)),
        ..Default::default()
    };
    let execution = transition_execution(&state, &id, ExecutionStatus::Paused, update).await?;
    Ok(Json(execution))
}

/// Resume a paused MOP execution (paused → running)
pub async fn resume_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let execution = transition_execution(
        &state,
        &id,
        ExecutionStatus::Running,
        UpdateMopExecution::default(),
    )
    .await?;
    Ok(Json(execution))
}

/// Abort a MOP execution (pending|running|paused → aborted). Devices still
/// running become failed ("aborted"); running steps fail, pending steps are
/// skipped, so nothing is left spinning in the UI.
pub async fn abort_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let update = UpdateMopExecution {
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    let execution = transition_execution(&state, &id, ExecutionStatus::Aborted, update).await?;
    // Raised before the cascade so an in-flight phase stops at its next
    // check instead of racing the cascade's writes.
    set_mop_abort_flag(&id);
    cascade_abort(&state, &id).await?;
    Ok(Json(execution))
}

async fn cascade_abort(state: &AppState, exec_id: &str) -> Result<(), ApiError> {
    let now = chrono::Utc::now();
    for device in state.provider.list_mop_execution_devices(exec_id).await? {
        if device.status == DeviceExecutionStatus::Running {
            let update = UpdateMopExecutionDevice {
                status: Some(DeviceExecutionStatus::Failed),
                error_message: Some(Some("aborted".to_string())),
                completed_at: Some(Some(now)),
                ..Default::default()
            };
            state
                .provider
                .update_mop_execution_device(&device.id, update)
                .await?;
        }
        for step in state.provider.list_mop_execution_steps(&device.id).await? {
            let new_status = match step.status {
                StepExecutionStatus::Running => StepExecutionStatus::Failed,
                StepExecutionStatus::Pending => StepExecutionStatus::Skipped,
                _ => continue,
            };
            let update = UpdateMopExecutionStep {
                status: Some(new_status),
                error_message: Some(Some("aborted".to_string())),
                completed_at: Some(Some(now)),
                ..Default::default()
            };
            state
                .provider
                .update_mop_execution_step(&step.id, update)
                .await?;
        }
    }
    Ok(())
}

/// Complete a MOP execution with AI analysis
#[derive(Debug, Deserialize, Default)]
pub struct CompleteExecutionRequest {
    #[serde(default)]
    pub ai_analysis: Option<String>,
}

/// Complete a MOP execution (running|paused → complete). `ai_analysis` is
/// only overwritten when the body carries a value — `POST /complete {}`
/// used to null it.
pub async fn complete_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: Option<Json<CompleteExecutionRequest>>,
) -> Result<Json<MopExecution>, ApiError> {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let update = UpdateMopExecution {
        completed_at: Some(Some(chrono::Utc::now())),
        ai_analysis: req.ai_analysis.map(Some),
        ..Default::default()
    };
    let execution = transition_execution(&state, &id, ExecutionStatus::Complete, update).await?;
    Ok(Json(execution))
}

// === MOP Execution Devices API (Phase 30) ===

/// Load a device and check it belongs to the execution in the path (404 otherwise).
async fn load_execution_device(
    provider: &dyn DataProvider,
    exec_id: &str,
    device_id: &str,
) -> Result<MopExecutionDevice, ApiError> {
    let device = provider.get_mop_execution_device(device_id).await?;
    if device.execution_id != exec_id {
        return Err(not_found_error(format!(
            "device {} is not part of execution {}",
            device_id, exec_id
        )));
    }
    Ok(device)
}

/// Load a step and check that its device belongs to the execution in the
/// path (404 otherwise). Every `…/steps/:step_id/*` route goes through this
/// so a step from another execution can't be edited, skipped or executed
/// under the wrong `exec_id`.
async fn load_step_in_execution(
    provider: &dyn DataProvider,
    exec_id: &str,
    step_id: &str,
) -> Result<(MopExecutionStep, MopExecutionDevice), ApiError> {
    let step = provider.get_mop_execution_step(step_id).await?;
    let device = provider
        .get_mop_execution_device(&step.execution_device_id)
        .await?;
    if device.execution_id != exec_id {
        return Err(not_found_error(format!(
            "step {} is not part of execution {}",
            step_id, exec_id
        )));
    }
    Ok((step, device))
}

/// The execution must be in one of `allowed_statuses` (409 otherwise).
async fn require_execution_status(
    provider: &dyn DataProvider,
    exec_id: &str,
    allowed_statuses: &[ExecutionStatus],
) -> Result<MopExecution, ApiError> {
    let execution = provider.get_mop_execution(exec_id).await?;
    if !allowed_statuses.contains(&execution.status) {
        return Err(invalid_state_error(format!(
            "execution {} is {}; expected one of {}",
            exec_id,
            execution.status,
            allowed_statuses
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join("|")
        )));
    }
    Ok(execution)
}

/// A skipped device never runs anything (409).
fn require_device_not_skipped(device: &MopExecutionDevice) -> Result<(), ApiError> {
    if device.status == DeviceExecutionStatus::Skipped {
        return Err(invalid_state_error(format!(
            "device {} was skipped",
            device.id
        )));
    }
    Ok(())
}

/// Guards shared by execute-phase / rollback: the execution must be in one
/// of `allowed_statuses`, the device must belong to it and must not have
/// been skipped.
async fn load_phase_target(
    state: &AppState,
    exec_id: &str,
    device_id: &str,
    allowed_statuses: &[ExecutionStatus],
) -> Result<(MopExecution, MopExecutionDevice), ApiError> {
    let execution =
        require_execution_status(state.provider.as_ref(), exec_id, allowed_statuses).await?;
    let device = load_execution_device(state.provider.as_ref(), exec_id, device_id).await?;
    require_device_not_skipped(&device)?;
    Ok((execution, device))
}

/// Per-device "something is running on this device" marker. Held for the
/// duration of a phase / step / rollback call; a concurrent request for the
/// same device gets 409 `PHASE_IN_PROGRESS` instead of a second shell
/// typing over the first one.
struct PhaseLock {
    state: Arc<AppState>,
    device_id: String,
}

impl PhaseLock {
    fn acquire(state: &Arc<AppState>, device_id: &str) -> Result<Self, ApiError> {
        let mut locks = state
            .mop_phase_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if !locks.insert(device_id.to_string()) {
            return Err(ApiError {
                error: format!("a phase or step is already running on device {}", device_id),
                code: "PHASE_IN_PROGRESS".to_string(),
            });
        }
        Ok(Self {
            state: state.clone(),
            device_id: device_id.to_string(),
        })
    }
}

impl Drop for PhaseLock {
    fn drop(&mut self) {
        let mut locks = self
            .state
            .mop_phase_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        locks.remove(&self.device_id);
    }
}

/// List devices for a MOP execution (404 for an unknown execution rather
/// than an empty list).
pub async fn list_execution_devices(
    State(state): State<Arc<AppState>>,
    Path(execution_id): Path<String>,
) -> Result<Json<Vec<MopExecutionDevice>>, ApiError> {
    let _ = state.provider.get_mop_execution(&execution_id).await?;
    let devices = state
        .provider
        .list_mop_execution_devices(&execution_id)
        .await?;
    Ok(Json(devices))
}

/// Add a device to a MOP execution. `device_name` / `device_host` /
/// `cli_flavor` are resolved from the session by the provider when missing.
/// `variables` (the device's resolved `{{name}}` map) is computed from the
/// execution's plan when the client omits it; `required` plan variables
/// without a value are a 400.
pub async fn add_execution_device(
    State(state): State<Arc<AppState>>,
    Path(execution_id): Path<String>,
    Json(device): Json<NewMopExecutionDevice>,
) -> Result<(StatusCode, Json<MopExecutionDevice>), ApiError> {
    let execution = state.provider.get_mop_execution(&execution_id).await?;
    // Ensure execution_id matches the path
    let mut device_data = NewMopExecutionDevice {
        execution_id,
        ..device
    };
    let plan = match execution.plan_id.as_deref() {
        Some(plan_id) => state.provider.get_change(plan_id).await.ok(),
        None => None,
    };
    if let Some(plan) = plan.as_ref() {
        // `device.*` built-ins are derived at resolution time and always win;
        // drop any a client echoed back so the stored map holds user values only.
        let variables: std::collections::HashMap<String, String> =
            match device_data.variables.take() {
                Some(sent) => sent
                    .into_iter()
                    .filter(|(k, _)| !k.starts_with("device."))
                    .collect(),
                None => plan_device_variables(plan, device_data.session_id.as_deref()),
            };
        let mut label = device_data
            .device_name
            .clone()
            .filter(|n| !n.trim().is_empty());
        if label.is_none() {
            if let Some(sid) = device_data.session_id.as_deref() {
                label = state.provider.get_session(sid).await.ok().map(|s| s.name);
            }
        }
        let label = label
            .or_else(|| device_data.device_id.clone())
            .or_else(|| device_data.session_id.clone())
            .unwrap_or_else(|| "unknown".to_string());
        require_plan_variables(plan, &variables, &label)?;
        device_data.variables = Some(variables);
    }
    let created = state
        .provider
        .create_mop_execution_device(device_data)
        .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Skip a device in a MOP execution
pub async fn skip_execution_device(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionDevice>, ApiError> {
    let _ = load_execution_device(state.provider.as_ref(), &exec_id, &device_id).await?;
    let update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Skipped),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    let device = state
        .provider
        .update_mop_execution_device(&device_id, update)
        .await?;
    Ok(Json(device))
}

/// Retry a failed device: device → pending and its failed/skipped steps →
/// pending, so the phase can be run again.
pub async fn retry_execution_device(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionDevice>, ApiError> {
    let _ = load_execution_device(state.provider.as_ref(), &exec_id, &device_id).await?;
    for step in state.provider.list_mop_execution_steps(&device_id).await? {
        if matches!(
            step.status,
            StepExecutionStatus::Failed | StepExecutionStatus::Skipped
        ) {
            let update = UpdateMopExecutionStep {
                status: Some(StepExecutionStatus::Pending),
                output: Some(None),
                error_message: Some(None),
                assertion_results: Some(None),
                started_at: Some(None),
                completed_at: Some(None),
                duration_ms: Some(None),
                ..Default::default()
            };
            state
                .provider
                .update_mop_execution_step(&step.id, update)
                .await?;
        }
    }
    let update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Pending),
        error_message: Some(None),
        started_at: Some(None),
        completed_at: Some(None),
        ..Default::default()
    };
    let device = state
        .provider
        .update_mop_execution_device(&device_id, update)
        .await?;
    Ok(Json(device))
}

/// Optional body for `POST …/rollback`.
#[derive(Debug, Deserialize, Default)]
pub struct RollbackRequest {
    /// Per-step timeout (default 60 s, max 600 s).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Run the device's `rollback` steps exactly like a phase (config wrapper
/// included). Allowed whenever something may have been applied: running,
/// paused, complete, failed or aborted executions — not pending.
pub async fn rollback_execution_device(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
    body: Option<Json<RollbackRequest>>,
) -> Result<Json<PhaseExecutionResult>, ApiError> {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let (execution, device) = load_phase_target(
        &state,
        &exec_id,
        &device_id,
        &[
            ExecutionStatus::Running,
            ExecutionStatus::Paused,
            ExecutionStatus::Complete,
            ExecutionStatus::Failed,
            ExecutionStatus::Aborted,
        ],
    )
    .await?;
    let _lock = PhaseLock::acquire(&state, &device_id)?;
    run_device_phase_guarded(
        &state,
        &exec_id,
        execution.status,
        &device,
        MopStepType::Rollback,
        step_timeout(req.timeout_secs),
    )
    .await
}

// === MOP Execution Steps API (Phase 30) ===

/// List steps for a device (the device must belong to the execution).
pub async fn list_execution_steps(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<Vec<MopExecutionStep>>, ApiError> {
    let _ = load_execution_device(state.provider.as_ref(), &exec_id, &device_id).await?;
    let steps = state.provider.list_mop_execution_steps(&device_id).await?;
    Ok(Json(steps))
}

/// Add steps to a device (bulk create)
pub async fn add_execution_steps(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
    Json(steps): Json<Vec<NewMopExecutionStep>>,
) -> Result<(StatusCode, Json<Vec<MopExecutionStep>>), ApiError> {
    let _ = load_execution_device(state.provider.as_ref(), &exec_id, &device_id).await?;
    if let Some(i) = steps.iter().position(|s| s.command.trim().is_empty()) {
        return Err(validation_error(format!(
            "steps[{}].command must be non-empty",
            i
        )));
    }
    // Ensure device_id matches for all steps
    let steps_data: Vec<NewMopExecutionStep> = steps
        .into_iter()
        .map(|s| NewMopExecutionStep {
            execution_device_id: device_id.clone(),
            ..s
        })
        .collect();
    let created = state
        .provider
        .bulk_create_mop_execution_steps(steps_data)
        .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Values available to `{{placeholder}}` resolution on one execution device:
/// the `device.*` built-ins (which always win) and the device's resolved
/// plan variables (`MopExecutionDevice.variables`).
struct RuntimeVars<'a> {
    device_host: &'a str,
    device_name: &'a str,
    /// `cli_flavor` wire string; "" when unknown.
    device_type: &'a str,
    custom: &'a std::collections::HashMap<String, String>,
}

fn no_runtime_vars() -> &'static std::collections::HashMap<String, String> {
    static EMPTY: std::sync::OnceLock<std::collections::HashMap<String, String>> =
        std::sync::OnceLock::new();
    EMPTY.get_or_init(std::collections::HashMap::new)
}

impl<'a> RuntimeVars<'a> {
    fn for_device(device: &'a MopExecutionDevice) -> Self {
        Self {
            device_host: &device.device_host,
            device_name: &device.device_name,
            device_type: device.cli_flavor.as_deref().unwrap_or(""),
            custom: match device.variables.as_ref() {
                Some(map) => map,
                None => no_runtime_vars(),
            },
        }
    }

    fn lookup(&self, name: &str) -> Option<&str> {
        match name {
            "device.host" => Some(self.device_host),
            "device.name" => Some(self.device_name),
            "device.type" => Some(self.device_type),
            _ => self.custom.get(name).map(String::as_str),
        }
    }
}

/// A placeholder body the resolver recognises: `name` or `device.name`.
fn is_placeholder_name(inner: &str) -> bool {
    let mut chars = inner.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Walk every `{{ … }}` span of `template`, appending either `on_placeholder`'s
/// replacement or the span verbatim (also verbatim when the body is not a
/// placeholder name). Whitespace inside the braces is tolerated.
fn map_placeholders(
    template: &str,
    mut on_placeholder: impl FnMut(&str) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let raw = &rest[start..start + 2 + end + 2];
        let inner = after[..end].trim();
        match if is_placeholder_name(inner) {
            on_placeholder(inner)
        } else {
            None
        } {
            Some(value) => out.push_str(&value),
            None => out.push_str(raw),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// Replace `{{name}}` / `{{ name }}` with the built-in or custom value.
/// Built-ins win over custom variables; unknown placeholders stay verbatim.
fn resolve_runtime_vars(template: &str, vars: &RuntimeVars<'_>) -> String {
    map_placeholders(template, |name| vars.lookup(name).map(str::to_string))
}

/// Placeholder names still present in `text` (after resolution), in order
/// of first appearance, without duplicates.
fn unresolved_placeholders(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    map_placeholders(text, |name| {
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
        None
    });
    names
}

/// `"Unresolved variables: {{vlan}}, {{desc}}"`
fn unresolved_variables_message(names: &[String]) -> String {
    let list: Vec<String> = names.iter().map(|n| format!("{{{{{}}}}}", n)).collect();
    format!("Unresolved variables: {}", list.join(", "))
}

/// Resolve runtime variables in a JSON value (recurse into string values)
fn resolve_runtime_vars_json(
    value: &serde_json::Value,
    vars: &RuntimeVars<'_>,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(resolve_runtime_vars(s, vars)),
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                new_map.insert(k.clone(), resolve_runtime_vars_json(v, vars));
            }
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => serde_json::Value::Array(
            arr.iter()
                .map(|v| resolve_runtime_vars_json(v, vars))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Placeholders left in any string leaf of a resolved JSON value.
fn unresolved_placeholders_json(value: &serde_json::Value) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    fn walk(value: &serde_json::Value, names: &mut Vec<String>) {
        match value {
            serde_json::Value::String(s) => {
                for n in unresolved_placeholders(s) {
                    if !names.contains(&n) {
                        names.push(n);
                    }
                }
            }
            serde_json::Value::Object(map) => map.values().for_each(|v| walk(v, names)),
            serde_json::Value::Array(arr) => arr.iter().for_each(|v| walk(v, names)),
            _ => {}
        }
    }
    walk(value, &mut names);
    names
}

/// Execute a quick action step: fetch action, resolve variables, execute, return output + status + resolved vars
async fn execute_quick_action_step(
    provider: &dyn DataProvider,
    action_id: &str,
    raw_variables: &Option<serde_json::Value>,
    runtime_vars: &RuntimeVars<'_>,
    auth_cache: Option<&crate::api_resource_client::AuthCache>,
) -> Result<
    (
        String,
        StepExecutionStatus,
        std::collections::HashMap<String, String>,
    ),
    ApiError,
> {
    let action = provider
        .get_quick_action(action_id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Quick action not found: {}", action_id),
            code: "NOT_FOUND".to_string(),
        })?;
    let resource = provider
        .get_api_resource(&action.api_resource_id)
        .await?
        .ok_or_else(|| ApiError {
            error: "API resource not found".to_string(),
            code: "NOT_FOUND".to_string(),
        })?;
    let credentials = provider
        .get_api_resource_credentials(&action.api_resource_id)
        .await
        .ok()
        .flatten();

    let raw: std::collections::HashMap<String, String> = raw_variables
        .as_ref()
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let variables: std::collections::HashMap<String, String> = raw
        .into_iter()
        .map(|(k, v)| (k, resolve_runtime_vars(&v, runtime_vars)))
        .collect();
    // Same rule as CLI steps: nothing is sent while a placeholder is unresolved.
    let mut keys: Vec<&String> = variables.keys().collect();
    keys.sort();
    let mut missing: Vec<String> = Vec::new();
    for key in keys {
        for name in unresolved_placeholders(&variables[key]) {
            if !missing.contains(&name) {
                missing.push(name);
            }
        }
    }
    if !missing.is_empty() {
        return Ok((
            unresolved_variables_message(&missing),
            StepExecutionStatus::Failed,
            variables,
        ));
    }

    let result = crate::quick_actions::execute_action(
        &resource,
        credentials.as_ref(),
        crate::api_resource_client::RequestSpec {
            method: &action.method,
            path: &action.path,
            headers: &action.headers,
            body: action.body.as_deref(),
            json_extract_path: action.json_extract_path.as_deref(),
            user_variables: &variables,
        },
        auth_cache,
    )
    .await;

    let output = format_quick_action_output(&result);
    let status = if result.success {
        StepExecutionStatus::Passed
    } else {
        StepExecutionStatus::Failed
    };

    Ok((output, status, variables))
}

/// Format quick action result into display output
fn format_quick_action_output(result: &QuickActionResult) -> String {
    if let Some(ref extracted) = result.extracted_value {
        serde_json::to_string_pretty(extracted).unwrap_or_default()
    } else if let Some(ref body) = result.raw_body {
        serde_json::to_string_pretty(body).unwrap_or_default()
    } else {
        result.error.clone().unwrap_or_default()
    }
}

/// Execute a script step: fetch script, resolve args, execute, return output + status + resolved args
async fn execute_script_step(
    provider: &dyn DataProvider,
    script_id: &str,
    raw_args: &Option<serde_json::Value>,
    runtime_vars: &RuntimeVars<'_>,
) -> Result<(String, StepExecutionStatus, Option<serde_json::Value>), ApiError> {
    let pool = provider.get_pool();
    let script = crate::scripts::get_script_by_id(pool, script_id)
        .await
        .map_err(|e| ApiError {
            error: e.error,
            code: e.code,
        })?;

    let resolved_args = raw_args
        .as_ref()
        .map(|args| resolve_runtime_vars_json(args, runtime_vars));
    if let Some(missing) = resolved_args
        .as_ref()
        .map(unresolved_placeholders_json)
        .filter(|m| !m.is_empty())
    {
        return Ok((
            unresolved_variables_message(&missing),
            StepExecutionStatus::Failed,
            resolved_args,
        ));
    }
    let main_args = resolved_args.as_ref().map(|v| v.to_string());

    let result = crate::scripts::run_script_once(&script.content, None, main_args.as_deref()).await;

    let (status, output) = match result {
        Ok(script_output) => {
            if script_output.exit_code == 0 {
                (StepExecutionStatus::Passed, script_output.stdout)
            } else {
                let err_output = if script_output.stderr.is_empty() {
                    script_output.stdout
                } else {
                    format!(
                        "{}\n\nSTDERR:\n{}",
                        script_output.stdout, script_output.stderr
                    )
                };
                (StepExecutionStatus::Failed, err_output)
            }
        }
        Err(e) => (
            StepExecutionStatus::Failed,
            format!("Script error: {}", e.error),
        ),
    };

    Ok((output, status, resolved_args))
}

// === Step evaluation (NS-MOP-2) ===

/// Per-step timeout bounds (seconds) for `timeout_secs` on phase / step / rollback requests.
const DEFAULT_STEP_TIMEOUT_SECS: u64 = 60;
const MAX_STEP_TIMEOUT_SECS: u64 = 600;

fn step_timeout(requested_secs: Option<u64>) -> std::time::Duration {
    std::time::Duration::from_secs(
        requested_secs
            .unwrap_or(DEFAULT_STEP_TIMEOUT_SECS)
            .clamp(1, MAX_STEP_TIMEOUT_SECS),
    )
}

/// Substrings that mean the device rejected the command even though it
/// returned a prompt. `error: ` (Junos) is matched at line start only.
const VENDOR_ERROR_MARKERS: &[&str] = &[
    "% Invalid input",
    "% Ambiguous command",
    "% Incomplete command",
    "% Unknown command",
    "% Invalid command",
    "syntax error",
    "unknown command",
    "Invalid command",
    "Command fail",
    "command not found",
];

/// Normalise a `cli_flavor` wire string ("cisco-ios", also tolerates
/// "cisco_ios") for the lookup tables below.
fn normalize_cli_flavor(cli_flavor: Option<&str>) -> String {
    cli_flavor
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-")
}

/// Scan a step's own output for a vendor CLI error line. The echoed command
/// line is ignored so a command that mentions "error" does not fail itself.
/// Linux shells only get the `command not found` check — "error"-ish words
/// are ordinary output there.
fn detect_vendor_error(output: &str, command: &str, cli_flavor: Option<&str>) -> Option<String> {
    let flavor = normalize_cli_flavor(cli_flavor);
    let is_linux = flavor == "linux";
    let command = command.trim();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || (!command.is_empty() && trimmed.ends_with(command)) {
            continue;
        }
        if is_linux {
            if trimmed.contains("command not found") {
                return Some(trimmed.to_string());
            }
            continue;
        }
        if trimmed.starts_with("error: ")
            || VENDOR_ERROR_MARKERS.iter().any(|m| trimmed.contains(m))
        {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Evaluate `expected_output` against a step's output. Grammar mirrors the
/// frontend `parseAssertions` (MopWorkspace.tsx): one assertion per line —
/// `CONTAINS: <text>`, `NOT_CONTAINS: <text>`, `REGEX: <pattern>`; any other
/// non-empty line is plain reference text and yields an advisory `TEXT:`
/// result that never changes the step status.
///
/// Returns the results and whether any *structured* assertion failed.
fn evaluate_assertions(expected_output: &str, output: &str) -> (Vec<AssertionResult>, bool) {
    let mut results = Vec::new();
    let mut hard_failure = false;
    for raw in expected_output.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (assertion, passed, detail, advisory) =
            if let Some(text) = line.strip_prefix("CONTAINS:") {
                let text = text.trim();
                let passed = output.contains(text);
                (
                    format!("CONTAINS: {}", text),
                    passed,
                    if passed {
                        "text found in output".to_string()
                    } else {
                        "text not found in output".to_string()
                    },
                    false,
                )
            } else if let Some(text) = line.strip_prefix("NOT_CONTAINS:") {
                let text = text.trim();
                let passed = !output.contains(text);
                (
                    format!("NOT_CONTAINS: {}", text),
                    passed,
                    if passed {
                        "text absent from output".to_string()
                    } else {
                        "text present in output".to_string()
                    },
                    false,
                )
            } else if let Some(pattern) = line.strip_prefix("REGEX:") {
                let pattern = pattern.trim();
                let (passed, detail) = match regex::Regex::new(pattern) {
                    Ok(re) => match re.find(output) {
                        Some(m) => (true, format!("matched '{}'", m.as_str())),
                        None => (false, "pattern did not match".to_string()),
                    },
                    Err(e) => (false, format!("invalid regex: {}", e)),
                };
                (format!("REGEX: {}", pattern), passed, detail, false)
            } else {
                let passed = output.contains(line);
                (
                    format!("TEXT: {}", line),
                    passed,
                    if passed {
                        "reference text present (advisory)".to_string()
                    } else {
                        "reference text not found (advisory, does not fail the step)".to_string()
                    },
                    true,
                )
            };
        if !passed && !advisory {
            hard_failure = true;
        }
        results.push(AssertionResult {
            assertion,
            passed,
            detail,
        });
    }
    (results, hard_failure)
}

/// Outcome of running one step, ready to be persisted by `finalize_step_execution`.
#[derive(Debug, Clone)]
struct StepEvaluation {
    status: StepExecutionStatus,
    /// The step's OWN output — never the cumulative session transcript.
    output: String,
    error_message: Option<String>,
    assertion_results: Option<Vec<AssertionResult>>,
}

impl StepEvaluation {
    fn failed(output: String, error_message: impl Into<String>) -> Self {
        Self {
            status: StepExecutionStatus::Failed,
            output,
            error_message: Some(error_message.into()),
            assertion_results: None,
        }
    }

    /// Apply `expected_output` assertions. Results are recorded regardless;
    /// the status only drops to `failed` from `passed`.
    fn with_assertions(mut self, expected_output: Option<&str>) -> Self {
        let expected = expected_output.map(str::trim).unwrap_or("");
        if expected.is_empty() {
            return self;
        }
        let (results, hard_failure) = evaluate_assertions(expected, &self.output);
        if hard_failure && self.status == StepExecutionStatus::Passed {
            let first = results
                .iter()
                .find(|r| !r.passed && !r.assertion.starts_with("TEXT: "))
                .map(|r| format!("assertion failed: {} ({})", r.assertion, r.detail))
                .unwrap_or_else(|| "assertion failed".to_string());
            self.status = StepExecutionStatus::Failed;
            self.error_message = Some(first);
        }
        self.assertion_results = Some(results);
        self
    }
}

/// Pass/fail rule for a CLI step (NS-MOP-2):
/// 1. transport failure (error / timeout / auth / not-run) → failed (not-run → skipped);
/// 2. vendor error marker in the step's own output → failed;
/// 3. `expected_output` assertions → failed on any structured miss;
/// 4. otherwise passed.
fn evaluate_cli_step(
    result: &ssh::ShellCommandResult,
    command: &str,
    expected_output: Option<&str>,
    cli_flavor: Option<&str>,
    timeout: std::time::Duration,
) -> StepEvaluation {
    let base = match result.status {
        ssh::CommandStatus::Success => {
            match detect_vendor_error(&result.output, command, cli_flavor) {
                Some(line) => StepEvaluation::failed(result.output.clone(), line),
                None => StepEvaluation {
                    status: StepExecutionStatus::Passed,
                    output: result.output.clone(),
                    error_message: None,
                    assertion_results: None,
                },
            }
        }
        ssh::CommandStatus::Error => StepEvaluation::failed(
            result.output.clone(),
            result
                .error
                .clone()
                .unwrap_or_else(|| "command failed".to_string()),
        ),
        ssh::CommandStatus::Timeout => StepEvaluation::failed(
            result.output.clone(),
            format!("command timed out after {}s", timeout.as_secs()),
        ),
        ssh::CommandStatus::AuthFailed => StepEvaluation::failed(
            result.output.clone(),
            "authentication failed - check credentials",
        ),
        ssh::CommandStatus::NotRun => StepEvaluation {
            status: StepExecutionStatus::Skipped,
            output: String::new(),
            error_message: Some(
                result
                    .error
                    .clone()
                    .unwrap_or_else(|| "not run: an earlier step timed out".to_string()),
            ),
            assertion_results: None,
        },
    };
    base.with_assertions(expected_output)
}

/// Evaluation for quick-action / script steps: status from the runner, then
/// the same assertion pass as CLI steps.
fn evaluate_generic_step(
    status: StepExecutionStatus,
    output: String,
    expected_output: Option<&str>,
) -> StepEvaluation {
    let error_message = if status == StepExecutionStatus::Failed {
        Some(
            output
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .unwrap_or_else(|| "step failed".to_string()),
        )
    } else {
        None
    };
    StepEvaluation {
        status,
        output,
        error_message,
        assertion_results: None,
    }
    .with_assertions(expected_output)
}

/// Whether a step is transported over the device's CLI shell.
fn is_cli_step(step: &MopExecutionStep) -> bool {
    step.execution_source != "quick_action"
        && step.execution_source != "script"
        && step.step_type != MopStepType::ApiAction
}

/// Persist a finished step: status, own output, error, assertions, duration.
async fn finalize_step_execution(
    provider: &dyn DataProvider,
    step_id: &str,
    eval: StepEvaluation,
    started_at: chrono::DateTime<chrono::Utc>,
    extra_fields: Option<UpdateMopExecutionStep>,
) -> Result<MopExecutionStep, ApiError> {
    let now = chrono::Utc::now();
    // A step that never ran (skipped after an earlier timeout) has no
    // duration of its own — the batch's elapsed time used to land here.
    let duration_ms = if eval.status == StepExecutionStatus::Skipped {
        None
    } else {
        Some((now - started_at).num_milliseconds())
    };

    let mut update = extra_fields.unwrap_or_default();
    update.status = Some(eval.status);
    update.output = Some(Some(eval.output));
    update.error_message = Some(eval.error_message);
    update.assertion_results = Some(eval.assertion_results);
    update.completed_at = Some(Some(now));
    update.duration_ms = Some(duration_ms);

    Ok(provider.update_mop_execution_step(step_id, update).await?)
}

// === Phase wrapper (NS-MOP-5) ===

/// Commands sent before / after the steps of a phase, keyed on the session's
/// `cli_flavor`. Change and rollback enter and leave config mode and save;
/// pre/post checks disable the pager. Unknown / `auto` / Linux / FortiOS
/// flavors get no wrapper at all (FortiOS has no global config mode and
/// commits per `end`).
fn phase_commands(cli_flavor: Option<&str>, step_type: &MopStepType) -> (Vec<String>, Vec<String>) {
    let flavor = normalize_cli_flavor(cli_flavor);
    let strings = |cmds: &[&str]| cmds.iter().map(|c| c.to_string()).collect::<Vec<String>>();
    match step_type {
        MopStepType::Change | MopStepType::Rollback => match flavor.as_str() {
            "cisco-ios" | "cisco-ios-xe" | "cisco-nxos" | "arista" | "arista-eos" => (
                strings(&["configure terminal"]),
                strings(&["end", "write memory"]),
            ),
            "cisco-ios-xr" => (strings(&["configure"]), strings(&["commit", "end"])),
            "juniper" | "juniper-junos" => (strings(&["configure"]), strings(&["commit", "exit"])),
            "paloalto" | "panos" => (strings(&["configure"]), strings(&["commit", "exit"])),
            _ => (Vec::new(), Vec::new()),
        },
        MopStepType::PreCheck | MopStepType::PostCheck => match flavor.as_str() {
            "cisco-ios" | "cisco-ios-xe" | "cisco-ios-xr" | "cisco-nxos" | "arista"
            | "arista-eos" => (strings(&["terminal length 0"]), Vec::new()),
            "juniper" | "juniper-junos" => (strings(&["set cli screen-length 0"]), Vec::new()),
            _ => (Vec::new(), Vec::new()),
        },
        MopStepType::ApiAction => (Vec::new(), Vec::new()),
    }
}

/// Strict exec-prompt detection (`^\S+[#>]$`) is right for network CLIs and
/// wrong for Linux shells (`user@host:~$` never matches, so every command
/// would time out). Unknown / `auto` flavors keep the loose heuristic.
fn exec_prompt_only_for(cli_flavor: Option<&str>) -> bool {
    matches!(
        normalize_cli_flavor(cli_flavor).as_str(),
        "cisco-ios"
            | "cisco-ios-xe"
            | "cisco-ios-xr"
            | "cisco-nxos"
            | "arista"
            | "arista-eos"
            | "juniper"
            | "juniper-junos"
            | "paloalto"
            | "panos"
            | "fortinet"
            | "fortios"
    )
}

const WRAP_PRE_PREFIX: &str = "__pre__";

/// Separates the per-step sections of a phase snapshot from the raw session
/// transcript appended after them. The diff / analysis only look at the part
/// before the marker, so login banners and clocks never show up as changes.
const SNAPSHOT_TRANSCRIPT_MARKER: &str = "\n=== session transcript ===\n";

/// The per-step part of a snapshot output (everything before the transcript).
fn snapshot_step_output(output: &str) -> &str {
    output
        .split(SNAPSHOT_TRANSCRIPT_MARKER)
        .next()
        .unwrap_or(output)
}

/// What one wrapped SSH shell batch produced.
struct CliBatchOutcome {
    /// Results for the real steps, in batch order.
    step_results: Vec<ssh::ShellCommandResult>,
    /// "=== cmd ===" sections for the setup / teardown commands, appended to
    /// the phase output so the config-mode entry and the save are auditable.
    wrapper_output: String,
    /// First failing teardown command (commit / write memory), if any.
    post_command_error: Option<String>,
    /// The raw session transcript (banner, wrapper, steps) — snapshot only.
    transcript: String,
}

/// Open one shell, run `pre` wrapper → steps → `post` wrapper, and split the
/// results back out. Setup commands ride in the batch with synthetic step ids
/// and teardown commands come back as `post_command_results`, so their
/// success is observable — `write memory` failing used to be a `warn!` and
/// the step still passed.
async fn run_wrapped_cli_batch(
    config: SshConfig,
    session: &Session,
    auto_commands: Vec<String>,
    cli_flavor: Option<&str>,
    step_type: &MopStepType,
    steps: &[(String, String)],
    timeout: std::time::Duration,
) -> CliBatchOutcome {
    let (pre, post) = phase_commands(cli_flavor, step_type);
    let mut commands: Vec<(String, String)> = pre
        .iter()
        .enumerate()
        .map(|(i, c)| (format!("{}{}", WRAP_PRE_PREFIX, i), c.clone()))
        .collect();
    commands.extend(steps.iter().cloned());

    // AUDIT FIX (REMOTE-003): default-refuse changed host keys.
    let shell_results = ssh::execute_commands_via_shell(
        config,
        session.id.clone(),
        session.name.clone(),
        ssh::ShellCommandBatch {
            auto_commands,
            commands: commands.clone(),
            post_commands: post.clone(),
            timeout_per_command: timeout,
            exec_prompt_only: exec_prompt_only_for(cli_flavor),
            stop_on_timeout: true,
        },
        false, // auto_accept_changed_keys
    )
    .await;

    let mut outcome = CliBatchOutcome {
        step_results: Vec::with_capacity(steps.len()),
        wrapper_output: String::new(),
        post_command_error: None,
        transcript: shell_results.full_transcript,
    };
    let wrapper_failure = |result: &ssh::ShellCommandResult, cmd: &str| match result.status {
        ssh::CommandStatus::Success => detect_vendor_error(&result.output, cmd, cli_flavor),
        _ => Some(
            result
                .error
                .clone()
                .unwrap_or_else(|| format!("{:?}", result.status).to_lowercase()),
        ),
    };
    for result in shell_results.commands {
        if !result.step_id.starts_with(WRAP_PRE_PREFIX) {
            outcome.step_results.push(result);
            continue;
        }
        let cmd = commands
            .iter()
            .find(|(id, _)| *id == result.step_id)
            .map(|(_, c)| c.as_str())
            .unwrap_or("");
        outcome
            .wrapper_output
            .push_str(&format!("\n=== {} [setup] ===\n{}\n", cmd, result.output));
        if let Some(detail) = wrapper_failure(&result, cmd) {
            tracing::warn!(
                "MOP setup command '{}' failed on {}: {}",
                cmd,
                session.name,
                detail
            );
        }
    }
    // Teardown: `post_command_results` is empty when the batch stopped early
    // (timeout / connection failure) — the config was then never saved.
    if !post.is_empty() && shell_results.post_command_results.is_empty() {
        outcome.post_command_error = Some(format!(
            "{}: not run (batch stopped early)",
            post.join(", ")
        ));
    }
    for result in shell_results.post_command_results {
        let cmd = result.step_id.clone();
        outcome
            .wrapper_output
            .push_str(&format!("\n=== {} [save] ===\n{}\n", cmd, result.output));
        if let Some(detail) = wrapper_failure(&result, &cmd) {
            tracing::warn!(
                "MOP post-command '{}' failed on {}: {}",
                cmd,
                session.name,
                detail
            );
            if outcome.post_command_error.is_none() {
                outcome.post_command_error = Some(format!("{}: {}", cmd, detail));
            }
        }
    }
    outcome
}

/// Resolve everything needed to open the device's shell: session, profile,
/// credential-backed SSH config and the effective auto_commands.
async fn resolve_device_ssh(
    state: &AppState,
    device: &MopExecutionDevice,
) -> Result<(Session, SshConfig, Vec<String>), ApiError> {
    let session_id = device
        .session_id
        .as_deref()
        .ok_or_else(|| validation_error("Device has no session_id"))?;
    let session = state.provider.get_session(session_id).await?;
    let profile = state.provider.get_profile(&session.profile_id).await?;
    let credential = state
        .provider
        .get_profile_credential(&session.profile_id)
        .await?;
    let config =
        build_ssh_config_from_session(&session, &profile, credential.as_ref()).map_err(|e| {
            ApiError {
                error: e,
                code: "AUTH_MISSING".to_string(),
            }
        })?;
    let auto_commands = if session.auto_commands.is_empty() {
        profile.auto_commands.clone()
    } else {
        session.auto_commands.clone()
    };
    Ok((session, config, auto_commands))
}

/// Fill in `device_name` / `device_host` / `cli_flavor` from the session when
/// the row still carries a UUID fallback or nothing (devices added before
/// these were resolved at insert time). Returns the effective device.
async fn refresh_device_identity(
    state: &AppState,
    device: &MopExecutionDevice,
    session: &Session,
) -> Result<MopExecutionDevice, ApiError> {
    let uuid_ish =
        |v: &str| v.trim().is_empty() || Some(v) == device.session_id.as_deref() || v == "unknown";
    let mut update = UpdateMopExecutionDevice::default();
    if uuid_ish(&device.device_name) {
        update.device_name = Some(session.name.clone());
    }
    if uuid_ish(&device.device_host) {
        update.device_host = Some(session.host.clone());
    }
    if device
        .cli_flavor
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        update.cli_flavor = Some(Some(session.cli_flavor.as_str().to_string()));
    }
    if update.device_name.is_none() && update.device_host.is_none() && update.cli_flavor.is_none() {
        return Ok(device.clone());
    }
    Ok(state
        .provider
        .update_mop_execution_device(&device.id, update)
        .await?)
}

/// Optional body for `POST …/steps/:id/execute`.
#[derive(Debug, Deserialize, Default)]
pub struct ExecuteStepRequest {
    /// Per-step timeout (default 60 s, max 600 s).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Execute a step - actually runs the command on the device via SSH
pub async fn execute_step(
    State(state): State<Arc<AppState>>,
    Path((exec_id, step_id)): Path<(String, String)>,
    body: Option<Json<ExecuteStepRequest>>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let (step, device) =
        load_step_in_execution(state.provider.as_ref(), &exec_id, &step_id).await?;
    let _ = require_execution_status(
        state.provider.as_ref(),
        &exec_id,
        &[ExecutionStatus::Running],
    )
    .await?;
    require_device_not_skipped(&device)?;
    let _lock = PhaseLock::acquire(&state, &device.id)?;
    let start_time = chrono::Utc::now();
    match execute_step_inner(
        &state,
        &exec_id,
        &device,
        step,
        start_time,
        step_timeout(req.timeout_secs),
    )
    .await
    {
        Ok(step) => Ok(Json(step)),
        Err(err) => {
            // The step was already marked Running; without this it stays in the
            // "running" spinner forever after a 4xx/5xx (NS-AGENT-1).
            let update = UpdateMopExecutionStep {
                status: Some(StepExecutionStatus::Failed),
                error_message: Some(Some(err.error.clone())),
                completed_at: Some(Some(chrono::Utc::now())),
                ..Default::default()
            };
            if let Err(e) = state
                .provider
                .update_mop_execution_step(&step_id, update)
                .await
            {
                tracing::warn!(
                    "execute_step: failed to mark step {} failed: {}",
                    step_id,
                    e
                );
            }
            Err(err)
        }
    }
}

async fn execute_step_inner(
    state: &Arc<AppState>,
    exec_id: &str,
    device: &MopExecutionDevice,
    step: MopExecutionStep,
    start_time: chrono::DateTime<chrono::Utc>,
    timeout: std::time::Duration,
) -> Result<MopExecutionStep, ApiError> {
    let step_id = step.id.clone();
    // Single steps only run on a `running` execution; anything else seen at
    // write time (abort cascade, pause, complete) wins over our verdict.
    let guard = PhaseGuard {
        provider: state.provider.as_ref(),
        exec_id,
        expected: ExecutionStatus::Running,
    };

    // Mark step as running
    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Running),
        started_at: Some(Some(start_time)),
        error_message: Some(None),
        assertion_results: Some(None),
        ..Default::default()
    };
    let step = state
        .provider
        .update_mop_execution_step(&step_id, update)
        .await?;

    // Check if mock mode is enabled
    if step.mock_enabled {
        let mock_output = step
            .mock_output
            .clone()
            .unwrap_or_else(|| "[MOCKED] No mock output provided".to_string());
        let eval = StepEvaluation {
            status: StepExecutionStatus::Mocked,
            output: mock_output,
            error_message: None,
            assertion_results: None,
        };
        return finalize_step_guarded(&guard, &step_id, eval, start_time, None).await;
    }

    // Device context for runtime variable substitution (resolved names, never UUIDs)
    let session = match device.session_id.as_deref() {
        Some(sid) => state.provider.get_session(sid).await.ok(),
        None => None,
    };
    let device = match session.as_ref() {
        Some(s) => refresh_device_identity(state, device, s).await?,
        None => device.clone(),
    };
    let runtime_vars = RuntimeVars::for_device(&device);

    // Handle quick_action execution source (or legacy api_action step type)
    if step.execution_source == "quick_action" || step.step_type == MopStepType::ApiAction {
        let action_id = step.quick_action_id.as_deref().unwrap_or(&step.command);
        let (output, status, variables) = execute_quick_action_step(
            state.provider.as_ref(),
            action_id,
            &step.quick_action_variables,
            &runtime_vars,
            Some(&state.auth_cache),
        )
        .await?;

        let extra = UpdateMopExecutionStep {
            quick_action_variables: Some(Some(
                serde_json::to_value(&variables).unwrap_or_default(),
            )),
            ..Default::default()
        };
        let eval = evaluate_generic_step(status, output, step.expected_output.as_deref());
        return finalize_step_guarded(&guard, &step_id, eval, start_time, Some(extra)).await;
    }

    // Handle script execution source
    if step.execution_source == "script" {
        let script_id = step.script_id.as_deref().unwrap_or(&step.command);
        let (output, status, resolved_args) = execute_script_step(
            state.provider.as_ref(),
            script_id,
            &step.script_args,
            &runtime_vars,
        )
        .await?;

        let extra = UpdateMopExecutionStep {
            script_args: Some(resolved_args),
            ..Default::default()
        };
        let eval = evaluate_generic_step(status, output, step.expected_output.as_deref());
        return finalize_step_guarded(&guard, &step_id, eval, start_time, Some(extra)).await;
    }

    // CLI step: `{{name}}` placeholders resolved here (the client normally
    // sends resolved text already); anything left unresolved fails the step
    // before a shell is even opened.
    let command = resolve_runtime_vars(&step.command, &runtime_vars);
    let missing = unresolved_placeholders(&command);
    if !missing.is_empty() {
        let eval = StepEvaluation::failed(String::new(), unresolved_variables_message(&missing));
        return finalize_step_guarded(&guard, &step_id, eval, start_time, None).await;
    }

    // Fresh shell, same config-mode wrapper as the phase path.
    let (session, config, auto_commands) = match resolve_device_ssh(state, &device).await {
        Ok(v) => v,
        Err(e) if e.code == "AUTH_MISSING" => {
            // Missing credentials: record on the step rather than 401 the call.
            let eval = StepEvaluation::failed(String::new(), e.error);
            return finalize_step_guarded(&guard, &step_id, eval, start_time, None).await;
        }
        Err(e) => return Err(e),
    };

    let outcome = run_wrapped_cli_batch(
        config,
        &session,
        auto_commands,
        device.cli_flavor.as_deref(),
        &step.step_type,
        &[(step_id.clone(), command.clone())],
        timeout,
    )
    .await;

    let result = outcome
        .step_results
        .into_iter()
        .next()
        .unwrap_or(ssh::ShellCommandResult {
            step_id: step_id.clone(),
            status: ssh::CommandStatus::Error,
            output: String::new(),
            error: Some("No result returned".to_string()),
            execution_time_ms: 0,
            transcript: String::new(),
        });

    let mut eval = evaluate_cli_step(
        &result,
        &command,
        step.expected_output.as_deref(),
        device.cli_flavor.as_deref(),
        timeout,
    );
    if let Some(post_err) = outcome.post_command_error {
        eval.status = StepExecutionStatus::Failed;
        eval.error_message = Some(format!("config save failed: {}", post_err));
    }

    finalize_step_guarded(&guard, &step_id, eval, start_time, None).await
}

/// `finalize_step_execution` unless the execution moved on meanwhile — then
/// the row is closed (if still `running`) and returned as it stands.
async fn finalize_step_guarded(
    guard: &PhaseGuard<'_>,
    step_id: &str,
    eval: StepEvaluation,
    started_at: chrono::DateTime<chrono::Utc>,
    extra_fields: Option<UpdateMopExecutionStep>,
) -> Result<MopExecutionStep, ApiError> {
    if let Some(status) = guard.interrupted_by().await? {
        tracing::warn!(
            "execute_step: execution {} is {}; discarding the result of step {}",
            guard.exec_id,
            status,
            step_id
        );
        close_interrupted_step(guard.provider, step_id, &status).await?;
        return Ok(guard.provider.get_mop_execution_step(step_id).await?);
    }
    finalize_step_execution(guard.provider, step_id, eval, started_at, extra_fields).await
}

/// Approve a step (mark as passed — engineer override, clears the error)
pub async fn approve_step(
    State(state): State<Arc<AppState>>,
    Path((exec_id, step_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let (step, _) = load_step_in_execution(state.provider.as_ref(), &exec_id, &step_id).await?;
    let now = chrono::Utc::now();
    let duration_ms = step
        .started_at
        .map(|start| (now - start).num_milliseconds());

    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Passed),
        error_message: Some(None),
        completed_at: Some(Some(now)),
        duration_ms: Some(duration_ms),
        ..Default::default()
    };
    let step = state
        .provider
        .update_mop_execution_step(&step_id, update)
        .await?;
    Ok(Json(step))
}

/// Skip a step
pub async fn skip_step(
    State(state): State<Arc<AppState>>,
    Path((exec_id, step_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let _ = load_step_in_execution(state.provider.as_ref(), &exec_id, &step_id).await?;
    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Skipped),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    let step = state
        .provider
        .update_mop_execution_step(&step_id, update)
        .await?;
    Ok(Json(step))
}

/// Update step mock configuration
#[derive(Debug, Deserialize)]
pub struct MockConfig {
    pub mock_enabled: bool,
    pub mock_output: Option<String>,
}

pub async fn update_step_mock(
    State(state): State<Arc<AppState>>,
    Path((exec_id, step_id)): Path<(String, String)>,
    Json(mock): Json<MockConfig>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let _ = load_step_in_execution(state.provider.as_ref(), &exec_id, &step_id).await?;
    let update = UpdateMopExecutionStep {
        mock_enabled: Some(mock.mock_enabled),
        mock_output: Some(mock.mock_output),
        ..Default::default()
    };
    let step = state
        .provider
        .update_mop_execution_step(&step_id, update)
        .await?;
    Ok(Json(step))
}

/// Edit the command text for a MOP execution step before it runs.
///
/// Frontend's inline step-edit affordance used to silently no-op the
/// persistence — the original command was always re-run on execute.
/// This endpoint makes the edit actually stick: the execute path reads
/// the step row at execute-time, so once the command column is updated
/// the new command is what gets sent to the device.
#[derive(Debug, Deserialize)]
pub struct StepCommandUpdate {
    pub command: String,
}

pub async fn update_step_command(
    State(state): State<Arc<AppState>>,
    Path((exec_id, step_id)): Path<(String, String)>,
    Json(payload): Json<StepCommandUpdate>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let command = payload.command.trim().to_string();
    if command.is_empty() {
        return Err(validation_error("command must be non-empty"));
    }
    let _ = load_step_in_execution(state.provider.as_ref(), &exec_id, &step_id).await?;
    let update = UpdateMopExecutionStep {
        command: Some(command),
        ..Default::default()
    };
    let step = state
        .provider
        .update_mop_execution_step(&step_id, update)
        .await?;
    Ok(Json(step))
}

/// Update step output after execution
#[derive(Debug, Deserialize)]
pub struct StepOutputUpdate {
    pub output: Option<String>,
    pub status: StepExecutionStatus,
    pub ai_feedback: Option<String>,
}

pub async fn update_step_output(
    State(state): State<Arc<AppState>>,
    Path((exec_id, step_id)): Path<(String, String)>,
    Json(output): Json<StepOutputUpdate>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let (step, _) = load_step_in_execution(state.provider.as_ref(), &exec_id, &step_id).await?;
    let now = chrono::Utc::now();
    let duration_ms = step
        .started_at
        .map(|start| (now - start).num_milliseconds());

    let update = UpdateMopExecutionStep {
        status: Some(output.status),
        output: Some(output.output),
        ai_feedback: Some(output.ai_feedback),
        completed_at: Some(Some(now)),
        duration_ms: Some(duration_ms),
        ..Default::default()
    };
    let step = state
        .provider
        .update_mop_execution_step(&step_id, update)
        .await?;
    Ok(Json(step))
}

// === MOP Phase Execution & Snapshot APIs ===

/// Request to execute all steps of a specific type for a device
#[derive(Debug, Deserialize)]
pub struct ExecutePhaseRequest {
    pub step_type: MopStepType, // pre_check, change, post_check, rollback
    /// Per-step timeout (default 60 s, max 600 s).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Response with phase execution results
#[derive(Debug, Serialize)]
pub struct PhaseExecutionResult {
    pub device_id: String,
    /// snake_case: pre_check | change | post_check | rollback | api_action
    pub step_type: String,
    /// Steps that actually ran (passed + failed; mocked counts as passed).
    pub steps_executed: usize,
    pub steps_passed: usize,
    pub steps_failed: usize,
    /// Steps not run because an earlier step timed out / the shell was lost.
    pub steps_skipped: usize,
    pub snapshot_id: Option<String>,
    pub combined_output: String,
    /// True when the phase stopped before its last step (timeout / auth /
    /// connection loss, or the execution was aborted / paused / completed
    /// while the phase was running — see the note in `combined_output`).
    pub stopped_early: bool,
    /// First failing teardown command (`commit` / `write memory`), if any.
    pub post_command_error: Option<String>,
}

/// Execute all steps of a phase for a device and capture snapshot
pub async fn execute_device_phase(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
    Json(req): Json<ExecutePhaseRequest>,
) -> Result<Json<PhaseExecutionResult>, ApiError> {
    let (execution, device) =
        load_phase_target(&state, &exec_id, &device_id, &[ExecutionStatus::Running]).await?;
    let _lock = PhaseLock::acquire(&state, &device_id)?;
    run_device_phase_guarded(
        &state,
        &exec_id,
        execution.status,
        &device,
        req.step_type,
        step_timeout(req.timeout_secs),
    )
    .await
}

/// `run_device_phase` plus the NS-AGENT-1 guarantee: never leave the device
/// stuck in Running when the handler errors out.
async fn run_device_phase_guarded(
    state: &Arc<AppState>,
    exec_id: &str,
    expected_status: ExecutionStatus,
    device: &MopExecutionDevice,
    step_type: MopStepType,
    timeout: std::time::Duration,
) -> Result<Json<PhaseExecutionResult>, ApiError> {
    match run_device_phase(
        state,
        exec_id,
        expected_status.clone(),
        device,
        step_type,
        timeout,
    )
    .await
    {
        Ok(r) => Ok(Json(r)),
        Err(err) => {
            // If the execution moved on meanwhile the cascade owns the device row.
            let guard = PhaseGuard {
                provider: state.provider.as_ref(),
                exec_id,
                expected: expected_status,
            };
            if guard.interrupted_by().await.ok().flatten().is_some() {
                return Err(err);
            }
            let update = UpdateMopExecutionDevice {
                status: Some(DeviceExecutionStatus::Failed),
                error_message: Some(Some(err.error.clone())),
                completed_at: Some(Some(chrono::Utc::now())),
                ..Default::default()
            };
            if let Err(e) = state
                .provider
                .update_mop_execution_device(&device.id, update)
                .await
            {
                tracing::warn!(
                    "execute_device_phase: failed to mark device {} failed: {}",
                    device.id,
                    e
                );
            }
            Err(err)
        }
    }
}

/// Running tallies for one phase run.
#[derive(Default)]
struct PhaseTally {
    passed: usize,
    failed: usize,
    skipped: usize,
    combined_output: String,
    commands_run: Vec<String>,
    stopped_early: bool,
    post_command_error: Option<String>,
    first_error: Option<String>,
    /// Raw shell transcripts of every batch (snapshot only).
    transcripts: String,
    /// Set when the execution left its start state mid-phase; no further
    /// step / device / snapshot writes happen after this.
    interrupted: Option<ExecutionStatus>,
}

impl PhaseTally {
    fn interrupt(&mut self, status: ExecutionStatus) {
        if self.interrupted.is_none() {
            self.combined_output.push_str(&format!(
                "\n[execution {} while phase was running; remaining steps not run, results not recorded]\n",
                status
            ));
            self.interrupted = Some(status);
        }
        self.stopped_early = true;
    }

    fn record(&mut self, step: &MopExecutionStep, eval: &StepEvaluation, label: &str) {
        match eval.status {
            StepExecutionStatus::Passed | StepExecutionStatus::Mocked => self.passed += 1,
            StepExecutionStatus::Failed => {
                self.failed += 1;
                if self.first_error.is_none() {
                    self.first_error = eval.error_message.clone();
                }
            }
            StepExecutionStatus::Skipped => self.skipped += 1,
            _ => {}
        }
        let title = step
            .description
            .as_deref()
            .filter(|d| !d.trim().is_empty())
            .unwrap_or(&step.command);
        self.combined_output
            .push_str(&format!("\n=== {}{} ===\n{}\n", title, label, eval.output));
        if let Some(err) = eval.error_message.as_deref() {
            self.combined_output
                .push_str(&format!("[{}: {}]\n", eval.status, err));
        }
        self.commands_run.push(step.command.clone());
    }
}

/// Tally and persist a step verdict — unless the execution moved on, in
/// which case the row is closed (if still ours), the tally is marked
/// interrupted and `false` comes back so the phase stops.
async fn record_and_finalize(
    guard: &PhaseGuard<'_>,
    tally: &mut PhaseTally,
    step: &MopExecutionStep,
    eval: StepEvaluation,
    label: &str,
    started_at: chrono::DateTime<chrono::Utc>,
    extra_fields: Option<UpdateMopExecutionStep>,
) -> Result<bool, ApiError> {
    if let Some(status) = guard.interrupted_by().await? {
        close_interrupted_step(guard.provider, &step.id, &status).await?;
        tally.interrupt(status);
        return Ok(false);
    }
    tally.record(step, &eval, label);
    finalize_step_execution(guard.provider, &step.id, eval, started_at, extra_fields).await?;
    Ok(true)
}

/// Run every step of `step_type` on one device, strictly in `step_order`.
/// Contiguous CLI steps share one shell batch (wrapper included); quick
/// actions / scripts run inline at their position. Pre/post-check phases
/// store an execution-owned snapshot of the combined output.
///
/// `expected_status` is what the execution was in when the caller checked
/// it; every write re-checks it (plus the abort flag) so an `/abort`,
/// pause or complete that lands mid-phase is never overwritten.
async fn run_device_phase(
    state: &Arc<AppState>,
    exec_id: &str,
    expected_status: ExecutionStatus,
    device: &MopExecutionDevice,
    step_type: MopStepType,
    timeout: std::time::Duration,
) -> Result<PhaseExecutionResult, ApiError> {
    tracing::info!(
        "run_device_phase: exec_id={}, device_id={}, step_type={}",
        exec_id,
        device.id,
        step_type
    );
    let device_id = device.id.clone();
    let guard = PhaseGuard {
        provider: state.provider.as_ref(),
        exec_id,
        expected: expected_status,
    };

    let mut phase_steps: Vec<MopExecutionStep> = state
        .provider
        .list_mop_execution_steps(&device_id)
        .await?
        .into_iter()
        .filter(|s| s.step_type == step_type)
        .collect();
    phase_steps.sort_by_key(|s| s.step_order);

    if phase_steps.is_empty() {
        return Ok(PhaseExecutionResult {
            device_id,
            step_type: step_type.to_string(),
            steps_executed: 0,
            steps_passed: 0,
            steps_failed: 0,
            steps_skipped: 0,
            snapshot_id: None,
            combined_output: "No steps to execute".to_string(),
            stopped_early: false,
            post_command_error: None,
        });
    }

    // Resolve the shell only when a real CLI step needs it (a phase of mocked
    // or script steps must not fail on missing credentials).
    let needs_ssh = phase_steps
        .iter()
        .any(|s| !s.mock_enabled && is_cli_step(s));
    let ssh_ctx = if needs_ssh {
        Some(resolve_device_ssh(state, device).await?)
    } else {
        None
    };
    let session = match device.session_id.as_deref() {
        Some(sid) => state.provider.get_session(sid).await.ok(),
        None => None,
    };
    let device = match session.as_ref() {
        Some(s) => refresh_device_identity(state, device, s).await?,
        None => device.clone(),
    };
    let runtime_vars = RuntimeVars::for_device(&device);
    let cli_flavor = device.cli_flavor.clone();
    // CLI commands with every `{{name}}` resolved, keyed by step id; a step
    // with unresolved placeholders is failed before the batch is sent.
    let resolve_cli = |step: &MopExecutionStep| -> Result<String, Vec<String>> {
        let command = resolve_runtime_vars(&step.command, &runtime_vars);
        let missing = unresolved_placeholders(&command);
        if missing.is_empty() {
            Ok(command)
        } else {
            Err(missing)
        }
    };

    // Device → running; execution.current_phase follows the phase being run.
    if let Some(status) = guard.interrupted_by().await? {
        return Err(invalid_state_error(format!(
            "execution {} is {}; phase not started",
            exec_id, status
        )));
    }
    let device_update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Running),
        started_at: Some(Some(chrono::Utc::now())),
        error_message: Some(None),
        ..Default::default()
    };
    state
        .provider
        .update_mop_execution_device(&device_id, device_update)
        .await?;
    let phase_update = UpdateMopExecution {
        current_phase: Some(Some(step_type.to_string())),
        ..Default::default()
    };
    if let Err(e) = state
        .provider
        .update_mop_execution(exec_id, phase_update)
        .await
    {
        tracing::warn!(
            "run_device_phase: failed to set current_phase on {}: {}",
            exec_id,
            e
        );
    }

    let mut tally = PhaseTally::default();
    let mut i = 0;
    while i < phase_steps.len() {
        let step = &phase_steps[i];

        // Nothing new is marked running or sent to the device once the
        // execution has moved on (abort flag / status re-read).
        if let Some(status) = guard.interrupted_by().await? {
            tally.interrupt(status);
            break;
        }

        if tally.stopped_early {
            let eval = StepEvaluation {
                status: StepExecutionStatus::Skipped,
                output: String::new(),
                error_message: Some("not run: an earlier step timed out".to_string()),
                assertion_results: None,
            };
            if !record_and_finalize(&guard, &mut tally, step, eval, "", chrono::Utc::now(), None)
                .await?
            {
                break;
            }
            i += 1;
            continue;
        }

        if step.mock_enabled {
            let now = chrono::Utc::now();
            let mock_out = step
                .mock_output
                .clone()
                .unwrap_or_else(|| "[MOCKED]".to_string());
            let eval = StepEvaluation {
                status: StepExecutionStatus::Mocked,
                output: mock_out,
                error_message: None,
                assertion_results: None,
            };
            let extra = UpdateMopExecutionStep {
                started_at: Some(Some(now)),
                ..Default::default()
            };
            if !record_and_finalize(
                &guard,
                &mut tally,
                step,
                eval,
                " [MOCKED]",
                now,
                Some(extra),
            )
            .await?
            {
                break;
            }
            i += 1;
            continue;
        }

        if is_cli_step(step) {
            if let Err(missing) = resolve_cli(step) {
                let step_start = mark_step_running(state.provider.as_ref(), &step.id).await?;
                let eval =
                    StepEvaluation::failed(String::new(), unresolved_variables_message(&missing));
                if !record_and_finalize(&guard, &mut tally, step, eval, "", step_start, None)
                    .await?
                {
                    break;
                }
                i += 1;
                continue;
            }
        }

        if step.execution_source == "quick_action" || step.step_type == MopStepType::ApiAction {
            let step_start = mark_step_running(state.provider.as_ref(), &step.id).await?;
            let action_id = step.quick_action_id.as_deref().unwrap_or(&step.command);
            let (output, status, resolved_vars) = match execute_quick_action_step(
                state.provider.as_ref(),
                action_id,
                &step.quick_action_variables,
                &runtime_vars,
                Some(&state.auth_cache),
            )
            .await
            {
                Ok(result) => result,
                Err(e) => (
                    format!("Quick action error: {}", e.error),
                    StepExecutionStatus::Failed,
                    std::collections::HashMap::new(),
                ),
            };
            let extra = UpdateMopExecutionStep {
                quick_action_variables: Some(Some(
                    serde_json::to_value(&resolved_vars).unwrap_or_default(),
                )),
                ..Default::default()
            };
            let eval = evaluate_generic_step(status, output, step.expected_output.as_deref());
            if !record_and_finalize(
                &guard,
                &mut tally,
                step,
                eval,
                " [Quick Action]",
                step_start,
                Some(extra),
            )
            .await?
            {
                break;
            }
            i += 1;
            continue;
        }

        if step.execution_source == "script" {
            let step_start = mark_step_running(state.provider.as_ref(), &step.id).await?;
            let script_id = step.script_id.as_deref().unwrap_or(&step.command);
            let (output, status, resolved_args) = match execute_script_step(
                state.provider.as_ref(),
                script_id,
                &step.script_args,
                &runtime_vars,
            )
            .await
            {
                Ok(result) => result,
                Err(e) => (
                    format!("Script error: {}", e.error),
                    StepExecutionStatus::Failed,
                    None,
                ),
            };
            let extra = UpdateMopExecutionStep {
                script_args: Some(resolved_args),
                ..Default::default()
            };
            let eval = evaluate_generic_step(status, output, step.expected_output.as_deref());
            if !record_and_finalize(
                &guard,
                &mut tally,
                step,
                eval,
                " [Script]",
                step_start,
                Some(extra),
            )
            .await?
            {
                break;
            }
            i += 1;
            continue;
        }

        // Contiguous CLI steps (with resolvable commands) → one shell batch.
        let mut j = i;
        let mut commands: Vec<(String, String)> = Vec::new();
        while j < phase_steps.len() && is_cli_step(&phase_steps[j]) && !phase_steps[j].mock_enabled
        {
            match resolve_cli(&phase_steps[j]) {
                Ok(command) => commands.push((phase_steps[j].id.clone(), command)),
                Err(_) => break,
            }
            j += 1;
        }
        let batch: Vec<&MopExecutionStep> = phase_steps[i..j].iter().collect();
        let (session, config, auto_commands) = ssh_ctx
            .as_ref()
            .map(|(s, c, a)| (s, c.clone(), a.clone()))
            .ok_or_else(|| validation_error("Device has no session_id"))?;

        let batch_start = chrono::Utc::now();
        for step in &batch {
            mark_step_running(state.provider.as_ref(), &step.id).await?;
        }
        let outcome = run_wrapped_cli_batch(
            config,
            session,
            auto_commands,
            cli_flavor.as_deref(),
            &step_type,
            &commands,
            timeout,
        )
        .await;

        let all_connection_errors = !outcome.step_results.is_empty()
            && outcome
                .step_results
                .iter()
                .all(|r| r.status == ssh::CommandStatus::Error && r.output.is_empty());
        let mut last_ran: Option<(String, StepEvaluation)> = None;
        for step in &batch {
            let result = outcome.step_results.iter().find(|r| r.step_id == step.id);
            let sent = commands
                .iter()
                .find(|(id, _)| *id == step.id)
                .map(|(_, c)| c.as_str())
                .unwrap_or(&step.command);
            let eval = match result {
                Some(r) => evaluate_cli_step(
                    r,
                    sent,
                    step.expected_output.as_deref(),
                    cli_flavor.as_deref(),
                    timeout,
                ),
                None => StepEvaluation::failed(String::new(), "No result returned"),
            };
            if let Some(r) = result {
                if matches!(
                    r.status,
                    ssh::CommandStatus::Timeout
                        | ssh::CommandStatus::AuthFailed
                        | ssh::CommandStatus::NotRun
                ) || all_connection_errors
                {
                    tally.stopped_early = true;
                }
            }
            let verdict = (eval.status != StepExecutionStatus::Skipped).then(|| eval.clone());
            if !record_and_finalize(&guard, &mut tally, step, eval, "", batch_start, None).await? {
                break;
            }
            if let Some(verdict) = verdict {
                last_ran = Some((step.id.clone(), verdict));
            }
        }
        tally.combined_output.push_str(&outcome.wrapper_output);
        tally.transcripts.push_str(&outcome.transcript);
        if tally.interrupted.is_some() {
            break;
        }

        // A failed commit / write memory fails the phase and the last step
        // that ran, so an unsaved change never reads as "passed".
        if let Some(post_err) = outcome.post_command_error {
            if tally.post_command_error.is_none() {
                tally.post_command_error = Some(post_err.clone());
            }
            if let Some((last_id, mut last_eval)) = last_ran {
                if let Some(status) = guard.interrupted_by().await? {
                    tally.interrupt(status);
                    break;
                }
                if last_eval.status != StepExecutionStatus::Failed {
                    tally.passed = tally.passed.saturating_sub(1);
                    tally.failed += 1;
                }
                last_eval.status = StepExecutionStatus::Failed;
                last_eval.error_message = Some(format!("config save failed: {}", post_err));
                if tally.first_error.is_none() {
                    tally.first_error = last_eval.error_message.clone();
                }
                let update = UpdateMopExecutionStep {
                    status: Some(StepExecutionStatus::Failed),
                    error_message: Some(last_eval.error_message.clone()),
                    ..Default::default()
                };
                state
                    .provider
                    .update_mop_execution_step(&last_id, update)
                    .await?;
            }
        }
        i = j;
    }

    // Device status from the results — unless the execution moved on, in
    // which case the cascade's row stands (a row still `running` is closed).
    if tally.interrupted.is_none() {
        if let Some(status) = guard.interrupted_by().await? {
            tally.interrupt(status);
        }
    }
    if let Some(status) = tally.interrupted.clone() {
        tracing::warn!(
            "run_device_phase: execution {} is {}; leaving device {} to the cascade",
            exec_id,
            status,
            device_id
        );
        close_interrupted_device(state.provider.as_ref(), &device_id, &status).await?;
        return Ok(PhaseExecutionResult {
            device_id,
            step_type: step_type.to_string(),
            steps_executed: tally.passed + tally.failed,
            steps_passed: tally.passed,
            steps_failed: tally.failed,
            steps_skipped: tally.skipped,
            snapshot_id: None,
            combined_output: tally.combined_output,
            stopped_early: true,
            post_command_error: tally.post_command_error,
        });
    }
    let device_failed = tally.failed > 0 || tally.post_command_error.is_some();
    let device_update = UpdateMopExecutionDevice {
        status: Some(if device_failed {
            DeviceExecutionStatus::Failed
        } else {
            DeviceExecutionStatus::Complete
        }),
        error_message: Some(if device_failed {
            tally
                .post_command_error
                .clone()
                .or_else(|| tally.first_error.clone())
        } else {
            None
        }),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    state
        .provider
        .update_mop_execution_device(&device_id, device_update)
        .await?;

    // Execution-owned snapshot for pre_check / post_check phases (NS-MOP-1);
    // skipped when the execution moved on between the two writes.
    let wants_snapshot = matches!(step_type, MopStepType::PreCheck | MopStepType::PostCheck);
    if wants_snapshot {
        if let Some(status) = guard.interrupted_by().await? {
            tally.interrupt(status);
        }
    }
    let snapshot_id = if wants_snapshot && tally.interrupted.is_none() {
        let is_pre = step_type == MopStepType::PreCheck;
        let snapshot = state
            .provider
            .create_snapshot(NewSnapshot {
                change_id: None,
                execution_id: Some(exec_id.to_string()),
                snapshot_type: if is_pre { "pre" } else { "post" }.to_string(),
                commands: tally.commands_run.clone(),
                output: if tally.transcripts.is_empty() {
                    tally.combined_output.clone()
                } else {
                    format!(
                        "{}{}{}",
                        tally.combined_output, SNAPSHOT_TRANSCRIPT_MARKER, tally.transcripts
                    )
                },
            })
            .await?;

        let snapshot_update = if is_pre {
            UpdateMopExecutionDevice {
                pre_snapshot_id: Some(Some(snapshot.id.clone())),
                ..Default::default()
            }
        } else {
            UpdateMopExecutionDevice {
                post_snapshot_id: Some(Some(snapshot.id.clone())),
                ..Default::default()
            }
        };
        state
            .provider
            .update_mop_execution_device(&device_id, snapshot_update)
            .await?;
        Some(snapshot.id)
    } else {
        None
    };

    Ok(PhaseExecutionResult {
        device_id,
        step_type: step_type.to_string(),
        steps_executed: tally.passed + tally.failed,
        steps_passed: tally.passed,
        steps_failed: tally.failed,
        steps_skipped: tally.skipped,
        snapshot_id,
        combined_output: tally.combined_output,
        stopped_early: tally.stopped_early,
        post_command_error: tally.post_command_error,
    })
}

/// Mark a step running (clearing a previous run's verdict) and return its start time.
async fn mark_step_running(
    provider: &dyn DataProvider,
    step_id: &str,
) -> Result<chrono::DateTime<chrono::Utc>, ApiError> {
    let now = chrono::Utc::now();
    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Running),
        started_at: Some(Some(now)),
        error_message: Some(None),
        assertion_results: Some(None),
        ..Default::default()
    };
    provider.update_mop_execution_step(step_id, update).await?;
    Ok(now)
}

/// Diff response between pre and post snapshots (same LCS diff as `POST /mop/diff`).
#[derive(Debug, Serialize)]
pub struct SnapshotDiff {
    pub device_id: String,
    pub pre_snapshot_id: Option<String>,
    pub post_snapshot_id: Option<String>,
    pub has_changes: bool,
    pub summary: String,
    /// Lines added or rewritten in post (what the UI renders as the diff).
    pub lines_added: Vec<String>,
    /// Lines removed or rewritten from pre.
    pub lines_removed: Vec<String>,
    /// Ordered LCS diff entries (`added` / `removed` / `changed`).
    pub changes: Vec<DiffChange>,
}

/// Get diff between pre and post snapshots for a device
pub async fn get_device_snapshot_diff(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<SnapshotDiff>, ApiError> {
    let device = load_execution_device(state.provider.as_ref(), &exec_id, &device_id).await?;

    let pre_output = match device.pre_snapshot_id.as_deref() {
        Some(id) => Some(state.provider.get_snapshot(id).await?.output),
        None => None,
    };
    let post_output = match device.post_snapshot_id.as_deref() {
        Some(id) => Some(state.provider.get_snapshot(id).await?.output),
        None => None,
    };

    let (changes, summary) = match (&pre_output, &post_output) {
        (Some(pre), Some(post)) => {
            let diff = mop_diff_text(snapshot_step_output(pre), snapshot_step_output(post));
            let summary = if diff.changes.is_empty() {
                "No changes detected between pre and post checks.".to_string()
            } else {
                format!(
                    "Changes detected: {} lines added, {} lines removed, {} lines changed",
                    diff.summary.added, diff.summary.removed, diff.summary.changed
                )
            };
            (diff.changes, summary)
        }
        (None, Some(_)) => (
            Vec::new(),
            "Post-check captured, no pre-check snapshot available.".to_string(),
        ),
        (Some(_), None) => (
            Vec::new(),
            "Pre-check captured, no post-check snapshot yet.".to_string(),
        ),
        (None, None) => (Vec::new(), "No snapshots captured yet.".to_string()),
    };

    let as_line = |v: &serde_json::Value| v.as_str().map(|s| s.to_string());
    let lines_added: Vec<String> = changes
        .iter()
        .filter(|c| c.change_type == "added" || c.change_type == "changed")
        .filter_map(|c| as_line(&c.new))
        .collect();
    let lines_removed: Vec<String> = changes
        .iter()
        .filter(|c| c.change_type == "removed" || c.change_type == "changed")
        .filter_map(|c| as_line(&c.old))
        .collect();

    Ok(Json(SnapshotDiff {
        device_id,
        pre_snapshot_id: device.pre_snapshot_id,
        post_snapshot_id: device.post_snapshot_id,
        has_changes: !changes.is_empty(),
        summary,
        lines_added,
        lines_removed,
        changes,
    }))
}

/// AI analysis request for MOP execution
#[derive(Debug, Deserialize, Default)]
pub struct MopAiAnalysisRequest {
    #[serde(default)]
    pub include_outputs: bool,
    #[serde(default)]
    pub include_diff: bool,
    /// Re-run the model even when a stored AI analysis exists.
    #[serde(default)]
    pub force: bool,
}

/// AI analysis response
#[derive(Debug, Serialize)]
pub struct MopAiAnalysisResponse {
    pub execution_id: String,
    pub analysis: String,
    pub recommendations: Vec<String>,
    /// "low" | "medium" | "high" | "critical" | "unknown"
    pub risk_level: String,
    /// "ai" | "rules"
    pub source: String,
    /// "<provider>/<model>" when `source == "ai"`.
    pub model: Option<String>,
    /// Why the result is rule-based / cached.
    pub warnings: Vec<String>,
}

/// Truncate to at most `max` bytes without splitting a UTF-8 character.
fn truncate_on_char_boundary(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    &text[..text.floor_char_boundary(max)]
}

/// Last `max` bytes of `text` (char-boundary safe).
fn tail_on_char_boundary(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    &text[text.ceil_char_boundary(text.len() - max)..]
}

// --- context (same caps as frontend `lib/mopAiContext.ts`) -----------------

/// Max bytes of one step's output kept (the tail).
const MOP_ANALYSIS_STEP_OUTPUT_TAIL: usize = 4096;
/// Max bytes of step output across the whole context.
const MOP_ANALYSIS_TOTAL_OUTPUT: usize = 32 * 1024;
/// Max diff lines rendered per device.
const MOP_ANALYSIS_DIFF_LINES: usize = 40;

/// Human platform name for a `cli_flavor` wire string (mirrors the frontend
/// `CLI_FLAVOR_META`); `None` for `auto` / unknown.
fn cli_flavor_display_name(flavor: Option<&str>) -> Option<&'static str> {
    match flavor.map(str::trim).unwrap_or("") {
        "cisco-ios" => Some("Cisco IOS/IOS-XE"),
        "cisco-ios-xr" => Some("Cisco IOS-XR"),
        "cisco-nxos" => Some("Cisco NX-OS"),
        "juniper" => Some("Juniper Junos"),
        "arista" => Some("Arista EOS"),
        "paloalto" => Some("Palo Alto PAN-OS"),
        "fortinet" => Some("Fortinet FortiOS"),
        "linux" => Some("Linux"),
        _ => None,
    }
}

/// Pre/post snapshot diff of one device, reduced for the prompt.
struct MopAnalysisDeviceDiff {
    added: usize,
    removed: usize,
    changed: usize,
    /// `+ …` / `- …` lines, at most `MOP_ANALYSIS_DIFF_LINES`.
    lines: Vec<String>,
}

struct MopAnalysisDevice {
    device: MopExecutionDevice,
    /// Sorted by step_order.
    steps: Vec<MopExecutionStep>,
    diff: Option<MopAnalysisDeviceDiff>,
}

/// Everything the analysis (AI or rule-based) looks at, loaded once.
struct MopAnalysisData {
    execution: MopExecution,
    plan: Option<Change>,
    /// In device_order.
    devices: Vec<MopAnalysisDevice>,
}

async fn load_mop_analysis_data(
    provider: &dyn DataProvider,
    exec_id: &str,
    include_diff: bool,
) -> Result<MopAnalysisData, ApiError> {
    let execution = provider.get_mop_execution(exec_id).await?;
    let plan = match execution.plan_id.as_deref() {
        Some(plan_id) => provider.get_change(plan_id).await.ok(),
        None => None,
    };
    let mut devices = Vec::new();
    for device in provider.list_mop_execution_devices(exec_id).await? {
        let mut steps = provider.list_mop_execution_steps(&device.id).await?;
        steps.sort_by_key(|s| s.step_order);
        let mut diff = None;
        if include_diff {
            if let (Some(pre_id), Some(post_id)) =
                (&device.pre_snapshot_id, &device.post_snapshot_id)
            {
                if let (Ok(pre), Ok(post)) = (
                    provider.get_snapshot(pre_id).await,
                    provider.get_snapshot(post_id).await,
                ) {
                    let d = mop_diff_text(
                        snapshot_step_output(&pre.output),
                        snapshot_step_output(&post.output),
                    );
                    let mut lines = Vec::new();
                    for c in &d.changes {
                        if lines.len() >= MOP_ANALYSIS_DIFF_LINES {
                            break;
                        }
                        if c.change_type == "removed" || c.change_type == "changed" {
                            if let Some(l) = c.old.as_str() {
                                lines.push(format!("- {}", l));
                            }
                        }
                        if lines.len() < MOP_ANALYSIS_DIFF_LINES
                            && (c.change_type == "added" || c.change_type == "changed")
                        {
                            if let Some(l) = c.new.as_str() {
                                lines.push(format!("+ {}", l));
                            }
                        }
                    }
                    diff = Some(MopAnalysisDeviceDiff {
                        added: d.summary.added,
                        removed: d.summary.removed,
                        changed: d.summary.changed,
                        lines,
                    });
                }
            }
        }
        devices.push(MopAnalysisDevice {
            device,
            steps,
            diff,
        });
    }
    Ok(MopAnalysisData {
        execution,
        plan,
        devices,
    })
}

/// Distinct platform names across the execution's devices (sorted).
fn mop_analysis_platforms(data: &MopAnalysisData) -> Vec<&'static str> {
    let mut names: Vec<&'static str> = data
        .devices
        .iter()
        .filter_map(|d| cli_flavor_display_name(d.device.cli_flavor.as_deref()))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Render the execution for the reviewer prompt. Deterministic for the same
/// data; step output is capped per step and in total.
fn build_mop_analysis_context(data: &MopAnalysisData, include_outputs: bool) -> String {
    let mut out = String::new();
    let exec = &data.execution;
    out.push_str(&format!("# MOP execution: {}\n", exec.name));
    out.push_str(&format!(
        "status: {} | strategy: {} | control mode: {} | on_failure: {}\n",
        exec.status, exec.execution_strategy, exec.control_mode, exec.on_failure
    ));
    if let Some(desc) = exec.description.as_deref().filter(|d| !d.trim().is_empty()) {
        out.push_str(&format!("description: {}\n", desc.trim()));
    }
    if let Some(plan) = &data.plan {
        out.push_str(&format!("\n## Plan: {}\n", plan.name));
        if let Some(desc) = plan.description.as_deref().filter(|d| !d.trim().is_empty()) {
            out.push_str(&format!("{}\n", desc.trim()));
        }
        if let Some(risk) = plan.risk_level.as_deref() {
            out.push_str(&format!("declared risk: {}\n", risk));
        }
        if let Some(ticket) = plan.change_ticket.as_deref() {
            out.push_str(&format!("change ticket: {}\n", ticket));
        }
    }
    let platforms = mop_analysis_platforms(data);
    if !platforms.is_empty() {
        out.push_str(&format!("\nPlatforms: {}\n", platforms.join(", ")));
    }

    let mut budget = MOP_ANALYSIS_TOTAL_OUTPUT;
    let mut mocked = 0usize;
    for entry in &data.devices {
        let d = &entry.device;
        let platform =
            cli_flavor_display_name(d.cli_flavor.as_deref()).unwrap_or("unknown platform");
        out.push_str(&format!(
            "\n## Device: {} ({}) — {} — status: {}\n",
            d.device_name, d.device_host, platform, d.status
        ));
        if let Some(err) = d.error_message.as_deref().filter(|e| !e.trim().is_empty()) {
            out.push_str(&format!("device error: {}\n", err.trim()));
        }
        if let Some(vars) = d.variables.as_ref().filter(|v| !v.is_empty()) {
            let mut names: Vec<&String> = vars.keys().collect();
            names.sort();
            let rendered: Vec<String> = names
                .iter()
                .map(|n| format!("{}={}", n, vars[*n]))
                .collect();
            out.push_str(&format!("variables: {}\n", rendered.join(", ")));
        }
        for step in &entry.steps {
            if step.mock_enabled || step.status == StepExecutionStatus::Mocked {
                mocked += 1;
            }
            out.push_str(&format!(
                "- [{}] #{} `{}` → {}{}\n",
                step.step_type,
                step.step_order,
                step.command,
                step.status,
                if step.mock_enabled || step.status == StepExecutionStatus::Mocked {
                    " (MOCKED)"
                } else {
                    ""
                }
            ));
            if let Some(err) = step
                .error_message
                .as_deref()
                .filter(|e| !e.trim().is_empty())
            {
                out.push_str(&format!("  error: {}\n", err.trim()));
            }
            if let Some(results) = step.assertion_results.as_ref().filter(|r| !r.is_empty()) {
                for r in results {
                    out.push_str(&format!(
                        // "[PASS]" rather than "PASS:" — the sanitizer's generic
                        // password rule treats "pass:" as a credential prefix.
                        "  assertion [{}] {} ({})",
                        if r.passed { "PASS" } else { "FAIL" },
                        r.assertion,
                        r.detail
                    ));
                    out.push('\n');
                }
            }
            if include_outputs {
                if let Some(raw) = step
                    .output
                    .as_deref()
                    .map(str::trim)
                    .filter(|o| !o.is_empty())
                {
                    if budget == 0 {
                        out.push_str("  output: [omitted — context budget exhausted]\n");
                        continue;
                    }
                    let tail =
                        tail_on_char_boundary(raw, MOP_ANALYSIS_STEP_OUTPUT_TAIL.min(budget));
                    budget -= tail.len();
                    let note = if tail.len() < raw.len() {
                        " (tail)"
                    } else {
                        ""
                    };
                    out.push_str(&format!("  output{}:\n```\n{}\n```\n", note, tail));
                }
            }
        }
        if let Some(diff) = &entry.diff {
            out.push_str(&format!(
                "pre/post diff: {} added, {} removed, {} changed\n",
                diff.added, diff.removed, diff.changed
            ));
            if !diff.lines.is_empty() {
                out.push_str("```diff\n");
                for l in &diff.lines {
                    out.push_str(l);
                    out.push('\n');
                }
                out.push_str("```\n");
            }
        }
    }
    if mocked > 0 {
        out.push_str(&format!(
            "\nNOTE: {} step(s) were mocked — their output is fabricated test data, not device state.\n",
            mocked
        ));
    }
    out
}

/// Reviewer instructions + the JSON contract the reply must follow.
fn build_mop_analysis_system_prompt(data: &MopAnalysisData) -> String {
    let platforms = mop_analysis_platforms(data);
    let platform_line = if platforms.is_empty() {
        "The device platforms are not recorded; infer them from the command syntax and say so."
            .to_string()
    } else {
        format!(
            "Platforms in scope: {}. Interpret every command output with that platform's CLI conventions \
             (error markers, prompt modes, commit/save semantics, show-command formats).",
            platforms.join(", ")
        )
    };
    format!(
        "You are a senior (CCIE-level) network engineer reviewing the recorded results of a Method of Procedure (MOP) execution.\n\
         {platform_line}\n\
         Assess: did the change achieve its intent; do the pre-check and post-check outputs agree with the expected state; \
         are the recorded failures real device errors, assertion misses or transport problems; what must be verified, fixed or rolled back before sign-off. \
         Treat mocked steps as unverified. Be specific and cite device names and commands.\n\
         Reply with ONLY a JSON object of this shape, no prose or markdown outside it:\n\
         {{\"analysis\": \"<markdown review>\", \"recommendations\": [\"<action>\", ...], \"risk_level\": \"low|medium|high|critical|unknown\"}}"
    )
}

/// `stripAiCodeFences` + `extractAiJsonObject` from the frontend: drop
/// ``` fences and take the outermost `{…}` span.
fn extract_ai_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

fn strip_ai_code_fences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            // Keep anything after the fence marker + language tag on the same line.
            let rest = trimmed.trim_start_matches('`');
            let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
            if !rest.trim().is_empty() {
                out.push_str(rest);
                out.push('\n');
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

fn normalize_risk_level(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    match lower.as_str() {
        "low" | "medium" | "high" | "critical" | "unknown" => lower,
        _ => "unknown".to_string(),
    }
}

/// Parse the model's reply; unparsable text becomes the analysis itself
/// with `risk_level = "unknown"`.
fn parse_mop_analysis_reply(raw: &str) -> (String, Vec<String>, String) {
    let cleaned = strip_ai_code_fences(raw);
    let parsed = extract_ai_json_object(&cleaned)
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok());
    let Some(obj) = parsed.as_ref().and_then(|v| v.as_object()) else {
        return (raw.trim().to_string(), Vec::new(), "unknown".to_string());
    };
    let analysis = match obj.get("analysis") {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(other) if !other.is_null() => other.to_string(),
        _ => raw.trim().to_string(),
    };
    let recommendations = obj
        .get("recommendations")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| match v {
                    serde_json::Value::String(s) => Some(s.trim().to_string()),
                    serde_json::Value::Null => None,
                    other => Some(other.to_string()),
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let risk_level = obj
        .get("risk_level")
        .and_then(|v| v.as_str())
        .map(normalize_risk_level)
        .unwrap_or_else(|| "unknown".to_string());
    (analysis, recommendations, risk_level)
}

/// Summarise the execution from the recorded device / step statuses: risk
/// follows the failure counts and nothing is reported as successful while
/// devices are still pending.
fn rule_based_mop_analysis(
    data: &MopAnalysisData,
    include_outputs: bool,
) -> (String, Vec<String>, String) {
    let execution = &data.execution;
    let mut complete = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut unfinished = 0usize;
    let mut failed_steps = 0usize;
    let mut pending_steps = 0usize;
    let mut recommendations = Vec::new();
    let mut details = Vec::new();

    for entry in &data.devices {
        let device = &entry.device;
        match device.status {
            DeviceExecutionStatus::Complete => complete += 1,
            DeviceExecutionStatus::Failed => failed += 1,
            DeviceExecutionStatus::Skipped => skipped += 1,
            DeviceExecutionStatus::Pending
            | DeviceExecutionStatus::Running
            | DeviceExecutionStatus::Waiting => unfinished += 1,
        }
        if device.status == DeviceExecutionStatus::Failed {
            match &device.error_message {
                Some(err) => recommendations.push(format!(
                    "Review failed device {}: {}",
                    device.device_name, err
                )),
                None => {
                    recommendations.push(format!("Review failed device {}", device.device_name))
                }
            }
        }

        for step in &entry.steps {
            match step.status {
                StepExecutionStatus::Failed => {
                    failed_steps += 1;
                    let mut line = format!(
                        "{} · {} step {} `{}` failed",
                        device.device_name, step.step_type, step.step_order, step.command
                    );
                    if let Some(err) = &step.error_message {
                        line.push_str(&format!(": {}", err));
                    }
                    if include_outputs {
                        if let Some(out) = step.output.as_deref().filter(|o| !o.trim().is_empty()) {
                            line.push_str(&format!(
                                "\n    output: {}",
                                truncate_on_char_boundary(out.trim(), 500)
                            ));
                        }
                    }
                    details.push(line);
                }
                StepExecutionStatus::Pending | StepExecutionStatus::Running => pending_steps += 1,
                _ => {}
            }
        }

        if let Some(diff) = &entry.diff {
            details.push(format!(
                "{} · pre/post diff: {} added, {} removed, {} changed",
                device.device_name, diff.added, diff.removed, diff.changed
            ));
        }
    }

    if unfinished > 0 {
        recommendations.push(format!(
            "{} device(s) have not finished; do not sign off yet.",
            unfinished
        ));
    }
    if pending_steps > 0 {
        recommendations.push(format!(
            "{} step(s) are still pending or running.",
            pending_steps
        ));
    }
    if data.devices.is_empty() {
        recommendations.push("No devices are attached to this execution.".to_string());
    } else if recommendations.is_empty() {
        recommendations.push("All devices finished without recorded failures.".to_string());
    }

    let risk_level = if failed > 0 || failed_steps > 0 {
        "high"
    } else if unfinished > 0 || pending_steps > 0 || execution.status == ExecutionStatus::Aborted {
        "medium"
    } else if data.devices.is_empty() {
        "unknown"
    } else {
        "low"
    }
    .to_string();

    let mut analysis = format!(
        "MOP execution '{}' is {}: {} of {} device(s) complete, {} failed, {} skipped, {} not finished; {} failed step(s).",
        execution.name,
        execution.status,
        complete,
        data.devices.len(),
        failed,
        skipped,
        unfinished,
        failed_steps
    );
    if !details.is_empty() {
        analysis.push('\n');
        analysis.push_str(&details.join("\n"));
    }
    analysis.push_str("\n(Rule-based summary from recorded statuses — not an AI review.)");
    (analysis, recommendations, risk_level)
}

/// The model `/analyze` will call, or why it cannot.
enum MopAnalysisModel {
    Ready {
        provider: Box<dyn ai::providers::AiProvider>,
        /// "<provider>/<model>" label stored with the analysis.
        model: String,
        profile: Option<Box<ai::profile::AiEngineerProfile>>,
    },
    Unavailable(String),
}

/// "anthropic/claude-…" style label for the stored analysis meta.
fn ai_config_model_label(config: &ai::providers::AiProviderConfig) -> String {
    use ai::providers::AiProviderConfig as C;
    match config {
        C::Anthropic { model, .. } => format!("anthropic/{}", model),
        C::OpenAI { model, .. } => format!("openai/{}", model),
        C::Ollama { model, .. } => format!("ollama/{}", model),
        C::OpenRouter { model, .. } => format!("openrouter/{}", model),
        C::LiteLLM { model, .. } => format!("litellm/{}", model),
        C::Custom { model, .. } => format!("custom/{}", model),
    }
}

/// Same wiring as the background agent (`tasks/react.rs`): saved settings →
/// provider → sanitizer wrapper; the engineer profile is loaded like
/// `ai/chat.rs` does.
async fn load_mop_analysis_model(state: &AppState) -> MopAnalysisModel {
    let config = match ai::chat::load_ai_config(state.provider.as_ref(), None, None)
        .await
        .0
    {
        Ok(cfg) => cfg,
        Err(reason) => return MopAnalysisModel::Unavailable(reason),
    };
    let model = ai_config_model_label(&config);
    let raw = ai::providers::create_provider(Some(config));
    let provider: Box<dyn ai::providers::AiProvider> =
        Box::new(ai::sanitizer::SanitizingProvider::new(
            raw,
            state.sanitizer.clone(),
            state.provider.clone(),
        ));
    let profile = crate::db::ai_profile::get_profile(&state.pool)
        .await
        .ok()
        .flatten()
        .map(Box::new);
    MopAnalysisModel::Ready {
        provider,
        model,
        profile,
    }
}

/// One line, bounded, for the `warnings` array.
fn sanitise_ai_error(err: &ai::providers::AiError) -> String {
    let text = match err {
        ai::providers::AiError::NotConfigured(_) => "AI provider not configured".to_string(),
        other => other.to_string(),
    };
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_on_char_boundary(&one_line, 300).to_string()
}

/// `/analyze` without the HTTP layer: AI review when a model is available,
/// rule-based summary otherwise (never an error because the AI is
/// unavailable), cached per execution unless `force`.
async fn analyze_mop_execution_with(
    provider: &dyn DataProvider,
    model: MopAnalysisModel,
    exec_id: &str,
    req: &MopAiAnalysisRequest,
) -> Result<MopAiAnalysisResponse, ApiError> {
    let execution = provider.get_mop_execution(exec_id).await?;

    // Cached AI review: return it without calling the model.
    if !req.force {
        if let Some(meta) = execution
            .ai_analysis_meta
            .as_ref()
            .filter(|m| m.source == "ai")
        {
            if let Some(stored) = execution
                .ai_analysis
                .as_deref()
                .filter(|a| !a.trim().is_empty())
            {
                return Ok(MopAiAnalysisResponse {
                    execution_id: exec_id.to_string(),
                    analysis: stored.to_string(),
                    recommendations: meta.recommendations.clone(),
                    risk_level: meta.risk_level.clone(),
                    source: "ai".to_string(),
                    model: meta.model.clone(),
                    warnings: vec!["cached".to_string()],
                });
            }
        }
    }

    let data = load_mop_analysis_data(provider, exec_id, req.include_diff).await?;
    let mut warnings: Vec<String> = Vec::new();
    let mut ai_result: Option<(String, Vec<String>, String, String)> = None;

    match model {
        MopAnalysisModel::Ready {
            provider: ai_provider,
            model,
            profile,
        } => {
            let messages = vec![
                ai::providers::ChatMessage {
                    role: "system".to_string(),
                    content: build_mop_analysis_system_prompt(&data),
                },
                ai::providers::ChatMessage {
                    role: "user".to_string(),
                    content: build_mop_analysis_context(&data, req.include_outputs),
                },
            ];
            let context = ai::providers::AiContext {
                session_name: Some(format!("MOP: {}", data.execution.name)),
                ai_profile: profile.map(|p| *p),
                feature: ai::profile::AiFeature::Chat,
                ..Default::default()
            };
            match ai_provider.chat_completion(messages, Some(context)).await {
                Ok(reply) => {
                    let (analysis, recommendations, risk_level) = parse_mop_analysis_reply(&reply);
                    ai_result = Some((analysis, recommendations, risk_level, model));
                }
                Err(e) => {
                    tracing::warn!(
                        "analyze_mop_execution {}: AI call failed, using rule-based summary: {}",
                        exec_id,
                        e
                    );
                    warnings.push(sanitise_ai_error(&e));
                }
            }
        }
        MopAnalysisModel::Unavailable(reason) => warnings.push(reason),
    }

    let (analysis, recommendations, risk_level, source, model) = match ai_result {
        Some((analysis, recommendations, risk_level, model)) => (
            analysis,
            recommendations,
            risk_level,
            "ai".to_string(),
            Some(model),
        ),
        None => {
            let (analysis, recommendations, risk_level) =
                rule_based_mop_analysis(&data, req.include_outputs);
            (
                analysis,
                recommendations,
                risk_level,
                "rules".to_string(),
                None,
            )
        }
    };

    // Persist: an AI review always; the rule-based text only fills an empty
    // slot (never clobbers a real analysis).
    let stored_empty = data
        .execution
        .ai_analysis
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty();
    if source == "ai" || stored_empty {
        let meta = MopAnalysisMeta {
            risk_level: risk_level.clone(),
            recommendations: recommendations.clone(),
            source: source.clone(),
            model: model.clone(),
            analyzed_at: chrono::Utc::now(),
        };
        let update = UpdateMopExecution {
            ai_analysis: Some(Some(analysis.clone())),
            ai_analysis_meta: Some(Some(meta)),
            ..Default::default()
        };
        provider.update_mop_execution(exec_id, update).await?;
    }

    Ok(MopAiAnalysisResponse {
        execution_id: exec_id.to_string(),
        analysis,
        recommendations,
        risk_level,
        source,
        model,
        warnings,
    })
}

/// `POST /mop-executions/:id/analyze` — AI review of the recorded results
/// (context built server-side from the DB), falling back to the rule-based
/// summary with `source: "rules"` when no model is configured or the call
/// fails. Cached in `mop_executions.ai_analysis(_meta)` unless `force`.
pub async fn analyze_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(exec_id): Path<String>,
    body: Option<Json<MopAiAnalysisRequest>>,
) -> Result<Json<MopAiAnalysisResponse>, ApiError> {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let model = load_mop_analysis_model(&state).await;
    let response =
        analyze_mop_execution_with(state.provider.as_ref(), model, &exec_id, &req).await?;
    Ok(Json(response))
}

// === SNMP Endpoints ===

/// Optional jump-host fields shared by every SNMP request type. Setting
/// either field routes the SNMP query through that jump (running net-snmp
/// CLI tools on the bastion) instead of going direct over UDP. Mutually
/// exclusive — set at most one. See `build_snmp_dest`.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnmpJumpRef {
    #[serde(default)]
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub jump_session_id: Option<String>,
}

/// SNMP GET request body
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpGetRequest {
    pub host: String,
    pub port: Option<u16>,
    pub community: String,
    pub oids: Vec<String>,
    #[serde(default, flatten)]
    pub jump: SnmpJumpRef,
    // Optional. When the request omits jump fields, the named profile's
    // jump configuration is the fallback (mirrors `try-communities`).
    #[serde(default)]
    pub profile_id: Option<String>,
}

/// SNMP WALK request body
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpWalkRequest {
    pub host: String,
    pub port: Option<u16>,
    pub community: String,
    pub root_oid: String,
    #[serde(default, flatten)]
    pub jump: SnmpJumpRef,
    #[serde(default)]
    pub profile_id: Option<String>,
}

/// SNMP try-communities request body
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpTryCommunityRequest {
    pub host: String,
    pub port: Option<u16>,
    pub profile_id: String,
    #[serde(default, flatten)]
    pub jump: SnmpJumpRef,
}

/// SNMP GET response (wraps SnmpValueEntry list)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpGetApiResponse {
    pub values: Vec<crate::snmp::SnmpValueEntry>,
}

/// SNMP WALK response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpWalkApiResponse {
    pub entries: Vec<crate::snmp::SnmpValueEntry>,
    pub root_oid: String,
}

/// SNMP try-communities response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpTryCommunityApiResponse {
    pub community: String,
    pub sys_name: String,
}

/// Map SnmpError to ApiError with appropriate HTTP status codes
fn snmp_error_to_api_error(err: crate::snmp::SnmpError) -> ApiError {
    use crate::snmp::SnmpError;
    match &err {
        SnmpError::Timeout(_) => ApiError {
            error: err.to_string(),
            code: "SNMP_TIMEOUT".to_string(),
        },
        SnmpError::ConnectionFailed { .. } => ApiError {
            error: err.to_string(),
            code: "SNMP_CONNECTION_FAILED".to_string(),
        },
        SnmpError::AuthError => ApiError {
            error: "SNMP authentication failed".to_string(),
            code: "SNMP_AUTH_ERROR".to_string(),
        },
        SnmpError::InvalidOid(_) => ApiError {
            error: err.to_string(),
            code: "VALIDATION".to_string(),
        },
        SnmpError::NoSuchObject(oid) => ApiError {
            error: format!("No such object at OID {}", oid),
            code: "NOT_FOUND".to_string(),
        },
        SnmpError::NoSuchInstance(oid) => ApiError {
            error: format!("No such instance at OID {}", oid),
            code: "NOT_FOUND".to_string(),
        },
        SnmpError::InterfaceNotFound(msg) => ApiError {
            error: msg.clone(),
            code: "INTERFACE_NOT_FOUND".to_string(),
        },
        _ => ApiError {
            error: err.to_string(),
            code: "SNMP_ERROR".to_string(),
        },
    }
}

/// HTTP-layer wrapper around [`crate::snmp::dest::snmp_dest_for`] that
/// validates request-level jump fields and maps the domain `String` error
/// to a `400 Bad Request`.
async fn build_snmp_dest(
    state: &Arc<AppState>,
    host: &str,
    port: u16,
    jump: &SnmpJumpRef,
    profile_id: Option<&str>,
) -> Result<crate::snmp::SnmpDest, Response> {
    if jump.jump_host_id.is_some() && jump.jump_session_id.is_some() {
        let api_err = ApiError {
            error: "jump_host_id and jump_session_id are mutually exclusive — set at most one"
                .into(),
            code: "VALIDATION".into(),
        };
        return Err((StatusCode::BAD_REQUEST, Json(api_err)).into_response());
    }

    let session_level = crate::ws::JumpRef::from_pair(
        jump.jump_host_id.as_deref(),
        jump.jump_session_id.as_deref(),
    );

    crate::snmp::dest::snmp_dest_for(&state.provider, host, port, session_level, profile_id)
        .await
        .map_err(|e| {
            let api_err = ApiError {
                error: e,
                code: "VALIDATION".into(),
            };
            (StatusCode::BAD_REQUEST, Json(api_err)).into_response()
        })
}

/// Custom IntoResponse for SNMP ApiError that maps codes to HTTP status
impl ApiError {
    fn snmp_status(&self) -> StatusCode {
        match self.code.as_str() {
            "SNMP_TIMEOUT" => StatusCode::GATEWAY_TIMEOUT,
            "SNMP_CONNECTION_FAILED" => StatusCode::BAD_GATEWAY,
            "SNMP_AUTH_ERROR" => StatusCode::UNAUTHORIZED,
            "INTERFACE_NOT_FOUND" => StatusCode::UNPROCESSABLE_ENTITY,
            _ => match self.code.as_str() {
                "NOT_FOUND" => StatusCode::NOT_FOUND,
                "VALIDATION" => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
        }
    }
}

/// SNMP GET endpoint - query one or more OIDs from a device
///
/// POST /api/snmp/get
pub async fn snmp_get(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SnmpGetRequest>,
) -> Result<Json<SnmpGetApiResponse>, Response> {
    let port = req.port.unwrap_or(161);

    tracing::info!("SNMP GET {}:{} OIDs: {:?}", req.host, port, req.oids);

    let oid_refs: Vec<&str> = req.oids.iter().map(|s| s.as_str()).collect();
    let dest = build_snmp_dest(
        &state,
        req.host.as_str(),
        port,
        &req.jump,
        req.profile_id.as_deref(),
    )
    .await?;
    let values = crate::snmp::snmp_get(&dest, &req.community, &oid_refs)
        .await
        .map_err(|e| {
            let api_err = snmp_error_to_api_error(e);
            let status = api_err.snmp_status();
            (status, Json(api_err)).into_response()
        })?;

    Ok(Json(SnmpGetApiResponse { values }))
}

/// SNMP WALK endpoint - walk a subtree on a device
///
/// POST /api/snmp/walk
pub async fn snmp_walk(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SnmpWalkRequest>,
) -> Result<Json<SnmpWalkApiResponse>, Response> {
    let port = req.port.unwrap_or(161);

    tracing::info!("SNMP WALK {}:{} root: {}", req.host, port, req.root_oid);

    let dest = build_snmp_dest(
        &state,
        req.host.as_str(),
        port,
        &req.jump,
        req.profile_id.as_deref(),
    )
    .await?;
    let walk_results = crate::snmp::snmp_walk(&dest, &req.community, &req.root_oid)
        .await
        .map_err(|e| {
            let api_err = snmp_error_to_api_error(e);
            let status = api_err.snmp_status();
            (status, Json(api_err)).into_response()
        })?;

    // Convert (String, SnmpValue) tuples to SnmpValueEntry structs
    let entries: Vec<crate::snmp::SnmpValueEntry> = walk_results
        .into_iter()
        .map(|(oid, value)| {
            let value_type = match &value {
                crate::snmp::SnmpValue::Integer(_) => "Integer",
                crate::snmp::SnmpValue::String(_) => "OctetString",
                crate::snmp::SnmpValue::OctetString(_) => "OctetString",
                crate::snmp::SnmpValue::Counter32(_) => "Counter32",
                crate::snmp::SnmpValue::Counter64(_) => "Counter64",
                crate::snmp::SnmpValue::Gauge32(_) => "Gauge32",
                crate::snmp::SnmpValue::TimeTicks(_) => "TimeTicks",
                crate::snmp::SnmpValue::IpAddress(_) => "IpAddress",
                crate::snmp::SnmpValue::ObjectId(_) => "ObjectIdentifier",
                crate::snmp::SnmpValue::Boolean(_) => "Boolean",
                crate::snmp::SnmpValue::Null => "Null",
                crate::snmp::SnmpValue::EndOfMibView => "EndOfMibView",
                crate::snmp::SnmpValue::NoSuchObject => "NoSuchObject",
                crate::snmp::SnmpValue::NoSuchInstance => "NoSuchInstance",
                crate::snmp::SnmpValue::Unknown(_) => "Unknown",
            }
            .to_string();
            crate::snmp::SnmpValueEntry {
                oid,
                value,
                value_type,
            }
        })
        .collect();

    Ok(Json(SnmpWalkApiResponse {
        entries,
        root_oid: req.root_oid,
    }))
}

/// SNMP try-communities endpoint - find working community string from profile vault
///
/// POST /api/snmp/try-communities
pub async fn snmp_try_communities(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SnmpTryCommunityRequest>,
) -> Result<Json<SnmpTryCommunityApiResponse>, Response> {
    let port = req.port.unwrap_or(161);

    tracing::info!(
        "SNMP try-communities {}:{} profile: {}",
        req.host,
        port,
        req.profile_id
    );

    let mut communities: Vec<String> = Vec::new();

    // Only the requested profile is consulted. A locked vault is a 403 the UI
    // can act on, not "no communities".
    let profile_cred = state
        .provider
        .get_profile_credential(&req.profile_id)
        .await
        .map_err(|e| ApiError::from(e).into_response())?;
    if let Some(cred) = profile_cred {
        if let Some(ref comms) = cred.snmp_communities {
            if !comms.is_empty() {
                communities = comms.clone();
            }
        }
    }

    if communities.is_empty() {
        // Do NOT fall back to other profiles' communities: that sent a
        // customer/site community string to an unrelated device and made
        // discovery "work" with credentials the engineer never chose (NS-AGENT-3).
        let api_err = ApiError {
            error: format!(
                "Profile {} has no SNMP communities configured. Add one under Profiles → SNMP.",
                req.profile_id
            ),
            code: "VALIDATION".to_string(),
        };
        return Err((StatusCode::BAD_REQUEST, Json(api_err)).into_response());
    }

    let dest = build_snmp_dest(
        &state,
        req.host.as_str(),
        port,
        &req.jump,
        Some(&req.profile_id),
    )
    .await?;
    let result = crate::snmp::try_communities(&dest, &communities)
        .await
        .map_err(|e| {
            let api_err = snmp_error_to_api_error(e);
            let status = api_err.snmp_status();
            (status, Json(api_err)).into_response()
        })?;

    Ok(Json(SnmpTryCommunityApiResponse {
        community: result.community,
        sys_name: result.sys_name,
    }))
}

// === SNMP Interface Stats Endpoints ===

/// SNMP interface stats request body (with explicit community)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpInterfaceStatsRequest {
    pub host: String,
    pub port: Option<u16>,
    pub community: String,
    pub interface_name: String,
    #[serde(default, flatten)]
    pub jump: SnmpJumpRef,
    #[serde(default)]
    pub profile_id: Option<String>,
}

/// SNMP interface stats request body (using profile vault for community)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpTryInterfaceStatsRequest {
    pub host: String,
    pub port: Option<u16>,
    pub profile_id: String,
    pub interface_name: String,
    #[serde(default, flatten)]
    pub jump: SnmpJumpRef,
}

/// SNMP interface stats response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpInterfaceStatsResponse {
    pub if_index: u64,
    pub if_descr: String,
    pub if_alias: String,
    pub oper_status: u8,
    pub oper_status_text: String,
    pub admin_status: u8,
    pub admin_status_text: String,
    pub if_type: u64,
    pub if_type_text: String,
    pub mtu: u64,
    pub phys_address: String,
    pub last_change: u64,
    pub speed_mbps: u64,
    pub in_octets: u64,
    pub out_octets: u64,
    pub in_errors: u64,
    pub out_errors: u64,
    pub in_discards: u64,
    pub out_discards: u64,
    pub in_ucast_pkts: u64,
    pub out_ucast_pkts: u64,
    pub in_multicast_pkts: u64,
    pub out_multicast_pkts: u64,
    pub in_broadcast_pkts: u64,
    pub out_broadcast_pkts: u64,
    pub hc_counters: bool,
}

/// Map IANA ifType integer to readable name
fn if_type_to_string(if_type: u64) -> String {
    match if_type {
        1 => "other".to_string(),
        6 => "ethernetCsmacd".to_string(),
        24 => "softwareLoopback".to_string(),
        53 => "propVirtual".to_string(),
        131 => "tunnel".to_string(),
        135 => "l2vlan".to_string(),
        136 => "l3ipvlan".to_string(),
        161 => "ieee8023adLag".to_string(),
        n => format!("ifType({})", n),
    }
}

/// Convert InterfaceStats to API response with status text
fn interface_stats_to_response(stats: crate::snmp::InterfaceStats) -> SnmpInterfaceStatsResponse {
    let oper_status_text = match stats.oper_status {
        1 => "up".to_string(),
        2 => "down".to_string(),
        3 => "testing".to_string(),
        n => format!("unknown({})", n),
    };
    let admin_status_text = match stats.admin_status {
        1 => "up".to_string(),
        2 => "down".to_string(),
        3 => "testing".to_string(),
        n => format!("unknown({})", n),
    };
    let if_type_text = if_type_to_string(stats.if_type);
    SnmpInterfaceStatsResponse {
        if_index: stats.if_index,
        if_descr: stats.if_descr,
        if_alias: stats.if_alias,
        oper_status: stats.oper_status,
        oper_status_text,
        admin_status: stats.admin_status,
        admin_status_text,
        if_type: stats.if_type,
        if_type_text,
        mtu: stats.mtu,
        phys_address: stats.phys_address,
        last_change: stats.last_change,
        speed_mbps: stats.speed_mbps,
        in_octets: stats.in_octets,
        out_octets: stats.out_octets,
        in_errors: stats.in_errors,
        out_errors: stats.out_errors,
        in_discards: stats.in_discards,
        out_discards: stats.out_discards,
        in_ucast_pkts: stats.in_ucast_pkts,
        out_ucast_pkts: stats.out_ucast_pkts,
        in_multicast_pkts: stats.in_multicast_pkts,
        out_multicast_pkts: stats.out_multicast_pkts,
        in_broadcast_pkts: stats.in_broadcast_pkts,
        out_broadcast_pkts: stats.out_broadcast_pkts,
        hc_counters: stats.hc_counters,
    }
}

/// SNMP interface stats endpoint - get all IF-MIB counters for a named interface
///
/// POST /api/snmp/interface-stats
pub async fn snmp_interface_stats(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SnmpInterfaceStatsRequest>,
) -> Result<Json<SnmpInterfaceStatsResponse>, Response> {
    let port = req.port.unwrap_or(161);

    tracing::info!(
        "SNMP interface-stats {}:{} interface: {}",
        req.host,
        port,
        req.interface_name
    );

    let dest = build_snmp_dest(
        &state,
        req.host.as_str(),
        port,
        &req.jump,
        req.profile_id.as_deref(),
    )
    .await?;
    let stats = crate::snmp::snmp_interface_stats(&dest, &req.community, &req.interface_name)
        .await
        .map_err(|e| {
            let api_err = snmp_error_to_api_error(e);
            let status = api_err.snmp_status();
            (status, Json(api_err)).into_response()
        })?;

    Ok(Json(interface_stats_to_response(stats)))
}

/// SNMP try-interface-stats endpoint - find working community from profile vault,
/// then get all IF-MIB counters for a named interface
///
/// POST /api/snmp/try-interface-stats
pub async fn snmp_try_interface_stats(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SnmpTryInterfaceStatsRequest>,
) -> Result<Json<SnmpInterfaceStatsResponse>, Response> {
    let port = req.port.unwrap_or(161);

    tracing::info!(
        "SNMP try-interface-stats {}:{} profile: {} interface: {}",
        req.host,
        port,
        req.profile_id,
        req.interface_name
    );

    let mut communities: Vec<String> = Vec::new();

    // Only the requested profile is consulted. A locked vault is a 403 the UI
    // can act on, not "no communities".
    let profile_cred = state
        .provider
        .get_profile_credential(&req.profile_id)
        .await
        .map_err(|e| ApiError::from(e).into_response())?;
    if let Some(cred) = profile_cred {
        if let Some(ref comms) = cred.snmp_communities {
            if !comms.is_empty() {
                communities = comms.clone();
                tracing::debug!(
                    "Using SNMP communities from requested profile {}",
                    req.profile_id
                );
            }
        }
    }

    if communities.is_empty() {
        // Do NOT fall back to other profiles' communities: that sent a
        // customer/site community string to an unrelated device and made
        // discovery "work" with credentials the engineer never chose (NS-AGENT-3).
        let api_err = ApiError {
            error: format!(
                "Profile {} has no SNMP communities configured. Add one under Profiles → SNMP.",
                req.profile_id
            ),
            code: "VALIDATION".to_string(),
        };
        return Err((StatusCode::BAD_REQUEST, Json(api_err)).into_response());
    }

    // Try each community with snmp_interface_stats, return first success
    tracing::info!(
        "Trying {} SNMP communit(ies) for {}:{} interface: {}",
        communities.len(),
        req.host,
        port,
        req.interface_name
    );
    let mut last_error: Option<crate::snmp::SnmpError> = None;
    let dest = build_snmp_dest(
        &state,
        req.host.as_str(),
        port,
        &req.jump,
        Some(&req.profile_id),
    )
    .await?;
    for community in &communities {
        match crate::snmp::snmp_interface_stats(&dest, community, &req.interface_name).await {
            Ok(stats) => {
                tracing::info!("SNMP interface stats success for {}:{}", req.host, port);
                return Ok(Json(interface_stats_to_response(stats)));
            }
            Err(crate::snmp::SnmpError::Timeout(_)) => {
                tracing::warn!(
                    "SNMP community timed out for {}:{}, trying next",
                    req.host,
                    port
                );
                last_error = Some(crate::snmp::SnmpError::Timeout(5));
                continue;
            }
            Err(crate::snmp::SnmpError::AuthError) => {
                tracing::warn!(
                    "SNMP community rejected by {}:{}, trying next",
                    req.host,
                    port
                );
                last_error = Some(crate::snmp::SnmpError::AuthError);
                continue;
            }
            Err(e) => {
                tracing::error!(
                    "SNMP interface stats error for {}:{} interface {}: {}",
                    req.host,
                    port,
                    req.interface_name,
                    e
                );
                // For non-auth/timeout errors (like InterfaceNotFound), return immediately
                let api_err = snmp_error_to_api_error(e);
                let status = api_err.snmp_status();
                return Err((status, Json(api_err)).into_response());
            }
        }
    }

    // No community worked
    let err = last_error.unwrap_or(crate::snmp::SnmpError::AuthError);
    tracing::warn!(
        "All SNMP communities failed for {}:{} interface {}: {:?}",
        req.host,
        port,
        req.interface_name,
        err
    );
    let api_err = match &err {
        crate::snmp::SnmpError::AuthError => ApiError {
            error: "No SNMP community string succeeded for this device".to_string(),
            code: "SNMP_AUTH_ERROR".to_string(),
        },
        _ => snmp_error_to_api_error(err),
    };
    let status = api_err.snmp_status();
    Err((status, Json(api_err)).into_response())
}

// === Task API Handlers (Phase 02) ===

/// Query parameters for listing tasks
#[derive(Debug, Deserialize)]
pub struct ListTasksParams {
    pub status: Option<String>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
}

/// Response for listing tasks
#[derive(Debug, Serialize)]
pub struct ListTasksResponse {
    pub tasks: Vec<crate::tasks::AgentTask>,
    /// Tasks currently holding a concurrency slot.
    pub running_count: usize,
    /// Spawned tasks still waiting for a slot (NS-API-8).
    pub queued_count: usize,
    pub max_concurrent: usize,
}

/// `POST /tasks` reply: the pending row, as 200 when it got a slot at once or
/// 202 + `queued: true` when every slot was busy and the executor queued it.
/// Either way the handler never blocks on the semaphore (NS-API-8).
fn spawned_task_response(task: crate::tasks::AgentTask, queued: bool) -> Response {
    if !queued {
        return Json(task).into_response();
    }
    let mut body =
        serde_json::to_value(&task).unwrap_or_else(|_| serde_json::json!({ "id": task.id }));
    body["queued"] = serde_json::json!(true);
    (StatusCode::ACCEPTED, Json(body)).into_response()
}

/// Create a new task
pub async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::tasks::CreateTaskRequest>,
) -> Result<Response, (StatusCode, String)> {
    let task = state
        .task_store
        .create_task(req)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Spawn for background execution (returns immediately; a full pool
    // queues the task inside the executor — NS-API-8).
    let queued = state.task_registry.semaphore().available_permits() == 0;
    if let Err(e) = state.task_executor.spawn_task(task.id.clone()).await {
        tracing::warn!("Failed to spawn task {}: {}", task.id, e);
        // Task is created but not running - client can retry
    }

    Ok(spawned_task_response(task, queued))
}

/// List tasks with optional status filter
pub async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListTasksParams>,
) -> Result<Json<ListTasksResponse>, (StatusCode, String)> {
    let status = params
        .status
        .and_then(|s| crate::tasks::TaskStatus::from_str(&s));
    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    let tasks = state
        .task_store
        .list_tasks(status, limit, offset)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Registry handles include tasks still queued for a slot (NS-API-8), so
    // "running" is the number of permits in use, and the rest are queued.
    let max_concurrent = state.task_registry.max_concurrent();
    let running_count =
        max_concurrent.saturating_sub(state.task_registry.semaphore().available_permits());
    let queued_count = state
        .task_registry
        .running_count()
        .await
        .saturating_sub(running_count);

    Ok(Json(ListTasksResponse {
        tasks,
        running_count,
        queued_count,
        max_concurrent,
    }))
}

/// Get a single task
pub async fn get_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<crate::tasks::AgentTask>, (StatusCode, String)> {
    let task = state.task_store.get_task(&id).await.map_err(|e| match e {
        crate::tasks::TaskStoreError::NotFound(_) => {
            (StatusCode::NOT_FOUND, "Task not found".to_string())
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    })?;

    Ok(Json(task))
}

/// Query for the transcript catch-up endpoint.
#[derive(Debug, serde::Deserialize)]
pub struct TaskMessagesQuery {
    /// Return steps with seq strictly greater than this. Default -1 (all).
    #[serde(default = "default_since_seq")]
    pub since_seq: i64,
}

fn default_since_seq() -> i64 {
    -1
}

/// GET /api/tasks/:id/messages?since_seq=N — transcript steps after seq N.
/// Used by the live glass-box view to backfill after WebSocket lag (Feature A).
pub async fn list_task_messages(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<TaskMessagesQuery>,
) -> Result<Json<Vec<crate::tasks::TaskMessage>>, (StatusCode, String)> {
    let messages = state
        .task_store
        .list_messages(&id, q.since_seq)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(messages))
}

/// Cancel/delete a task
pub async fn delete_task_endpoint(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Cancel if running
    let _ = state.task_executor.cancel_task(&id).await;

    // Delete from store
    state
        .task_store
        .delete_task(&id)
        .await
        .map_err(|e| match e {
            crate::tasks::TaskStoreError::NotFound(_) => {
                (StatusCode::NOT_FOUND, "Task not found".to_string())
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

// === SMTP Configuration Endpoints ===

/// SMTP configuration response (without password)
#[derive(Debug, Serialize)]
pub struct SmtpConfigResponse {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub use_tls: bool,
    pub from_email: String,
    pub from_name: Option<String>,
    pub has_password: bool,
}

/// Request to save SMTP configuration
#[derive(Deserialize)]
pub struct SaveSmtpConfigRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub use_tls: bool,
    pub from_email: String,
    pub from_name: Option<String>,
}

impl std::fmt::Debug for SaveSmtpConfigRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SaveSmtpConfigRequest")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("use_tls", &self.use_tls)
            .field("from_email", &self.from_email)
            .field("from_name", &self.from_name)
            .finish()
    }
}

/// Request to test SMTP connection
#[derive(Debug, Deserialize)]
pub struct TestSmtpRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub use_tls: bool,
    pub from_email: String,
    pub from_name: Option<String>,
}

/// Response from SMTP test
#[derive(Debug, Serialize)]
pub struct TestSmtpResponse {
    pub success: bool,
    pub error: Option<String>,
}

/// Get SMTP configuration
pub async fn get_smtp_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Option<SmtpConfigResponse>>, ApiError> {
    // Get pool from provider (LocalDataProvider exposes pool via get_pool method)
    let pool = state.provider.get_pool();

    // Query smtp_config table
    let row: Option<(String, i32, String, i32, String, Option<String>)> = sqlx::query_as(
        "SELECT host, port, username, use_tls, from_email, from_name FROM smtp_config WHERE id = 'default'"
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Database error: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    match row {
        Some((host, port, username, use_tls, from_email, from_name)) => {
            // Check if password exists in vault
            let has_password = state.provider.get_api_key("smtp_password").await?.is_some();

            Ok(Json(Some(SmtpConfigResponse {
                host,
                port: port as u16,
                username,
                use_tls: use_tls != 0,
                from_email,
                from_name,
                has_password,
            })))
        }
        None => Ok(Json(None)),
    }
}

/// Save SMTP configuration
pub async fn save_smtp_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveSmtpConfigRequest>,
) -> Result<StatusCode, ApiError> {
    // Validate required fields
    if req.host.is_empty() {
        return Err(ApiError {
            error: "SMTP host is required".to_string(),
            code: "VALIDATION".to_string(),
        });
    }
    if req.username.is_empty() {
        return Err(ApiError {
            error: "SMTP username is required".to_string(),
            code: "VALIDATION".to_string(),
        });
    }
    if req.from_email.is_empty() {
        return Err(ApiError {
            error: "From email is required".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    let pool = state.provider.get_pool();

    // Upsert smtp_config (SQLite UPSERT)
    sqlx::query(
        r#"INSERT INTO smtp_config (id, host, port, username, use_tls, from_email, from_name, updated_at)
           VALUES ('default', ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
               host = excluded.host,
               port = excluded.port,
               username = excluded.username,
               use_tls = excluded.use_tls,
               from_email = excluded.from_email,
               from_name = excluded.from_name,
               updated_at = datetime('now')"#
    )
    .bind(&req.host)
    .bind(req.port as i32)
    .bind(&req.username)
    .bind(if req.use_tls { 1 } else { 0 })
    .bind(&req.from_email)
    .bind(&req.from_name)
    .execute(pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Database error: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    // Store password in vault if provided
    if let Some(password) = req.password {
        if !password.is_empty() {
            state
                .provider
                .store_api_key("smtp_password", &password)
                .await?;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Delete SMTP configuration
pub async fn delete_smtp_config(
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let pool = state.provider.get_pool();

    // Delete the vault secret first and propagate failures (a locked vault is
    // a 403). Deleting the row first left an orphaned password that a later
    // config reported as `has_password: true` (NS-API-20).
    state.provider.delete_api_key("smtp_password").await?;

    sqlx::query("DELETE FROM smtp_config WHERE id = 'default'")
        .execute(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Test SMTP connection
pub async fn test_smtp_connection(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<TestSmtpRequest>,
) -> Json<TestSmtpResponse> {
    use crate::integrations::smtp::{EmailService, SmtpConfig};

    let config = SmtpConfig {
        host: req.host,
        port: req.port,
        username: req.username,
        use_tls: req.use_tls,
        from_email: req.from_email,
        from_name: req.from_name,
    };

    let service = EmailService::new(config, req.password);

    match service.test_connection().await {
        Ok(()) => Json(TestSmtpResponse {
            success: true,
            error: None,
        }),
        Err(e) => Json(TestSmtpResponse {
            success: false,
            error: Some(e.to_string()),
        }),
    }
}

// === MCP Server Endpoints (Phase 06-03) ===

/// Request to add a new MCP server
#[derive(Debug, Deserialize)]
pub struct AddMcpServerRequest {
    pub name: String,
    pub transport_type: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub auth_type: Option<String>,
    pub auth_token: Option<String>,
    pub server_type: Option<String>,
}

/// MCP server response
#[derive(Debug, Serialize)]
pub struct McpServerResponse {
    pub id: String,
    pub name: String,
    pub transport_type: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub auth_type: String,
    pub server_type: String,
    pub enabled: bool,
    pub connected: bool,
    pub tools: Vec<McpToolResponse>,
}

/// MCP tool response
#[derive(Debug, Serialize)]
pub struct McpToolResponse {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub input_schema: serde_json::Value,
}

/// List all configured MCP servers
pub async fn list_mcp_servers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<McpServerResponse>>, ApiError> {
    let pool = state.provider.get_pool();

    // Named-field row instead of a 9-element tuple — see the same struct
    // pattern in main.rs's auto-connect loop. Auth_token columns are
    // intentionally omitted: list_mcp_servers must never surface secrets.
    #[derive(sqlx::FromRow)]
    struct McpServerListRow {
        id: String,
        name: String,
        transport_type: String,
        command: String,
        args: String,
        enabled: i32,
        url: Option<String>,
        auth_type: String,
        server_type: String,
    }

    let rows: Vec<McpServerListRow> = sqlx::query_as(
        "SELECT id, name, transport_type, command, args, enabled, url, auth_type, server_type FROM mcp_servers ORDER BY name"
    )
    .fetch_all(pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Database error: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let mut responses = Vec::new();
    for row in rows {
        let McpServerListRow {
            id,
            name,
            transport_type,
            command,
            args: args_json,
            enabled,
            url,
            auth_type,
            server_type,
        } = row;
        let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();
        let connected = state
            .mcp_client_manager
            .read()
            .await
            .is_connected(&id)
            .await;

        // Get tools for this server from database
        let tool_rows: Vec<(String, String, Option<String>, i32, String)> = sqlx::query_as(
            "SELECT id, name, description, enabled, COALESCE(input_schema, '{}') FROM mcp_tools WHERE server_id = ? ORDER BY name"
        )
        .bind(&id)
        .fetch_all(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

        let tools: Vec<McpToolResponse> = tool_rows
            .into_iter()
            .map(
                |(tool_id, tool_name, description, tool_enabled, schema_str)| McpToolResponse {
                    id: tool_id,
                    name: tool_name,
                    description,
                    enabled: tool_enabled != 0,
                    input_schema: serde_json::from_str(&schema_str)
                        .unwrap_or(serde_json::json!({})),
                },
            )
            .collect();

        responses.push(McpServerResponse {
            id,
            name,
            transport_type,
            command,
            args,
            url,
            auth_type,
            server_type,
            enabled: enabled != 0,
            connected,
            tools,
        });
    }

    Ok(Json(responses))
}

/// Add a new MCP server configuration
///
/// AUDIT FIX (CRYPTO-002): if the request includes an `auth_token`, the
/// vault must be unlocked so we can encrypt it. The plaintext column is no
/// longer written to.
pub async fn add_mcp_server(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AddMcpServerRequest>,
) -> Result<(StatusCode, Json<McpServerResponse>), ApiError> {
    let pool = state.provider.get_pool();
    let id = uuid::Uuid::new_v4().to_string();
    let transport_type = req.transport_type.unwrap_or_else(|| "stdio".to_string());
    let command = req.command.unwrap_or_default();
    let args = req.args.unwrap_or_default();
    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".to_string());
    let auth_type = req.auth_type.unwrap_or_else(|| "none".to_string());
    let server_type = req.server_type.unwrap_or_else(|| "custom".to_string());

    if req.auth_token.is_some() && !state.provider.is_unlocked() {
        return Err(ApiError {
            error: "Unlock the vault before saving an MCP auth token".to_string(),
            code: "VAULT_LOCKED".to_string(),
        });
    }

    // Insert with NULL auth_token / auth_token_encrypted; we set the
    // encrypted token in a follow-up call so the encryption logic is in one
    // place (`store_mcp_auth_token`).
    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport_type, command, args, url, auth_type, auth_token, auth_token_encrypted, server_type, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0)"
    )
    .bind(&id)
    .bind(&req.name)
    .bind(&transport_type)
    .bind(&command)
    .bind(&args_json)
    .bind(&req.url)
    .bind(&auth_type)
    .bind(&server_type)
    .execute(pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Database error: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    if let Some(token) = req.auth_token.as_deref() {
        if !token.is_empty() {
            state
                .provider
                .store_mcp_auth_token(&id, token)
                .await
                .map_err(|e| ApiError {
                    error: format!("Failed to encrypt MCP auth token: {}", e),
                    code: "VAULT_ERROR".to_string(),
                })?;
        }
    }

    Ok((
        StatusCode::CREATED,
        Json(McpServerResponse {
            id,
            name: req.name,
            transport_type,
            command,
            args,
            url: req.url,
            auth_type,
            server_type,
            enabled: false,
            connected: false,
            tools: vec![],
        }),
    ))
}

/// Delete an MCP server configuration
pub async fn delete_mcp_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let pool = state.provider.get_pool();

    // Disconnect if connected
    let _ = state.mcp_client_manager.read().await.disconnect(&id).await;

    // AUDIT FIX (CRYPTO-002): defence-in-depth — explicitly clear any
    // encrypted/legacy auth token before the row goes away. The DELETE on
    // the row would also remove these columns, but going through the vault
    // helper keeps every credential-clear path uniform.
    if state.provider.is_unlocked()
        && state
            .provider
            .mcp_server_has_token(&id)
            .await
            .unwrap_or(false)
    {
        let _ = state.provider.delete_mcp_auth_token(&id).await;
    }

    // Delete from database (tools will cascade delete)
    let result = sqlx::query("DELETE FROM mcp_servers WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

    if result.rows_affected() == 0 {
        return Err(ApiError {
            error: "MCP server not found".to_string(),
            code: "NOT_FOUND".to_string(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Row shape for `SELECT id, name, transport_type, command, args, enabled, url,
/// auth_type, server_type FROM mcp_servers`.
type McpServerRow = (
    String,
    String,
    String,
    String,
    String,
    i32,
    Option<String>,
    String,
    String,
);

/// Connect to an MCP server and discover tools
pub async fn connect_mcp_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<McpServerResponse>, ApiError> {
    let pool = state.provider.get_pool();

    // Load server config from database (no auth_token here — we fetch that
    // separately through the vault helper, see CRYPTO-002).
    let row: Option<McpServerRow> = sqlx::query_as(
        "SELECT id, name, transport_type, command, args, enabled, url, auth_type, server_type FROM mcp_servers WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(pool)
    .await
    .map_err(|e| ApiError {
        error: format!("Database error: {}", e),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let (server_id, name, transport_type, command, args_json, enabled, url, auth_type, server_type) =
        row.ok_or_else(|| ApiError {
            error: "MCP server not found".to_string(),
            code: "NOT_FOUND".to_string(),
        })?;

    let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();

    // AUDIT FIX (CRYPTO-002): pull the token through the vault. If the
    // server was registered with a token but the vault is currently locked,
    // we surface a clear 403 instead of silently using a missing token.
    let auth_token = match state.provider.get_mcp_auth_token(&server_id).await {
        Ok(t) => t,
        Err(crate::providers::ProviderError::VaultLocked) => {
            return Err(ApiError {
                error: "Unlock the vault before connecting to this MCP server".to_string(),
                code: "VAULT_LOCKED".to_string(),
            });
        }
        Err(e) => {
            return Err(ApiError {
                error: format!("Failed to load MCP auth token: {}", e),
                code: "VAULT_ERROR".to_string(),
            });
        }
    };

    let config = crate::integrations::McpServerConfig {
        id: server_id.clone(),
        name: name.clone(),
        transport_type: transport_type.clone(),
        command: command.clone(),
        args: args.clone(),
        url: url.clone(),
        auth_type: auth_type.clone(),
        auth_token,
        server_type: server_type.clone(),
        enabled: enabled != 0,
    };

    // Connect and discover tools
    let mcp_tools = state
        .mcp_client_manager
        .read()
        .await
        .connect(config)
        .await
        .map_err(|e| ApiError {
            error: e.to_string(),
            code: "CONNECTION_FAILED".to_string(),
        })?;

    // Mark server as enabled
    sqlx::query("UPDATE mcp_servers SET enabled = 1 WHERE id = ?")
        .bind(&server_id)
        .execute(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

    // Upsert discovered tools to database
    for tool in &mcp_tools {
        let schema_json =
            serde_json::to_string(&tool.input_schema).unwrap_or_else(|_| "{}".to_string());

        sqlx::query(
            r#"INSERT INTO mcp_tools (id, server_id, name, description, input_schema, enabled)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(server_id, name) DO UPDATE SET
                 description = excluded.description,
                 input_schema = excluded.input_schema,
                 updated_at = datetime('now')"#,
        )
        .bind(&tool.id)
        .bind(&tool.server_id)
        .bind(&tool.name)
        .bind(&tool.description)
        .bind(&schema_json)
        .execute(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;
    }

    // The client builds every tool with `enabled: false`; the upsert above
    // preserves the stored flag, so report the DB state or the UI shows 0/N
    // enabled after every Connect/Restart (NS-AI-17).
    let enabled_rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, enabled FROM mcp_tools WHERE server_id = ?")
            .bind(&server_id)
            .fetch_all(pool)
            .await
            .map_err(|e| ApiError {
                error: format!("Database error: {}", e),
                code: "DATABASE_ERROR".to_string(),
            })?;
    let enabled_by_id: std::collections::HashMap<String, bool> = enabled_rows
        .into_iter()
        .map(|(id, e)| (id, e != 0))
        .collect();

    // Return updated server response with tools
    let tools: Vec<McpToolResponse> = mcp_tools
        .into_iter()
        .map(|t| McpToolResponse {
            enabled: enabled_by_id.get(&t.id).copied().unwrap_or(t.enabled),
            id: t.id,
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
        })
        .collect();

    Ok(Json(McpServerResponse {
        id: server_id,
        name,
        transport_type,
        command,
        args,
        url,
        auth_type,
        server_type,
        enabled: true,
        connected: true,
        tools,
    }))
}

/// Request to update an existing MCP server
#[derive(Debug, Deserialize)]
pub struct UpdateMcpServerRequest {
    pub name: Option<String>,
    pub transport_type: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub auth_type: Option<String>,
    pub server_type: Option<String>,
    /// Empty string clears the stored token; non-empty rotates it; absent leaves it alone.
    pub auth_token: Option<String>,
}

/// Update an existing MCP server configuration. Disconnects the server
/// first so the new config takes effect on the next connect.
pub async fn update_mcp_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateMcpServerRequest>,
) -> Result<Json<McpServerResponse>, ApiError> {
    let pool = state.provider.get_pool();

    let row: Option<McpServerRow> = sqlx::query_as(
        "SELECT id, name, transport_type, command, args, enabled, url, auth_type, server_type FROM mcp_servers WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(pool)
    .await
    .map_err(|e| ApiError { error: format!("Database error: {}", e), code: "DATABASE_ERROR".to_string() })?;
    let (
        existing_id,
        name,
        transport_type,
        command,
        args_json,
        _enabled,
        url,
        auth_type,
        server_type,
    ) = row.ok_or_else(|| ApiError {
        error: "MCP server not found".to_string(),
        code: "NOT_FOUND".to_string(),
    })?;

    if req.auth_token.is_some() && !state.provider.is_unlocked() {
        return Err(ApiError {
            error: "Unlock the vault before changing the MCP auth token".to_string(),
            code: "VAULT_LOCKED".to_string(),
        });
    }

    let new_name = req.name.unwrap_or(name);
    let new_transport_type = req.transport_type.unwrap_or(transport_type);
    let new_command = req.command.unwrap_or(command);
    let new_args: Vec<String> = req
        .args
        .unwrap_or_else(|| serde_json::from_str(&args_json).unwrap_or_default());
    let new_args_json = serde_json::to_string(&new_args).unwrap_or_else(|_| "[]".to_string());
    let new_url = req.url.or(url);
    let new_auth_type = req.auth_type.unwrap_or(auth_type);
    let new_server_type = req.server_type.unwrap_or(server_type);

    // Drop the live connection so the new config takes effect on next
    // connect; also flip enabled=0 so the row matches reality.
    let _ = state
        .mcp_client_manager
        .read()
        .await
        .disconnect(&existing_id)
        .await;

    sqlx::query(
        "UPDATE mcp_servers SET name = ?, transport_type = ?, command = ?, args = ?, url = ?, auth_type = ?, server_type = ?, enabled = 0 WHERE id = ?",
    )
    .bind(&new_name)
    .bind(&new_transport_type)
    .bind(&new_command)
    .bind(&new_args_json)
    .bind(&new_url)
    .bind(&new_auth_type)
    .bind(&new_server_type)
    .bind(&existing_id)
    .execute(pool)
    .await
    .map_err(|e| ApiError { error: format!("Database error: {}", e), code: "DATABASE_ERROR".to_string() })?;

    if let Some(token) = req.auth_token.as_deref() {
        if token.is_empty() {
            state
                .provider
                .delete_mcp_auth_token(&existing_id)
                .await
                .map_err(|e| ApiError {
                    error: format!("Failed to clear MCP auth token: {}", e),
                    code: "DATABASE_ERROR".to_string(),
                })?;
        } else {
            state
                .provider
                .store_mcp_auth_token(&existing_id, token)
                .await
                .map_err(|e| ApiError {
                    error: format!("Failed to encrypt MCP auth token: {}", e),
                    code: "VAULT_ERROR".to_string(),
                })?;
        }
    }

    let tool_rows: Vec<(String, String, Option<String>, i32, String)> = sqlx::query_as(
        "SELECT id, name, description, enabled, COALESCE(input_schema, '{}') FROM mcp_tools WHERE server_id = ? ORDER BY name"
    )
    .bind(&existing_id)
    .fetch_all(pool)
    .await
    .map_err(|e| ApiError { error: format!("Database error: {}", e), code: "DATABASE_ERROR".to_string() })?;
    let tools: Vec<McpToolResponse> = tool_rows
        .into_iter()
        .map(
            |(tool_id, tool_name, description, tool_enabled, schema_str)| McpToolResponse {
                id: tool_id,
                name: tool_name,
                description,
                enabled: tool_enabled != 0,
                input_schema: serde_json::from_str(&schema_str).unwrap_or(serde_json::json!({})),
            },
        )
        .collect();

    Ok(Json(McpServerResponse {
        id: existing_id,
        name: new_name,
        transport_type: new_transport_type,
        command: new_command,
        args: new_args,
        url: new_url,
        auth_type: new_auth_type,
        server_type: new_server_type,
        enabled: false,
        connected: false,
        tools,
    }))
}

/// Test response — boolean + reason + tools-discovered count.
#[derive(Debug, Serialize)]
pub struct TestMcpServerResponse {
    pub success: bool,
    pub message: String,
    pub tools_discovered: usize,
}

/// Test an MCP server without persisting anything. If the server is
/// already connected, return the live tool count instead of yanking
/// the session. Otherwise: connect, count tools, disconnect.
pub async fn test_mcp_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<TestMcpServerResponse>, ApiError> {
    let pool = state.provider.get_pool();

    let row: Option<McpServerRow> = sqlx::query_as(
        "SELECT id, name, transport_type, command, args, enabled, url, auth_type, server_type FROM mcp_servers WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(pool)
    .await
    .map_err(|e| ApiError { error: format!("Database error: {}", e), code: "DATABASE_ERROR".to_string() })?;
    let (server_id, name, transport_type, command, args_json, enabled, url, auth_type, server_type) =
        row.ok_or_else(|| ApiError {
            error: "MCP server not found".to_string(),
            code: "NOT_FOUND".to_string(),
        })?;
    let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();

    if state
        .mcp_client_manager
        .read()
        .await
        .is_connected(&server_id)
        .await
    {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM mcp_tools WHERE server_id = ?")
            .bind(&server_id)
            .fetch_one(pool)
            .await
            .map_err(|e| ApiError {
                error: format!("Database error: {}", e),
                code: "DATABASE_ERROR".to_string(),
            })?;
        return Ok(Json(TestMcpServerResponse {
            success: true,
            message: format!("'{}' is already connected", name),
            tools_discovered: count as usize,
        }));
    }

    let auth_token = match state.provider.get_mcp_auth_token(&server_id).await {
        Ok(t) => t,
        Err(crate::providers::ProviderError::VaultLocked) => {
            return Err(ApiError {
                error: "Unlock the vault before testing this MCP server".to_string(),
                code: "VAULT_LOCKED".to_string(),
            });
        }
        Err(e) => {
            return Err(ApiError {
                error: format!("Failed to load MCP auth token: {}", e),
                code: "VAULT_ERROR".to_string(),
            })
        }
    };

    let config = crate::integrations::McpServerConfig {
        id: server_id.clone(),
        name: name.clone(),
        transport_type,
        command,
        args,
        url,
        auth_type,
        auth_token,
        server_type,
        enabled: enabled != 0,
    };

    let mgr = state.mcp_client_manager.read().await;
    let result = mgr.connect(config).await;
    let _ = mgr.disconnect(&server_id).await;
    drop(mgr);

    match result {
        Ok(tools) => Ok(Json(TestMcpServerResponse {
            success: true,
            message: format!(
                "'{}' connected — discovered {} tool{}",
                name,
                tools.len(),
                if tools.len() == 1 { "" } else { "s" }
            ),
            tools_discovered: tools.len(),
        })),
        Err(e) => Ok(Json(TestMcpServerResponse {
            success: false,
            message: format!("'{}' failed: {}", name, e),
            tools_discovered: 0,
        })),
    }
}

/// Restart = disconnect followed by reconnect.
pub async fn restart_mcp_server(
    state: State<Arc<AppState>>,
    path: Path<String>,
) -> Result<Json<McpServerResponse>, ApiError> {
    // Best-effort disconnect — if not connected, just proceed.
    let _ = state
        .mcp_client_manager
        .read()
        .await
        .disconnect(&path.0)
        .await;
    connect_mcp_server(state, path).await
}

/// Disconnect from an MCP server
pub async fn disconnect_mcp_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let pool = state.provider.get_pool();

    // Disconnect
    state
        .mcp_client_manager
        .read()
        .await
        .disconnect(&id)
        .await
        .map_err(|e| ApiError {
            error: e.to_string(),
            code: "DISCONNECT_FAILED".to_string(),
        })?;

    // Mark server as disabled
    sqlx::query("UPDATE mcp_servers SET enabled = 0 WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Request to set tool enabled status
#[derive(Debug, Deserialize)]
pub struct SetToolEnabledRequest {
    pub enabled: bool,
}

/// Set MCP tool enabled status (per-tool approval)
pub async fn set_mcp_tool_enabled(
    State(state): State<Arc<AppState>>,
    Path(tool_id): Path<String>,
    Json(req): Json<SetToolEnabledRequest>,
) -> Result<StatusCode, ApiError> {
    let pool = state.provider.get_pool();

    let result: sqlx::sqlite::SqliteQueryResult =
        sqlx::query("UPDATE mcp_tools SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(if req.enabled { 1 } else { 0 })
            .bind(&tool_id)
            .execute(pool)
            .await
            .map_err(|e: sqlx::Error| ApiError {
                error: e.to_string(),
                code: "DB_ERROR".to_string(),
            })?;

    if result.rows_affected() == 0 {
        return Err(ApiError {
            error: "MCP tool not found".to_string(),
            code: "NOT_FOUND".to_string(),
        });
    }

    tracing::info!(
        tool_id = %tool_id,
        enabled = %req.enabled,
        "MCP tool enabled status updated"
    );

    Ok(StatusCode::NO_CONTENT)
}

/// Request to execute an MCP tool
#[derive(Debug, Deserialize)]
pub struct ExecuteMcpToolRequest {
    pub arguments: serde_json::Value,
}

/// Response from executing an MCP tool
#[derive(Debug, Serialize)]
pub struct ExecuteMcpToolResponse {
    pub content: String,
    pub is_error: bool,
}

/// Execute an MCP tool by its database ID
pub async fn execute_mcp_tool(
    State(state): State<Arc<AppState>>,
    Path(tool_id): Path<String>,
    Json(req): Json<ExecuteMcpToolRequest>,
) -> Result<Json<ExecuteMcpToolResponse>, ApiError> {
    let pool = state.provider.get_pool();

    // Look up the tool to get server_id and name
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT server_id, name FROM mcp_tools WHERE id = ? AND enabled = 1")
            .bind(&tool_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| ApiError {
                error: format!("Database error: {}", e),
                code: "DATABASE_ERROR".to_string(),
            })?;

    let (server_id, tool_name) = row.ok_or_else(|| ApiError {
        error: "MCP tool not found or not enabled".to_string(),
        code: "NOT_FOUND".to_string(),
    })?;

    // Call the tool via MCP client manager
    let result = state
        .mcp_client_manager
        .read()
        .await
        .call_tool(&server_id, &tool_name, req.arguments)
        .await
        .map_err(|e| ApiError {
            error: format!("MCP tool execution failed: {}", e),
            code: "TOOL_EXECUTION_FAILED".to_string(),
        })?;

    // Extract text content from the result
    let content = result
        .content
        .iter()
        .filter_map(|c| match c.raw {
            rmcp::model::RawContent::Text(ref text) => Some(text.text.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(Json(ExecuteMcpToolResponse {
        content,
        is_error: result.is_error.unwrap_or(false),
    }))
}

// === SSH Certificate Auth ===

/// GET /api/cert/status - Get certificate status
pub async fn cert_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    match &state.cert_manager {
        Some(cm) => Json(
            serde_json::to_value(cm.get_status().await)
                .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() })),
        ),
        None => {
            Json(serde_json::json!({ "valid": false, "error": "Certificate auth not initialized" }))
        }
    }
}

/// GET /api/cert/public-key - Get the agent's public key for signing
pub async fn cert_public_key(State(state): State<Arc<AppState>>) -> Result<String, StatusCode> {
    let cm = state
        .cert_manager
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    cm.get_public_key()
        .await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// POST /api/cert/store - Store a signed certificate (called by frontend after login)
pub async fn cert_store(
    State(state): State<Arc<AppState>>,
    Json(cert_info): Json<crate::cert_manager::SignedCertInfo>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let cm = state
        .cert_manager
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    cm.store_certificate(&cert_info).await.map_err(|e| {
        tracing::error!("Failed to store certificate: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(
        serde_json::to_value(cm.get_status().await)
            .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() })),
    ))
}

/// POST /api/cert/renew - Trigger certificate renewal
///
/// AUDIT FIX (CRYPTO-011): the previous implementation silently returned
/// `cert_status()` and pretended renewal had succeeded. The cert-manager
/// activation path (`cert_manager.rs::_initialize`/`_generate_keypair`) was
/// never wired in, so users would lose SSH cert auth at expiry without
/// warning. Until the activation path is wired, return 501 Not Implemented
/// so callers know the renewal didn't happen and don't get false confidence.
pub async fn cert_renew(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let _cm = state
        .cert_manager
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    tracing::warn!(
        target: "audit",
        "cert_renew was called but the renewal pipeline is not yet implemented; returning 501"
    );
    Err(StatusCode::NOT_IMPLEMENTED)
}

// === Discovery API Endpoints (Phase 27: Topology Discovery v2) ===

/// POST /api/discovery/batch - Batch neighbor discovery
///
/// Accepts a list of targets with SNMP/SSH profiles and runs discovery
/// in parallel with bounded concurrency (max 10 simultaneous targets).
/// For each target: tries SNMP first, falls back to CLI, then nmap.
pub async fn discovery_batch(
    State(state): State<Arc<AppState>>,
    Json(request): Json<crate::discovery::BatchDiscoveryRequest>,
) -> Result<Json<Vec<crate::discovery::TargetDiscoveryResult>>, (StatusCode, String)> {
    tracing::info!("Discovery batch request: {} targets", request.targets.len());

    let results =
        crate::discovery::orchestrator::run_batch_discovery(request, &state.provider).await;

    Ok(Json(results))
}

/// POST /api/discovery/traceroute-resolve - Resolve traceroute hops
///
/// Resolves a list of traceroute hop IPs to parent devices using
/// NetBox/Netdisco/LibreNMS integrations, then runs SNMP neighbor
/// discovery on resolved management IPs. Falls back to direct
/// SNMP/SSH/nmap on unresolved hops.
pub async fn discovery_traceroute_resolve(
    State(state): State<Arc<AppState>>,
    Json(request): Json<crate::discovery::TracerouteResolveRequest>,
) -> Result<Json<Vec<crate::discovery::HopResolutionResult>>, (StatusCode, String)> {
    tracing::info!("Traceroute resolve request: {} hops", request.hops.len());

    let results =
        crate::discovery::orchestrator::resolve_traceroute_hops(request, &state.provider).await;

    Ok(Json(results))
}

/// GET /api/discovery/capabilities - Check available discovery methods
///
/// Reports whether nmap is available, whether sudo is available for
/// OS detection, and confirms SNMP support.
pub async fn discovery_capabilities() -> Json<crate::discovery::DiscoveryCapabilities> {
    let caps = crate::discovery::orchestrator::check_capabilities().await;
    Json(caps)
}

// === MOP Diff ===

#[derive(Deserialize)]
pub struct MopDiffRequest {
    a: String,
    b: String,
    format: String, // "json" or "text"
}

#[derive(Debug, Serialize)]
pub struct DiffChange {
    path: String,
    old: serde_json::Value,
    new: serde_json::Value,
    #[serde(rename = "type")]
    change_type: String,
}

#[derive(Serialize)]
pub struct DiffSummary {
    changed: usize,
    added: usize,
    removed: usize,
}

#[derive(Serialize)]
pub struct StepDiff {
    format: String,
    changes: Vec<DiffChange>,
    summary: DiffSummary,
}

/// POST /api/mop/diff - Compare two strings and return a structured diff
///
/// Supports JSON mode (deep object comparison with JSON paths) and
/// text mode (line-level diff).
pub async fn mop_diff(Json(req): Json<MopDiffRequest>) -> Result<Json<StepDiff>, ApiError> {
    match req.format.as_str() {
        "json" => mop_diff_json(&req.a, &req.b),
        "text" => Ok(Json(mop_diff_text(&req.a, &req.b))),
        other => Err(ApiError {
            error: format!(
                "Unknown diff format: '{}', expected 'json' or 'text'",
                other
            ),
            code: "VALIDATION".to_string(),
        }),
    }
}

fn mop_diff_json(a: &str, b: &str) -> Result<Json<StepDiff>, ApiError> {
    let val_a: serde_json::Value = serde_json::from_str(a).map_err(|e| ApiError {
        error: format!("Failed to parse 'a' as JSON: {}", e),
        code: "VALIDATION".to_string(),
    })?;
    let val_b: serde_json::Value = serde_json::from_str(b).map_err(|e| ApiError {
        error: format!("Failed to parse 'b' as JSON: {}", e),
        code: "VALIDATION".to_string(),
    })?;

    let mut changes = Vec::new();
    diff_json_values("$", &val_a, &val_b, &mut changes);

    let summary = DiffSummary {
        changed: changes
            .iter()
            .filter(|c| c.change_type == "changed")
            .count(),
        added: changes.iter().filter(|c| c.change_type == "added").count(),
        removed: changes
            .iter()
            .filter(|c| c.change_type == "removed")
            .count(),
    };

    Ok(Json(StepDiff {
        format: "json".to_string(),
        changes,
        summary,
    }))
}

fn diff_json_values(
    path: &str,
    a: &serde_json::Value,
    b: &serde_json::Value,
    changes: &mut Vec<DiffChange>,
) {
    use serde_json::Value;

    match (a, b) {
        (Value::Object(map_a), Value::Object(map_b)) => {
            // Keys in a but not in b → removed
            for key in map_a.keys() {
                let child_path = format!("{}.{}", path, key);
                if let Some(val_b) = map_b.get(key) {
                    diff_json_values(&child_path, &map_a[key], val_b, changes);
                } else {
                    collect_all_leaves(&child_path, &map_a[key], changes, "removed", true);
                }
            }
            // Keys in b but not in a → added
            for key in map_b.keys() {
                if !map_a.contains_key(key) {
                    let child_path = format!("{}.{}", path, key);
                    collect_all_leaves(&child_path, &map_b[key], changes, "added", false);
                }
            }
        }
        (Value::Array(arr_a), Value::Array(arr_b)) => {
            let max_len = arr_a.len().max(arr_b.len());
            for i in 0..max_len {
                let child_path = format!("{}[{}]", path, i);
                match (arr_a.get(i), arr_b.get(i)) {
                    (Some(va), Some(vb)) => diff_json_values(&child_path, va, vb, changes),
                    (Some(va), None) => {
                        collect_all_leaves(&child_path, va, changes, "removed", true);
                    }
                    (None, Some(vb)) => {
                        collect_all_leaves(&child_path, vb, changes, "added", false);
                    }
                    (None, None) => {}
                }
            }
        }
        _ => {
            if a != b {
                changes.push(DiffChange {
                    path: path.to_string(),
                    old: a.clone(),
                    new: b.clone(),
                    change_type: "changed".to_string(),
                });
            }
        }
    }
}

/// For added/removed subtrees, emit a single change entry at the subtree root
/// rather than recursing into every leaf.
fn collect_all_leaves(
    path: &str,
    val: &serde_json::Value,
    changes: &mut Vec<DiffChange>,
    change_type: &str,
    is_old: bool,
) {
    let (old, new) = if is_old {
        (val.clone(), serde_json::Value::Null)
    } else {
        (serde_json::Value::Null, val.clone())
    };
    changes.push(DiffChange {
        path: path.to_string(),
        old,
        new,
        change_type: change_type.to_string(),
    });
}

fn mop_diff_text(a: &str, b: &str) -> StepDiff {
    let lines_a: Vec<&str> = a.lines().collect();
    let lines_b: Vec<&str> = b.lines().collect();

    // LCS-based diff
    let lcs_table = build_lcs_table(&lines_a, &lines_b);
    let changes = extract_diff_changes(&lcs_table, &lines_a, &lines_b);

    let summary = DiffSummary {
        changed: changes
            .iter()
            .filter(|c| c.change_type == "changed")
            .count(),
        added: changes.iter().filter(|c| c.change_type == "added").count(),
        removed: changes
            .iter()
            .filter(|c| c.change_type == "removed")
            .count(),
    };

    StepDiff {
        format: "text".to_string(),
        changes,
        summary,
    }
}

fn build_lcs_table(a: &[&str], b: &[&str]) -> Vec<Vec<usize>> {
    let m = a.len();
    let n = b.len();
    let mut table = vec![vec![0usize; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            if a[i - 1] == b[j - 1] {
                table[i][j] = table[i - 1][j - 1] + 1;
            } else {
                table[i][j] = table[i - 1][j].max(table[i][j - 1]);
            }
        }
    }
    table
}

fn extract_diff_changes(table: &[Vec<usize>], a: &[&str], b: &[&str]) -> Vec<DiffChange> {
    let mut changes = Vec::new();
    let mut i = a.len();
    let mut j = b.len();

    // Backtrack through the LCS table to produce diff entries
    // We collect in reverse order, then reverse at the end
    let mut raw: Vec<(String, serde_json::Value, serde_json::Value, String)> = Vec::new();

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && a[i - 1] == b[j - 1] {
            // Lines match — no change
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || table[i][j - 1] >= table[i - 1][j]) {
            // Line added in b
            raw.push((
                format!("L{}", j),
                serde_json::Value::Null,
                serde_json::Value::String(b[j - 1].to_string()),
                "added".to_string(),
            ));
            j -= 1;
        } else if i > 0 {
            // Line removed from a
            raw.push((
                format!("L{}", i),
                serde_json::Value::String(a[i - 1].to_string()),
                serde_json::Value::Null,
                "removed".to_string(),
            ));
            i -= 1;
        }
    }

    raw.reverse();

    // Pair up adjacent removed+added at the same conceptual position as "changed"
    let mut idx = 0;
    while idx < raw.len() {
        // Identical text on both sides is a moved line, not a rewrite — emit
        // the removed/added pair as-is instead of a "changed" entry with old == new.
        if idx + 1 < raw.len()
            && raw[idx].3 == "removed"
            && raw[idx + 1].3 == "added"
            && raw[idx].1 != raw[idx + 1].2
        {
            changes.push(DiffChange {
                path: raw[idx].0.clone(),
                old: raw[idx].1.clone(),
                new: raw[idx + 1].2.clone(),
                change_type: "changed".to_string(),
            });
            idx += 2;
        } else {
            changes.push(DiffChange {
                path: raw[idx].0.clone(),
                old: raw[idx].1.clone(),
                new: raw[idx].2.clone(),
                change_type: raw[idx].3.clone(),
            });
            idx += 1;
        }
    }

    changes
}

// === AI Memory Endpoints ===

/// GET /ai/memory — list all memories, optionally filtered by category
pub async fn list_ai_memories(
    State(state): State<Arc<AppState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows: Vec<(String, String, String, String, String, String)> = if let Some(cat) = params.get("category") {
        sqlx::query_as(
            "SELECT id, content, category, source, created_at, updated_at FROM ai_memory WHERE category = ? ORDER BY created_at DESC LIMIT 100"
        )
        .bind(cat)
        .fetch_all(&state.pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, content, category, source, created_at, updated_at FROM ai_memory ORDER BY created_at DESC LIMIT 100"
        )
        .fetch_all(&state.pool)
        .await
    }
    .map_err(|e| ApiError { error: e.to_string(), code: "DATABASE_ERROR".to_string() })?;

    let memories: Vec<serde_json::Value> = rows
        .iter()
        .map(|(id, content, category, source, created_at, updated_at)| {
            serde_json::json!({
                "id": id,
                "content": content,
                "category": category,
                "source": source,
                "created_at": created_at,
                "updated_at": updated_at,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "memories": memories })))
}

/// POST /ai/memory — create a new memory
pub async fn create_ai_memory(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let content = body
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let category = body
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("general")
        .to_string();
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("user")
        .to_string();

    if content.is_empty() {
        return Err(ApiError {
            error: "Memory content cannot be empty".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    sqlx::query("INSERT INTO ai_memory (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&content).bind(&category).bind(&source).bind(&now).bind(&now)
        .execute(&state.pool)
        .await
        .map_err(|e| ApiError { error: e.to_string(), code: "DATABASE_ERROR".to_string() })?;

    Ok(Json(
        serde_json::json!({ "id": id, "content": content, "category": category }),
    ))
}

/// PUT /ai/memory/:id — update a memory
pub async fn update_ai_memory(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, ApiError> {
    let content = body
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err(ApiError {
            error: "Memory content cannot be empty".to_string(),
            code: "VALIDATION".to_string(),
        });
    }
    let category = body
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("general");
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let result =
        sqlx::query("UPDATE ai_memory SET content = ?, category = ?, updated_at = ? WHERE id = ?")
            .bind(content)
            .bind(category)
            .bind(&now)
            .bind(&id)
            .execute(&state.pool)
            .await
            .map_err(|e| ApiError {
                error: e.to_string(),
                code: "DATABASE_ERROR".to_string(),
            })?;
    if result.rows_affected() == 0 {
        return Err(ApiError {
            error: "Memory not found".to_string(),
            code: "NOT_FOUND".to_string(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /ai/memory/:id — delete a memory
pub async fn delete_ai_memory(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM ai_memory WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| ApiError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

// === Task Tool-Use Approval Endpoints (AUDIT FIX EXEC-017) ===
//
// Background ReAct tasks pause before any mutating tool dispatch
// (`tasks::approvals::is_mutating_tool`). The frontend polls
// `GET /api/tasks/:id/pending-approvals` while showing a running task
// and resolves via the approve/reject endpoints below.

/// GET /api/tasks/:task_id/pending-approvals — pending tool-use prompts
/// for one task.
pub async fn list_task_pending_approvals(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Json<Vec<crate::tasks::approvals::PendingInteraction>> {
    Json(
        state
            .task_executor
            .approval_service
            .pending_for_task(&task_id)
            .await,
    )
}

/// GET /api/task-approvals — every pending approval across all tasks.
/// Used by the agents panel for a "you have N pending decisions" badge.
pub async fn list_all_task_approvals(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<crate::tasks::approvals::PendingInteraction>> {
    Json(state.task_executor.approval_service.list_all().await)
}

/// Typed body for the generalized interaction-resolve endpoint (Feature B).
/// `{"kind":"approve"}`, `{"kind":"reject","reason":"..."}`,
/// `{"kind":"answer","text":"..."}`, or `{"kind":"answer_structured","json":{...}}`.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolveInteractionBody {
    Approve,
    Reject { reason: Option<String> },
    Answer { text: String },
    AnswerStructured { json: serde_json::Value },
}

impl From<ResolveInteractionBody> for crate::tasks::approvals::HumanResponse {
    fn from(b: ResolveInteractionBody) -> Self {
        use crate::tasks::approvals::HumanResponse as H;
        match b {
            ResolveInteractionBody::Approve => H::Approve,
            ResolveInteractionBody::Reject { reason } => H::Reject { reason },
            ResolveInteractionBody::Answer { text } => H::Answer { text },
            ResolveInteractionBody::AnswerStructured { json } => H::AnswerStructured { json },
        }
    }
}

/// POST /api/task-interactions/:interaction_id/resolve — typed resolution
/// (Feature B). Carries an approve/reject OR a free-text/structured answer.
/// The server-side `resolve()` invariant check means a free-text answer can
/// never approve a mutating tool (kind/variant incompatibility -> rejected).
pub async fn resolve_task_interaction(
    State(state): State<Arc<AppState>>,
    Path(interaction_id): Path<String>,
    Json(body): Json<ResolveInteractionBody>,
) -> Result<StatusCode, ApiError> {
    let response: crate::tasks::approvals::HumanResponse = body.into();
    if state
        .task_executor
        .approval_service
        .resolve(&interaction_id, response)
        .await
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        // `false` = not found, already resolved/expired, OR the response variant
        // was incompatible with the interaction kind (structural invariant).
        Err(ApiError {
            error: "Interaction not found, already resolved, or incompatible response".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}

/// POST /api/task-approvals/:approval_id/approve — user approved the call.
pub async fn approve_task_tool_use(
    State(state): State<Arc<AppState>>,
    Path(approval_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state
        .task_executor
        .approval_service
        .resolve(
            &approval_id,
            crate::tasks::approvals::HumanResponse::Approve,
        )
        .await
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            error: "Approval not found (likely already resolved or timed out)".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}

/// POST /api/task-approvals/:approval_id/reject — user rejected the call.
pub async fn reject_task_tool_use(
    State(state): State<Arc<AppState>>,
    Path(approval_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state
        .task_executor
        .approval_service
        .resolve(
            &approval_id,
            crate::tasks::approvals::HumanResponse::Reject { reason: None },
        )
        .await
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            error: "Approval not found (likely already resolved or timed out)".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}

// === Host-Key Approval Endpoints (AUDIT FIX REMOTE-001) ===
//
// The SSH handshake calls into a server-side approval queue when it sees
// an unknown or changed host key. The frontend polls this surface every
// ~750 ms while a connection is in flight, shows the modal, and resolves
// the prompt with the user's decision.

/// GET /api/host-keys/prompts — list currently-pending fingerprint prompts.
pub async fn list_host_key_prompts(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<crate::ssh::approvals::PendingPrompt>> {
    Json(state.host_key_approvals.list_pending().await)
}

/// POST /api/host-keys/prompts/:id/approve — user accepted the fingerprint.
pub async fn approve_host_key_prompt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state.host_key_approvals.resolve(&id, true).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            error: "Prompt not found (likely already resolved or timed out)".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}

/// POST /api/host-keys/prompts/:id/reject — user refused the fingerprint.
pub async fn reject_host_key_prompt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if state.host_key_approvals.resolve(&id, false).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            error: "Prompt not found (likely already resolved or timed out)".to_string(),
            code: "NOT_FOUND".to_string(),
        })
    }
}

/// GET /api/host-keys — list every trusted host key in the known_hosts
/// store so the user can audit and revoke TOFU decisions.
pub async fn list_host_keys() -> Result<Json<Vec<crate::ssh::host_keys::HostKeyEntry>>, ApiError> {
    let store_arc = crate::ssh::host_keys::load_default_store();
    let store = store_arc.lock().await;
    Ok(Json(store.list_entries()))
}

/// DELETE /api/host-keys/:host/:port — revoke a previously-trusted key.
/// On the next connection to that host:port the user will get a fresh
/// TOFU prompt. Returns 404 if no key was stored for the pair.
pub async fn delete_host_key(
    Path((host, port)): Path<(String, u16)>,
) -> Result<StatusCode, ApiError> {
    let store_arc = crate::ssh::host_keys::load_default_store();
    let mut store = store_arc.lock().await;
    let removed = store.remove_key(&host, port).map_err(|e| ApiError {
        error: format!("Failed to revoke host key: {}", e),
        code: "HOST_KEY_REMOVE_FAILED".to_string(),
    })?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError {
            error: format!("No trusted key found for {}:{}", host, port),
            code: "NOT_FOUND".to_string(),
        })
    }
}

#[derive(Serialize)]
pub struct PurgeHostKeysResponse {
    pub removed: usize,
}

/// DELETE /api/host-keys — purge ALL trusted host keys. Every subsequent
/// connection re-prompts (TOFU). Returns how many were removed.
pub async fn purge_host_keys() -> Result<Json<PurgeHostKeysResponse>, ApiError> {
    let store_arc = crate::ssh::host_keys::load_default_store();
    let mut store = store_arc.lock().await;
    let removed = store.clear_all().map_err(|e| ApiError {
        error: format!("Failed to purge host keys: {}", e),
        code: "HOST_KEY_REMOVE_FAILED".to_string(),
    })?;
    Ok(Json(PurgeHostKeysResponse { removed }))
}

// === AI Config-Mode Endpoints (AUDIT FIX EXEC-002) ===
//
// These three endpoints replace the request-body `allow_config_changes`
// boolean as the source of truth for whether the AI may emit configuration
// commands. Enable requires the current master password; the state expires
// automatically after CONFIG_MODE_TTL_SECS so an unattended laptop does not
// stay armed indefinitely.

#[derive(Debug, Deserialize)]
pub struct ConfigModeEnableRequest {
    pub master_password: String,
}

#[derive(Debug, Serialize)]
pub struct ConfigModeStatusResponse {
    pub enabled: bool,
    pub expires_at: Option<String>,
    pub seconds_remaining: Option<i64>,
}

/// POST /api/ai/config-mode/enable — turn config mode on for CONFIG_MODE_TTL_SECS.
/// Requires the user to re-supply the master password (proof-of-presence).
pub async fn enable_config_mode(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConfigModeEnableRequest>,
) -> Result<Json<ConfigModeStatusResponse>, ApiError> {
    state
        .provider
        .unlock(&req.master_password)
        .await
        .map_err(|_| ApiError {
            error: "Invalid master password".to_string(),
            code: "INVALID_PASSWORD".to_string(),
        })?;

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(CONFIG_MODE_TTL_SECS);
    *state.config_mode.write().await = Some(ConfigModeState { expires_at });

    tracing::warn!(
        target: "audit",
        ttl_secs = CONFIG_MODE_TTL_SECS,
        "AI config mode enabled (auto-expires in {} secs)",
        CONFIG_MODE_TTL_SECS
    );

    Ok(Json(ConfigModeStatusResponse {
        enabled: true,
        expires_at: Some(expires_at.to_rfc3339()),
        seconds_remaining: Some(CONFIG_MODE_TTL_SECS),
    }))
}

/// POST /api/ai/config-mode/disable — turn config mode off immediately.
pub async fn disable_config_mode(
    State(state): State<Arc<AppState>>,
) -> Json<ConfigModeStatusResponse> {
    let was_active = state.config_mode.write().await.take().is_some();
    if was_active {
        tracing::warn!(target: "audit", "AI config mode disabled by user");
    }
    Json(ConfigModeStatusResponse {
        enabled: false,
        expires_at: None,
        seconds_remaining: None,
    })
}

/// GET /api/ai/config-mode/status — frontend polls this so the UI can
/// reflect the active state and show the countdown.
pub async fn config_mode_status(
    State(state): State<Arc<AppState>>,
) -> Json<ConfigModeStatusResponse> {
    let snapshot = *state.config_mode.read().await;
    let now = chrono::Utc::now();
    match snapshot {
        Some(s) if s.expires_at > now => Json(ConfigModeStatusResponse {
            enabled: true,
            expires_at: Some(s.expires_at.to_rfc3339()),
            seconds_remaining: Some((s.expires_at - now).num_seconds().max(0)),
        }),
        _ => Json(ConfigModeStatusResponse {
            enabled: false,
            expires_at: None,
            seconds_remaining: None,
        }),
    }
}

// === Tunnel Manager Endpoints ===

pub async fn list_tunnels(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<TunnelWithState>>, ApiError> {
    let tunnels = crate::db::list_tunnels(&state.pool).await?;
    let states = state.tunnel_manager.get_all_states().await;
    let mut state_map: std::collections::HashMap<String, TunnelRuntimeState> =
        states.into_iter().map(|s| (s.id.clone(), s)).collect();

    let mut result: Vec<TunnelWithState> = tunnels
        .into_iter()
        .map(|t| {
            let runtime = state_map.remove(&t.id).unwrap_or(TunnelRuntimeState {
                id: t.id.clone(),
                status: TunnelStatus::Disconnected,
                uptime_secs: None,
                bytes_tx: 0,
                bytes_rx: 0,
                last_error: None,
                retry_count: 0,
            });
            TunnelWithState {
                tunnel: t,
                state: runtime,
            }
        })
        .collect();

    // Append session tunnels (ephemeral, not in DB) using definitions + already-fetched states
    for (id, def) in state.tunnel_manager.get_session_tunnel_definitions().await {
        let runtime = state_map.remove(&id).unwrap_or(TunnelRuntimeState {
            id: id.clone(),
            status: TunnelStatus::Connected,
            uptime_secs: None,
            bytes_tx: 0,
            bytes_rx: 0,
            last_error: None,
            retry_count: 0,
        });
        result.push(TunnelWithState {
            tunnel: def,
            state: runtime,
        });
    }

    Ok(Json(result))
}

/// Validate a tunnel bind_address — only loopback is permitted by default.
///
/// AUDIT FIX (REMOTE-010): the previous behaviour accepted any string, so
/// `0.0.0.0` (open the tunnel to the entire LAN) was a single config typo.
/// Combined with REMOTE-011 (SOCKS5 advertises no-auth), an accidental
/// `0.0.0.0` SOCKS5 forward turned the user's machine into an unauthenticated
/// pivot proxy. We allow only IPv4 / IPv6 loopback addresses; any non-loopback
/// must be opted into via a future `share_with_lan` UI gesture (not yet
/// implemented).
fn validate_tunnel_bind_address(bind: &str) -> Result<(), ApiError> {
    let trimmed = bind.trim();
    let parsed: std::net::IpAddr = trimmed.parse().map_err(|_| ApiError {
        error: format!(
            "bind_address '{}' is not a valid IP literal (use 127.0.0.1 or ::1)",
            trimmed
        ),
        code: "VALIDATION".to_string(),
    })?;
    if !parsed.is_loopback() {
        return Err(ApiError {
            error: format!(
                "bind_address '{}' must be a loopback address (127.0.0.0/8 or ::1) — \
                 binding tunnels to non-loopback exposes them to the LAN with no auth",
                trimmed
            ),
            code: "VALIDATION".to_string(),
        });
    }
    Ok(())
}

pub async fn create_tunnel(
    State(state): State<Arc<AppState>>,
    Json(new_tunnel): Json<NewTunnel>,
) -> Result<(StatusCode, Json<Tunnel>), ApiError> {
    validate_tunnel_bind_address(&new_tunnel.bind_address)?;
    let tunnel = crate::db::create_tunnel(&state.pool, new_tunnel).await?;
    Ok((StatusCode::CREATED, Json(tunnel)))
}

pub async fn update_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateTunnel>,
) -> Result<Json<Tunnel>, ApiError> {
    if let Some(bind) = update.bind_address.as_deref() {
        validate_tunnel_bind_address(bind)?;
    }
    // stop_tunnel only succeeds for a tunnel the manager is tracking, so its
    // result tells us whether to bring the tunnel back up after the edit.
    // Previously an edit silently left a running tunnel down (NS-FEAT-12).
    let was_running = state.tunnel_manager.stop_tunnel(&id).await.is_ok();
    let tunnel = crate::db::update_tunnel(&state.pool, &id, update).await?;
    if was_running {
        if let Err(e) = state.tunnel_manager.start_tunnel(&tunnel).await {
            tracing::warn!(
                "update_tunnel: tunnel {} was running but failed to restart: {}",
                id,
                e
            );
        }
    }
    Ok(Json(tunnel))
}

pub async fn delete_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let _ = state.tunnel_manager.stop_tunnel(&id).await;
    crate::db::delete_tunnel(&state.pool, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn start_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let tunnel = crate::db::get_tunnel(&state.pool, &id).await?;
    state
        .tunnel_manager
        .start_tunnel(&tunnel)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "TUNNEL_ERROR".to_string(),
        })?;
    Ok(Json(serde_json::json!({"status": "started"})))
}

pub async fn stop_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .tunnel_manager
        .stop_tunnel(&id)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "TUNNEL_ERROR".to_string(),
        })?;
    Ok(Json(serde_json::json!({"status": "stopped"})))
}

pub async fn reconnect_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ = state.tunnel_manager.stop_tunnel(&id).await;
    let tunnel = crate::db::get_tunnel(&state.pool, &id).await?;
    state
        .tunnel_manager
        .start_tunnel(&tunnel)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "TUNNEL_ERROR".to_string(),
        })?;
    Ok(Json(serde_json::json!({"status": "reconnected"})))
}

pub async fn tunnel_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<TunnelRuntimeState>>, ApiError> {
    let states = state.tunnel_manager.get_all_states().await;
    Ok(Json(states))
}

pub async fn start_all_tunnels(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let tunnels = crate::db::list_tunnels(&state.pool).await?;
    state.tunnel_manager.start_all_auto(&tunnels).await;
    Ok(Json(serde_json::json!({"status": "started"})))
}

pub async fn stop_all_tunnels(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.tunnel_manager.stop_all().await;
    Ok(Json(serde_json::json!({"status": "stopped"})))
}

// ── Workspace local file operations ────────────────────────────────────────

/// Validate that a filesystem path is safe to operate on.
///
/// Blocks path-traversal attacks (`..` components), access to sensitive
/// system directories, and access to the app's own database file.
fn validate_local_path(raw: &str) -> Result<std::path::PathBuf, ApiError> {
    use std::path::Path;

    let path = Path::new(raw);

    // Block relative paths and paths containing `..` traversal
    if !path.is_absolute() {
        return Err(ApiError {
            error: "Only absolute paths are allowed".to_string(),
            code: "FS_PATH_DENIED".to_string(),
        });
    }

    // Check for `..` components before canonicalization (blocks the attempt
    // even when the intermediate path doesn't exist yet, e.g. mkdir).
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(ApiError {
                error: "Path traversal ('..') is not allowed".to_string(),
                code: "FS_PATH_DENIED".to_string(),
            });
        }
    }

    // Try to canonicalize (resolves symlinks). If the path doesn't exist
    // yet (e.g. mkdir, write to new file), canonicalize the longest existing
    // ancestor instead so we can still validate the final location.
    let canonical = if path.exists() {
        path.canonicalize().map_err(|e| ApiError {
            error: format!("Failed to resolve path: {}", e),
            code: "FS_PATH_DENIED".to_string(),
        })?
    } else {
        // Walk up until we find a component that exists, canonicalize that,
        // then re-append the tail.
        let mut existing = path.to_path_buf();
        let mut tail_parts: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            if let Some(name) = existing.file_name() {
                tail_parts.push(name.to_os_string());
                existing = existing.parent().unwrap_or(Path::new("/")).to_path_buf();
            } else {
                break;
            }
        }
        let mut base = existing.canonicalize().map_err(|e| ApiError {
            error: format!("Failed to resolve path: {}", e),
            code: "FS_PATH_DENIED".to_string(),
        })?;
        for part in tail_parts.into_iter().rev() {
            base.push(part);
        }
        base
    };

    let canonical_str = canonical.to_string_lossy();

    // Blocked prefixes — sensitive system directories and user secrets.
    // /proc, /dev, /sys are kernel/pseudo filesystems (process memory, raw
    // devices) that are never legitimate file-browse targets; /var is left
    // browsable since /var/log is useful to a network engineer.
    let blocked_prefixes: &[&str] = &[
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/proc",
        "/dev",
        "/sys",
    ];

    for prefix in blocked_prefixes {
        if canonical_str.starts_with(prefix) {
            return Err(ApiError {
                error: format!("Access to '{}' is not allowed", prefix),
                code: "FS_PATH_DENIED".to_string(),
            });
        }
    }

    // Block ~/.ssh/
    if let Some(home) = dirs::home_dir() {
        let ssh_dir = home.join(".ssh");
        if canonical.starts_with(&ssh_dir) {
            return Err(ApiError {
                error: "Access to ~/.ssh/ is not allowed".to_string(),
                code: "FS_PATH_DENIED".to_string(),
            });
        }
    }

    // Block the app's own database file
    let db_path = crate::db::default_db_path();
    if let Ok(db_canonical) = db_path.canonicalize() {
        if canonical == db_canonical {
            return Err(ApiError {
                error: "Access to the application database is not allowed".to_string(),
                code: "FS_PATH_DENIED".to_string(),
            });
        }
    }

    Ok(canonical)
}

#[derive(Deserialize)]
pub struct LocalFileReadRequest {
    pub path: String,
}

pub async fn local_file_read(
    Json(req): Json<LocalFileReadRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    let content = tokio::fs::read_to_string(&safe)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to read {}: {}", req.path, e),
            code: "FS_READ".to_string(),
        })?;
    Ok(Json(
        serde_json::json!({ "content": content, "path": req.path }),
    ))
}

/// Read a file as raw bytes and return base64. Used by the workspace image
/// viewer (and any other binary preview) since `local_file_read` uses
/// `read_to_string` which rejects non-UTF-8 input.
pub async fn local_file_read_binary(
    Json(req): Json<LocalFileReadRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let safe = validate_local_path(&req.path)?;
    let bytes = tokio::fs::read(&safe).await.map_err(|e| ApiError {
        error: format!("Failed to read {}: {}", req.path, e),
        code: "FS_READ".to_string(),
    })?;
    let encoded = STANDARD.encode(&bytes);
    Ok(Json(serde_json::json!({
        "content_base64": encoded,
        "size": bytes.len(),
        "path": req.path,
    })))
}

#[derive(Deserialize)]
pub struct LocalFileWriteRequest {
    pub path: String,
    pub content: String,
}

pub async fn local_file_write(
    Json(req): Json<LocalFileWriteRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    tokio::fs::write(&safe, &req.content)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to write {}: {}", req.path, e),
            code: "FS_WRITE".to_string(),
        })?;
    Ok(Json(
        serde_json::json!({ "success": true, "path": req.path, "bytes": req.content.len() }),
    ))
}

#[derive(Deserialize)]
pub struct LocalFileWriteBinaryRequest {
    pub path: String,
    pub content_base64: String,
}

pub async fn local_file_write_binary(
    Json(req): Json<LocalFileWriteBinaryRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use base64::Engine;
    let safe = validate_local_path(&req.path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.content_base64)
        .map_err(|e| ApiError {
            error: format!("Invalid base64: {}", e),
            code: "INVALID_INPUT".to_string(),
        })?;
    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&safe).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let byte_count = bytes.len();
    tokio::fs::write(&safe, &bytes)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to write {}: {}", req.path, e),
            code: "FS_WRITE".to_string(),
        })?;
    Ok(Json(
        serde_json::json!({ "success": true, "path": req.path, "bytes": byte_count }),
    ))
}

#[derive(Deserialize)]
pub struct LocalDirListRequest {
    pub path: String,
}

pub async fn local_dir_list(
    Json(req): Json<LocalDirListRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    let mut entries = Vec::new();
    // Cap the listing so enumerating a huge directory (e.g. "/") cannot produce a
    // multi-hundred-MB response and exhaust memory.
    const MAX_ENTRIES: usize = 10_000;
    let mut truncated = false;
    let mut dir = tokio::fs::read_dir(&safe).await.map_err(|e| ApiError {
        error: format!("Failed to read dir {}: {}", req.path, e),
        code: "FS_READDIR".to_string(),
    })?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| ApiError {
        error: e.to_string(),
        code: "FS_READDIR".to_string(),
    })? {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let metadata = entry.metadata().await.ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        entries.push(serde_json::json!({
            "name": name,
            "path": path,
            "is_dir": is_dir,
            "size": size,
            "modified": modified,
        }));
    }
    entries.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        let a_name = a["name"].as_str().unwrap_or("");
        let b_name = b["name"].as_str().unwrap_or("");
        a_name.to_lowercase().cmp(&b_name.to_lowercase())
    });
    Ok(Json(
        serde_json::json!({ "entries": entries, "path": req.path, "truncated": truncated }),
    ))
}

#[derive(Deserialize)]
pub struct LocalFileMkdirRequest {
    pub path: String,
}

pub async fn local_file_mkdir(
    Json(req): Json<LocalFileMkdirRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    tokio::fs::create_dir_all(&safe)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to mkdir {}: {}", req.path, e),
            code: "FS_MKDIR".to_string(),
        })?;
    Ok(Json(
        serde_json::json!({ "success": true, "path": req.path }),
    ))
}

#[derive(Deserialize)]
pub struct LocalFileDeleteRequest {
    pub path: String,
    pub is_dir: bool,
}

pub async fn local_file_delete(
    Json(req): Json<LocalFileDeleteRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    if req.is_dir {
        tokio::fs::remove_dir_all(&safe).await
    } else {
        tokio::fs::remove_file(&safe).await
    }
    .map_err(|e| ApiError {
        error: format!("Failed to delete {}: {}", req.path, e),
        code: "FS_DELETE".to_string(),
    })?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct LocalFileRenameRequest {
    pub from: String,
    pub to: String,
}

pub async fn local_file_rename(
    Json(req): Json<LocalFileRenameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe_from = validate_local_path(&req.from)?;
    let safe_to = validate_local_path(&req.to)?;
    tokio::fs::rename(&safe_from, &safe_to)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to rename: {}", e),
            code: "FS_RENAME".to_string(),
        })?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct LocalFileExistsRequest {
    pub path: String,
}

pub async fn local_file_exists(
    Json(req): Json<LocalFileExistsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    let exists = tokio::fs::try_exists(&safe).await.unwrap_or(false);
    Ok(Json(serde_json::json!({ "exists": exists })))
}

#[derive(Deserialize)]
pub struct LocalRunPythonRequest {
    pub path: String,
    pub main_args: Option<String>,
}

pub async fn local_run_python(
    Json(req): Json<LocalRunPythonRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    let content = tokio::fs::read_to_string(&safe)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to read {}: {}", req.path, e),
            code: "FS_READ".to_string(),
        })?;

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<SseEvent, Infallible>>(100);
    let main_args = req.main_args.clone();
    let path = req.path.clone();

    tokio::spawn(async move {
        let start = std::time::Instant::now();

        let _ = tx
            .send(Ok(SseEvent::default()
                .event("status")
                .data("Setting up Python runtime...")))
            .await;

        let uv = match crate::scripts::ensure_uv().await {
            Ok(uv) => uv,
            Err(e) => {
                let _ = tx
                    .send(Ok(SseEvent::default().event("error").data(e.error)))
                    .await;
                return;
            }
        };

        let _ = tx
            .send(Ok(SseEvent::default().event("status").data(format!(
                "Running {}...",
                path.split('/').next_back().unwrap_or(&path)
            ))))
            .await;

        let prepared = crate::scripts::prepare_script_for_run(&content, main_args.as_deref());

        let tmp_dir = std::env::temp_dir();
        let script_path = tmp_dir.join(format!("ns_ws_{}.py", uuid::Uuid::new_v4()));
        if let Err(e) = tokio::fs::write(&script_path, &prepared).await {
            let _ = tx
                .send(Ok(SseEvent::default()
                    .event("error")
                    .data(format!("Failed to write temp script: {}", e))))
                .await;
            return;
        }

        let mut cmd = tokio::process::Command::new(&uv);
        cmd.arg("run")
            .arg("--quiet")
            .arg("--script")
            .arg(&script_path);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(args) = &main_args {
            cmd.env("NETSTACKS_ARGS", args);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = tokio::fs::remove_file(&script_path).await;
                let _ = tx
                    .send(Ok(SseEvent::default()
                        .event("error")
                        .data(format!("Failed to start: {}", e))))
                    .await;
                return;
            }
        };

        let stderr = child.stderr.take();
        let stdout = child.stdout.take();
        let tx2 = tx.clone();

        if let Some(stderr) = stderr {
            let tx_err = tx2.clone();
            tokio::spawn(async move {
                let reader = tokio::io::BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx_err
                        .send(Ok(SseEvent::default().event("stderr").data(line)))
                        .await;
                }
            });
        }

        if let Some(stdout) = stdout {
            let tx_out = tx2.clone();
            tokio::spawn(async move {
                let reader = tokio::io::BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx_out
                        .send(Ok(SseEvent::default().event("stdout").data(line)))
                        .await;
                }
            });
        }

        // Wait for the child OR the SSE client to disconnect. Without the
        // second arm, a long-running script (or `while True: pass`) outlives
        // the user closing the tab — the spawn task keeps reading, the child
        // keeps running, until the process self-terminates.
        let status = tokio::select! {
            status = child.wait() => status,
            _ = tx.closed() => {
                tracing::warn!("SSE client disconnected mid-run — killing python process");
                let _ = child.kill().await;
                let _ = tokio::fs::remove_file(&script_path).await;
                return;
            }
        };
        let _ = tokio::fs::remove_file(&script_path).await;
        let duration_ms = start.elapsed().as_millis();
        let exit_code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

        let _ = tx
            .send(Ok(SseEvent::default().event("complete").data(
                serde_json::json!({
                    "exit_code": exit_code,
                    "duration_ms": duration_ms,
                })
                .to_string(),
            )))
            .await;
    });

    Ok(Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod netbox_console_access_tests {
    use super::*;
    use serde_json::json;

    fn port(device_id: i64, cf: serde_json::Value, cabled: bool) -> serde_json::Value {
        let mut v = json!({
            "id": 1, "name": "console", "device": {"id": device_id, "name": "edge"},
            "custom_fields": {"device_console": cf},
        });
        if cabled {
            v["connected_endpoints_type"] = json!("dcim.consoleserverport");
            v["connected_endpoints"] =
                json!([{"id": 9, "name": "port07", "device": {"id": 500, "name": "oob-den1"}}]);
        }
        v
    }

    #[test]
    fn parses_cabled_port_with_tcp_port() {
        let p = parse_console_port(&port(7, json!(3007), true)).unwrap();
        assert_eq!(p.device_id, 7);
        assert_eq!(p.server, Some((500, "oob-den1".to_string())));
        assert_eq!(p.tcp_port, Ok(3007));
        // String-typed custom fields are accepted too.
        let p = parse_console_port(&port(7, json!("2007"), true)).unwrap();
        assert_eq!(p.tcp_port, Ok(2007));
    }

    #[test]
    fn legacy_singular_connected_endpoint_is_accepted() {
        let mut v = port(7, json!(3007), false);
        v["connected_endpoint_type"] = json!("dcim.consoleserverport");
        v["connected_endpoint"] = json!({"id": 9, "device": {"id": 500, "name": "oob-den1"}});
        let p = parse_console_port(&v).unwrap();
        assert_eq!(p.server, Some((500, "oob-den1".to_string())));
    }

    #[test]
    fn interface_cable_is_not_a_console_server() {
        let mut v = port(7, json!(3007), true);
        v["connected_endpoints_type"] = json!("dcim.interface");
        assert_eq!(parse_console_port(&v).unwrap().server, None);
    }

    #[test]
    fn custom_field_validation() {
        assert!(parse_console_port(&port(7, json!(null), true))
            .unwrap()
            .tcp_port
            .unwrap_err()
            .contains("no `device_console`"));
        assert!(parse_console_port(&port(7, json!(0), true))
            .unwrap()
            .tcp_port
            .is_err());
        assert!(parse_console_port(&port(7, json!(70000), true))
            .unwrap()
            .tcp_port
            .is_err());
        assert!(parse_console_port(&port(7, json!("abc"), true))
            .unwrap()
            .tcp_port
            .is_err());
    }

    #[test]
    fn console_server_host_prefers_primary_ip4_then_oob_and_strips_cidr() {
        let s = parse_console_server(&json!({
            "id": 500, "name": "oob-den1",
            "primary_ip4": {"address": "10.9.0.5/24"}, "oob_ip": {"address": "192.0.2.1/32"},
            "device_type": {"manufacturer": {"slug": "Opengear"}},
        }))
        .unwrap();
        assert_eq!(s.host.as_deref(), Some("10.9.0.5"));
        assert_eq!(s.manufacturer_slug.as_deref(), Some("opengear"));
        let s = parse_console_server(&json!({"id": 501, "name": "ts", "primary_ip4": null, "oob_ip": {"address": "192.0.2.1/32"}})).unwrap();
        assert_eq!(s.host.as_deref(), Some("192.0.2.1"));
        let s = parse_console_server(&json!({"id": 502, "name": "ts"})).unwrap();
        assert_eq!(s.host, None);
    }

    #[test]
    fn resolution_picks_usable_port_and_reports_reasons() {
        let mut servers = std::collections::HashMap::new();
        servers.insert(
            500,
            NetBoxConsoleServerRef {
                id: 500,
                name: "oob-den1".into(),
                host: Some("10.9.0.5".into()),
                manufacturer_slug: Some("opengear".into()),
            },
        );
        servers.insert(
            501,
            NetBoxConsoleServerRef {
                id: 501,
                name: "ts-noip".into(),
                host: None,
                manufacturer_slug: None,
            },
        );

        let usable = parse_console_port(&port(7, json!(3007), true)).unwrap();
        let uncabled = parse_console_port(&port(7, json!(3007), false)).unwrap();
        let no_cf = parse_console_port(&port(7, json!(null), true)).unwrap();

        let r = resolve_console_access(7, &[uncabled.clone(), usable.clone()], &servers);
        assert_eq!(r.tcp_port, Some(3007));
        assert_eq!(
            r.console_server
                .as_ref()
                .and_then(|s| s.host.clone())
                .as_deref(),
            Some("10.9.0.5")
        );
        assert_eq!(r.skip_reason, None);

        assert_eq!(
            resolve_console_access(7, &[], &servers).skip,
            Some(ConsoleSkip::NoConsolePort)
        );
        assert_eq!(
            resolve_console_access(7, &[uncabled], &servers).skip,
            Some(ConsoleSkip::NotCabled)
        );
        assert_eq!(
            resolve_console_access(7, &[no_cf], &servers).skip,
            Some(ConsoleSkip::NoTcpPort)
        );

        let mut no_ip = usable;
        no_ip.server = Some((501, "ts-noip".into()));
        let r = resolve_console_access(7, &[no_ip], &servers);
        assert_eq!(r.skip, Some(ConsoleSkip::ServerNoIp));
        assert!(r.skip_reason.unwrap().contains("ts-noip"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_librenms_port_stats_converts_octets_to_bits() {
        // LibreNMS /api/v0/ports returns rates as bytes/sec; we convert to bits/sec.
        let v = serde_json::json!({
            "port_id": 101,
            "ifInOctets_rate": 31_250_000,   // 250 Mbps
            "ifOutOctets_rate": 12_500_000,  // 100 Mbps
            "ifSpeed": 1_000_000_000,        // 1 Gbps
            "ifInErrors": 5,
            "ifOutErrors": 0,
            "ifOperStatus": "up"
        });
        let stats = parse_librenms_port_stats(&v).expect("should parse");
        assert_eq!(stats.in_rate_bps, Some(250_000_000));
        assert_eq!(stats.out_rate_bps, Some(100_000_000));
        assert_eq!(stats.speed_bps, Some(1_000_000_000));
        assert_eq!(stats.in_errors, Some(5));
        assert_eq!(stats.out_errors, Some(0));
        assert_eq!(stats.oper_status.as_deref(), Some("up"));
    }

    #[test]
    fn parse_librenms_port_stats_handles_string_numbers() {
        // Some LibreNMS deployments serialize numeric fields as strings.
        let v = serde_json::json!({
            "ifInOctets_rate": "100",
            "ifOutOctets_rate": "200",
            "ifSpeed": "1000000000",
            "ifInErrors": "7",
            "ifOutErrors": "0",
            "ifOperStatus": "down"
        });
        let stats = parse_librenms_port_stats(&v).expect("should parse string numbers");
        assert_eq!(stats.in_rate_bps, Some(800)); // 100 bytes/s * 8
        assert_eq!(stats.out_rate_bps, Some(1600));
        assert_eq!(stats.speed_bps, Some(1_000_000_000));
        assert_eq!(stats.in_errors, Some(7));
        assert_eq!(stats.oper_status.as_deref(), Some("down"));
    }

    #[test]
    fn parse_librenms_port_stats_returns_none_for_non_object() {
        let v = serde_json::json!("not an object");
        assert!(parse_librenms_port_stats(&v).is_none());
    }

    #[test]
    fn parse_librenms_port_stats_missing_fields_are_none() {
        let v = serde_json::json!({ "port_id": 101 });
        let stats = parse_librenms_port_stats(&v).expect("empty object should still parse");
        assert!(stats.in_rate_bps.is_none());
        assert!(stats.speed_bps.is_none());
        assert!(stats.oper_status.is_none());
    }

    // ===== Phase 4: bulk topology import helpers =====

    #[test]
    fn classify_device_type_recognizes_switches() {
        assert_eq!(
            classify_device_type(Some("Catalyst 9300-48P"), Some("IOS-XE")),
            "switch"
        );
        assert_eq!(
            classify_device_type(Some("Nexus 9000"), Some("NX-OS")),
            "switch"
        );
        assert_eq!(
            classify_device_type(Some("DCS-7050"), Some("Arista EOS")),
            "switch"
        );
    }

    #[test]
    fn classify_device_type_recognizes_routers() {
        assert_eq!(
            classify_device_type(Some("ASR1001"), Some("IOS-XE")),
            "router"
        );
        assert_eq!(
            classify_device_type(Some("ISR4321"), Some("Cisco IOS")),
            "router"
        );
        assert_eq!(classify_device_type(Some("MX240"), Some("Junos")), "router");
    }

    #[test]
    fn classify_device_type_recognizes_firewalls() {
        assert_eq!(
            classify_device_type(Some("ASA 5525"), Some("Cisco ASA")),
            "firewall"
        );
        assert_eq!(
            classify_device_type(Some("FortiGate 100"), Some("FortiOS")),
            "firewall"
        );
        assert_eq!(
            classify_device_type(Some("PA-3220"), Some("PAN-OS")),
            "firewall"
        );
    }

    #[test]
    fn classify_device_type_unknown_when_unclear() {
        assert_eq!(
            classify_device_type(Some("Generic Box"), Some("Linux")),
            "unknown"
        );
        assert_eq!(classify_device_type(None, None), "unknown");
    }

    #[test]
    fn infer_vendor_picks_known_brands() {
        assert_eq!(
            infer_vendor(Some("Catalyst"), None).as_deref(),
            Some("Cisco")
        );
        assert_eq!(
            infer_vendor(None, Some("Arista EOS")).as_deref(),
            Some("Arista")
        );
        assert_eq!(
            infer_vendor(None, Some("Junos 22")).as_deref(),
            Some("Juniper")
        );
        assert_eq!(
            infer_vendor(Some("FortiGate"), None).as_deref(),
            Some("Fortinet")
        );
        assert_eq!(infer_vendor(Some("Generic"), Some("Linux")), None);
    }

    #[test]
    fn hostname_variants_returns_fqdn_and_short() {
        let v = hostname_variants("Edge-01.lab.example.com");
        assert!(v.contains(&"edge-01.lab.example.com".to_string()));
        assert!(v.contains(&"edge-01".to_string()));

        let s = hostname_variants("core-sw");
        assert_eq!(s, vec!["core-sw".to_string()]);

        let pad = hostname_variants("  Spine-01.DC1  ");
        assert!(pad.contains(&"spine-01.dc1".to_string()));
        assert!(pad.contains(&"spine-01".to_string()));
    }

    #[test]
    fn import_request_defaults_include_connections_true() {
        let req: LibreNmsImportTopologyRequest =
            serde_json::from_str(r#"{"topology_id": "t1"}"#).unwrap();
        assert!(req.include_connections);
        let req2: LibreNmsImportTopologyRequest =
            serde_json::from_str(r#"{"topology_id": "t1", "include_connections": false}"#).unwrap();
        assert!(!req2.include_connections);

        let crawler: NetStacksCrawlerImportTopologyRequest =
            serde_json::from_str(r#"{"topology_id": "t1"}"#).unwrap();
        assert!(crawler.include_connections);
    }

    // === End-to-end import tests against a real LocalDataProvider ===
    // These avoid HTTP by calling the pure-input helpers directly with
    // hand-rolled device/link payloads (the same shapes the proxy handlers
    // would deserialize from a real LibreNMS / Netdisco response).
    use crate::db::init_db;
    use crate::providers::local::LocalDataProvider;
    use crate::providers::DataProvider;
    use tempfile::tempdir;

    async fn import_test_provider() -> LocalDataProvider {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("imp.db");
        let pool = init_db(&db_path).await.unwrap();
        std::mem::forget(dir);
        LocalDataProvider::new(pool)
    }

    fn lib_dev(id: i64, hostname: &str, ip: &str, hw: &str, os: &str) -> LibreNmsDevice {
        LibreNmsDevice {
            device_id: id,
            hostname: hostname.to_string(),
            sys_name: Some(hostname.to_string()),
            ip: ip.to_string(),
            device_type: None,
            hardware: Some(hw.to_string()),
            os: Some(os.to_string()),
            status: 1,
        }
    }

    fn lib_link(
        id: i64,
        local_id: i64,
        local_port: &str,
        remote_host: &str,
        remote_port: &str,
    ) -> LibreNmsLink {
        LibreNmsLink {
            id,
            local_device_id: local_id,
            local_port_id: id * 100,
            local_port: local_port.to_string(),
            remote_hostname: remote_host.to_string(),
            remote_port: remote_port.to_string(),
            protocol: "lldp".to_string(),
            local_port_in_rate_bps: None,
            local_port_out_rate_bps: None,
            local_port_speed_bps: None,
            local_port_in_errors: None,
            local_port_out_errors: None,
            local_port_oper_status: None,
        }
    }

    #[tokio::test]
    async fn librenms_import_creates_devices_with_correct_fields() {
        let provider = import_test_provider().await;
        let topo = provider.create_topology("phase4").await.unwrap();

        let devs = vec![
            lib_dev(1, "core-sw-01", "10.0.0.1", "Catalyst 9300", "IOS-XE"),
            lib_dev(2, "edge-rtr-01", "10.0.0.2", "ASR1001-X", "IOS-XE"),
            lib_dev(3, "fw-01", "10.0.0.3", "ASA 5525-X", "Cisco ASA"),
        ];

        let resp = import_librenms_into_topology(&provider, &topo.id, devs, vec![], false)
            .await
            .unwrap();
        assert_eq!(resp.devices_created, 3);
        assert_eq!(resp.devices_skipped, 0);
        assert_eq!(resp.connections_created, 0);

        let created = provider.get_topology_devices(&topo.id).await.unwrap();
        assert_eq!(created.len(), 3);
        let by_name: std::collections::HashMap<String, &TopologyDevice> =
            created.iter().map(|d| (d.name.clone(), d)).collect();
        assert_eq!(by_name["core-sw-01"].device_type, "switch");
        assert_eq!(by_name["edge-rtr-01"].device_type, "router");
        assert_eq!(by_name["fw-01"].device_type, "firewall");
        assert_eq!(
            by_name["core-sw-01"].primary_ip.as_deref(),
            Some("10.0.0.1")
        );
        assert_eq!(by_name["core-sw-01"].vendor.as_deref(), Some("Cisco"));
        assert_eq!(
            by_name["core-sw-01"].model.as_deref(),
            Some("Catalyst 9300")
        );
    }

    #[tokio::test]
    async fn librenms_import_dedupes_by_name_and_ip() {
        let provider = import_test_provider().await;
        let topo = provider.create_topology("dedup").await.unwrap();

        // Pre-seed: device with same hostname
        provider
            .add_discovered_device(
                &topo.id,
                crate::providers::NewDiscoveredDevice {
                    name: "core-sw-01",
                    host: "10.0.0.1",
                    device_type: "switch",
                    x: 200.0,
                    y: 200.0,
                    profile_id: None,
                    snmp_profile_id: None,
                },
            )
            .await
            .unwrap();

        let devs = vec![
            lib_dev(1, "core-sw-01", "10.0.0.99", "Catalyst", "IOS"), // dup by name
            lib_dev(2, "new-sw-02", "10.0.0.1", "Catalyst", "IOS"),   // dup by IP
            lib_dev(3, "fresh-rtr", "10.0.0.5", "ASR1001", "IOS-XE"), // new
        ];
        let resp = import_librenms_into_topology(&provider, &topo.id, devs, vec![], false)
            .await
            .unwrap();
        assert_eq!(resp.devices_created, 1);
        assert_eq!(resp.devices_skipped, 2);
        let all = provider.get_topology_devices(&topo.id).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn librenms_import_creates_connections_when_both_endpoints_resolve() {
        let provider = import_test_provider().await;
        let topo = provider.create_topology("conn").await.unwrap();

        let devs = vec![
            lib_dev(1, "core-sw-01", "10.0.0.1", "Catalyst 9300", "IOS-XE"),
            lib_dev(2, "edge-rtr-01", "10.0.0.2", "ASR1001-X", "IOS-XE"),
        ];
        let links = vec![
            lib_link(1, 1, "Gi1/0/1", "edge-rtr-01", "Gi0/0/1"), // resolves both
            lib_link(2, 1, "Gi1/0/2", "EDGE-RTR-01.LAB", "Gi0/0/2"), // FQDN/case differ — resolves via short
            lib_link(3, 1, "Gi1/0/3", "unknown-host", "Gi0/0/1"),    // remote missing
            lib_link(4, 99, "X", "edge-rtr-01", "Y"),                // local missing
        ];

        let resp = import_librenms_into_topology(&provider, &topo.id, devs, links, true)
            .await
            .unwrap();
        assert_eq!(resp.devices_created, 2);
        // First two links should resolve and create. Last two skip.
        assert_eq!(resp.connections_created, 2);
        assert_eq!(resp.connections_skipped, 2);
    }

    #[tokio::test]
    async fn librenms_import_skips_connections_when_disabled() {
        let provider = import_test_provider().await;
        let topo = provider.create_topology("noconn").await.unwrap();
        let devs = vec![
            lib_dev(1, "a", "10.0.0.1", "switch", "ios"),
            lib_dev(2, "b", "10.0.0.2", "switch", "ios"),
        ];
        let links = vec![lib_link(1, 1, "p1", "b", "p2")];
        let resp = import_librenms_into_topology(&provider, &topo.id, devs, links, false)
            .await
            .unwrap();
        assert_eq!(resp.connections_created, 0);
        assert_eq!(resp.connections_skipped, 0);
    }

    fn crawler_dev(
        ip: &str,
        name: Option<&str>,
        dns: Option<&str>,
        model: &str,
        os: &str,
        vendor: Option<&str>,
    ) -> NetStacksCrawlerDevice {
        NetStacksCrawlerDevice {
            ip: ip.to_string(),
            dns: dns.map(String::from),
            name: name.map(String::from),
            model: Some(model.to_string()),
            os: Some(os.to_string()),
            os_ver: None,
            vendor: vendor.map(String::from),
            serial: None,
            uptime: None,
            last_discover: None,
        }
    }

    #[tokio::test]
    async fn crawler_import_dedupes_by_name_or_ip_and_creates_connections() {
        let provider = import_test_provider().await;
        let topo = provider.create_topology("crawler").await.unwrap();

        // Pre-seed a device by IP only
        provider
            .add_discovered_device(
                &topo.id,
                crate::providers::NewDiscoveredDevice {
                    name: "preexisting",
                    host: "192.168.1.10",
                    device_type: "switch",
                    x: 100.0,
                    y: 100.0,
                    profile_id: None,
                    snmp_profile_id: None,
                },
            )
            .await
            .unwrap();

        let devs = vec![
            crawler_dev(
                "192.168.1.10",
                Some("ignored-dup-ip"),
                None,
                "Catalyst",
                "IOS",
                None,
            ), // dup by IP
            crawler_dev(
                "192.168.1.20",
                Some("preexisting"),
                None,
                "ASA 5500",
                "ASA",
                None,
            ), // dup by name
            crawler_dev(
                "192.168.1.30",
                Some("core-sw-30"),
                Some("core-sw-30.lab"),
                "Catalyst 9300",
                "IOS-XE",
                Some("Cisco"),
            ),
            crawler_dev(
                "192.168.1.40",
                Some("edge-rtr-40"),
                None,
                "ASR1001",
                "IOS-XE",
                None,
            ),
        ];
        let links = vec![
            NetStacksCrawlerDeviceLink {
                left_ip: "192.168.1.30".into(),
                left_dns: None,
                left_port: Some("Gi1/0/1".into()),
                right_ip: "192.168.1.40".into(),
                right_dns: None,
                right_port: Some("Gi0/0/1".into()),
                speed: Some("1000".into()),
                protocol: Some("lldp".into()),
            },
            // Dangling — right device not in topo
            NetStacksCrawlerDeviceLink {
                left_ip: "192.168.1.30".into(),
                left_dns: None,
                left_port: Some("Gi1/0/2".into()),
                right_ip: "10.99.99.99".into(),
                right_dns: None,
                right_port: Some("X".into()),
                speed: None,
                protocol: None,
            },
        ];

        let resp = import_crawler_into_topology(&provider, &topo.id, devs, links, true)
            .await
            .unwrap();
        assert_eq!(resp.devices_created, 2);
        assert_eq!(resp.devices_skipped, 2);
        assert_eq!(resp.connections_created, 1);
        assert_eq!(resp.connections_skipped, 1);

        let conns = provider.get_topology_connections(&topo.id).await.unwrap();
        assert_eq!(conns.len(), 1);
        let conn = &conns[0];
        assert_eq!(conn.source_interface.as_deref(), Some("Gi1/0/1"));
        assert_eq!(conn.target_interface.as_deref(), Some("Gi0/0/1"));
    }

    #[test]
    fn librenms_links_query_defaults_stats_to_false() {
        // Default() must give stats=false so the existing structural
        // links endpoint stays cheap when no query param is supplied.
        let q = LibreNmsLinksQuery::default();
        assert!(!q.stats);
        // Deserialize from a JSON object as a simple format-agnostic check
        // that #[serde(default)] takes effect when the field is missing.
        let empty: LibreNmsLinksQuery = serde_json::from_str("{}").unwrap();
        assert!(!empty.stats);
        let enabled: LibreNmsLinksQuery = serde_json::from_str(r#"{"stats": true}"#).unwrap();
        assert!(enabled.stats);
    }
}

// ============================================================================
// Enrichment endpoints (Phase 2 — terminal intelligence)
// ============================================================================

/// POST /enrich — take a token + optional session context, return aggregated
/// enrichment from all configured sources for that token's matcher type.
pub async fn enrich_token(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::enrich::EnrichRequest>,
) -> Result<Json<crate::enrich::EnrichResponse>, ApiError> {
    let started = std::time::Instant::now();

    // Resolve CLI flavor: explicit param wins, else look up from session
    let mut cli_flavor: Option<String> = req.cli_flavor.clone();
    let mut session_host: String = "global".to_string();
    let mut session_ctx: Option<crate::enrich::pipeline::SessionContext> = None;
    if let Some(sid) = &req.session_id {
        if let Ok(session) = state.provider.get_session(sid).await {
            session_host = session.host.clone();
            session_ctx = Some(crate::enrich::pipeline::SessionContext {
                host: session.host.clone(),
                name: session.name.clone(),
            });
            if cli_flavor.is_none() {
                // CliFlavor uses `#[serde(rename_all = "kebab-case")]`, so serde
                // gives us "cisco-ios", "cisco-iosxr", "juniper", etc. — matches
                // the cli_flavors list in enrichment.toml.
                cli_flavor = serde_json::to_value(&session.cli_flavor)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
            }
        }
    }

    // Find the matching matcher (highest priority + cli-flavor compatible)
    let match_result = {
        let reg = state.enrichment.read().await;
        reg.find_matcher(&req.token, cli_flavor.as_deref())
    };
    let Some(m) = match_result else {
        return Ok(Json(crate::enrich::EnrichResponse {
            token: req.token.clone(),
            token_type: None,
            matcher_name: None,
            sources: std::collections::HashMap::new(),
            errors: std::collections::HashMap::new(),
            cached: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }));
    };

    // Cache check
    {
        let mut cache = state.enrichment_cache.write().await;
        if let Some((cached_matcher, cached_sources, cached_errors)) =
            cache.get(&session_host, &m.matcher_name, &m.token_normalized)
        {
            return Ok(Json(crate::enrich::EnrichResponse {
                token: req.token.clone(),
                token_type: Some(m.matcher_name.clone()),
                matcher_name: Some(cached_matcher),
                sources: cached_sources,
                errors: cached_errors,
                cached: true,
                elapsed_ms: started.elapsed().as_millis() as u64,
            }));
        }
    }

    // Detect which source backends are configured right now
    let active = crate::enrich::ActiveSources::detect(&state).await;

    // Run the pipeline in parallel
    let out = crate::enrich::Pipeline::run(
        &m.token_normalized,
        &m.enrich_sources,
        state.clone(),
        &active,
        session_ctx,
    )
    .await;

    // Cache the result. Cache errors alongside sources so a 429 doesn't
    // hammer the upstream again on every hover — the TTL (5min default) is
    // short enough that transient failures heal naturally.
    {
        let mut cache = state.enrichment_cache.write().await;
        cache.insert(
            &session_host,
            &m.matcher_name,
            &m.token_normalized,
            m.matcher_name.clone(),
            out.sources.clone(),
            out.errors.clone(),
        );
    }

    Ok(Json(crate::enrich::EnrichResponse {
        token: req.token.clone(),
        token_type: Some(m.matcher_name.clone()),
        matcher_name: Some(m.matcher_name),
        sources: out.sources,
        errors: out.errors,
        cached: false,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }))
}

/// POST /enrich/match — fast matcher-only lookup. Takes the same body as
/// /enrich but skips source execution. Returns the matcher hit + the list
/// of source names that *would* be run. The webview uses this so it can
/// render the popup skeleton (one section per source) before any source
/// data is back, then fire per-source requests in parallel via
/// /enrich/source.
#[derive(Debug, serde::Serialize)]
pub struct EnrichMatchResponse {
    pub token: String,
    pub token_normalized: String,
    pub matcher_name: Option<String>,
    pub source_names: Vec<String>,
}

pub async fn enrich_match(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::enrich::EnrichRequest>,
) -> Result<Json<EnrichMatchResponse>, ApiError> {
    let mut cli_flavor: Option<String> = req.cli_flavor.clone();
    if let Some(sid) = &req.session_id {
        if let Ok(session) = state.provider.get_session(sid).await {
            if cli_flavor.is_none() {
                cli_flavor = serde_json::to_value(&session.cli_flavor)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
            }
        }
    }
    let match_result = {
        let reg = state.enrichment.read().await;
        reg.find_matcher(&req.token, cli_flavor.as_deref())
    };
    let Some(m) = match_result else {
        return Ok(Json(EnrichMatchResponse {
            token: req.token.clone(),
            token_normalized: req.token.clone(),
            matcher_name: None,
            source_names: vec![],
        }));
    };
    // Filter source list to only those currently configured (mirrors what
    // Pipeline::run would actually execute).
    let available: Vec<String> = {
        let cache = state.enrichment_sources.read().await;
        m.enrich_sources
            .iter()
            .filter(|s| crate::enrich::ActiveSources::source_available_from_cache(&cache, s))
            .cloned()
            .collect()
    };
    Ok(Json(EnrichMatchResponse {
        token: req.token.clone(),
        token_normalized: m.token_normalized,
        matcher_name: Some(m.matcher_name),
        source_names: available,
    }))
}

/// POST /enrich/source — run a single source for a token. Used by the
/// webview after /enrich/match returns the source list: fires one of
/// these per source in parallel, renders each section as it completes,
/// so the popup is visible immediately instead of waiting for the
/// slowest source to finish.
#[derive(Debug, serde::Deserialize)]
pub struct EnrichSourceRequest {
    pub token: String,
    pub source: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct EnrichSourceResponse {
    pub source: String,
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub async fn enrich_source_one(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EnrichSourceRequest>,
) -> Result<Json<EnrichSourceResponse>, ApiError> {
    let session_ctx = if let Some(sid) = &req.session_id {
        match state.provider.get_session(sid).await {
            Ok(s) => Some(crate::enrich::pipeline::SessionContext {
                host: s.host.clone(),
                name: s.name.clone(),
            }),
            Err(_) => None,
        }
    } else {
        None
    };
    match crate::enrich::pipeline::run_one_source(
        &req.source,
        &req.token,
        state.clone(),
        session_ctx.as_ref(),
    )
    .await
    {
        Ok(value) => Ok(Json(EnrichSourceResponse {
            source: req.source.clone(),
            data: if value.is_null() { None } else { Some(value) },
            error: None,
        })),
        Err(err) => Ok(Json(EnrichSourceResponse {
            source: req.source.clone(),
            data: None,
            error: Some(err),
        })),
    }
}

/// GET /enrich/active-matchers — list matchers whose enrichment sources are
/// actually configured. The webview uses this to decide which token patterns
/// to scan for in terminal output.
pub async fn enrich_active_matchers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::enrich::ActiveMatchersResponse>, ApiError> {
    let sources_cache = state.enrichment_sources.read().await;

    let mut matchers = Vec::new();
    {
        let reg = state.enrichment.read().await;
        for m in reg.all_matchers() {
            let has_active_source = m.config.enrich.iter().any(|s| {
                crate::enrich::ActiveSources::source_available_from_cache(&sources_cache, s)
            });
            if !has_active_source {
                continue;
            }
            matchers.push(crate::enrich::ActiveMatcher {
                name: m.config.name.clone(),
                patterns: m.config.patterns.clone(),
                cli_flavors: m.config.cli_flavors.clone(),
                priority: m.config.priority,
            });
        }
    }

    let has_crawler = sources_cache
        .values()
        .any(|s| s.name.starts_with("crawler_") && s.api_resource_id.is_some());
    let has_netbox = sources_cache
        .values()
        .any(|s| s.name.starts_with("netbox_") && s.api_resource_id.is_some());

    Ok(Json(crate::enrich::ActiveMatchersResponse {
        matchers,
        crawler_available: has_crawler,
        netbox_available: has_netbox,
    }))
}

#[derive(serde::Serialize)]
pub struct EnrichmentReloadResponse {
    pub success: bool,
    pub matchers_loaded: usize,
    pub cache_ttl_seconds: u64,
}

/// POST /enrichment/reload — re-read the enrichment TOML and rebuild the
/// matcher registry in place. Called after the user edits enrichment.toml.
pub async fn enrich_reload(
    State(state): State<Arc<AppState>>,
) -> Result<Json<EnrichmentReloadResponse>, ApiError> {
    // Phase 5 — reload matchers + sources from DB. (TOML import is a separate
    // endpoint now; this just refreshes the in-memory caches.)
    let db_matchers = state.provider.list_enrichment_matchers().await?;
    let db_sources = state.provider.list_enrichment_sources().await?;
    let count = db_matchers.len();
    let ttl = 300u64; // default; per-user TTL deferred

    let sources_by_id: std::collections::HashMap<String, String> = db_sources
        .iter()
        .map(|s| (s.id.clone(), s.name.clone()))
        .collect();
    let sources_by_name: std::collections::HashMap<String, crate::models::EnrichmentSource> =
        db_sources
            .into_iter()
            .map(|s| (s.name.clone(), s))
            .collect();
    let new_registry = crate::enrich::MatcherRegistry::from_db(&db_matchers, &sources_by_id);

    {
        let mut reg = state.enrichment.write().await;
        *reg = new_registry;
    }
    {
        let mut src = state.enrichment_sources.write().await;
        *src = sources_by_name;
    }
    // Clear result cache so stale-keyed entries don't outlive the change
    {
        let mut cache = state.enrichment_cache.write().await;
        *cache = crate::enrich::EnrichmentCache::new(ttl);
    }
    tracing::info!(matchers_loaded = count, ttl, "enrichment reloaded from DB");
    Ok(Json(EnrichmentReloadResponse {
        success: true,
        matchers_loaded: count,
        cache_ttl_seconds: ttl,
    }))
}

// ============================================================================
// Phase 5 — Hover Enrichment Settings UI: CRUD + test endpoints
// ============================================================================

// --- Matchers ---

pub async fn list_enrichment_matchers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::models::EnrichmentMatcher>>, ApiError> {
    Ok(Json(state.provider.list_enrichment_matchers().await?))
}

pub async fn get_enrichment_matcher(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<crate::models::EnrichmentMatcher>, ApiError> {
    let m = state
        .provider
        .get_enrichment_matcher(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Matcher not found: {}", id),
            code: "NOT_FOUND".into(),
        })?;
    Ok(Json(m))
}

pub async fn create_enrichment_matcher(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::models::CreateEnrichmentMatcherRequest>,
) -> Result<(StatusCode, Json<crate::models::EnrichmentMatcher>), ApiError> {
    // Validate patterns compile before saving
    for p in &req.patterns {
        regex::Regex::new(p).map_err(|e| ApiError {
            error: format!("invalid regex '{}': {}", p, e),
            code: "VALIDATION".into(),
        })?;
    }
    let m = state.provider.create_enrichment_matcher(&req).await?;
    Ok((StatusCode::CREATED, Json(m)))
}

pub async fn update_enrichment_matcher(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<crate::models::UpdateEnrichmentMatcherRequest>,
) -> Result<StatusCode, ApiError> {
    // Built-in name is immutable
    if let Some(name) = &req.name {
        let existing = state
            .provider
            .get_enrichment_matcher(&id)
            .await?
            .ok_or_else(|| ApiError {
                error: format!("Matcher not found: {}", id),
                code: "NOT_FOUND".into(),
            })?;
        if existing.is_builtin && existing.name != *name {
            return Err(ApiError {
                error: "Built-in matcher name is immutable".into(),
                code: "VALIDATION".into(),
            });
        }
    }
    if let Some(patterns) = &req.patterns {
        for p in patterns {
            regex::Regex::new(p).map_err(|e| ApiError {
                error: format!("invalid regex '{}': {}", p, e),
                code: "VALIDATION".into(),
            })?;
        }
    }
    state.provider.update_enrichment_matcher(&id, &req).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_enrichment_matcher(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let existing = state
        .provider
        .get_enrichment_matcher(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Matcher not found: {}", id),
            code: "NOT_FOUND".into(),
        })?;
    if existing.is_builtin {
        return Err(ApiError {
            error: "Built-in matchers can't be deleted".into(),
            code: "VALIDATION".into(),
        });
    }
    state.provider.delete_enrichment_matcher(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, serde::Deserialize)]
pub struct TestMatcherRequest {
    pub patterns: Vec<String>,
    pub sample_text: String,
}

#[derive(Debug, serde::Serialize)]
pub struct MatcherTestMatch {
    pub pattern: String,
    pub matches: Vec<MatcherTestMatchRange>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct MatcherTestMatchRange {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

pub async fn test_matcher(
    Json(req): Json<TestMatcherRequest>,
) -> Result<Json<Vec<MatcherTestMatch>>, ApiError> {
    let out: Vec<MatcherTestMatch> = req
        .patterns
        .iter()
        .map(|p| match regex::Regex::new(p) {
            Ok(re) => MatcherTestMatch {
                pattern: p.clone(),
                matches: re
                    .find_iter(&req.sample_text)
                    .map(|m| MatcherTestMatchRange {
                        start: m.start(),
                        end: m.end(),
                        text: m.as_str().to_string(),
                    })
                    .collect(),
                error: None,
            },
            Err(e) => MatcherTestMatch {
                pattern: p.clone(),
                matches: vec![],
                error: Some(e.to_string()),
            },
        })
        .collect();
    Ok(Json(out))
}

#[derive(Debug, serde::Deserialize)]
pub struct ReplaceMatcherSourcesRequest {
    pub source_ids: Vec<String>,
}

pub async fn replace_matcher_sources(
    State(state): State<Arc<AppState>>,
    Path(matcher_id): Path<String>,
    Json(req): Json<ReplaceMatcherSourcesRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .provider
        .replace_matcher_sources(&matcher_id, &req.source_ids)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Sources ---

pub async fn list_enrichment_sources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::models::EnrichmentSource>>, ApiError> {
    Ok(Json(state.provider.list_enrichment_sources().await?))
}

pub async fn get_enrichment_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<crate::models::EnrichmentSource>, ApiError> {
    let s = state
        .provider
        .get_enrichment_source(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Source not found: {}", id),
            code: "NOT_FOUND".into(),
        })?;
    Ok(Json(s))
}

pub async fn create_enrichment_source(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::models::CreateEnrichmentSourceRequest>,
) -> Result<(StatusCode, Json<crate::models::EnrichmentSource>), ApiError> {
    let s = state.provider.create_enrichment_source(&req).await?;
    Ok((StatusCode::CREATED, Json(s)))
}

pub async fn update_enrichment_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<crate::models::UpdateEnrichmentSourceRequest>,
) -> Result<StatusCode, ApiError> {
    if let Some(name) = &req.name {
        let existing = state
            .provider
            .get_enrichment_source(&id)
            .await?
            .ok_or_else(|| ApiError {
                error: format!("Source not found: {}", id),
                code: "NOT_FOUND".into(),
            })?;
        if existing.is_builtin && existing.name != *name {
            return Err(ApiError {
                error: "Built-in source name is immutable".into(),
                code: "VALIDATION".into(),
            });
        }
    }
    state.provider.update_enrichment_source(&id, &req).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_enrichment_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let existing = state
        .provider
        .get_enrichment_source(&id)
        .await?
        .ok_or_else(|| ApiError {
            error: format!("Source not found: {}", id),
            code: "NOT_FOUND".into(),
        })?;
    if existing.is_builtin {
        return Err(ApiError {
            error: "Built-in sources can't be deleted".into(),
            code: "VALIDATION".into(),
        });
    }
    state.provider.delete_enrichment_source(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, serde::Deserialize)]
pub struct TestEnrichmentSourceRequest {
    pub api_resource_id: Option<String>,
    #[serde(default = "default_test_method")]
    pub method: String,
    pub path_template: String,
    #[serde(default)]
    pub response_unwrap: String,
    pub sample_token: String,
    pub sample_session_host: Option<String>,
    pub sample_session_name: Option<String>,
}
fn default_test_method() -> String {
    "GET".into()
}

#[derive(Debug, serde::Serialize)]
pub struct EnrichmentSourceTestResult {
    pub success: bool,
    pub status_code: Option<u16>,
    pub duration_ms: u64,
    pub url: String,
    pub raw_response: Option<serde_json::Value>,
    pub unwrapped: Option<serde_json::Value>,
    pub flattened_keys: Vec<String>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

pub async fn test_enrichment_source(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TestEnrichmentSourceRequest>,
) -> Result<Json<EnrichmentSourceTestResult>, ApiError> {
    let started = std::time::Instant::now();
    let Some(api_id) = req.api_resource_id else {
        return Ok(Json(EnrichmentSourceTestResult {
            success: false,
            status_code: None,
            duration_ms: 0,
            url: req.path_template,
            raw_response: None,
            unwrapped: None,
            flattened_keys: vec![],
            error: Some("No API resource selected".into()),
            raw_text: None,
            content_type: None,
        }));
    };

    // Substitute template (same logic as the pipeline)
    let session_host = req.sample_session_host.clone().unwrap_or_default();
    let session_name = req.sample_session_name.clone().unwrap_or_default();
    // Mirror pipeline substitution semantics. `{session_host_ip}` is
    // DNS-resolved only when the marker appears (avoid blocking on every
    // test call). If session_host is already an IP, use it as-is.
    let host_ip = if req.path_template.contains("{session_host_ip}")
        || req.response_unwrap.contains("{session_host_ip}")
    {
        crate::enrich::pipeline::resolve_session_host_ip_pub(&session_host)
    } else {
        String::new()
    };
    let path = req
        .path_template
        .replace("{token_url}", &urlencoding::encode(&req.sample_token))
        .replace("{token}", &req.sample_token)
        .replace("{session_host_ip}", &host_ip)
        .replace("{session_host}", &session_host)
        .replace("{sessions_host}", &session_host)
        .replace("{session_name}", &session_name);

    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider,
        &api_id,
        Some(&state.auth_cache),
    )
    .await
    .map_err(|e| ApiError {
        error: format!("client: {}", e),
        code: "VALIDATION".into(),
    })?;

    // Use the unified execute() path (handles substitution + multi-step auth).
    // status_code == 0 means the request never made it onto the wire.
    let exec = client
        .execute(
            &req.method.to_uppercase(),
            &path,
            &serde_json::json!({}),
            None,
            None,
            &std::collections::HashMap::new(),
        )
        .await;
    let raw_text = exec.raw_text.clone();
    let content_type = exec.content_type.clone();
    let result: Result<(u16, serde_json::Value), String> = if exec.status_code == 0 {
        Err(exec.error.unwrap_or_else(|| "request failed".into()))
    } else {
        Ok((
            exec.status_code,
            exec.raw_body.unwrap_or(serde_json::Value::Null),
        ))
    };

    let elapsed = started.elapsed().as_millis() as u64;
    let full_url = path.to_string(); // path only (base_url is internal to client)
    match result {
        Ok((status, body)) => {
            // Substitute the same template vars in response_unwrap so JSONPath
            // expressions referencing session context work in the test endpoint
            // exactly like they do in the pipeline. Mirror the pipeline alias
            // set ({sessions_host}, {session_host_ip}).
            let unwrap_resolved = req
                .response_unwrap
                .replace("{token_url}", &urlencoding::encode(&req.sample_token))
                .replace("{token}", &req.sample_token)
                .replace("{session_host_ip}", &host_ip)
                .replace("{session_host}", &session_host)
                .replace("{sessions_host}", &session_host)
                .replace("{session_name}", &session_name);
            let unwrapped = if unwrap_resolved.is_empty() {
                body.clone()
            } else {
                walk_path(&body, &unwrap_resolved)
            };
            let keys = flatten_json_keys(&unwrapped, "");
            Ok(Json(EnrichmentSourceTestResult {
                success: (200..300).contains(&status),
                status_code: Some(status),
                duration_ms: elapsed,
                url: full_url,
                raw_response: Some(body),
                unwrapped: Some(unwrapped),
                flattened_keys: keys,
                error: None,
                raw_text,
                content_type,
            }))
        }
        Err(e) => Ok(Json(EnrichmentSourceTestResult {
            success: false,
            status_code: None,
            duration_ms: elapsed,
            url: full_url,
            raw_response: None,
            unwrapped: None,
            flattened_keys: vec![],
            error: Some(e),
            raw_text,
            content_type,
        })),
    }
}

/// Normalize a JSON path: convert `[n]` bracket notation to dotted form
/// (`ips[0].name` → `ips.0.name`) and drop empty segments. Lets the UI accept
/// either notation interchangeably.
fn normalize_path(path: &str) -> String {
    path.replace('[', ".")
        .replace(']', "")
        .split('.')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(".")
}

/// Walk a JSON value by either a JSONPath expression (path starts with `$`)
/// OR a dotted/bracket path (`ips.0.name`, `ips[0].name`).
///
/// JSONPath returns the single matched value (or first match for array results)
/// to match the picker's first-hit semantics. Returns Null on failure for
/// graceful degradation in the hover popup.
pub(crate) fn walk_path(value: &serde_json::Value, path: &str) -> serde_json::Value {
    if path.is_empty() {
        return value.clone();
    }
    let trimmed = path.trim();
    if trimmed.starts_with('$') {
        match serde_json_path::JsonPath::parse(trimmed) {
            Ok(jp) => {
                let nodes: Vec<&serde_json::Value> = jp.query(value).all();
                match nodes.len() {
                    0 => serde_json::Value::Null,
                    1 => nodes[0].clone(),
                    _ => serde_json::Value::Array(nodes.into_iter().cloned().collect()),
                }
            }
            Err(_) => serde_json::Value::Null,
        }
    } else {
        let normalized = normalize_path(trimmed);
        if normalized.is_empty() {
            return value.clone();
        }
        let mut cur = value;
        for part in normalized.split('.') {
            cur = match cur {
                serde_json::Value::Object(m) => m.get(part).unwrap_or(&serde_json::Value::Null),
                serde_json::Value::Array(a) => match part.parse::<usize>() {
                    Ok(i) => a.get(i).unwrap_or(&serde_json::Value::Null),
                    Err(_) => return serde_json::Value::Null,
                },
                _ => return serde_json::Value::Null,
            };
        }
        cur.clone()
    }
}

// --- TOML export / import ---

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct EnrichmentExportToml {
    #[serde(default, rename = "matcher", skip_serializing_if = "Vec::is_empty")]
    matchers: Vec<MatcherToml>,
    #[serde(default, rename = "source", skip_serializing_if = "Vec::is_empty")]
    sources: Vec<SourceToml>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MatcherToml {
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    patterns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    cli_flavors: Vec<String>,
    #[serde(default = "default_export_priority")]
    priority: i32,
    /// Source names assigned to this matcher (joined from enrichment_matcher_sources).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sources: Vec<String>,
}
fn default_export_priority() -> i32 {
    10
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct SourceToml {
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default = "default_source_kind_toml")]
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_resource_id: Option<String>,
    /// Convenience for human editors: NAME of the API resource. On import we
    /// resolve to id; exported as a comment-friendly value alongside the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_resource_name: Option<String>,
    #[serde(default = "default_source_method_toml")]
    method: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    path_template: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    response_unwrap: String,
    #[serde(default)]
    picked_fields: Vec<crate::models::PickedField>,
}
fn default_source_kind_toml() -> String {
    "api_resource".into()
}
fn default_source_method_toml() -> String {
    "GET".into()
}

/// Export current matchers + sources + assignments to TOML for backup or
/// version control. Sources are referenced by NAME inside matcher entries
/// (rather than id) so the file is portable across installs.
pub async fn enrichment_export(State(state): State<Arc<AppState>>) -> Result<String, ApiError> {
    let matchers = state.provider.list_enrichment_matchers().await?;
    let sources = state.provider.list_enrichment_sources().await?;
    let api_resources = state
        .provider
        .list_api_resources()
        .await
        .unwrap_or_default();
    let api_name_by_id: std::collections::HashMap<String, String> = api_resources
        .iter()
        .map(|r| (r.id.clone(), r.name.clone()))
        .collect();
    let source_name_by_id: std::collections::HashMap<String, String> = sources
        .iter()
        .map(|s| (s.id.clone(), s.name.clone()))
        .collect();

    let export = EnrichmentExportToml {
        matchers: matchers
            .into_iter()
            .map(|m| MatcherToml {
                name: m.name,
                description: m.description,
                patterns: m.patterns,
                cli_flavors: m.cli_flavors,
                priority: m.priority,
                sources: m
                    .source_ids
                    .into_iter()
                    .filter_map(|sid| source_name_by_id.get(&sid).cloned())
                    .collect(),
            })
            .collect(),
        sources: sources
            .into_iter()
            .map(|s| SourceToml {
                name: s.name,
                description: s.description,
                kind: s.kind,
                api_resource_name: s
                    .api_resource_id
                    .as_ref()
                    .and_then(|id| api_name_by_id.get(id).cloned()),
                api_resource_id: s.api_resource_id,
                method: s.method,
                path_template: s.path_template,
                response_unwrap: s.response_unwrap,
                picked_fields: s.picked_fields,
            })
            .collect(),
    };

    toml::to_string_pretty(&export).map_err(|e| ApiError {
        error: format!("toml serialize: {}", e),
        code: "EXPORT_FAILED".into(),
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct EnrichmentImportRequest {
    pub toml: String,
    /// If true, replace existing rows by name. If false (default), only insert
    /// rows that don't already exist (safe append).
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct EnrichmentImportResult {
    pub matchers_added: usize,
    pub matchers_updated: usize,
    pub sources_added: usize,
    pub sources_updated: usize,
    pub assignments_updated: usize,
}

/// Import enrichment config from TOML. Matchers and sources are matched by
/// NAME — that's the stable identifier across machines. Cross-references
/// (matcher.sources = ["foo", "bar"]) are resolved to source IDs at import time.
/// Built-in rows can be updated but not renamed (handled by the regular
/// update validation).
pub async fn enrichment_import(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EnrichmentImportRequest>,
) -> Result<Json<EnrichmentImportResult>, ApiError> {
    let parsed: EnrichmentExportToml = toml::from_str(&req.toml).map_err(|e| ApiError {
        error: format!("invalid TOML: {}", e),
        code: "VALIDATION".into(),
    })?;

    let existing_matchers = state.provider.list_enrichment_matchers().await?;
    let existing_sources = state.provider.list_enrichment_sources().await?;
    let api_resources = state
        .provider
        .list_api_resources()
        .await
        .unwrap_or_default();
    let api_id_by_name: std::collections::HashMap<String, String> = api_resources
        .iter()
        .map(|r| (r.name.clone(), r.id.clone()))
        .collect();

    let mut result = EnrichmentImportResult {
        matchers_added: 0,
        matchers_updated: 0,
        sources_added: 0,
        sources_updated: 0,
        assignments_updated: 0,
    };

    // Sources first — matchers reference them by name
    for s in parsed.sources {
        let resolved_api_id = s.api_resource_id.clone().or_else(|| {
            s.api_resource_name
                .and_then(|n| api_id_by_name.get(&n).cloned())
        });
        if let Some(existing) = existing_sources.iter().find(|x| x.name == s.name) {
            if req.overwrite {
                let upd = crate::models::UpdateEnrichmentSourceRequest {
                    name: None,
                    description: Some(s.description),
                    api_resource_id: Some(resolved_api_id),
                    method: Some(s.method),
                    path_template: Some(s.path_template),
                    response_unwrap: Some(s.response_unwrap),
                    picked_fields: Some(s.picked_fields),
                };
                state
                    .provider
                    .update_enrichment_source(&existing.id, &upd)
                    .await?;
                result.sources_updated += 1;
            }
        } else {
            let req_create = crate::models::CreateEnrichmentSourceRequest {
                name: s.name,
                description: s.description,
                kind: s.kind,
                api_resource_id: resolved_api_id,
                method: s.method,
                path_template: s.path_template,
                response_unwrap: s.response_unwrap,
                picked_fields: s.picked_fields,
            };
            state.provider.create_enrichment_source(&req_create).await?;
            result.sources_added += 1;
        }
    }

    // Re-read source name → id after possibly inserting new sources
    let all_sources = state.provider.list_enrichment_sources().await?;
    let source_id_by_name: std::collections::HashMap<String, String> = all_sources
        .iter()
        .map(|s| (s.name.clone(), s.id.clone()))
        .collect();

    for m in parsed.matchers {
        let matcher_id = if let Some(existing) = existing_matchers.iter().find(|x| x.name == m.name)
        {
            if req.overwrite {
                let upd = crate::models::UpdateEnrichmentMatcherRequest {
                    name: None,
                    description: Some(m.description),
                    patterns: Some(m.patterns),
                    cli_flavors: Some(m.cli_flavors),
                    priority: Some(m.priority),
                };
                state
                    .provider
                    .update_enrichment_matcher(&existing.id, &upd)
                    .await?;
                result.matchers_updated += 1;
            }
            existing.id.clone()
        } else {
            let req_create = crate::models::CreateEnrichmentMatcherRequest {
                name: m.name,
                description: m.description,
                patterns: m.patterns,
                cli_flavors: m.cli_flavors,
                priority: m.priority,
            };
            let created = state
                .provider
                .create_enrichment_matcher(&req_create)
                .await?;
            result.matchers_added += 1;
            created.id
        };

        if !m.sources.is_empty() {
            let source_ids: Vec<String> = m
                .sources
                .into_iter()
                .filter_map(|name| source_id_by_name.get(&name).cloned())
                .collect();
            state
                .provider
                .replace_matcher_sources(&matcher_id, &source_ids)
                .await?;
            result.assignments_updated += 1;
        }
    }

    Ok(Json(result))
}

/// Flatten a JSON value into dotted-path keys for the field-picker checkboxes.
/// Walks objects recursively; arrays use `0`, `1`, etc. as path segments.
/// Returns leaf keys only (no intermediate object paths).
fn flatten_json_keys(value: &serde_json::Value, prefix: &str) -> Vec<String> {
    let mut out = Vec::new();
    match value {
        serde_json::Value::Object(m) => {
            for (k, v) in m {
                let next = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                match v {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        out.extend(flatten_json_keys(v, &next));
                    }
                    _ => out.push(next),
                }
            }
        }
        serde_json::Value::Array(a) => {
            for (i, v) in a.iter().enumerate().take(3) {
                // cap at 3 to avoid mega-lists
                let next = if prefix.is_empty() {
                    i.to_string()
                } else {
                    format!("{}.{}", prefix, i)
                };
                match v {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        out.extend(flatten_json_keys(v, &next));
                    }
                    _ => out.push(next),
                }
            }
        }
        _ => {}
    }
    out
}

// === Backup & Seed: whole-database export / import ===
//
// Export copies the entire SQLite DB (every table, configured or not) to a
// user-chosen path. A "shareable" export strips all secret material. Import
// validates the chosen DB and stages it; the agent swaps it in on next startup
// (the only safe time to replace an open SQLite file), so the UI relaunches after.

#[derive(serde::Deserialize)]
pub struct DbExportRequest {
    /// Absolute destination path chosen via the native save dialog.
    pub path: String,
    /// true = full backup (includes secrets); false = shareable seed (secrets stripped).
    #[serde(default = "default_true_db")]
    pub include_vault: bool,
}
fn default_true_db() -> bool {
    true
}

pub async fn db_export(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DbExportRequest>,
) -> Result<StatusCode, ApiError> {
    crate::db_backup::export_db(&state.pool, &req.path, req.include_vault)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "DATABASE_ERROR".to_string(),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct DbImportRequest {
    /// Absolute path of the .db file chosen via the native open dialog.
    pub path: String,
}

pub async fn db_import(
    State(_state): State<Arc<AppState>>,
    Json(req): Json<DbImportRequest>,
) -> Result<StatusCode, ApiError> {
    let db_path = crate::db::resolve_db_path();
    crate::db_backup::validate_and_stage(&db_path, &req.path)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "VALIDATION".to_string(),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

// --- DB info / reset / path ---

#[derive(serde::Serialize)]
pub struct DbInfoResponse {
    pub path: String,
    pub dir: String,
    pub size_bytes: u64,
}

pub async fn db_info() -> Json<DbInfoResponse> {
    let path = crate::db::resolve_db_path();
    let dir = path
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Json(DbInfoResponse {
        path: path.display().to_string(),
        dir,
        size_bytes,
    })
}

pub async fn db_reset(State(state): State<Arc<AppState>>) -> Result<StatusCode, ApiError> {
    let db_path = crate::db::resolve_db_path();
    crate::db_backup::stage_reset(&state.pool, &db_path)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "DATABASE_ERROR".to_string(),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct DbSetPathRequest {
    pub path: String,
}

pub async fn db_set_path(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DbSetPathRequest>,
) -> Result<StatusCode, ApiError> {
    let new_path = std::path::PathBuf::from(&req.path);
    crate::db_backup::move_db(&state.pool, &new_path)
        .await
        .map_err(|e| ApiError {
            error: e,
            code: "DATABASE_ERROR".to_string(),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn db_clear_path() -> Result<StatusCode, ApiError> {
    crate::db_backup::clear_db_path_config().map_err(|e| ApiError {
        error: e,
        code: "CONFIG_ERROR".to_string(),
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod mop_tests {
    use super::*;
    use crate::providers::local::tests::setup_provider;

    fn shell_result(
        status: ssh::CommandStatus,
        output: &str,
        error: Option<&str>,
    ) -> ssh::ShellCommandResult {
        ssh::ShellCommandResult {
            step_id: "s1".to_string(),
            status,
            output: output.to_string(),
            error: error.map(|e| e.to_string()),
            execution_time_ms: 5,
            transcript: String::new(),
        }
    }

    fn cli_step(id: &str, step_type: MopStepType, order: i32, source: &str) -> MopExecutionStep {
        MopExecutionStep::new(NewMopExecutionStep {
            execution_device_id: id.to_string(),
            step_order: order,
            step_type,
            command: "show version".to_string(),
            description: None,
            expected_output: None,
            mock_enabled: false,
            mock_output: None,
            execution_source: source.to_string(),
            quick_action_id: None,
            quick_action_variables: None,
            script_id: None,
            script_args: None,
            paired_step_id: None,
            output_format: None,
        })
    }

    // --- assertions -------------------------------------------------------

    #[test]
    fn assertions_contains_not_contains_regex() {
        let output = "Interface Gi0/1 is up, line protocol is up\nBGP state = Established";
        let (results, failed) = evaluate_assertions(
            "CONTAINS: line protocol is up\nNOT_CONTAINS: administratively down\nREGEX: BGP state = (Established|Idle)",
            output,
        );
        assert!(!failed);
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.passed), "{:?}", results);
        assert_eq!(results[0].assertion, "CONTAINS: line protocol is up");
        assert_eq!(results[1].assertion, "NOT_CONTAINS: administratively down");
        assert!(results[2].detail.contains("Established"));

        let (results, failed) = evaluate_assertions("CONTAINS: Gi0/2", output);
        assert!(failed);
        assert!(!results[0].passed);

        let (results, failed) = evaluate_assertions("NOT_CONTAINS: Established", output);
        assert!(failed);
        assert!(!results[0].passed);

        let (results, failed) = evaluate_assertions("REGEX: ^Idle$", output);
        assert!(failed);
        assert_eq!(results[0].detail, "pattern did not match");

        let (results, failed) = evaluate_assertions("REGEX: (unclosed", output);
        assert!(failed, "an invalid regex is a failed assertion, not a pass");
        assert!(results[0].detail.starts_with("invalid regex"));
    }

    #[test]
    fn plain_text_expected_output_is_advisory_only() {
        let (results, failed) = evaluate_assertions(
            "line protocol is down\n\n  \n",
            "Gi0/1 is up, line protocol is up",
        );
        assert!(!failed, "plain reference text must never fail the step");
        assert_eq!(results.len(), 1, "blank lines are ignored");
        assert_eq!(results[0].assertion, "TEXT: line protocol is down");
        assert!(!results[0].passed);
        assert!(results[0].detail.contains("advisory"));

        // Mixed: a structured miss fails even when the TEXT line matches.
        let (_, failed) = evaluate_assertions("Gi0/1 is up\nCONTAINS: Gi0/9", "Gi0/1 is up");
        assert!(failed);
    }

    #[test]
    fn with_assertions_only_demotes_passed_steps() {
        let passed = StepEvaluation {
            status: StepExecutionStatus::Passed,
            output: "state Idle".to_string(),
            error_message: None,
            assertion_results: None,
        }
        .with_assertions(Some("CONTAINS: Established"));
        assert_eq!(passed.status, StepExecutionStatus::Failed);
        assert!(passed
            .error_message
            .as_deref()
            .unwrap()
            .starts_with("assertion failed: CONTAINS: Established"));

        let already_failed = StepEvaluation::failed("boom".to_string(), "transport")
            .with_assertions(Some("CONTAINS: boom"));
        assert_eq!(already_failed.status, StepExecutionStatus::Failed);
        assert_eq!(
            already_failed.error_message.as_deref(),
            Some("transport"),
            "original error is kept"
        );
        assert_eq!(
            already_failed.assertion_results.as_ref().map(|r| r.len()),
            Some(1),
            "results still recorded"
        );

        let untouched = StepEvaluation::failed(String::new(), "x").with_assertions(Some("   "));
        assert!(
            untouched.assertion_results.is_none(),
            "blank expected_output records nothing"
        );
    }

    // --- vendor error markers ---------------------------------------------

    #[test]
    fn vendor_error_markers_fail_network_cli_output() {
        let cases = [
            (
                "cisco-ios",
                "sh ip int brie\n         ^\n% Invalid input detected at '^' marker.",
                "% Invalid input",
            ),
            (
                "cisco-ios",
                "conf\n% Ambiguous command:  \"conf\"",
                "% Ambiguous command",
            ),
            (
                "cisco-ios",
                "interface\n% Incomplete command.",
                "% Incomplete command",
            ),
            (
                "cisco-nxos",
                "foo\n% Invalid command at '^' marker.",
                "% Invalid command",
            ),
            (
                "juniper",
                "show foo\nsyntax error, expecting <command>.",
                "syntax error",
            ),
            ("juniper", "unknown command.", "unknown command"),
            (
                "juniper",
                "error: configuration check-out failed",
                "error: ",
            ),
            ("arista", "% Unknown command", "% Unknown command"),
            ("paloalto", "Invalid command: foo", "Invalid command"),
            ("fortinet", "Command fail. Return code -61", "Command fail"),
        ];
        for (flavor, output, marker) in cases {
            let hit = detect_vendor_error(output, "cmd", Some(flavor));
            assert!(
                hit.as_deref().map(|l| l.contains(marker)).unwrap_or(false),
                "{} / {:?} → {:?}",
                flavor,
                output,
                hit
            );
        }
        assert!(detect_vendor_error(
            "Building configuration...\n[OK]",
            "write memory",
            Some("cisco-ios")
        )
        .is_none());
        // Underscore spelling from the contract is tolerated.
        assert!(detect_vendor_error("% Invalid input", "x", Some("cisco_ios")).is_some());
        // No flavor at all still scans (a Cisco box on `auto` must not pass `% Invalid input`).
        assert!(detect_vendor_error("% Invalid input detected", "x", None).is_some());
    }

    #[test]
    fn vendor_error_scan_skips_echo_and_relaxes_for_linux() {
        // The echoed command line itself must not trip the scanner.
        assert!(detect_vendor_error(
            "show log | include syntax error\n<no lines>",
            "show log | include syntax error",
            Some("cisco-ios")
        )
        .is_none());
        // Linux: only `command not found` counts …
        assert_eq!(
            detect_vendor_error("-bash: fooo: command not found", "fooo", Some("linux")).as_deref(),
            Some("-bash: fooo: command not found")
        );
        // … while ordinary output that mentions "error"/"syntax error" passes.
        assert!(detect_vendor_error(
            "error: something in a log line\nsyntax error in file.py",
            "cat log",
            Some("linux")
        )
        .is_none());
        assert!(detect_vendor_error("Invalid command", "cat log", Some("linux")).is_none());
    }

    #[test]
    fn evaluate_cli_step_transport_statuses() {
        let timeout = std::time::Duration::from_secs(60);
        let ok = evaluate_cli_step(
            &shell_result(ssh::CommandStatus::Success, "uptime 1d", None),
            "show",
            None,
            Some("cisco-ios"),
            timeout,
        );
        assert_eq!(ok.status, StepExecutionStatus::Passed);
        assert_eq!(ok.output, "uptime 1d", "output is the step's own output");
        assert!(ok.error_message.is_none());

        let t = evaluate_cli_step(
            &shell_result(ssh::CommandStatus::Timeout, "", Some("Timed out")),
            "show",
            None,
            None,
            timeout,
        );
        assert_eq!(t.status, StepExecutionStatus::Failed);
        assert_eq!(
            t.error_message.as_deref(),
            Some("command timed out after 60s")
        );

        let nr = evaluate_cli_step(
            &shell_result(
                ssh::CommandStatus::NotRun,
                "",
                Some("not run: previous command timed out"),
            ),
            "show",
            Some("CONTAINS: x"),
            None,
            timeout,
        );
        assert_eq!(nr.status, StepExecutionStatus::Skipped);
        assert_eq!(
            nr.error_message.as_deref(),
            Some("not run: previous command timed out")
        );

        let auth = evaluate_cli_step(
            &shell_result(ssh::CommandStatus::AuthFailed, "", None),
            "show",
            None,
            None,
            timeout,
        );
        assert_eq!(auth.status, StepExecutionStatus::Failed);

        let err = evaluate_cli_step(
            &shell_result(
                ssh::CommandStatus::Error,
                "",
                Some("Failed to open channel"),
            ),
            "show",
            None,
            None,
            timeout,
        );
        assert_eq!(err.status, StepExecutionStatus::Failed);
        assert_eq!(err.error_message.as_deref(), Some("Failed to open channel"));

        let vendor = evaluate_cli_step(
            &shell_result(
                ssh::CommandStatus::Success,
                "% Invalid input detected",
                None,
            ),
            "shw",
            None,
            Some("cisco-ios"),
            timeout,
        );
        assert_eq!(vendor.status, StepExecutionStatus::Failed);
        assert_eq!(
            vendor.error_message.as_deref(),
            Some("% Invalid input detected")
        );
    }

    // --- phase wrapper ------------------------------------------------------

    #[test]
    fn phase_commands_per_flavor() {
        let v = |cmds: &[&str]| cmds.iter().map(|c| c.to_string()).collect::<Vec<_>>();
        for flavor in ["cisco-ios", "cisco-nxos", "arista"] {
            assert_eq!(
                phase_commands(Some(flavor), &MopStepType::Change),
                (v(&["configure terminal"]), v(&["end", "write memory"])),
                "{}",
                flavor
            );
            assert_eq!(
                phase_commands(Some(flavor), &MopStepType::Rollback),
                (v(&["configure terminal"]), v(&["end", "write memory"])),
                "{}",
                flavor
            );
            assert_eq!(
                phase_commands(Some(flavor), &MopStepType::PreCheck),
                (v(&["terminal length 0"]), vec![]),
                "{}",
                flavor
            );
        }
        assert_eq!(
            phase_commands(Some("cisco-ios-xr"), &MopStepType::Change),
            (v(&["configure"]), v(&["commit", "end"]))
        );
        assert_eq!(
            phase_commands(Some("cisco-ios-xr"), &MopStepType::PostCheck),
            (v(&["terminal length 0"]), vec![])
        );
        assert_eq!(
            phase_commands(Some("juniper"), &MopStepType::Change),
            (v(&["configure"]), v(&["commit", "exit"]))
        );
        assert_eq!(
            phase_commands(Some("juniper"), &MopStepType::PreCheck),
            (v(&["set cli screen-length 0"]), vec![])
        );
        assert_eq!(
            phase_commands(Some("paloalto"), &MopStepType::Change),
            (v(&["configure"]), v(&["commit", "exit"]))
        );
        assert_eq!(
            phase_commands(Some("paloalto"), &MopStepType::PreCheck),
            (vec![], vec![])
        );
        for flavor in [
            Some("fortinet"),
            Some("linux"),
            Some("auto"),
            Some("something-else"),
            None,
        ] {
            assert_eq!(
                phase_commands(flavor, &MopStepType::Change),
                (vec![], vec![]),
                "{:?}",
                flavor
            );
            assert_eq!(
                phase_commands(flavor, &MopStepType::PreCheck),
                (vec![], vec![]),
                "{:?}",
                flavor
            );
        }
        assert_eq!(
            phase_commands(Some("cisco-ios"), &MopStepType::ApiAction),
            (vec![], vec![])
        );
        // Contract spelling with underscores is accepted too.
        assert_eq!(
            phase_commands(Some("cisco_ios_xr"), &MopStepType::Change).1,
            v(&["commit", "end"])
        );
    }

    #[test]
    fn exec_prompt_only_for_network_flavors_only() {
        for flavor in [
            "cisco-ios",
            "cisco-ios-xr",
            "cisco-nxos",
            "arista",
            "juniper",
            "paloalto",
            "fortinet",
        ] {
            assert!(exec_prompt_only_for(Some(flavor)), "{}", flavor);
        }
        for flavor in [Some("linux"), Some("auto"), Some(""), None] {
            assert!(!exec_prompt_only_for(flavor), "{:?}", flavor);
        }
    }

    #[test]
    fn step_timeout_defaults_and_clamps() {
        assert_eq!(step_timeout(None).as_secs(), 60);
        assert_eq!(step_timeout(Some(0)).as_secs(), 1);
        assert_eq!(step_timeout(Some(120)).as_secs(), 120);
        assert_eq!(step_timeout(Some(10_000)).as_secs(), 600);
    }

    #[test]
    fn is_cli_step_routes_by_source_and_type() {
        assert!(is_cli_step(&cli_step("d", MopStepType::Change, 1, "cli")));
        assert!(!is_cli_step(&cli_step(
            "d",
            MopStepType::Change,
            1,
            "script"
        )));
        assert!(!is_cli_step(&cli_step(
            "d",
            MopStepType::Change,
            1,
            "quick_action"
        )));
        assert!(!is_cli_step(&cli_step(
            "d",
            MopStepType::ApiAction,
            1,
            "cli"
        )));
    }

    // --- state machine ---------------------------------------------------------

    #[test]
    fn execution_state_machine_table() {
        use ExecutionStatus::*;
        let all = [Pending, Running, Paused, Complete, Failed, Aborted];
        let allowed = [
            (Pending, Running),
            (Running, Paused),
            (Paused, Running),
            (Running, Complete),
            (Paused, Complete),
            (Running, Failed),
            (Paused, Failed),
            (Pending, Aborted),
            (Running, Aborted),
            (Paused, Aborted),
        ];
        for from in &all {
            for to in &all {
                let expected = allowed.iter().any(|(f, t)| f == from && t == to);
                assert_eq!(
                    execution_transition_allowed(from, to),
                    expected,
                    "{} → {}",
                    from,
                    to
                );
            }
        }
        // Terminal states never move again.
        for from in [Complete, Failed, Aborted] {
            for to in &all {
                assert!(
                    !execution_transition_allowed(&from, to),
                    "{} → {}",
                    from,
                    to
                );
            }
        }
    }

    #[test]
    fn validate_mop_steps_rejects_bad_enums_and_blank_commands() {
        let mut step: MopStep =
            serde_json::from_str(r#"{"step_type":"change","command":"x"}"#).unwrap();
        assert!(validate_mop_steps("mop_steps", std::slice::from_ref(&step)).is_ok());
        step.step_type = "verify".to_string();
        assert_eq!(
            validate_mop_steps("mop_steps", std::slice::from_ref(&step))
                .unwrap_err()
                .code,
            "VALIDATION"
        );
        step.step_type = "change".to_string();
        step.status = "done".to_string();
        assert_eq!(
            validate_mop_steps("mop_steps", std::slice::from_ref(&step))
                .unwrap_err()
                .code,
            "VALIDATION"
        );
        step.status = "pending".to_string();
        step.command = "   ".to_string();
        assert_eq!(
            validate_mop_steps("mop_steps", std::slice::from_ref(&step))
                .unwrap_err()
                .code,
            "VALIDATION"
        );
        assert_eq!(status_for_error_code("INVALID_STATE"), StatusCode::CONFLICT);
        assert_eq!(
            status_for_error_code("PHASE_IN_PROGRESS"),
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn validate_change_steps_covers_plan_and_device_overrides() {
        let ok: MopStep =
            serde_json::from_str(r#"{"step_type":"change","command":"vlan 100"}"#).unwrap();
        let mut bad_type = ok.clone();
        bad_type.step_type = "verify".to_string();
        let mut blank = ok.clone();
        blank.command = "  ".to_string();

        assert!(validate_change_steps(Some(std::slice::from_ref(&ok)), None).is_ok());
        assert!(validate_change_steps(None, None).is_ok());

        let err = validate_change_steps(Some(&[ok.clone(), blank.clone()]), None).unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        assert!(
            err.error.starts_with("mop_steps[1].command"),
            "{}",
            err.error
        );

        let mut overrides = std::collections::HashMap::new();
        overrides.insert("core-sw1".to_string(), vec![ok.clone()]);
        overrides.insert("core-sw2".to_string(), vec![ok.clone(), bad_type.clone()]);
        assert!(validate_change_steps(Some(std::slice::from_ref(&ok)), Some(&overrides)).is_err());
        let err = validate_change_steps(None, Some(&overrides)).unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        assert!(
            err.error
                .starts_with("device_overrides[core-sw2][1].step_type 'verify'"),
            "{}",
            err.error
        );

        // Import packages go through the same rules with their own labels.
        let pkg_step: MopPackageStep =
            serde_json::from_str(r#"{"order":1,"step_type":"change","command":" "}"#).unwrap();
        let converted = package_step_to_mop_step(&pkg_step);
        assert_eq!(converted.status, "pending");
        let err = validate_mop_steps("mop.steps", &[converted]).unwrap_err();
        assert_eq!(err.error, "mop.steps[0].command must be non-empty");
    }

    // --- diff ------------------------------------------------------------------

    #[test]
    fn identical_reordered_line_is_not_reported_as_changed() {
        let pre = "a\nb\nc";
        let post = "b\nc\na";
        let diff = mop_diff_text(pre, post);
        assert_eq!(diff.summary.changed, 0, "{:?}", diff.changes);
        assert!(
            diff.changes.iter().all(|c| c.old != c.new),
            "no entry may have old == new: {:?}",
            diff.changes
        );
        assert_eq!(diff.summary.added, 1);
        assert_eq!(diff.summary.removed, 1);

        // A genuine rewrite is still paired as "changed".
        let diff = mop_diff_text("a\nb\nc", "a\nB\nc");
        assert_eq!(diff.summary.changed, 1);
        assert_eq!(diff.changes[0].old, serde_json::Value::String("b".into()));
        assert_eq!(diff.changes[0].new, serde_json::Value::String("B".into()));
    }

    #[test]
    fn snapshot_transcript_is_excluded_from_the_step_output() {
        let out = format!(
            "=== show vlan ===\n1 default{}core-sw1# show vlan\n1 default\ncore-sw1#",
            SNAPSHOT_TRANSCRIPT_MARKER
        );
        assert_eq!(snapshot_step_output(&out), "=== show vlan ===\n1 default");
        assert_eq!(snapshot_step_output("plain"), "plain");
    }

    #[test]
    fn truncation_never_splits_a_multibyte_char() {
        let text = "ééééé"; // 10 bytes, 5 chars
        assert_eq!(truncate_on_char_boundary(text, 3), "é");
        assert_eq!(truncate_on_char_boundary(text, 4), "éé");
        assert_eq!(truncate_on_char_boundary(text, 100), text);
        assert_eq!(truncate_on_char_boundary("abc", 2), "ab");
    }

    // --- provider integration: change → execution → device → steps → snapshot → diff ---

    /// A credential profile plus one Cisco IOS session to hang executions on.
    async fn lab_session(provider: &crate::providers::local::LocalDataProvider) -> Session {
        let profile = provider
            .create_profile(NewCredentialProfile {
                name: "lab".into(),
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
            })
            .await
            .unwrap();
        let session = provider
            .create_session(NewSession {
                name: "core-sw1".into(),
                folder_id: None,
                host: "10.0.0.1".into(),
                port: 22,
                color: None,
                profile_id: profile.id.clone(),
                netbox_device_id: None,
                netbox_source_id: None,
                cli_flavor: CliFlavor::CiscoIos,
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
            })
            .await
            .unwrap();
        session
    }

    fn new_execution(
        name: &str,
        template_id: Option<String>,
        plan_id: Option<String>,
    ) -> NewMopExecution {
        NewMopExecution {
            template_id,
            plan_id,
            name: name.to_string(),
            description: None,
            execution_strategy: ExecutionStrategy::default(),
            control_mode: ControlMode::default(),
            created_by: "test".into(),
            on_failure: "pause".into(),
            ai_autonomy_level: None,
            pause_after_pre_checks: None,
            pause_after_changes: None,
            pause_after_post_checks: None,
        }
    }

    fn new_device(exec_id: &str, session_id: &str) -> NewMopExecutionDevice {
        NewMopExecutionDevice {
            execution_id: exec_id.to_string(),
            session_id: Some(session_id.to_string()),
            device_id: None,
            credential_id: None,
            device_name: None,
            device_host: Some("   ".into()),
            role: None,
            cli_flavor: None,
            variables: None,
            device_order: 0,
        }
    }

    fn passed_eval(output: &str) -> StepEvaluation {
        StepEvaluation {
            status: StepExecutionStatus::Passed,
            output: output.to_string(),
            error_message: None,
            assertion_results: None,
        }
    }

    #[tokio::test]
    async fn phase_guard_stops_on_abort_flag_or_status_change() {
        let provider = setup_provider().await;
        let exec = provider
            .create_mop_execution(new_execution("guard", None, None))
            .await
            .unwrap();
        let set_status = |status: ExecutionStatus| {
            provider.update_mop_execution(
                &exec.id,
                UpdateMopExecution {
                    status: Some(status),
                    ..Default::default()
                },
            )
        };
        set_status(ExecutionStatus::Running).await.unwrap();
        let guard = PhaseGuard {
            provider: &provider,
            exec_id: &exec.id,
            expected: ExecutionStatus::Running,
        };
        assert_eq!(guard.interrupted_by().await.unwrap(), None);

        // The in-memory flag is honoured without waiting for the row.
        set_mop_abort_flag(&exec.id);
        assert!(mop_abort_flag_set(&exec.id));
        assert_eq!(
            guard.interrupted_by().await.unwrap(),
            Some(ExecutionStatus::Aborted)
        );
        clear_mop_abort_flag(&exec.id);
        assert!(!mop_abort_flag_set(&exec.id));
        assert_eq!(guard.interrupted_by().await.unwrap(), None);

        // Any status change in the row counts: pause, complete, abort.
        set_status(ExecutionStatus::Paused).await.unwrap();
        assert_eq!(
            guard.interrupted_by().await.unwrap(),
            Some(ExecutionStatus::Paused)
        );
        set_status(ExecutionStatus::Running).await.unwrap();
        assert_eq!(
            guard.interrupted_by().await.unwrap(),
            None,
            "resume makes the phase writable again"
        );
        set_status(ExecutionStatus::Aborted).await.unwrap();
        assert_eq!(
            guard.interrupted_by().await.unwrap(),
            Some(ExecutionStatus::Aborted)
        );

        // A rollback started on an aborted execution is not stopped by the abort flag.
        set_mop_abort_flag(&exec.id);
        let rollback_guard = PhaseGuard {
            provider: &provider,
            exec_id: &exec.id,
            expected: ExecutionStatus::Aborted,
        };
        assert_eq!(rollback_guard.interrupted_by().await.unwrap(), None);
        clear_mop_abort_flag(&exec.id);
    }

    #[tokio::test]
    async fn interrupted_phase_never_overwrites_the_abort_cascade() {
        let provider = setup_provider().await;
        let session = lab_session(&provider).await;
        let exec = provider
            .create_mop_execution(new_execution("abort race", None, None))
            .await
            .unwrap();
        provider
            .update_mop_execution(
                &exec.id,
                UpdateMopExecution {
                    status: Some(ExecutionStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let device = provider
            .create_mop_execution_device(new_device(&exec.id, &session.id))
            .await
            .unwrap();
        let steps = provider
            .bulk_create_mop_execution_steps(
                (1..=3)
                    .map(|order| NewMopExecutionStep {
                        execution_device_id: device.id.clone(),
                        step_order: order,
                        step_type: MopStepType::Change,
                        command: format!("vlan {}", order),
                        description: None,
                        expected_output: None,
                        mock_enabled: false,
                        mock_output: None,
                        execution_source: "cli".into(),
                        quick_action_id: None,
                        quick_action_variables: None,
                        script_id: None,
                        script_args: None,
                        paired_step_id: None,
                        output_format: None,
                    })
                    .collect(),
            )
            .await
            .unwrap();
        provider
            .update_mop_execution_device(
                &device.id,
                UpdateMopExecutionDevice {
                    status: Some(DeviceExecutionStatus::Running),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        // While the execution is running the shared path persists verdicts normally.
        let guard = PhaseGuard {
            provider: &provider,
            exec_id: &exec.id,
            expected: ExecutionStatus::Running,
        };
        let mut tally = PhaseTally::default();
        let started = mark_step_running(&provider, &steps[0].id).await.unwrap();
        assert!(record_and_finalize(
            &guard,
            &mut tally,
            &steps[0],
            passed_eval("ok"),
            "",
            started,
            None
        )
        .await
        .unwrap());
        assert_eq!(tally.passed, 1);
        assert_eq!(
            provider
                .get_mop_execution_step(&steps[0].id)
                .await
                .unwrap()
                .status,
            StepExecutionStatus::Passed
        );

        // Batch in flight: steps 2 and 3 are running, then /abort lands and
        // its cascade re-labels step 2 (step 3 is marked running by the
        // phase just after the cascade — the widest possible race).
        mark_step_running(&provider, &steps[1].id).await.unwrap();
        provider
            .update_mop_execution_step(
                &steps[1].id,
                UpdateMopExecutionStep {
                    status: Some(StepExecutionStatus::Failed),
                    error_message: Some(Some("aborted".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        provider
            .update_mop_execution_device(
                &device.id,
                UpdateMopExecutionDevice {
                    status: Some(DeviceExecutionStatus::Failed),
                    error_message: Some(Some("aborted".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        provider
            .update_mop_execution(
                &exec.id,
                UpdateMopExecution {
                    status: Some(ExecutionStatus::Aborted),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        set_mop_abort_flag(&exec.id);
        let started = mark_step_running(&provider, &steps[2].id).await.unwrap();

        // The SSH batch comes back "passed" for both — neither may be written.
        assert!(!record_and_finalize(
            &guard,
            &mut tally,
            &steps[1],
            passed_eval("ok"),
            "",
            started,
            None
        )
        .await
        .unwrap());
        assert_eq!(tally.interrupted, Some(ExecutionStatus::Aborted));
        assert!(tally.stopped_early);
        assert_eq!(tally.passed, 1, "the discarded verdict is not tallied");
        assert!(
            tally
                .combined_output
                .contains("execution aborted while phase was running"),
            "{}",
            tally.combined_output
        );
        let cascaded = provider.get_mop_execution_step(&steps[1].id).await.unwrap();
        assert_eq!(cascaded.status, StepExecutionStatus::Failed);
        assert_eq!(
            cascaded.error_message.as_deref(),
            Some("aborted"),
            "cascade value kept"
        );

        // A row the cascade never saw (still running) is closed, not left spinning.
        close_interrupted_step(&provider, &steps[2].id, &ExecutionStatus::Aborted)
            .await
            .unwrap();
        let closed = provider.get_mop_execution_step(&steps[2].id).await.unwrap();
        assert_eq!(closed.status, StepExecutionStatus::Failed);
        assert!(closed
            .error_message
            .as_deref()
            .unwrap()
            .starts_with("execution aborted while the step was running"));
        assert!(closed.completed_at.is_some());
        // Idempotent / never touches a finished row.
        close_interrupted_step(&provider, &steps[0].id, &ExecutionStatus::Aborted)
            .await
            .unwrap();
        assert_eq!(
            provider
                .get_mop_execution_step(&steps[0].id)
                .await
                .unwrap()
                .status,
            StepExecutionStatus::Passed
        );

        // Device: the cascade's failed/"aborted" row stands …
        close_interrupted_device(&provider, &device.id, &ExecutionStatus::Aborted)
            .await
            .unwrap();
        let dev = provider.get_mop_execution_device(&device.id).await.unwrap();
        assert_eq!(dev.status, DeviceExecutionStatus::Failed);
        assert_eq!(dev.error_message.as_deref(), Some("aborted"));
        // … while one still marked running by the phase gets closed.
        provider
            .update_mop_execution_device(
                &device.id,
                UpdateMopExecutionDevice {
                    status: Some(DeviceExecutionStatus::Running),
                    error_message: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        close_interrupted_device(&provider, &device.id, &ExecutionStatus::Paused)
            .await
            .unwrap();
        let dev = provider.get_mop_execution_device(&device.id).await.unwrap();
        assert_eq!(dev.status, DeviceExecutionStatus::Failed);
        assert_eq!(
            dev.error_message.as_deref(),
            Some("execution paused while the phase was running")
        );
        clear_mop_abort_flag(&exec.id);
    }

    #[tokio::test]
    async fn step_and_device_routes_are_scoped_to_their_execution() {
        let provider = setup_provider().await;
        let session = lab_session(&provider).await;
        let exec_a = provider
            .create_mop_execution(new_execution("a", None, None))
            .await
            .unwrap();
        let exec_b = provider
            .create_mop_execution(new_execution("b", None, None))
            .await
            .unwrap();
        let device = provider
            .create_mop_execution_device(new_device(&exec_a.id, &session.id))
            .await
            .unwrap();
        let step = provider
            .bulk_create_mop_execution_steps(vec![NewMopExecutionStep {
                execution_device_id: device.id.clone(),
                step_order: 1,
                step_type: MopStepType::PreCheck,
                command: "show version".into(),
                description: None,
                expected_output: None,
                mock_enabled: false,
                mock_output: None,
                execution_source: "cli".into(),
                quick_action_id: None,
                quick_action_variables: None,
                script_id: None,
                script_args: None,
                paired_step_id: None,
                output_format: None,
            }])
            .await
            .unwrap()
            .remove(0);

        let (found, owner) = load_step_in_execution(&provider, &exec_a.id, &step.id)
            .await
            .unwrap();
        assert_eq!(found.id, step.id);
        assert_eq!(owner.id, device.id);
        assert_eq!(
            load_step_in_execution(&provider, &exec_b.id, &step.id)
                .await
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        assert_eq!(
            load_step_in_execution(&provider, &exec_a.id, "ghost")
                .await
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        assert!(load_execution_device(&provider, &exec_a.id, &device.id)
            .await
            .is_ok());
        assert_eq!(
            load_execution_device(&provider, &exec_b.id, &device.id)
                .await
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );

        // Execution / device state guards used by execute-step.
        assert_eq!(
            require_execution_status(&provider, &exec_a.id, &[ExecutionStatus::Running])
                .await
                .unwrap_err()
                .code,
            "INVALID_STATE"
        );
        assert!(require_execution_status(
            &provider,
            &exec_a.id,
            &[ExecutionStatus::Pending, ExecutionStatus::Running]
        )
        .await
        .is_ok());
        assert!(require_device_not_skipped(&device).is_ok());
        let skipped = provider
            .update_mop_execution_device(
                &device.id,
                UpdateMopExecutionDevice {
                    status: Some(DeviceExecutionStatus::Skipped),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            require_device_not_skipped(&skipped).unwrap_err().code,
            "INVALID_STATE"
        );
    }

    #[tokio::test]
    async fn end_to_end_execution_owned_snapshots_and_diff() {
        let provider = setup_provider().await;
        let session = lab_session(&provider).await;

        // Change with the new metadata; a malformed step element is dropped, not the whole plan.
        let change = provider
            .create_change(NewChange {
                session_id: None,
                name: "Add VLAN 100".into(),
                description: None,
                mop_steps: vec![serde_json::from_str(
                    r#"{"step_type":"change","command":"vlan 100"}"#,
                )
                .unwrap()],
                device_overrides: None,
                variables: vec![],
                device_variables: DeviceVariableMap::new(),
                document_id: None,
                risk_level: Some("medium".into()),
                change_ticket: Some("CHG-42".into()),
                tags: vec!["vlan".into()],
                session_ids: vec![session.id.clone()],
                created_by: "test".into(),
            })
            .await
            .unwrap();
        assert_eq!(change.risk_level.as_deref(), Some("medium"));
        assert_eq!(change.tags, vec!["vlan".to_string()]);
        assert_eq!(change.session_ids, vec![session.id.clone()]);
        sqlx::query("UPDATE changes SET mop_steps = ? WHERE id = ?")
            .bind(r#"[{"step_type":"change","command":"vlan 100"},{"bogus":true}]"#)
            .bind(&change.id)
            .execute(provider.get_pool())
            .await
            .unwrap();
        let reloaded = provider.get_change(&change.id).await.unwrap();
        assert_eq!(
            reloaded.mop_steps.len(),
            1,
            "parseable steps survive a bad sibling"
        );
        let cleared = provider
            .update_change(
                &change.id,
                UpdateChange {
                    change_ticket: Some(None),
                    tags: Some(vec![]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(cleared.change_ticket, None, "null clears the ticket");
        assert_eq!(
            cleared.risk_level.as_deref(),
            Some("medium"),
            "absent keeps the risk"
        );
        assert!(cleared.tags.is_empty());

        // Execution: plan_id persisted, unknown template / plan → NotFound.
        let new_exec = |template_id: Option<String>| {
            new_execution("run 1", template_id, Some(change.id.clone()))
        };
        assert!(matches!(
            provider
                .create_mop_execution(new_exec(Some("nope".into())))
                .await,
            Err(ProviderError::NotFound(_))
        ));
        assert!(matches!(
            provider
                .create_mop_execution(new_execution("run 1", None, Some("nope".into())))
                .await,
            Err(ProviderError::NotFound(_))
        ));
        let exec = provider.create_mop_execution(new_exec(None)).await.unwrap();
        assert_eq!(
            provider
                .get_mop_execution(&exec.id)
                .await
                .unwrap()
                .plan_id
                .as_deref(),
            Some(change.id.as_str())
        );

        // Device: name/host/cli_flavor resolved from the session; duplicates and unknown refs rejected.
        let new_device = |session_id: &str| new_device(&exec.id, session_id);
        let device = provider
            .create_mop_execution_device(new_device(&session.id))
            .await
            .unwrap();
        assert_eq!(device.device_name, "core-sw1");
        assert_eq!(device.device_host, "10.0.0.1");
        assert_eq!(device.cli_flavor.as_deref(), Some("cisco-ios"));
        assert!(matches!(
            provider
                .create_mop_execution_device(new_device(&session.id))
                .await,
            Err(ProviderError::Conflict(_))
        ));
        assert!(matches!(
            provider
                .create_mop_execution_device(new_device("ghost"))
                .await,
            Err(ProviderError::NotFound(_))
        ));
        let stored = provider.get_mop_execution_device(&device.id).await.unwrap();
        assert_eq!(stored.cli_flavor.as_deref(), Some("cisco-ios"));

        // Steps: blank command → Validation, unknown device → NotFound.
        let mut steps = [
            cli_step(&device.id, MopStepType::PreCheck, 1, "cli"),
            cli_step(&device.id, MopStepType::Change, 2, "cli"),
            cli_step(&device.id, MopStepType::PostCheck, 3, "cli"),
        ];
        let to_new = |s: &MopExecutionStep| NewMopExecutionStep {
            execution_device_id: s.execution_device_id.clone(),
            step_order: s.step_order,
            step_type: s.step_type.clone(),
            command: s.command.clone(),
            description: None,
            expected_output: Some("CONTAINS: up".into()),
            mock_enabled: false,
            mock_output: None,
            execution_source: s.execution_source.clone(),
            quick_action_id: None,
            quick_action_variables: None,
            script_id: None,
            script_args: None,
            paired_step_id: None,
            output_format: None,
        };
        let mut blank = to_new(&steps[0]);
        blank.command = " ".into();
        assert!(matches!(
            provider.bulk_create_mop_execution_steps(vec![blank]).await,
            Err(ProviderError::Validation(_))
        ));
        let mut orphan = to_new(&steps[0]);
        orphan.execution_device_id = "ghost".into();
        assert!(matches!(
            provider.bulk_create_mop_execution_steps(vec![orphan]).await,
            Err(ProviderError::NotFound(_))
        ));
        steps[1].command = "vlan 100".into();
        let created = provider
            .bulk_create_mop_execution_steps(steps.iter().map(to_new).collect())
            .await
            .unwrap();
        assert_eq!(created.len(), 3);

        // Finalize one step through the shared path: assertions + error land in the row.
        let eval = evaluate_cli_step(
            &shell_result(ssh::CommandStatus::Success, "Gi0/1 is down", None),
            "show version",
            Some("CONTAINS: up"),
            Some("cisco-ios"),
            std::time::Duration::from_secs(60),
        );
        let finalized =
            finalize_step_execution(&provider, &created[0].id, eval, chrono::Utc::now(), None)
                .await
                .unwrap();
        assert_eq!(finalized.status, StepExecutionStatus::Failed);
        assert_eq!(finalized.output.as_deref(), Some("Gi0/1 is down"));
        assert!(finalized
            .error_message
            .as_deref()
            .unwrap()
            .starts_with("assertion failed"));
        let results = provider
            .get_mop_execution_step(&created[0].id)
            .await
            .unwrap()
            .assertion_results
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].passed);
        assert!(finalized.duration_ms.is_some());
        // A step skipped after a timeout carries no duration (O2).
        let not_run = evaluate_cli_step(
            &shell_result(
                ssh::CommandStatus::NotRun,
                "",
                Some("not run: previous command timed out"),
            ),
            "show version",
            None,
            Some("cisco-ios"),
            std::time::Duration::from_secs(60),
        );
        let skipped = finalize_step_execution(
            &provider,
            &created[1].id,
            not_run,
            chrono::Utc::now() - chrono::Duration::seconds(90),
            None,
        )
        .await
        .unwrap();
        assert_eq!(skipped.status, StepExecutionStatus::Skipped);
        assert_eq!(skipped.duration_ms, None);

        // Snapshots: execution-owned; owner checks.
        assert!(matches!(
            provider
                .create_snapshot(NewSnapshot {
                    change_id: None,
                    execution_id: None,
                    snapshot_type: "pre".into(),
                    commands: vec![],
                    output: String::new()
                })
                .await,
            Err(ProviderError::Validation(_))
        ));
        assert!(matches!(
            provider
                .create_snapshot(NewSnapshot {
                    change_id: Some("nope".into()),
                    execution_id: None,
                    snapshot_type: "pre".into(),
                    commands: vec![],
                    output: String::new()
                })
                .await,
            Err(ProviderError::NotFound(_))
        ));
        assert!(matches!(
            provider
                .create_snapshot(NewSnapshot {
                    change_id: None,
                    execution_id: Some("nope".into()),
                    snapshot_type: "pre".into(),
                    commands: vec![],
                    output: String::new()
                })
                .await,
            Err(ProviderError::NotFound(_))
        ));
        let pre = provider
            .create_snapshot(NewSnapshot {
                change_id: None,
                execution_id: Some(exec.id.clone()),
                snapshot_type: "pre".into(),
                commands: vec!["show vlan brief".into()],
                output: "1    default   active\n10   users     active".into(),
            })
            .await
            .unwrap();
        assert_eq!(pre.execution_id.as_deref(), Some(exec.id.as_str()));
        assert!(pre.change_id.is_none());
        let post = provider
            .create_snapshot(NewSnapshot {
                change_id: None,
                execution_id: Some(exec.id.clone()),
                snapshot_type: "post".into(),
                commands: vec!["show vlan brief".into()],
                output: "1    default   active\n10   users     active\n100  servers   active"
                    .into(),
            })
            .await
            .unwrap();
        provider
            .update_mop_execution_device(
                &device.id,
                UpdateMopExecutionDevice {
                    pre_snapshot_id: Some(Some(pre.id.clone())),
                    post_snapshot_id: Some(Some(post.id.clone())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let device = provider.get_mop_execution_device(&device.id).await.unwrap();
        assert_eq!(device.pre_snapshot_id.as_deref(), Some(pre.id.as_str()));

        // Diff through the same LCS path the endpoint uses.
        let pre_out = provider
            .get_snapshot(device.pre_snapshot_id.as_deref().unwrap())
            .await
            .unwrap()
            .output;
        let post_out = provider
            .get_snapshot(device.post_snapshot_id.as_deref().unwrap())
            .await
            .unwrap()
            .output;
        let diff = mop_diff_text(&pre_out, &post_out);
        assert_eq!(diff.summary.added, 1);
        assert_eq!(diff.summary.removed, 0);
        assert_eq!(
            diff.changes[0].new,
            serde_json::Value::String("100  servers   active".into())
        );

        // Deleting the execution cascades to its snapshots.
        provider.delete_mop_execution(&exec.id).await.unwrap();
        assert!(matches!(
            provider.get_snapshot(&pre.id).await,
            Err(ProviderError::NotFound(_))
        ));
    }

    // --- plan variables (P1-11) --------------------------------------------

    fn vars(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn plan_var(name: &str, value: &str, required: bool) -> MopVariable {
        MopVariable {
            name: name.into(),
            value: value.into(),
            description: None,
            required,
        }
    }

    #[test]
    fn runtime_vars_builtins_win_whitespace_tolerated_unknown_verbatim() {
        let custom = vars(&[
            ("vlan", "100"),
            ("desc", "uplink"),
            ("device.host", "spoofed"),
        ]);
        let rv = RuntimeVars {
            device_host: "10.0.0.1",
            device_name: "core-sw1",
            device_type: "cisco-ios",
            custom: &custom,
        };

        assert_eq!(
            resolve_runtime_vars("vlan {{vlan}} on {{device.name}}", &rv),
            "vlan 100 on core-sw1"
        );
        assert_eq!(
            resolve_runtime_vars("{{ vlan }}/{{  desc }}/{{device.type }}", &rv),
            "100/uplink/cisco-ios"
        );
        assert_eq!(
            resolve_runtime_vars("{{device.host}}", &rv),
            "10.0.0.1",
            "built-ins win over a custom key"
        );
        assert_eq!(
            resolve_runtime_vars("{{missing}} and {{ not a name }} and {{", &rv),
            "{{missing}} and {{ not a name }} and {{"
        );
        assert_eq!(
            resolve_runtime_vars("no placeholders", &rv),
            "no placeholders"
        );

        // device.type is "" when unknown; a custom map may be absent.
        let none = vars(&[]);
        let bare = RuntimeVars {
            device_host: "h",
            device_name: "n",
            device_type: "",
            custom: &none,
        };
        assert_eq!(resolve_runtime_vars("[{{device.type}}]", &bare), "[]");

        let resolved = resolve_runtime_vars(
            "vlan {{vlan}} {{ site }} {{desc}} {{site}} {{ description }}",
            &rv,
        );
        assert_eq!(
            unresolved_placeholders(&resolved),
            vec!["site".to_string(), "description".to_string()]
        );
        assert_eq!(
            unresolved_variables_message(&unresolved_placeholders(&resolved)),
            "Unresolved variables: {{site}}, {{description}}"
        );
        assert!(
            unresolved_placeholders("{{ not valid }} {{}}").is_empty(),
            "non-names are not placeholders"
        );

        // JSON leaves: nested objects / arrays are resolved and scanned.
        let args = serde_json::json!({ "a": "{{vlan}}", "b": ["{{device.host}}", { "c": "{{missing}}" }], "n": 1 });
        let resolved = resolve_runtime_vars_json(&args, &rv);
        assert_eq!(resolved["a"], "100");
        assert_eq!(resolved["b"][0], "10.0.0.1");
        assert_eq!(resolved["b"][1]["c"], "{{missing}}");
        assert_eq!(
            unresolved_placeholders_json(&resolved),
            vec!["missing".to_string()]
        );
    }

    #[test]
    fn validate_change_variables_cases() {
        let ok = vec![plan_var("vlan", "100", true), plan_var("_desc2", "", false)];
        let mut overrides = DeviceVariableMap::new();
        overrides.insert("sess-1".into(), vars(&[("vlan", "200")]));
        assert!(validate_change_variables(&ok, &overrides).is_ok());
        assert!(validate_change_variables(&[], &DeviceVariableMap::new()).is_ok());

        let bad_name =
            validate_change_variables(&[plan_var("1vlan", "", false)], &DeviceVariableMap::new())
                .unwrap_err();
        assert_eq!(bad_name.code, "VALIDATION");
        assert!(
            bad_name
                .error
                .starts_with("variables[0].name '1vlan' is invalid"),
            "{}",
            bad_name.error
        );
        for name in ["", "vlan id", "device.host", "vlan-id", "ünicode"] {
            assert!(
                validate_change_variables(&[plan_var(name, "", false)], &DeviceVariableMap::new())
                    .is_err(),
                "{name:?}"
            );
        }

        let dup = validate_change_variables(
            &[plan_var("vlan", "", false), plan_var("vlan", "", false)],
            &DeviceVariableMap::new(),
        )
        .unwrap_err();
        assert_eq!(
            dup.error,
            "variables[1].name 'vlan' is declared more than once"
        );
        assert!(
            validate_change_variables(
                &[plan_var("Vlan", "", false), plan_var("vlan", "", false)],
                &DeviceVariableMap::new()
            )
            .is_ok(),
            "case-sensitive"
        );

        let mut undeclared = DeviceVariableMap::new();
        undeclared.insert("sess-1".into(), vars(&[("vlan", "1"), ("site", "x")]));
        let err = validate_change_variables(&ok, &undeclared).unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        assert_eq!(
            err.error,
            "device_variables[sess-1].site is not a declared variable"
        );
    }

    #[test]
    fn plan_device_variables_merges_defaults_and_overrides() {
        let mut plan = serde_json::from_value::<Change>(serde_json::json!({
            "id": "p1", "session_id": null, "name": "x", "description": null, "status": "draft", "mop_steps": [],
            "pre_snapshot_id": null, "post_snapshot_id": null, "ai_analysis": null, "document_id": null,
            "created_by": "t", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "executed_at": null, "completed_at": null
        }))
        .unwrap();
        assert!(
            plan.variables.is_empty() && plan.device_variables.is_empty(),
            "serde defaults"
        );
        plan.variables = vec![
            plan_var("vlan", "100", true),
            plan_var("desc", "", false),
            plan_var("site", "", true),
        ];
        plan.device_variables.insert(
            "s1".into(),
            vars(&[("vlan", "200"), ("desc", "   "), ("site", "nyc")]),
        );

        let s1 = plan_device_variables(&plan, Some("s1"));
        assert_eq!(
            s1,
            vars(&[("vlan", "200"), ("desc", ""), ("site", "nyc")]),
            "blank override inherits the default"
        );
        let s2 = plan_device_variables(&plan, Some("s2"));
        assert_eq!(s2, vars(&[("vlan", "100"), ("desc", ""), ("site", "")]));
        assert_eq!(plan_device_variables(&plan, None), s2);

        assert!(require_plan_variables(&plan, &s1, "core-sw1").is_ok());
        let err = require_plan_variables(&plan, &s2, "core-sw2").unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        assert_eq!(
            err.error,
            "Required variable 'site' has no value for device core-sw2"
        );

        // Wire shape of a MopVariable.
        let v: MopVariable = serde_json::from_str(r#"{"name":"vlan"}"#).unwrap();
        assert_eq!(v, plan_var("vlan", "", false));
        assert_eq!(
            serde_json::to_value(&v).unwrap(),
            serde_json::json!({"name": "vlan", "value": "", "required": false})
        );
    }

    // --- AI-backed /analyze --------------------------------------------------

    fn analysis_fixture(outputs: &[&str]) -> MopAnalysisData {
        let execution = MopExecution::new(new_execution("run 1", None, None));
        let mut device = MopExecutionDevice::new(NewMopExecutionDevice {
            device_name: Some("core-sw1".into()),
            device_host: Some("10.0.0.1".into()),
            cli_flavor: Some("cisco-ios".into()),
            variables: Some(vars(&[("vlan", "100")])),
            ..new_device(&execution.id, "sess-1")
        });
        device.status = DeviceExecutionStatus::Complete;
        let steps = outputs
            .iter()
            .enumerate()
            .map(|(i, out)| {
                let mut step = cli_step(&device.id, MopStepType::PreCheck, i as i32 + 1, "cli");
                step.status = StepExecutionStatus::Passed;
                step.output = Some(out.to_string());
                step
            })
            .collect();
        MopAnalysisData {
            execution,
            plan: None,
            devices: vec![MopAnalysisDevice {
                device,
                steps,
                diff: None,
            }],
        }
    }

    #[test]
    fn mop_analysis_context_is_deterministic_and_capped() {
        // 12 steps × 10 KiB of output: each capped to a 4 KiB tail, 32 KiB in total.
        let big: Vec<String> = (0..12)
            .map(|i| format!("{}END{:04}", "x".repeat(10 * 1024 - 8), i))
            .collect();
        let refs: Vec<&str> = big.iter().map(String::as_str).collect();
        let data = analysis_fixture(&refs);

        let a = build_mop_analysis_context(&data, true);
        let b = build_mop_analysis_context(&data, true);
        assert_eq!(a, b, "deterministic for the same data");
        assert!(a.contains("Platforms: Cisco IOS/IOS-XE"), "{}", &a[..300]);
        assert!(a.contains("variables: vlan=100"));
        assert!(
            a.contains("END0000") && a.contains("END0007"),
            "kept tails carry the end of each output"
        );
        assert!(
            !a.contains("END0011"),
            "output past the total budget is omitted"
        );
        assert!(a.contains("[omitted — context budget exhausted]"));
        let x_bytes = a.bytes().filter(|b| *b == b'x').count();
        assert!(
            x_bytes <= MOP_ANALYSIS_TOTAL_OUTPUT,
            "{} bytes of output exceed the total cap",
            x_bytes
        );
        assert!(
            a.len() < MOP_ANALYSIS_TOTAL_OUTPUT + 8 * 1024,
            "context is bounded: {} bytes",
            a.len()
        );

        let without = build_mop_analysis_context(&data, false);
        assert!(!without.contains("END0000") && without.contains("`show version` → passed"));

        let system = build_mop_analysis_system_prompt(&data);
        assert!(system.contains("Cisco IOS/IOS-XE") && system.contains("\"risk_level\""));
        assert_eq!(cli_flavor_display_name(Some("auto")), None);
        assert_eq!(
            cli_flavor_display_name(Some("juniper")),
            Some("Juniper Junos")
        );
    }

    #[test]
    fn parse_mop_analysis_reply_tolerates_fences_prose_and_garbage() {
        let fenced = "Here is my review:\n```json\n{\"analysis\": \"**Looks good**\", \"recommendations\": [\"verify BGP\", 2], \"risk_level\": \"LOW\"}\n```\nThanks!";
        let (analysis, recs, risk) = parse_mop_analysis_reply(fenced);
        assert_eq!(analysis, "**Looks good**");
        assert_eq!(recs, vec!["verify BGP".to_string(), "2".to_string()]);
        assert_eq!(risk, "low");

        let (analysis, recs, risk) =
            parse_mop_analysis_reply("{\"analysis\":\"x\",\"risk_level\":\"severe\"}");
        assert_eq!(
            (analysis.as_str(), recs.len(), risk.as_str()),
            ("x", 0, "unknown")
        );

        let (analysis, recs, risk) =
            parse_mop_analysis_reply("  Sorry, I cannot produce JSON. The change looks fine. ");
        assert_eq!(
            analysis,
            "Sorry, I cannot produce JSON. The change looks fine."
        );
        assert!(recs.is_empty());
        assert_eq!(risk, "unknown");
    }

    struct StubAi(Result<String, &'static str>);

    #[async_trait::async_trait]
    impl ai::providers::AiProvider for StubAi {
        async fn chat_completion(
            &self,
            messages: Vec<ai::providers::ChatMessage>,
            _context: Option<ai::providers::AiContext>,
        ) -> Result<String, ai::providers::AiError> {
            assert_eq!(messages.len(), 2);
            assert_eq!(
                (messages[0].role.as_str(), messages[1].role.as_str()),
                ("system", "user")
            );
            assert!(messages[1].content.starts_with("# MOP execution: "));
            self.0
                .clone()
                .map_err(|e| ai::providers::AiError::RequestFailed(e.to_string()))
        }
        fn provider_name(&self) -> &str {
            "stub"
        }
    }

    #[tokio::test]
    async fn analyze_falls_back_to_rules_and_caches_ai_reviews() {
        let provider = setup_provider().await;
        let session = lab_session(&provider).await;
        let change = provider
            .create_change(NewChange {
                session_id: None,
                name: "Add VLAN".into(),
                description: None,
                mop_steps: vec![],
                device_overrides: None,
                variables: vec![plan_var("vlan", "100", true)],
                device_variables: DeviceVariableMap::from([(
                    session.id.clone(),
                    vars(&[("vlan", "200")]),
                )]),
                document_id: None,
                risk_level: None,
                change_ticket: None,
                tags: vec![],
                session_ids: vec![],
                created_by: "test".into(),
            })
            .await
            .unwrap();
        // Variables persist through create / update / get.
        assert_eq!(change.variables, vec![plan_var("vlan", "100", true)]);
        assert_eq!(change.device_variables[&session.id]["vlan"], "200");
        let updated = provider
            .update_change(
                &change.id,
                UpdateChange {
                    variables: Some(vec![plan_var("vlan", "300", false)]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.variables[0].value, "300");
        assert_eq!(
            updated.device_variables[&session.id]["vlan"], "200",
            "absent map keeps the overrides"
        );

        let exec = provider
            .create_mop_execution(new_execution("run 1", None, Some(change.id.clone())))
            .await
            .unwrap();
        let device = provider
            .create_mop_execution_device(NewMopExecutionDevice {
                variables: Some(plan_device_variables(&updated, Some(&session.id))),
                ..new_device(&exec.id, &session.id)
            })
            .await
            .unwrap();
        assert_eq!(device.variables.as_ref().unwrap()["vlan"], "200");
        assert_eq!(
            provider
                .get_mop_execution_device(&device.id)
                .await
                .unwrap()
                .variables,
            device.variables
        );
        let step = provider
            .bulk_create_mop_execution_steps(vec![NewMopExecutionStep {
                execution_device_id: device.id.clone(),
                step_order: 1,
                step_type: MopStepType::Change,
                command: "vlan {{vlan}}".into(),
                description: None,
                expected_output: None,
                mock_enabled: false,
                mock_output: None,
                execution_source: "cli".into(),
                quick_action_id: None,
                quick_action_variables: None,
                script_id: None,
                script_args: None,
                paired_step_id: None,
                output_format: None,
            }])
            .await
            .unwrap()
            .remove(0);
        let eval = StepEvaluation::failed("% Invalid input".into(), "% Invalid input");
        finalize_step_execution(&provider, &step.id, eval, chrono::Utc::now(), None)
            .await
            .unwrap();

        // No model configured → rule-based, 200, warning explains why.
        let req = MopAiAnalysisRequest {
            include_outputs: true,
            include_diff: true,
            force: false,
        };
        let unavailable = || MopAnalysisModel::Unavailable("AI provider not configured".into());
        let rules = analyze_mop_execution_with(&provider, unavailable(), &exec.id, &req)
            .await
            .unwrap();
        assert_eq!(rules.source, "rules");
        assert_eq!(rules.model, None);
        assert_eq!(
            rules.warnings,
            vec!["AI provider not configured".to_string()]
        );
        assert_eq!(rules.risk_level, "high");
        assert!(
            rules.analysis.contains("vlan {{vlan}}")
                && rules.analysis.contains("Rule-based summary")
        );
        let stored = provider.get_mop_execution(&exec.id).await.unwrap();
        assert_eq!(
            stored.ai_analysis.as_deref(),
            Some(rules.analysis.as_str()),
            "rules fill the empty slot"
        );
        assert_eq!(
            stored.ai_analysis_meta.as_ref().map(|m| m.source.as_str()),
            Some("rules")
        );

        // Model errors → still 200 + rules; the stored rules text is not clobbered.
        let failing = MopAnalysisModel::Ready {
            provider: Box::new(StubAi(Err("boom"))),
            model: "stub/x".into(),
            profile: None,
        };
        let again = analyze_mop_execution_with(&provider, failing, &exec.id, &req)
            .await
            .unwrap();
        assert_eq!(again.source, "rules");
        assert_eq!(again.warnings, vec!["API request failed: boom".to_string()]);

        // A real reply is parsed, persisted with meta, and served from cache afterwards.
        let reply = "```json\n{\"analysis\":\"VLAN 200 was rejected on core-sw1.\",\"recommendations\":[\"retry after fixing syntax\"],\"risk_level\":\"high\"}\n```";
        let ready = MopAnalysisModel::Ready {
            provider: Box::new(StubAi(Ok(reply.into()))),
            model: "anthropic/claude-x".into(),
            profile: None,
        };
        let ai = analyze_mop_execution_with(&provider, ready, &exec.id, &req)
            .await
            .unwrap();
        assert_eq!(
            (ai.source.as_str(), ai.model.as_deref()),
            ("ai", Some("anthropic/claude-x"))
        );
        assert_eq!(ai.analysis, "VLAN 200 was rejected on core-sw1.");
        assert_eq!(
            ai.recommendations,
            vec!["retry after fixing syntax".to_string()]
        );
        assert!(ai.warnings.is_empty());
        let stored = provider.get_mop_execution(&exec.id).await.unwrap();
        let meta = stored.ai_analysis_meta.clone().unwrap();
        assert_eq!(
            (
                meta.source.as_str(),
                meta.model.as_deref(),
                meta.risk_level.as_str()
            ),
            ("ai", Some("anthropic/claude-x"), "high")
        );
        assert_eq!(
            serde_json::to_value(&meta).unwrap()["recommendations"][0],
            "retry after fixing syntax"
        );

        let cached = analyze_mop_execution_with(&provider, unavailable(), &exec.id, &req)
            .await
            .unwrap();
        assert_eq!(
            (cached.source.as_str(), cached.warnings.clone()),
            ("ai", vec!["cached".to_string()])
        );
        assert_eq!(cached.analysis, ai.analysis);

        // force re-runs; a failing model then reports rules without touching the stored AI review.
        let forced = MopAiAnalysisRequest { force: true, ..req };
        let refreshed = analyze_mop_execution_with(&provider, unavailable(), &exec.id, &forced)
            .await
            .unwrap();
        assert_eq!(refreshed.source, "rules");
        let stored = provider.get_mop_execution(&exec.id).await.unwrap();
        assert_eq!(
            stored.ai_analysis.as_deref(),
            Some("VLAN 200 was rejected on core-sw1.")
        );
        assert_eq!(stored.ai_analysis_meta.unwrap().source, "ai");
    }
}
