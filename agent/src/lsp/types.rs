//! Plugin descriptor types and install status.
//!
//! The `LspPlugin` shape is the contract between the agent's plugin
//! registry, the SQLite store, and the frontend's plugin registry.
//! Anything that changes here must be mirrored in
//! `frontend/src/lsp/types.ts` (added in Phase 3).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Where a plugin descriptor originated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSource {
    /// Hard-coded in the agent binary (e.g. Pyrefly).
    BuiltIn,
    /// Added by the user via Settings; persisted in SQLite.
    UserAdded,
}

/// How the plugin's binary gets onto disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InstallationKind {
    /// Downloaded from a URL on demand; SHA-256 verified.
    /// `sources` maps platform string (e.g. "macos-arm64") to its source.
    OnDemandDownload {
        version: String,
        sources: HashMap<String, OnDemandSource>,
    },
    /// Ships in the agent installer (not used in v1; future-proofing).
    Bundled { binary: String, args: Vec<String> },
    /// User-installed; the agent just runs the configured command.
    SystemPath { default_command: String },
}

/// One platform's download source for an on-demand plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnDemandSource {
    pub url: String,
    pub sha256: String,
    /// Path inside the downloaded archive to the executable.
    pub binary_path: String,
}

/// Runtime command for spawning the LSP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub command: String,
    pub args: Vec<String>,
}

/// Whether the LSP binary is present on disk and ready to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallStatus {
    /// Bundled/SystemPath plugin always reports `Installed`. On-demand
    /// plugin reports this when the verified binary is present at the
    /// expected path.
    Installed,
    /// On-demand plugin: not yet downloaded (or uninstalled).
    NotInstalled,
    /// On-demand plugin: download in progress.
    Installing,
    /// On-demand plugin: binary downloaded but smoke test (`--version`)
    /// failed; user should reinstall or set a custom command.
    InstalledButUnusable,
    /// The plugin is unavailable in the current app mode (e.g. Python
    /// LSP in Enterprise mode where there's no local agent).
    Unavailable,
    /// User has explicitly disabled this plugin.
    Disabled,
}

/// Full plugin descriptor — the unit of registration in the LspHost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPlugin {
    pub id: String,
    pub display_name: String,
    /// Monaco language id this plugin attaches to (e.g. "python").
    pub language: String,
    /// File extensions (with leading `.`) this language covers.
    pub file_extensions: Vec<String>,
    pub default_enabled: bool,
    pub unavailable_in_enterprise: bool,
    pub source: PluginSource,
    pub installation: InstallationKind,
    pub runtime: RuntimeConfig,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_camel_case_field_names() {
        let plugin = LspPlugin {
            id: "test".into(),
            display_name: "Test Plugin".into(),
            language: "python".into(),
            file_extensions: vec![".py".into()],
            default_enabled: true,
            unavailable_in_enterprise: true,
            source: PluginSource::BuiltIn,
            installation: InstallationKind::SystemPath {
                default_command: "echo".into(),
            },
            runtime: RuntimeConfig {
                command: "echo".into(),
                args: vec!["hello".into()],
            },
        };
        let json = serde_json::to_value(&plugin).unwrap();
        assert!(json.get("displayName").is_some());
        assert!(json.get("fileExtensions").is_some());
        assert!(json.get("defaultEnabled").is_some());
        assert!(json.get("unavailableInEnterprise").is_some());
        // PluginSource::BuiltIn serializes as kebab-case via PluginSource's own attribute.
        assert_eq!(json.get("source").unwrap().as_str().unwrap(), "built-in");
    }

    #[test]
    fn install_status_serializes_as_kebab_case() {
        assert_eq!(
            serde_json::to_value(InstallStatus::NotInstalled).unwrap(),
            serde_json::json!("not-installed")
        );
        assert_eq!(
            serde_json::to_value(InstallStatus::InstalledButUnusable).unwrap(),
            serde_json::json!("installed-but-unusable")
        );
    }

    #[test]
    fn installation_kind_serializes_with_kind_tag() {
        let on_demand = InstallationKind::OnDemandDownload {
            version: "1.0.0".into(),
            sources: HashMap::from([(
                "macos-arm64".into(),
                OnDemandSource {
                    url: "https://example.com/pyrefly.whl".into(),
                    sha256: "abcd".into(),
                    binary_path: "pyrefly/bin/pyrefly".into(),
                },
            )]),
        };
        let json = serde_json::to_value(&on_demand).unwrap();
        assert_eq!(json["kind"].as_str().unwrap(), "on-demand-download");
        assert_eq!(json["version"].as_str().unwrap(), "1.0.0");
    }
}
