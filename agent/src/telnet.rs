//! Telnet client for legacy device connections
//!
//! Implements Telnet protocol over raw TCP with:
//! - IAC option negotiation (echo, terminal type, NAWS)
//! - Credential prompt auto-detection and injection
//! - Same send/recv interface as SshSession

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

/// Telnet IAC (Interpret As Command) bytes
const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250; // Sub-negotiation Begin
const SE: u8 = 240; // Sub-negotiation End

/// Telnet options
const OPT_ECHO: u8 = 1;
const OPT_SUPPRESS_GO_AHEAD: u8 = 3;
const OPT_TERMINAL_TYPE: u8 = 24;
const OPT_NAWS: u8 = 31; // Negotiate About Window Size

#[derive(Debug)]
pub enum TelnetError {
    ConnectionFailed(String),
    IoError(std::io::Error),
    ChannelClosed,
}

impl std::fmt::Display for TelnetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TelnetError::ConnectionFailed(msg) => write!(f, "Connection failed: {}", msg),
            TelnetError::IoError(e) => write!(f, "IO error: {}", e),
            TelnetError::ChannelClosed => write!(f, "Channel closed"),
        }
    }
}

impl From<std::io::Error> for TelnetError {
    fn from(e: std::io::Error) -> Self {
        TelnetError::IoError(e)
    }
}

pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// A Telnet session with the same send/recv interface as SshSession
pub struct TelnetSession {
    input_tx: mpsc::UnboundedSender<Vec<u8>>,
    output_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
}

impl TelnetSession {
    /// Connect to a Telnet host and optionally auto-inject credentials
    pub async fn connect(config: TelnetConfig) -> Result<Self, TelnetError> {
        let addr = format!("{}:{}", config.host, config.port);
        let stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| TelnetError::ConnectionFailed(format!("{}: {}", addr, e)))?;

        let (read_half, write_half) = tokio::io::split(stream);
        let read_half = Arc::new(Mutex::new(read_half));
        let write_half = Arc::new(Mutex::new(write_half));

        // Channels for the public API
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (output_tx, output_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        // Spawn the I/O task
        let write_clone = write_half.clone();
        let username = config.username;
        let password = config.password;

        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            let mut auth_state = AuthState::new(username, password);

            loop {
                tokio::select! {
                    // Read from socket
                    result = async {
                        let mut reader = read_half.lock().await;
                        reader.read(&mut buf).await
                    } => {
                        match result {
                            Ok(0) => break, // Connection closed
                            Ok(n) => {
                                let raw = &buf[..n];
                                let (clean_data, responses) = process_telnet_data(raw);

                                // Send IAC responses
                                if !responses.is_empty() {
                                    let mut writer = write_clone.lock().await;
                                    let _ = writer.write_all(&responses).await;
                                    let _ = writer.flush().await;
                                }

                                // Handle credential injection
                                if !clean_data.is_empty() {
                                    if let Some(response) = auth_state.check_and_respond(&clean_data) {
                                        let mut writer = write_clone.lock().await;
                                        let _ = writer.write_all(response.as_bytes()).await;
                                        let _ = writer.flush().await;
                                    }

                                    // Forward clean data to output
                                    if output_tx.send(clean_data).is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }

                    // Write from user input
                    data = input_rx.recv() => {
                        match data {
                            Some(bytes) => {
                                let mut writer = write_clone.lock().await;
                                if writer.write_all(&bytes).await.is_err() {
                                    break;
                                }
                                let _ = writer.flush().await;
                            }
                            None => break, // Input channel closed
                        }
                    }
                }
            }
        });

        Ok(Self {
            input_tx,
            output_rx: Mutex::new(output_rx),
        })
    }

    /// Send data to the remote host
    pub async fn send(&self, data: &[u8]) -> Result<(), TelnetError> {
        self.input_tx
            .send(data.to_vec())
            .map_err(|_| TelnetError::ChannelClosed)
    }

    /// Receive data from the remote host
    pub async fn recv(&self) -> Result<Option<Vec<u8>>, TelnetError> {
        let mut rx = self.output_rx.lock().await;
        match rx.recv().await {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }

    /// Send NAWS sub-negotiation (RFC 1073) with current window size
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), TelnetError> {
        // IAC SB NAWS WIDTH[1] WIDTH[0] HEIGHT[1] HEIGHT[0] IAC SE
        let msg = vec![
            IAC, SB, OPT_NAWS,
            (cols >> 8) as u8, (cols & 0xff) as u8,
            (rows >> 8) as u8, (rows & 0xff) as u8,
            IAC, SE,
        ];
        self.send(&msg).await
    }
}

/// Process raw Telnet data: strip IAC commands, return clean data + IAC responses
fn process_telnet_data(data: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut clean = Vec::with_capacity(data.len());
    let mut responses = Vec::new();
    let mut i = 0;

    while i < data.len() {
        if data[i] == IAC && i + 1 < data.len() {
            match data[i + 1] {
                // Double IAC = literal 0xFF
                IAC => {
                    clean.push(IAC);
                    i += 2;
                }
                DO => {
                    if i + 2 < data.len() {
                        let opt = data[i + 2];
                        match opt {
                            OPT_TERMINAL_TYPE | OPT_SUPPRESS_GO_AHEAD | OPT_NAWS => {
                                responses.extend_from_slice(&[IAC, WILL, opt]);
                            }
                            _ => {
                                // Refuse everything else
                                responses.extend_from_slice(&[IAC, WONT, opt]);
                            }
                        }
                        i += 3;
                    } else {
                        i += 2;
                    }
                }
                WILL => {
                    if i + 2 < data.len() {
                        let opt = data[i + 2];
                        match opt {
                            OPT_ECHO | OPT_SUPPRESS_GO_AHEAD => {
                                // Accept echo and suppress-go-ahead from server
                                responses.extend_from_slice(&[IAC, DO, opt]);
                            }
                            _ => {
                                responses.extend_from_slice(&[IAC, DONT, opt]);
                            }
                        }
                        i += 3;
                    } else {
                        i += 2;
                    }
                }
                WONT | DONT => {
                    // Acknowledge
                    i += if i + 2 < data.len() { 3 } else { 2 };
                }
                SB => {
                    // Skip sub-negotiation until SE
                    let start = i;
                    i += 2;
                    while i < data.len() {
                        if data[i] == IAC && i + 1 < data.len() && data[i + 1] == SE {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                    // If it was a terminal type request, respond
                    if start + 2 < data.len() && data[start + 2] == OPT_TERMINAL_TYPE {
                        let term_type = b"xterm-256color";
                        responses.push(IAC);
                        responses.push(SB);
                        responses.push(OPT_TERMINAL_TYPE);
                        responses.push(0); // IS
                        responses.extend_from_slice(term_type);
                        responses.push(IAC);
                        responses.push(SE);
                    }
                }
                _ => {
                    i += 2;
                }
            }
        } else {
            clean.push(data[i]);
            i += 1;
        }
    }

    (clean, responses)
}

/// Tracks credential auto-injection state
struct AuthState {
    username: Option<String>,
    password: Option<String>,
    sent_username: bool,
    sent_password: bool,
    /// Buffer of recently received text for prompt detection
    recent_text: String,
}

impl AuthState {
    fn new(username: Option<String>, password: Option<String>) -> Self {
        Self {
            username,
            password,
            sent_username: false,
            sent_password: false,
            recent_text: String::new(),
        }
    }

    /// Check incoming data for login prompts and return credential to send
    fn check_and_respond(&mut self, data: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(data);
        self.recent_text.push_str(&text);

        // Keep only last 256 chars for prompt detection
        if self.recent_text.len() > 256 {
            let start = self.recent_text.len() - 256;
            self.recent_text = self.recent_text[start..].to_string();
        }

        let lower = self.recent_text.to_lowercase();

        // Check for username prompt
        if !self.sent_username {
            if let Some(ref username) = self.username {
                if lower.ends_with("username:")
                    || lower.ends_with("login:")
                    || lower.ends_with("user:")
                    || lower.ends_with("username: ")
                    || lower.ends_with("login: ")
                    || lower.ends_with("user: ")
                    || lower.ends_with("user name:")
                    || lower.ends_with("user name: ")
                {
                    self.sent_username = true;
                    self.recent_text.clear();
                    return Some(format!("{}\r\n", username));
                }
            }
        }

        // Check for password prompt
        if self.sent_username && !self.sent_password {
            if let Some(ref password) = self.password {
                if lower.ends_with("password:")
                    || lower.ends_with("password: ")
                    || lower.ends_with("secret:")
                    || lower.ends_with("secret: ")
                {
                    self.sent_password = true;
                    self.recent_text.clear();
                    return Some(format!("{}\r\n", password));
                }
            }
        }

        None
    }
}
