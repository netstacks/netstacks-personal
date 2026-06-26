//! Local TCP port forwarding via SSH.
//!
//! Binds a local TCP listener and for each incoming connection, opens an SSH
//! direct-tcpip channel to the remote host:port, then bridges data
//! bidirectionally between the TCP stream and the SSH channel.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::PooledConnection;

/// Run a local forward: bind a TCP listener on `bind_address:local_port` and
/// for each accepted connection, open an SSH direct-tcpip channel to
/// `remote_host:remote_port`, then bridge data in both directions.
///
/// Returns when the cancellation token is triggered or a fatal bind error occurs.
pub async fn run_local_forward(
    conn: Arc<Mutex<PooledConnection>>,
    bind_address: &str,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
    cancel: CancellationToken,
    bytes_tx: Arc<AtomicU64>,
    bytes_rx: Arc<AtomicU64>,
) -> Result<(), String> {
    let addr = format!("{}:{}", bind_address, local_port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind {}: {}", addr, e))?;

    tracing::info!(
        "Local forward listening on {} -> {}:{}",
        addr,
        remote_host,
        remote_port
    );

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                tracing::info!("Local forward on {} cancelled", addr);
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, peer)) => {
                        tracing::debug!("Accepted connection from {} on {}", peer, addr);
                        let conn = conn.clone();
                        let remote_host = remote_host.to_string();
                        let cancel = cancel.clone();
                        let bytes_tx = bytes_tx.clone();
                        let bytes_rx = bytes_rx.clone();

                        tokio::spawn(async move {
                            if let Err(e) = bridge_connection(
                                conn,
                                stream,
                                &remote_host,
                                remote_port,
                                cancel,
                                bytes_tx,
                                bytes_rx,
                            )
                            .await
                            {
                                tracing::warn!(
                                    "Bridge to {}:{} failed: {}",
                                    remote_host,
                                    remote_port,
                                    e
                                );
                            }
                        });
                    }
                    Err(e) => {
                        tracing::error!("Accept error on {}: {}", addr, e);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Bridge a single TCP connection to an SSH direct-tcpip channel.
///
/// Opens the channel via the pooled SSH handle, then copies data bidirectionally
/// until either side closes or the cancellation token fires.
async fn bridge_connection(
    conn: Arc<Mutex<PooledConnection>>,
    mut tcp_stream: tokio::net::TcpStream,
    remote_host: &str,
    remote_port: u16,
    cancel: CancellationToken,
    bytes_tx: Arc<AtomicU64>,
    bytes_rx: Arc<AtomicU64>,
) -> Result<(), String> {
    // Open a direct-tcpip channel through the SSH connection
    let mut channel = {
        let guard = conn.lock().await;
        guard
            .handle
            .channel_open_direct_tcpip(
                remote_host,
                remote_port as u32,
                "127.0.0.1",
                0,
            )
            .await
            .map_err(|e| format!("Failed to open direct-tcpip channel: {}", e))?
    };

    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
    let mut buf = [0u8; 32768];

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                break;
            }

            // TCP -> SSH: read from TCP client, send to SSH channel
            result = tcp_read.read(&mut buf) => {
                match result {
                    Ok(0) => {
                        // TCP client closed
                        let _ = channel.eof().await;
                        break;
                    }
                    Ok(n) => {
                        bytes_tx.fetch_add(n as u64, Ordering::Relaxed);
                        let mut cursor = std::io::Cursor::new(&buf[..n]);
                        if channel.data(&mut cursor).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::debug!("TCP read error: {}", e);
                        break;
                    }
                }
            }

            // SSH -> TCP: read from SSH channel, write to TCP client
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        bytes_rx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        if tcp_write.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    // Clean up
    let _ = channel.close().await;
    Ok(())
}
