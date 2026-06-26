//! SSH session management using russh.

pub mod host_keys;
pub mod approvals;
pub mod jump;
pub mod exec_pool;
#[cfg(test)]
pub(crate) mod test_utils;

use futures::future::join_all;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{load_secret_key, Algorithm, EcdsaCurve, HashAlg};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::{cipher, kex, mac, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

// AUDIT FIX (REMOTE-002): the global "disable host key checking" toggle
// (`HOST_KEY_CHECKING_DISABLED` AtomicBool, `set_host_key_checking_disabled`,
// `is_host_key_checking_disabled`, the `PUT /settings/ssh.hostKeyChecking`
// route, and the boot-time DB reload) has been removed. It was a single
// switch that turned MITM defence off for the entire fleet across SSH,
// SFTP, MOPs, and tunnels — and any caller with the bearer token (the
// frontend, AI tasks, MCP servers) could flip it. Per-session opt-in
// (`auto_accept_changed_keys` on the connect call) is the only remaining
// way to bypass strict host-key checking, and it's no longer persistent.

use thiserror::Error;
use tokio::sync::{mpsc, Mutex, Semaphore};

/// SSH-related errors.
#[derive(Error, Debug)]
pub enum SshError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("Key error: {0}")]
    KeyError(String),

    #[error("Channel error: {0}")]
    ChannelError(String),

    #[error("Session closed")]
    _SessionClosed,
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::ConnectionFailed(e.to_string())
    }
}

/// SSH authentication method.
#[derive(Clone)]
pub enum SshAuth {
    /// Password authentication.
    Password(String),
    /// Key file authentication with optional passphrase.
    KeyFile { path: String, passphrase: Option<String> },
}

/// SSH connection configuration.
#[derive(Clone)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// Enable legacy/insecure SSH algorithms for older devices
    pub legacy_ssh: bool,
    /// Skip keyboard-interactive probe and go straight to password/key auth.
    /// Set true when connecting to Linux hosts — KBI is only needed for
    /// network devices (Arista, etc.) and the probe adds ~80ms per connection.
    pub skip_keyboard_interactive: bool,
}

// Manual Debug that redacts auth so passwords/passphrases never appear in
// log output or `{:?}` traces (the auto-derive would expose them).
impl std::fmt::Debug for SshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let auth_kind = match self.auth {
            SshAuth::Password(_) => "Password(<redacted>)",
            SshAuth::KeyFile { .. } => "KeyFile { path: <set>, passphrase: <redacted> }",
        };
        f.debug_struct("SshConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth", &format_args!("{}", auth_kind))
            .field("legacy_ssh", &self.legacy_ssh)
            .finish()
    }
}

use crate::models::{Session, CredentialProfile, ProfileCredential, AuthType};

/// Build an SshConfig from a session, its credential profile, and optional vault credential.
/// Returns Err with a descriptive message if required auth credentials are missing.
pub fn build_ssh_config_from_session(
    session: &Session,
    profile: &CredentialProfile,
    credential: Option<&ProfileCredential>,
) -> Result<SshConfig, String> {
    let auth = match profile.auth_type {
        AuthType::Password => {
            let password = credential
                .and_then(|c| c.password.clone());

            match password {
                Some(p) => SshAuth::Password(p),
                None => {
                    return Err(format!(
                        "No password found for session '{}' via profile '{}'. Please configure credentials in profile settings.",
                        session.name, profile.name
                    ));
                }
            }
        }
        AuthType::Key => {
            match &profile.key_path {
                Some(path) => {
                    let passphrase = credential
                        .and_then(|c| c.key_passphrase.clone());
                    SshAuth::KeyFile { path: path.clone(), passphrase }
                }
                None => {
                    return Err(format!(
                        "No SSH key path found for session '{}' via profile '{}'. Please configure key path in profile settings.",
                        session.name, profile.name
                    ));
                }
            }
        }
    };

    Ok(SshConfig {
        host: session.host.clone(),
        port: session.port,
        username: profile.username.clone(),
        auth,
        legacy_ssh: session.legacy_ssh,
        skip_keyboard_interactive: false,
    })
}

/// Client handler for russh.
pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    host_key_store: Arc<tokio::sync::Mutex<host_keys::HostKeyStore>>,
    /// When true, auto-accept changed host keys WITHOUT prompting. This
    /// remains the explicit per-call escape hatch (e.g. a future post-RMA
    /// MOP toggle) but is no longer the default for any code path.
    auto_accept_changed_keys: bool,
    /// AUDIT FIX (REMOTE-001): when present, unknown or changed host keys
    /// surface a UI prompt and the handshake blocks on the user's
    /// decision. When None (a small number of legacy callers), fall back
    /// to the previous silent-TOFU behaviour.
    approvals: Option<Arc<approvals::HostKeyApprovalService>>,
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Hold the lock only across `classify`, then drop before awaiting
        // the user prompt — the prompt can sit for up to 2 minutes and
        // we don't want to block other connections from reading the store.
        let classification = {
            let store = self.host_key_store.lock().await;
            store
                .classify(&self.host, self.port, server_public_key)
                .map_err(|e| SshError::KeyError(e.to_string()))?
        };

        use host_keys::HostKeyClassification as C;
        match classification {
            C::Matches => Ok(true),
            // Already-explicit opt-in (`auto_accept_changed_keys=true`) skips
            // the prompt. This is the post-RMA escape hatch and is never the
            // default.
            C::Unknown { presented_fingerprint } | C::Changed { presented_fingerprint, .. }
                if self.auto_accept_changed_keys =>
            {
                let mut store = self.host_key_store.lock().await;
                store
                    .trust_key(&self.host, self.port, server_public_key)
                    .map_err(|e| SshError::KeyError(e.to_string()))?;
                tracing::warn!(
                    target: "audit",
                    host = %self.host,
                    port = self.port,
                    fingerprint = %presented_fingerprint,
                    "host key trusted via auto_accept_changed_keys opt-in"
                );
                Ok(true)
            }
            // No approval service wired (legacy callers) — fall back to
            // silent TOFU. This branch should disappear once every call
            // site supplies a service.
            C::Unknown { presented_fingerprint } if self.approvals.is_none() => {
                let mut store = self.host_key_store.lock().await;
                store
                    .trust_key(&self.host, self.port, server_public_key)
                    .map_err(|e| SshError::KeyError(e.to_string()))?;
                tracing::warn!(
                    target: "audit",
                    host = %self.host,
                    port = self.port,
                    fingerprint = %presented_fingerprint,
                    "host key TOFU-accepted (no approval service supplied — legacy call site)"
                );
                Ok(true)
            }
            // No approval service AND a changed key — refuse outright.
            C::Changed { previous_fingerprint, presented_fingerprint } if self.approvals.is_none() => {
                tracing::error!(
                    target: "audit",
                    host = %self.host,
                    port = self.port,
                    previous = %previous_fingerprint,
                    presented = %presented_fingerprint,
                    "host key MISMATCH — refusing connection (no approval service to prompt user)"
                );
                Err(SshError::KeyError(format!(
                    "host key for {}:{} changed (was {}, now {}) — refusing connection",
                    self.host, self.port, previous_fingerprint, presented_fingerprint
                )))
            }
            // Approval service present — surface a prompt and block on the
            // user's decision.
            C::Unknown { presented_fingerprint } => {
                let svc = self.approvals.as_ref().expect("checked above");
                let approved = svc
                    .request_approval(
                        self.host.clone(),
                        self.port,
                        presented_fingerprint.clone(),
                        false,
                        None,
                    )
                    .await
                    .map_err(|e| SshError::KeyError(format!("host-key approval: {}", e)))?;
                if !approved {
                    return Err(SshError::KeyError(format!(
                        "user rejected host key for {}:{} (fingerprint {})",
                        self.host, self.port, presented_fingerprint
                    )));
                }
                let mut store = self.host_key_store.lock().await;
                store
                    .trust_key(&self.host, self.port, server_public_key)
                    .map_err(|e| SshError::KeyError(e.to_string()))?;
                Ok(true)
            }
            C::Changed { previous_fingerprint, presented_fingerprint } => {
                let svc = self.approvals.as_ref().expect("checked above");
                let approved = svc
                    .request_approval(
                        self.host.clone(),
                        self.port,
                        presented_fingerprint.clone(),
                        true,
                        Some(previous_fingerprint.clone()),
                    )
                    .await
                    .map_err(|e| SshError::KeyError(format!("host-key approval: {}", e)))?;
                if !approved {
                    return Err(SshError::KeyError(format!(
                        "user rejected changed host key for {}:{} (was {}, now {})",
                        self.host, self.port, previous_fingerprint, presented_fingerprint
                    )));
                }
                let mut store = self.host_key_store.lock().await;
                store
                    .trust_key(&self.host, self.port, server_public_key)
                    .map_err(|e| SshError::KeyError(e.to_string()))?;
                Ok(true)
            }
        }
    }
}

/// Try keyboard-interactive authentication with the given password.
/// Many network devices (Arista, some Cisco, etc.) require keyboard-interactive
/// instead of plain password authentication.
async fn try_keyboard_interactive(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    password: &str,
) -> Result<bool, SshError> {
    tracing::debug!("Starting keyboard-interactive auth for {}", username);

    // Start keyboard-interactive authentication
    let response = handle
        .authenticate_keyboard_interactive_start(username, None::<String>)
        .await
        .map_err(|e| {
            tracing::error!("keyboard-interactive start error: {}", e);
            SshError::AuthFailed(format!("keyboard-interactive start failed: {}", e))
        })?;

    // AUDIT FIX (DATA-010): demote `{:?}` of the server-supplied response
    // struct to debug — it can include attacker-supplied prompt text.
    tracing::debug!("Got keyboard-interactive response variant");

    // Handle the response - may need multiple rounds
    match response {
        KeyboardInteractiveAuthResponse::Success => {
            tracing::debug!("Keyboard-interactive auth succeeded immediately");
            Ok(true)
        }
        KeyboardInteractiveAuthResponse::Failure { .. } => {
            tracing::debug!("Keyboard-interactive auth rejected immediately");
            Ok(false)
        }
        KeyboardInteractiveAuthResponse::InfoRequest { name: _name, instructions: _instructions, prompts } => {
            tracing::debug!("Keyboard-interactive InfoRequest: {} prompts", prompts.len());

            // AUDIT FIX (REMOTE-017): only respond to NON-echo prompts with
            // the password. A malicious server could send an echo=true prompt
            // (e.g., "Username:") and capture the password as cleartext echo
            // on the wire. Sending an empty string for echo=true prompts
            // means the password is only ever sent in response to fields
            // marked as secret.
            let responses: Vec<String> = prompts
                .iter()
                .map(|p| if p.echo { String::new() } else { password.to_string() })
                .collect();
            tracing::info!("Sending {} responses", responses.len());

            let mut current_response = handle
                .authenticate_keyboard_interactive_respond(responses)
                .await
                .map_err(|e| {
                    tracing::error!("keyboard-interactive respond error: {}", e);
                    SshError::AuthFailed(format!("keyboard-interactive respond failed: {}", e))
                })?;

            // Handle multiple rounds of prompts (some servers send empty rounds)
            loop {
                tracing::debug!("Got keyboard-interactive follow-up response variant");

                match current_response {
                    KeyboardInteractiveAuthResponse::Success => {
                        tracing::info!("Keyboard-interactive auth succeeded");
                        return Ok(true);
                    }
                    KeyboardInteractiveAuthResponse::Failure { .. } => {
                        tracing::info!("Keyboard-interactive auth rejected");
                        return Ok(false);
                    }
                    KeyboardInteractiveAuthResponse::InfoRequest { prompts: ref new_prompts, .. } => {
                        if new_prompts.is_empty() {
                            // Empty prompt list - respond with empty list to confirm
                            tracing::info!("Empty prompt list, sending empty response to confirm");
                            current_response = handle
                                .authenticate_keyboard_interactive_respond(vec![])
                                .await
                                .map_err(|e| {
                                    tracing::error!("keyboard-interactive empty respond error: {}", e);
                                    SshError::AuthFailed(format!("keyboard-interactive respond failed: {}", e))
                                })?;
                        } else {
                            // More prompts - unexpected, give up
                            tracing::info!("Unexpected additional prompts, giving up");
                            return Ok(false);
                        }
                    }
                }
            }
        }
    }
}

/// An active SSH session.
///
/// Uses internal channels to avoid deadlocks between send and receive operations.
pub struct SshSession {
    /// Channel for sending data to the SSH session
    input_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Channel for resize requests
    resize_tx: mpsc::UnboundedSender<(u32, u32)>,
    /// Channel for receiving data from the SSH session
    output_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    /// Flag to track if session is closed
    _closed: Mutex<bool>,
}

impl SshSession {
    /// Connect to an SSH server and open a shell session.
    /// `cols` and `rows` set the initial PTY dimensions (defaults to 80x24 if 0).
    pub async fn connect(config: SshConfig, cols: u32, rows: u32) -> Result<Self, SshError> {
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };

        // Connect and authenticate using the shared helper
        let handle = connect_and_authenticate(&config, false).await?;

        // Open session channel
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Request PTY with xterm-256color terminal type and caller-specified size
        channel
            .request_pty(
                false,
                "xterm-256color",
                cols,    // columns
                rows,    // rows
                0,       // pixel width
                0,       // pixel height
                &[],
            )
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Request shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Create internal channels for non-blocking communication
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();
        let (output_tx, output_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        // Spawn a task to handle all channel I/O
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    // Handle incoming data from SSH
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                if output_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if output_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                break;
                            }
                            _ => {}
                        }
                    }
                    // Handle outgoing data to SSH
                    Some(data) = input_rx.recv() => {
                        use std::io::Cursor;
                        let mut cursor = Cursor::new(data);
                        if channel.data(&mut cursor).await.is_err() {
                            break;
                        }
                    }
                    // Handle resize requests
                    Some((cols, rows)) = resize_rx.recv() => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                }
            }
            // Clean up
            let _ = channel.eof().await;
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        });

        Ok(Self {
            input_tx,
            resize_tx,
            output_rx: Mutex::new(output_rx),
            _closed: Mutex::new(false),
        })
    }

    /// Connect to a target host through a jump host and open a shell session.
    /// Same PTY and I/O semantics as `connect()`, but the underlying TCP
    /// connection goes through russh's direct-tcpip channel.
    ///
    /// `cols` and `rows` set the initial PTY dimensions (defaults to 80x24 if 0).
    pub async fn connect_via_jump(
        target: SshConfig,
        jump: SshConfig,
        cols: u32,
        rows: u32,
    ) -> Result<Self, SshError> {
        let cols = if cols == 0 { 80 } else { cols };
        let rows = if rows == 0 { 24 } else { rows };

        // Use the jump module helper. Pass `None` for approvals — the
        // approvals service is not currently threaded through here; if
        // T9 needs it, plumb it as a parameter then.
        let handle = crate::ssh::jump::connect_via_jump(&target, &jump, None).await?;

        // Open session channel, request PTY, request shell — same as connect().
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Request PTY with xterm-256color terminal type and caller-specified size
        channel
            .request_pty(
                false,
                "xterm-256color",
                cols,    // columns
                rows,    // rows
                0,       // pixel width
                0,       // pixel height
                &[],
            )
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Request shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Create internal channels for non-blocking communication
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();
        let (output_tx, output_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        // Spawn a task to handle all channel I/O
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    // Handle incoming data from SSH
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                if output_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if output_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                break;
                            }
                            _ => {}
                        }
                    }
                    // Handle outgoing data to SSH
                    Some(data) = input_rx.recv() => {
                        use std::io::Cursor;
                        let mut cursor = Cursor::new(data);
                        if channel.data(&mut cursor).await.is_err() {
                            break;
                        }
                    }
                    // Handle resize requests
                    Some((cols, rows)) = resize_rx.recv() => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                }
            }
            // Clean up
            let _ = channel.eof().await;
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        });

        Ok(Self {
            input_tx,
            resize_tx,
            output_rx: Mutex::new(output_rx),
            _closed: Mutex::new(false),
        })
    }

    /// Send data to the remote shell.
    pub async fn send(&self, data: &[u8]) -> Result<(), SshError> {
        self.input_tx
            .send(data.to_vec())
            .map_err(|_| SshError::ChannelError("Channel closed".to_string()))
    }

    /// Resize the PTY.
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.resize_tx
            .send((cols, rows))
            .map_err(|_| SshError::ChannelError("Channel closed".to_string()))
    }

    /// Receive data from the remote shell.
    /// Returns None if the channel is closed or EOF is received.
    pub async fn recv(&self) -> Result<Option<Vec<u8>>, SshError> {
        let mut rx = self.output_rx.lock().await;
        match rx.recv().await {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }

    /// Close the SSH session.
    pub async fn _close(&self) -> Result<(), SshError> {
        let mut closed = self._closed.lock().await;
        *closed = true;
        // Dropping the senders will cause the I/O task to exit
        Ok(())
    }
}

// === Bulk Command Execution ===

/// Request to execute a command on multiple sessions
#[derive(Debug, Clone, Deserialize)]
pub struct BulkCommandRequest {
    pub session_ids: Vec<String>,
    pub command: String,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: Option<u64>,
}

fn default_timeout_secs() -> Option<u64> {
    Some(30)
}

/// Status of command execution on a single session
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandStatus {
    Success,
    Error,
    Timeout,
    AuthFailed,
}

/// Result of command execution on a single session
#[derive(Debug, Clone, Serialize)]
pub struct CommandResult {
    pub session_id: String,
    pub session_name: String,
    pub host: String,
    pub status: CommandStatus,
    pub output: String,
    pub error: Option<String>,
    pub execution_time_ms: u64,
    /// SSH exec channel exit code (Linux/Unix targets).
    /// Network CLIs via PTY/shell mode do not provide this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Response from bulk command execution
#[derive(Debug, Clone, Serialize)]
pub struct BulkCommandResponse {
    pub results: Vec<CommandResult>,
    pub total_time_ms: u64,
    pub success_count: u32,
    pub error_count: u32,
}

/// Maximum concurrent SSH connections for bulk operations
const MAX_CONCURRENT_CONNECTIONS: usize = 10;

/// Build russh client config with comprehensive algorithm support
/// Like SecureCRT, we include ALL algorithms by default - SSH negotiation picks the best one
fn build_ssh_config(_legacy_ssh: bool) -> client::Config {
    let mut cfg = client::Config::default();

    // Key exchange algorithms - comprehensive list matching SecureCRT
    // Includes modern + legacy algorithms; negotiation picks the strongest common one
    let kex_algorithms = vec![
        kex::CURVE25519,
        kex::CURVE25519_PRE_RFC_8731,
        kex::ECDH_SHA2_NISTP256,
        kex::ECDH_SHA2_NISTP384,
        kex::ECDH_SHA2_NISTP521,
        kex::DH_G16_SHA512,
        kex::DH_G14_SHA256,
        kex::DH_G14_SHA1,  // Legacy but widely supported
        kex::DH_G1_SHA1,   // Very old devices
    ];

    // Host key algorithms - prioritize Ed25519/ECDSA (most reliable), then RSA-SHA256
    // RSA-SHA512 has known signature verification issues in russh
    let key_algorithms = vec![
        Algorithm::Ed25519,
        Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
        Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
        Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
        Algorithm::Rsa { hash: Some(HashAlg::Sha256) }, // rsa-sha2-256 (preferred RSA)
        Algorithm::Rsa { hash: Some(HashAlg::Sha512) }, // rsa-sha2-512 (has issues)
        Algorithm::Rsa { hash: None }, // ssh-rsa (SHA-1, legacy)
        Algorithm::Dsa, // ssh-dss (legacy)
    ];

    // Ciphers - all supported ciphers (modern preferred, legacy included)
    let cipher_algorithms = vec![
        cipher::CHACHA20_POLY1305,
        cipher::AES_256_GCM,
        cipher::AES_256_CTR,
        cipher::AES_192_CTR,
        cipher::AES_128_CTR,
        cipher::AES_256_CBC,
        cipher::AES_192_CBC,
        cipher::AES_128_CBC,
    ];

    // MACs - all supported (modern preferred, legacy included)
    let mac_algorithms = vec![
        mac::HMAC_SHA512_ETM,
        mac::HMAC_SHA256_ETM,
        mac::HMAC_SHA512,
        mac::HMAC_SHA256,
        mac::HMAC_SHA1_ETM,
        mac::HMAC_SHA1,
    ];

    cfg.preferred = russh::Preferred {
        kex: Cow::Owned(kex_algorithms),
        key: Cow::Owned(key_algorithms),
        cipher: Cow::Owned(cipher_algorithms),
        mac: Cow::Owned(mac_algorithms),
        ..Default::default()
    };

    cfg
}

/// Connect to an SSH server and authenticate using the provided config.
/// Returns the authenticated Handle ready for channel operations.
/// `auto_accept_changed_keys` controls whether changed host keys are auto-accepted (true for MOP execution).
///
/// Backwards-compatible wrapper that omits the host-key approval service.
/// Unknown hosts will be silently TOFU-accepted (legacy behaviour). Prefer
/// `connect_and_authenticate_with_approvals` for any new call site.
pub async fn connect_and_authenticate(
    config: &SshConfig,
    auto_accept_changed_keys: bool,
) -> Result<client::Handle<ClientHandler>, SshError> {
    connect_and_authenticate_with_approvals(config, auto_accept_changed_keys, None).await
}

/// Connect to an SSH server with optional host-key prompt support.
///
/// AUDIT FIX (REMOTE-001): when `approvals` is `Some`, unknown or changed
/// host keys block the SSH handshake on a UI prompt. The frontend polls
/// `GET /api/host-keys/prompts` and resolves via
/// `POST /api/host-keys/prompts/:id/{approve,reject}`. Without approvals,
/// behaviour falls back to silent TOFU.
pub async fn connect_and_authenticate_with_approvals(
    config: &SshConfig,
    auto_accept_changed_keys: bool,
    approvals: Option<Arc<approvals::HostKeyApprovalService>>,
) -> Result<client::Handle<ClientHandler>, SshError> {
    let russh_config = Arc::new(build_ssh_config(config.legacy_ssh));
    let addr = format!("{}:{}", config.host, config.port);

    // Load host key store for verification
    let host_key_store = host_keys::load_default_store();

    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
        host_key_store,
        auto_accept_changed_keys,
        approvals,
    };

    // AUDIT FIX (REMOTE-001): the russh handshake includes `check_server_key`,
    // which can now block for up to `approvals::PROMPT_TIMEOUT` waiting for
    // the user. Extend the outer timeout when approvals are wired so the
    // prompt has a chance to complete.
    let connect_timeout = if handler.approvals.is_some() {
        std::time::Duration::from_secs(15) + approvals::PROMPT_TIMEOUT
    } else {
        std::time::Duration::from_secs(15)
    };
    let connect_timeout_secs = connect_timeout.as_secs();
    let mut handle = tokio::time::timeout(
        connect_timeout,
        client::connect(russh_config, &addr, handler),
    )
        .await
        .map_err(|_| SshError::ConnectionFailed(format!(
            "{}:{} - connection timed out after {}s",
            config.host, config.port, connect_timeout_secs,
        )))?
        .map_err(|e| SshError::ConnectionFailed(format!(
            "{}:{} - {}",
            config.host, config.port, e
        )))?;

    // Authenticate using the shared helper (preserves keyboard-interactive
    // → password fallback and RSA SHA-512 → SHA-256 fallback).
    if !authenticate_handle(&mut handle, config).await? {
        return Err(SshError::AuthFailed(
            "authentication failed - check credentials in profile".to_string()
        ));
    }

    Ok(handle)
}

/// Authenticate an already-connected handle using the configured auth method.
///
/// Implements the full fallback chain shared by both TCP-direct and stream-based
/// connect paths:
/// - Password auth: keyboard-interactive first (many network devices require this),
///   then plain password auth as fallback.
/// - Key auth: for RSA keys, try SHA-512 first then SHA-256 (server may not
///   accept ssh-rsa SHA-1). Other key types use the default hash algorithm.
/// - Certificate auth: Ed25519 cert + private key.
///
/// Returns:
/// - `Ok(true)` — server accepted credentials.
/// - `Ok(false)` — server cleanly rejected (audit-logged here, caller decides
///   whether to surface a generic vs. specific error).
/// - `Err(...)` — protocol/IO/key-load error before a clean accept/reject.
async fn authenticate_handle(
    handle: &mut client::Handle<ClientHandler>,
    config: &SshConfig,
) -> Result<bool, SshError> {
    let auth_method_desc = match &config.auth {
        SshAuth::Password(_) => "password".to_string(),
        SshAuth::KeyFile { path, .. } => format!("key ({})", path),
    };

    let authenticated = match &config.auth {
        SshAuth::Password(password) => {
            if config.skip_keyboard_interactive {
                // Linux hosts / deploy execs: go straight to password auth.
                let result = handle
                    .authenticate_password(&config.username, password)
                    .await
                    .map_err(|_e| SshError::AuthFailed("authentication failed".to_string()))?;
                matches!(result, russh::client::AuthResult::Success)
            } else {
                // Network devices (Arista, Cisco, etc.) often require keyboard-interactive.
                // Probe it first, fall back to plain password if rejected.
                tracing::debug!("Trying keyboard-interactive auth first for {}@{}", config.username, config.host);
                let ki_result = try_keyboard_interactive(handle, &config.username, password).await;

                match ki_result {
                    Ok(true) => {
                        tracing::info!("Keyboard-interactive auth succeeded for {}@{}", config.username, config.host);
                        true
                    }
                    Ok(false) | Err(_) => {
                        tracing::debug!("Keyboard-interactive rejected, falling back to password auth for {}@{}", config.username, config.host);
                        let result = handle
                            .authenticate_password(&config.username, password)
                            .await
                            .map_err(|_e| SshError::AuthFailed("authentication failed".to_string()))?;
                        matches!(result, russh::client::AuthResult::Success)
                    }
                }
            }
        }
        SshAuth::KeyFile { path, passphrase } => {
            let key_path = Path::new(path);
            tracing::info!("Loading SSH key from: {}", path);
            let key_pair = load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| SshError::KeyError(format!(
                    "failed to load key '{}': {}",
                    path, e
                )))?;
            tracing::info!("Key loaded successfully, algorithm: {:?}", key_pair.algorithm());

            // For RSA keys, try multiple signature algorithms
            // Modern servers disable ssh-rsa (SHA-1) and require rsa-sha2-256 or rsa-sha2-512
            if matches!(key_pair.algorithm(), Algorithm::Rsa { .. }) {
                // First try with SHA-512 (rsa-sha2-512)
                tracing::info!("Attempting RSA publickey auth (SHA-512) for {}@{}", config.username, config.host);
                let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key_pair.clone()), Some(HashAlg::Sha512));
                let auth_result = handle
                    .authenticate_publickey(&config.username, key_with_hash)
                    .await;
                tracing::info!("RSA publickey auth (SHA-512) result: {:?}", auth_result);

                match auth_result {
                    Ok(russh::client::AuthResult::Success) => true,
                    _ => {
                        // Try SHA-256 (rsa-sha2-256) as fallback
                        tracing::info!("RSA-SHA512 failed, trying RSA-SHA256 for {}@{}", config.username, config.host);
                        let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key_pair), Some(HashAlg::Sha256));
                        let auth_result = handle
                            .authenticate_publickey(&config.username, key_with_hash)
                            .await;
                        tracing::info!("RSA-SHA256 auth result: {:?}", auth_result);
                        matches!(auth_result, Ok(russh::client::AuthResult::Success))
                    }
                }
            } else {
                // For non-RSA keys, use None for hash_alg
                tracing::info!("Attempting publickey auth for {}@{}", config.username, config.host);
                let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key_pair), None);
                let auth_result = handle
                    .authenticate_publickey(&config.username, key_with_hash)
                    .await;
                tracing::info!("Publickey auth result: {:?}", auth_result);
                matches!(auth_result, Ok(russh::client::AuthResult::Success))
            }
        }
    };

    if !authenticated {
        // AUDIT FIX (REMOTE-008): generic auth-failure message — don't echo
        // username/host distinguishably (username-enumeration aid). The
        // operator-side detail (which method, which user) stays in the
        // tracing logs which they already have access to.
        tracing::info!(
            target: "audit",
            method = %auth_method_desc,
            username = %config.username,
            host = %config.host,
            "ssh authentication rejected by server"
        );
    }

    Ok(authenticated)
}

/// Connect to an SSH server over a pre-established stream and authenticate.
///
/// Used by ProxyJump where the stream is a russh channel from the jump host.
/// This variant skips TCP connection and runs the SSH handshake directly over
/// the provided stream. Auth logic is shared with `connect_and_authenticate_with_approvals`
/// via the `authenticate_handle` helper.
pub async fn connect_and_authenticate_over_stream<S>(
    config: &SshConfig,
    stream: S,
    approvals: Option<Arc<approvals::HostKeyApprovalService>>,
) -> Result<client::Handle<ClientHandler>, SshError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let russh_config = Arc::new(build_ssh_config(config.legacy_ssh));

    // Load host key store for verification
    let host_key_store = host_keys::load_default_store();

    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
        host_key_store,
        auto_accept_changed_keys: false,
        approvals,
    };

    // Connect over the stream (no TCP dial, no timeout needed for the connect itself)
    let mut handle = client::connect_stream(russh_config, stream, handler)
        .await
        .map_err(|e| SshError::ConnectionFailed(format!(
            "{}:{} - stream handshake failed: {}",
            config.host, config.port, e
        )))?;

    // Authenticate using the shared helper.
    if !authenticate_handle(&mut handle, config).await? {
        return Err(SshError::AuthFailed(
            "authentication failed - check credentials in profile".to_string()
        ));
    }

    Ok(handle)
}

/// Result of `exec_on_remote` — the slim, programmatic counterpart to
/// `CommandResult` (which is shaped for the command-runner UI).
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Exit status reported by the remote shell. `None` means no
    /// `ExitStatus` arrived; check `termination` for why.
    pub exit_status: Option<u32>,
    /// Why the channel ended. Lets callers distinguish "rejected by sshd"
    /// from "killed by signal" from "closed silently" — all of which look
    /// the same in `exit_status` (None) but mean very different things.
    pub termination: ExecTermination,
}

/// How a remote exec ended, for cases where there's no clean exit status.
#[derive(Debug, Clone)]
pub enum ExecTermination {
    /// Remote sent SSH_MSG_CHANNEL_REQUEST_SUCCESS for the exec and then a
    /// normal `ExitStatus` (which the caller reads from `exit_status`).
    Normal,
    /// Remote sent `Failure` for the exec request — the command was never
    /// run. Common causes: ForceCommand, restricted shell, no-shell user.
    ExecRequestRejected,
    /// Remote sent `ExitSignal` instead of `ExitStatus` — the process was
    /// killed by a signal. The string is `"<signal>: <error_message>"`.
    KilledBySignal(String),
    /// Channel closed without `ExitStatus`, `ExitSignal`, or `Failure`.
    /// Sometimes seen with abruptly-disconnected sessions or sshd bugs.
    ClosedSilently,
}

/// Open one fresh exec channel on an already-authenticated handle, run
/// `command`, drain stdout/stderr, and report exit status + termination
/// reason. Used by the pooled `exec_pool::exec_on_remote_pooled` (the
/// only production caller) so the channel-handling loop has exactly one
/// source of truth. For interactive UI command-running see
/// `execute_command_on_session_with_approvals` instead.
pub(crate) async fn exec_on_handle(
    handle: &client::Handle<ClientHandler>,
    command: &str,
) -> Result<ExecResult, SshError> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::ChannelError(e.to_string()))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| SshError::ChannelError(e.to_string()))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status: Option<u32> = None;
    let mut termination = ExecTermination::ClosedSilently;

    // Per RFC 4254 §6.10, `exit-status` is independent of `eof`/`close` and
    // can arrive in any order. OpenSSH server commonly sends `eof` BEFORE
    // `exit-status`, so we MUST NOT break on `eof` — we'd miss the status
    // and surface a spurious "closed without an exit status" error. Break
    // only on `close` or when the channel is fully drained (`None`). The
    // outer caller's timeout protects against a server that never closes.
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, ext }) => {
                if ext == 1 {
                    stderr.extend_from_slice(&data);
                } else {
                    stdout.extend_from_slice(&data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status: s }) => {
                exit_status = Some(s);
                termination = ExecTermination::Normal;
            }
            Some(ChannelMsg::ExitSignal { signal_name, error_message, .. }) => {
                let detail = if error_message.is_empty() {
                    format!("{:?}", signal_name)
                } else {
                    format!("{:?}: {}", signal_name, error_message)
                };
                termination = ExecTermination::KilledBySignal(detail);
            }
            Some(ChannelMsg::Failure) => {
                termination = ExecTermination::ExecRequestRejected;
            }
            Some(ChannelMsg::Eof) => { /* no more data, but exit-status / close may still arrive */ }
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }

    Ok(ExecResult { stdout, stderr, exit_status, termination })
}

/// Execute a command on a single session with timeout.
///
/// Backwards-compatible wrapper without host-key approval. New callers
/// should prefer `execute_command_on_session_with_approvals` so unknown
/// host keys surface a UI prompt instead of silent TOFU.
pub async fn execute_command_on_session(
    config: SshConfig,
    session_id: String,
    session_name: String,
    command: String,
    timeout: Duration,
) -> CommandResult {
    execute_command_on_session_with_approvals(config, session_id, session_name, command, timeout, None).await
}

/// Execute a command on a single session with optional host-key prompt
/// support (AUDIT FIX REMOTE-001).
pub async fn execute_command_on_session_with_approvals(
    config: SshConfig,
    session_id: String,
    session_name: String,
    command: String,
    timeout: Duration,
    approvals: Option<Arc<approvals::HostKeyApprovalService>>,
) -> CommandResult {
    let start = Instant::now();
    let host = config.host.clone();

    // Connect to SSH server without PTY (exec channel instead)
    let connect_result = tokio::time::timeout(timeout, async {
        let handle = connect_and_authenticate_with_approvals(&config, false, approvals.clone()).await?;

        // Open session channel for exec (not shell)
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Execute command via exec (not shell)
        channel
            .exec(false, command.as_bytes())
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Collect output and exit status
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status: Option<u32> = None;

        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    if ext == 1 {
                        stderr.extend_from_slice(&data);
                    } else {
                        stdout.extend_from_slice(&data);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status: code }) => {
                    exit_status = Some(code);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    break;
                }
                _ => {}
            }
        }

        // Close connection
        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;

        Ok((stdout, stderr, exit_status))
    })
    .await;

    let execution_time_ms = start.elapsed().as_millis() as u64;

    match connect_result {
        Ok(Ok((stdout, stderr, exit_status))) => {
            let output = String::from_utf8_lossy(&stdout).to_string();
            let stderr_str = String::from_utf8_lossy(&stderr).to_string();
            let exit_code = exit_status.map(|s| s as i32);
            let status = match exit_code {
                Some(0) | None => CommandStatus::Success,
                Some(_) => CommandStatus::Error,
            };

            CommandResult {
                session_id,
                session_name,
                host,
                status,
                output,
                error: if stderr_str.is_empty() {
                    None
                } else {
                    Some(stderr_str)
                },
                execution_time_ms,
                exit_code,
            }
        }
        Ok(Err(e)) => {
            let status = if matches!(e, SshError::AuthFailed(_)) {
                CommandStatus::AuthFailed
            } else {
                CommandStatus::Error
            };

            CommandResult {
                session_id,
                session_name,
                host,
                status,
                output: String::new(),
                error: Some(e.to_string()),
                execution_time_ms,
                exit_code: None,
            }
        }
        Err(_) => {
            CommandResult {
                session_id,
                session_name,
                host,
                status: CommandStatus::Timeout,
                output: String::new(),
                error: Some(format!("Command timed out after {}s", timeout.as_secs())),
                execution_time_ms,
                exit_code: None,
            }
        }
    }
}

/// Result of a single command executed via an interactive shell channel.
#[derive(Debug, Clone, Serialize)]
pub struct ShellCommandResult {
    pub step_id: String,
    pub status: CommandStatus,
    pub output: String,
    pub error: Option<String>,
    pub execution_time_ms: u64,
    /// Full CLI session transcript up to and including this command
    pub transcript: String,
}

/// Results from a shell execution session.
pub struct ShellExecutionResults {
    pub commands: Vec<ShellCommandResult>,
    /// The complete session transcript including auto_commands and all steps
    pub full_transcript: String,
}

/// Strip ANSI escape sequences from PTY output.
fn strip_ansi(input: &str) -> String {
    match strip_ansi_escapes::strip_str(input) {
        s if s.is_empty() => input.to_string(),
        s => s.to_string(),
    }
}

/// Strip the echoed command from the beginning of PTY output.
/// PTY shells echo the typed command back; remove that first line if it matches.
fn _strip_echo(output: &str, command: &str) -> String {
    let cmd_trimmed = command.trim();
    let mut lines = output.lines();
    if let Some(first_line) = lines.next() {
        if first_line.trim() == cmd_trimmed || first_line.trim().ends_with(cmd_trimmed) {
            return lines.collect::<Vec<_>>().join("\n");
        }
    }
    output.to_string()
}

/// Wait for a shell prompt by accumulating output until a prompt character is seen.
/// Uses a "settle" approach: after detecting a potential prompt ending, waits briefly
/// for more data. If no more data arrives, it's a real prompt. This prevents false
/// triggers on output lines like "Hardware version:" or "Serial number:".
async fn wait_for_prompt(
    channel: &mut russh::Channel<client::Msg>,
    timeout: Duration,
) -> Result<String, SshError> {
    let mut buffer = Vec::new();
    let settle_duration = Duration::from_millis(200);
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let partial = String::from_utf8_lossy(&buffer).to_string();
            return Err(SshError::ChannelError(format!(
                "Timed out waiting for prompt. Partial output: {}",
                if partial.len() > 200 { &partial[partial.len()-200..] } else { &partial }
            )));
        }

        match tokio::time::timeout(remaining, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => {
                buffer.extend_from_slice(&data);
            }
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                buffer.extend_from_slice(&data);
            }
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => {
                // Channel closed - return what we have if anything
                if !buffer.is_empty() {
                    return Ok(String::from_utf8_lossy(&buffer).to_string());
                }
                return Err(SshError::ChannelError("Channel closed while waiting for prompt".to_string()));
            }
            Ok(_) => continue,
            Err(_) => {
                let partial = String::from_utf8_lossy(&buffer).to_string();
                return Err(SshError::ChannelError(format!(
                    "Timed out waiting for prompt. Partial output: {}",
                    if partial.len() > 200 { &partial[partial.len()-200..] } else { &partial }
                )));
            }
        }

        // Check if buffer ends with a prompt character
        // Strip ANSI escape sequences first — PTY prompts often include color/cursor codes
        // like "P3-AMS#\x1b[0m\x1b[K" which would hide the actual prompt character
        let text = String::from_utf8_lossy(&buffer);
        let clean_text = strip_ansi(&text);
        let trimmed = clean_text.trim_end();
        let looks_like_prompt = trimmed.ends_with('>')
            || trimmed.ends_with('#')
            || trimmed.ends_with('$')
            || trimmed.ends_with('%')
            || trimmed.ends_with(':');

        if looks_like_prompt {
            // Settle: wait briefly for more data. If nothing arrives, it's a real prompt.
            // This prevents false triggers on output lines like "Hardware version:"
            let settle_deadline = tokio::time::Instant::now() + settle_duration;
            loop {
                let settle_remaining = settle_deadline.saturating_duration_since(tokio::time::Instant::now());
                if settle_remaining.is_zero() {
                    // Settle timeout expired — no more data, this is a real prompt
                    return Ok(text.to_string());
                }
                match tokio::time::timeout(settle_remaining, channel.wait()).await {
                    Ok(Some(ChannelMsg::Data { data })) => {
                        // More data arrived — not a real prompt, break to outer loop
                        buffer.extend_from_slice(&data);
                        break;
                    }
                    Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                        buffer.extend_from_slice(&data);
                        break;
                    }
                    Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => {
                        // Channel closed after prompt — return what we have
                        return Ok(text.to_string());
                    }
                    Ok(_) => {
                        // Non-data message (WindowAdjust, etc) — keep waiting in settle loop
                        continue;
                    }
                    Err(_) => {
                        // Settle timeout expired — no more data, this is a real prompt
                        return Ok(text.to_string());
                    }
                }
            }
        }
    }
}

/// Execute multiple commands via an interactive shell channel (PTY).
///
/// Opens a single SSH connection with a PTY shell, sends auto_commands first
/// (to enter privileged mode, etc.), then executes each MOP command in sequence,
/// capturing per-command output. State is maintained across all commands.
/// AUDIT FIX (REMOTE-003): MOP execution previously hard-coded
/// auto-accept of changed host keys, which is the worst possible default
/// for the highest-stakes path (config push, write memory). A network
/// attacker who could MITM at the moment of MOP execution could
/// impersonate the device and capture admin credentials. The caller now
/// passes `auto_accept_changed_keys=false` by default and only opts in
/// when they truly expect a key change (post-RMA, for example).
pub async fn execute_commands_via_shell(
    config: SshConfig,
    _session_id: String,
    session_name: String,
    auto_commands: Vec<String>,
    commands: Vec<(String, String)>, // (step_id, command)
    post_commands: Vec<String>,      // commands to run after all steps (e.g. exit, write memory)
    timeout_per_command: Duration,
    auto_accept_changed_keys: bool,
) -> ShellExecutionResults {
    let prompt_timeout = Duration::from_secs(15);

    // If connection/auth fails, return error for all commands
    let make_error_results = |commands: &[(String, String)], error: &str, time_ms: u64| -> ShellExecutionResults {
        ShellExecutionResults {
            commands: commands.iter().map(|(step_id, _)| ShellCommandResult {
                step_id: step_id.clone(),
                status: CommandStatus::Error,
                output: String::new(),
                error: Some(error.to_string()),
                execution_time_ms: time_ms,
                transcript: String::new(),
            }).collect(),
            full_transcript: format!("Error: {}", error),
        }
    };

    let overall_start = Instant::now();

    // Connect and authenticate. AUDIT FIX (REMOTE-003): the caller now
    // chooses whether to auto-accept changed keys; the default is false.
    let handle = match connect_and_authenticate(&config, auto_accept_changed_keys).await {
        Ok(h) => h,
        Err(e) => {
            return make_error_results(&commands, &e.to_string(), overall_start.elapsed().as_millis() as u64);
        }
    };

    // Open session channel with PTY + shell
    let mut channel = match handle.channel_open_session().await {
        Ok(ch) => ch,
        Err(e) => {
            return make_error_results(&commands, &format!("Failed to open channel: {}", e), overall_start.elapsed().as_millis() as u64);
        }
    };

    if let Err(e) = channel.request_pty(false, "xterm-256color", 200, 500, 0, 0, &[]).await {
        return make_error_results(&commands, &format!("Failed to request PTY: {}", e), overall_start.elapsed().as_millis() as u64);
    }

    if let Err(e) = channel.request_shell(false).await {
        return make_error_results(&commands, &format!("Failed to request shell: {}", e), overall_start.elapsed().as_millis() as u64);
    }

    // Wait for initial prompt and start building the session transcript
    let mut transcript = String::new();
    match wait_for_prompt(&mut channel, prompt_timeout).await {
        Ok(raw) => {
            let cleaned = strip_ansi(&raw);
            transcript.push_str(cleaned.trim_start());
        }
        Err(e) => {
            tracing::warn!("Shell initial prompt wait failed for {}@{}: {}", config.username, config.host, e);
        }
    }

    // Helper: send a command and append to transcript, return the cleaned output
    async fn send_cmd(
        channel: &mut russh::Channel<client::Msg>,
        cmd: &str,
        timeout: Duration,
        transcript: &mut String,
    ) -> Result<String, String> {
        let cmd_bytes = format!("{}\n", cmd);
        let mut cursor = std::io::Cursor::new(cmd_bytes.into_bytes());
        if let Err(e) = channel.data(&mut cursor).await {
            return Err(format!("Failed to send command: {}", e));
        }
        match wait_for_prompt(channel, timeout).await {
            Ok(raw_output) => {
                let cleaned = strip_ansi(&raw_output);
                // Append to transcript (includes echo + output + prompt)
                if !transcript.is_empty() && !transcript.ends_with('\n') {
                    // No newline needed — the prompt line is already there
                }
                transcript.push_str(&cleaned);
                Ok(cleaned)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    // Send auto_commands one at a time, waiting for prompt between each
    for (i, auto_cmd) in auto_commands.iter().enumerate() {
        tracing::debug!("Sending auto_command {}/{} to {}: {}", i + 1, auto_commands.len(), session_name, auto_cmd);
        match send_cmd(&mut channel, auto_cmd, prompt_timeout, &mut transcript).await {
            Ok(_) => {
                tracing::debug!("Auto_command '{}' complete", auto_cmd);
            }
            Err(e) => {
                tracing::warn!("Auto_command '{}' failed: {}", auto_cmd, e);
            }
        }
    }

    tracing::debug!("Auto_commands complete for {}, executing {} commands", session_name, commands.len());

    // Execute each MOP command in sequence
    let mut results = Vec::with_capacity(commands.len());

    for (step_id, command) in &commands {
        let cmd_start = Instant::now();

        match send_cmd(&mut channel, command, timeout_per_command, &mut transcript).await {
            Ok(cleaned) => {
                // Per-step output: just this command's output (strip trailing prompt line)
                let lines: Vec<&str> = cleaned.lines().collect();
                let step_output = if lines.len() <= 1 {
                    cleaned.trim().to_string()
                } else {
                    lines[..lines.len() - 1].join("\n")
                };

                results.push(ShellCommandResult {
                    step_id: step_id.clone(),
                    status: CommandStatus::Success,
                    output: step_output,
                    error: None,
                    execution_time_ms: cmd_start.elapsed().as_millis() as u64,
                    transcript: transcript.clone(),
                });
            }
            Err(e) => {
                let is_timeout = e.contains("Timed out");
                results.push(ShellCommandResult {
                    step_id: step_id.clone(),
                    status: if is_timeout { CommandStatus::Timeout } else { CommandStatus::Error },
                    output: String::new(),
                    error: Some(e),
                    execution_time_ms: cmd_start.elapsed().as_millis() as u64,
                    transcript: transcript.clone(),
                });
            }
        }
    }

    // Send post-commands (e.g. exit config mode, write memory) — don't track as steps
    for post_cmd in &post_commands {
        tracing::debug!("Sending post-command to {}: {}", session_name, post_cmd);
        match send_cmd(&mut channel, post_cmd, prompt_timeout, &mut transcript).await {
            Ok(_) => {
                tracing::debug!("Post-command '{}' complete", post_cmd);
            }
            Err(e) => {
                tracing::warn!("Post-command '{}' failed: {}", post_cmd, e);
            }
        }
    }

    // Disconnect
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;

    tracing::info!(
        "Shell execution on {}@{} complete: {} commands, {:.1}s total",
        config.username, config.host,
        results.len(),
        overall_start.elapsed().as_secs_f64()
    );

    ShellExecutionResults {
        commands: results,
        full_transcript: transcript,
    }
}

/// Execute a command on multiple SSH sessions in parallel
///
/// Uses a semaphore to limit concurrent connections to MAX_CONCURRENT_CONNECTIONS.
pub async fn execute_bulk_command(
    configs: Vec<(SshConfig, String, String)>, // (config, session_id, session_name)
    command: String,
    timeout_secs: u64,
) -> BulkCommandResponse {
    let start = Instant::now();
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
    let timeout = Duration::from_secs(timeout_secs);

    let futures: Vec<_> = configs
        .into_iter()
        .map(|(config, session_id, session_name)| {
            let semaphore = semaphore.clone();
            let command = command.clone();

            async move {
                let _permit = semaphore.acquire().await.unwrap();
                execute_command_on_session(config, session_id, session_name, command, timeout).await
            }
        })
        .collect();

    let results = join_all(futures).await;

    let success_count = results
        .iter()
        .filter(|r| r.status == CommandStatus::Success)
        .count() as u32;
    let error_count = results.len() as u32 - success_count;

    BulkCommandResponse {
        results,
        total_time_ms: start.elapsed().as_millis() as u64,
        success_count,
        error_count,
    }
}

#[cfg(test)]
mod exec_tests {
    //! Behavior contracts for the exec channel-handling loop, exercised
    //! through the production caller (`exec_on_remote_pooled`). Each test
    //! uses a unique ephemeral test-server port, so the pool's per-key
    //! mutex doesn't interleave them.

    use super::*;
    use super::exec_pool::exec_on_remote_pooled;
    use super::test_utils::{
        ephemeral_ed25519, start_test_server, ExecResponse, TestServerConfig,
    };
    use std::sync::Arc;

    fn cfg(host: std::net::SocketAddr) -> SshConfig {
        SshConfig {
            host: host.ip().to_string(),
            port: host.port(),
            username: "u".into(),
            auth: SshAuth::Password("p".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        }
    }

    async fn server_with_responder(
        responder: impl Fn(&str) -> Option<ExecResponse> + Send + Sync + 'static,
    ) -> std::net::SocketAddr {
        start_test_server(TestServerConfig {
            accept_password: Some(("u".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: Some(Arc::new(responder)),
            eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
        })
        .await
    }

    #[tokio::test]
    async fn captures_stdout_and_zero_exit() {
        let addr = server_with_responder(|cmd| {
            assert_eq!(cmd, "echo hello");
            Some(ExecResponse {
                stdout: b"hello\n".to_vec(),
                stderr: vec![],
                exit_status: 0,
            })
        })
        .await;

        let r = exec_on_remote_pooled(&cfg(addr), "echo hello", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(r.stdout, b"hello\n");
        assert!(r.stderr.is_empty());
        assert_eq!(r.exit_status, Some(0));
    }

    #[tokio::test]
    async fn propagates_nonzero_exit() {
        let addr = server_with_responder(|_| Some(ExecResponse {
            stdout: vec![],
            stderr: vec![],
            exit_status: 2,
        }))
        .await;

        let r = exec_on_remote_pooled(&cfg(addr), "false", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(r.exit_status, Some(2));
    }

    #[tokio::test]
    async fn captures_stderr_separately_from_stdout() {
        let addr = server_with_responder(|_| Some(ExecResponse {
            stdout: b"out\n".to_vec(),
            stderr: b"err\n".to_vec(),
            exit_status: 1,
        }))
        .await;

        let r = exec_on_remote_pooled(&cfg(addr), "noisy-cmd", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(r.stdout, b"out\n");
        assert_eq!(r.stderr, b"err\n");
        assert_eq!(r.exit_status, Some(1));
    }

    #[tokio::test]
    async fn reports_command_not_found_via_exit_127() {
        // Mirror real shell behavior: missing command → stderr message + exit 127.
        // The SNMP-via-jump path uses this exit code to surface a clear
        // "snmpget not found on jump host" error.
        let addr = server_with_responder(|_| Some(ExecResponse {
            stdout: vec![],
            stderr: b"bash: snmpget: command not found\n".to_vec(),
            exit_status: 127,
        }))
        .await;

        let r = exec_on_remote_pooled(&cfg(addr), "snmpget -v2c -c x 1.2.3.4 .1", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(r.exit_status, Some(127));
        assert!(String::from_utf8_lossy(&r.stderr).contains("not found"));
    }

    /// Regression test for the bug that produced "snmpget on jump 'X' closed
    /// without an exit status" against real OpenSSH bastions.
    ///
    /// RFC 4254 doesn't constrain the order of `eof` vs `exit-status`, and
    /// OpenSSH's server commonly sends `eof` first. An earlier version of
    /// the channel-handling loop broke on `eof`, which meant `exit-status`
    /// — sent ~µs later — was discarded and the call surfaced as a silent
    /// close. This test pins the fix: with the test server emitting
    /// `eof` BEFORE `exit-status`, we still capture the exit status.
    #[tokio::test]
    async fn captures_exit_status_when_eof_arrives_first() {
        let addr = start_test_server(TestServerConfig {
            accept_password: Some(("u".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: Some(Arc::new(|_| Some(ExecResponse {
                stdout: b"iso.3.6.1.2.1.1.5.0 = STRING: \"RR1-NYC\"\n".to_vec(),
                stderr: vec![],
                exit_status: 0,
            }))),
            eof_before_exit_status: true,
            host_key: ephemeral_ed25519(),
        })
        .await;

        let r = exec_on_remote_pooled(&cfg(addr), "snmpget ...", Duration::from_secs(5))
            .await
            .expect("exec should succeed even with eof-first ordering");
        assert_eq!(r.exit_status, Some(0),
            "exit_status must survive eof-arrives-first ordering");
        assert!(String::from_utf8_lossy(&r.stdout).contains("RR1-NYC"),
            "stdout should still be captured");
    }
}
