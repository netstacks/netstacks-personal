//! Per-(plugin, workspace) LSP session.
//!
//! Owns a stdio child process plus the set of attached WebSocket clients.
//! Reads LSP-framed messages from the child's stdout and broadcasts them
//! to every attached client. Writes from clients are serialized into
//! framed messages and forwarded to the child's stdin.

use crate::lsp::types::RuntimeConfig;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::task::JoinHandle;

const SHUTDOWN_GRACE_MS: u64 = 5_000;
const CLIENT_BROADCAST_CAPACITY: usize = 64;

#[derive(Debug, Error)]
pub enum LspSessionError {
    #[error("failed to spawn LSP child process: {0}")]
    SpawnFailed(String),
    #[error("child process I/O error: {0}")]
    ChildIo(String),
    #[error("invalid LSP frame: {0}")]
    InvalidFrame(String),
}

/// A message from the LSP child to attached clients. This is the JSON body
/// only; framing (Content-Length headers) is stripped before broadcast.
pub type LspMessage = Vec<u8>;

/// Per-client outbound stream: receives bytes from the LSP child to send
/// to the WebSocket client.
pub type OutboundReceiver = broadcast::Receiver<LspMessage>;

/// Per-session writer handle for messages from clients to the LSP child.
pub type InboundSender = mpsc::Sender<LspMessage>;

/// A running LSP session: child process + reader/writer tasks + client broadcast.
pub struct LspSession {
    /// Broadcast channel: every attached WebSocket subscribes here to
    /// receive messages from the child's stdout.
    outbound_tx: broadcast::Sender<LspMessage>,
    /// mpsc channel: every attached WebSocket sends messages here, which
    /// are then written to the child's stdin.
    inbound_tx: mpsc::Sender<LspMessage>,
    /// Handle to the child process; held so it stays alive.
    /// `Mutex` so shutdown can acquire it for `.kill()`.
    child: Arc<Mutex<Option<Child>>>,
    /// Background task reading from child stdout. Aborted on shutdown.
    _reader_task: JoinHandle<()>,
    /// Background task writing to child stdin. Aborted on shutdown.
    _writer_task: JoinHandle<()>,
    /// Background task draining child stderr to log lines. Aborted on shutdown.
    _stderr_task: JoinHandle<()>,
}

impl LspSession {
    /// Spawn a new LSP child process for the given runtime + workspace.
    ///
    /// `workspace` is set as the child's current_dir so the LSP sees it
    /// as the project root. Pass `None` for loose-file mode (Phase 6).
    pub fn spawn(
        runtime: &RuntimeConfig,
        workspace: Option<&Path>,
    ) -> Result<Arc<Self>, LspSessionError> {
        let mut cmd = Command::new(&runtime.command);
        cmd.args(&runtime.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(ws) = workspace {
            cmd.current_dir(ws);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| LspSessionError::SpawnFailed(format!("{}: {}", runtime.command, e)))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| LspSessionError::SpawnFailed("no stdin pipe".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| LspSessionError::SpawnFailed("no stdout pipe".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| LspSessionError::SpawnFailed("no stderr pipe".into()))?;

        let (outbound_tx, _) = broadcast::channel::<LspMessage>(CLIENT_BROADCAST_CAPACITY);
        let (inbound_tx, inbound_rx) = mpsc::channel::<LspMessage>(CLIENT_BROADCAST_CAPACITY);

        let reader_task = spawn_reader(stdout, outbound_tx.clone());
        let writer_task = spawn_writer(stdin, inbound_rx);
        let stderr_task = spawn_stderr_logger(stderr, runtime.command.clone());

        let child_handle = Arc::new(Mutex::new(Some(child)));

        Ok(Arc::new(Self {
            outbound_tx,
            inbound_tx,
            child: child_handle,
            _reader_task: reader_task,
            _writer_task: writer_task,
            _stderr_task: stderr_task,
        }))
    }

    /// Subscribe to messages from the LSP child. Each call yields a fresh
    /// receiver — drop the receiver to disconnect.
    pub fn subscribe(&self) -> OutboundReceiver {
        self.outbound_tx.subscribe()
    }

    /// How many subscribers (typically WebSocket clients) are attached.
    /// Currently unused — kept (with underscore prefix) as a hook for the
    /// future "shut down idle LSP sessions" sweep.
    pub fn _client_count(&self) -> usize {
        self.outbound_tx.receiver_count()
    }

    pub fn inbound_sender(&self) -> InboundSender {
        self.inbound_tx.clone()
    }

    /// Gracefully shut down the session: send `shutdown` then `exit` LSP
    /// requests, wait up to SHUTDOWN_GRACE_MS, then SIGKILL if still alive.
    pub async fn shutdown(&self) {
        // Send `shutdown` and `exit` via inbound channel; the LSP server
        // is expected to exit cleanly. If it doesn't, we kill it.
        let shutdown_msg = br#"{"jsonrpc":"2.0","id":99999,"method":"shutdown"}"#;
        let exit_msg = br#"{"jsonrpc":"2.0","method":"exit"}"#;

        let _ = self.inbound_tx.send(shutdown_msg.to_vec()).await;
        let _ = self.inbound_tx.send(exit_msg.to_vec()).await;

        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            match tokio::time::timeout(
                Duration::from_millis(SHUTDOWN_GRACE_MS),
                child.wait(),
            )
            .await
            {
                Ok(Ok(status)) => {
                    tracing::info!(?status, "LSP session exited cleanly");
                }
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "LSP child wait failed");
                }
                Err(_) => {
                    tracing::warn!("LSP session did not exit within grace period; killing");
                    let _ = child.kill().await;
                }
            }
        }
    }
}

/// Background task: read framed LSP messages from child stdout and broadcast
/// them. Exits when stdout closes.
fn spawn_reader(stdout: ChildStdout, tx: broadcast::Sender<LspMessage>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader).await {
                Ok(Some(body)) => {
                    // Drop is fine if no subscribers; broadcast will report
                    // the count back via `receiver_count`.
                    let _ = tx.send(body);
                }
                Ok(None) => {
                    tracing::debug!("LSP child stdout closed");
                    return;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "LSP frame read error; closing reader");
                    return;
                }
            }
        }
    })
}

/// Background task: serialize messages from clients into LSP frames and
/// write them to child stdin. Exits when channel closes or stdin errors.
fn spawn_writer(mut stdin: ChildStdin, mut rx: mpsc::Receiver<LspMessage>) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(body) = rx.recv().await {
            let header = format!("Content-Length: {}\r\n\r\n", body.len());
            if let Err(e) = stdin.write_all(header.as_bytes()).await {
                tracing::warn!(error = %e, "LSP stdin write error (header)");
                return;
            }
            if let Err(e) = stdin.write_all(&body).await {
                tracing::warn!(error = %e, "LSP stdin write error (body)");
                return;
            }
            if let Err(e) = stdin.flush().await {
                tracing::warn!(error = %e, "LSP stdin flush error");
                return;
            }
        }
        tracing::debug!("LSP writer task exiting (channel closed)");
    })
}

/// Background task: drain child stderr into the agent log.
fn spawn_stderr_logger(
    stderr: tokio::process::ChildStderr,
    command: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => return,
                Ok(_) => {
                    tracing::debug!(target: "lsp_stderr", "{}: {}", command, line.trim_end());
                }
                Err(e) => {
                    tracing::warn!(error = %e, "LSP stderr read error");
                    return;
                }
            }
        }
    })
}

/// Read one LSP frame from an async BufReader.
async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, LspSessionError> {
    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| LspSessionError::ChildIo(e.to_string()))?;
        if n == 0 {
            return Ok(None);
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix("Content-Length: ") {
            content_length = Some(
                rest.trim()
                    .parse()
                    .map_err(|e: std::num::ParseIntError| {
                        LspSessionError::InvalidFrame(format!("Content-Length: {}", e))
                    })?,
            );
        }
        // Other headers ignored.
    }

    let len = content_length
        .ok_or_else(|| LspSessionError::InvalidFrame("missing Content-Length header".into()))?;
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|e| LspSessionError::ChildIo(e.to_string()))?;
    Ok(Some(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::time::{timeout, Duration};

    fn fake_lsp_path() -> PathBuf {
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR set when cargo runs tests");
        PathBuf::from(manifest)
            .join("tests/fixtures/fake-lsp/target/release/fake-lsp")
    }

    fn ensure_fake_lsp_built() {
        let bin = fake_lsp_path();
        if !bin.exists() {
            let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
            let status = std::process::Command::new("cargo")
                .args(["build", "--release"])
                .current_dir(PathBuf::from(manifest).join("tests/fixtures/fake-lsp"))
                .status()
                .expect("cargo build fake-lsp");
            assert!(status.success(), "failed to build fake-lsp");
        }
    }

    fn runtime_for_fake() -> RuntimeConfig {
        ensure_fake_lsp_built();
        RuntimeConfig {
            command: fake_lsp_path().to_string_lossy().into_owned(),
            args: vec![],
        }
    }

    #[tokio::test]
    async fn spawn_and_initialize_round_trip() {
        let runtime = runtime_for_fake();
        let session = LspSession::spawn(&runtime, None).expect("spawn");

        let mut rx = session.subscribe();
        let tx = session.inbound_sender();

        // Send initialize
        let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#;
        tx.send(init.to_vec()).await.expect("send");

        // Receive response
        let body = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for initialize response")
            .expect("broadcast error");

        let v: serde_json::Value = serde_json::from_slice(&body).expect("parse json");
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["serverInfo"]["name"], "fake-lsp");

        session.shutdown().await;
    }

    #[tokio::test]
    async fn multiple_subscribers_each_receive_messages() {
        let runtime = runtime_for_fake();
        let session = LspSession::spawn(&runtime, None).expect("spawn");

        let mut rx1 = session.subscribe();
        let mut rx2 = session.subscribe();
        assert_eq!(session._client_count(), 2);

        let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#;
        session.inbound_sender().send(init.to_vec()).await.expect("send");

        let body1 = timeout(Duration::from_secs(5), rx1.recv()).await.expect("rx1 timeout").expect("rx1 recv");
        let body2 = timeout(Duration::from_secs(5), rx2.recv()).await.expect("rx2 timeout").expect("rx2 recv");
        assert_eq!(body1, body2);

        session.shutdown().await;
    }

    #[tokio::test]
    async fn did_open_triggers_diagnostic_publish() {
        let runtime = runtime_for_fake();
        let session = LspSession::spawn(&runtime, None).expect("spawn");

        let mut rx = session.subscribe();
        let tx = session.inbound_sender();

        // Initialize first (drain response so we know the server is ready)
        let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#;
        tx.send(init.to_vec()).await.expect("send");
        let _ = timeout(Duration::from_secs(5), rx.recv()).await.expect("init resp timeout");

        // Send textDocument/didOpen
        let did_open = br#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///tmp/x.py","languageId":"python","version":1,"text":"x = 1"}}}"#;
        tx.send(did_open.to_vec()).await.expect("send");

        // Should receive publishDiagnostics with FAKE-LSP-DIAG
        let body = timeout(Duration::from_secs(5), rx.recv()).await.expect("diag timeout").expect("recv");
        let v: serde_json::Value = serde_json::from_slice(&body).expect("parse");
        assert_eq!(v["method"], "textDocument/publishDiagnostics");
        let diag_msg = v["params"]["diagnostics"][0]["message"].as_str().unwrap();
        assert!(diag_msg.contains("FAKE-LSP-DIAG"), "got: {}", diag_msg);

        session.shutdown().await;
    }
}
