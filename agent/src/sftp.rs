//! SFTP session management using russh-sftp.
//!
//! Provides file browser functionality alongside terminal sessions.

use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, Algorithm, EcdsaCurve, HashAlg};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::{cipher, kex, mac, Channel};
use russh_sftp::client::SftpSession as RusshSftpSession;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};

/// SFTP-related errors.
#[derive(Error, Debug)]
pub enum SftpError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("Key error: {0}")]
    KeyError(String),

    #[error("Channel error: {0}")]
    ChannelError(String),

    #[error("SFTP error: {0}")]
    SftpError(String),

    #[error("File not found: {0}")]
    _NotFound(String),

    #[error("Permission denied: {0}")]
    _PermissionDenied(String),

    #[error("Session not found")]
    SessionNotFound,

    #[error("Session closed")]
    _SessionClosed,
}

impl From<russh::Error> for SftpError {
    fn from(e: russh::Error) -> Self {
        SftpError::ConnectionFailed(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for SftpError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        SftpError::SftpError(e.to_string())
    }
}

/// SSH authentication method (reused from ssh module).
#[derive(Clone)]
pub enum SftpAuth {
    /// Password authentication.
    Password(String),
    /// Key file authentication with optional passphrase.
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
}

/// SFTP connection configuration.
#[derive(Clone)]
pub struct SftpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SftpAuth,
}

/// File entry information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

/// Client handler for russh.
struct SftpClientHandler {
    host: String,
    port: u16,
    host_key_store: Arc<tokio::sync::Mutex<crate::ssh::host_keys::HostKeyStore>>,
}

impl client::Handler for SftpClientHandler {
    type Error = SftpError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // AUDIT FIX (REMOTE-002): the global "disable host-key checking"
        // toggle has been removed. SFTP now always uses strict TOFU —
        // unknown keys are accepted on first sight and stored, but a
        // *changed* key is rejected. (This matches `connect_and_authenticate`
        // when `auto_accept_changed_keys=false`.)
        let mut store = self.host_key_store.lock().await;
        store.verify_or_store(&self.host, self.port, server_public_key, false)
            .map_err(|e| SftpError::KeyError(e.to_string()))
    }
}

/// An active SFTP session.
pub struct SftpSession {
    _handle: Handle<SftpClientHandler>,
    sftp: RusshSftpSession,
    _channel: Channel<Msg>,
}

impl SftpSession {
    /// Connect to an SSH server and start an SFTP session.
    pub async fn connect(config: SftpConfig) -> Result<Self, SftpError> {
        // Build config with comprehensive algorithm support (matching SecureCRT)
        let mut cfg = client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            ..Default::default()
        };

        // Comprehensive algorithm support matching SecureCRT
        cfg.preferred = russh::Preferred {
            kex: Cow::Owned(vec![
                kex::CURVE25519,
                kex::CURVE25519_PRE_RFC_8731,
                kex::ECDH_SHA2_NISTP256,
                kex::ECDH_SHA2_NISTP384,
                kex::ECDH_SHA2_NISTP521,
                kex::DH_G16_SHA512,
                kex::DH_G14_SHA256,
                kex::DH_G14_SHA1,
                kex::DH_G1_SHA1,
            ]),
            key: Cow::Owned(vec![
                Algorithm::Ed25519,
                Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
                Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
                Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
                Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
                Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
                Algorithm::Rsa { hash: None },
                Algorithm::Dsa,
            ]),
            cipher: Cow::Owned(vec![
                cipher::CHACHA20_POLY1305,
                cipher::AES_256_GCM,
                cipher::AES_256_CTR,
                cipher::AES_192_CTR,
                cipher::AES_128_CTR,
                cipher::AES_256_CBC,
                cipher::AES_192_CBC,
                cipher::AES_128_CBC,
            ]),
            mac: Cow::Owned(vec![
                mac::HMAC_SHA512_ETM,
                mac::HMAC_SHA256_ETM,
                mac::HMAC_SHA512,
                mac::HMAC_SHA256,
                mac::HMAC_SHA1_ETM,
                mac::HMAC_SHA1,
            ]),
            ..Default::default()
        };

        let russh_config = Arc::new(cfg);

        let addr = format!("{}:{}", config.host, config.port);

        // Load host key store for verification
        let host_key_store = crate::ssh::host_keys::load_default_store();

        let handler = SftpClientHandler {
            host: config.host.clone(),
            port: config.port,
            host_key_store,
        };

        let mut handle = client::connect(russh_config, &addr, handler)
            .await
            .map_err(|e| SftpError::ConnectionFailed(format!(
                "{}:{} - {}",
                config.host, config.port, e
            )))?;

        // Authenticate
        let auth_method_desc = match &config.auth {
            SftpAuth::Password(_) => "password".to_string(),
            SftpAuth::KeyFile { path, .. } => format!("key ({})", path),
        };

        let authenticated = match &config.auth {
            SftpAuth::Password(password) => {
                let result = handle
                    .authenticate_password(&config.username, password)
                    .await
                    .map_err(|e| SftpError::AuthFailed(format!(
                        "password auth for '{}@{}' failed: {}",
                        config.username, config.host, e
                    )))?;
                matches!(result, russh::client::AuthResult::Success)
            }
            SftpAuth::KeyFile { path, passphrase } => {
                let key_path = Path::new(path);
                let key_pair = load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| SftpError::KeyError(format!(
                        "failed to load key '{}': {}",
                        path, e
                    )))?;

                // Use PrivateKeyWithHashAlg for proper RSA signature algorithm support
                let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key_pair), None);
                let result = handle
                    .authenticate_publickey(&config.username, key_with_hash)
                    .await
                    .map_err(|e| SftpError::AuthFailed(format!(
                        "key auth for '{}@{}' using '{}' failed: {}",
                        config.username, config.host, path, e
                    )))?;
                matches!(result, russh::client::AuthResult::Success)
            }
        };

        if !authenticated {
            return Err(SftpError::AuthFailed(format!(
                "server rejected {} authentication for '{}@{}' - verify username and credentials",
                auth_method_desc, config.username, config.host
            )));
        }

        // Open session channel for SFTP subsystem
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;

        // Request SFTP subsystem
        channel
            .request_subsystem(false, "sftp")
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;

        // Create SFTP session
        let sftp = RusshSftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        // Re-open a channel reference for management (we gave ownership to stream)
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;

        Ok(Self {
            _handle: handle,
            sftp,
            _channel: channel,
        })
    }

    /// List directory contents.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, SftpError> {
        let dir = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        let mut entries = Vec::new();
        for entry in dir {
            let file_name = entry.file_name();
            let file_path = if path == "/" || path.is_empty() {
                format!("/{}", file_name)
            } else {
                format!("{}/{}", path.trim_end_matches('/'), file_name)
            };

            let attrs = entry.metadata();
            let is_dir = attrs.is_dir();
            let size = attrs.len();
            // Get mtime from metadata - convert u32 to u64
            let modified = attrs.mtime.map(|t| t as u64);
            // permissions is already a u32
            let permissions = attrs.permissions;

            entries.push(FileEntry {
                name: file_name,
                path: file_path,
                is_dir,
                size,
                modified,
                permissions,
            });
        }

        // Sort: directories first, then by name
        entries.sort_by(|a, b| {
            match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(entries)
    }

    /// Download a file and return its contents.
    pub async fn download(&self, path: &str) -> Result<Vec<u8>, SftpError> {
        use tokio::io::AsyncReadExt;

        let mut file = self
            .sftp
            .open(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        Ok(data)
    }

    /// Upload a file with the given contents.
    pub async fn upload(&self, path: &str, data: &[u8]) -> Result<(), SftpError> {
        use tokio::io::AsyncWriteExt;

        let mut file = self
            .sftp
            .create(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        file.write_all(data)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        file.shutdown()
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        Ok(())
    }

    /// Create a directory.
    pub async fn mkdir(&self, path: &str) -> Result<(), SftpError> {
        self.sftp
            .create_dir(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))
    }

    /// Remove a file.
    pub async fn rm(&self, path: &str) -> Result<(), SftpError> {
        self.sftp
            .remove_file(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))
    }

    /// Remove a directory.
    pub async fn rmdir(&self, path: &str) -> Result<(), SftpError> {
        self.sftp
            .remove_dir(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))
    }

    /// Rename a file or directory.
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), SftpError> {
        self.sftp
            .rename(from, to)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))
    }

    /// Get file/directory info.
    pub async fn stat(&self, path: &str) -> Result<FileEntry, SftpError> {
        let metadata = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))?;

        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());

        let is_dir = metadata.is_dir();
        let size = metadata.len();
        let modified = metadata.mtime.map(|t| t as u64);
        let permissions = metadata.permissions;

        Ok(FileEntry {
            name,
            path: path.to_string(),
            is_dir,
            size,
            modified,
            permissions,
        })
    }

    /// Get current working directory.
    pub async fn pwd(&self) -> Result<String, SftpError> {
        self.sftp
            .canonicalize(".")
            .await
            .map_err(|e| SftpError::SftpError(e.to_string()))
    }
}

/// Manager for SFTP sessions.
pub struct SftpManager {
    sessions: RwLock<HashMap<String, Arc<Mutex<SftpSession>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Create a new SFTP session.
    pub async fn create_session(
        &self,
        session_id: String,
        config: SftpConfig,
    ) -> Result<(), SftpError> {
        let session = SftpSession::connect(config).await?;

        self.sessions
            .write()
            .await
            .insert(session_id, Arc::new(Mutex::new(session)));

        Ok(())
    }

    /// Get a session by ID.
    pub async fn get_session(&self, session_id: &str) -> Option<Arc<Mutex<SftpSession>>> {
        self.sessions.read().await.get(session_id).cloned()
    }

    /// Check if a session exists.
    pub async fn _has_session(&self, session_id: &str) -> bool {
        self.sessions.read().await.contains_key(session_id)
    }

    /// Remove a session.
    pub async fn remove_session(&self, session_id: &str) {
        self.sessions.write().await.remove(session_id);
    }

    /// List all active session IDs.
    pub async fn _list_sessions(&self) -> Vec<String> {
        self.sessions.read().await.keys().cloned().collect()
    }
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}
