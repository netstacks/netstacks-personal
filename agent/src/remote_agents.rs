//! Remote agent lifecycle management.
//!
//! Handles deploying the netstacks-agent binary to remote Linux hosts via
//! SFTP, launching it with `--remote`, capturing the stdout protocol output
//! (NETSTACKS_AUTH_TOKEN, NETSTACKS_TLS_CERT, NETSTACKS_PORT), and tracking
//! running remote agents for status checks and cleanup.
//!
//! The remote agent listens on the remote host's loopback only. Every
//! connection to it — from this agent and from the app's remote windows and
//! workspaces — goes through an SSH local forward (`AgentTunnel`), so it works
//! behind host firewalls (NixOS's default, firewalld, cloud security groups)
//! and the agent is never exposed on the network.

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::api::{ApiError, AppState};
use crate::models::AuthType;
use crate::sftp::{SftpAuth, SftpConfig, SftpManager};
use crate::ssh;
use crate::tunnels::local_forward::{serve_local_forward, ForwardCounters};
use crate::tunnels::PooledConnection;

const REMOTE_AGENT_DIR: &str = ".netstacks";
const REMOTE_AGENT_BIN: &str = ".netstacks/netstacks-agent";
/// Launch output (protocol lines + logs). Under $HOME rather than a shared
/// /tmp name, which another user's file on the same server could block.
const REMOTE_LAUNCH_LOG: &str = ".netstacks/launch.log";
const LOCAL_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Pulls just the protocol lines out of the launch log. The agent logs
/// startup (DB migrations, …) before it prints NETSTACKS_PORT, so a fixed
/// `head -N` missed the port.
const PROTOCOL_GREP: &str = "grep -E '^NETSTACKS_(AUTH_TOKEN|TLS_CERT|PORT)='";
/// SSH keepalive on the tunnel connection, so idle NAT / firewall state
/// doesn't silently drop it.
const TUNNEL_KEEPALIVE: Duration = Duration::from_secs(30);

/// Public CDN base for the remote-workspace agent binaries. The matching
/// version + arch is downloaded on demand (the binary is not bundled in the
/// app). Layout: `<base>/<version>/netstacks-agent-<triple>` (+ `.sha256`).
const REMOTE_AGENT_BASE_URL: &str = "https://releases.netstacks.net/agent";

#[derive(Debug, Clone, Serialize)]
pub struct RemoteAgentInfo {
    pub id: String,
    pub session_id: String,
    /// The remote server (the SSH session's host).
    pub host: String,
    /// The agent's port on the remote host's loopback.
    pub remote_port: u16,
    pub auth_token: String,
    pub tls_cert_b64: String,
    #[serde(skip)]
    tunnel: Arc<AgentTunnel>,
}

impl RemoteAgentInfo {
    fn response(&self) -> DeployResponse {
        DeployResponse {
            agent_id: self.id.clone(),
            host: Ipv4Addr::LOCALHOST.to_string(),
            port: self.tunnel.local_port,
            remote_host: self.host.clone(),
            auth_token: self.auth_token.clone(),
            tls_cert_b64: self.tls_cert_b64.clone(),
        }
    }
}

/// SSH local forward from `127.0.0.1:<local_port>` on this machine to the
/// remote agent's loopback port, over one dedicated SSH connection. Dropping
/// the last handle stops the listener and closes the connection.
struct AgentTunnel {
    local_port: u16,
    conn: Arc<Mutex<PooledConnection>>,
    cancel: CancellationToken,
}

impl AgentTunnel {
    async fn is_open(&self) -> bool {
        !self.cancel.is_cancelled() && !self.conn.lock().await.handle.is_closed()
    }
}

impl Drop for AgentTunnel {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl std::fmt::Debug for AgentTunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentTunnel").field("local_port", &self.local_port).finish()
    }
}

#[derive(Debug, Deserialize)]
pub struct DeployRequest {
    pub session_id: String,
}

/// How the app reaches a deployed agent: `https://{host}:{port}` is the local
/// end of the SSH tunnel; `remote_host` is the server it runs on (for display).
#[derive(Debug, Serialize)]
pub struct DeployResponse {
    pub agent_id: String,
    pub host: String,
    pub port: u16,
    pub remote_host: String,
    pub auth_token: String,
    pub tls_cert_b64: String,
}

#[derive(Debug, Serialize)]
pub struct AgentStatusResponse {
    pub alive: bool,
    pub host: String,
    pub port: u16,
}

pub struct RemoteAgentManager {
    agents: RwLock<HashMap<String, RemoteAgentInfo>>,
    deploying: RwLock<HashSet<String>>,
}

impl RemoteAgentManager {
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            deploying: RwLock::new(HashSet::new()),
        }
    }

    pub async fn deploy(
        &self,
        state: &Arc<AppState>,
        req: DeployRequest,
    ) -> Result<DeployResponse, ApiError> {
        let (mut ssh_config, sftp_config, session) =
            resolve_session_configs(state, &req.session_id).await?;
        ssh_config.skip_keyboard_interactive = true;
        let host = session.host.clone();

        // Concurrent deploy protection — only one deploy per host at a time
        {
            let mut deploying = self.deploying.write().await;
            if !deploying.insert(host.clone()) {
                return Err(ApiError {
                    error: format!("Deploy already in progress for {}", host),
                    code: "DEPLOY_IN_PROGRESS".to_string(),
                });
            }
        }
        let result = self.deploy_inner(&ssh_config, sftp_config, &req, &host).await;
        self.deploying.write().await.remove(&host);
        result
    }

    async fn deploy_inner(
        &self,
        ssh_config: &ssh::SshConfig,
        sftp_config: SftpConfig,
        req: &DeployRequest,
        host: &str,
    ) -> Result<DeployResponse, ApiError> {
        // 1. An agent we already track for this host: reopen its tunnel if the
        //    SSH connection dropped, then reuse it when healthy + same version.
        let existing = self.agents.read().await.values().find(|a| a.host == host).cloned();
        if let Some(mut existing) = existing {
            if !existing.tunnel.is_open().await {
                match open_tunnel(ssh_config, existing.remote_port).await {
                    Ok(tunnel) => existing.tunnel = Arc::new(tunnel),
                    Err(e) => tracing::info!(host = %host, error = %e.error, "Could not reopen tunnel to tracked remote agent"),
                }
            }
            match tunnel_health(&existing.tunnel, &existing.auth_token, 1).await {
                Some(remote_ver) if remote_ver == LOCAL_VERSION => {
                    tracing::info!(host = %host, local_port = existing.tunnel.local_port, "Reusing healthy remote agent (in-memory, version match)");
                    let response = existing.response();
                    self.agents.write().await.insert(existing.id.clone(), existing);
                    return Ok(response);
                }
                Some(remote_ver) => tracing::info!(host = %host, local = LOCAL_VERSION, remote = %remote_ver, "Remote agent version mismatch — will redeploy"),
                None => tracing::info!(host = %host, "Tracked remote agent unreachable — will relaunch"),
            }
            self.agents.write().await.remove(&existing.id);
        }

        // 2. An agent already running on the remote host (survives local app
        //    restarts — the remote process keeps running): reuse it through a
        //    fresh tunnel when healthy + same version.
        let probe_result = ssh_exec(ssh_config, &req.session_id, host,
            &format!("{PROTOCOL_GREP} ~/{REMOTE_LAUNCH_LOG} 2>/dev/null"),
            Duration::from_secs(10),
        ).await;
        if let Some((token, cert, remote_port)) = parse_launch_protocol(&probe_result.output) {
            if let Ok(tunnel) = open_tunnel(ssh_config, remote_port).await {
                match tunnel_health(&tunnel, &token, 1).await {
                    Some(remote_ver) if remote_ver == LOCAL_VERSION => {
                        tracing::info!(host = %host, remote_port, "Reusing remote agent (discovered via SSH, version match)");
                        let info = RemoteAgentInfo {
                            id: uuid::Uuid::new_v4().to_string(),
                            session_id: req.session_id.clone(),
                            host: host.to_string(),
                            remote_port,
                            auth_token: token,
                            tls_cert_b64: cert,
                            tunnel: Arc::new(tunnel),
                        };
                        let response = info.response();
                        self.agents.write().await.insert(info.id.clone(), info);
                        return Ok(response);
                    }
                    Some(remote_ver) => tracing::info!(host = %host, local = LOCAL_VERSION, remote = %remote_ver, "Remote agent version mismatch — will redeploy"),
                    None => {}
                }
            }
        }

        // 3. Binary on disk but not running — check version before launching
        let version_check = ssh_exec(ssh_config, &req.session_id, host,
            &format!("test -x ~/{bin} && ~/{bin} --version 2>/dev/null || echo MISSING", bin = REMOTE_AGENT_BIN),
            Duration::from_secs(10),
        ).await;
        let remote_bin_version = version_check.output.trim();
        if remote_bin_version == LOCAL_VERSION {
            tracing::info!(host = %host, version = LOCAL_VERSION, "Binary on remote matches — launching without re-upload");
            return self.launch_remote_agent(ssh_config, req, host).await;
        }
        if remote_bin_version != "MISSING" && !remote_bin_version.is_empty() {
            tracing::info!(host = %host, local = LOCAL_VERSION, remote = remote_bin_version, "Binary on remote is outdated — re-uploading");
        }

        // 4. Full deploy: kill stale process, upload binary, launch.
        //    Each SSH exec is a short single-purpose command. russh's channel
        //    can close early on compound commands that include `sleep`, so all
        //    waits happen on our side via tokio::time::sleep.
        tracing::info!("Full deploy to {} (uploading {} binary)", host, LOCAL_VERSION);

        // 4a. Resolve $HOME
        let home_result = ssh_exec(ssh_config, &req.session_id, host,
            "echo \"$HOME\"",
            Duration::from_secs(10),
        ).await;
        let home = home_result.output.trim().to_string();
        if !home.starts_with('/') {
            let detail = home_result.error.unwrap_or_else(|| home.clone());
            return Err(ApiError {
                error: format!("Could not resolve $HOME on {}: {:?}", host, detail),
                code: "HOME_UNKNOWN".to_string(),
            });
        }

        // 4b. Kill running agent, wait for exit, then clean up.
        //     Single SSH exec — output doesn't matter, only side effects.
        //     Safe even if russh closes the channel early: pkill already ran.
        let _ = ssh_exec(ssh_config, &req.session_id, host,
            "pkill -f \"$HOME/.netstacks/netstacks-agent --remote\" 2>/dev/null || true; \
             for _i in 1 2 3 4 5 6 7 8 9 10; do \
               pgrep -f \"$HOME/.netstacks/netstacks-agent --remote\" >/dev/null 2>&1 || break; \
               sleep 1; \
             done; \
             mkdir -p ~/.netstacks; \
             rm -f ~/.netstacks/netstacks-agent ~/.netstacks/launch.log 2>/dev/null",
            Duration::from_secs(20),
        ).await;

        // 4c. Detect the remote CPU arch → musl target triple. NetStacks ships
        //     static musl binaries (one per arch) that run on any distro.
        let arch_result = ssh_exec(ssh_config, &req.session_id, host,
            "uname -m",
            Duration::from_secs(10),
        ).await;
        let arch = arch_result.output.trim();
        let target_triple = match arch {
            "x86_64" | "amd64" => "x86_64-unknown-linux-musl",
            "aarch64" | "arm64" => "aarch64-unknown-linux-musl",
            other => {
                let shown = if other.is_empty() { "unknown" } else { other };
                return Err(ApiError {
                    error: format!("Unsupported remote architecture '{shown}' — NetStacks ships remote agents for x86_64 and aarch64 Linux only"),
                    code: "UNSUPPORTED_ARCH".to_string(),
                });
            }
        };

        // 4d. Read + upload binary via SFTP
        let remote_dir = format!("{}/{}", home, REMOTE_AGENT_DIR);
        let remote_bin = format!("{}/{}", home, REMOTE_AGENT_BIN);

        let binary_path = ensure_remote_agent_binary(target_triple).await?;
        let binary_data = tokio::fs::read(&binary_path).await.map_err(|e| ApiError {
            error: format!("Failed to read agent binary at {}: {}", binary_path.display(), e),
            code: "BINARY_READ_FAILED".to_string(),
        })?;
        let binary_size = binary_data.len();
        tracing::info!(size_mb = binary_size as f64 / 1_048_576.0, "Uploading agent binary");

        let sftp_manager = SftpManager::new();
        let sftp_id = format!("remote-deploy-{}", uuid::Uuid::new_v4());
        sftp_manager
            .create_session(sftp_id.clone(), sftp_config)
            .await
            .map_err(|e| ApiError {
                error: format!("SFTP connect to {} failed: {}", host, e),
                code: "SFTP_CONNECT_FAILED".to_string(),
            })?;

        let upload_result: Result<(), ApiError> = async {
            let sftp_session = sftp_manager.get_session(&sftp_id).await.ok_or_else(|| ApiError {
                error: "SFTP session lost after connect".to_string(),
                code: "SFTP_SESSION_LOST".to_string(),
            })?;
            let session = sftp_session.lock().await;
            let _ = session.mkdir(&remote_dir).await; // may already exist
            session.upload(&remote_bin, &binary_data).await.map_err(|e| ApiError {
                error: format!("SFTP upload failed: {}", e),
                code: "UPLOAD_FAILED".to_string(),
            })
        }.await;

        sftp_manager.remove_session(&sftp_id).await;
        if let Err(ref e) = upload_result {
            tracing::error!(host = %host, error = %e.error, code = %e.code, "SFTP upload failed");
        }
        upload_result?;

        // 4e. Verify upload + chmod
        let verify = ssh_exec(ssh_config, &req.session_id, host,
            "SZ=$(stat -c%s ~/.netstacks/netstacks-agent 2>/dev/null || \
                  stat -f%z ~/.netstacks/netstacks-agent 2>/dev/null || echo 0); \
             chmod +x ~/.netstacks/netstacks-agent 2>/dev/null; \
             echo \"SIZE=$SZ\"",
            Duration::from_secs(15),
        ).await;
        let remote_size: usize = verify.output.lines()
            .find_map(|l| l.strip_prefix("SIZE="))
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        if remote_size != binary_size {
            return Err(ApiError {
                error: format!("Binary upload corrupted — local {} bytes, remote {} bytes", binary_size, remote_size),
                code: "UPLOAD_CORRUPT".to_string(),
            });
        }

        tracing::info!("Binary uploaded and verified ({} bytes) — launching...", binary_size);
        self.launch_remote_agent(ssh_config, req, host).await
    }

    async fn launch_remote_agent(
        &self,
        ssh_config: &ssh::SshConfig,
        req: &DeployRequest,
        host: &str,
    ) -> Result<DeployResponse, ApiError> {
        // Kill stale process, wait for exit, clear old log, chmod
        let _ = ssh_exec(ssh_config, &req.session_id, host,
            &format!(
                "pkill -f \"$HOME/.netstacks/netstacks-agent --remote\" 2>/dev/null || true; \
                 for _i in 1 2 3 4 5; do \
                   pgrep -f \"$HOME/.netstacks/netstacks-agent --remote\" >/dev/null 2>&1 || break; \
                   sleep 1; \
                 done; \
                 mkdir -p ~/{dir}; \
                 rm -f ~/{log} 2>/dev/null; \
                 chmod +x ~/{bin}",
                dir = REMOTE_AGENT_DIR, log = REMOTE_LAUNCH_LOG, bin = REMOTE_AGENT_BIN,
            ),
            Duration::from_secs(15),
        ).await;

        // Launch agent in background — shell forks and exits immediately.
        // Loopback only: the app reaches it through the SSH tunnel, never
        // over the network. `--license-example` satisfies the agent's launch
        // gate (anti-double-click friction barrier — see REQUIRED_LAUNCH_FLAG
        // in agent/src/main.rs). Must match the value the agent enforces.
        let launch_cmd = format!(
            "umask 077; nohup ~/{bin} --remote --bind 127.0.0.1 --license-example \
             > ~/{log} 2>&1 &",
            bin = REMOTE_AGENT_BIN, log = REMOTE_LAUNCH_LOG,
        );
        let _ = ssh_exec(ssh_config, &req.session_id, host, &launch_cmd, Duration::from_secs(10)).await;

        // Wait for the agent to write its protocol lines (TLS key generation
        // on a first launch can take a few seconds on a slow host).
        let mut output = String::new();
        let mut protocol = None;
        for attempt in 0..6 {
            tokio::time::sleep(Duration::from_secs(if attempt == 0 { 3 } else { 2 })).await;
            let log_result = ssh_exec(ssh_config, &req.session_id, host,
                &format!("{PROTOCOL_GREP} ~/{REMOTE_LAUNCH_LOG} 2>/dev/null"),
                Duration::from_secs(10),
            ).await;
            output = if log_result.output.is_empty() {
                log_result.error.unwrap_or_default()
            } else {
                log_result.output
            };
            protocol = parse_launch_protocol(&output);
            if protocol.is_some() {
                break;
            }
        }
        let (auth_token, tls_cert_b64, remote_port) = protocol.ok_or_else(|| ApiError {
            error: format!(
                "Remote agent didn't report its auth token, certificate and port. Output: {}",
                truncate(&output, 500)
            ),
            code: "PROTOCOL_ERROR".to_string(),
        })?;

        let tunnel = open_tunnel(ssh_config, remote_port).await?;
        if tunnel_health(&tunnel, &auth_token, 5).await.is_none() {
            return Err(ApiError {
                error: format!(
                    "Remote agent started on {host} (port {remote_port}) but isn't answering through the SSH tunnel. Output: {}",
                    truncate(&output, 500)
                ),
                code: "TUNNEL_UNHEALTHY".to_string(),
            });
        }

        let info = RemoteAgentInfo {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: req.session_id.clone(),
            host: host.to_string(),
            remote_port,
            auth_token,
            tls_cert_b64,
            tunnel: Arc::new(tunnel),
        };
        tracing::info!(agent_id = %info.id, host = %host, remote_port, local_port = info.tunnel.local_port, version = LOCAL_VERSION, "Remote agent launched");
        let response = info.response();
        self.agents.write().await.insert(info.id.clone(), info);
        Ok(response)
    }

    pub async fn status(&self, agent_id: &str) -> Result<AgentStatusResponse, ApiError> {
        let agents = self.agents.read().await;
        let info = agents.get(agent_id).ok_or_else(|| ApiError {
            error: format!("Remote agent '{}' not found", agent_id),
            code: "NOT_FOUND".to_string(),
        })?;
        let alive = info.tunnel.is_open().await
            && tunnel_health(&info.tunnel, &info.auth_token, 1).await.is_some();
        Ok(AgentStatusResponse { alive, host: Ipv4Addr::LOCALHOST.to_string(), port: info.tunnel.local_port })
    }

    pub async fn stop(
        &self,
        state: &Arc<AppState>,
        agent_id: &str,
    ) -> Result<(), ApiError> {
        let info = {
            let agents = self.agents.read().await;
            agents.get(agent_id).cloned().ok_or_else(|| ApiError {
                error: format!("Remote agent '{}' not found", agent_id),
                code: "NOT_FOUND".to_string(),
            })?
        };

        let (ssh_config, _, _) = resolve_session_configs(state, &info.session_id).await?;
        let _ = ssh_exec(&ssh_config, &info.session_id, &info.host,
            "pkill -f \"$HOME/.netstacks/netstacks-agent --remote\" 2>/dev/null; echo done",
            Duration::from_secs(10),
        ).await;

        self.agents.write().await.remove(agent_id);
        tracing::info!(agent_id = %agent_id, "Remote agent stopped");
        Ok(())
    }
}

impl Default for RemoteAgentManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async fn ssh_exec(
    config: &ssh::SshConfig,
    session_id: &str,
    host: &str,
    cmd: &str,
    timeout: Duration,
) -> ssh::CommandResult {
    ssh::execute_command_on_session(
        config.clone(),
        session_id.to_string(),
        host.to_string(),
        cmd.to_string(),
        timeout,
    ).await
}

/// Open an SSH local forward to the remote agent's loopback `remote_port`,
/// on a dedicated keepalive connection, listening on an OS-assigned local
/// loopback port.
async fn open_tunnel(config: &ssh::SshConfig, remote_port: u16) -> Result<AgentTunnel, ApiError> {
    let handle = ssh::connect_and_authenticate_with_options(
        config,
        ssh::ConnectOptions {
            auto_accept_changed_keys: false,
            approvals: None,
            keepalive_interval: Some(TUNNEL_KEEPALIVE),
        },
    )
    .await
    .map_err(|e| ApiError {
        error: format!("SSH tunnel to {} failed: {}", config.host, e),
        code: "TUNNEL_FAILED".to_string(),
    })?;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| ApiError {
            error: format!("Could not open a local port for the remote agent tunnel: {}", e),
            code: "TUNNEL_FAILED".to_string(),
        })?;
    let local_port = listener
        .local_addr()
        .map_err(|e| ApiError {
            error: format!("Could not read the tunnel's local port: {}", e),
            code: "TUNNEL_FAILED".to_string(),
        })?
        .port();
    let conn = Arc::new(Mutex::new(PooledConnection { handle, tunnel_ids: Vec::new() }));
    let cancel = CancellationToken::new();
    tokio::spawn({
        let conn = conn.clone();
        let cancel = cancel.clone();
        async move {
            let counters = ForwardCounters {
                tx: Arc::new(AtomicU64::new(0)),
                rx: Arc::new(AtomicU64::new(0)),
            };
            serve_local_forward(conn, listener, "127.0.0.1", remote_port, cancel, counters).await;
        }
    });
    tracing::info!(host = %config.host, remote_port, local_port, "Remote agent tunnel open");
    Ok(AgentTunnel { local_port, conn, cancel })
}

/// The remote agent's version via its tunnel, retrying `attempts` times a
/// second apart; None if it never answers.
async fn tunnel_health(tunnel: &AgentTunnel, token: &str, attempts: u32) -> Option<String> {
    for attempt in 0..attempts {
        if let Some(version) =
            health_check_version(&Ipv4Addr::LOCALHOST.to_string(), tunnel.local_port, token).await
        {
            return Some(version);
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    None
}

/// (auth token, TLS cert, port) from the agent's launch output, if complete.
fn parse_launch_protocol(output: &str) -> Option<(String, String, u16)> {
    Some((
        parse_protocol_line(output, "NETSTACKS_AUTH_TOKEN=")?,
        parse_protocol_line(output, "NETSTACKS_TLS_CERT=")?,
        parse_protocol_line(output, "NETSTACKS_PORT=")?.parse().ok()?,
    ))
}

async fn resolve_session_configs(
    state: &Arc<AppState>,
    session_id: &str,
) -> Result<(ssh::SshConfig, SftpConfig, crate::models::Session), ApiError> {
    let session = state.provider.get_session(session_id).await.map_err(|e| ApiError {
        error: format!("Session not found: {}", e),
        code: "NOT_FOUND".to_string(),
    })?;

    let profile = state.provider.get_profile(&session.profile_id).await.map_err(|e| ApiError {
        error: format!("Profile not found: {}", e),
        code: "NOT_FOUND".to_string(),
    })?;

    let credential = state
        .provider
        .get_profile_credential(&session.profile_id)
        .await
        .ok()
        .flatten();

    let ssh_config =
        ssh::build_ssh_config_from_session(&session, &profile, credential.as_ref())
            .map_err(|e| ApiError { error: e, code: "AUTH_MISSING".to_string() })?;

    let sftp_auth = match profile.auth_type {
        AuthType::Password => {
            let password = credential
                .as_ref()
                .and_then(|c| c.password.clone())
                .ok_or_else(|| ApiError {
                    error: "No password for SFTP".to_string(),
                    code: "AUTH_MISSING".to_string(),
                })?;
            SftpAuth::Password(password)
        }
        AuthType::Key => {
            let key_path = profile.key_path.clone().ok_or_else(|| ApiError {
                error: "No key path for SFTP".to_string(),
                code: "AUTH_MISSING".to_string(),
            })?;
            let passphrase = credential.as_ref().and_then(|c| c.key_passphrase.clone());
            SftpAuth::KeyFile { path: key_path, passphrase }
        }
    };

    let sftp_config = SftpConfig {
        host: session.host.clone(),
        port: session.port,
        username: profile.username.clone(),
        auth: sftp_auth,
    };

    Ok((ssh_config, sftp_config, session))
}

/// Resolve the remote-workspace agent binary for `target_triple`, downloading
/// it from the release CDN on first use and caching it under the app data dir.
///
/// The binary is NOT bundled in the app: the first time a user opens a remote
/// workspace we fetch the version- and arch-matched static musl binary, verify
/// it against the published SHA-256, and cache it. Subsequent deploys reuse the
/// cached copy. A locally cross-compiled binary is preferred during development.
async fn ensure_remote_agent_binary(target_triple: &str) -> Result<PathBuf, ApiError> {
    let filename = format!("netstacks-agent-{target_triple}");

    // Dev fast-path: a locally cross-compiled binary, if present, wins so
    // developers test their own build without hitting the CDN.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let dev = exe_dir.join(format!("../../target/{target_triple}/release/netstacks-agent"));
            if dev.is_file() {
                tracing::info!(path = %dev.display(), "Using dev cross-compiled remote agent binary");
                return Ok(dev);
            }
        }
    }

    // Per-version cache. A present file was verified when written, so reuse it.
    let cache_dir = crate::tls::data_dir().join("remote-agents").join(LOCAL_VERSION);
    let cache_path = cache_dir.join(&filename);
    if cache_path.is_file() {
        tracing::info!(path = %cache_path.display(), "Using cached remote agent binary");
        return Ok(cache_path);
    }

    let url = format!("{REMOTE_AGENT_BASE_URL}/{LOCAL_VERSION}/{filename}");
    tracing::info!(url = %url, "Downloading remote agent binary");

    let client = reqwest::Client::builder().build().map_err(|e| ApiError {
        error: format!("HTTP client init failed: {e}"),
        code: "HTTP_INIT_FAILED".to_string(),
    })?;

    let download_err = |e: reqwest::Error| ApiError {
        error: format!(
            "Could not download the remote workspace agent for {target_triple} (v{LOCAL_VERSION}): {e}. \
             It may not be published for this version/architecture yet."
        ),
        code: "AGENT_DOWNLOAD_FAILED".to_string(),
    };

    let resp = client
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(download_err)?;
    // The release CDN answers `204 No Content` for objects that don't exist
    // (rather than 404), which `error_for_status()` treats as success. Require
    // a real `200 OK` so a not-yet-published binary surfaces as a clear
    // "not published" error instead of flowing through as empty bytes and
    // tripping the checksum check below.
    if resp.status() != reqwest::StatusCode::OK {
        return Err(ApiError {
            error: format!(
                "The remote workspace agent for {target_triple} (v{LOCAL_VERSION}) is not published yet \
                 (the release server returned {} for {url}).",
                resp.status()
            ),
            code: "AGENT_DOWNLOAD_FAILED".to_string(),
        });
    }
    let binary_data = resp.bytes().await.map_err(download_err)?;
    if binary_data.is_empty() {
        return Err(ApiError {
            error: format!(
                "The remote workspace agent for {target_triple} (v{LOCAL_VERSION}) is not published yet \
                 (the release server returned an empty response)."
            ),
            code: "AGENT_DOWNLOAD_FAILED".to_string(),
        });
    }

    // Verify against the published checksum (transport is TLS to the CDN).
    let sha_text = client
        .get(format!("{url}.sha256"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| ApiError {
            error: format!("Could not download remote agent checksum: {e}"),
            code: "AGENT_CHECKSUM_FAILED".to_string(),
        })?
        .text()
        .await
        .map_err(|e| ApiError {
            error: format!("Could not read remote agent checksum: {e}"),
            code: "AGENT_CHECKSUM_FAILED".to_string(),
        })?;
    let expected = sha_text.split_whitespace().next().unwrap_or("").to_lowercase();

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&binary_data);
    let actual = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    if expected.is_empty() || actual != expected {
        return Err(ApiError {
            error: format!(
                "Remote agent checksum mismatch for {target_triple} (expected {expected}, got {actual}) — refusing to deploy"
            ),
            code: "AGENT_CHECKSUM_MISMATCH".to_string(),
        });
    }

    // Write atomically (temp + rename) so a concurrent/aborted deploy never
    // leaves a partial binary that the cache fast-path would later trust.
    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| ApiError {
        error: format!("Failed to create agent cache dir: {e}"),
        code: "CACHE_WRITE_FAILED".to_string(),
    })?;
    let tmp_path = cache_dir.join(format!(".{filename}.tmp"));
    tokio::fs::write(&tmp_path, &binary_data).await.map_err(|e| ApiError {
        error: format!("Failed to write agent cache: {e}"),
        code: "CACHE_WRITE_FAILED".to_string(),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755)).await;
    }
    tokio::fs::rename(&tmp_path, &cache_path).await.map_err(|e| ApiError {
        error: format!("Failed to finalize agent cache: {e}"),
        code: "CACHE_WRITE_FAILED".to_string(),
    })?;

    tracing::info!(path = %cache_path.display(), bytes = binary_data.len(), "Remote agent downloaded, verified, and cached");
    Ok(cache_path)
}

fn parse_protocol_line(output: &str, prefix: &str) -> Option<String> {
    output
        .lines()
        .find(|line| line.starts_with(prefix))
        .and_then(|line| {
            let value = &line[prefix.len()..];
            let trimmed = value.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        })
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() > max { &s[..max] } else { s }
}

/// Health check that also returns the remote agent's version.
/// Returns Some(version) if alive, None if unreachable.
async fn health_check_version(host: &str, port: u16, token: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;

    // Try /api/info first (returns version), fall back to /api/health
    let info_url = format!("https://{}:{}/api/info", host, port);
    if let Ok(resp) = client
        .get(&info_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let Some(ver) = body.get("version").and_then(|v| v.as_str()) {
                    return Some(ver.to_string());
                }
            }
        }
    }

    // Fallback: basic health check (agent may be old version without /api/info)
    let health_url = format!("https://{}:{}/api/health", host, port);
    if let Ok(resp) = client
        .get(&health_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        if resp.status().is_success() {
            return Some("unknown".to_string());
        }
    }

    None
}
