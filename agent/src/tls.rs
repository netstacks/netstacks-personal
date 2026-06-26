use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};

const CERT_FILE: &str = "localhost.crt";
const KEY_FILE: &str = "localhost.key";
const VALIDITY_DAYS: u64 = 365 * 10;
const RENEW_THRESHOLD_DAYS: u64 = 30;

pub struct LocalTls {
    pub cert_pem: String,
    pub server_config: Arc<ServerConfig>,
}

/// Returns the agent data directory (same base as app-config.json).
pub fn data_dir() -> PathBuf {
    const APP_ID: &str = "com.netstacks.terminal";

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!("{}/Library/Application Support/{}", home, APP_ID))
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(format!("{}/.local/share/{}", home, APP_ID))
    }
    #[cfg(target_os = "windows")]
    {
        let app_data = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(format!("{}\\{}", app_data, APP_ID))
    }
}

/// Load existing cert if still valid, otherwise generate a new one.
pub async fn load_or_generate() -> Result<LocalTls, anyhow::Error> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);

    if cert_path.exists() && key_path.exists() && !expiring_soon(&cert_path) {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        let key_pem = std::fs::read_to_string(&key_path)?;
        match build_server_config(&cert_pem, &key_pem) {
            Ok(server_config) => {
                tracing::info!("Loaded existing localhost TLS cert from {}", cert_path.display());
                return Ok(LocalTls { cert_pem, server_config });
            }
            Err(e) => tracing::warn!("Failed to load existing TLS cert, regenerating: {}", e),
        }
    }

    generate_and_save(&cert_path, &key_path).await
}

/// True if the cert file is older than (validity - threshold) days.
fn expiring_soon(cert_path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(cert_path) else { return true };
    let Ok(modified) = meta.modified() else { return true };
    let age_secs = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_secs();
    age_secs > (VALIDITY_DAYS - RENEW_THRESHOLD_DAYS) * 86400
}

async fn generate_and_save(cert_path: &Path, key_path: &Path) -> Result<LocalTls, anyhow::Error> {
    tracing::info!("Generating new localhost TLS certificate");

    let (cert_pem, key_pem) = tokio::task::spawn_blocking(generate_cert)
        .await
        .map_err(|e| anyhow::anyhow!("TLS cert generation task panicked: {}", e))??;

    std::fs::write(cert_path, &cert_pem)?;
    std::fs::write(key_path, &key_pem)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))?;
    }

    let server_config = build_server_config(&cert_pem, &key_pem)?;
    tracing::info!("Generated and saved new localhost TLS certificate");

    Ok(LocalTls { cert_pem, server_config })
}

fn build_server_config(cert_pem: &str, key_pem: &str) -> Result<Arc<ServerConfig>, anyhow::Error> {
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()?;

    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_pem.as_bytes())?
        .ok_or_else(|| anyhow::anyhow!("No private key found in PEM"))?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    Ok(Arc::new(config))
}

fn generate_cert() -> Result<(String, String), anyhow::Error> {
    generate_cert_with_sans(&[])
}

/// Generate a self-signed TLS certificate.
///
/// Always includes localhost + 127.0.0.1. `extra_sans` adds additional
/// DNS names or IP addresses (parsed automatically from strings).
fn generate_cert_with_sans(extra_sans: &[String]) -> Result<(String, String), anyhow::Error> {
    let not_after = rcgen::date_time_ymd(
        (1970 + SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() / 31_557_600 + 10) as i32,
        1,
        1,
    );

    let mut params = CertificateParams::new(vec!["localhost".to_string()])?;
    params.subject_alt_names.push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));

    for san in extra_sans {
        let san = san.trim();
        if san.is_empty() { continue; }
        if let Ok(ip) = san.parse::<IpAddr>() {
            params.subject_alt_names.push(SanType::IpAddress(ip));
        } else {
            params.subject_alt_names.push(SanType::DnsName(san.to_string().try_into()?));
        }
    }

    params.not_after = not_after;

    let cn = if extra_sans.is_empty() {
        "NetStacks Local Agent"
    } else {
        "NetStacks Remote Agent"
    };
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, cn);
    params.distinguished_name = dn;

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    Ok((cert.pem(), key_pair.serialize_pem()))
}

/// Load or generate a TLS cert with extra SANs (for remote mode).
/// Reuses the existing cert if valid — the user only has to approve
/// the OS trust dialog once per remote host.
pub async fn load_or_generate_remote(extra_sans: Vec<String>) -> Result<LocalTls, anyhow::Error> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    let cert_path = dir.join("remote.crt");
    let key_path = dir.join("remote.key");

    if cert_path.exists() && key_path.exists() && !expiring_soon(&cert_path) {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        let key_pem = std::fs::read_to_string(&key_path)?;
        match build_server_config(&cert_pem, &key_pem) {
            Ok(server_config) => {
                tracing::info!("Loaded existing remote TLS cert from {}", cert_path.display());
                return Ok(LocalTls { cert_pem, server_config });
            }
            Err(e) => tracing::warn!("Failed to load existing remote TLS cert, regenerating: {}", e),
        }
    }

    let (cert_pem, key_pem) = tokio::task::spawn_blocking(move || generate_cert_with_sans(&extra_sans))
        .await
        .map_err(|e| anyhow::anyhow!("TLS cert generation task panicked: {}", e))??;

    std::fs::write(&cert_path, &cert_pem)?;
    std::fs::write(&key_path, &key_pem)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))?;
    }

    let server_config = build_server_config(&cert_pem, &key_pem)?;
    tracing::info!("Generated new remote TLS certificate");

    Ok(LocalTls { cert_pem, server_config })
}
