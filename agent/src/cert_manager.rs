//! SSH Certificate Manager
//!
//! Handles the lifecycle of SSH certificates:
//! - Ed25519 keypair generation and vault storage
//! - Certificate signing via Controller API
//! - Auto-renewal timer
//! - Certificate status API for frontend

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::crypto;

/// Certificate auth state
#[derive(Debug, Clone, Serialize)]
pub struct CertStatus {
    pub valid: bool,
    pub expires_at: Option<String>,
    pub public_key_fingerprint: Option<String>,
    pub error: Option<String>,
}

/// Signed certificate response from controller login
#[derive(Debug, Clone, Deserialize)]
pub struct SignedCertInfo {
    pub certificate: String,
    pub ca_public_key: String,
    #[serde(rename = "valid_after")]
    pub _valid_after: String,
    pub valid_before: String,
    #[serde(rename = "serial")]
    pub _serial: i64,
}

/// Internal cert state
#[derive(Debug)]
struct CertState {
    _private_key_pem: Option<String>,
    public_key_openssh: Option<String>,
    certificate_openssh: Option<String>,
    cert_expiry: Option<DateTime<Utc>>,
    ca_public_key: Option<String>,
}

pub struct CertManager {
    pool: SqlitePool,
    state: RwLock<CertState>,
}

impl CertManager {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            state: RwLock::new(CertState {
                _private_key_pem: None,
                public_key_openssh: None,
                certificate_openssh: None,
                cert_expiry: None,
                ca_public_key: None,
            }),
        }
    }

    /// Initialize: load existing state from DB or generate new keypair
    pub async fn _initialize(&self, master_password: &str) -> Result<(), String> {
        // Try loading existing state from DB
        let row: Option<_CertAuthRow> = sqlx::query_as(
            "SELECT private_key_encrypted, public_key_openssh, certificate_openssh, cert_expiry, ca_public_key
             FROM cert_auth_state WHERE id = 1"
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("DB error: {}", e))?;

        if let Some(row) = row {
            // Decrypt private key
            let encrypted = crypto::EncryptedData::from_bytes(&row.private_key_encrypted)
                .map_err(|e| format!("Decrypt error: {}", e))?;
            let private_key_pem = crypto::decrypt(&encrypted, master_password)
                .map_err(|e| format!("Decrypt error: {}", e))?;

            let cert_expiry = row.cert_expiry
                .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                .map(|dt| dt.with_timezone(&Utc));

            let mut state = self.state.write().await;
            state._private_key_pem = Some(private_key_pem);
            state.public_key_openssh = Some(row.public_key_openssh);
            state.certificate_openssh = row.certificate_openssh;
            state.cert_expiry = cert_expiry;
            state.ca_public_key = row.ca_public_key;

            tracing::info!("Loaded existing SSH certificate auth state");
        } else {
            // Generate new Ed25519 keypair
            self._generate_keypair(master_password).await?;
        }

        Ok(())
    }

    /// Generate a new Ed25519 keypair and store in DB
    async fn _generate_keypair(&self, master_password: &str) -> Result<(), String> {
        use ssh_key::{Algorithm, LineEnding, PrivateKey};
        use rand::rngs::OsRng;

        let private_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
            .map_err(|e| format!("Key generation error: {}", e))?;

        let private_key_pem = private_key
            .to_openssh(LineEnding::LF)
            .map_err(|e| format!("Key export error: {}", e))?
            .to_string();

        let public_key_openssh = private_key.public_key().to_openssh()
            .map_err(|e| format!("Public key export error: {}", e))?;

        // Encrypt private key for storage
        let encrypted = crypto::encrypt(&private_key_pem, master_password)
            .map_err(|e| format!("Encrypt error: {}", e))?;

        // Store in DB
        sqlx::query(
            "INSERT OR REPLACE INTO cert_auth_state (id, private_key_encrypted, public_key_openssh)
             VALUES (1, $1, $2)"
        )
        .bind(encrypted.to_bytes())
        .bind(&public_key_openssh)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("DB error: {}", e))?;

        let mut state = self.state.write().await;
        state._private_key_pem = Some(private_key_pem);
        state.public_key_openssh = Some(public_key_openssh);

        tracing::info!("Generated new Ed25519 keypair for certificate auth");
        Ok(())
    }

    /// Get the public key in OpenSSH format (for sending to controller during login)
    pub async fn get_public_key(&self) -> Option<String> {
        self.state.read().await.public_key_openssh.clone()
    }

    /// Store a signed certificate received from the controller
    pub async fn store_certificate(&self, cert_info: &SignedCertInfo) -> Result<(), String> {
        let cert_expiry = &cert_info.valid_before;

        sqlx::query(
            "UPDATE cert_auth_state SET certificate_openssh = $1, cert_expiry = $2, ca_public_key = $3, updated_at = datetime('now')
             WHERE id = 1"
        )
        .bind(&cert_info.certificate)
        .bind(cert_expiry)
        .bind(&cert_info.ca_public_key)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("DB error: {}", e))?;

        let expiry = DateTime::parse_from_rfc3339(cert_expiry)
            .ok()
            .map(|dt| dt.with_timezone(&Utc));

        let mut state = self.state.write().await;
        state.certificate_openssh = Some(cert_info.certificate.clone());
        state.cert_expiry = expiry;
        state.ca_public_key = Some(cert_info.ca_public_key.clone());

        tracing::info!("Stored signed SSH certificate, expires: {}", cert_expiry);
        Ok(())
    }

    /// Get current certificate status for frontend
    pub async fn get_status(&self) -> CertStatus {
        let state = self.state.read().await;
        let valid = match (&state.certificate_openssh, state.cert_expiry) {
            (Some(_), Some(expiry)) => Utc::now() < expiry,
            _ => false,
        };

        CertStatus {
            valid,
            expires_at: state.cert_expiry.map(|e| e.to_rfc3339()),
            public_key_fingerprint: state.public_key_openssh.as_ref().map(|k| {
                let parts: Vec<&str> = k.split_whitespace().collect();
                if parts.len() >= 2 {
                    let key_data = parts[1];
                    if key_data.len() > 16 {
                        format!("...{}", &key_data[key_data.len()-16..])
                    } else {
                        key_data.to_string()
                    }
                } else {
                    "unknown".to_string()
                }
            }),
            error: None,
        }
    }

    /// Get auth material for SSH connections (private key PEM + certificate)
    pub async fn _get_auth_material(&self) -> Option<(String, String)> {
        let state = self.state.read().await;
        match (&state._private_key_pem, &state.certificate_openssh, state.cert_expiry) {
            (Some(key), Some(cert), Some(expiry)) if Utc::now() < expiry => {
                Some((key.clone(), cert.clone()))
            }
            _ => None,
        }
    }
}

/// DB row for cert_auth_state
#[derive(sqlx::FromRow)]
struct _CertAuthRow {
    private_key_encrypted: Vec<u8>,
    public_key_openssh: String,
    certificate_openssh: Option<String>,
    cert_expiry: Option<String>,
    ca_public_key: Option<String>,
}
