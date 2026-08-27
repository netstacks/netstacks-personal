use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

use subtle::ConstantTimeEq;

use crate::api::AppState;
use crate::models::{AuthType, CredentialProfile, PortForward, ProfileCredential, Protocol};
use futures::stream::{SplitSink, SplitStream};
use crate::terminal::{SshJump, SshSessionOptions, SshTarget, TerminalManager, TerminalMessage, TerminalSession};
use crate::guard_probe::{probe_session_facts, ProbeSpec};
use crate::ssh::{SshAuth, SshConfig};
use netstacks_agent::guard::live::{ECHO_TICK, HOLD_TIMEOUT};
use netstacks_agent::guard::{store::append_trace, Action, GuardMode, LiveGuard, Platform, SessionFacts};
use std::sync::Mutex as StdMutex;
use tokio::task::AbortHandle;

/// Combined state for WebSocket handlers
#[derive(Clone)]
pub struct WsState {
    pub terminal_manager: Arc<TerminalManager>,
    pub app_state: Arc<AppState>,
}

/// Per-session Session Guard handle shared by the input and output tasks.
///
/// The engine itself is synchronous and microsecond-fast, so a std mutex
/// is fine — it is never held across an await.
#[derive(Clone)]
pub struct GuardRuntime {
    guard: Arc<StdMutex<LiveGuard>>,
    /// Injects guard notices into the session's output stream so they
    /// reach the client through the same WebSocket writer as PTY output.
    notices: mpsc::UnboundedSender<TerminalMessage>,
    /// How to open the probe login, or why it cannot be opened — in which
    /// case facts stay unknown and the reason reaches the UI (NS-GUARD-11).
    probe: Result<Arc<ProbeSpec>, ProbeSkipped>,
    /// Background work owned by this session, aborted when it closes.
    tasks: Arc<StdMutex<GuardTasks>>,
}

/// Why no probe login can be opened for this session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeSkipped {
    /// v1's probe runner is direct-only.
    JumpHost,
    /// Agent-auth / interactive-only sessions leave nothing to log in with.
    NoCredentials,
    /// A serial line is single-occupant: a second login to the same
    /// terminal-server port would steal or block the user's console.
    Console,
}

impl ProbeSkipped {
    fn detail(self) -> &'static str {
        match self {
            ProbeSkipped::JumpHost => "probe connection not available for jump-host sessions; facts stay unknown",
            ProbeSkipped::NoCredentials => {
                "no stored password or key to open the probe connection with; facts stay unknown"
            }
            ProbeSkipped::Console => "probe connection not opened on console sessions; facts stay unknown",
        }
    }
}

#[derive(Default)]
struct GuardTasks {
    /// The running probe, if any (NS-GUARD-13).
    probe: Option<AbortHandle>,
    /// The echo-settle ticker while an Enter is withheld (NS-GUARD-5).
    ticker: Option<AbortHandle>,
    /// Hold-timeout timers (NS-GUARD-6).
    timers: Vec<AbortHandle>,
}

impl GuardRuntime {
    fn set_facts(&self, facts: SessionFacts) {
        if let Ok(mut g) = self.guard.lock() {
            g.set_facts(facts);
        }
    }

    fn refresh_failed(&self) {
        if let Ok(mut g) = self.guard.lock() {
            g.refresh_failed();
        }
    }

    fn status(&self, state: &str, detail: impl Into<String>) {
        let _ = self.notices.send(TerminalMessage::GuardStatus { state: state.to_string(), detail: detail.into() });
    }

    /// Run the probes in the background and install the facts when done.
    /// A probe still running from an earlier request is abandoned first.
    fn spawn_probe(&self) {
        let spec = match &self.probe {
            Ok(spec) => spec.clone(),
            Err(skip) => {
                self.status("skipped", skip.detail());
                self.refresh_failed();
                return;
            }
        };
        self.status("probing", format!("opening probe connection to {} (second login as {})", spec.config.host, spec.config.username));
        let rt = self.clone();
        let task = tokio::spawn(async move {
            match probe_session_facts(&spec).await {
                Ok(outcome) => {
                    tracing::info!("Session Guard facts for {}: {}", spec.device, outcome.summary);
                    rt.set_facts(outcome.facts);
                    rt.status("ready", outcome.summary.to_string());
                }
                Err(e) => {
                    tracing::warn!("Session Guard probe failed for {}: {}", spec.device, e);
                    rt.refresh_failed();
                    rt.status("failed", e);
                }
            }
        });
        if let Ok(mut t) = self.tasks.lock() {
            if let Some(prev) = t.probe.replace(task.abort_handle()) {
                prev.abort();
            }
        }
    }

    /// Start the echo-settle ticker unless one is already running. It calls
    /// the guard every `ECHO_TICK` until the withheld Enter is resolved.
    fn ensure_ticker(&self, session: Arc<TerminalSession>) {
        let Ok(mut t) = self.tasks.lock() else { return };
        if t.ticker.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let rt = self.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(ECHO_TICK).await;
                let actions = rt.guard.lock().map(|mut g| g.on_await_tick()).unwrap_or_default();
                let waiting = actions.iter().any(|a| matches!(a, Action::AwaitEcho));
                let actions: Vec<Action> = actions.into_iter().filter(|a| !matches!(a, Action::AwaitEcho)).collect();
                apply_guard_actions(Some(&rt), &session, actions).await;
                if !waiting {
                    break;
                }
            }
        });
        t.ticker = Some(task.abort_handle());
    }

    /// Cancel hold `id` if nobody answers it within `HOLD_TIMEOUT`.
    fn arm_hold_timeout(&self, id: String, session: Arc<TerminalSession>) {
        let rt = self.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(HOLD_TIMEOUT).await;
            let actions = rt.guard.lock().map(|mut g| g.on_hold_expired(&id)).unwrap_or_default();
            if !actions.is_empty() {
                tracing::info!("Session Guard hold {} expired with no decision; cancelled", id);
            }
            apply_guard_actions(Some(&rt), &session, actions).await;
        });
        if let Ok(mut t) = self.tasks.lock() {
            t.timers.retain(|h| !h.is_finished());
            t.timers.push(task.abort_handle());
        }
    }

    /// The session is closing: stop every background task it owns.
    fn shutdown(&self) {
        let Ok(mut t) = self.tasks.lock() else { return };
        if let Some(h) = t.probe.take() {
            h.abort();
        }
        if let Some(h) = t.ticker.take() {
            h.abort();
        }
        for h in t.timers.drain(..) {
            h.abort();
        }
    }

    fn on_output(&self, data: &str) -> Vec<Action> {
        self.guard.lock().map(|mut g| g.on_output(data)).unwrap_or_default()
    }

    fn on_input(&self, data: &str) -> Vec<Action> {
        match self.guard.lock() {
            Ok(mut g) => g.on_input(data),
            // A poisoned guard must never eat input: fall back to pass-through.
            Err(_) => vec![Action::Send(data.to_string())],
        }
    }

    fn on_decision(&self, id: &str, proceed: bool) -> Vec<Action> {
        self.guard.lock().map(|mut g| g.on_decision(id, proceed)).unwrap_or_default()
    }
}

/// Build the guard for an SSH session if the client asked for it and the
/// CLI flavor is one the v1 engine understands (IOS-XE only).
fn build_guard_runtime(
    query: &WsQuery,
    params: &SshParams,
    notices: mpsc::UnboundedSender<TerminalMessage>,
    console: bool,
) -> Option<GuardRuntime> {
    let host = params.host.as_str();
    if !matches!(query.guard.as_deref(), Some("1") | Some("true")) {
        return None;
    }
    let platform = match query.guard_flavor.as_deref().unwrap_or("auto") {
        "cisco-ios" => Platform::IosXe,
        // `auto` is every session's default; it says nothing about the
        // device, so it must not put an IOS probe login on it (NS-GUARD-9).
        "auto" => {
            tracing::info!("Session Guard: CLI flavor is 'auto' for {}; guard inactive until the session's flavor is set to Cisco IOS", host);
            let _ = notices.send(TerminalMessage::GuardStatus {
                state: "skipped".to_string(),
                detail: "flavor auto — set CLI flavor to Cisco IOS to enable".to_string(),
            });
            return None;
        }
        other => {
            tracing::info!("Session Guard: CLI flavor '{}' not supported in v1; guard inactive", other);
            let _ = notices.send(TerminalMessage::GuardStatus {
                state: "skipped".to_string(),
                detail: format!("CLI flavor {other} is not supported in v1 (Cisco IOS only)"),
            });
            return None;
        }
    };
    let mode = query.guard_mode.as_deref().and_then(GuardMode::parse).unwrap_or(GuardMode::DryRun);
    let device = query
        .guard_device
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| host.to_string());
    tracing::info!("Session Guard active for {} ({}, {})", device, platform.as_str(), mode.as_str());
    Some(GuardRuntime {
        guard: Arc::new(StdMutex::new(LiveGuard::new(&device, platform, mode))),
        notices,
        probe: if console {
            Err(ProbeSkipped::Console)
        } else {
            probe_spec_for(params, &device).map(Arc::new)
        },
        tasks: Arc::new(StdMutex::new(GuardTasks::default())),
    })
}

/// The probe login reuses the session's own credentials. Jump-host paths
/// are not supported in v1 (`connect_and_authenticate` is direct-only).
fn probe_spec_for(params: &SshParams, device: &str) -> Result<ProbeSpec, ProbeSkipped> {
    if params.jump_host.is_some() {
        return Err(ProbeSkipped::JumpHost);
    }
    let auth = match (&params.password, &params.key_path) {
        (Some(p), _) => SshAuth::Password(p.clone()),
        (None, Some(path)) => SshAuth::KeyFile { path: path.clone(), passphrase: params.key_passphrase.clone() },
        (None, None) => return Err(ProbeSkipped::NoCredentials),
    };
    Ok(ProbeSpec {
        config: SshConfig {
            host: params.host.clone(),
            port: params.port,
            username: params.username.clone(),
            auth,
            legacy_ssh: params.legacy_ssh,
            skip_keyboard_interactive: false,
        },
        device: device.to_string(),
    })
}

/// Optional behaviour layered over the plain terminal loop.
struct SessionOptions {
    /// Commands to send once the first prompt appears.
    auto_commands: Vec<String>,
    /// Session Guard, if the client enabled it for this session.
    guard: Option<GuardRuntime>,
}

/// Execute the guard's actions, in order, against the session.
async fn apply_guard_actions(guard: Option<&GuardRuntime>, session: &Arc<TerminalSession>, actions: Vec<Action>) {
    for action in actions {
        match action {
            Action::Send(data) => {
                if let Err(e) = session.write(&data).await {
                    tracing::error!("Failed to write to PTY: {}", e);
                }
            }
            Action::Hold(n) => {
                if let Some(g) = guard {
                    let _ = g.notices.send(TerminalMessage::GuardHold {
                        id: n.id.clone(),
                        command: n.command,
                        verdict: n.verdict,
                        reason: n.reason,
                        objects: n.objects,
                        block_lines: n.block_lines,
                    });
                    g.arm_hold_timeout(n.id, session.clone());
                }
            }
            Action::HoldExpired(id) => {
                if let Some(g) = guard {
                    g.status("hold-expired", id);
                }
            }
            Action::Trace(record) => match append_trace(&record).await {
                Ok(path) => tracing::info!("Session Guard trace {} appended to {}", record.id, path.display()),
                Err(e) => tracing::warn!("Session Guard: failed to write trace record: {}", e),
            },
            Action::RefreshFacts => {
                if let Some(g) = guard {
                    g.spawn_probe();
                }
            }
            Action::AwaitEcho => {
                if let Some(g) = guard {
                    g.ensure_ticker(session.clone());
                }
            }
        }
    }
}

/// Auto-command prompt heuristic: the last non-blank output ends in a shell
/// or network-device prompt character. A trailing `:` is *not* a prompt —
/// `Password:` and banner lines end that way (NS-TERM-14).
fn looks_like_prompt(output: &str) -> bool {
    let trimmed = output.trim_end();
    trimmed.ends_with('>') || trimmed.ends_with('#') || trimmed.ends_with('$') || trimmed.ends_with('%')
}

/// Keep only the tail of the auto-command output buffer; a chatty login
/// (long banners, `show run` in a startup script) must not grow it without
/// bound. Cuts on a char boundary.
const OUTPUT_BUFFER_CAP: usize = 8 * 1024;

fn cap_output_buffer(buf: &mut String) {
    if buf.len() <= OUTPUT_BUFFER_CAP {
        return;
    }
    let mut cut = buf.len() - OUTPUT_BUFFER_CAP;
    while !buf.is_char_boundary(cut) {
        cut += 1;
    }
    buf.drain(..cut);
}

/// Query parameters for WebSocket connections
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    pub r#type: ConnectionType,
    pub session_id: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub token: Option<String>,
    /// Initial terminal columns (from xterm.js FitAddon)
    #[serde(default)]
    pub cols: u32,
    /// Initial terminal rows (from xterm.js FitAddon)
    #[serde(default)]
    pub rows: u32,
    /// Session Guard: `1`/`true` to activate for this session.
    pub guard: Option<String>,
    /// Session Guard mode: `dry-run` (default) or `enforce`.
    pub guard_mode: Option<String>,
    /// CLI flavor of the saved session (kebab-case, e.g. `cisco-ios`).
    /// The v1 engine only understands IOS-XE; other flavors leave the
    /// guard inactive.
    pub guard_flavor: Option<String>,
    /// Device label for trace records (session name); defaults to host.
    pub guard_device: Option<String>,
}

/// Connection type for WebSocket
#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    #[default]
    Local,
    Ssh,
    Telnet,
    /// OOB console: SSH or Telnet to the terminal-server port stored on the
    /// saved session (`console_*` fields). Requires `session_id`.
    Console,
}

/// Messages from client to server
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum _ClientMessage {
    Input { data: String },
    Resize { cols: u32, rows: u32 },
}

/// Messages from server to client
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    _Output { data: String },
    Connected {
        session_id: Option<String>,
        /// Display name of the jump used for this connection (jump host name
        /// or session name) — `None` for direct connections. Used by the
        /// frontend to render the "via X" pill.
        #[serde(skip_serializing_if = "Option::is_none")]
        via_jump: Option<String>,
        /// `host:port` of the terminal server for OOB console sessions —
        /// `None` for ordinary sessions. Rendered as a "console" pill.
        #[serde(skip_serializing_if = "Option::is_none")]
        via_console: Option<String>,
    },
    _Disconnected { reason: String },
    Error { data: String },
}

/// WebSocket handler for terminal connections
///
/// Validates auth token from query parameter before upgrading.
/// Rejects with 401 if token is missing or invalid.
pub async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    // Validate auth token from query parameter (constant-time compare,
    // matching api.rs auth_middleware to prevent timing-based leaks)
    match &query.token {
        Some(token)
            if token
                .as_bytes()
                .ct_eq(state.app_state.auth_token.as_bytes())
                .into() => {}
        _ => {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
            )
                .into_response();
        }
    }

    ws.on_upgrade(move |socket| async move {
        let initial_cols = query.cols;
        let initial_rows = query.rows;
        match query.r#type {
            ConnectionType::Local => handle_local_terminal(socket, state.terminal_manager, initial_cols, initial_rows).await,
            ConnectionType::Ssh => handle_ssh_terminal(socket, query, state.terminal_manager, state.app_state).await,
            ConnectionType::Telnet => handle_telnet_terminal(socket, query, state.terminal_manager, state.app_state).await,
            ConnectionType::Console => handle_console_terminal(socket, query, state.terminal_manager, state.app_state).await,
        }
    })
    .into_response()
}

/// Handle local terminal connections (PTY)
async fn handle_local_terminal(socket: WebSocket, manager: Arc<TerminalManager>, initial_cols: u32, initial_rows: u32) {
    let (ws_tx, ws_rx) = socket.split();

    // Create channel for PTY output
    let (pty_tx, pty_rx) = mpsc::unbounded_channel::<TerminalMessage>();

    // Create a new local terminal session with initial dimensions from frontend
    let session_id = match manager.create_local_session(pty_tx, initial_cols, initial_rows).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("Failed to create terminal session: {}", e);
            let mut ws_tx = ws_tx;
            let _ = ws_tx
                .send(Message::Text(
                    serde_json::to_string(&TerminalMessage::Error(e.to_string()))
                        .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() }),
                ))
                .await;
            return;
        }
    };

    tracing::info!("Created terminal session: {}", session_id);

    run_terminal_session(ws_tx, ws_rx, pty_rx, &session_id, &manager, "Terminal", None).await;
}

/// Handle SSH terminal connections using PTY-based ssh command
async fn handle_ssh_terminal(socket: WebSocket, query: WsQuery, manager: Arc<TerminalManager>, app_state: Arc<AppState>) {
    let (mut ws_tx, ws_rx) = socket.split();

    // Get SSH credentials from vault if session_id provided
    let ssh_params = match get_ssh_params_with_vault(&query, &app_state).await {
        Ok(params) => params,
        Err(e) => {
            send_ws_error(&mut ws_tx, e).await;
            return;
        }
    };

    run_ssh_terminal(ws_tx, ws_rx, query, manager, app_state, ssh_params, None).await;
}

/// Send a `ServerMessage::Error` to the client (best-effort).
async fn send_ws_error(ws_tx: &mut SplitSink<WebSocket, Message>, data: String) {
    let msg = ServerMessage::Error { data };
    let _ = ws_tx
        .send(Message::Text(serde_json::to_string(&msg)
            .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })))
        .await;
}

/// Delay before the console wake CR (§3.2 of docs/console-access-design.md).
const CONSOLE_WAKE_DELAY_MS: u64 = 300;

/// A serial line shows nothing until it sees input, so nudge it with one CR
/// shortly after the transport is up. Console path only — on a device shell
/// an unsolicited CR would just litter the scrollback.
fn spawn_console_wake(manager: &Arc<TerminalManager>, session_id: &str) {
    let manager = manager.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(CONSOLE_WAKE_DELAY_MS)).await;
        if let Some(session) = manager.get_session(&session_id).await {
            if let Err(e) = session.write("\r").await {
                tracing::debug!("Console wake CR failed for {}: {}", session_id, e);
            }
        }
    });
}

/// Run an interactive SSH terminal with already-resolved parameters.
/// Shared by the SSH path and the OOB console path (`console` set).
async fn run_ssh_terminal(
    mut ws_tx: SplitSink<WebSocket, Message>,
    ws_rx: SplitStream<WebSocket>,
    query: WsQuery,
    manager: Arc<TerminalManager>,
    app_state: Arc<AppState>,
    ssh_params: SshParams,
    // `host:port` of the terminal server when this is an OOB console session
    console_label: Option<String>,
) {
    let host_for_log = ssh_params.host.clone();

    // Create channel for PTY output
    let (pty_tx, pty_rx) = mpsc::unbounded_channel::<TerminalMessage>();

    // Session Guard (opt-in via query). Shares the PTY output channel so
    // hold notices ride the same WebSocket writer as terminal output.
    let guard = build_guard_runtime(&query, &ssh_params, pty_tx.clone(), console_label.is_some());

    // Clone port forwards before passing to create_ssh_session (which moves them)
    let session_port_forwards = ssh_params.port_forwards.clone();

    // Create SSH session with initial dimensions from frontend
    let session_id = match manager.create_ssh_session(
        pty_tx,
        SshTarget {
            host: &ssh_params.host,
            port: ssh_params.port,
            username: &ssh_params.username,
            password: ssh_params.password.as_deref(),
            key_path: ssh_params.key_path.as_deref(),
            key_passphrase: ssh_params.key_passphrase.as_deref(),
            legacy_ssh: ssh_params.legacy_ssh,
        },
        ssh_params.jump_host.as_deref().map(|jump_host| SshJump {
            host: jump_host,
            port: ssh_params.jump_port,
            username: ssh_params.jump_username.as_deref(),
            password: ssh_params.jump_password.as_deref(),
            key_path: ssh_params.jump_key_path.as_deref(),
            key_passphrase: ssh_params.jump_key_passphrase.as_deref(),
            legacy_ssh: ssh_params.jump_legacy_ssh,
        }),
        query.cols,
        query.rows,
        SshSessionOptions {
            // Interactive terminals now go through the same host-key approval
            // flow as the AI exec path: unknown keys prompt, changed keys can
            // be approved instead of hard-refused (NS-TERM-6).
            approvals: Some(app_state.host_key_approvals.clone()),
            keepalive_interval_secs: ssh_params.keepalive_interval,
        },
    ).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("Failed to create SSH session: {}", e);
            let msg = ServerMessage::Error {
                data: format!("SSH connection failed: {}", e),
            };
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&msg)
                    .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })))
                .await;
            return;
        }
    };

    tracing::info!("Created SSH session {} to {}", session_id, host_for_log);

    // The user's login succeeded, so the probe login (same credentials)
    // is worth attempting now.
    if let Some(g) = &guard {
        g.spawn_probe();
    }

    // Stamp last_connected_at on the saved-session row. Best-effort: a DB
    // hiccup mustn't break the connect path, so we spawn and log.
    if let Some(saved_id) = query.session_id.clone() {
        let provider = app_state.provider.clone();
        tokio::spawn(async move {
            if let Err(e) = provider.touch_session(&saved_id).await {
                tracing::warn!("touch_session({}) failed: {}", saved_id, e);
            }
        });
    }

    // Start session port forwards via TunnelManager
    if !session_port_forwards.is_empty() {
        let enabled_forwards: Vec<_> = session_port_forwards.iter()
            .filter(|f| f.enabled)
            .collect();
        if !enabled_forwards.is_empty() {
            tracing::info!("Starting {} session tunnel(s) for {}", enabled_forwards.len(), host_for_log);
            for fwd in enabled_forwards {
                // Inherit the SSH session's resolved jump host so this
                // session-attached tunnel travels the same path (and shares
                // the pooled SSH connection where possible).
                let tunnel = crate::models::Tunnel {
                    id: format!("session:{}:{}", session_id, fwd.id),
                    name: format!("Session forward :{}", fwd.local_port),
                    host: ssh_params.host.clone(),
                    port: ssh_params.port,
                    profile_id: ssh_params.profile_id.clone(),
                    // Inherit BOTH kinds of jump from the parent SSH session
                    // (mutually exclusive — at most one is Some).
                    jump_host_id: ssh_params.jump_host_id_effective.clone(),
                    jump_session_id: ssh_params.jump_session_id_effective.clone(),
                    forward_type: fwd.forward_type.clone(),
                    local_port: fwd.local_port,
                    bind_address: fwd.bind_address.clone().unwrap_or_else(|| "127.0.0.1".to_string()),
                    remote_host: fwd.remote_host.clone(),
                    remote_port: fwd.remote_port,
                    auto_start: false,
                    auto_reconnect: false,
                    max_retries: 0,
                    enabled: true,
                    created_at: String::new(),
                    updated_at: String::new(),
                };
                if let Err(e) = app_state.tunnel_manager.start_tunnel(&tunnel).await {
                    tracing::warn!("Failed to start session tunnel :{}: {}", fwd.local_port, e);
                }
            }
        }
    }

    // Send connected message — includes the resolved jump display name so
    // the terminal can render a "via X" pill when applicable.
    let connected_msg = ServerMessage::Connected {
        session_id: query.session_id.clone(),
        via_jump: ssh_params.jump_display_name.clone(),
        via_console: console_label.clone(),
    };
    if ws_tx
        .send(Message::Text(serde_json::to_string(&connected_msg)
            .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })))
        .await
        .is_err()
    {
        return;
    }

    if console_label.is_some() {
        spawn_console_wake(&manager, &session_id);
    }

    let log_label = match &console_label {
        Some(label) => format!("Console session via {}", label),
        None => format!("SSH session to {}", host_for_log),
    };

    // Execute auto commands if configured (Phase: auto commands on connect)
    // We need to wait for the shell to be ready before sending commands
    if !ssh_params.auto_commands.is_empty() {
        run_terminal_session_with_auto_commands(
            ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label,
            SessionOptions { auto_commands: ssh_params.auto_commands, guard },
        ).await;
    } else {
        run_terminal_session(ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label, guard).await;
    }

    // Stop session tunnels on disconnect
    let session_prefix = format!("session:{}:", session_id);
    let active_states = app_state.tunnel_manager.get_all_states().await;
    for state in active_states {
        if state.id.starts_with(&session_prefix) {
            let _ = app_state.tunnel_manager.stop_tunnel(&state.id).await;
        }
    }
}

/// Shared terminal session message loop.
/// Handles forwarding PTY output to WebSocket and processing incoming messages.
async fn run_terminal_session<S>(
    ws_tx: futures::stream::SplitSink<WebSocket, Message>,
    mut ws_rx: S,
    mut pty_rx: mpsc::UnboundedReceiver<TerminalMessage>,
    session_id: &str,
    manager: &Arc<TerminalManager>,
    log_label: &str,
    guard: Option<GuardRuntime>,
)
where
    S: futures::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let session_id_for_output = session_id.to_string();
    let session_id_owned = session_id.to_string();
    let log_label_owned = log_label.to_string();
    let manager_for_cleanup = manager.clone();
    let manager_for_input = manager.clone();
    let manager_for_output = manager.clone();
    let guard_for_output = guard.clone();

    // Task to forward PTY output to WebSocket
    let mut output_task = tokio::spawn(async move {
        let mut ws_tx = ws_tx;
        while let Some(msg) = pty_rx.recv().await {
            if let (Some(g), TerminalMessage::Output(data)) = (&guard_for_output, &msg) {
                // Echo arriving may release a withheld Enter.
                let actions = g.on_output(data);
                if !actions.is_empty() {
                    if let Some(session) = manager_for_output.get_session(&session_id_for_output).await {
                        apply_guard_actions(Some(g), &session, actions).await;
                    }
                }
            }
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    tracing::error!("Failed to serialize message: {}", e);
                    continue;
                }
            };

            if ws_tx.send(Message::Text(json)).await.is_err() {
                tracing::info!("WebSocket closed for {}", session_id_for_output);
                break;
            }
        }
    });

    // Tear the socket down when the transport ends (device closed the session,
    // exec-timeout, shell exit). Without this the loop waited for the *client*
    // to close and the tab stayed "connected" while every keystroke failed
    // (NS-TERM-5).
    let close_token = manager.get_session(session_id).await.map(|s| s.close_token());

    // Handle incoming WebSocket messages
    loop {
        let msg = tokio::select! {
            _ = async {
                match &close_token {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                tracing::info!("Transport closed for {}; closing WebSocket", session_id);
                break;
            }
            next = ws_rx.next() => match next {
                Some(Ok(m)) => m,
                _ => break,
            },
        };
        match msg {
            Message::Text(text) => {
                let terminal_msg: TerminalMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Invalid message: {}", e);
                        continue;
                    }
                };

                match terminal_msg {
                    TerminalMessage::Input(data) => {
                        let actions = match &guard {
                            Some(g) => g.on_input(&data),
                            None => vec![Action::Send(data)],
                        };
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            apply_guard_actions(guard.as_ref(), &session, actions).await;
                        }
                    }
                    TerminalMessage::GuardDecision { id, proceed } => {
                        if let Some(g) = &guard {
                            let actions = g.on_decision(&id, proceed);
                            if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                                apply_guard_actions(Some(g), &session, actions).await;
                            }
                        }
                    }
                    TerminalMessage::Resize { cols, rows } => {
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            if let Err(e) = session.resize(cols as u32, rows as u32).await {
                                tracing::warn!("Failed to resize PTY: {}", e);
                            } else {
                                tracing::trace!("Resized PTY to {}x{}", cols, rows);
                            }
                        }
                    }
                    TerminalMessage::Close => {
                        break;
                    }
                    _ => {}
                }
            }
            Message::Binary(_) | Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // Cleanup
    // If the transport died (close_token fired) give the output task a moment to
    // flush the reader's final `Close`/`Error` frame to the client before
    // aborting it — the guard holds a `pty_tx` clone, so the channel never
    // drains on its own.
    if close_token.as_ref().is_some_and(|t| t.is_cancelled()) {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(250), &mut output_task).await;
    }
    output_task.abort();
    if let Some(g) = &guard {
        g.shutdown();
    }
    manager_for_cleanup.remove_session(&session_id_owned).await;
    tracing::info!("{} {} closed", log_label_owned, session_id_owned);
}

/// Terminal session with auto commands execution.
/// Waits for shell prompt before sending configured commands.
async fn run_terminal_session_with_auto_commands<S>(
    ws_tx: futures::stream::SplitSink<WebSocket, Message>,
    mut ws_rx: S,
    mut pty_rx: mpsc::UnboundedReceiver<TerminalMessage>,
    session_id: &str,
    manager: &Arc<TerminalManager>,
    log_label: &str,
    opts: SessionOptions,
)
where
    S: futures::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let SessionOptions { auto_commands, guard } = opts;
    let session_id_for_output = session_id.to_string();
    let session_id_owned = session_id.to_string();
    let log_label_owned = log_label.to_string();
    let manager_for_cleanup = manager.clone();
    let manager_for_input = manager.clone();
    let guard_for_output = guard.clone();
    let manager_for_auto = manager.clone();
    let session_id_for_auto = session_id.to_string();

    // Channel to signal when auto commands are done
    let (auto_done_tx, _auto_done_rx) = tokio::sync::oneshot::channel::<()>();

    // Task to forward PTY output to WebSocket and detect prompt for auto commands
    let mut output_task = tokio::spawn(async move {
        let mut ws_tx = ws_tx;
        let mut output_buffer = String::new();
        let mut auto_commands_sent = false;
        let mut auto_done_tx = Some(auto_done_tx);
        let commands_to_send = auto_commands;
        let mut current_command_idx = 0;

        while let Some(msg) = pty_rx.recv().await {
            if let (Some(g), TerminalMessage::Output(data)) = (&guard_for_output, &msg) {
                // Echo arriving may release a withheld Enter.
                let actions = g.on_output(data);
                if !actions.is_empty() {
                    if let Some(session) = manager_for_auto.get_session(&session_id_for_auto).await {
                        apply_guard_actions(Some(g), &session, actions).await;
                    }
                }
            }
            // Forward to WebSocket
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    tracing::error!("Failed to serialize message: {}", e);
                    continue;
                }
            };

            if ws_tx.send(Message::Text(json)).await.is_err() {
                tracing::info!("WebSocket closed for {}", session_id_for_output);
                break;
            }

            // Check for prompt if we haven't sent all auto commands yet
            if current_command_idx < commands_to_send.len() {
                if let TerminalMessage::Output(data) = &msg {
                    output_buffer.push_str(data);
                    cap_output_buffer(&mut output_buffer);

                    // Check if output ends with a prompt character
                    // Common prompts: hostname>, hostname#, user$, user%
                    if looks_like_prompt(&output_buffer) {
                        // Send the next auto command
                        if let Some(session) = manager_for_auto.get_session(&session_id_for_auto).await {
                            let cmd = &commands_to_send[current_command_idx];
                            tracing::debug!("Executing auto command {}: {}", current_command_idx + 1, cmd);
                            if let Err(e) = session.write(&format!("{}\n", cmd)).await {
                                tracing::warn!("Failed to execute auto command '{}': {}", cmd, e);
                            }
                            current_command_idx += 1;
                            output_buffer.clear();
                        }
                    }
                }
            } else if !auto_commands_sent {
                // All commands sent, signal completion
                auto_commands_sent = true;
                if let Some(tx) = auto_done_tx.take() {
                    let _ = tx.send(());
                }
            }
        }
    });

    // Tear the socket down when the transport ends (device closed the session,
    // exec-timeout, shell exit). Without this the loop waited for the *client*
    // to close and the tab stayed "connected" while every keystroke failed
    // (NS-TERM-5).
    let close_token = manager.get_session(session_id).await.map(|s| s.close_token());

    // Handle incoming WebSocket messages
    loop {
        let msg = tokio::select! {
            _ = async {
                match &close_token {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                tracing::info!("Transport closed for {}; closing WebSocket", session_id);
                break;
            }
            next = ws_rx.next() => match next {
                Some(Ok(m)) => m,
                _ => break,
            },
        };
        match msg {
            Message::Text(text) => {
                let terminal_msg: TerminalMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Invalid message: {}", e);
                        continue;
                    }
                };

                match terminal_msg {
                    TerminalMessage::Input(data) => {
                        let actions = match &guard {
                            Some(g) => g.on_input(&data),
                            None => vec![Action::Send(data)],
                        };
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            apply_guard_actions(guard.as_ref(), &session, actions).await;
                        }
                    }
                    TerminalMessage::GuardDecision { id, proceed } => {
                        if let Some(g) = &guard {
                            let actions = g.on_decision(&id, proceed);
                            if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                                apply_guard_actions(Some(g), &session, actions).await;
                            }
                        }
                    }
                    TerminalMessage::Resize { cols, rows } => {
                        if let Some(session) = manager_for_input.get_session(&session_id_owned).await {
                            if let Err(e) = session.resize(cols as u32, rows as u32).await {
                                tracing::warn!("Failed to resize PTY: {}", e);
                            } else {
                                tracing::trace!("Resized PTY to {}x{}", cols, rows);
                            }
                        }
                    }
                    TerminalMessage::Close => {
                        break;
                    }
                    _ => {}
                }
            }
            Message::Binary(_) | Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // Cleanup
    // If the transport died (close_token fired) give the output task a moment to
    // flush the reader's final `Close`/`Error` frame to the client before
    // aborting it — the guard holds a `pty_tx` clone, so the channel never
    // drains on its own.
    if close_token.as_ref().is_some_and(|t| t.is_cancelled()) {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(250), &mut output_task).await;
    }
    output_task.abort();
    if let Some(g) = &guard {
        g.shutdown();
    }
    manager_for_cleanup.remove_session(&session_id_owned).await;
    tracing::info!("{} {} closed", log_label_owned, session_id_owned);
}

/// SSH parameters for PTY-based connection
struct SshParams {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
    // Effective jump (session override or profile default). Exactly one of
    // jump_host_id_effective / jump_session_id_effective is Some when a
    // jump was resolved; both None for direct connections.
    jump_host_id_effective: Option<String>,
    jump_session_id_effective: Option<String>,
    /// Display name of the resolved jump (jump host name or session name)
    /// — sent to the frontend so the terminal can render a "via X" pill.
    jump_display_name: Option<String>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_username: Option<String>,
    jump_password: Option<String>,
    jump_key_path: Option<String>,
    jump_key_passphrase: Option<String>,
    jump_legacy_ssh: bool,
    // Port forwarding (Phase 06.3)
    port_forwards: Vec<PortForward>,
    // Profile ID for tunnel credential lookup
    profile_id: String,
    // Auto commands on connect
    auto_commands: Vec<String>,
    // Legacy SSH support for older devices
    legacy_ssh: bool,
    /// Profile `keepalive_interval` (seconds); 0 disables SSH keepalives.
    keepalive_interval: u32,
}

impl SshParams {
    /// Target + login + jump hop from a resolved profile. Per-session extras
    /// (`port_forwards`, `auto_commands`, `legacy_ssh`) start empty/off and
    /// are set by the caller.
    fn from_profile(
        host: String,
        port: u16,
        profile: &CredentialProfile,
        profile_id: String,
        auth: ProfileSshAuth,
        jump: JumpFields,
    ) -> Self {
        SshParams {
            host,
            port,
            username: profile.username.clone(),
            password: auth.password,
            key_path: auth.key_path,
            key_passphrase: auth.key_passphrase,
            jump_host_id_effective: jump.host_id_effective,
            jump_session_id_effective: jump.session_id_effective,
            jump_display_name: jump.display_name,
            jump_host: jump.host,
            jump_port: jump.port,
            jump_username: jump.username,
            jump_password: jump.password,
            jump_key_path: jump.key_path,
            jump_key_passphrase: jump.key_passphrase,
            jump_legacy_ssh: jump.legacy_ssh,
            port_forwards: Vec::new(),
            profile_id,
            auto_commands: Vec::new(),
            legacy_ssh: false,
            keepalive_interval: profile.keepalive_interval,
        }
    }
}

/// Get SSH parameters with vault credential lookup
///
/// If session_id is provided and no password/key is in query params,
/// tries to look up the session details and credentials from the vault.
/// Falls back to query params if vault lookup fails or params are provided.
async fn get_ssh_params_with_vault(query: &WsQuery, app_state: &Arc<AppState>) -> Result<SshParams, String> {
    // If session_id provided and no explicit credentials in query, try vault lookup
    if let Some(session_id) = &query.session_id {
        // Only do vault lookup if credentials not provided via query params
        if query.password.is_none() && query.key_path.is_none() {
            // Try to get session details from database
            match app_state.provider.get_session(session_id).await {
                Ok(session) => {
                    tracing::debug!("Found session {} in database", session_id);

                    // All sessions now require a profile for credentials
                    let profile_id = &session.profile_id;
                    tracing::debug!("Looking up profile for profile_id={}", profile_id);

                    let (profile, credential) = load_profile_and_credential(profile_id, app_state).await?;
                    let auth = ssh_auth_from_profile(&profile, credential.as_ref(), query)?;

                    let auto_commands = if session.auto_commands.is_empty() {
                        profile.auto_commands.clone()
                    } else {
                        session.auto_commands.clone()
                    };

                    // Resolve effective jump (session override > profile default).
                    // Each level can be a JumpHost or a Session; mutual exclusion is
                    // enforced at write time (T1).
                    let session_level = JumpRef::from_pair(
                        session.jump_host_id.as_deref(),
                        session.jump_session_id.as_deref(),
                    );
                    let profile_level = JumpRef::from_pair(
                        profile.jump_host_id.as_deref(),
                        profile.jump_session_id.as_deref(),
                    );
                    let jump = resolve_jump_fields(session_level, profile_level, app_state).await?;

                    let mut params = SshParams::from_profile(session.host, session.port, &profile, session.profile_id, auth, jump);
                    params.port_forwards = session.port_forwards;
                    params.auto_commands = auto_commands;
                    params.legacy_ssh = session.legacy_ssh;
                    return Ok(params);
                }
                Err(e) => {
                    // If a session_id was provided but not found, return error
                    // (don't fall through to query params - that would give confusing errors)
                    return Err(format!("Session '{}' not found: {}", session_id, e));
                }
            }
        }
    }

    // Fallback: build params from query params (for quick connect without saved session)
    // This only runs if session_id was NOT provided
    get_ssh_params(query)
}

/// Load a credential profile and its vault secret. A locked vault is a
/// user-facing error; a missing secret is not (key auth may need none).
async fn load_profile_and_credential(
    profile_id: &str,
    app_state: &Arc<AppState>,
) -> Result<(CredentialProfile, Option<ProfileCredential>), String> {
    let profile = app_state
        .provider
        .get_profile(profile_id)
        .await
        .map_err(|e| format!("Failed to get profile: {}", e))?;

    let credential = match app_state.provider.get_profile_credential(profile_id).await {
        Ok(Some(pc)) => {
            tracing::debug!("Found profile credential, has_password={}", pc.password.is_some());
            Some(pc)
        }
        Ok(None) => {
            tracing::debug!("No profile credential found");
            None
        }
        Err(crate::providers::ProviderError::VaultLocked) => {
            return Err("Vault is locked. Go to Settings > Security to unlock.".to_string());
        }
        Err(e) => {
            tracing::warn!("Failed to get profile credential: {}", e);
            None
        }
    };

    Ok((profile, credential))
}

/// SSH auth material derived from a profile + vault secret, with the
/// quick-connect query params as a fallback source.
struct ProfileSshAuth {
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
}

fn ssh_auth_from_profile(
    profile: &CredentialProfile,
    credential: Option<&ProfileCredential>,
    query: &WsQuery,
) -> Result<ProfileSshAuth, String> {
    match profile.auth_type {
        AuthType::Password => {
            let password = credential
                .and_then(|c| c.password.clone())
                .or_else(|| query.password.clone());

            if password.is_none() {
                return Err("No password stored. Edit profile to add password, then unlock vault in Settings > Security.".to_string());
            }
            Ok(ProfileSshAuth { password, key_path: None, key_passphrase: None })
        }
        AuthType::Key => {
            let key_path = profile.key_path.clone()
                .or_else(|| query.key_path.clone());

            if key_path.is_none() {
                return Err("No key path found in profile or query params".to_string());
            }
            let key_passphrase = credential.and_then(|c| c.key_passphrase.clone());
            Ok(ProfileSshAuth { password: None, key_path, key_passphrase })
        }
    }
}

/// Resolved jump-hop parameters for `SshParams`; all `None` / `false` for
/// a direct connection.
#[derive(Default)]
struct JumpFields {
    host_id_effective: Option<String>,
    session_id_effective: Option<String>,
    display_name: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
    legacy_ssh: bool,
}

async fn resolve_jump_fields(
    session_level: JumpRef,
    profile_level: JumpRef,
    app_state: &Arc<AppState>,
) -> Result<JumpFields, String> {
    let Some(r) = resolve_effective_jump(session_level, profile_level, &app_state.provider).await? else {
        return Ok(JumpFields::default());
    };
    let (password, key_path, key_passphrase) = match r.profile.auth_type {
        AuthType::Password => (
            r.credential.as_ref().and_then(|c| c.password.clone()),
            None, None,
        ),
        AuthType::Key => (
            None,
            r.profile.key_path.clone(),
            r.credential.as_ref().and_then(|c| c.key_passphrase.clone()),
        ),
    };
    let (host_id_effective, session_id_effective) = match &r.source {
        JumpSource::JumpHost { id, .. } => (Some(id.clone()), None),
        JumpSource::Session { id, .. } => (None, Some(id.clone())),
    };
    Ok(JumpFields {
        host_id_effective,
        session_id_effective,
        display_name: Some(r.source.display_name().to_string()),
        host: Some(r.host.clone()),
        port: Some(r.port),
        username: Some(r.profile.username.clone()),
        password,
        key_path,
        key_passphrase,
        legacy_ssh: false, // no profile field for it yet
    })
}

/// Where the jump came from — flavors error messages and lets the UI
/// render "via {name}" with the right source.
#[derive(Debug, Clone)]
pub enum JumpSource {
    JumpHost { id: String, name: String },
    Session { id: String, name: String },
}

impl JumpSource {
    /// Display name for log lines and the terminal "via X" pill.
    pub fn display_name(&self) -> &str {
        match self {
            Self::JumpHost { name, .. } => name,
            Self::Session { name, .. } => name,
        }
    }

    /// Source id (used for tunnel-pool keying and inheritance, plus tests).
    #[cfg(test)]
    pub fn id(&self) -> &str {
        match self {
            Self::JumpHost { id, .. } => id,
            Self::Session { id, .. } => id,
        }
    }
}

/// Input to `resolve_effective_jump`: either nothing, a JumpHost id, or
/// a Session id. The two kinds are mutually exclusive at the data layer
/// (T1 enforces it), so a single enum captures the option.
#[derive(Debug, Clone)]
pub enum JumpRef {
    None,
    JumpHost(String),
    Session(String),
}

impl JumpRef {
    pub fn from_pair(jump_host_id: Option<&str>, jump_session_id: Option<&str>) -> Self {
        match (jump_host_id, jump_session_id) {
            (Some(id), _) => Self::JumpHost(id.to_string()),
            (None, Some(id)) => Self::Session(id.to_string()),
            (None, None) => Self::None,
        }
    }

    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }
}

/// Fully-resolved jump context for one connection. Source-agnostic — the
/// downstream SSH layer doesn't care whether the jump came from a JumpHost
/// record or a Session.
#[derive(Debug, Clone)]
pub struct JumpResolution {
    pub source: JumpSource,
    pub host: String,
    pub port: u16,
    pub profile: crate::models::CredentialProfile,
    pub credential: Option<crate::models::ProfileCredential>,
}

/// Resolve the effective jump for a connection. Session-level wins over
/// profile-level when not `None`. Returns Ok(None) for direct connections.
pub async fn resolve_effective_jump(
    session_level: JumpRef,
    profile_level: JumpRef,
    provider: &Arc<dyn crate::providers::DataProvider>,
) -> Result<Option<JumpResolution>, String> {
    let chosen = if !session_level.is_none() { session_level } else { profile_level };

    match chosen {
        JumpRef::None => Ok(None),
        JumpRef::JumpHost(id) => resolve_jump_host(&id, provider).await.map(Some),
        JumpRef::Session(id) => resolve_session_as_jump(&id, provider).await.map(Some),
    }
}

async fn resolve_jump_host(
    id: &str,
    provider: &Arc<dyn crate::providers::DataProvider>,
) -> Result<JumpResolution, String> {
    let jump_host = provider.get_jump_host(id).await
        .map_err(|e| format!(
            "Jump host '{}' referenced by session/profile no longer exists. \
             Edit the session or profile to fix. (Underlying error: {})",
            id, e
        ))?;

    let profile = provider.get_profile(&jump_host.profile_id).await
        .map_err(|e| format!(
            "Failed to load auth profile '{}' for jump host '{}': {}",
            jump_host.profile_id, jump_host.name, e
        ))?;

    let credential = load_jump_credential(provider, &jump_host.profile_id, &jump_host.name).await?;

    Ok(JumpResolution {
        source: JumpSource::JumpHost { id: jump_host.id.clone(), name: jump_host.name.clone() },
        host: jump_host.host,
        port: jump_host.port,
        profile,
        credential,
    })
}

async fn resolve_session_as_jump(
    id: &str,
    provider: &Arc<dyn crate::providers::DataProvider>,
) -> Result<JumpResolution, String> {
    let jump_session = provider.get_session(id).await
        .map_err(|e| format!(
            "Session '{}' selected as a jump no longer exists. \
             Edit the dependent session/tunnel/profile to fix. (Underlying error: {})",
            id, e
        ))?;

    let profile = provider.get_profile(&jump_session.profile_id).await
        .map_err(|e| format!(
            "Failed to load auth profile for session '{}' (used as jump): {}",
            jump_session.name, e
        ))?;

    let credential = load_jump_credential(provider, &jump_session.profile_id, &jump_session.name).await?;

    Ok(JumpResolution {
        source: JumpSource::Session { id: jump_session.id, name: jump_session.name.clone() },
        host: jump_session.host,
        port: jump_session.port,
        profile,
        credential,
    })
}

async fn load_jump_credential(
    provider: &Arc<dyn crate::providers::DataProvider>,
    profile_id: &str,
    display_name: &str,
) -> Result<Option<crate::models::ProfileCredential>, String> {
    match provider.get_profile_credential(profile_id).await {
        Ok(opt) => Ok(opt),
        Err(crate::providers::ProviderError::VaultLocked) => Err(format!(
            "Vault is locked — cannot read credentials for jump '{}'. \
             Unlock in Settings > Security.",
            display_name
        )),
        Err(e) => Err(format!(
            "Failed to read credentials for jump '{}': {}",
            display_name, e
        )),
    }
}

/// Get SSH parameters from query
fn get_ssh_params(query: &WsQuery) -> Result<SshParams, String> {
    let host = query
        .host
        .clone()
        .ok_or_else(|| "Missing required parameter: host".to_string())?;

    let username = query
        .username
        .clone()
        .ok_or_else(|| "Missing required parameter: username".to_string())?;

    let (password, key_path) = if query.password.is_some() {
        (query.password.clone(), None)
    } else if query.key_path.is_some() {
        (None, query.key_path.clone())
    } else {
        return Err("Missing required parameter: password or key_path".to_string());
    };

    Ok(SshParams {
        host,
        port: query.port.unwrap_or(22),
        username,
        password,
        key_path,
        key_passphrase: None,
        // Jump host / proxy not supported in quick connect (only stored sessions)
        jump_host_id_effective: None,
        jump_session_id_effective: None,
        jump_display_name: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        jump_password: None,
        jump_key_path: None,
        jump_key_passphrase: None,
        jump_legacy_ssh: false,
        // Port forwarding not supported in quick connect (only stored sessions)
        port_forwards: vec![],
        profile_id: String::new(),
        // Auto commands not supported in quick connect (only stored sessions)
        auto_commands: vec![],
        // Legacy SSH not supported in quick connect (only stored sessions)
        legacy_ssh: false,
        keepalive_interval: 30,
    })
}

// === Telnet Terminal ===

/// Telnet connection parameters
struct TelnetParams {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    auto_commands: Vec<String>,
}

/// Get Telnet parameters with vault credential lookup
async fn get_telnet_params_with_vault(
    query: &WsQuery,
    app_state: &Arc<AppState>,
) -> Result<TelnetParams, String> {
    if let Some(session_id) = &query.session_id {
        let provider = &app_state.provider;

        let session = provider
            .get_session(session_id)
            .await
            .map_err(|e| format!("Failed to get session: {}", e))?;

        let (profile, credential) = load_profile_and_credential(&session.profile_id, app_state).await?;
        let password = credential.and_then(|c| c.password);

        let auto_commands = if session.auto_commands.is_empty() {
            profile.auto_commands.clone()
        } else {
            session.auto_commands.clone()
        };

        Ok(TelnetParams {
            host: session.host,
            port: session.port,
            username: Some(profile.username),
            password,
            auto_commands,
        })
    } else {
        Err("Telnet requires a session_id".to_string())
    }
}

/// Handle Telnet terminal connections
async fn handle_telnet_terminal(
    socket: WebSocket,
    query: WsQuery,
    manager: Arc<TerminalManager>,
    app_state: Arc<AppState>,
) {
    let (mut ws_tx, ws_rx) = socket.split();

    let telnet_params = match get_telnet_params_with_vault(&query, &app_state).await {
        Ok(params) => params,
        Err(e) => {
            send_ws_error(&mut ws_tx, format!("Failed to get Telnet params: {}", e)).await;
            return;
        }
    };

    run_telnet_terminal(ws_tx, ws_rx, query, manager, app_state, telnet_params, None).await;
}

/// Run an interactive Telnet terminal with already-resolved parameters.
/// Shared by the Telnet path and the OOB console path (`console` set).
async fn run_telnet_terminal(
    mut ws_tx: SplitSink<WebSocket, Message>,
    ws_rx: SplitStream<WebSocket>,
    query: WsQuery,
    manager: Arc<TerminalManager>,
    app_state: Arc<AppState>,
    telnet_params: TelnetParams,
    // `host:port` of the terminal server when this is an OOB console session
    console_label: Option<String>,
) {
    let host_for_log = telnet_params.host.clone();

    let (pty_tx, pty_rx) = mpsc::unbounded_channel();

    let session_id = match manager
        .create_telnet_session(
            pty_tx,
            telnet_params.host.clone(),
            telnet_params.port,
            telnet_params.username,
            telnet_params.password,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            let msg = ServerMessage::Error {
                data: format!("Telnet connection failed: {}", e),
            };
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&msg)
                    .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })))
                .await;
            return;
        }
    };

    tracing::info!("Created Telnet session {} to {}", session_id, host_for_log);

    // Stamp last_connected_at on the saved-session row. Best-effort.
    if let Some(saved_id) = query.session_id.clone() {
        let provider = app_state.provider.clone();
        tokio::spawn(async move {
            if let Err(e) = provider.touch_session(&saved_id).await {
                tracing::warn!("touch_session({}) failed: {}", saved_id, e);
            }
        });
    }

    // Send connected message (telnet has no jump concept).
    let connected_msg = ServerMessage::Connected {
        session_id: query.session_id.clone(),
        via_jump: None,
        via_console: console_label.clone(),
    };
    if ws_tx
        .send(Message::Text(serde_json::to_string(&connected_msg)
            .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })))
        .await
        .is_err()
    {
        return;
    }

    if console_label.is_some() {
        spawn_console_wake(&manager, &session_id);
    }

    let log_label = match &console_label {
        Some(label) => format!("Console session via {}", label),
        None => format!("Telnet session to {}", host_for_log),
    };

    if !telnet_params.auto_commands.is_empty() {
        run_terminal_session_with_auto_commands(
            ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label,
            SessionOptions { auto_commands: telnet_params.auto_commands, guard: None },
        ).await;
    } else {
        run_terminal_session(ws_tx, ws_rx, pty_rx, &session_id, &manager, &log_label, None).await;
    }
}

// === OOB console ===

/// Resolved parameters for an OOB console connection.
enum ConsoleParams {
    /// Boxed: `SshParams` is ~400 bytes vs ~100 for telnet (clippy::large_enum_variant).
    Ssh(Box<SshParams>),
    Telnet(TelnetParams),
}

const NO_CONSOLE_CONFIGURED: &str = "No console access configured for this session";

/// Handle OOB console connections: SSH or Telnet to the terminal-server
/// port stored on the saved session. The resulting shell *is* the device's
/// serial console, so no second hop is involved.
async fn handle_console_terminal(
    socket: WebSocket,
    query: WsQuery,
    manager: Arc<TerminalManager>,
    app_state: Arc<AppState>,
) {
    let (mut ws_tx, ws_rx) = socket.split();

    match get_console_params(&query, &app_state).await {
        Ok((ConsoleParams::Ssh(params), label)) => {
            run_ssh_terminal(ws_tx, ws_rx, query, manager, app_state, *params, Some(label)).await
        }
        Ok((ConsoleParams::Telnet(params), label)) => {
            run_telnet_terminal(ws_tx, ws_rx, query, manager, app_state, params, Some(label)).await
        }
        Err(e) => send_ws_error(&mut ws_tx, e).await,
    }
}

/// Build console parameters from the saved session's `console_*` fields;
/// returns them with the `host:port` label of the terminal server.
///
/// The session's own `auto_commands` and port forwards are deliberately not
/// applied: they assume the device prompt, but a console may be sitting at a
/// login prompt, in ROMMON, or on a half-typed line from the last person.
async fn get_console_params(
    query: &WsQuery,
    app_state: &Arc<AppState>,
) -> Result<(ConsoleParams, String), String> {
    let session_id = query
        .session_id
        .as_deref()
        .ok_or_else(|| "Console access requires a saved session".to_string())?;
    let session = app_state
        .provider
        .get_session(session_id)
        .await
        .map_err(|e| format!("Session '{}' not found: {}", session_id, e))?;

    let host = session
        .console_host
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty());
    let (host, port) = match (host, session.console_port) {
        (Some(h), Some(p)) if p > 0 => (h.to_string(), p),
        _ => return Err(NO_CONSOLE_CONFIGURED.to_string()),
    };
    let label = format!("{}:{}", host, port);

    match session.console_protocol {
        Protocol::Ssh => {
            let profile_id = session.console_profile_id.clone().ok_or_else(|| {
                "Console access over SSH needs a credential profile for the terminal server login. Edit the session's Console settings.".to_string()
            })?;
            let (profile, credential) = load_profile_and_credential(&profile_id, app_state).await?;
            let auth = ssh_auth_from_profile(&profile, credential.as_ref(), query)?;
            // Only the console profile's jump default applies — the OOB
            // network is reached independently of the device's own path.
            let profile_level = JumpRef::from_pair(
                profile.jump_host_id.as_deref(),
                profile.jump_session_id.as_deref(),
            );
            let jump = resolve_jump_fields(JumpRef::None, profile_level, app_state).await?;

            let mut params = SshParams::from_profile(host, port, &profile, profile_id, auth, jump);
            params.legacy_ssh = session.console_legacy_ssh;
            Ok((ConsoleParams::Ssh(Box::new(params)), label))
        }
        Protocol::Telnet => {
            // A reverse-telnet line may have no login at all; the profile
            // is optional and, when present, only supplies username/password.
            let (username, password) = match session.console_profile_id.as_deref() {
                Some(pid) => {
                    let (profile, credential) = load_profile_and_credential(pid, app_state).await?;
                    (Some(profile.username), credential.and_then(|c| c.password))
                }
                None => (None, None),
            };
            Ok((
                ConsoleParams::Telnet(TelnetParams {
                    host,
                    port,
                    username,
                    password,
                    auto_commands: Vec::new(),
                }),
                label,
            ))
        }
    }
}

// === Topology Live SNMP WebSocket ===

/// Query parameters for topology live WebSocket
#[derive(Debug, Deserialize)]
pub struct TopologyWsQuery {
    pub token: Option<String>,
}

/// Client → Server: subscribe to SNMP polling targets
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum TopologyClientMessage {
    Subscribe {
        targets: Vec<TopologyTarget>,
        #[serde(default = "default_interval")]
        #[serde(rename = "intervalSecs")]
        interval_secs: u64,
    },
    Unsubscribe,
}

fn default_interval() -> u64 {
    30
}

/// A single device target with interfaces to poll
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TopologyTarget {
    host: String,
    profile_id: String,
    interfaces: Vec<String>,
}

/// Server → Client: stats update for a host
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyStatsMessage {
    r#type: &'static str,
    host: String,
    timestamp: String,
    interfaces: Vec<TopologyInterfaceStats>,
}

/// Single interface stats in topology live response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyInterfaceStats {
    if_descr: String,
    if_alias: String,
    oper_status: u8,
    oper_status_text: String,
    speed_mbps: u64,
    in_octets: u64,
    out_octets: u64,
    in_errors: u64,
    out_errors: u64,
    in_discards: u64,
    out_discards: u64,
    hc_counters: bool,
}

/// Per-interface summary included in device_stats message
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInterfaceInfo {
    if_descr: String,
    if_alias: String,
    oper_status: u8,
    admin_status: u8,
    speed_mbps: u64,
    in_octets: u64,
    out_octets: u64,
    in_errors: u64,
    out_errors: u64,
}

/// Server → Client: device-level stats (system info + interface summary + resources)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyDeviceStatsMessage {
    r#type: &'static str,
    host: String,
    timestamp: String,
    sys_uptime_seconds: Option<f64>,
    sys_descr: Option<String>,
    interface_summary: InterfaceSummary,
    cpu_percent: Option<f64>,
    memory_percent: Option<f64>,
    memory_used_mb: Option<f64>,
    memory_total_mb: Option<f64>,
    interfaces: Vec<DeviceInterfaceInfo>,
}

/// Aggregated interface summary for a device
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InterfaceSummary {
    total: u32,
    up: u32,
    down: u32,
    admin_down: u32,
    total_in_errors: u64,
    total_out_errors: u64,
    total_in_discards: u64,
    total_out_discards: u64,
}

/// Server → Client: error for a specific host
#[derive(Debug, Serialize)]
struct TopologyErrorMessage {
    r#type: &'static str,
    host: String,
    error: String,
}

/// WebSocket handler for topology live SNMP polling
///
/// Validates auth token from query parameter before upgrading.
/// On subscribe, polls SNMP targets periodically and pushes stats.
pub async fn topology_live_ws(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(query): Query<TopologyWsQuery>,
) -> impl IntoResponse {
    // Validate auth token from query parameter (constant-time, same pattern as terminal_ws)
    match &query.token {
        Some(token)
            if token
                .as_bytes()
                .ct_eq(state.app_state.auth_token.as_bytes())
                .into() => {}
        _ => {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
            )
                .into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_topology_live(socket, state.app_state))
        .into_response()
}

/// Handle topology live WebSocket connection
async fn handle_topology_live(socket: WebSocket, app_state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<String>();

    // Track the current polling task so we can cancel it
    let mut poll_handle: Option<tokio::task::JoinHandle<()>> = None;

    // Task to forward outgoing messages to WebSocket
    let output_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            if ws_tx.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming WebSocket messages
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                let client_msg: TopologyClientMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Invalid topology-live message: {}", e);
                        let err = TopologyErrorMessage {
                            r#type: "error",
                            host: String::new(),
                            error: format!("Invalid message: {}", e),
                        };
                        let _ = msg_tx.send(serde_json::to_string(&err)
                            .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() }));
                        continue;
                    }
                };

                match client_msg {
                    TopologyClientMessage::Subscribe { targets, interval_secs } => {
                        // Cancel existing polling task
                        if let Some(handle) = poll_handle.take() {
                            handle.abort();
                        }

                        // Clamp interval: minimum 10, maximum 300
                        let interval = interval_secs.clamp(10, 300);

                        let msg_tx = msg_tx.clone();
                        let app_state = app_state.clone();

                        // Spawn polling task
                        poll_handle = Some(tokio::spawn(async move {
                            topology_poll_loop(targets, interval, msg_tx, app_state).await;
                        }));
                    }
                    TopologyClientMessage::Unsubscribe => {
                        if let Some(handle) = poll_handle.take() {
                            handle.abort();
                        }
                        tracing::debug!("Topology-live: unsubscribed");
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup
    if let Some(handle) = poll_handle.take() {
        handle.abort();
    }
    output_task.abort();
    tracing::info!("Topology-live WebSocket closed");
}

/// Polling loop: periodically polls all targets and sends stats.
/// Exits when the WebSocket receiver is dropped (msg_tx sends fail).
async fn topology_poll_loop(
    targets: Vec<TopologyTarget>,
    interval_secs: u64,
    msg_tx: mpsc::UnboundedSender<String>,
    app_state: Arc<AppState>,
) {
    let interval = tokio::time::Duration::from_secs(interval_secs);

    loop {
        // Poll all targets in parallel; each task returns whether the channel is still open
        let mut tasks = Vec::new();
        for target in &targets {
            let target = target.clone();
            let app_state = app_state.clone();
            let msg_tx = msg_tx.clone();

            tasks.push(tokio::spawn(async move {
                poll_single_target(&target, &app_state, &msg_tx).await
            }));
        }

        // Wait for all polls to complete and check if channel is still open
        let mut channel_open = true;
        for task in tasks {
            match task.await {
                Ok(false) => channel_open = false,
                Err(_) => {} // task panicked, continue
                _ => {}
            }
        }

        if !channel_open {
            tracing::debug!("Topology WebSocket closed, stopping poll loop");
            break;
        }

        // Sleep until next poll interval
        tokio::time::sleep(interval).await;
    }
}

/// Poll a single target device and send results or errors.
/// Returns `true` if the channel is still open, `false` if the WebSocket receiver has been dropped.
async fn poll_single_target(
    target: &TopologyTarget,
    app_state: &Arc<AppState>,
    msg_tx: &mpsc::UnboundedSender<String>,
) -> bool {
    let host = &target.host;
    let port: u16 = 161;

    // Resolve SNMP communities from profile vault
    let communities = match resolve_snmp_communities(&target.profile_id, app_state).await {
        Ok(c) => c,
        Err(e) => {
            let err = TopologyErrorMessage {
                r#type: "error",
                host: host.clone(),
                error: e,
            };
            if msg_tx.send(serde_json::to_string(&err)
                .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })).is_err() {
                return false;
            }
            return true;
        }
    };

    // Resolve via the profile so live polling honors any configured jump
    // (matches the per-call API behavior). Vault/credential failures fall
    // back to direct so unreachable devices surface their own error rather
    // than a misleading credential one.
    let dest = match crate::snmp::dest::snmp_dest_for(
        &app_state.provider,
        host.as_str(),
        port,
        crate::ws::JumpRef::None,
        Some(&target.profile_id),
    )
    .await
    {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(
                "Live-poll jump resolution for {} failed ({}); using direct",
                host, e
            );
            crate::snmp::SnmpDest::direct(host.as_str(), port)
        }
    };

    // Try each community with snmp_bulk_interface_stats (same try-communities pattern)
    let mut last_error: Option<String> = None;
    for community in &communities {
        match crate::snmp::snmp_bulk_interface_stats(&dest, community, &target.interfaces).await {
            Ok(stats) => {
                let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

                // Compute interface summary from already-fetched stats (zero extra SNMP calls)
                let mut summary = InterfaceSummary {
                    total: stats.len() as u32,
                    up: 0,
                    down: 0,
                    admin_down: 0,
                    total_in_errors: 0,
                    total_out_errors: 0,
                    total_in_discards: 0,
                    total_out_discards: 0,
                };
                for s in &stats {
                    match s.oper_status {
                        1 => summary.up += 1,
                        2 => {
                            if s.admin_status == 2 {
                                summary.admin_down += 1;
                            } else {
                                summary.down += 1;
                            }
                        }
                        _ => {}
                    }
                    summary.total_in_errors += s.in_errors;
                    summary.total_out_errors += s.out_errors;
                    summary.total_in_discards += s.in_discards;
                    summary.total_out_discards += s.out_discards;
                }

                // Build per-interface info array BEFORE consuming stats with into_iter
                let iface_infos: Vec<DeviceInterfaceInfo> = stats
                    .iter()
                    .map(|s| DeviceInterfaceInfo {
                        if_descr: s.if_descr.clone(),
                        if_alias: s.if_alias.clone(),
                        oper_status: s.oper_status,
                        admin_status: s.admin_status,
                        speed_mbps: s.speed_mbps,
                        in_octets: s.in_octets,
                        out_octets: s.out_octets,
                        in_errors: s.in_errors,
                        out_errors: s.out_errors,
                    })
                    .collect();

                let interfaces: Vec<TopologyInterfaceStats> = stats
                    .into_iter()
                    .map(|s| {
                        let oper_status_text = match s.oper_status {
                            1 => "up".to_string(),
                            2 => "down".to_string(),
                            3 => "testing".to_string(),
                            n => format!("unknown({})", n),
                        };
                        TopologyInterfaceStats {
                            if_descr: s.if_descr,
                            if_alias: s.if_alias,
                            oper_status: s.oper_status,
                            oper_status_text,
                            speed_mbps: s.speed_mbps,
                            in_octets: s.in_octets,
                            out_octets: s.out_octets,
                            in_errors: s.in_errors,
                            out_errors: s.out_errors,
                            in_discards: s.in_discards,
                            out_discards: s.out_discards,
                            hc_counters: s.hc_counters,
                        }
                    })
                    .collect();

                // Send interface stats message (existing behavior)
                let msg = TopologyStatsMessage {
                    r#type: "stats",
                    host: host.clone(),
                    timestamp: timestamp.clone(),
                    interfaces,
                };
                if msg_tx.send(serde_json::to_string(&msg)
                    .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })).is_err() {
                    return false;
                }

                // Fetch device system info (one extra UDP round-trip for sysUpTime + sysDescr)
                let (sys_uptime_seconds, sys_descr) =
                    match crate::snmp::snmp_device_system_info(&dest, community).await {
                        Ok(info) => (
                            info.sys_uptime_hundredths.map(|h| h as f64 / 100.0),
                            info.sys_descr,
                        ),
                        Err(e) => {
                            tracing::debug!("Failed to get system info for {}: {}", host, e);
                            (None, None)
                        }
                    };

                // Fetch CPU/memory resources (1-2 extra UDP round-trips)
                let (cpu_percent, memory_percent, memory_used_mb, memory_total_mb) =
                    match crate::snmp::snmp_device_resources(&dest, community).await {
                        Ok(res) => {
                            let mem_pct = match (res.memory_used_bytes, res.memory_free_bytes) {
                                (Some(used), Some(free)) if used + free > 0 => {
                                    Some((used as f64 / (used + free) as f64) * 100.0)
                                }
                                _ => None,
                            };
                            let mem_used_mb = res.memory_used_bytes.map(|b| b as f64 / (1024.0 * 1024.0));
                            let mem_total_mb = match (res.memory_used_bytes, res.memory_free_bytes) {
                                (Some(used), Some(free)) => Some((used + free) as f64 / (1024.0 * 1024.0)),
                                _ => None,
                            };
                            (res.cpu_percent, mem_pct, mem_used_mb, mem_total_mb)
                        }
                        Err(e) => {
                            tracing::debug!("Failed to get resource info for {}: {}", host, e);
                            (None, None, None, None)
                        }
                    };

                // Send device stats message
                let device_msg = TopologyDeviceStatsMessage {
                    r#type: "device_stats",
                    host: host.clone(),
                    timestamp,
                    sys_uptime_seconds,
                    sys_descr,
                    interface_summary: summary,
                    cpu_percent,
                    memory_percent,
                    memory_used_mb,
                    memory_total_mb,
                    interfaces: iface_infos,
                };
                return msg_tx.send(serde_json::to_string(&device_msg)
                    .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })).is_ok();
            }
            Err(crate::snmp::SnmpError::Timeout(_)) => {
                last_error = Some("SNMP timeout after 5s".to_string());
                continue;
            }
            Err(crate::snmp::SnmpError::AuthError) => {
                last_error = Some("SNMP authentication failed".to_string());
                continue;
            }
            Err(e) => {
                // Non-auth/timeout error: report immediately
                let err = TopologyErrorMessage {
                    r#type: "error",
                    host: host.clone(),
                    error: e.to_string(),
                };
                return msg_tx.send(serde_json::to_string(&err)
                    .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })).is_ok();
            }
        }
    }

    // No community worked
    let err = TopologyErrorMessage {
        r#type: "error",
        host: host.clone(),
        error: last_error.unwrap_or_else(|| "No SNMP community succeeded".to_string()),
    };
    msg_tx.send(serde_json::to_string(&err)
        .unwrap_or_else(|e| { tracing::error!("Serialization failed: {}", e); r#"{"error":"serialization failed"}"#.to_string() })).is_ok()
}

/// Resolve SNMP communities from a profile ID via the vault.
/// Falls back to scanning all profiles if the requested profile has no SNMP communities
/// (same pattern as the HTTP API's snmp_try_interface_stats).
async fn resolve_snmp_communities(
    profile_id: &str,
    app_state: &Arc<AppState>,
) -> Result<Vec<String>, String> {
    let mut communities: Vec<String> = Vec::new();

    // Level 1: Try the requested profile
    match app_state.provider.get_profile_credential(profile_id).await {
        Ok(Some(cred)) => {
            if let Some(ref comms) = cred.snmp_communities {
                if !comms.is_empty() {
                    communities = comms.clone();
                    tracing::debug!("Using SNMP communities from requested profile {}", profile_id);
                }
            }
        }
        Ok(None) => {
            tracing::debug!("No credential found for profile {}", profile_id);
        }
        Err(crate::providers::ProviderError::VaultLocked) => {
            return Err("Vault is locked. Unlock in Settings > Security.".to_string());
        }
        Err(e) => {
            tracing::warn!("Failed to get profile credential for {}: {}", profile_id, e);
        }
    }

    // Level 2: Scan all profiles for one with SNMP communities
    if communities.is_empty() {
        tracing::debug!("Profile {} has no SNMP communities, scanning all profiles", profile_id);
        if let Ok(all_profiles) = app_state.provider.list_profiles().await {
            for profile in &all_profiles {
                if profile.id == profile_id {
                    continue; // Already tried
                }
                if let Ok(Some(cred)) = app_state.provider.get_profile_credential(&profile.id).await {
                    if let Some(ref comms) = cred.snmp_communities {
                        if !comms.is_empty() {
                            communities = comms.clone();
                            tracing::info!(
                                "Found SNMP communities in profile {} ({})",
                                profile.name, profile.id
                            );
                            break;
                        }
                    }
                }
            }
        }
    }

    if communities.is_empty() {
        return Err("No SNMP communities found in any profile".to_string());
    }

    Ok(communities)
}

// === Task Progress WebSocket ===

/// Query parameters for task progress WebSocket
#[derive(Debug, Deserialize)]
pub struct TaskProgressWsQuery {
    pub token: Option<String>,
}

/// WebSocket handler for task progress streaming
///
/// Validates auth token from query parameter before upgrading.
/// Sends init message with current task list, then streams progress events.
pub async fn task_progress_ws(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    Query(query): Query<TaskProgressWsQuery>,
) -> impl IntoResponse {
    // Validate auth token from query parameter (constant-time compare,
    // matching api.rs auth_middleware to prevent timing-based leaks)
    match &query.token {
        Some(token)
            if token
                .as_bytes()
                .ct_eq(state.app_state.auth_token.as_bytes())
                .into() => {}
        _ => {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
            )
                .into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_task_progress(socket, state.app_state))
        .into_response()
}

/// Handle task progress WebSocket connection
async fn handle_task_progress(socket: WebSocket, app_state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Subscribe to progress events
    let mut progress_rx = app_state.progress_broadcaster.subscribe();

    // Send current task list on connect (so client has initial state)
    if let Ok(tasks) = app_state.task_store.list_tasks(None, 50, 0).await {
        let init_msg = serde_json::json!({
            "type": "init",
            "tasks": tasks,
            "running_count": app_state.task_registry.running_count().await,
            "max_concurrent": app_state.task_registry.max_concurrent(),
        });
        if let Ok(json) = serde_json::to_string(&init_msg) {
            let _ = ws_tx.send(Message::Text(json)).await;
        }
    }

    // Spawn task to forward progress events to WebSocket
    let forward_task = tokio::spawn(async move {
        loop {
            match progress_rx.recv().await {
                Ok(event) => {
                    if let Ok(json) = serde_json::to_string(&event) {
                        if ws_tx.send(Message::Text(json)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("Task progress WebSocket lagged {} events", n);
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    // Handle incoming messages (client can send commands like cancel)
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                // Parse client commands
                if let Ok(cmd) = serde_json::from_str::<TaskWsCommand>(&text) {
                    match cmd {
                        TaskWsCommand::Cancel { task_id } => {
                            if let Err(e) = app_state.task_executor.cancel_task(&task_id).await {
                                tracing::warn!("Failed to cancel task {}: {}", task_id, e);
                            }
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    forward_task.abort();
    tracing::debug!("Task progress WebSocket closed");
}

/// Commands from client to server via WebSocket
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TaskWsCommand {
    Cancel { task_id: String },
}

#[cfg(test)]
mod auto_command_prompt_tests {
    use super::*;

    #[test]
    fn trailing_colon_is_not_a_prompt() {
        assert!(looks_like_prompt("mgmt-sw-01#"));
        assert!(looks_like_prompt("banner\r\nmgmt-sw-01> "));
        assert!(looks_like_prompt("user@host:~$ "));
        assert!(looks_like_prompt("host% "));
        assert!(!looks_like_prompt("Password: "));
        assert!(!looks_like_prompt("Authorized users only. Violators will be prosecuted:\r\n"));
        assert!(!looks_like_prompt(""));
    }

    #[test]
    fn output_buffer_is_capped_on_a_char_boundary() {
        let mut buf = "ñ".repeat(OUTPUT_BUFFER_CAP); // 2 bytes each
        buf.push_str("sw#");
        cap_output_buffer(&mut buf);
        assert!(buf.len() <= OUTPUT_BUFFER_CAP);
        assert!(buf.ends_with("sw#"));
        assert!(buf.starts_with('ñ'));
        let mut small = "abc".to_string();
        cap_output_buffer(&mut small);
        assert_eq!(small, "abc");
    }
}

#[cfg(test)]
mod resolve_effective_jump_tests {
    use super::*;
    use crate::models::{NewCredentialProfile, NewJumpHost, AuthType, CliFlavor};
    use crate::providers::local::LocalDataProvider;
    use std::sync::Arc;
    use tempfile::tempdir;

    async fn fresh_provider() -> Arc<dyn crate::providers::DataProvider> {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = crate::db::init_db(&db_path).await.unwrap();
        std::mem::forget(dir);
        Arc::new(LocalDataProvider::new(pool))
    }

    fn np(name: &str, jump_host_id: Option<String>) -> NewCredentialProfile {
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
            jump_host_id,
            jump_session_id: None,
        }
    }

    #[tokio::test]
    async fn session_jump_overrides_profile_jump() {
        let provider = fresh_provider().await;
        let session_jump_profile = provider.create_profile(np("session-jump-creds", None)).await.unwrap();
        let profile_jump_profile = provider.create_profile(np("profile-jump-creds", None)).await.unwrap();
        let session_jump = provider.create_jump_host(NewJumpHost {
            name: "session-jump".into(), host: "10.0.0.1".into(), port: 22,
            profile_id: session_jump_profile.id.clone(),
        }).await.unwrap();
        let profile_jump = provider.create_jump_host(NewJumpHost {
            name: "profile-jump".into(), host: "10.0.0.2".into(), port: 22,
            profile_id: profile_jump_profile.id.clone(),
        }).await.unwrap();

        let result = resolve_effective_jump(
            JumpRef::JumpHost(session_jump.id.clone()),
            JumpRef::JumpHost(profile_jump.id.clone()),
            &provider,
        ).await.unwrap();

        let r = result.expect("should resolve");
        assert_eq!(r.source.id(), session_jump.id, "session jump should win");
        assert_eq!(r.profile.name, "session-jump-creds");
    }

    #[tokio::test]
    async fn falls_back_to_profile_jump_when_session_has_none() {
        let provider = fresh_provider().await;
        let backing = provider.create_profile(np("backing", None)).await.unwrap();
        let jh = provider.create_jump_host(NewJumpHost {
            name: "the-jump".into(), host: "10.0.0.1".into(), port: 22,
            profile_id: backing.id.clone(),
        }).await.unwrap();

        let result = resolve_effective_jump(JumpRef::None, JumpRef::JumpHost(jh.id.clone()), &provider).await.unwrap();
        let r = result.expect("should resolve from profile");
        assert_eq!(r.source.id(), jh.id);
    }

    #[tokio::test]
    async fn returns_none_when_neither_set() {
        let provider = fresh_provider().await;
        let result = resolve_effective_jump(JumpRef::None, JumpRef::None, &provider).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn missing_jump_host_returns_descriptive_error() {
        let provider = fresh_provider().await;
        let result = resolve_effective_jump(JumpRef::JumpHost("does-not-exist".into()), JumpRef::None, &provider).await;
        let err = result.unwrap_err();
        assert!(err.contains("does-not-exist"), "msg should name the missing id: {err}");
        assert!(err.contains("no longer exists"), "msg should explain: {err}");
    }

    /// End-to-end smoke test for the full jump-host bug fix:
    /// - Profile-default jump host (no session-level override)
    /// - Real DB + real vault with stored credentials
    /// - resolve_effective_jump returns the right jump host AND its credential
    ///
    /// Pre-fix, the chain dropped the device password entirely AND never
    /// loaded the jump host's credential. This test exercises both halves.
    #[tokio::test]
    async fn end_to_end_profile_default_jump_with_vault_credentials() {
        let provider = fresh_provider().await;
        provider.set_master_password("test-password").await.unwrap();

        // Set up the jump-host side: profile + JumpHost + stored vault credential.
        let jump_profile = provider
            .create_profile(np("bastion-creds", None))
            .await
            .unwrap();
        provider
            .store_profile_credential(
                &jump_profile.id,
                crate::models::ProfileCredential {
                    password: Some("jump-secret".into()),
                    key_passphrase: None,
                    snmp_communities: None,
                },
            )
            .await
            .unwrap();
        let jh = provider
            .create_jump_host(crate::models::NewJumpHost {
                name: "edge-bastion".into(),
                host: "10.0.0.1".into(),
                port: 22,
                profile_id: jump_profile.id.clone(),
            })
            .await
            .unwrap();

        // Set up the target side: profile with profile-level jump_host_id set.
        let target_profile = provider
            .create_profile(np("corp-routers", Some(jh.id.clone())))
            .await
            .unwrap();
        provider
            .store_profile_credential(
                &target_profile.id,
                crate::models::ProfileCredential {
                    password: Some("device-secret".into()),
                    key_passphrase: None,
                    snmp_communities: None,
                },
            )
            .await
            .unwrap();

        // Resolve the effective jump for a session that has NO override
        // (so it should inherit from the target profile).
        let profile_level = JumpRef::from_pair(
            target_profile.jump_host_id.as_deref(),
            target_profile.jump_session_id.as_deref(),
        );
        let resolution = resolve_effective_jump(JumpRef::None, profile_level, &provider)
            .await
            .unwrap()
            .expect("profile-default jump should resolve");

        // The resolved jump host matches what was configured on the profile.
        assert_eq!(resolution.source.id(), jh.id);
        assert_eq!(resolution.source.display_name(), "edge-bastion");
        assert_eq!(resolution.profile.username, "u");

        // The bug fix: the jump credential is loaded from the vault and
        // matches what was stored on the jump's profile.
        let cred = resolution.credential.expect("jump credential must be loaded");
        assert_eq!(
            cred.password.as_deref(),
            Some("jump-secret"),
            "jump host's own password must be loaded — pre-fix, this was never read"
        );
    }

    // === T2 (sessions-as-jump-hosts): resolution tests ===

    #[tokio::test]
    async fn resolves_session_as_jump() {
        let provider = fresh_provider().await;
        provider.set_master_password("test-password").await.unwrap();

        // Build session A with credentials — to be used AS the jump.
        let p_a = provider.create_profile(np("p_a", None)).await.unwrap();
        provider.store_profile_credential(&p_a.id, crate::models::ProfileCredential {
            password: Some("session-a-secret".into()),
            key_passphrase: None, snmp_communities: None,
        }).await.unwrap();
        let session_a = provider.create_session(crate::models::NewSession {
            name: "homelab-bastion".into(), folder_id: None,
            host: "192.168.1.5".into(), port: 2222,
            color: None, profile_id: p_a.id.clone(),
            netbox_device_id: None, netbox_source_id: None,
            cli_flavor: crate::models::CliFlavor::Auto, terminal_theme: None,
            font_family: None, font_size_override: None,
            jump_host_id: None, jump_session_id: None,
            port_forwards: vec![], auto_commands: vec![],
            legacy_ssh: false, protocol: crate::models::Protocol::Ssh,
            sftp_start_path: None,
            console_host: None, console_port: None,
            console_protocol: crate::models::Protocol::Ssh, console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        }).await.unwrap();

        // Resolve "session A as jump" via the new path.
        let r = resolve_effective_jump(JumpRef::Session(session_a.id.clone()), JumpRef::None, &provider)
            .await
            .unwrap()
            .expect("session-as-jump must resolve");

        assert!(matches!(r.source, JumpSource::Session { .. }));
        assert_eq!(r.source.id(), session_a.id);
        assert_eq!(r.source.display_name(), "homelab-bastion");
        assert_eq!(r.host, "192.168.1.5");
        assert_eq!(r.port, 2222);
        assert_eq!(r.profile.id, p_a.id);
        assert_eq!(
            r.credential.expect("vault credential").password.as_deref(),
            Some("session-a-secret"),
            "must load A's own credential, not anyone else's"
        );
    }

    #[tokio::test]
    async fn resolves_session_as_jump_missing_returns_descriptive_error() {
        let provider = fresh_provider().await;
        let err = resolve_effective_jump(JumpRef::Session("ghost".into()), JumpRef::None, &provider)
            .await
            .unwrap_err();
        assert!(err.contains("ghost"), "msg should name missing id: {err}");
        assert!(err.contains("no longer exists"), "msg should explain: {err}");
    }

    /// End-to-end smoke for the full sessions-as-jump-hosts feature.
    ///
    /// Mirrors `end_to_end_profile_default_jump_with_vault_credentials`
    /// from PR #1 but for the session-as-jump path. Real DB + real vault
    /// + stored credentials. Verifies:
    /// 1. A session set up as another session's jump_session_id resolves.
    /// 2. The resolved jump host/port match the upstream session's host/port
    ///    (one source of truth — the user's pain in PR #1).
    /// 3. The resolved credential is the upstream session's profile's
    ///    credential, NOT the device's — so the auth bug that prompted
    ///    this whole project cannot recur for the session-as-jump path.
    #[tokio::test]
    async fn end_to_end_session_as_jump_with_vault_credentials() {
        let provider = fresh_provider().await;
        provider.set_master_password("test-password").await.unwrap();

        // Set up Session A — the future jump.
        let p_a = provider.create_profile(
            crate::models::NewCredentialProfile {
                name: "homelab-bastion-creds".into(), username: "cwdavis".into(),
                auth_type: AuthType::Password, key_path: None,
                port: 22, keepalive_interval: 30, connection_timeout: 10,
                terminal_theme: None, default_font_size: None, default_font_family: None,
                scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: crate::models::CliFlavor::default(),
                auto_commands: vec![], jump_host_id: None, jump_session_id: None,
            }
        ).await.unwrap();
        provider.store_profile_credential(&p_a.id, crate::models::ProfileCredential {
            password: Some("the-real-bastion-password".into()),
            key_passphrase: None, snmp_communities: None,
        }).await.unwrap();
        let session_a = provider.create_session(crate::models::NewSession {
            name: "homelab-bastion".into(), folder_id: None,
            host: "192.168.50.127".into(), port: 22,
            color: None, profile_id: p_a.id.clone(),
            netbox_device_id: None, netbox_source_id: None,
            cli_flavor: crate::models::CliFlavor::Auto, terminal_theme: None,
            font_family: None, font_size_override: None,
            jump_host_id: None, jump_session_id: None,
            port_forwards: vec![], auto_commands: vec![],
            legacy_ssh: false, protocol: crate::models::Protocol::Ssh,
            sftp_start_path: None,
            console_host: None, console_port: None,
            console_protocol: crate::models::Protocol::Ssh, console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        }).await.unwrap();

        // Set up Session B with jump_session_id = A. Different profile,
        // different password (this is the exact divergence that bit us
        // in PR #1's debugging session).
        let p_b = provider.create_profile(
            crate::models::NewCredentialProfile {
                name: "router-creds".into(), username: "admin".into(),
                auth_type: AuthType::Password, key_path: None,
                port: 22, keepalive_interval: 30, connection_timeout: 10,
                terminal_theme: None, default_font_size: None, default_font_family: None,
                scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
                reconnect_delay: 5,
                cli_flavor: crate::models::CliFlavor::default(),
                auto_commands: vec![], jump_host_id: None, jump_session_id: None,
            }
        ).await.unwrap();
        provider.store_profile_credential(&p_b.id, crate::models::ProfileCredential {
            password: Some("device-password-DIFFERENT".into()),
            key_passphrase: None, snmp_communities: None,
        }).await.unwrap();
        let session_b = provider.create_session(crate::models::NewSession {
            name: "router-via-bastion".into(), folder_id: None,
            host: "172.30.0.200".into(), port: 22,
            color: None, profile_id: p_b.id.clone(),
            netbox_device_id: None, netbox_source_id: None,
            cli_flavor: crate::models::CliFlavor::Auto, terminal_theme: None,
            font_family: None, font_size_override: None,
            jump_host_id: None,
            jump_session_id: Some(session_a.id.clone()),
            port_forwards: vec![], auto_commands: vec![],
            legacy_ssh: false, protocol: crate::models::Protocol::Ssh,
            sftp_start_path: None,
            console_host: None, console_port: None,
            console_protocol: crate::models::Protocol::Ssh, console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        }).await.unwrap();

        // Resolve the effective jump for session B (no profile-level jump).
        let session_level = JumpRef::from_pair(
            session_b.jump_host_id.as_deref(),
            session_b.jump_session_id.as_deref(),
        );
        let r = resolve_effective_jump(session_level, JumpRef::None, &provider)
            .await
            .unwrap()
            .expect("session-as-jump must resolve");

        // Source kind + id correct.
        assert!(matches!(r.source, JumpSource::Session { .. }));
        assert_eq!(r.source.id(), session_a.id);
        assert_eq!(r.source.display_name(), "homelab-bastion");

        // Endpoint matches Session A — one source of truth.
        assert_eq!(r.host, "192.168.50.127");
        assert_eq!(r.port, 22);

        // Profile matches Session A's profile, NOT B's.
        assert_eq!(r.profile.id, p_a.id);
        assert_eq!(r.profile.username, "cwdavis");

        // The bug fix: resolved credential is A's stored password, NOT B's.
        // If we ever loaded the device's password for the jump hop, this
        // assertion would fail loudly.
        let cred = r.credential.expect("vault credential must be loaded");
        assert_eq!(
            cred.password.as_deref(),
            Some("the-real-bastion-password"),
            "must load Session A's own password (the upstream jump), \
             never the device's — this is the exact regression that PR #1 \
             diagnosed and this PR makes structurally impossible"
        );
    }

    /// End-to-end smoke for SNMP-via-jump. Walks the full chain:
    ///   Session-as-jump record → resolve_effective_jump → vault credential
    ///   → SshConfig → SnmpDest::ViaJump → snmp::snmp_get → russh exec
    ///   channel → shimmed snmpget → parsed SnmpValueEntry.
    ///
    /// The "jump host" is a russh test server with an exec_responder that
    /// returns canned net-snmp output when invoked with the right argv.
    /// Proves that a UI-triggered SNMP query for a device behind a jump
    /// successfully returns parsed values without ever opening a UDP
    /// socket from this process.
    #[tokio::test]
    async fn end_to_end_snmp_via_session_as_jump_with_vault_credentials() {
        use crate::ssh::test_utils::{ephemeral_ed25519, start_test_server, ExecResponse, TestServerConfig};
        use std::sync::Arc;

        // 1. Stand up the test SSH server with an snmpget shim.
        let saw_cmd = Arc::new(std::sync::Mutex::new(String::new()));
        let saw_cmd_w = saw_cmd.clone();
        let jump_addr = start_test_server(TestServerConfig {
            accept_password: Some(("bastion-user".into(), "bastion-secret".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: Some(Arc::new(move |cmd: &str| {
                *saw_cmd_w.lock().unwrap() = cmd.to_string();
                Some(ExecResponse {
                    stdout: b".1.3.6.1.2.1.1.5.0 = STRING: \"core-router-7\"\n".to_vec(),
                    stderr: vec![],
                    exit_status: 0,
                })
            })),
            eof_before_exit_status: false,
            shell: None,
            host_key: ephemeral_ed25519(),
        })
        .await;

        // 2. Provider + vault + the jump-side data.
        let provider = fresh_provider().await;
        provider.set_master_password("test-password").await.unwrap();

        let bastion_profile = provider.create_profile(crate::models::NewCredentialProfile {
            name: "bastion-creds".into(),
            username: "bastion-user".into(),
            auth_type: AuthType::Password, key_path: None,
            port: 22, keepalive_interval: 30, connection_timeout: 10,
            terminal_theme: None, default_font_size: None, default_font_family: None,
            scrollback_lines: 1000, local_echo: false, auto_reconnect: false,
            reconnect_delay: 5, cli_flavor: crate::models::CliFlavor::default(),
            auto_commands: vec![], jump_host_id: None, jump_session_id: None,
        }).await.unwrap();
        provider.store_profile_credential(&bastion_profile.id, crate::models::ProfileCredential {
            password: Some("bastion-secret".into()),
            key_passphrase: None, snmp_communities: None,
        }).await.unwrap();

        // The "jump session" — a Session record whose host:port points at
        // our test SSH server. Other sessions reference this one as their
        // SNMP jump (mirroring the user's homelab-bastion setup).
        let bastion_session = provider.create_session(crate::models::NewSession {
            name: "homelab-bastion".into(), folder_id: None,
            host: jump_addr.ip().to_string(),
            port: jump_addr.port(),
            color: None, profile_id: bastion_profile.id.clone(),
            netbox_device_id: None, netbox_source_id: None,
            cli_flavor: crate::models::CliFlavor::Auto, terminal_theme: None,
            font_family: None, font_size_override: None,
            jump_host_id: None, jump_session_id: None,
            port_forwards: vec![], auto_commands: vec![],
            legacy_ssh: false, protocol: crate::models::Protocol::Ssh,
            sftp_start_path: None,
            console_host: None, console_port: None,
            console_protocol: crate::models::Protocol::Ssh, console_profile_id: None,
            console_legacy_ssh: false,
            auto_reconnect: true,
            reconnect_delay: 5,
            scrollback_lines: 10000,
            local_echo: false,
            icon: None,
        }).await.unwrap();

        // 3. Resolve the jump exactly as api.rs does.
        let resolution = resolve_effective_jump(
            JumpRef::Session(bastion_session.id.clone()),
            JumpRef::None,
            &provider,
        )
        .await
        .unwrap()
        .expect("session-as-jump must resolve");

        // 4. Build the SnmpDest::ViaJump (mirroring api.rs::build_snmp_dest).
        let auth = match resolution.profile.auth_type {
            AuthType::Password => crate::ssh::SshAuth::Password(
                resolution.credential.as_ref().and_then(|c| c.password.clone()).unwrap()
            ),
            AuthType::Key => unreachable!("test uses password auth"),
        };
        let jump_cfg = crate::ssh::SshConfig {
            host: resolution.host.clone(),
            port: resolution.port,
            username: resolution.profile.username.clone(),
            auth,
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };
        let target_host = "10.99.0.5".to_string();
        let target_port: u16 = 161;
        let dest = crate::snmp::SnmpDest::ViaJump {
            jump: jump_cfg,
            target_host: target_host.clone(),
            target_port,
        };

        // 5. Run an SNMP GET through the full stack.
        let entries = crate::snmp::snmp_get(&dest, "public", &["1.3.6.1.2.1.1.5.0"])
            .await
            .expect("snmp_get via session-as-jump must succeed");

        // 6. Verify the parsed value matches the shim's canned output.
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].oid, "1.3.6.1.2.1.1.5.0");
        match &entries[0].value {
            crate::snmp::SnmpValue::String(s) => assert_eq!(s, "core-router-7"),
            other => panic!("expected String, got {other:?}"),
        }

        // 7. The shim received the right argv: net-snmp called with the
        // upstream session's password authenticating the SSH hop, and the
        // target device's host:port + community visible on the command line.
        let cmd = saw_cmd.lock().unwrap().clone();
        assert!(cmd.starts_with("snmpget"), "wrong tool: {cmd}");
        assert!(cmd.contains("-c 'public'"), "community quoted: {cmd}");
        assert!(cmd.contains(&format!("'{}:{}'", target_host, target_port)),
            "target host:port quoted: {cmd}");
        assert!(cmd.contains("'1.3.6.1.2.1.1.5.0'"), "oid quoted: {cmd}");
    }
}
