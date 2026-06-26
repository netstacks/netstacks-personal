//! Generic on-demand installer for LSP plugins.
//!
//! Downloads a wheel from PyPI, verifies its SHA-256 hash, extracts the
//! binary, runs a smoke test, and installs it to the data directory.

use crate::lsp::types::{InstallationKind, LspPlugin};
use crate::lsp::wheel::{extract_binary_from_wheel, WheelError};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("plugin does not support on-demand download")]
    NotOnDemand,
    #[error("no download source for current platform")]
    NoPlatformSource,
    #[error("download failed: {0}")]
    Download(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SHA-256 verification failed: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("wheel extraction failed: {0}")]
    Wheel(#[from] WheelError),
    #[error("smoke test failed: {0}")]
    SmokeTest(String),
    #[error("install already in progress")]
    InProgress,
}

/// Install phase — emitted as progress events during installation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallPhase {
    Downloading,
    Verifying,
    Extracting,
    SmokeTesting,
    Done,
    Error,
}

/// Progress event emitted during installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallEvent {
    pub phase: InstallPhase,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

/// Determine the platform key for the current OS+arch.
///
/// Maps to the keys used in `OnDemandSource` hashmaps (e.g. "macos-arm64").
pub fn current_platform_key() -> Option<String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    match (os, arch) {
        ("macos", "x86_64") => Some("macos-x86_64".into()),
        ("macos", "aarch64") => Some("macos-arm64".into()),
        ("linux", "x86_64") => Some("linux-x86_64".into()),
        ("linux", "aarch64") => Some("linux-arm64".into()),
        ("windows", "x86_64") => Some("windows-x86_64".into()),
        ("windows", "aarch64") => Some("windows-arm64".into()),
        _ => None,
    }
}

/// Install a plugin from its on-demand download source.
///
/// # Arguments
///
/// * `plugin` - The plugin descriptor with installation metadata
/// * `data_dir` - Base data directory (e.g. `~/.local/share/com.netstacks.terminal`)
/// * `progress` - Broadcast sender for progress events
///
/// # Returns
///
/// The absolute path to the installed binary on success.
///
/// # Errors
///
/// Returns an error if:
/// - The plugin is not configured for on-demand download
/// - No download source exists for the current platform
/// - Download fails or SHA-256 verification fails
/// - Wheel extraction fails
/// - Smoke test fails (binary doesn't respond to `--version`)
pub async fn install_plugin(
    plugin: &LspPlugin,
    data_dir: &Path,
    progress: tokio::sync::broadcast::Sender<InstallEvent>,
) -> Result<PathBuf, InstallError> {
    let InstallationKind::OnDemandDownload { version, sources } = &plugin.installation else {
        return Err(InstallError::NotOnDemand);
    };

    let platform_key = current_platform_key().ok_or(InstallError::NoPlatformSource)?;
    let source = sources
        .get(&platform_key)
        .ok_or(InstallError::NoPlatformSource)?;

    // Create plugin-specific directories
    let plugin_dir = data_dir.join("lsp").join(&plugin.id);
    let version_dir = plugin_dir.join(format!("v{}", version));
    let download_dir = plugin_dir.join(".download");
    std::fs::create_dir_all(&version_dir)?;
    std::fs::create_dir_all(&download_dir)?;

    let temp_wheel = download_dir.join(format!("{}-{}.whl", plugin.id, version));

    // Phase 1: Download
    let _ = progress.send(InstallEvent {
        phase: InstallPhase::Downloading,
        bytes_downloaded: 0,
        total_bytes: None,
        error: None,
    });

    let client = Client::new();
    let mut response = client.get(&source.url).send().await?;

    let total_bytes = response.content_length();
    let mut file = tokio::fs::File::create(&temp_wheel).await?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;

    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        let _ = progress.send(InstallEvent {
            phase: InstallPhase::Downloading,
            bytes_downloaded: downloaded,
            total_bytes,
            error: None,
        });
    }

    file.flush().await?;
    drop(file);

    // Phase 2: Verify SHA-256
    let _ = progress.send(InstallEvent {
        phase: InstallPhase::Verifying,
        bytes_downloaded: downloaded,
        total_bytes,
        error: None,
    });

    let hash = format!("{:x}", hasher.finalize());
    if hash != source.sha256 {
        // Delete partial file on hash mismatch
        let _ = tokio::fs::remove_file(&temp_wheel).await;
        return Err(InstallError::HashMismatch {
            expected: source.sha256.clone(),
            actual: hash,
        });
    }

    // Phase 3: Extract
    let _ = progress.send(InstallEvent {
        phase: InstallPhase::Extracting,
        bytes_downloaded: downloaded,
        total_bytes,
        error: None,
    });

    let binary_name = &source.binary_path;
    let dest_binary = version_dir.join(binary_name);

    // Run extraction in a blocking task (zip crate is synchronous)
    let temp_wheel_clone = temp_wheel.clone();
    let dest_binary_clone = dest_binary.clone();
    let binary_name_clone = binary_name.clone();
    tokio::task::spawn_blocking(move || {
        extract_binary_from_wheel(&temp_wheel_clone, &binary_name_clone, &dest_binary_clone)
    })
    .await
    .map_err(|e| InstallError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))??;

    // Clean up temp wheel
    let _ = tokio::fs::remove_file(&temp_wheel).await;

    // Phase 4: Smoke test
    let _ = progress.send(InstallEvent {
        phase: InstallPhase::SmokeTesting,
        bytes_downloaded: downloaded,
        total_bytes,
        error: None,
    });

    let smoke_result = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(&dest_binary)
            .arg("--version")
            .output(),
    )
    .await;

    match smoke_result {
        Ok(Ok(output)) if output.status.success() => {
            // Smoke test passed
        }
        Ok(Ok(output)) => {
            return Err(InstallError::SmokeTest(format!(
                "exit code {}: {}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(Err(e)) => {
            return Err(InstallError::SmokeTest(format!("failed to run binary: {}", e)));
        }
        Err(_) => {
            return Err(InstallError::SmokeTest("timeout after 5s".into()));
        }
    }

    // Phase 5: Done
    let _ = progress.send(InstallEvent {
        phase: InstallPhase::Done,
        bytes_downloaded: downloaded,
        total_bytes,
        error: None,
    });

    Ok(dest_binary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::types::{PluginSource, RuntimeConfig};
    use std::collections::HashMap;
    use tempfile::TempDir;

    #[test]
    fn current_platform_returns_valid_key() {
        let key = current_platform_key();
        assert!(key.is_some(), "should detect current platform");
        let key = key.unwrap();
        // Should be one of the supported platforms
        assert!(
            ["macos-x86_64", "macos-arm64", "linux-x86_64", "linux-arm64", "windows-x86_64", "windows-arm64"]
                .contains(&key.as_str())
        );
    }

    #[test]
    fn install_event_serializes_correctly() {
        let event = InstallEvent {
            phase: InstallPhase::Downloading,
            bytes_downloaded: 1024,
            total_bytes: Some(4096),
            error: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["phase"], "downloading");
        assert_eq!(json["bytesDownloaded"], 1024);
        assert_eq!(json["totalBytes"], 4096);
    }

    #[tokio::test]
    async fn install_fails_for_non_on_demand_plugin() {
        let plugin = LspPlugin {
            id: "test".into(),
            display_name: "Test".into(),
            language: "test".into(),
            file_extensions: vec![],
            default_enabled: true,
            unavailable_in_enterprise: false,
            source: PluginSource::BuiltIn,
            installation: InstallationKind::SystemPath {
                default_command: "test".into(),
            },
            runtime: RuntimeConfig {
                command: "test".into(),
                args: vec![],
            },
        };

        let temp_dir = TempDir::new().unwrap();
        let (tx, _rx) = tokio::sync::broadcast::channel(10);

        let result = install_plugin(&plugin, temp_dir.path(), tx).await;
        assert!(matches!(result, Err(InstallError::NotOnDemand)));
    }

    #[tokio::test]
    async fn install_fails_when_no_platform_source() {
        let plugin = LspPlugin {
            id: "test".into(),
            display_name: "Test".into(),
            language: "test".into(),
            file_extensions: vec![],
            default_enabled: true,
            unavailable_in_enterprise: false,
            source: PluginSource::BuiltIn,
            installation: InstallationKind::OnDemandDownload {
                version: "1.0.0".into(),
                sources: HashMap::new(), // No sources
            },
            runtime: RuntimeConfig {
                command: "test".into(),
                args: vec![],
            },
        };

        let temp_dir = TempDir::new().unwrap();
        let (tx, _rx) = tokio::sync::broadcast::channel(10);

        let result = install_plugin(&plugin, temp_dir.path(), tx).await;
        assert!(matches!(result, Err(InstallError::NoPlatformSource)));
    }
}
