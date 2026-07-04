//! SSH host key verification using known_hosts file.
//!
//! Implements TOFU (Trust On First Use) semantics for SSH host key verification.
//! New host keys are accepted and stored on first connection. Subsequent connections
//! verify against the stored key to prevent MITM attacks.

use russh::keys::ssh_key::PublicKey;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use thiserror::Error;

use super::SshError;

/// Errors that can occur during host key verification.
#[derive(Error, Debug)]
pub enum HostKeyError {
    #[error("Failed to load known_hosts file: {0}")]
    LoadError(String),

    #[error("Failed to save known_hosts file: {0}")]
    SaveError(String),

    #[error("Failed to parse host key: {0}")]
    ParseError(String),

    #[error("Host key verification failed: {0}")]
    _VerificationFailed(String),
}

impl From<HostKeyError> for SshError {
    fn from(e: HostKeyError) -> Self {
        SshError::KeyError(e.to_string())
    }
}

/// Store for managing SSH host keys using the standard known_hosts format.
///
/// The known_hosts file format is:
/// ```text
/// host:port key-type base64-key
/// ```
///
/// For example:
/// ```text
/// 192.168.1.1:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGqJ...
/// ```
pub struct HostKeyStore {
    /// Path to the known_hosts file
    path: PathBuf,
    /// In-memory cache of known host keys
    /// Key: "host:port", Value: serialized public key bytes
    known_keys: HashMap<String, Vec<u8>>,
}

impl HostKeyStore {
    /// Create a new HostKeyStore for the given known_hosts path.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            known_keys: HashMap::new(),
        }
    }

    /// Load known host keys from the known_hosts file.
    ///
    /// If the file doesn't exist, this is not an error - the store starts empty.
    /// Lines starting with '#' or empty lines are ignored.
    pub fn load_from_file(&mut self) -> Result<(), HostKeyError> {
        // If file doesn't exist, start with empty store
        if !self.path.exists() {
            tracing::debug!("Known_hosts file does not exist, starting with empty store: {:?}", self.path);
            return Ok(());
        }

        let file = fs::File::open(&self.path)
            .map_err(|e| HostKeyError::LoadError(format!("Failed to open {}: {}", self.path.display(), e)))?;

        let reader = BufReader::new(file);
        let mut line_num = 0;

        for line_result in reader.lines() {
            line_num += 1;
            let line = line_result
                .map_err(|e| HostKeyError::LoadError(format!("Failed to read line {}: {}", line_num, e)))?;

            // Skip comments and empty lines
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            // Parse line: "host:port key-type base64-key"
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 3 {
                tracing::warn!("Skipping malformed known_hosts line {}: {}", line_num, trimmed);
                continue;
            }

            let host_port = parts[0];
            let key_type = parts[1];
            let key_base64 = parts[2];

            // Reconstruct the OpenSSH public key format: "key-type base64-key"
            let openssh_key = format!("{} {}", key_type, key_base64);

            // Parse the public key
            match PublicKey::from_openssh(&openssh_key) {
                Ok(public_key) => {
                    // Store the key bytes for later comparison
                    let key_bytes = public_key.to_bytes().map_err(|e| {
                        HostKeyError::ParseError(format!("Failed to serialize key on line {}: {}", line_num, e))
                    })?;

                    self.known_keys.insert(host_port.to_string(), key_bytes);
                    tracing::trace!("Loaded known host key for {}", host_port);
                }
                Err(e) => {
                    tracing::warn!("Failed to parse key on line {}: {}", line_num, e);
                    continue;
                }
            }
        }

        tracing::info!("Loaded {} known host keys from {}", self.known_keys.len(), self.path.display());
        Ok(())
    }

    /// What the store determined about a presented host key.
    ///
    /// Used by `verify` (the new sync-friendly inspection function) so the
    /// caller can decide policy: accept silently, prompt the user, or
    /// abort. This split exists because the old combined "verify and
    /// store and decide" function couldn't be paused for a UI prompt.
    pub fn classify(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<HostKeyClassification, HostKeyError> {
        let host_port = format!("{}:{}", host, port);
        let presented = key.to_bytes().map_err(|e| {
            HostKeyError::ParseError(format!("Failed to serialize presented key: {}", e))
        })?;
        let presented_fp = fingerprint_bytes(&presented);

        Ok(match self.known_keys.get(&host_port) {
            Some(known) if known == &presented => HostKeyClassification::Matches,
            Some(known) => HostKeyClassification::Changed {
                previous_fingerprint: fingerprint_bytes(known),
                presented_fingerprint: presented_fp,
            },
            None => HostKeyClassification::Unknown {
                presented_fingerprint: presented_fp,
            },
        })
    }

    /// Persist a presented key as the trusted key for `host:port`.
    /// Called by the connect path after the user has approved a prompt
    /// (or after `auto_accept_changed_keys=true` was passed for a MOP
    /// connect that explicitly opted in).
    pub fn trust_key(&mut self, host: &str, port: u16, key: &PublicKey) -> Result<(), HostKeyError> {
        let host_port = format!("{}:{}", host, port);
        let bytes = key.to_bytes().map_err(|e| {
            HostKeyError::ParseError(format!("Failed to serialize key: {}", e))
        })?;
        self.known_keys.insert(host_port.clone(), bytes);
        self.save_to_file()?;
        tracing::warn!(
            target: "audit",
            host = %host_port,
            "host key persisted to known_hosts after explicit user approval"
        );
        Ok(())
    }

    /// Verify a host key, or store it if this is the first connection (TOFU).
    ///
    /// AUDIT FIX (REMOTE-001 partial): this remains the silent-TOFU path,
    /// kept ONLY for callers that have already obtained explicit user
    /// approval out-of-band (the `auto_accept_changed=true` MOP path
    /// that opts in to "I expect a key change because the device was just
    /// RMA'd"). New callers should use `classify()` plus the approval
    /// service, then `trust_key()` after a successful prompt.
    ///
    /// When `auto_accept_changed` is true, changed host keys are auto-accepted.
    ///
    /// Returns:
    /// - `Ok(true)` if the key matches, was auto-accepted, or was stored (first connection)
    /// - `Ok(false)` if the key does NOT match and `auto_accept_changed` is false
    /// - `Err(...)` if there was an error during verification or storage
    pub fn verify_or_store(&mut self, host: &str, port: u16, key: &PublicKey, auto_accept_changed: bool) -> Result<bool, HostKeyError> {
        let host_port = format!("{}:{}", host, port);

        // Serialize the presented key for comparison
        let presented_key_bytes = key.to_bytes()
            .map_err(|e| HostKeyError::ParseError(format!("Failed to serialize presented key: {}", e)))?;

        match self.known_keys.get(&host_port) {
            Some(known_key_bytes) if known_key_bytes == &presented_key_bytes => {
                tracing::debug!("Host key verified for {}", host_port);
                Ok(true)
            }
            Some(known_key_bytes) => {
                // Key mismatch
                if auto_accept_changed {
                    tracing::warn!(
                        "Host key changed for {} — auto-accepting new key (caller opted in). Fingerprint: {}",
                        host_port,
                        fingerprint_bytes(&presented_key_bytes)
                    );
                    self.known_keys.insert(host_port, presented_key_bytes);
                    self.save_to_file()?;
                    Ok(true)
                } else {
                    let known_fp = fingerprint_bytes(known_key_bytes);
                    let presented_fp = fingerprint_bytes(&presented_key_bytes);

                    tracing::error!(
                        "HOST KEY VERIFICATION FAILED for {}!\n\
                         Known fingerprint: {}\n\
                         Presented fingerprint: {}\n\
                         This could indicate a MITM attack or the host key has changed.",
                        host_port, known_fp, presented_fp
                    );

                    Ok(false)
                }
            }
            None => {
                // First time connecting to this host:port - TOFU (Trust On First Use)
                tracing::warn!(
                    "First connection to {} - accepting and storing host key (TOFU, caller opted in). Fingerprint: {}",
                    host_port,
                    fingerprint_bytes(&presented_key_bytes)
                );

                // Store the key
                self.known_keys.insert(host_port.clone(), presented_key_bytes);

                // Persist to disk
                self.save_to_file()?;

                Ok(true)
            }
        }
    }

    /// List every trusted host:port + fingerprint currently in the store.
    /// Used by the settings UI so a user can audit what they've TOFU'd.
    pub fn list_entries(&self) -> Vec<HostKeyEntry> {
        let mut out = Vec::with_capacity(self.known_keys.len());
        for (host_port, key_bytes) in &self.known_keys {
            // Split "host:port" — host may itself contain `:` (IPv6), so
            // partition on the LAST `:`.
            let (host, port) = match host_port.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(22)),
                None => (host_port.clone(), 22),
            };
            let key_type = PublicKey::from_bytes(key_bytes)
                .map(|pk| pk.algorithm().as_str().to_string())
                .unwrap_or_else(|_| "unknown".to_string());
            let fingerprint = fingerprint_bytes(key_bytes);
            out.push(HostKeyEntry { host, port, key_type, fingerprint });
        }
        // Stable ordering: by host, then port.
        out.sort_by(|a, b| a.host.cmp(&b.host).then(a.port.cmp(&b.port)));
        out
    }

    /// Remove the trusted host key for `host:port`. Returns true if an
    /// entry was actually removed; false if no such entry existed.
    pub fn remove_key(&mut self, host: &str, port: u16) -> Result<bool, HostKeyError> {
        let host_port = format!("{}:{}", host, port);
        if self.known_keys.remove(&host_port).is_none() {
            return Ok(false);
        }
        self.save_to_file()?;
        tracing::warn!(
            target: "audit",
            host = %host_port,
            "host key removed from known_hosts via user revoke"
        );
        Ok(true)
    }

    /// Remove ALL trusted host keys. Returns the number removed. On the next
    /// connection to any host the user will get a fresh TOFU prompt.
    pub fn clear_all(&mut self) -> Result<usize, HostKeyError> {
        let count = self.known_keys.len();
        if count == 0 {
            return Ok(0);
        }
        self.known_keys.clear();
        self.save_to_file()?;
        tracing::warn!(
            target: "audit",
            count = %count,
            "ALL host keys purged from known_hosts via user request"
        );
        Ok(count)
    }

    /// Save all known host keys to the known_hosts file.
    ///
    /// Creates the parent directory if it doesn't exist.
    fn save_to_file(&self) -> Result<(), HostKeyError> {
        // Create parent directory if needed
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| HostKeyError::SaveError(format!("Failed to create directory {}: {}", parent.display(), e)))?;
        }

        // Create or truncate the file
        let mut file = fs::File::create(&self.path)
            .map_err(|e| HostKeyError::SaveError(format!("Failed to create {}: {}", self.path.display(), e)))?;

        // Write header comment
        writeln!(file, "# SSH known hosts file managed by NetStacks")
            .map_err(|e| HostKeyError::SaveError(format!("Failed to write header: {}", e)))?;

        // Write all known keys
        for (host_port, key_bytes) in &self.known_keys {
            // Parse the key bytes back to PublicKey to get the OpenSSH format
            let public_key = PublicKey::from_bytes(key_bytes)
                .map_err(|e| HostKeyError::SaveError(format!("Failed to deserialize key for {}: {}", host_port, e)))?;

            let openssh_line = public_key.to_openssh()
                .map_err(|e| HostKeyError::SaveError(format!("Failed to serialize key to OpenSSH format for {}: {}", host_port, e)))?;

            // OpenSSH format is "key-type base64-key", we need to prepend "host:port"
            writeln!(file, "{} {}", host_port, openssh_line)
                .map_err(|e| HostKeyError::SaveError(format!("Failed to write entry for {}: {}", host_port, e)))?;
        }

        tracing::info!("Saved {} known host keys to {}", self.known_keys.len(), self.path.display());
        Ok(())
    }
}

/// One entry in the user-visible trusted-hosts list.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostKeyEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
}

/// Classification of a presented host key for the new prompt-driven flow.
pub enum HostKeyClassification {
    /// The presented key matches what's in known_hosts. Connection proceeds silently.
    Matches,
    /// No record of this host:port. Caller should prompt the user.
    Unknown { presented_fingerprint: String },
    /// host:port is known but the key is different. Strong MITM signal —
    /// caller should prompt the user with both fingerprints side-by-side.
    Changed {
        previous_fingerprint: String,
        presented_fingerprint: String,
    },
}

/// Compute a simple SHA-256 fingerprint of key bytes for logging.
///
/// Format: SHA256:base64
fn fingerprint_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hasher.finalize();

    format!("SHA256:{}", base64_encode(&hash))
}

/// Base64 encoding helper (without padding for SHA256 fingerprints).
fn base64_encode(bytes: &[u8]) -> String {
    use base64::{Engine as _, engine::general_purpose};
    general_purpose::STANDARD_NO_PAD.encode(bytes)
}

/// Get the default path to the known_hosts file.
///
/// Returns `~/.ssh/known_hosts` or `./.ssh/known_hosts` if home directory cannot be determined.
pub fn default_known_hosts_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh")
        .join("known_hosts")
}

/// Load the default HostKeyStore from ~/.ssh/known_hosts.
///
/// If the file doesn't exist or cannot be loaded, a warning is logged and an empty store is returned.
/// The store is wrapped in Arc<Mutex> for thread-safe shared access.
pub fn load_default_store() -> std::sync::Arc<tokio::sync::Mutex<HostKeyStore>> {
    let path = default_known_hosts_path();
    let mut store = HostKeyStore::new(path.clone());

    if let Err(e) = store.load_from_file() {
        tracing::warn!("Could not load known_hosts from {}: {}", path.display(), e);
    }

    std::sync::Arc::new(tokio::sync::Mutex::new(store))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn test_fingerprint_encoding() {
        let test_bytes = b"hello world";
        let fp = fingerprint_bytes(test_bytes);
        assert!(fp.starts_with("SHA256:"));
        assert!(fp.len() > 7); // SHA256: + base64 data
    }

    #[test]
    fn test_empty_store() {
        let temp_file = NamedTempFile::new().unwrap();
        let path = temp_file.path().to_path_buf();

        let mut store = HostKeyStore::new(path);
        assert!(store.load_from_file().is_ok());
        assert_eq!(store.known_keys.len(), 0);
    }
}
