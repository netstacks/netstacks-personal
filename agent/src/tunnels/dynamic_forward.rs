//! SOCKS5 dynamic port forwarding via SSH (RFC 1928).
//!
//! Binds a local TCP listener and acts as a SOCKS5 proxy. For each incoming
//! connection, performs the SOCKS5 handshake to determine the target host:port,
//! then opens an SSH `channel_open_direct_tcpip` channel and bridges data
//! bidirectionally between the TCP stream and the SSH channel.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::PooledConnection;

// SOCKS5 constants
const SOCKS_VERSION: u8 = 0x05;
const AUTH_NO_AUTH: u8 = 0x00;
const AUTH_NO_ACCEPTABLE: u8 = 0xFF;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;
const REPLY_SUCCESS: u8 = 0x00;
const REPLY_GENERAL_FAILURE: u8 = 0x01;
const REPLY_CMD_NOT_SUPPORTED: u8 = 0x07;
const REPLY_ATYP_NOT_SUPPORTED: u8 = 0x08;

/// Run a SOCKS5 dynamic forward proxy: bind a TCP listener on
/// `bind_address:local_port` and for each accepted connection, perform the
/// SOCKS5 handshake, open an SSH direct-tcpip channel to the requested target,
/// then bridge data in both directions.
///
/// Returns when the cancellation token is triggered or a fatal bind error occurs.
pub async fn run_socks5_proxy(
    conn: Arc<Mutex<PooledConnection>>,
    bind_address: &str,
    local_port: u16,
    cancel: CancellationToken,
    bytes_tx: Arc<AtomicU64>,
    bytes_rx: Arc<AtomicU64>,
) -> Result<(), String> {
    let addr = format!("{}:{}", bind_address, local_port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind {}: {}", addr, e))?;

    tracing::info!("SOCKS5 dynamic forward listening on {}", addr);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                tracing::info!("SOCKS5 proxy on {} cancelled", addr);
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, peer)) => {
                        tracing::debug!("SOCKS5 accepted connection from {} on {}", peer, addr);
                        let conn = conn.clone();
                        let cancel = cancel.clone();
                        let bytes_tx = bytes_tx.clone();
                        let bytes_rx = bytes_rx.clone();

                        tokio::spawn(async move {
                            if let Err(e) = handle_socks5_connection(
                                conn,
                                stream,
                                cancel,
                                bytes_tx,
                                bytes_rx,
                            )
                            .await
                            {
                                tracing::warn!("SOCKS5 connection from {} failed: {}", peer, e);
                            }
                        });
                    }
                    Err(e) => {
                        tracing::error!("SOCKS5 accept error on {}: {}", addr, e);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Handle a single SOCKS5 client connection: negotiate auth, parse the CONNECT
/// request, open an SSH channel, then bridge data.
async fn handle_socks5_connection(
    conn: Arc<Mutex<PooledConnection>>,
    mut stream: tokio::net::TcpStream,
    cancel: CancellationToken,
    bytes_tx: Arc<AtomicU64>,
    bytes_rx: Arc<AtomicU64>,
) -> Result<(), String> {
    // --- Step 1: Method negotiation ---
    // Client sends: version(1) + nmethods(1) + methods(nmethods)
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("Failed to read SOCKS5 greeting: {}", e))?;

    if header[0] != SOCKS_VERSION {
        return Err(format!("Unsupported SOCKS version: {}", header[0]));
    }

    let nmethods = header[1] as usize;
    let mut methods = vec![0u8; nmethods];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| format!("Failed to read SOCKS5 methods: {}", e))?;

    // We only support no-auth (0x00)
    if methods.contains(&AUTH_NO_AUTH) {
        stream
            .write_all(&[SOCKS_VERSION, AUTH_NO_AUTH])
            .await
            .map_err(|e| format!("Failed to send auth method: {}", e))?;
    } else {
        stream
            .write_all(&[SOCKS_VERSION, AUTH_NO_ACCEPTABLE])
            .await
            .map_err(|e| format!("Failed to send auth rejection: {}", e))?;
        return Err("Client does not support no-auth method".to_string());
    }

    // --- Step 2: Parse CONNECT request ---
    // Client sends: version(1) + cmd(1) + reserved(1) + atyp(1) + addr(variable) + port(2)
    let mut req_header = [0u8; 4];
    stream
        .read_exact(&mut req_header)
        .await
        .map_err(|e| format!("Failed to read SOCKS5 request: {}", e))?;

    if req_header[0] != SOCKS_VERSION {
        return Err(format!(
            "Unexpected SOCKS version in request: {}",
            req_header[0]
        ));
    }

    let cmd = req_header[1];
    let atyp = req_header[3];

    if cmd != CMD_CONNECT {
        // Send command-not-supported reply
        send_reply(&mut stream, REPLY_CMD_NOT_SUPPORTED).await?;
        return Err(format!("Unsupported SOCKS5 command: {}", cmd));
    }

    // Parse target address based on address type
    let target_host = match atyp {
        ATYP_IPV4 => {
            let mut addr = [0u8; 4];
            stream
                .read_exact(&mut addr)
                .await
                .map_err(|e| format!("Failed to read IPv4 address: {}", e))?;
            format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
        }
        ATYP_DOMAIN => {
            let mut len_buf = [0u8; 1];
            stream
                .read_exact(&mut len_buf)
                .await
                .map_err(|e| format!("Failed to read domain length: {}", e))?;
            let domain_len = len_buf[0] as usize;
            let mut domain = vec![0u8; domain_len];
            stream
                .read_exact(&mut domain)
                .await
                .map_err(|e| format!("Failed to read domain: {}", e))?;
            String::from_utf8(domain)
                .map_err(|e| format!("Invalid domain encoding: {}", e))?
        }
        ATYP_IPV6 => {
            let mut addr = [0u8; 16];
            stream
                .read_exact(&mut addr)
                .await
                .map_err(|e| format!("Failed to read IPv6 address: {}", e))?;
            let segments: Vec<String> = (0..8)
                .map(|i| format!("{:x}", u16::from_be_bytes([addr[i * 2], addr[i * 2 + 1]])))
                .collect();
            segments.join(":")
        }
        _ => {
            send_reply(&mut stream, REPLY_ATYP_NOT_SUPPORTED).await?;
            return Err(format!("Unsupported address type: {}", atyp));
        }
    };

    // Read port (2 bytes, big-endian)
    let mut port_buf = [0u8; 2];
    stream
        .read_exact(&mut port_buf)
        .await
        .map_err(|e| format!("Failed to read target port: {}", e))?;
    let target_port = u16::from_be_bytes(port_buf);

    tracing::debug!("SOCKS5 CONNECT to {}:{}", target_host, target_port);

    // --- Step 3: Open SSH channel ---
    let channel_result = {
        let guard = conn.lock().await;
        guard
            .handle
            .channel_open_direct_tcpip(
                target_host.as_str(),
                target_port as u32,
                "127.0.0.1",
                0u32,
            )
            .await
    };

    let mut channel = match channel_result {
        Ok(ch) => {
            // Send success reply
            send_reply(&mut stream, REPLY_SUCCESS).await?;
            ch
        }
        Err(e) => {
            // Send general failure reply
            send_reply(&mut stream, REPLY_GENERAL_FAILURE).await?;
            return Err(format!(
                "Failed to open direct-tcpip channel to {}:{}: {}",
                target_host, target_port, e
            ));
        }
    };

    // --- Step 4: Bridge data bidirectionally ---
    let (mut tcp_read, mut tcp_write) = stream.split();
    let mut buf = [0u8; 32768];

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                break;
            }

            // TCP -> SSH: read from SOCKS5 client, send to SSH channel
            result = tcp_read.read(&mut buf) => {
                match result {
                    Ok(0) => {
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
                        tracing::debug!("SOCKS5 TCP read error: {}", e);
                        break;
                    }
                }
            }

            // SSH -> TCP: read from SSH channel, write to SOCKS5 client
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

/// Send a SOCKS5 reply with the given status code.
/// Reply format: version(0x05) + status + reserved(0x00) + atyp(0x01) + addr(4 zeros) + port(2 zeros)
async fn send_reply(
    stream: &mut tokio::net::TcpStream,
    status: u8,
) -> Result<(), String> {
    let reply = [
        SOCKS_VERSION,
        status,
        0x00, // reserved
        ATYP_IPV4,
        0, 0, 0, 0, // bound address (zeros)
        0, 0, // bound port (zeros)
    ];
    stream
        .write_all(&reply)
        .await
        .map_err(|e| format!("Failed to send SOCKS5 reply: {}", e))
}
