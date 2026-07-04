//! API route handlers for NetStacks
//!
//! Exposes the DataProvider via REST API endpoints.

use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{sse::{Event as SseEvent, KeepAlive, Sse}, IntoResponse, Response},
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
use crate::ssh::{self, BulkCommandRequest, BulkCommandResponse, SshConfig, build_ssh_config_from_session};

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
    pub enrichment_sources: Arc<tokio::sync::RwLock<std::collections::HashMap<String, crate::models::EnrichmentSource>>>,
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
        Self { entries: std::collections::HashMap::new() }
    }

    pub fn insert(&mut self, request_id: String, output: String) {
        self.entries.retain(|_, v| v.created_at.elapsed() < std::time::Duration::from_secs(300));
        // Hard cap: keep at most 200 entries and 256 MB total to prevent unbounded growth.
        const MAX_ENTRIES: usize = 200;
        const MAX_BYTES: usize = 256 * 1024 * 1024;
        let total_bytes: usize = self.entries.values().map(|v| v.full_output.len()).sum();
        if self.entries.len() >= MAX_ENTRIES || total_bytes + output.len() > MAX_BYTES {
            // Evict the oldest entry.
            if let Some(oldest_key) = self.entries.iter()
                .min_by_key(|(_, v)| v.created_at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }
        self.entries.insert(request_id, CachedOutput {
            full_output: output,
            created_at: std::time::Instant::now(),
        });
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
            if token.as_bytes().ct_eq(app_state.auth_token.as_bytes()).into() {
                next.run(request).await
            } else {
                (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response()
            }
        }
        _ => {
            (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response()
        }
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
        let status = match self.code.as_str() {
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "VAULT_LOCKED" => StatusCode::FORBIDDEN,
            "INVALID_PASSWORD" => StatusCode::UNAUTHORIZED,
            "ACCESS_DENIED" => StatusCode::FORBIDDEN,
            "VALIDATION" => StatusCode::BAD_REQUEST,
            "CONFLICT" => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        (status, Json(self)).into_response()
    }
}

impl From<crate::db::DbError> for ApiError {
    fn from(err: crate::db::DbError) -> Self {
        let error = err.to_string();
        let code = if error.contains("RowNotFound") {
            "NOT_FOUND"
        } else {
            "DATABASE_ERROR"
        };
        ApiError { error, code: code.to_string() }
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
            ProviderError::_AccessDenied => ("ACCESS_DENIED".to_string(), "Access denied".to_string()),
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
    state.provider.set_master_password(req.password.expose()).await?;
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
    state.provider.wipe_vault(req.confirm_password.expose()).await?;
    Ok(StatusCode::NO_CONTENT)
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
        .set_setting(
            "vault.biometric_enabled",
            serde_json::json!(true),
        )
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
pub async fn disable_biometric(
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    crate::biometric::BiometricVaultStore::delete()
        .await
        .map_err(biometric_err_to_api)?;
    state
        .provider
        .set_setting(
            "vault.biometric_enabled",
            serde_json::json!(false),
        )
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
    let snippet = state.provider.create_snippet(Some(&session_id), new_snippet).await?;
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
pub async fn export_all(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ExportData>, ApiError> {
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
        let mut cache = state.sanitizer.write().await;
        *cache = None;
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
            .map(|(slug, title)| KbIndexEntry { slug: slug.to_string(), title: title.to_string() })
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
            .map(|h| KbSearchHit { slug: h.slug.to_string(), title: h.title.to_string(), snippet: h.snippet })
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
        None => Err(ApiError { error: format!("No bundled doc '{}'", slug), code: "NOT_FOUND".to_string() }),
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
            .join(format!("terminal-{}_{}.{}", terminal_id, now.format("%Y%m%d_%H%M%S"), extension))
            .to_string_lossy()
            .to_string()
    };

    // Create the log file
    tokio::fs::File::create(&path).await
        .map_err(|e| ApiError {
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

    tracing::debug!("Writing log for terminal {}: {} bytes to {}", terminal_id, req.content.len(), safe_path.display());

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
                            return Ok(Json(StopLogResponse { document_id: Some(id) }));
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
pub async fn append_to_log(
    Json(req): Json<AppendLogRequest>,
) -> Result<StatusCode, ApiError> {
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
    state.provider.delete_profile_credential(&profile_id).await?;
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

fn default_proxy_verify_ssl() -> bool { true }

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

    match client.send_authed(reqwest::Method::GET, "/api/status/").await {
        Ok(response) => {
            if response.status().is_success() {
                let version = response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("netbox-version").and_then(|v| v.as_str()).map(String::from));

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
                    .and_then(|v| v.get("netbox-version").and_then(|v| v.as_str()).map(String::from));

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
    Ok(Json(SyncCompleteResponse { source: updated_source }))
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
    let host = after_scheme.split(['/', ':', '?', '#'])
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

    if !name_vec.is_empty() { params.push(("name", &name_vec)); }
    if !sites.is_empty() { params.push(("site", &sites)); }
    if !roles.is_empty() { params.push(("role", &roles)); }
    if !manufacturers.is_empty() { params.push(("manufacturer", &manufacturers)); }
    if !platforms.is_empty() { params.push(("platform", &platforms)); }
    if !statuses.is_empty() { params.push(("status", &statuses)); }
    if !tags.is_empty() { params.push(("tag", &tags)); }

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
                match response.json::<NetBoxPaginatedResponse<serde_json::Value>>().await {
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

    if !name_vec.is_empty() { params.push(("name", &name_vec)); }
    if !sites.is_empty() { params.push(("site", &sites)); }
    if !roles.is_empty() { params.push(("role", &roles)); }
    if !manufacturers.is_empty() { params.push(("manufacturer", &manufacturers)); }
    if !platforms.is_empty() { params.push(("platform", &platforms)); }
    if !statuses.is_empty() { params.push(("status", &statuses)); }
    if !tags.is_empty() { params.push(("tag", &tags)); }

    let limit_vec = vec!["1000".to_string()];
    params.push(("limit", &limit_vec));

    let initial_url = build_netbox_url(&req.url, "/dcim/devices/", &params);
    let token = req.token.clone();

    // Collect all devices across all pages. Cap pagination so a NetBox
    // that returns a self-referential `next` chain (misconfigured or
    // malicious) can't OOM the agent. At limit=1000 per page, 200 pages =
    // 200k devices — well past anything a real network ops user has.
    const MAX_NETBOX_PAGES: u32 = 200;
    let mut all_devices: Vec<NetBoxDevice> = vec![];
    let mut next_url: Option<String> = Some(initial_url);
    let mut page_count: u32 = 0;

    while let Some(api_url) = next_url {
        page_count += 1;
        if page_count > MAX_NETBOX_PAGES {
            return Err(ApiError {
                error: format!(
                    "NetBox returned more than {} pages of devices — aborting to prevent runaway memory use",
                    MAX_NETBOX_PAGES,
                ),
                code: "NETBOX_TOO_MANY_PAGES".to_string(),
            });
        }
        tracing::debug!("Fetching NetBox devices page {} from: {}", page_count, api_url);

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

        let raw_text = response.text().await.map_err(|e| ApiError {
            error: format!("Failed to read response: {}", e),
            code: "READ_ERROR".to_string(),
        })?;

        let data: NetBoxPaginatedResponse<NetBoxDevice> = serde_json::from_str(&raw_text)
            .map_err(|e| ApiError {
                error: format!("Failed to parse response: {}", e),
                code: "PARSE_ERROR".to_string(),
            })?;

        tracing::debug!("Page {} returned {} devices (total count: {})", page_count, data.results.len(), data.count);
        all_devices.extend(data.results);

        // Check for next page
        next_url = data.next;
    }

    // Log summary
    let with_ip = all_devices.iter().filter(|d| d.primary_ip.is_some()).count();
    tracing::debug!("Total devices fetched across {} pages: {} (with primary_ip: {})",
              page_count, all_devices.len(), with_ip);

    Ok(Json(all_devices))
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
        .map_err(|e| ApiError { error: format!("Request failed: {}", e), code: "REQUEST_ERROR".to_string() })?;

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
        .map_err(|e| ApiError { error: format!("Request failed: {}", e), code: "REQUEST_ERROR".to_string() })?;

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
            let cable_id = iface.get("cable").and_then(|c| c.get("id")).and_then(|v| v.as_i64());
            let cable_label = iface.get("cable").and_then(|c| c.get("label")).and_then(|v| v.as_str()).map(String::from);
            if let Some(endpoints) = iface.get("connected_endpoints").and_then(|v| v.as_array()) {
                for endpoint in endpoints {
                    let device = endpoint.get("device");
                    let (Some(dev_id), Some(dev_name)) = (
                        device.and_then(|d| d.get("id")).and_then(|v| v.as_i64()),
                        device.and_then(|d| d.get("name")).and_then(|v| v.as_str()),
                    ) else { continue };
                    let remote_name = endpoint.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let pair_key = format!("{}-{}-{}-{}", device_id, dev_id, local_name, remote_name);
                    if !seen_pairs.insert(pair_key) { continue; }
                    let mut n = serde_json::json!({
                        "deviceId": dev_id,
                        "deviceName": dev_name,
                        "localInterface": local_name,
                        "remoteInterface": remote_name,
                    });
                    if let Some(cid) = cable_id { n["cableId"] = serde_json::json!(cid); }
                    if let Some(cl) = &cable_label { n["cableLabel"] = serde_json::json!(cl); }
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
            return s.parse::<i64>().ok().or_else(|| s.parse::<f64>().ok().map(|f| f as i64));
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
    state.provider.store_api_key(&key_type, &req.api_key).await?;
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
    let recordings = state.provider.list_recordings(query.session_id.as_deref()).await?;
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
        Json(SaveRecordingToDocsResponse { document_id: doc_id }),
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
    let rules = state.provider.list_highlight_rules(query.session_id.as_deref()).await?;
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
    let rules = state.provider.get_effective_highlight_rules(&session_id).await?;
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

    // Build SSH configs for each session
    let mut configs: Vec<(SshConfig, String, String)> = Vec::new();

    for session_id in &req.session_ids {
        // Get session from provider
        let session = match state.provider.get_session(session_id).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Failed to get session {}: {}", session_id, e);
                continue;
            }
        };

        // Get the profile for this session (required)
        let profile = match state.provider.get_profile(&session.profile_id).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Failed to get profile for session {} ({}): {}", session_id, session.name, e);
                continue;
            }
        };

        // Get credentials from vault (profile credentials)
        let credential = state
            .provider
            .get_profile_credential(&session.profile_id)
            .await
            .ok()
            .flatten();

        // Build SSH config from session + profile + credential
        let config = match build_ssh_config_from_session(&session, &profile, credential.as_ref()) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Skipping session {} ({}): {}", session_id, session.name, e);
                continue;
            }
        };

        configs.push((config, session_id.clone(), session.name.clone()));
    }

    if configs.is_empty() {
        return Err(ApiError {
            error: "No valid sessions found for bulk command execution".to_string(),
            code: "VALIDATION".to_string(),
        });
    }

    // Execute bulk command
    let response = ssh::execute_bulk_command(configs, req.command, timeout_secs).await;

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
        .await
        .ok()
        .flatten();

    // Build SSH config from session + profile + credential
    let config = build_ssh_config_from_session(&session, &profile, credential.as_ref())
        .map_err(|e| ApiError {
            error: e,
            code: "AUTH_MISSING".to_string(),
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
        },
        false, // never auto-accept changed host keys here
    )
    .await;

    let mut results: Vec<AiSshCommandResult> = Vec::with_capacity(command_list.len());
    let mut all_success = true;
    let mut total_time_ms: u64 = 0;
    let mut aggregated_output = String::new();

    for (i, (cmd, r)) in command_list.iter().zip(shell_results.commands.iter()).enumerate() {
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
        state.output_cache.write().await.insert(request_id.clone(), aggregated_output.clone());
        let truncated = &aggregated_output[..aggregated_output.floor_char_boundary(MAX_INLINE_BYTES)];
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
                    format!("=== [{}] {} ===\n[error] Command timed out after {}s", i + 1, cmd, timeout_secs)
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
        error: if all_success { None } else { Some("One or more commands failed".to_string()) },
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
            format!("Successfully wrote {} bytes to {}", req.content.len(), filepath)
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
    let new_content = apply_edit(&read_result.output, &req.old_text, &req.new_text)
        .map_err(|e| ApiError {
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
        .await
        .ok()
        .flatten();

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
            SftpError::SessionNotFound => ("SESSION_NOT_FOUND".to_string(), "SFTP session not found".to_string()),
            SftpError::_SessionClosed => ("SESSION_CLOSED".to_string(), "SFTP session closed".to_string()),
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
        .await
        .ok()
        .flatten();

    // Build SFTP auth from profile
    let auth = match profile.auth_type {
        AuthType::Password => {
            let password = credential
                .as_ref()
                .and_then(|c| c.password.clone())
                .ok_or_else(|| ApiError {
                    error: format!("No password found for session via profile '{}'", profile.name),
                    code: "AUTH_FAILED".to_string(),
                })?;
            SftpAuth::Password(password)
        }
        AuthType::Key => {
            let key_path = profile.key_path.clone().ok_or_else(|| ApiError {
                error: format!("No key path found for session via profile '{}'", profile.name),
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
    state.manager.create_session(sftp_id.clone(), config).await?;

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
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'.' | b'_' | b'~');
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
    let disposition = axum::http::HeaderValue::from_str(&header_value_str)
        .unwrap_or_else(|_| axum::http::HeaderValue::from_static(
            "attachment; filename=\"download\"",
        ));
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
    body: axum::body::Bytes,
) -> Result<StatusCode, ApiError> {
    let sftp_session = state
        .manager
        .get_session(&sftp_id)
        .await
        .ok_or(SftpError::SessionNotFound)?;

    let session = sftp_session.lock().await;
    session.upload(&query.path, &body).await?;

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
    let change = state.provider.create_change(new_change).await?;
    Ok((StatusCode::CREATED, Json(change)))
}

/// Update an existing change
pub async fn update_change(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateChange>,
) -> Result<Json<Change>, ApiError> {
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
        })
        .collect();

    // Resolve device_overrides keys from session IDs to "name (host)"
    let device_overrides = change.device_overrides.map(|overrides| {
        overrides
            .into_iter()
            .map(|(session_id, steps)| {
                let key = session_map
                    .get(&session_id)
                    .cloned()
                    .unwrap_or(session_id);
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
                    })
                    .collect();
                (key, pkg_steps)
            })
            .collect()
    });

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
            document,
        },
        metadata: MopPackageMetadata::default(),
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
    if !pkg.version.starts_with("1.") && pkg.version != "1" {
        return Err(ApiError {
            error: format!("Unsupported version: '{}', expected 1.x", pkg.version),
            code: "UNSUPPORTED_VERSION".to_string(),
        });
    }

    // Validate steps
    let valid_step_types = ["pre_check", "change", "post_check", "rollback", "api_action"];
    for step in &pkg.mop.steps {
        if step.command.trim().is_empty() {
            return Err(ApiError {
                error: format!("Step {} has an empty command", step.order),
                code: "INVALID_STEP".to_string(),
            });
        }
        if !valid_step_types.contains(&step.step_type.as_str()) {
            warnings.push(format!(
                "Step {} has unknown type '{}', importing anyway",
                step.order, step.step_type
            ));
        }
    }

    // Convert MopPackageStep → MopStep (assign new UUIDs, set status=pending)
    let mop_steps: Vec<MopStep> = pkg
        .mop
        .steps
        .iter()
        .map(|s| MopStep {
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
            device_scope: None,
            device_ids: None,
            deploy_metadata: None,
        })
        .collect();
    let steps_imported = mop_steps.len();

    // Resolve device override keys from "name (host)" → session IDs
    let sessions = state.provider.list_sessions().await?;
    let mut overrides_imported = 0usize;
    let device_overrides = pkg.mop.device_overrides.map(|overrides| {
        let mut resolved: std::collections::HashMap<String, Vec<MopStep>> =
            std::collections::HashMap::new();
        for (key, pkg_steps) in overrides {
            if let Some(session_id) = resolve_session_from_key(&key, &sessions) {
                let steps: Vec<MopStep> = pkg_steps
                    .iter()
                    .map(|s| MopStep {
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
                        device_scope: None,
                        device_ids: None,
                        deploy_metadata: None,
                    })
                    .collect();
                overrides_imported += 1;
                resolved.insert(session_id, steps);
            } else {
                warnings.push(format!(
                    "No matching session for device '{}', overrides skipped",
                    key
                ));
            }
        }
        resolved
    });

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

    sqlx::query(
        r#"INSERT INTO changes (
            id, session_id, name, description, status, mop_steps,
            device_overrides, document_id, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&change_id)
    .bind(None::<String>)  // session-unbound for imported MOPs
    .bind(&pkg.mop.name)
    .bind(&pkg.mop.description)
    .bind(&mop_steps_json)
    .bind(&device_overrides_json)
    .bind(&document_id)
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
    let memory = state.provider.get_or_create_device_memory(&session_id).await?;
    Ok(Json(memory))
}

pub async fn update_device_memory_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(update): Json<UpdateDeviceMemory>,
) -> Result<Json<DeviceMemory>, ApiError> {
    let existing = state.provider.get_or_create_device_memory(&session_id).await?;
    let memory = state.provider.update_device_memory(&existing.memory.id, update).await?;
    Ok(Json(memory))
}

pub async fn create_device_memory_entry_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(entry): Json<NewDeviceMemoryEntry>,
) -> Result<(StatusCode, Json<DeviceMemoryEntry>), ApiError> {
    let existing = state.provider.get_or_create_device_memory(&session_id).await?;
    let new_entry = state.provider.create_device_memory_entry(&existing.memory.id, entry).await?;
    Ok((StatusCode::CREATED, Json(new_entry)))
}

pub async fn update_device_memory_entry_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateDeviceMemoryEntry>,
) -> Result<Json<DeviceMemoryEntry>, ApiError> {
    let entry = state.provider.update_device_memory_entry(&id, update).await?;
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
                let results: Vec<String> = addrs
                    .map(|addr| addr.ip().to_string())
                    .collect();

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
                if lower.starts_with("orgname:") || lower.starts_with("org-name:") || lower.starts_with("organization:") {
                    summary.organization = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("country:") {
                    summary.country = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("netname:") {
                    summary.network_name = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("cidr:") {
                    summary.cidr = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
                } else if lower.starts_with("descr:") && summary.description.is_none() {
                    summary.description = Some(line.split(':').nth(1).unwrap_or("").trim().to_string());
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
    let folder = state.provider.create_folder(NewFolder {
        name: req.name,
        parent_id: req.parent_id,
        scope: Some("topology".into()),
    }).await?;
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
            state.provider.add_topology_device(&topology.id, &session).await.ok();
        }
    }

    Ok((StatusCode::CREATED, Json(topology)))
}

/// Get a single topology with its devices and connections
pub async fn get_topology(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<TopologyWithDetails>, ApiError> {
    let topology = state.provider.get_topology(&id).await?
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
    state.provider.move_topology(&id, req.folder_id, req.sort_order).await?;
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
    tracing::debug!("add_topology_device called: topology_id={}, req={:?}", topology_id, req);

    // Validate topology exists
    state.provider.get_topology(&topology_id).await?
        .ok_or_else(|| ApiError {
            error: format!("Topology not found: {}", topology_id),
            code: "NOT_FOUND".to_string(),
        })?;

    // If session_id is provided, link device to session
    if let Some(session_id) = &req.session_id {
        let session = state.provider.get_session(session_id).await?;
        let device = state.provider.add_topology_device(&topology_id, &session).await?;
        return Ok((StatusCode::CREATED, Json(device)));
    }

    // Otherwise, create a discovered device with provided fields
    let name = req.name.ok_or_else(|| ApiError {
        error: "name is required when session_id is not provided".to_string(),
        code: "VALIDATION_ERROR".to_string(),
    })?;

    let device = state.provider.add_discovered_device(
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
    ).await?;

    Ok((StatusCode::CREATED, Json(device)))
}

/// Update device position within a topology
pub async fn update_topology_device_position(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
    Json(update): Json<UpdateTopologyPosition>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_topology_device_position(&device_id, update.x, update.y).await?;
    Ok(StatusCode::OK)
}

/// Update device type within a topology
pub async fn update_topology_device_type(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
    Json(update): Json<UpdateTopologyDeviceType>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_topology_device_type(&device_id, &update.device_type).await?;
    Ok(StatusCode::OK)
}

/// Update device details (AI enrichment)
pub async fn update_topology_device_details(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, device_id)): Path<(String, String)>,
    Json(update): Json<UpdateTopologyDeviceDetails>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_topology_device_details(&device_id, &update).await?;
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
    let connection = state.provider.create_topology_connection(&topology_id, &req).await?;
    Ok((StatusCode::CREATED, Json(connection)))
}

/// Delete a connection
pub async fn delete_topology_connection(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, connection_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_topology_connection(&connection_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Update a connection (waypoints, label, color, line_style, etc.)
pub async fn update_topology_connection(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, connection_id)): Path<(String, String)>,
    Json(req): Json<UpdateConnectionRequest>,
) -> Result<Json<TopologyConnection>, ApiError> {
    let conn = state.provider.update_topology_connection(&connection_id, &req).await?;
    Ok(Json(conn))
}

// === Topology Annotations Endpoints (Phase 27-03) ===

/// List all annotations for a topology
pub async fn list_topology_annotations(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
) -> Result<Json<Vec<TopologyAnnotation>>, ApiError> {
    let annotations = state.provider.get_topology_annotations(&topology_id).await?;
    Ok(Json(annotations))
}

/// Create a new annotation
pub async fn create_topology_annotation(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
    Json(req): Json<CreateAnnotationRequest>,
) -> Result<(StatusCode, Json<TopologyAnnotation>), ApiError> {
    let annotation = state.provider.create_topology_annotation(&topology_id, &req).await?;
    Ok((StatusCode::CREATED, Json(annotation)))
}

/// Update an annotation
pub async fn update_topology_annotation(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, annotation_id)): Path<(String, String)>,
    Json(req): Json<UpdateAnnotationRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.update_topology_annotation(&annotation_id, &req).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete an annotation
pub async fn delete_topology_annotation(
    State(state): State<Arc<AppState>>,
    Path((_topology_id, annotation_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_topology_annotation(&annotation_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Reorder annotations by z-index
pub async fn reorder_topology_annotations(
    State(state): State<Arc<AppState>>,
    Path(topology_id): Path<String>,
    Json(req): Json<ReorderAnnotationsRequest>,
) -> Result<StatusCode, ApiError> {
    state.provider.reorder_topology_annotations(&topology_id, &req.id_order).await?;
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
    let source = state.provider.create_netstacks_crawler_source(new_source).await?;
    Ok((StatusCode::CREATED, Json(source.into())))
}

/// Update an existing NetStacks-Crawler source
pub async fn update_netstacks_crawler_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateNetStacksCrawlerSource>,
) -> Result<Json<NetStacksCrawlerSourceResponse>, ApiError> {
    let source = state.provider.update_netstacks_crawler_source(&id, update).await?;
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
    let source = state.provider.get_netstacks_crawler_source(source_id).await?;
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
    match client
        .send_authed(reqwest::Method::GET, test_path)
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
        client.get(&api_url)
            .header("X-API-Key", &req.credential)
            .header("Accept", "application/json")
    } else {
        // Basic auth
        let username = req.username.clone().unwrap_or_default();
        client.get(&api_url)
            .basic_auth(&username, Some(&req.credential))
            .header("Accept", "application/json")
    };

    match request.timeout(std::time::Duration::from_secs(10)).send().await {
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
    let results: Vec<NetStacksCrawlerSearchResult> = response.json().await.map_err(|e| ApiError {
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

    if blob.contains("asa") || blob.contains("fortinet") || blob.contains("fortigate")
        || blob.contains("palo") || blob.contains("pan-os") || blob.contains("firewall")
        || blob.contains("checkpoint")
    {
        return "firewall".to_string();
    }
    if blob.contains("catalyst") || blob.contains("nexus") || blob.contains("switch")
        || blob.contains("arista") || blob.contains("eos") || blob.contains("c9300")
        || blob.contains("c9500") || blob.contains("c9200")
    {
        return "switch".to_string();
    }
    if blob.contains("isr") || blob.contains("asr") || blob.contains("router")
        || blob.contains("ios-xr") || blob.contains("junos") || blob.contains("mx")
        || blob.contains("vmx")
    {
        return "router".to_string();
    }
    if blob.contains("access point") || blob.contains("aironet") || blob.contains("wlc")
    {
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
    if blob.contains("cisco") || blob.contains("ios") || blob.contains("nx-os")
        || blob.contains("catalyst") || blob.contains("nexus") || blob.contains("asa")
    {
        return Some("Cisco".to_string());
    }
    if blob.contains("arista") || blob.contains("eos") { return Some("Arista".to_string()); }
    if blob.contains("juniper") || blob.contains("junos") { return Some("Juniper".to_string()); }
    if blob.contains("fortinet") || blob.contains("fortigate") { return Some("Fortinet".to_string()); }
    if blob.contains("palo") || blob.contains("pan-os") { return Some("Palo Alto".to_string()); }
    if blob.contains("hp ") || blob.contains("aruba") || blob.contains("procurve") {
        return Some("HPE/Aruba".to_string());
    }
    if blob.contains("mikrotik") || blob.contains("routeros") { return Some("MikroTik".to_string()); }
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

fn default_import_true() -> bool { true }

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
    Ok(data.get("devices")
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
    Ok(data.get("links")
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
    let mut name_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut ip_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for d in &existing {
        for v in hostname_variants(&d.name) {
            name_index.entry(v).or_insert_with(|| d.id.clone());
        }
        // Index by both primary_ip (enriched) and host (raw connect target)
        // since older devices may only have host populated.
        if let Some(ip) = &d.primary_ip {
            ip_index.entry(ip.to_lowercase()).or_insert_with(|| d.id.clone());
        }
        if !d.host.is_empty() {
            ip_index.entry(d.host.to_lowercase()).or_insert_with(|| d.id.clone());
        }
    }

    let mut devices_created: i64 = 0;
    let mut devices_skipped: i64 = 0;
    let row_y_start = existing.iter().map(|d| d.y as i32).max().unwrap_or(200) as f64 + 100.0;
    let cols = 8usize;
    let dx = 110.0f64;
    let dy = 110.0f64;
    let mut placed = 0usize;
    let mut lib_id_to_topo_id: std::collections::HashMap<i64, String> = std::collections::HashMap::new();

    for dev in &devices {
        let display_name = dev.sys_name.clone().unwrap_or_else(|| dev.hostname.clone());
        let lname_variants = hostname_variants(&display_name);
        let alt_hostname_variants = hostname_variants(&dev.hostname);
        let ip_lower = dev.ip.to_lowercase();

        let existing_id = lname_variants.iter().find_map(|n| name_index.get(n).cloned())
            .or_else(|| alt_hostname_variants.iter().find_map(|n| name_index.get(n).cloned()))
            .or_else(|| {
                if !ip_lower.is_empty() { ip_index.get(&ip_lower).cloned() } else { None }
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

        let created = provider.add_discovered_device(
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
        ).await?;

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
        let _ = provider.update_topology_device_details(&created.id, &details).await;

        for v in &lname_variants { name_index.entry(v.clone()).or_insert_with(|| created.id.clone()); }
        for v in &alt_hostname_variants { name_index.entry(v.clone()).or_insert_with(|| created.id.clone()); }
        if !ip_lower.is_empty() {
            ip_index.entry(ip_lower).or_insert_with(|| created.id.clone());
        }
        lib_id_to_topo_id.insert(dev.device_id, created.id.clone());
        devices_created += 1;
    }

    let mut connections_created: i64 = 0;
    let mut connections_skipped: i64 = 0;
    if include_connections {
        let all_devices = provider.get_topology_devices(topology_id).await?;
        let mut tdev_by_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for d in &all_devices {
            for v in hostname_variants(&d.name) {
                tdev_by_name.entry(v).or_insert_with(|| d.id.clone());
            }
        }

        let mut seen_edges: std::collections::HashSet<(String, String, String, String)> =
            std::collections::HashSet::new();
        for link in links {
            let local_id = lib_id_to_topo_id.get(&link.local_device_id).cloned();
            let remote_id = hostname_variants(&link.remote_hostname).into_iter()
                .find_map(|v| tdev_by_name.get(&v).cloned());
            let (src, dst) = match (local_id, remote_id) {
                (Some(s), Some(d)) if s != d => (s, d),
                _ => { connections_skipped += 1; continue; }
            };
            let key = if src < dst {
                (src.clone(), link.local_port.clone(), dst.clone(), link.remote_port.clone())
            } else {
                (dst.clone(), link.remote_port.clone(), src.clone(), link.local_port.clone())
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
                waypoints: None, curve_style: None, bundle_id: None, bundle_index: None,
                color: None, line_style: None, line_width: None, notes: None,
            };
            match provider.create_topology_connection(topology_id, &req_conn).await {
                Ok(_) => connections_created += 1,
                Err(_) => connections_skipped += 1,
            }
        }
    }

    Ok(ImportTopologyResponse {
        devices_created, connections_created, devices_skipped, connections_skipped,
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
    let mut name_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut ip_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for d in &existing {
        for v in hostname_variants(&d.name) {
            name_index.entry(v).or_insert_with(|| d.id.clone());
        }
        // Index by both primary_ip (enriched) and host (raw connect target)
        // since older devices may only have host populated.
        if let Some(ip) = &d.primary_ip {
            ip_index.entry(ip.to_lowercase()).or_insert_with(|| d.id.clone());
        }
        if !d.host.is_empty() {
            ip_index.entry(d.host.to_lowercase()).or_insert_with(|| d.id.clone());
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
        let display_name = dev.name.clone()
            .or_else(|| dev.dns.clone())
            .unwrap_or_else(|| dev.ip.clone());
        let lname_variants = hostname_variants(&display_name);
        let dns_variants = dev.dns.as_deref().map(hostname_variants).unwrap_or_default();
        let ip_lower = dev.ip.to_lowercase();

        let dup_by_name = lname_variants.iter().any(|n| name_index.contains_key(n))
            || dns_variants.iter().any(|n| name_index.contains_key(n));
        let dup_by_ip = !ip_lower.is_empty() && ip_index.contains_key(&ip_lower);

        if dup_by_name || dup_by_ip {
            devices_skipped += 1;
            continue;
        }

        let device_type = classify_device_type(dev.model.as_deref(), dev.os.as_deref());
        let vendor = dev.vendor.clone().or_else(|| infer_vendor(dev.model.as_deref(), dev.os.as_deref()));

        let col = placed % cols;
        let row = placed / cols;
        let x = 100.0 + (col as f64) * dx;
        let y = row_y_start + (row as f64) * dy;
        placed += 1;

        let created = provider.add_discovered_device(
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
        ).await?;

        let details = UpdateTopologyDeviceDetails {
            device_type: Some(device_type),
            platform: dev.os.clone(),
            version: dev.os_ver.clone(),
            model: dev.model.clone(),
            serial: dev.serial.clone(),
            vendor,
            primary_ip: Some(dev.ip.clone()),
            uptime: dev.uptime.map(|u| u.to_string()),
            status: None, site: None, role: None,
            notes: Some("Imported from NetStacks-Crawler".to_string()),
            profile_id: None,
            snmp_profile_id: None,
        };
        let _ = provider.update_topology_device_details(&created.id, &details).await;

        for v in &lname_variants { name_index.entry(v.clone()).or_insert_with(|| created.id.clone()); }
        for v in &dns_variants { name_index.entry(v.clone()).or_insert_with(|| created.id.clone()); }
        if !ip_lower.is_empty() {
            ip_index.entry(ip_lower).or_insert_with(|| created.id.clone());
        }
        devices_created += 1;
    }

    let mut connections_created: i64 = 0;
    let mut connections_skipped: i64 = 0;
    if include_connections {
        let all_devices = provider.get_topology_devices(topology_id).await?;
        let mut tdev_by_ip: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut tdev_by_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for d in &all_devices {
            if let Some(ip) = &d.primary_ip {
                tdev_by_ip.entry(ip.to_lowercase()).or_insert_with(|| d.id.clone());
            }
            for v in hostname_variants(&d.name) {
                tdev_by_name.entry(v).or_insert_with(|| d.id.clone());
            }
        }
        let mut seen_edges: std::collections::HashSet<(String, String, String, String)> =
            std::collections::HashSet::new();
        for link in links {
            let left = tdev_by_ip.get(&link.left_ip.to_lowercase()).cloned()
                .or_else(|| link.left_dns.as_deref().and_then(|d| {
                    hostname_variants(d).into_iter().find_map(|v| tdev_by_name.get(&v).cloned())
                }));
            let right = tdev_by_ip.get(&link.right_ip.to_lowercase()).cloned()
                .or_else(|| link.right_dns.as_deref().and_then(|d| {
                    hostname_variants(d).into_iter().find_map(|v| tdev_by_name.get(&v).cloned())
                }));
            let (src, dst) = match (left, right) {
                (Some(s), Some(d)) if s != d => (s, d),
                _ => { connections_skipped += 1; continue; }
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
                waypoints: None, curve_style: None, bundle_id: None, bundle_index: None,
                color: None, line_style: None, line_width: None,
                notes: link.speed.clone().map(|s| format!("speed: {}", s)),
            };
            match provider.create_topology_connection(topology_id, &req_conn).await {
                Ok(_) => connections_created += 1,
                Err(_) => connections_skipped += 1,
            }
        }
    }

    Ok(ImportTopologyResponse {
        devices_created, connections_created, devices_skipped, connections_skipped,
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
    state.provider.get_topology(&req.topology_id).await?
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
        &*state.provider, &req.topology_id, devices, links, req.include_connections,
    ).await?;
    Ok(Json(resp))
}

/// Import all devices + L2 links from a NetStacks-Crawler source into a topology.
pub async fn netstacks_crawler_import_topology(
    State(state): State<Arc<AppState>>,
    Path(source_id): Path<String>,
    Json(req): Json<NetStacksCrawlerImportTopologyRequest>,
) -> Result<Json<ImportTopologyResponse>, ApiError> {
    state.provider.get_topology(&req.topology_id).await?
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
        &*state.provider, &req.topology_id, devices, links, req.include_connections,
    ).await?;
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
    let layout = state.provider.get_layout(&id).await?
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
    let existing = state.provider.get_layout(&id).await?
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
    let resource = state.provider.get_api_resource(&id).await?
        .ok_or_else(|| ApiError { error: format!("API resource not found: {}", id), code: "NOT_FOUND".to_string() })?;
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
    let resource = state.provider.get_api_resource(&id).await?
        .ok_or_else(|| ApiError { error: format!("API resource not found: {}", id), code: "NOT_FOUND".to_string() })?;
    let credentials = state.provider.get_api_resource_credentials(&id).await.ok().flatten();

    let has_test_path = resource.test_path.as_deref().map(|p| !p.trim().is_empty()).unwrap_or(false);
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
    ).await;

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

    let has_test_path = req.resource.test_path.as_deref().map(|p| !p.trim().is_empty()).unwrap_or(false);
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
    ).await;

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
    let action = state.provider.get_quick_action(&id).await?
        .ok_or_else(|| ApiError { error: format!("Quick action not found: {}", id), code: "NOT_FOUND".to_string() })?;
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
    let action = state.provider.get_quick_action(&id).await?
        .ok_or_else(|| ApiError { error: format!("Quick action not found: {}", id), code: "NOT_FOUND".to_string() })?;
    let resource = state.provider.get_api_resource(&action.api_resource_id).await?
        .ok_or_else(|| ApiError { error: "Referenced API resource not found".to_string(), code: "NOT_FOUND".to_string() })?;
    let credentials = state.provider.get_api_resource_credentials(&action.api_resource_id).await.ok().flatten();

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
    ).await;

    Ok(Json(result))
}

/// Execute a quick action inline (without saving)
pub async fn execute_inline_quick_action(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExecuteInlineQuickActionRequest>,
) -> Result<Json<QuickActionResult>, ApiError> {
    tracing::debug!(
        "execute_inline_quick_action: api_resource_id={} method={} path={} variables={:?}",
        req.api_resource_id, req.method, req.path, req.variables.keys().collect::<Vec<_>>()
    );
    let resource = state.provider.get_api_resource(&req.api_resource_id).await?
        .ok_or_else(|| {
            tracing::warn!("execute_inline_quick_action: api_resource_id '{}' not found in DB", req.api_resource_id);
            ApiError { error: format!("API resource '{}' not found", req.api_resource_id), code: "NOT_FOUND".to_string() }
        })?;
    let credentials = state.provider.get_api_resource_credentials(&req.api_resource_id).await.ok().flatten();

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
    ).await;

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
    let definition = state.provider.get_agent_definition(&id).await?
        .ok_or_else(|| ApiError::from(ProviderError::NotFound(format!("Agent definition not found: {}", id))))?;
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
) -> Result<Json<crate::tasks::AgentTask>, (StatusCode, String)> {
    // Verify agent definition exists and is enabled (Feature A safety fix:
    // a disabled definition must not run via the API).
    let definition = state.provider.get_agent_definition(&id).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Agent definition not found: {}", id)))?;
    if !definition.enabled {
        return Err((
            StatusCode::CONFLICT,
            format!("Agent definition '{}' is disabled", id),
        ));
    }

    // Create task with agent_definition_id
    let task = state
        .task_store
        .create_task_with_agent(crate::tasks::CreateTaskRequest { prompt: req.prompt, _failure_policy: None }, Some(id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Spawn for background execution
    if let Err(e) = state.task_executor.spawn_task(task.id.clone()).await {
        tracing::warn!("Failed to spawn agent task {}: {}", task.id, e);
    }

    Ok(Json(task))
}

// === MOP Templates API (Phase 30) ===

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
    let created = state.provider.create_mop_template(template).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Update a MOP template
pub async fn update_mop_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateMopTemplate>,
) -> Result<Json<MopTemplate>, ApiError> {
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
    let created = state.provider.create_mop_execution(execution).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Update a MOP execution
pub async fn update_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateMopExecution>,
) -> Result<Json<MopExecution>, ApiError> {
    let updated = state.provider.update_mop_execution(&id, update).await?;
    Ok(Json(updated))
}

/// Delete a MOP execution
pub async fn delete_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.provider.delete_mop_execution(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// === MOP Execution Control API (Phase 30) ===

/// Start a MOP execution
pub async fn start_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let update = UpdateMopExecution {
        status: Some(ExecutionStatus::Running),
        started_at: Some(Some(chrono::Utc::now())),
        current_phase: Some(Some("pre_checks".to_string())),
        ..Default::default()
    };
    let execution = state.provider.update_mop_execution(&id, update).await?;
    Ok(Json(execution))
}

/// Pause a MOP execution
pub async fn pause_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    // Capture checkpoint before pausing
    let execution = state.provider.get_mop_execution(&id).await?;
    let checkpoint = serde_json::to_string(&execution).ok();

    let update = UpdateMopExecution {
        status: Some(ExecutionStatus::Paused),
        last_checkpoint: Some(checkpoint),
        ..Default::default()
    };
    let execution = state.provider.update_mop_execution(&id, update).await?;
    Ok(Json(execution))
}

/// Resume a paused MOP execution
pub async fn resume_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let update = UpdateMopExecution {
        status: Some(ExecutionStatus::Running),
        ..Default::default()
    };
    let execution = state.provider.update_mop_execution(&id, update).await?;
    Ok(Json(execution))
}

/// Abort a MOP execution
pub async fn abort_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MopExecution>, ApiError> {
    let update = UpdateMopExecution {
        status: Some(ExecutionStatus::Aborted),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    let execution = state.provider.update_mop_execution(&id, update).await?;
    Ok(Json(execution))
}

/// Complete a MOP execution with AI analysis
#[derive(Debug, Deserialize)]
pub struct CompleteExecutionRequest {
    pub ai_analysis: Option<String>,
}

pub async fn complete_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<CompleteExecutionRequest>,
) -> Result<Json<MopExecution>, ApiError> {
    let update = UpdateMopExecution {
        status: Some(ExecutionStatus::Complete),
        completed_at: Some(Some(chrono::Utc::now())),
        ai_analysis: Some(req.ai_analysis),
        ..Default::default()
    };
    let execution = state.provider.update_mop_execution(&id, update).await?;
    Ok(Json(execution))
}

// === MOP Execution Devices API (Phase 30) ===

/// List devices for a MOP execution
pub async fn list_execution_devices(
    State(state): State<Arc<AppState>>,
    Path(execution_id): Path<String>,
) -> Result<Json<Vec<MopExecutionDevice>>, ApiError> {
    let devices = state.provider.list_mop_execution_devices(&execution_id).await?;
    Ok(Json(devices))
}

/// Add a device to a MOP execution
pub async fn add_execution_device(
    State(state): State<Arc<AppState>>,
    Path(execution_id): Path<String>,
    Json(device): Json<NewMopExecutionDevice>,
) -> Result<(StatusCode, Json<MopExecutionDevice>), ApiError> {
    // Ensure execution_id matches the path
    let device_data = NewMopExecutionDevice {
        execution_id,
        session_id: device.session_id,
        device_id: device.device_id,
        credential_id: device.credential_id,
        device_name: device.device_name,
        device_host: device.device_host,
        role: device.role,
        device_order: device.device_order,
    };
    let created = state.provider.create_mop_execution_device(device_data).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Skip a device in a MOP execution
pub async fn skip_execution_device(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionDevice>, ApiError> {
    let update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Skipped),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    let device = state.provider.update_mop_execution_device(&device_id, update).await?;
    Ok(Json(device))
}

/// Retry a failed device in a MOP execution
pub async fn retry_execution_device(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionDevice>, ApiError> {
    let update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Pending),
        error_message: Some(None),
        started_at: Some(None),
        completed_at: Some(None),
        ..Default::default()
    };
    let device = state.provider.update_mop_execution_device(&device_id, update).await?;
    Ok(Json(device))
}

/// Rollback a device in a MOP execution
pub async fn rollback_execution_device(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionDevice>, ApiError> {
    // Mark device for rollback - actual rollback logic handled by frontend/wizard
    let update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Running),
        current_step_id: Some(None), // Will be set to rollback steps
        ..Default::default()
    };
    let device = state.provider.update_mop_execution_device(&device_id, update).await?;
    Ok(Json(device))
}

// === MOP Execution Steps API (Phase 30) ===

/// List steps for a device
pub async fn list_execution_steps(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<Vec<MopExecutionStep>>, ApiError> {
    let steps = state.provider.list_mop_execution_steps(&device_id).await?;
    Ok(Json(steps))
}

/// Add steps to a device (bulk create)
pub async fn add_execution_steps(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, device_id)): Path<(String, String)>,
    Json(steps): Json<Vec<NewMopExecutionStep>>,
) -> Result<(StatusCode, Json<Vec<MopExecutionStep>>), ApiError> {
    // Ensure device_id matches for all steps
    let steps_data: Vec<NewMopExecutionStep> = steps
        .into_iter()
        .map(|s| NewMopExecutionStep {
            execution_device_id: device_id.clone(),
            ..s
        })
        .collect();
    let created = state.provider.bulk_create_mop_execution_steps(steps_data).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Resolve runtime context variables in a string.
/// Supports: {{device.host}}, {{device.name}}, {{device.type}}
fn resolve_runtime_vars(template: &str, device_host: &str, device_name: &str) -> String {
    template
        .replace("{{device.host}}", device_host)
        .replace("{{device.name}}", device_name)
        .replace("{{device.type}}", "") // not available in standalone
}

/// Resolve runtime variables in a JSON value (recurse into string values)
fn resolve_runtime_vars_json(value: &serde_json::Value, device_host: &str, device_name: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(resolve_runtime_vars(s, device_host, device_name)),
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                new_map.insert(k.clone(), resolve_runtime_vars_json(v, device_host, device_name));
            }
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(|v| resolve_runtime_vars_json(v, device_host, device_name)).collect())
        }
        other => other.clone(),
    }
}

/// Execute a quick action step: fetch action, resolve variables, execute, return output + status + resolved vars
async fn execute_quick_action_step(
    provider: &dyn DataProvider,
    action_id: &str,
    raw_variables: &Option<serde_json::Value>,
    device_host: &str,
    device_name: &str,
    auth_cache: Option<&crate::api_resource_client::AuthCache>,
) -> Result<(String, StepExecutionStatus, std::collections::HashMap<String, String>), ApiError> {
    let action = provider.get_quick_action(action_id).await?
        .ok_or_else(|| ApiError { error: format!("Quick action not found: {}", action_id), code: "NOT_FOUND".to_string() })?;
    let resource = provider.get_api_resource(&action.api_resource_id).await?
        .ok_or_else(|| ApiError { error: "API resource not found".to_string(), code: "NOT_FOUND".to_string() })?;
    let credentials = provider.get_api_resource_credentials(&action.api_resource_id).await.ok().flatten();

    let raw: std::collections::HashMap<String, String> = raw_variables
        .as_ref()
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let variables: std::collections::HashMap<String, String> = raw
        .into_iter()
        .map(|(k, v)| (k, resolve_runtime_vars(&v, device_host, device_name)))
        .collect();

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
    ).await;

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
    device_host: &str,
    device_name: &str,
) -> Result<(String, StepExecutionStatus, Option<serde_json::Value>), ApiError> {
    let pool = provider.get_pool();
    let script = crate::scripts::get_script_by_id(pool, script_id).await
        .map_err(|e| ApiError { error: e.error, code: e.code })?;

    let resolved_args = raw_args.as_ref().map(|args| {
        resolve_runtime_vars_json(args, device_host, device_name)
    });
    let main_args = resolved_args.as_ref().map(|v| v.to_string());

    let result = crate::scripts::run_script_once(
        &script.content,
        None,
        main_args.as_deref(),
    ).await;

    let (status, output) = match result {
        Ok(script_output) => {
            if script_output.exit_code == 0 {
                (StepExecutionStatus::Passed, script_output.stdout)
            } else {
                let err_output = if script_output.stderr.is_empty() {
                    script_output.stdout
                } else {
                    format!("{}\n\nSTDERR:\n{}", script_output.stdout, script_output.stderr)
                };
                (StepExecutionStatus::Failed, err_output)
            }
        }
        Err(e) => (StepExecutionStatus::Failed, format!("Script error: {}", e.error)),
    };

    Ok((output, status, resolved_args))
}

/// Update a step execution with completion status, output, and duration
async fn finalize_step_execution(
    provider: &dyn DataProvider,
    step_id: &str,
    status: StepExecutionStatus,
    output: String,
    started_at: chrono::DateTime<chrono::Utc>,
    extra_fields: Option<UpdateMopExecutionStep>,
) -> Result<MopExecutionStep, ApiError> {
    let now = chrono::Utc::now();
    let duration_ms = (now - started_at).num_milliseconds();

    let mut update = extra_fields.unwrap_or_default();
    update.status = Some(status);
    update.output = Some(Some(output));
    update.completed_at = Some(Some(now));
    update.duration_ms = Some(Some(duration_ms));

    Ok(provider.update_mop_execution_step(step_id, update).await?)
}

/// Map an SSH shell command result to a step execution status and output string
fn map_ssh_result_to_step_status(result: &ssh::ShellCommandResult) -> (StepExecutionStatus, String) {
    match result.status {
        ssh::CommandStatus::Success => (StepExecutionStatus::Passed, result.transcript.clone()),
        ssh::CommandStatus::Error => (StepExecutionStatus::Failed,
            if result.transcript.is_empty() {
                format!("Error: {}", result.error.as_deref().unwrap_or_default())
            } else {
                format!("{}\n\nError: {}", result.transcript, result.error.as_deref().unwrap_or_default())
            }),
        ssh::CommandStatus::Timeout => (StepExecutionStatus::Failed,
            if result.transcript.is_empty() {
                "Command timed out".to_string()
            } else {
                format!("{}\n\n[Command timed out]", result.transcript)
            }),
        ssh::CommandStatus::AuthFailed => (StepExecutionStatus::Failed, "Authentication failed - check credentials".to_string()),
    }
}

/// Execute a step - actually runs the command on the device via SSH
pub async fn execute_step(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, step_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let start_time = chrono::Utc::now();

    // Mark step as running
    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Running),
        started_at: Some(Some(start_time)),
        ..Default::default()
    };
    let step = state.provider.update_mop_execution_step(&step_id, update).await?;

    // Check if mock mode is enabled
    if step.mock_enabled {
        let mock_output = step.mock_output.clone().unwrap_or_else(|| "[MOCKED] No mock output provided".to_string());
        let now = chrono::Utc::now();
        let duration_ms = (now - start_time).num_milliseconds();

        let update = UpdateMopExecutionStep {
            status: Some(StepExecutionStatus::Mocked),
            output: Some(Some(mock_output)),
            completed_at: Some(Some(now)),
            duration_ms: Some(Some(duration_ms)),
            ..Default::default()
        };
        let step = state.provider.update_mop_execution_step(&step_id, update).await?;
        return Ok(Json(step));
    }

    // Resolve device context for runtime variable substitution
    let (device_host, device_name) = {
        let device = state.provider.get_mop_execution_device(&step.execution_device_id).await.ok();
        if let Some(ref dev) = device {
            let session = if let Some(ref sid) = dev.session_id {
                state.provider.get_session(sid).await.ok()
            } else { None };
            (
                session.as_ref().map(|s| s.host.clone()).unwrap_or_default(),
                session.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
            )
        } else {
            (String::new(), String::new())
        }
    };

    // Handle quick_action execution source (or legacy api_action step type)
    if step.execution_source == "quick_action" || step.step_type == MopStepType::ApiAction {
        let action_id = step.quick_action_id.as_deref().unwrap_or(&step.command);
        let (output, status, variables) = execute_quick_action_step(
            state.provider.as_ref(),
            action_id,
            &step.quick_action_variables,
            &device_host,
            &device_name,
            Some(&state.auth_cache),
        ).await?;

        let extra = UpdateMopExecutionStep {
            quick_action_variables: Some(Some(serde_json::to_value(&variables).unwrap_or_default())),
            ..Default::default()
        };
        let step = finalize_step_execution(
            state.provider.as_ref(), &step_id, status, output, start_time, Some(extra),
        ).await?;
        return Ok(Json(step));
    }

    // Handle script execution source
    if step.execution_source == "script" {
        let script_id = step.script_id.as_deref().unwrap_or(&step.command);
        let (output, status, resolved_args) = execute_script_step(
            state.provider.as_ref(),
            script_id,
            &step.script_args,
            &device_host,
            &device_name,
        ).await?;

        let extra = UpdateMopExecutionStep {
            script_args: Some(resolved_args),
            ..Default::default()
        };
        let step = finalize_step_execution(
            state.provider.as_ref(), &step_id, status, output, start_time, Some(extra),
        ).await?;
        return Ok(Json(step));
    }

    // Get the device to find the session_id
    let device = state.provider.get_mop_execution_device(&step.execution_device_id).await?;

    // Get the session
    let session_id = device.session_id.as_deref()
        .ok_or_else(|| ApiError { error: "Device has no session_id".to_string(), code: "VALIDATION".to_string() })?;
    let session = state.provider.get_session(session_id).await?;

    // Get the profile for credentials
    let profile = state.provider.get_profile(&session.profile_id).await?;

    // Get credential from profile (profile credentials, not session-level)
    let credential = state
        .provider
        .get_profile_credential(&session.profile_id)
        .await
        .ok()
        .flatten();

    // Build SSH config from session + profile + credential
    let config = match build_ssh_config_from_session(&session, &profile, credential.as_ref()) {
        Ok(c) => c,
        Err(e) => {
            // Update step as failed - missing credentials
            let update = UpdateMopExecutionStep {
                status: Some(StepExecutionStatus::Failed),
                output: Some(Some(e)),
                completed_at: Some(Some(chrono::Utc::now())),
                ..Default::default()
            };
            let step = state.provider.update_mop_execution_step(&step_id, update).await?;
            return Ok(Json(step));
        }
    };

    // Load auto_commands: session-level override, fallback to profile
    let auto_commands = if session.auto_commands.is_empty() {
        profile.auto_commands.clone()
    } else {
        session.auto_commands.clone()
    };

    // Execute single command via shell (opens fresh SSH connection with auto_commands).
    // AUDIT FIX (REMOTE-003): default to refusing changed host keys.
    // A future per-execution "expect new host key" toggle would feed in here.
    let shell_results = ssh::execute_commands_via_shell(
        config,
        session_id.to_string(),
        session.name.clone(),
        ssh::ShellCommandBatch {
            auto_commands,
            commands: vec![(step_id.clone(), step.command.clone())],
            post_commands: vec![], // no post-commands for single step execution
            timeout_per_command: std::time::Duration::from_secs(60),
        },
        false, // auto_accept_changed_keys
    ).await;

    // Get the single result
    let result = shell_results.commands.into_iter().next().unwrap_or(ssh::ShellCommandResult {
        step_id: step_id.clone(),
        status: ssh::CommandStatus::Error,
        output: String::new(),
        error: Some("No result returned".to_string()),
        execution_time_ms: 0,
        transcript: String::new(),
    });

    let (status, final_output) = map_ssh_result_to_step_status(&result);

    let step = finalize_step_execution(
        state.provider.as_ref(), &step_id, status, final_output, start_time, None,
    ).await?;

    Ok(Json(step))
}

/// Approve a step (mark as passed)
pub async fn approve_step(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, step_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let step = state.provider.get_mop_execution_step(&step_id).await?;
    let now = chrono::Utc::now();
    let duration_ms = step.started_at.map(|start| (now - start).num_milliseconds());

    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Passed),
        completed_at: Some(Some(now)),
        duration_ms: Some(duration_ms),
        ..Default::default()
    };
    let step = state.provider.update_mop_execution_step(&step_id, update).await?;
    Ok(Json(step))
}

/// Skip a step
pub async fn skip_step(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, step_id)): Path<(String, String)>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let update = UpdateMopExecutionStep {
        status: Some(StepExecutionStatus::Skipped),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    let step = state.provider.update_mop_execution_step(&step_id, update).await?;
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
    Path((_exec_id, step_id)): Path<(String, String)>,
    Json(mock): Json<MockConfig>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let update = UpdateMopExecutionStep {
        mock_enabled: Some(mock.mock_enabled),
        mock_output: Some(mock.mock_output),
        ..Default::default()
    };
    let step = state.provider.update_mop_execution_step(&step_id, update).await?;
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
    Path((_exec_id, step_id)): Path<(String, String)>,
    Json(payload): Json<StepCommandUpdate>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let command = payload.command.trim().to_string();
    if command.is_empty() {
        return Err(ApiError {
            error: "command must be non-empty".to_string(),
            code: "VALIDATION".to_string(),
        });
    }
    let update = UpdateMopExecutionStep {
        command: Some(command),
        ..Default::default()
    };
    let step = state.provider.update_mop_execution_step(&step_id, update).await?;
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
    Path((_exec_id, step_id)): Path<(String, String)>,
    Json(output): Json<StepOutputUpdate>,
) -> Result<Json<MopExecutionStep>, ApiError> {
    let step = state.provider.get_mop_execution_step(&step_id).await?;
    let now = chrono::Utc::now();
    let duration_ms = step.started_at.map(|start| (now - start).num_milliseconds());

    let update = UpdateMopExecutionStep {
        status: Some(output.status),
        output: Some(output.output),
        ai_feedback: Some(output.ai_feedback),
        completed_at: Some(Some(now)),
        duration_ms: Some(duration_ms),
        ..Default::default()
    };
    let step = state.provider.update_mop_execution_step(&step_id, update).await?;
    Ok(Json(step))
}

// === MOP Phase Execution & Snapshot APIs ===

/// Request to execute all steps of a specific type for a device
#[derive(Debug, Deserialize)]
pub struct ExecutePhaseRequest {
    pub step_type: MopStepType, // pre_check, change, post_check
}

/// Response with phase execution results
#[derive(Debug, Serialize)]
pub struct PhaseExecutionResult {
    pub device_id: String,
    pub step_type: String,
    pub steps_executed: usize,
    pub steps_passed: usize,
    pub steps_failed: usize,
    pub snapshot_id: Option<String>,
    pub combined_output: String,
}

/// Execute all steps of a phase for a device and capture snapshot
pub async fn execute_device_phase(
    State(state): State<Arc<AppState>>,
    Path((exec_id, device_id)): Path<(String, String)>,
    Json(req): Json<ExecutePhaseRequest>,
) -> Result<Json<PhaseExecutionResult>, ApiError> {
    tracing::info!("execute_device_phase called: exec_id={}, device_id={}, step_type={:?}", exec_id, device_id, req.step_type);
    // Get the device
    let device = state.provider.get_mop_execution_device(&device_id).await.map_err(|e| {
        tracing::error!("execute_device_phase: failed to get device {}: {}", device_id, e);
        ApiError::from(e)
    })?;

    // Get all steps for this device
    let all_steps = state.provider.list_mop_execution_steps(&device_id).await?;

    // Filter to the requested step type
    let phase_steps: Vec<_> = all_steps.into_iter()
        .filter(|s| s.step_type == req.step_type)
        .collect();

    if phase_steps.is_empty() {
        return Ok(Json(PhaseExecutionResult {
            device_id: device_id.clone(),
            step_type: format!("{:?}", req.step_type),
            steps_executed: 0,
            steps_passed: 0,
            steps_failed: 0,
            snapshot_id: None,
            combined_output: "No steps to execute".to_string(),
        }));
    }

    // Get session info for SSH execution
    let session_id = device.session_id.as_deref()
        .ok_or_else(|| ApiError { error: "Device has no session_id".to_string(), code: "VALIDATION".to_string() })?;
    let session = state.provider.get_session(session_id).await?;
    let profile = state.provider.get_profile(&session.profile_id).await?;
    let credential = state
        .provider
        .get_profile_credential(&session.profile_id)
        .await
        .ok()
        .flatten();

    // Build SSH config from session + profile + credential
    let config = build_ssh_config_from_session(&session, &profile, credential.as_ref())
        .map_err(|e| ApiError {
            error: e,
            code: "AUTH_MISSING".to_string(),
        })?;

    // Load auto_commands: session-level override, fallback to profile
    let mut auto_commands = if session.auto_commands.is_empty() {
        profile.auto_commands.clone()
    } else {
        session.auto_commands.clone()
    };

    // Auto-enter config mode for change steps (like an engineer would at the CLI)
    // and auto-save config after changes complete
    let mut post_commands = Vec::new();
    if req.step_type == MopStepType::Change {
        auto_commands.push("configure terminal".to_string());
        // After change steps: exit config mode, then save config
        post_commands.push("end".to_string());
        post_commands.push("write memory".to_string());
    }

    // Update device status to running
    let device_update = UpdateMopExecutionDevice {
        status: Some(DeviceExecutionStatus::Running),
        started_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    state.provider.update_mop_execution_device(&device_id, device_update).await?;

    // Handle mocked steps and collect real commands
    let mut combined_output = String::new();
    let mut commands_run = Vec::new();
    let mut steps_passed = 0;
    let mut steps_failed = 0;

    // Process mocked steps first
    for step in &phase_steps {
        if step.mock_enabled {
            let now = chrono::Utc::now();
            let mock_out = step.mock_output.clone().unwrap_or_else(|| "[MOCKED]".to_string());
            let update = UpdateMopExecutionStep {
                status: Some(StepExecutionStatus::Mocked),
                output: Some(Some(mock_out.clone())),
                started_at: Some(Some(now)),
                completed_at: Some(Some(now)),
                duration_ms: Some(Some(0)),
                ..Default::default()
            };
            state.provider.update_mop_execution_step(&step.id, update).await?;
            steps_passed += 1;
            combined_output.push_str(&format!("\n=== {} ===\n[MOCKED]\n{}\n",
                step.description.as_deref().unwrap_or("Command"), mock_out));
            commands_run.push(step.command.clone());
        }
    }

    // Separate non-mocked steps by execution source
    let non_mocked: Vec<_> = phase_steps.iter().filter(|s| !s.mock_enabled).collect();
    let cli_commands: Vec<(String, String)> = non_mocked.iter()
        .filter(|s| s.execution_source != "quick_action" && s.execution_source != "script")
        .map(|s| (s.id.clone(), s.command.clone()))
        .collect();
    let qa_steps: Vec<_> = non_mocked.iter()
        .filter(|s| s.execution_source == "quick_action")
        .collect();
    let script_steps: Vec<_> = non_mocked.iter()
        .filter(|s| s.execution_source == "script")
        .collect();

    // Device context for runtime variable resolution
    let device_host = session.host.clone();
    let device_name = session.name.clone();

    // Execute Quick Action steps
    for step in &qa_steps {
        let step_start = chrono::Utc::now();
        let update = UpdateMopExecutionStep {
            status: Some(StepExecutionStatus::Running),
            started_at: Some(Some(step_start)),
            ..Default::default()
        };
        state.provider.update_mop_execution_step(&step.id, update).await?;

        let action_id = step.quick_action_id.as_deref().unwrap_or(&step.command);
        let (output, status, resolved_vars) = match execute_quick_action_step(
            state.provider.as_ref(),
            action_id,
            &step.quick_action_variables,
            &device_host,
            &device_name,
            Some(&state.auth_cache),
        ).await {
            Ok(result) => result,
            Err(e) => (format!("Quick action error: {}", e.error), StepExecutionStatus::Failed, std::collections::HashMap::new()),
        };

        let extra = UpdateMopExecutionStep {
            quick_action_variables: Some(Some(serde_json::to_value(&resolved_vars).unwrap_or_default())),
            ..Default::default()
        };
        finalize_step_execution(
            state.provider.as_ref(), &step.id, status.clone(), output.clone(), step_start, Some(extra),
        ).await?;
        match status {
            StepExecutionStatus::Passed => steps_passed += 1,
            StepExecutionStatus::Failed => steps_failed += 1,
            _ => {}
        }
        combined_output.push_str(&format!("\n=== {} [Quick Action] ===\n{}\n",
            step.description.as_deref().unwrap_or("Quick Action"), output));
        commands_run.push(step.command.clone());
    }

    // Execute Script steps
    for step in &script_steps {
        let step_start = chrono::Utc::now();
        let update = UpdateMopExecutionStep {
            status: Some(StepExecutionStatus::Running),
            started_at: Some(Some(step_start)),
            ..Default::default()
        };
        state.provider.update_mop_execution_step(&step.id, update).await?;

        let script_id = step.script_id.as_deref().unwrap_or(&step.command);
        let (output, status, resolved_args) = match execute_script_step(
            state.provider.as_ref(),
            script_id,
            &step.script_args,
            &device_host,
            &device_name,
        ).await {
            Ok(result) => result,
            Err(e) => (format!("Script error: {}", e.error), StepExecutionStatus::Failed, None),
        };

        let extra = UpdateMopExecutionStep {
            script_args: Some(resolved_args),
            ..Default::default()
        };
        finalize_step_execution(
            state.provider.as_ref(), &step.id, status.clone(), output.clone(), step_start, Some(extra),
        ).await?;
        match status {
            StepExecutionStatus::Passed => steps_passed += 1,
            StepExecutionStatus::Failed => steps_failed += 1,
            _ => {}
        }
        combined_output.push_str(&format!("\n=== {} [Script] ===\n{}\n",
            step.description.as_deref().unwrap_or("Script"), output));
        commands_run.push(step.command.clone());
    }

    // Execute CLI steps via SSH shell session (batched)
    if !cli_commands.is_empty() {
        for (step_id, _) in &cli_commands {
            let update = UpdateMopExecutionStep {
                status: Some(StepExecutionStatus::Running),
                started_at: Some(Some(chrono::Utc::now())),
                ..Default::default()
            };
            state.provider.update_mop_execution_step(step_id, update).await?;
        }

        // AUDIT FIX (REMOTE-003): default-refuse changed host keys.
        let shell_results = ssh::execute_commands_via_shell(
            config,
            session_id.to_string(),
            session.name.clone(),
            ssh::ShellCommandBatch {
                auto_commands,
                commands: cli_commands.clone(),
                post_commands,
                timeout_per_command: std::time::Duration::from_secs(60),
            },
            false, // auto_accept_changed_keys
        ).await;

        for result in &shell_results.commands {
            let (status, output) = map_ssh_result_to_step_status(result);

            let now = chrono::Utc::now();
            let update = UpdateMopExecutionStep {
                status: Some(status.clone()),
                output: Some(Some(output)),
                completed_at: Some(Some(now)),
                duration_ms: Some(Some(result.execution_time_ms as i64)),
                ..Default::default()
            };
            state.provider.update_mop_execution_step(&result.step_id, update).await?;

            match status {
                StepExecutionStatus::Passed => steps_passed += 1,
                StepExecutionStatus::Failed => steps_failed += 1,
                _ => {}
            }

            let cmd_text = cli_commands.iter().find(|(id, _)| id == &result.step_id)
                .map(|(_, cmd)| cmd.as_str()).unwrap_or("");
            commands_run.push(cmd_text.to_string());
        }
        combined_output.push_str(&shell_results.full_transcript);
    }

    // Update device status based on results
    let device_status = if steps_failed > 0 {
        DeviceExecutionStatus::Failed
    } else {
        DeviceExecutionStatus::Complete
    };
    let device_update = UpdateMopExecutionDevice {
        status: Some(device_status),
        completed_at: Some(Some(chrono::Utc::now())),
        ..Default::default()
    };
    state.provider.update_mop_execution_device(&device_id, device_update).await?;

    // Create snapshot for pre_check or post_check phases
    let snapshot_id = if req.step_type == MopStepType::PreCheck || req.step_type == MopStepType::PostCheck {
        let snapshot_type = if req.step_type == MopStepType::PreCheck { "pre" } else { "post" };
        let snapshot = state.provider.create_snapshot(NewSnapshot {
            change_id: exec_id.clone(), // Use execution ID as the reference
            snapshot_type: snapshot_type.to_string(),
            commands: commands_run,
            output: combined_output.clone(),
        }).await?;

        // Update device with snapshot reference
        let snapshot_update = if req.step_type == MopStepType::PreCheck {
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
        state.provider.update_mop_execution_device(&device_id, snapshot_update).await?;

        Some(snapshot.id)
    } else {
        None
    };

    Ok(Json(PhaseExecutionResult {
        device_id,
        step_type: format!("{:?}", req.step_type),
        steps_executed: phase_steps.len(),
        steps_passed,
        steps_failed,
        snapshot_id,
        combined_output,
    }))
}

/// Diff response between pre and post snapshots
#[derive(Debug, Serialize)]
pub struct SnapshotDiff {
    pub device_id: String,
    pub pre_snapshot_id: Option<String>,
    pub post_snapshot_id: Option<String>,
    pub pre_output: Option<String>,
    pub post_output: Option<String>,
    pub has_changes: bool,
    pub diff_summary: String,
}

/// Get diff between pre and post snapshots for a device
pub async fn get_device_snapshot_diff(
    State(state): State<Arc<AppState>>,
    Path((_exec_id, device_id)): Path<(String, String)>,
) -> Result<Json<SnapshotDiff>, ApiError> {
    let device = state.provider.get_mop_execution_device(&device_id).await?;

    let pre_output = if let Some(ref pre_id) = device.pre_snapshot_id {
        Some(state.provider.get_snapshot(pre_id).await?.output)
    } else {
        None
    };

    let post_output = if let Some(ref post_id) = device.post_snapshot_id {
        Some(state.provider.get_snapshot(post_id).await?.output)
    } else {
        None
    };

    // Simple diff check - compare outputs
    let has_changes = match (&pre_output, &post_output) {
        (Some(pre), Some(post)) => pre != post,
        _ => false,
    };

    // Generate a simple diff summary
    let diff_summary = match (&pre_output, &post_output) {
        (Some(pre), Some(post)) => {
            if pre == post {
                "No changes detected between pre and post checks.".to_string()
            } else {
                // Count line differences
                let pre_lines: Vec<_> = pre.lines().collect();
                let post_lines: Vec<_> = post.lines().collect();
                let added = post_lines.iter().filter(|l| !pre_lines.contains(l)).count();
                let removed = pre_lines.iter().filter(|l| !post_lines.contains(l)).count();
                format!("Changes detected: {} lines added, {} lines removed", added, removed)
            }
        }
        (None, Some(_)) => "Post-check captured, no pre-check snapshot available.".to_string(),
        (Some(_), None) => "Pre-check captured, no post-check snapshot yet.".to_string(),
        (None, None) => "No snapshots captured yet.".to_string(),
    };

    Ok(Json(SnapshotDiff {
        device_id,
        pre_snapshot_id: device.pre_snapshot_id,
        post_snapshot_id: device.post_snapshot_id,
        pre_output,
        post_output,
        has_changes,
        diff_summary,
    }))
}

/// AI analysis request for MOP execution
#[derive(Debug, Deserialize)]
pub struct MopAiAnalysisRequest {
    pub include_outputs: bool,
    pub include_diff: bool,
}

/// AI analysis response
#[derive(Debug, Serialize)]
pub struct MopAiAnalysisResponse {
    pub execution_id: String,
    pub analysis: String,
    pub recommendations: Vec<String>,
    pub risk_level: String,
}

/// Generate AI analysis for a MOP execution
pub async fn analyze_mop_execution(
    State(state): State<Arc<AppState>>,
    Path(exec_id): Path<String>,
    Json(req): Json<MopAiAnalysisRequest>,
) -> Result<Json<MopAiAnalysisResponse>, ApiError> {
    let execution = state.provider.get_mop_execution(&exec_id).await?;
    let devices = state.provider.list_mop_execution_devices(&exec_id).await?;

    let mut context = format!("MOP Execution: {}\nStatus: {:?}\nDevices: {}\n\n",
        execution.name,
        execution.status,
        devices.len()
    );

    // Gather device information
    for device in &devices {
        let session = if let Some(ref sid) = device.session_id {
            state.provider.get_session(sid).await.ok()
        } else { None };
        let session_name = session
            .map(|s| s.name)
            .unwrap_or_else(|| device.device_name.clone());

        context.push_str(&format!("Device: {} (Status: {:?})\n", session_name, device.status));

        if req.include_outputs {
            let steps = state.provider.list_mop_execution_steps(&device.id).await?;
            for step in steps {
                context.push_str(&format!("  Step: {} - {:?}\n", step.command, step.status));
                if let Some(ref out) = step.output {
                    let truncated = if out.len() > 500 { &out[..500] } else { out };
                    context.push_str(&format!("    Output: {}\n", truncated));
                }
            }
        }

        if req.include_diff {
            if let (Some(ref pre_id), Some(ref post_id)) = (&device.pre_snapshot_id, &device.post_snapshot_id) {
                if let (Ok(pre), Ok(post)) = (
                    state.provider.get_snapshot(pre_id).await,
                    state.provider.get_snapshot(post_id).await
                ) {
                    let pre_lines: Vec<_> = pre.output.lines().collect();
                    let post_lines: Vec<_> = post.output.lines().collect();
                    let changes: Vec<_> = post_lines.iter()
                        .filter(|l| !pre_lines.contains(l))
                        .take(10)
                        .collect();
                    if !changes.is_empty() {
                        context.push_str("  Changes:\n");
                        for line in changes {
                            context.push_str(&format!("    + {}\n", line));
                        }
                    }
                }
            }
        }
    }

    // Determine risk level based on status
    let risk_level = match execution.status {
        ExecutionStatus::Complete => "LOW",
        ExecutionStatus::Failed => "HIGH",
        ExecutionStatus::Aborted => "MEDIUM",
        _ => "UNKNOWN",
    }.to_string();

    // Generate basic recommendations
    let mut recommendations = Vec::new();
    for device in &devices {
        if device.status == DeviceExecutionStatus::Failed {
            let session = if let Some(ref sid) = device.session_id {
                state.provider.get_session(sid).await.ok()
            } else { None };
            let name = session
                .map(|s| s.name)
                .unwrap_or_else(|| device.device_name.clone());
            recommendations.push(format!("Review failed device: {}", name));
            if let Some(error_message) = &device.error_message {
                recommendations.push(format!("Check error on {}: {}", name, error_message));
            }
        }
    }

    if recommendations.is_empty() {
        recommendations.push("All devices completed successfully.".to_string());
    }

    // For now, generate a simple analysis (could integrate with AI provider later)
    let analysis = format!(
        "MOP execution '{}' completed with status {:?}. {} of {} devices succeeded. {}",
        execution.name,
        execution.status,
        devices.iter().filter(|d| d.status == DeviceExecutionStatus::Complete).count(),
        devices.len(),
        if risk_level == "HIGH" { "Manual review recommended." } else { "No critical issues detected." }
    );

    // Update execution with AI analysis
    let update = UpdateMopExecution {
        ai_analysis: Some(Some(analysis.clone())),
        ..Default::default()
    };
    state.provider.update_mop_execution(&exec_id, update).await?;

    Ok(Json(MopAiAnalysisResponse {
        execution_id: exec_id,
        analysis,
        recommendations,
        risk_level,
    }))
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
            error: "jump_host_id and jump_session_id are mutually exclusive — set at most one".into(),
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
            let api_err = ApiError { error: e, code: "VALIDATION".into() };
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
    let dest = build_snmp_dest(&state, req.host.as_str(), port, &req.jump, req.profile_id.as_deref()).await?;
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

    let dest = build_snmp_dest(&state, req.host.as_str(), port, &req.jump, req.profile_id.as_deref()).await?;
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

    tracing::info!("SNMP try-communities {}:{} profile: {}", req.host, port, req.profile_id);

    // Resolve SNMP communities with fallback: try requested profile first,
    // then scan all profiles for one with SNMP communities configured.
    let mut communities: Vec<String> = Vec::new();

    // Level 1: Try the requested profile
    if let Ok(Some(cred)) = state.provider.get_profile_credential(&req.profile_id).await {
        if let Some(ref comms) = cred.snmp_communities {
            if !comms.is_empty() {
                communities = comms.clone();
            }
        }
    }

    // Level 2: Scan all profiles for one with SNMP communities
    if communities.is_empty() {
        tracing::debug!("Profile {} has no SNMP communities, scanning all profiles", req.profile_id);
        if let Ok(all_profiles) = state.provider.list_profiles().await {
            for profile in &all_profiles {
                if profile.id == req.profile_id {
                    continue;
                }
                if let Ok(Some(cred)) = state.provider.get_profile_credential(&profile.id).await {
                    if let Some(ref comms) = cred.snmp_communities {
                        if !comms.is_empty() {
                            communities = comms.clone();
                            tracing::info!("Found SNMP communities in profile {} ({})", profile.name, profile.id);
                            break;
                        }
                    }
                }
            }
        }
    }

    if communities.is_empty() {
        let api_err = ApiError {
            error: "No SNMP communities found in any profile".to_string(),
            code: "VALIDATION".to_string(),
        };
        return Err((StatusCode::BAD_REQUEST, Json(api_err)).into_response());
    }

    let dest = build_snmp_dest(&state, req.host.as_str(), port, &req.jump, Some(&req.profile_id)).await?;
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
        req.host, port, req.interface_name
    );

    let dest = build_snmp_dest(&state, req.host.as_str(), port, &req.jump, req.profile_id.as_deref()).await?;
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
        req.host, port, req.profile_id, req.interface_name
    );

    // Resolve SNMP communities with fallback: try requested profile first,
    // then scan all profiles for one with SNMP communities configured.
    let mut communities: Vec<String> = Vec::new();

    // Level 1: Try the requested profile
    if let Ok(Some(cred)) = state.provider.get_profile_credential(&req.profile_id).await {
        if let Some(ref comms) = cred.snmp_communities {
            if !comms.is_empty() {
                communities = comms.clone();
                tracing::debug!("Using SNMP communities from requested profile {}", req.profile_id);
            }
        }
    }

    // Level 2: Scan all profiles for one with SNMP communities
    if communities.is_empty() {
        tracing::debug!("Profile {} has no SNMP communities, scanning all profiles", req.profile_id);
        if let Ok(all_profiles) = state.provider.list_profiles().await {
            for profile in &all_profiles {
                if profile.id == req.profile_id {
                    continue; // Already tried
                }
                if let Ok(Some(cred)) = state.provider.get_profile_credential(&profile.id).await {
                    if let Some(ref comms) = cred.snmp_communities {
                        if !comms.is_empty() {
                            communities = comms.clone();
                            tracing::info!("Found SNMP communities in profile {} ({})", profile.name, profile.id);
                            break;
                        }
                    }
                }
            }
        }
    }

    if communities.is_empty() {
        let api_err = ApiError {
            error: "No SNMP communities found in any profile".to_string(),
            code: "VALIDATION".to_string(),
        };
        return Err((StatusCode::BAD_REQUEST, Json(api_err)).into_response());
    }

    // Try each community with snmp_interface_stats, return first success
    tracing::info!(
        "Trying {} SNMP communit(ies) for {}:{} interface: {}",
        communities.len(), req.host, port, req.interface_name
    );
    let mut last_error: Option<crate::snmp::SnmpError> = None;
    let dest = build_snmp_dest(&state, req.host.as_str(), port, &req.jump, Some(&req.profile_id)).await?;
    for community in &communities {
        match crate::snmp::snmp_interface_stats(&dest, community, &req.interface_name).await {
            Ok(stats) => {
                tracing::info!("SNMP interface stats success for {}:{}", req.host, port);
                return Ok(Json(interface_stats_to_response(stats)));
            }
            Err(crate::snmp::SnmpError::Timeout(_)) => {
                tracing::warn!(
                    "SNMP community timed out for {}:{}, trying next",
                    req.host, port
                );
                last_error = Some(crate::snmp::SnmpError::Timeout(5));
                continue;
            }
            Err(crate::snmp::SnmpError::AuthError) => {
                tracing::warn!(
                    "SNMP community rejected by {}:{}, trying next",
                    req.host, port
                );
                last_error = Some(crate::snmp::SnmpError::AuthError);
                continue;
            }
            Err(e) => {
                tracing::error!(
                    "SNMP interface stats error for {}:{} interface {}: {}",
                    req.host, port, req.interface_name, e
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
        req.host, port, req.interface_name, err
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
    pub running_count: usize,
    pub max_concurrent: usize,
}

/// Create a new task
pub async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::tasks::CreateTaskRequest>,
) -> Result<Json<crate::tasks::AgentTask>, (StatusCode, String)> {
    let task = state
        .task_store
        .create_task(req)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Spawn for background execution
    if let Err(e) = state.task_executor.spawn_task(task.id.clone()).await {
        tracing::warn!("Failed to spawn task {}: {}", task.id, e);
        // Task is created but not running - client can retry
    }

    Ok(Json(task))
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

    let running_count = state.task_registry.running_count().await;
    let max_concurrent = state.task_registry.max_concurrent();

    Ok(Json(ListTasksResponse {
        tasks,
        running_count,
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
    state.task_store.delete_task(&id).await.map_err(|e| match e {
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
            state.provider.store_api_key("smtp_password", &password).await?;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Delete SMTP configuration
pub async fn delete_smtp_config(
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let pool = state.provider.get_pool();

    // Delete from database
    sqlx::query("DELETE FROM smtp_config WHERE id = 'default'")
        .execute(pool)
        .await
        .map_err(|e| ApiError {
            error: format!("Database error: {}", e),
            code: "DATABASE_ERROR".to_string(),
        })?;

    // Delete password from vault
    let _ = state.provider.delete_api_key("smtp_password").await;

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
            id, name, transport_type, command, args: args_json, enabled, url, auth_type, server_type,
        } = row;
        let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();
        let connected = state.mcp_client_manager.read().await.is_connected(&id).await;

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
            .map(|(tool_id, tool_name, description, tool_enabled, schema_str)| McpToolResponse {
                id: tool_id,
                name: tool_name,
                description,
                enabled: tool_enabled != 0,
                input_schema: serde_json::from_str(&schema_str).unwrap_or(serde_json::json!({})),
            })
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

    Ok((StatusCode::CREATED, Json(McpServerResponse {
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
    })))
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
        && state.provider.mcp_server_has_token(&id).await.unwrap_or(false)
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
type McpServerRow = (String, String, String, String, String, i32, Option<String>, String, String);

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

    let (server_id, name, transport_type, command, args_json, enabled, url, auth_type, server_type) = row.ok_or_else(|| ApiError {
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
    let mcp_tools = state.mcp_client_manager.read().await.connect(config).await
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
        let schema_json = serde_json::to_string(&tool.input_schema).unwrap_or_else(|_| "{}".to_string());

        sqlx::query(
            r#"INSERT INTO mcp_tools (id, server_id, name, description, input_schema, enabled)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(server_id, name) DO UPDATE SET
                 description = excluded.description,
                 input_schema = excluded.input_schema,
                 updated_at = datetime('now')"#
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

    // Return updated server response with tools
    let tools: Vec<McpToolResponse> = mcp_tools
        .into_iter()
        .map(|t| McpToolResponse {
            id: t.id,
            name: t.name,
            description: t.description,
            enabled: t.enabled,
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
    let (existing_id, name, transport_type, command, args_json, _enabled, url, auth_type, server_type) = row.ok_or_else(|| ApiError {
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
    let new_args: Vec<String> = req.args.unwrap_or_else(|| serde_json::from_str(&args_json).unwrap_or_default());
    let new_args_json = serde_json::to_string(&new_args).unwrap_or_else(|_| "[]".to_string());
    let new_url = req.url.or(url);
    let new_auth_type = req.auth_type.unwrap_or(auth_type);
    let new_server_type = req.server_type.unwrap_or(server_type);

    // Drop the live connection so the new config takes effect on next
    // connect; also flip enabled=0 so the row matches reality.
    let _ = state.mcp_client_manager.read().await.disconnect(&existing_id).await;

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
            let _ = state.provider.delete_mcp_auth_token(&existing_id).await;
        } else {
            state.provider.store_mcp_auth_token(&existing_id, token).await
                .map_err(|e| ApiError { error: format!("Failed to encrypt MCP auth token: {}", e), code: "VAULT_ERROR".to_string() })?;
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
        .map(|(tool_id, tool_name, description, tool_enabled, schema_str)| McpToolResponse {
            id: tool_id,
            name: tool_name,
            description,
            enabled: tool_enabled != 0,
            input_schema: serde_json::from_str(&schema_str).unwrap_or(serde_json::json!({})),
        })
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
    let (server_id, name, transport_type, command, args_json, enabled, url, auth_type, server_type) = row.ok_or_else(|| ApiError {
        error: "MCP server not found".to_string(),
        code: "NOT_FOUND".to_string(),
    })?;
    let args: Vec<String> = serde_json::from_str(&args_json).unwrap_or_default();

    if state.mcp_client_manager.read().await.is_connected(&server_id).await {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM mcp_tools WHERE server_id = ?")
            .bind(&server_id)
            .fetch_one(pool)
            .await
            .map_err(|e| ApiError { error: format!("Database error: {}", e), code: "DATABASE_ERROR".to_string() })?;
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
        Err(e) => return Err(ApiError { error: format!("Failed to load MCP auth token: {}", e), code: "VAULT_ERROR".to_string() }),
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
            message: format!("'{}' connected — discovered {} tool{}", name, tools.len(), if tools.len() == 1 { "" } else { "s" }),
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
    let _ = state.mcp_client_manager.read().await.disconnect(&path.0).await;
    connect_mcp_server(state, path).await
}

/// Disconnect from an MCP server
pub async fn disconnect_mcp_server(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let pool = state.provider.get_pool();

    // Disconnect
    state.mcp_client_manager.read().await.disconnect(&id).await
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

    let result: sqlx::sqlite::SqliteQueryResult = sqlx::query(
        "UPDATE mcp_tools SET enabled = ?, updated_at = datetime('now') WHERE id = ?"
    )
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
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT server_id, name FROM mcp_tools WHERE id = ? AND enabled = 1"
    )
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
    let result = state.mcp_client_manager.read().await
        .call_tool(&server_id, &tool_name, req.arguments).await
        .map_err(|e| ApiError {
            error: format!("MCP tool execution failed: {}", e),
            code: "TOOL_EXECUTION_FAILED".to_string(),
        })?;

    // Extract text content from the result
    let content = result.content.iter()
        .filter_map(|c| {
            match c.raw {
                rmcp::model::RawContent::Text(ref text) => Some(text.text.to_string()),
                _ => None,
            }
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
pub async fn cert_status(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    match &state.cert_manager {
        Some(cm) => Json(serde_json::to_value(cm.get_status().await).unwrap()),
        None => Json(serde_json::json!({ "valid": false, "error": "Certificate auth not initialized" })),
    }
}

/// GET /api/cert/public-key - Get the agent's public key for signing
pub async fn cert_public_key(
    State(state): State<Arc<AppState>>,
) -> Result<String, StatusCode> {
    let cm = state.cert_manager.as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    cm.get_public_key().await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// POST /api/cert/store - Store a signed certificate (called by frontend after login)
pub async fn cert_store(
    State(state): State<Arc<AppState>>,
    Json(cert_info): Json<crate::cert_manager::SignedCertInfo>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let cm = state.cert_manager.as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    cm.store_certificate(&cert_info).await
        .map_err(|e| {
            tracing::error!("Failed to store certificate: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(Json(serde_json::to_value(cm.get_status().await).unwrap()))
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
    let _cm = state.cert_manager.as_ref()
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
    tracing::info!(
        "Discovery batch request: {} targets",
        request.targets.len()
    );

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
    tracing::info!(
        "Traceroute resolve request: {} hops",
        request.hops.len()
    );

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

#[derive(Serialize)]
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
pub async fn mop_diff(
    Json(req): Json<MopDiffRequest>,
) -> Result<Json<StepDiff>, ApiError> {
    match req.format.as_str() {
        "json" => mop_diff_json(&req.a, &req.b),
        "text" => Ok(Json(mop_diff_text(&req.a, &req.b))),
        other => Err(ApiError {
            error: format!("Unknown diff format: '{}', expected 'json' or 'text'", other),
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
        changed: changes.iter().filter(|c| c.change_type == "changed").count(),
        added: changes.iter().filter(|c| c.change_type == "added").count(),
        removed: changes.iter().filter(|c| c.change_type == "removed").count(),
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
        changed: changes.iter().filter(|c| c.change_type == "changed").count(),
        added: changes.iter().filter(|c| c.change_type == "added").count(),
        removed: changes.iter().filter(|c| c.change_type == "removed").count(),
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

fn extract_diff_changes(
    table: &[Vec<usize>],
    a: &[&str],
    b: &[&str],
) -> Vec<DiffChange> {
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
        if idx + 1 < raw.len() && raw[idx].3 == "removed" && raw[idx + 1].3 == "added" {
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

    let memories: Vec<serde_json::Value> = rows.iter().map(|(id, content, category, source, created_at, updated_at)| {
        serde_json::json!({
            "id": id,
            "content": content,
            "category": category,
            "source": source,
            "created_at": created_at,
            "updated_at": updated_at,
        })
    }).collect();

    Ok(Json(serde_json::json!({ "memories": memories })))
}

/// POST /ai/memory — create a new memory
pub async fn create_ai_memory(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let content = body.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let category = body.get("category").and_then(|v| v.as_str()).unwrap_or("general").to_string();
    let source = body.get("source").and_then(|v| v.as_str()).unwrap_or("user").to_string();

    if content.is_empty() {
        return Err(ApiError { error: "Memory content cannot be empty".to_string(), code: "VALIDATION".to_string() });
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    sqlx::query("INSERT INTO ai_memory (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&content).bind(&category).bind(&source).bind(&now).bind(&now)
        .execute(&state.pool)
        .await
        .map_err(|e| ApiError { error: e.to_string(), code: "DATABASE_ERROR".to_string() })?;

    Ok(Json(serde_json::json!({ "id": id, "content": content, "category": category })))
}

/// PUT /ai/memory/:id — update a memory
pub async fn update_ai_memory(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, ApiError> {
    let content = body.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let category = body.get("category").and_then(|v| v.as_str()).unwrap_or("general");
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    sqlx::query("UPDATE ai_memory SET content = ?, category = ?, updated_at = ? WHERE id = ?")
        .bind(content).bind(category).bind(&now).bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| ApiError { error: e.to_string(), code: "DATABASE_ERROR".to_string() })?;

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
        .map_err(|e| ApiError { error: e.to_string(), code: "DATABASE_ERROR".to_string() })?;

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
    Json(state.task_executor.approval_service.pending_for_task(&task_id).await)
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
    if state.task_executor.approval_service.resolve(&interaction_id, response).await {
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
    if state.task_executor.approval_service
        .resolve(&approval_id, crate::tasks::approvals::HumanResponse::Approve)
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
    if state.task_executor.approval_service
        .resolve(&approval_id, crate::tasks::approvals::HumanResponse::Reject { reason: None })
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

    let mut result: Vec<TunnelWithState> = tunnels.into_iter().map(|t| {
        let runtime = state_map.remove(&t.id).unwrap_or(TunnelRuntimeState {
            id: t.id.clone(),
            status: TunnelStatus::Disconnected,
            uptime_secs: None,
            bytes_tx: 0,
            bytes_rx: 0,
            last_error: None,
            retry_count: 0,
        });
        TunnelWithState { tunnel: t, state: runtime }
    }).collect();

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
        result.push(TunnelWithState { tunnel: def, state: runtime });
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
    let _ = state.tunnel_manager.stop_tunnel(&id).await;
    let tunnel = crate::db::update_tunnel(&state.pool, &id, update).await?;
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
    state.tunnel_manager.start_tunnel(&tunnel).await
        .map_err(|e| ApiError { error: e, code: "TUNNEL_ERROR".to_string() })?;
    Ok(Json(serde_json::json!({"status": "started"})))
}

pub async fn stop_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.tunnel_manager.stop_tunnel(&id).await
        .map_err(|e| ApiError { error: e, code: "TUNNEL_ERROR".to_string() })?;
    Ok(Json(serde_json::json!({"status": "stopped"})))
}

pub async fn reconnect_tunnel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let _ = state.tunnel_manager.stop_tunnel(&id).await;
    let tunnel = crate::db::get_tunnel(&state.pool, &id).await?;
    state.tunnel_manager.start_tunnel(&tunnel).await
        .map_err(|e| ApiError { error: e, code: "TUNNEL_ERROR".to_string() })?;
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
    let content = tokio::fs::read_to_string(&safe).await.map_err(|e| ApiError {
        error: format!("Failed to read {}: {}", req.path, e),
        code: "FS_READ".to_string(),
    })?;
    Ok(Json(serde_json::json!({ "content": content, "path": req.path })))
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
    tokio::fs::write(&safe, &req.content).await.map_err(|e| ApiError {
        error: format!("Failed to write {}: {}", req.path, e),
        code: "FS_WRITE".to_string(),
    })?;
    Ok(Json(serde_json::json!({ "success": true, "path": req.path, "bytes": req.content.len() })))
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
    tokio::fs::write(&safe, &bytes).await.map_err(|e| ApiError {
        error: format!("Failed to write {}: {}", req.path, e),
        code: "FS_WRITE".to_string(),
    })?;
    Ok(Json(serde_json::json!({ "success": true, "path": req.path, "bytes": byte_count })))
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
        let modified = metadata.as_ref()
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
        if a_dir != b_dir { return if a_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }; }
        let a_name = a["name"].as_str().unwrap_or("");
        let b_name = b["name"].as_str().unwrap_or("");
        a_name.to_lowercase().cmp(&b_name.to_lowercase())
    });
    Ok(Json(serde_json::json!({ "entries": entries, "path": req.path, "truncated": truncated })))
}

#[derive(Deserialize)]
pub struct LocalFileMkdirRequest {
    pub path: String,
}

pub async fn local_file_mkdir(
    Json(req): Json<LocalFileMkdirRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let safe = validate_local_path(&req.path)?;
    tokio::fs::create_dir_all(&safe).await.map_err(|e| ApiError {
        error: format!("Failed to mkdir {}: {}", req.path, e),
        code: "FS_MKDIR".to_string(),
    })?;
    Ok(Json(serde_json::json!({ "success": true, "path": req.path })))
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
    }.map_err(|e| ApiError {
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
    tokio::fs::rename(&safe_from, &safe_to).await.map_err(|e| ApiError {
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
    let content = tokio::fs::read_to_string(&safe).await.map_err(|e| ApiError {
        error: format!("Failed to read {}: {}", req.path, e),
        code: "FS_READ".to_string(),
    })?;

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<SseEvent, Infallible>>(100);
    let main_args = req.main_args.clone();
    let path = req.path.clone();

    tokio::spawn(async move {
        let start = std::time::Instant::now();

        let _ = tx.send(Ok(SseEvent::default()
            .event("status")
            .data("Setting up Python runtime..."))).await;

        let uv = match crate::scripts::ensure_uv().await {
            Ok(uv) => uv,
            Err(e) => {
                let _ = tx.send(Ok(SseEvent::default()
                    .event("error")
                    .data(e.error))).await;
                return;
            }
        };

        let _ = tx.send(Ok(SseEvent::default()
            .event("status")
            .data(format!("Running {}...", path.split('/').next_back().unwrap_or(&path))))).await;

        let prepared = crate::scripts::prepare_script_for_run(&content, main_args.as_deref());

        let tmp_dir = std::env::temp_dir();
        let script_path = tmp_dir.join(format!("ns_ws_{}.py", uuid::Uuid::new_v4()));
        if let Err(e) = tokio::fs::write(&script_path, &prepared).await {
            let _ = tx.send(Ok(SseEvent::default()
                .event("error")
                .data(format!("Failed to write temp script: {}", e)))).await;
            return;
        }

        let mut cmd = tokio::process::Command::new(&uv);
        cmd.arg("run").arg("--quiet").arg("--script").arg(&script_path);
        cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());

        if let Some(args) = &main_args {
            cmd.env("NETSTACKS_ARGS", args);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = tokio::fs::remove_file(&script_path).await;
                let _ = tx.send(Ok(SseEvent::default()
                    .event("error")
                    .data(format!("Failed to start: {}", e)))).await;
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
                    let _ = tx_err.send(Ok(SseEvent::default()
                        .event("stderr")
                        .data(line))).await;
                }
            });
        }

        if let Some(stdout) = stdout {
            let tx_out = tx2.clone();
            tokio::spawn(async move {
                let reader = tokio::io::BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx_out.send(Ok(SseEvent::default()
                        .event("stdout")
                        .data(line))).await;
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

        let _ = tx.send(Ok(SseEvent::default()
            .event("complete")
            .data(serde_json::json!({
                "exit_code": exit_code,
                "duration_ms": duration_ms,
            }).to_string()))).await;
    });

    Ok(Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default()))
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
        assert_eq!(classify_device_type(Some("Catalyst 9300-48P"), Some("IOS-XE")), "switch");
        assert_eq!(classify_device_type(Some("Nexus 9000"), Some("NX-OS")), "switch");
        assert_eq!(classify_device_type(Some("DCS-7050"), Some("Arista EOS")), "switch");
    }

    #[test]
    fn classify_device_type_recognizes_routers() {
        assert_eq!(classify_device_type(Some("ASR1001"), Some("IOS-XE")), "router");
        assert_eq!(classify_device_type(Some("ISR4321"), Some("Cisco IOS")), "router");
        assert_eq!(classify_device_type(Some("MX240"), Some("Junos")), "router");
    }

    #[test]
    fn classify_device_type_recognizes_firewalls() {
        assert_eq!(classify_device_type(Some("ASA 5525"), Some("Cisco ASA")), "firewall");
        assert_eq!(classify_device_type(Some("FortiGate 100"), Some("FortiOS")), "firewall");
        assert_eq!(classify_device_type(Some("PA-3220"), Some("PAN-OS")), "firewall");
    }

    #[test]
    fn classify_device_type_unknown_when_unclear() {
        assert_eq!(classify_device_type(Some("Generic Box"), Some("Linux")), "unknown");
        assert_eq!(classify_device_type(None, None), "unknown");
    }

    #[test]
    fn infer_vendor_picks_known_brands() {
        assert_eq!(infer_vendor(Some("Catalyst"), None).as_deref(), Some("Cisco"));
        assert_eq!(infer_vendor(None, Some("Arista EOS")).as_deref(), Some("Arista"));
        assert_eq!(infer_vendor(None, Some("Junos 22")).as_deref(), Some("Juniper"));
        assert_eq!(infer_vendor(Some("FortiGate"), None).as_deref(), Some("Fortinet"));
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
    use crate::providers::local::LocalDataProvider;
    use crate::providers::DataProvider;
    use crate::db::init_db;
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

    fn lib_link(id: i64, local_id: i64, local_port: &str, remote_host: &str, remote_port: &str) -> LibreNmsLink {
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
        assert_eq!(by_name["core-sw-01"].primary_ip.as_deref(), Some("10.0.0.1"));
        assert_eq!(by_name["core-sw-01"].vendor.as_deref(), Some("Cisco"));
        assert_eq!(by_name["core-sw-01"].model.as_deref(), Some("Catalyst 9300"));
    }

    #[tokio::test]
    async fn librenms_import_dedupes_by_name_and_ip() {
        let provider = import_test_provider().await;
        let topo = provider.create_topology("dedup").await.unwrap();

        // Pre-seed: device with same hostname
        provider.add_discovered_device(&topo.id, crate::providers::NewDiscoveredDevice {
            name: "core-sw-01", host: "10.0.0.1", device_type: "switch",
            x: 200.0, y: 200.0, profile_id: None, snmp_profile_id: None,
        }).await.unwrap();

        let devs = vec![
            lib_dev(1, "core-sw-01", "10.0.0.99", "Catalyst", "IOS"),   // dup by name
            lib_dev(2, "new-sw-02", "10.0.0.1", "Catalyst", "IOS"),     // dup by IP
            lib_dev(3, "fresh-rtr", "10.0.0.5", "ASR1001", "IOS-XE"),  // new
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
            lib_link(1, 1, "Gi1/0/1", "edge-rtr-01", "Gi0/0/1"),       // resolves both
            lib_link(2, 1, "Gi1/0/2", "EDGE-RTR-01.LAB", "Gi0/0/2"),   // FQDN/case differ — resolves via short
            lib_link(3, 1, "Gi1/0/3", "unknown-host", "Gi0/0/1"),       // remote missing
            lib_link(4, 99, "X", "edge-rtr-01", "Y"),                   // local missing
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

    fn crawler_dev(ip: &str, name: Option<&str>, dns: Option<&str>, model: &str, os: &str, vendor: Option<&str>) -> NetStacksCrawlerDevice {
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
        provider.add_discovered_device(&topo.id, crate::providers::NewDiscoveredDevice {
            name: "preexisting", host: "192.168.1.10", device_type: "switch",
            x: 100.0, y: 100.0, profile_id: None, snmp_profile_id: None,
        }).await.unwrap();

        let devs = vec![
            crawler_dev("192.168.1.10", Some("ignored-dup-ip"), None, "Catalyst", "IOS", None), // dup by IP
            crawler_dev("192.168.1.20", Some("preexisting"), None, "ASA 5500", "ASA", None),     // dup by name
            crawler_dev("192.168.1.30", Some("core-sw-30"), Some("core-sw-30.lab"), "Catalyst 9300", "IOS-XE", Some("Cisco")),
            crawler_dev("192.168.1.40", Some("edge-rtr-40"), None, "ASR1001", "IOS-XE", None),
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
        m.enrich_sources.iter()
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
    } else { None };
    match crate::enrich::pipeline::run_one_source(
        &req.source, &req.token, state.clone(), session_ctx.as_ref(),
    ).await {
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
            let has_active_source = m
                .config
                .enrich
                .iter()
                .any(|s| crate::enrich::ActiveSources::source_available_from_cache(&sources_cache, s));
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

    let has_crawler = sources_cache.values().any(|s| s.name.starts_with("crawler_") && s.api_resource_id.is_some());
    let has_netbox = sources_cache.values().any(|s| s.name.starts_with("netbox_") && s.api_resource_id.is_some());

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
    let ttl = 300u64;  // default; per-user TTL deferred

    let sources_by_id: std::collections::HashMap<String, String> = db_sources.iter()
        .map(|s| (s.id.clone(), s.name.clone())).collect();
    let sources_by_name: std::collections::HashMap<String, crate::models::EnrichmentSource> =
        db_sources.into_iter().map(|s| (s.name.clone(), s)).collect();
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
    let m = state.provider.get_enrichment_matcher(&id).await?
        .ok_or_else(|| ApiError { error: format!("Matcher not found: {}", id), code: "NOT_FOUND".into() })?;
    Ok(Json(m))
}

pub async fn create_enrichment_matcher(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::models::CreateEnrichmentMatcherRequest>,
) -> Result<(StatusCode, Json<crate::models::EnrichmentMatcher>), ApiError> {
    // Validate patterns compile before saving
    for p in &req.patterns {
        regex::Regex::new(p).map_err(|e| ApiError {
            error: format!("invalid regex '{}': {}", p, e), code: "VALIDATION".into(),
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
        let existing = state.provider.get_enrichment_matcher(&id).await?
            .ok_or_else(|| ApiError { error: format!("Matcher not found: {}", id), code: "NOT_FOUND".into() })?;
        if existing.is_builtin && existing.name != *name {
            return Err(ApiError { error: "Built-in matcher name is immutable".into(), code: "VALIDATION".into() });
        }
    }
    if let Some(patterns) = &req.patterns {
        for p in patterns {
            regex::Regex::new(p).map_err(|e| ApiError {
                error: format!("invalid regex '{}': {}", p, e), code: "VALIDATION".into(),
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
    let existing = state.provider.get_enrichment_matcher(&id).await?
        .ok_or_else(|| ApiError { error: format!("Matcher not found: {}", id), code: "NOT_FOUND".into() })?;
    if existing.is_builtin {
        return Err(ApiError { error: "Built-in matchers can't be deleted".into(), code: "VALIDATION".into() });
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
    let out: Vec<MatcherTestMatch> = req.patterns.iter().map(|p| {
        match regex::Regex::new(p) {
            Ok(re) => MatcherTestMatch {
                pattern: p.clone(),
                matches: re.find_iter(&req.sample_text).map(|m| MatcherTestMatchRange {
                    start: m.start(),
                    end: m.end(),
                    text: m.as_str().to_string(),
                }).collect(),
                error: None,
            },
            Err(e) => MatcherTestMatch {
                pattern: p.clone(),
                matches: vec![],
                error: Some(e.to_string()),
            },
        }
    }).collect();
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
    state.provider.replace_matcher_sources(&matcher_id, &req.source_ids).await?;
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
    let s = state.provider.get_enrichment_source(&id).await?
        .ok_or_else(|| ApiError { error: format!("Source not found: {}", id), code: "NOT_FOUND".into() })?;
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
        let existing = state.provider.get_enrichment_source(&id).await?
            .ok_or_else(|| ApiError { error: format!("Source not found: {}", id), code: "NOT_FOUND".into() })?;
        if existing.is_builtin && existing.name != *name {
            return Err(ApiError { error: "Built-in source name is immutable".into(), code: "VALIDATION".into() });
        }
    }
    state.provider.update_enrichment_source(&id, &req).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_enrichment_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let existing = state.provider.get_enrichment_source(&id).await?
        .ok_or_else(|| ApiError { error: format!("Source not found: {}", id), code: "NOT_FOUND".into() })?;
    if existing.is_builtin {
        return Err(ApiError { error: "Built-in sources can't be deleted".into(), code: "VALIDATION".into() });
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
fn default_test_method() -> String { "GET".into() }

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
}

pub async fn test_enrichment_source(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TestEnrichmentSourceRequest>,
) -> Result<Json<EnrichmentSourceTestResult>, ApiError> {
    let started = std::time::Instant::now();
    let Some(api_id) = req.api_resource_id else {
        return Ok(Json(EnrichmentSourceTestResult {
            success: false, status_code: None, duration_ms: 0,
            url: req.path_template,
            raw_response: None, unwrapped: None, flattened_keys: vec![],
            error: Some("No API resource selected".into()),
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
    let path = req.path_template
        .replace("{token_url}", &urlencoding::encode(&req.sample_token))
        .replace("{token}", &req.sample_token)
        .replace("{session_host_ip}", &host_ip)
        .replace("{session_host}", &session_host)
        .replace("{sessions_host}", &session_host)
        .replace("{session_name}", &session_name);

    let client = crate::api_resource_client::ApiResourceClient::from_id(
        &state.provider, &api_id, Some(&state.auth_cache),
    ).await.map_err(|e| ApiError { error: format!("client: {}", e), code: "VALIDATION".into() })?;

    // Use the unified execute() path (handles substitution + multi-step auth).
    // status_code == 0 means the request never made it onto the wire.
    let exec = client.execute(
        &req.method.to_uppercase(),
        &path,
        &serde_json::json!({}),
        None,
        None,
        &std::collections::HashMap::new(),
    ).await;
    let result: Result<(u16, serde_json::Value), String> = if exec.status_code == 0 {
        Err(exec.error.unwrap_or_else(|| "request failed".into()))
    } else {
        Ok((exec.status_code, exec.raw_body.unwrap_or(serde_json::Value::Null)))
    };

    let elapsed = started.elapsed().as_millis() as u64;
    let full_url = path.to_string();  // path only (base_url is internal to client)
    match result {
        Ok((status, body)) => {
            // Substitute the same template vars in response_unwrap so JSONPath
            // expressions referencing session context work in the test endpoint
            // exactly like they do in the pipeline. Mirror the pipeline alias
            // set ({sessions_host}, {session_host_ip}).
            let unwrap_resolved = req.response_unwrap
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
            }))
        }
        Err(e) => Ok(Json(EnrichmentSourceTestResult {
            success: false, status_code: None, duration_ms: elapsed,
            url: full_url,
            raw_response: None, unwrapped: None, flattened_keys: vec![],
            error: Some(e),
        })),
    }
}

/// Normalize a JSON path: convert `[n]` bracket notation to dotted form
/// (`ips[0].name` → `ips.0.name`) and drop empty segments. Lets the UI accept
/// either notation interchangeably.
fn normalize_path(path: &str) -> String {
    path.replace('[', ".").replace(']', "")
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
    if path.is_empty() { return value.clone(); }
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
        if normalized.is_empty() { return value.clone(); }
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
fn default_export_priority() -> i32 { 10 }

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
fn default_source_kind_toml() -> String { "api_resource".into() }
fn default_source_method_toml() -> String { "GET".into() }

/// Export current matchers + sources + assignments to TOML for backup or
/// version control. Sources are referenced by NAME inside matcher entries
/// (rather than id) so the file is portable across installs.
pub async fn enrichment_export(
    State(state): State<Arc<AppState>>,
) -> Result<String, ApiError> {
    let matchers = state.provider.list_enrichment_matchers().await?;
    let sources = state.provider.list_enrichment_sources().await?;
    let api_resources = state.provider.list_api_resources().await.unwrap_or_default();
    let api_name_by_id: std::collections::HashMap<String, String> = api_resources.iter()
        .map(|r| (r.id.clone(), r.name.clone()))
        .collect();
    let source_name_by_id: std::collections::HashMap<String, String> = sources.iter()
        .map(|s| (s.id.clone(), s.name.clone()))
        .collect();

    let export = EnrichmentExportToml {
        matchers: matchers.into_iter().map(|m| MatcherToml {
            name: m.name,
            description: m.description,
            patterns: m.patterns,
            cli_flavors: m.cli_flavors,
            priority: m.priority,
            sources: m.source_ids.into_iter()
                .filter_map(|sid| source_name_by_id.get(&sid).cloned())
                .collect(),
        }).collect(),
        sources: sources.into_iter().map(|s| SourceToml {
            name: s.name,
            description: s.description,
            kind: s.kind,
            api_resource_name: s.api_resource_id.as_ref().and_then(|id| api_name_by_id.get(id).cloned()),
            api_resource_id: s.api_resource_id,
            method: s.method,
            path_template: s.path_template,
            response_unwrap: s.response_unwrap,
            picked_fields: s.picked_fields,
        }).collect(),
    };

    toml::to_string_pretty(&export)
        .map_err(|e| ApiError { error: format!("toml serialize: {}", e), code: "EXPORT_FAILED".into() })
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
    let parsed: EnrichmentExportToml = toml::from_str(&req.toml)
        .map_err(|e| ApiError { error: format!("invalid TOML: {}", e), code: "VALIDATION".into() })?;

    let existing_matchers = state.provider.list_enrichment_matchers().await?;
    let existing_sources = state.provider.list_enrichment_sources().await?;
    let api_resources = state.provider.list_api_resources().await.unwrap_or_default();
    let api_id_by_name: std::collections::HashMap<String, String> = api_resources.iter()
        .map(|r| (r.name.clone(), r.id.clone()))
        .collect();

    let mut result = EnrichmentImportResult {
        matchers_added: 0, matchers_updated: 0,
        sources_added: 0, sources_updated: 0, assignments_updated: 0,
    };

    // Sources first — matchers reference them by name
    for s in parsed.sources {
        let resolved_api_id = s.api_resource_id.clone()
            .or_else(|| s.api_resource_name.and_then(|n| api_id_by_name.get(&n).cloned()));
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
                state.provider.update_enrichment_source(&existing.id, &upd).await?;
                result.sources_updated += 1;
            }
        } else {
            let req_create = crate::models::CreateEnrichmentSourceRequest {
                name: s.name, description: s.description, kind: s.kind,
                api_resource_id: resolved_api_id, method: s.method,
                path_template: s.path_template, response_unwrap: s.response_unwrap,
                picked_fields: s.picked_fields,
            };
            state.provider.create_enrichment_source(&req_create).await?;
            result.sources_added += 1;
        }
    }

    // Re-read source name → id after possibly inserting new sources
    let all_sources = state.provider.list_enrichment_sources().await?;
    let source_id_by_name: std::collections::HashMap<String, String> = all_sources.iter()
        .map(|s| (s.name.clone(), s.id.clone()))
        .collect();

    for m in parsed.matchers {
        let matcher_id = if let Some(existing) = existing_matchers.iter().find(|x| x.name == m.name) {
            if req.overwrite {
                let upd = crate::models::UpdateEnrichmentMatcherRequest {
                    name: None,
                    description: Some(m.description),
                    patterns: Some(m.patterns),
                    cli_flavors: Some(m.cli_flavors),
                    priority: Some(m.priority),
                };
                state.provider.update_enrichment_matcher(&existing.id, &upd).await?;
                result.matchers_updated += 1;
            }
            existing.id.clone()
        } else {
            let req_create = crate::models::CreateEnrichmentMatcherRequest {
                name: m.name, description: m.description, patterns: m.patterns,
                cli_flavors: m.cli_flavors, priority: m.priority,
            };
            let created = state.provider.create_enrichment_matcher(&req_create).await?;
            result.matchers_added += 1;
            created.id
        };

        if !m.sources.is_empty() {
            let source_ids: Vec<String> = m.sources.into_iter()
                .filter_map(|name| source_id_by_name.get(&name).cloned())
                .collect();
            state.provider.replace_matcher_sources(&matcher_id, &source_ids).await?;
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
                let next = if prefix.is_empty() { k.clone() } else { format!("{}.{}", prefix, k) };
                match v {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        out.extend(flatten_json_keys(v, &next));
                    }
                    _ => out.push(next),
                }
            }
        }
        serde_json::Value::Array(a) => {
            for (i, v) in a.iter().enumerate().take(3) {  // cap at 3 to avoid mega-lists
                let next = if prefix.is_empty() { i.to_string() } else { format!("{}.{}", prefix, i) };
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
fn default_true_db() -> bool { true }

pub async fn db_export(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DbExportRequest>,
) -> Result<StatusCode, ApiError> {
    crate::db_backup::export_db(&state.pool, &req.path, req.include_vault)
        .await
        .map_err(|e| ApiError { error: e, code: "DATABASE_ERROR".to_string() })?;
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
        .map_err(|e| ApiError { error: e, code: "VALIDATION".to_string() })?;
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
    let dir = path.parent().map(|p| p.display().to_string()).unwrap_or_default();
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Json(DbInfoResponse { path: path.display().to_string(), dir, size_bytes })
}

pub async fn db_reset(
    State(state): State<Arc<AppState>>,
) -> Result<StatusCode, ApiError> {
    let db_path = crate::db::resolve_db_path();
    crate::db_backup::stage_reset(&state.pool, &db_path)
        .await
        .map_err(|e| ApiError { error: e, code: "DATABASE_ERROR".to_string() })?;
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
        .map_err(|e| ApiError { error: e, code: "DATABASE_ERROR".to_string() })?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn db_clear_path() -> Result<StatusCode, ApiError> {
    crate::db_backup::clear_db_path_config()
        .map_err(|e| ApiError { error: e, code: "CONFIG_ERROR".to_string() })?;
    Ok(StatusCode::NO_CONTENT)
}
