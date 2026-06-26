#![cfg(test)]
//! Shared test scaffolding for SSH module tests.
//!
//! This module provides reusable test servers, key generation, and utilities
//! for tests across `jump.rs`, `mod.rs` (SshSession), and future modules
//! (`terminal.rs`, `tunnels`, e2e).

use russh::keys::ssh_key;
use russh::keys::PrivateKey;
use russh::server::{Auth, Config as ServerConfig, Msg, Server, Session};
use russh::{Channel, ChannelId};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Canned response for an exec request the test server should serve.
#[derive(Clone, Default)]
pub(crate) struct ExecResponse {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: u32,
}

/// Map of exec command -> canned response. The match is against the full
/// exec command string sent by the client.
pub(crate) type ExecResponder = Arc<dyn Fn(&str) -> Option<ExecResponse> + Send + Sync>;

/// Configuration for the test SSH server.
#[derive(Clone)]
pub(crate) struct TestServerConfig {
    /// If Some, accept password auth with this (username, password).
    pub accept_password: Option<(String, String)>,
    /// If Some, accept publickey auth from this username (any key).
    pub accept_key_user: Option<String>,
    /// Whether to allow direct-tcpip channels.
    pub allow_direct_tcpip: bool,
    /// If Some, called for every exec_request. Returning Some(response)
    /// makes the server emit that stdout/stderr + exit status. Returning
    /// None makes the server reject the exec (channel close, no exit).
    pub exec_responder: Option<ExecResponder>,
    /// If true, send `eof` BEFORE `exit-status` (mimicking OpenSSH server
    /// behavior). If false, default order: data → exit-status → eof → close.
    /// Used to regression-test the channel-handling loop against both orders.
    pub eof_before_exit_status: bool,
    /// Host key for the server.
    pub host_key: PrivateKey,
}

/// Test server handler — implements both `Server` and `Handler`.
/// The Server trait creates new Handler instances for each client; we
/// just clone ourselves since the config is shared via Arc.
#[derive(Clone)]
pub(crate) struct TestServer {
    pub cfg: Arc<TestServerConfig>,
}

impl Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
        self.clone()
    }
}

impl russh::server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<Auth, Self::Error> {
        if let Some((u, p)) = &self.cfg.accept_password {
            if user == u && password == p {
                return Ok(Auth::Accept);
            }
        }
        Ok(Auth::reject())
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        _public_key: &ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        if let Some(accept_user) = &self.cfg.accept_key_user {
            if user == accept_user {
                return Ok(Auth::Accept);
            }
        }
        Ok(Auth::reject())
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        // Accept session channels (target needs this for shell).
        Ok(true)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if !self.cfg.allow_direct_tcpip {
            return Ok(false);
        }

        // Connect to the actual target and bridge data through this channel.
        let addr = format!("{}:{}", host_to_connect, port_to_connect);
        let stream = match TcpStream::connect(&addr).await {
            Ok(s) => s,
            Err(_) => return Ok(false),
        };

        tokio::spawn(async move {
            let _ = pump_channel_to_socket(channel, stream).await;
        });
        Ok(true)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Emit a "READY\n" banner that the test checks for. Spawn the
        // write so we don't block the request handler.
        let handle = session.handle();
        tokio::spawn(async move {
            let _ = handle.data(channel, b"READY\n".to_vec().into()).await;
        });
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        let responder = self.cfg.exec_responder.clone();
        let eof_first = self.cfg.eof_before_exit_status;
        let handle = session.handle();
        tokio::spawn(async move {
            let response = responder.as_ref().and_then(|r| r(&cmd)).unwrap_or_default();
            if !response.stdout.is_empty() {
                let _ = handle.data(channel, response.stdout.into()).await;
            }
            if !response.stderr.is_empty() {
                // ext = 1 = stderr per RFC 4254
                let _ = handle.extended_data(channel, 1, response.stderr.into()).await;
            }
            if eof_first {
                let _ = handle.eof(channel).await;
                let _ = handle.exit_status_request(channel, response.exit_status).await;
            } else {
                let _ = handle.exit_status_request(channel, response.exit_status).await;
                let _ = handle.eof(channel).await;
            }
            let _ = handle.close(channel).await;
        });
        Ok(())
    }
}

/// Bridge a russh server channel <-> a real TCP socket.
/// Used by the jump server to forward client traffic to the target.
pub(crate) async fn pump_channel_to_socket(
    mut channel: Channel<Msg>,
    mut stream: TcpStream,
) -> std::io::Result<()> {
    let mut buf = vec![0u8; 8192];
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(russh::ChannelMsg::Data { data }) => {
                        stream.write_all(&data).await?;
                    }
                    None | Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => break,
                    _ => {}
                }
            }
            n = stream.read(&mut buf) => {
                match n? {
                    0 => break,
                    n => {
                        channel.data(&buf[..n]).await
                            .map_err(|e| std::io::Error::new(
                                std::io::ErrorKind::Other, e.to_string()
                            ))?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Start a russh server on an ephemeral port. Returns its bound address.
pub(crate) async fn start_test_server(cfg: TestServerConfig) -> SocketAddr {
    let host_key = cfg.host_key.clone();
    let server_config = Arc::new(ServerConfig {
        keys: vec![host_key],
        // Short auth rejection times so failure tests don't take forever.
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        ..Default::default()
    });

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = TestServer {
        cfg: Arc::new(cfg),
    };

    tokio::spawn(async move {
        loop {
            let (sock, peer) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let mut srv = server.clone();
            let handler = russh::server::Server::new_client(&mut srv, Some(peer));
            let cfg = server_config.clone();
            tokio::spawn(async move {
                let _ = russh::server::run_stream(cfg, sock, handler).await;
            });
        }
    });

    addr
}

/// Generate an ephemeral Ed25519 key for testing.
pub(crate) fn ephemeral_ed25519() -> PrivateKey {
    PrivateKey::random(&mut rand::rngs::OsRng, ssh_key::Algorithm::Ed25519).unwrap()
}

/// Write a temporary key file for publickey auth tests. Returns the path.
pub(crate) fn write_temp_key(key: &PrivateKey) -> std::path::PathBuf {
    let dir = tempfile::tempdir().unwrap().keep();
    let path = dir.join("id_test");
    let pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();
    std::fs::write(&path, pem.as_bytes()).unwrap();
    path
}

/// Convenience helper: start a jump host and a target host with password auth
/// and direct-tcpip allowed on the jump.
///
/// Returns (jump_addr, target_addr).
///
/// This is the common pattern for jump-chain tests:
/// - Jump accepts (jump_user, jump_pw) password auth + allows forwarding
/// - Target accepts (target_user, target_pw) password auth + denies forwarding
pub(crate) async fn start_jump_and_target(
    jump_user: &str,
    jump_pw: &str,
    target_user: &str,
    target_pw: &str,
) -> (SocketAddr, SocketAddr) {
    let jump_addr = start_test_server(TestServerConfig {
        accept_password: Some((jump_user.into(), jump_pw.into())),
        accept_key_user: None,
        allow_direct_tcpip: true,
        exec_responder: None,
        eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
    })
    .await;

    let target_addr = start_test_server(TestServerConfig {
        accept_password: Some((target_user.into(), target_pw.into())),
        accept_key_user: None,
        allow_direct_tcpip: false,
        exec_responder: None,
        eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
    })
    .await;

    (jump_addr, target_addr)
}
