//! LSP plugin host.
//!
//! Owns the merged plugin registry (built-ins from `plugins::built_in_plugins()`
//! plus user-added entries loaded from SQLite) and the active session map.
//! Session lifecycle is owned by `LspSession` (added in P2T5). This struct
//! is the public surface used by HTTP/WS routes.

use crate::lsp::install::{install_plugin as do_install, InstallError, InstallEvent};
use crate::lsp::plugins::built_in_plugins;
use crate::lsp::session::LspSession;
use crate::lsp::types::{InstallationKind, InstallStatus, LspPlugin, PluginSource, RuntimeConfig};
use dashmap::DashMap;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::broadcast;

#[derive(Debug, Error)]
pub enum LspHostError {
    #[error("plugin id {0} not found")]
    PluginNotFound(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("invalid plugin config: {0}")]
    InvalidConfig(String),
    #[error("install error: {0}")]
    Install(#[from] InstallError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Session key: a plugin id paired with its workspace root. A loose-file
/// session (no workspace) uses a synthetic per-connection id stored in
/// `WorkspaceKey::Scratch`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkspaceKey {
    Path(PathBuf),
    Scratch(String), // UUID; Phase 6 implements scratch dirs
}

pub type SessionKey = (String, WorkspaceKey);

/// The agent-wide LSP host. Held inside AppState as `Arc<LspHost>`.
pub struct LspHost {
    pool: SqlitePool,
    /// Base data directory for LSP plugin binaries.
    data_dir: PathBuf,
    /// Active sessions. Phase 2 only declares the map; LspSession is added in P2T5.
    pub(crate) sessions: DashMap<SessionKey, Arc<LspSession>>,
    /// In-progress installs. Maps plugin_id → broadcast channel for SSE subscribers.
    pub(crate) installs: DashMap<String, broadcast::Sender<InstallEvent>>,
}

impl LspHost {
    pub fn new(pool: SqlitePool, data_dir: PathBuf) -> Self {
        Self {
            pool,
            data_dir,
            sessions: DashMap::new(),
            installs: DashMap::new(),
        }
    }

    /// Return the merged plugin list (built-in + user-added). User-added
    /// rows from `lsp_plugins` are wrapped as `PluginSource::UserAdded`
    /// descriptors with `InstallationKind::SystemPath`. Per-built-in
    /// overrides from `lsp_plugin_overrides` are applied to built-ins.
    pub async fn list_plugins(&self) -> Result<Vec<LspPlugin>, LspHostError> {
        let mut all = built_in_plugins();

        // Apply per-built-in overrides
        let overrides = sqlx::query_as::<_, BuiltInOverrideRow>(
            "SELECT plugin_id, enabled, custom_command, custom_args FROM lsp_plugin_overrides"
        )
        .fetch_all(&self.pool)
        .await?;

        for row in overrides {
            if let Some(plugin) = all.iter_mut().find(|p| p.id == row.plugin_id) {
                if !row.enabled {
                    plugin.default_enabled = false;
                }
                if let Some(cmd) = row.custom_command {
                    let args: Vec<String> = serde_json::from_str(&row.custom_args)
                        .map_err(|e| LspHostError::InvalidConfig(format!(
                            "lsp_plugin_overrides.custom_args for {}: {}",
                            row.plugin_id, e
                        )))?;
                    plugin.runtime = RuntimeConfig { command: cmd, args };
                }
            }
        }

        // Append user-added plugins
        let user_rows = sqlx::query_as::<_, UserPluginRow>(
            "SELECT id, display_name, language, file_extensions, command, args, enabled FROM lsp_plugins"
        )
        .fetch_all(&self.pool)
        .await?;

        for row in user_rows {
            let file_extensions: Vec<String> = serde_json::from_str(&row.file_extensions)
                .map_err(|e| LspHostError::InvalidConfig(format!(
                    "lsp_plugins.file_extensions for {}: {}",
                    row.id, e
                )))?;
            let args: Vec<String> = serde_json::from_str(&row.args)
                .map_err(|e| LspHostError::InvalidConfig(format!(
                    "lsp_plugins.args for {}: {}",
                    row.id, e
                )))?;
            all.push(LspPlugin {
                id: row.id.clone(),
                display_name: row.display_name,
                language: row.language,
                file_extensions,
                default_enabled: row.enabled,
                unavailable_in_enterprise: false,
                source: PluginSource::UserAdded,
                installation: InstallationKind::SystemPath {
                    default_command: row.command.clone(),
                },
                runtime: RuntimeConfig {
                    command: row.command,
                    args,
                },
            });
        }

        Ok(all)
    }

    /// Look up a plugin by id from the merged registry. Returns Err if not found.
    pub async fn get_plugin(&self, id: &str) -> Result<LspPlugin, LspHostError> {
        let all = self.list_plugins().await?;
        all.into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| LspHostError::PluginNotFound(id.to_string()))
    }

    /// Get or create the session for `(plugin_id, workspace)`. Spawns the
    /// LSP child if no session exists. Subsequent calls for the same key
    /// return the existing session so WebSocket clients can share it.
    pub async fn get_or_create_session(
        &self,
        plugin_id: &str,
        workspace: WorkspaceKey,
    ) -> Result<Arc<LspSession>, LspHostError> {
        let key = (plugin_id.to_string(), workspace.clone());
        if let Some(s) = self.sessions.get(&key) {
            return Ok(s.clone());
        }
        let plugin = self.get_plugin(plugin_id).await?;

        // For on-demand plugins, use the installed binary path instead of
        // the placeholder runtime command.
        let runtime = if let InstallationKind::OnDemandDownload { version, .. } = &plugin.installation {
            let binary_path = self.installed_binary_path(&plugin.id, version);
            if binary_path.exists() {
                RuntimeConfig {
                    command: binary_path.to_string_lossy().to_string(),
                    args: plugin.runtime.args.clone(),
                }
            } else {
                return Err(LspHostError::InvalidConfig(format!(
                    "plugin {} is not installed; binary not found at {}",
                    plugin.id,
                    binary_path.display()
                )));
            }
        } else {
            plugin.runtime.clone()
        };

        let workspace_path: Option<PathBuf> = match &workspace {
            WorkspaceKey::Path(p) => Some(p.clone()),
            WorkspaceKey::Scratch(uuid) => Some(
                crate::lsp::scratch::ensure_scratch_dir(&self.data_dir, uuid)
                    .map_err(|e| LspHostError::InvalidConfig(format!("scratch dir: {}", e)))?
            ),
        };
        let session = LspSession::spawn(&runtime, workspace_path.as_deref())
            .map_err(|e| LspHostError::InvalidConfig(format!("spawn LSP for {}: {}", plugin_id, e)))?;
        self.sessions.insert(key, session.clone());
        Ok(session)
    }

    /// Install a plugin from its on-demand download source.
    ///
    /// Returns a broadcast receiver for progress events. The install runs
    /// asynchronously in the background.
    ///
    /// Returns `InstallError::InProgress` if an install is already running
    /// for this plugin.
    pub async fn install_plugin(
        &self,
        plugin_id: String,
    ) -> Result<broadcast::Receiver<InstallEvent>, LspHostError> {
        // Check if already installing
        if self.installs.contains_key(&plugin_id) {
            return Err(InstallError::InProgress.into());
        }

        let plugin = self.get_plugin(&plugin_id).await?;

        // Create progress channel (buffer 100 events)
        let (tx, rx) = broadcast::channel(100);
        self.installs.insert(plugin_id.clone(), tx.clone());

        // Spawn the install task
        let data_dir = self.data_dir.clone();
        let installs = self.installs.clone();
        tokio::spawn(async move {
            let result = async {
                do_install(&plugin, &data_dir, tx.clone()).await?;

                Ok::<_, LspHostError>(())
            }
            .await;

            // Send final event on error
            if let Err(e) = result {
                let _ = tx.send(InstallEvent {
                    phase: crate::lsp::install::InstallPhase::Error,
                    bytes_downloaded: 0,
                    total_bytes: None,
                    error: Some(e.to_string()),
                });
            }

            // Remove from in-progress map
            installs.remove(&plugin_id);
        });

        Ok(rx)
    }

    /// Uninstall a plugin by deleting its binary directory.
    ///
    /// For built-in plugins, this removes the on-demand downloaded binary.
    /// For user-added plugins, this is a no-op (Phase 5 will implement).
    pub async fn uninstall_plugin(&self, plugin_id: &str) -> Result<(), LspHostError> {
        let plugin = self.get_plugin(plugin_id).await?;

        // Only on-demand plugins can be uninstalled
        let InstallationKind::OnDemandDownload { .. } = &plugin.installation else {
            return Ok(()); // No-op for system path / bundled plugins
        };

        // Kill any active sessions for this plugin and clean up scratch dirs
        let keys_to_remove: Vec<_> = self.sessions
            .iter()
            .filter(|e| e.key().0 == plugin_id)
            .map(|e| e.key().clone())
            .collect();

        for key in keys_to_remove {
            if let Some((k, _)) = self.sessions.remove(&key) {
                if let WorkspaceKey::Scratch(uuid) = &k.1 {
                    crate::lsp::scratch::remove_scratch_dir(&self.data_dir, uuid);
                }
            }
        }

        // Delete the plugin directory
        let plugin_dir = self.data_dir.join("lsp").join(plugin_id);
        if plugin_dir.exists() {
            tokio::fs::remove_dir_all(&plugin_dir).await?;
        }

        Ok(())
    }

    /// Compute install status for a plugin.
    ///
    /// Used by routes.rs to populate the `installStatus` field in plugin list responses.
    pub fn compute_install_status(&self, plugin: &LspPlugin) -> InstallStatus {
        match &plugin.installation {
            InstallationKind::SystemPath { .. } | InstallationKind::Bundled { .. } => {
                InstallStatus::Installed
            }
            InstallationKind::OnDemandDownload { version, .. } => {
                // Check if currently installing
                if self.installs.contains_key(&plugin.id) {
                    return InstallStatus::Installing;
                }

                // Check if binary exists on disk
                let binary_path = self.installed_binary_path(&plugin.id, version);
                if binary_path.exists() {
                    InstallStatus::Installed
                } else {
                    InstallStatus::NotInstalled
                }
            }
        }
    }

    /// Get the expected path to an installed binary.
    fn installed_binary_path(&self, plugin_id: &str, version: &str) -> PathBuf {
        #[cfg(target_os = "windows")]
        let binary_name = format!("{}.exe", plugin_id);
        #[cfg(not(target_os = "windows"))]
        let binary_name = plugin_id.to_string();

        self.data_dir
            .join("lsp")
            .join(plugin_id)
            .join(format!("v{}", version))
            .join(binary_name)
    }

    /// Create a new user-added plugin. Returns conflict error if id collides.
    pub async fn create_user_plugin(&self, input: UserPluginInput) -> Result<LspPlugin, LspHostError> {
        // Check id collision against built-ins AND user-added entries
        if built_in_plugins().iter().any(|p| p.id == input.id) {
            return Err(LspHostError::InvalidConfig(format!(
                "id '{}' is reserved by a built-in plugin",
                input.id
            )));
        }
        let existing: Option<i64> = sqlx::query_scalar("SELECT 1 FROM lsp_plugins WHERE id = ?1")
            .bind(&input.id)
            .fetch_optional(&self.pool)
            .await?;
        if existing.is_some() {
            return Err(LspHostError::InvalidConfig(format!(
                "plugin id '{}' already exists",
                input.id
            )));
        }

        let file_extensions_json = serde_json::to_string(&input.file_extensions)
            .map_err(|e| LspHostError::InvalidConfig(e.to_string()))?;
        let args_json = serde_json::to_string(&input.args)
            .map_err(|e| LspHostError::InvalidConfig(e.to_string()))?;
        let env_vars_json = serde_json::to_string(&input.env_vars)
            .map_err(|e| LspHostError::InvalidConfig(e.to_string()))?;

        sqlx::query(
            "INSERT INTO lsp_plugins (id, display_name, language, file_extensions, command, args, env_vars, enabled) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
        )
        .bind(&input.id)
        .bind(&input.display_name)
        .bind(&input.language)
        .bind(&file_extensions_json)
        .bind(&input.command)
        .bind(&args_json)
        .bind(&env_vars_json)
        .execute(&self.pool)
        .await?;

        self.get_plugin(&input.id).await
    }

    /// Update an existing plugin. Built-in: writes to lsp_plugin_overrides
    /// (only enabled + custom_command + custom_args can be changed).
    /// User-added: updates the row in lsp_plugins (all fields).
    pub async fn update_plugin(&self, id: &str, input: PluginUpdateInput) -> Result<LspPlugin, LspHostError> {
        let is_built_in = built_in_plugins().iter().any(|p| p.id == id);
        if is_built_in {
            // Upsert into overrides table
            let custom_args_json = match &input.args {
                Some(a) => serde_json::to_string(a)
                    .map_err(|e| LspHostError::InvalidConfig(e.to_string()))?,
                None => "[]".to_string(),
            };
            sqlx::query(
                "INSERT INTO lsp_plugin_overrides (plugin_id, enabled, custom_command, custom_args) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(plugin_id) DO UPDATE SET \
                   enabled = COALESCE(?2, enabled), \
                   custom_command = COALESCE(?3, custom_command), \
                   custom_args = ?4, \
                   updated_at = datetime('now')",
            )
            .bind(id)
            .bind(input.enabled.unwrap_or(true))
            .bind(input.command.as_deref())
            .bind(custom_args_json)
            .execute(&self.pool)
            .await?;
        } else {
            // Update user-added row. Build dynamic SET clause based on fields present.
            // Simplest: fetch row, apply updates, write back.
            let row: Option<(String, String, String, String, String, bool)> = sqlx::query_as(
                "SELECT display_name, language, file_extensions, command, args, enabled FROM lsp_plugins WHERE id = ?1"
            )
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;

            let (mut dn, mut lang, mut fext, mut cmd, mut args, mut enabled) = row
                .ok_or_else(|| LspHostError::PluginNotFound(id.to_string()))?;

            if let Some(v) = input.display_name { dn = v; }
            if let Some(v) = input.language { lang = v; }
            if let Some(v) = input.file_extensions {
                fext = serde_json::to_string(&v)
                    .map_err(|e| LspHostError::InvalidConfig(e.to_string()))?;
            }
            if let Some(v) = input.command { cmd = v; }
            if let Some(v) = input.args {
                args = serde_json::to_string(&v)
                    .map_err(|e| LspHostError::InvalidConfig(e.to_string()))?;
            }
            if let Some(v) = input.enabled { enabled = v; }

            sqlx::query(
                "UPDATE lsp_plugins SET display_name = ?2, language = ?3, file_extensions = ?4, \
                 command = ?5, args = ?6, enabled = ?7, updated_at = datetime('now') WHERE id = ?1"
            )
            .bind(id)
            .bind(dn)
            .bind(lang)
            .bind(fext)
            .bind(cmd)
            .bind(args)
            .bind(enabled)
            .execute(&self.pool)
            .await?;
        }
        self.get_plugin(id).await
    }

    /// Delete a plugin. Built-in: errors (built-ins can only be uninstalled via the install module).
    /// User-added: deletes the SQLite row.
    pub async fn delete_user_plugin(&self, id: &str) -> Result<(), LspHostError> {
        let is_built_in = built_in_plugins().iter().any(|p| p.id == id);
        if is_built_in {
            return Err(LspHostError::InvalidConfig(format!(
                "'{}' is a built-in plugin; use uninstall_plugin to remove its binary",
                id
            )));
        }

        let affected = sqlx::query("DELETE FROM lsp_plugins WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();

        if affected == 0 {
            return Err(LspHostError::PluginNotFound(id.to_string()));
        }

        // Also kill any active sessions for this plugin
        let keys_to_remove: Vec<_> = self.sessions
            .iter()
            .filter(|e| e.key().0 == id)
            .map(|e| e.key().clone())
            .collect();

        for key in keys_to_remove {
            if let Some((k, session)) = self.sessions.remove(&key) {
                session.shutdown().await;
                // Clean up scratch dir if it was a scratch session
                if let WorkspaceKey::Scratch(uuid) = &k.1 {
                    crate::lsp::scratch::remove_scratch_dir(&self.data_dir, uuid);
                }
            }
        }

        Ok(())
    }
}

/// Input for creating a new user-added plugin.
/// The frontend (lsp/installationApi.ts) sends camelCase keys (displayName,
/// fileExtensions, envVars); rename so they deserialize into these snake_case fields.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPluginInput {
    pub id: String,                    // unique, kebab-case
    pub display_name: String,
    pub language: String,              // Monaco language id
    pub file_extensions: Vec<String>,  // e.g. [".go", ".mod"]
    pub command: String,               // absolute path or PATH name
    pub args: Vec<String>,             // e.g. ["serve"]
    #[serde(default)]
    pub env_vars: HashMap<String, String>, // optional, default empty
}

/// Input for updating a plugin (built-in or user-added).
/// Frontend sends camelCase (displayName, fileExtensions); rename to match.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInput {
    pub display_name: Option<String>,
    pub language: Option<String>,
    pub file_extensions: Option<Vec<String>>,
    pub command: Option<String>,           // for user-added; OR override for built-in
    pub args: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

#[derive(sqlx::FromRow)]
struct BuiltInOverrideRow {
    plugin_id: String,
    enabled: bool,
    custom_command: Option<String>,
    custom_args: String,
}

#[derive(sqlx::FromRow)]
struct UserPluginRow {
    id: String,
    display_name: String,
    language: String,
    file_extensions: String,
    command: String,
    args: String,
    enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE lsp_plugins (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                language TEXT NOT NULL,
                file_extensions TEXT NOT NULL,
                command TEXT NOT NULL,
                args TEXT NOT NULL,
                env_vars TEXT NOT NULL DEFAULT '{}',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE lsp_plugin_overrides (
                plugin_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 1,
                custom_command TEXT,
                custom_args TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn pyrefly_appears_in_built_in_list() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());
        let plugins = host.list_plugins().await.unwrap();
        assert_eq!(plugins.len(), 1, "Phase 4 adds Pyrefly as the only built-in");
        assert_eq!(plugins[0].id, "pyrefly");
        assert_eq!(plugins[0].language, "python");
    }

    #[tokio::test]
    async fn user_added_plugin_appears_in_list() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO lsp_plugins (id, display_name, language, file_extensions, command, args, enabled) \
             VALUES ('go', 'gopls', 'go', '[\".go\"]', 'gopls', '[\"serve\"]', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());
        let plugins = host.list_plugins().await.unwrap();
        assert_eq!(plugins.len(), 2, "Pyrefly + gopls");
        let go = plugins.iter().find(|p| p.id == "go").unwrap();
        assert_eq!(go.display_name, "gopls");
        assert_eq!(go.language, "go");
        assert_eq!(go.file_extensions, vec![".go".to_string()]);
        assert_eq!(go.runtime.command, "gopls");
        assert_eq!(go.runtime.args, vec!["serve".to_string()]);
        assert!(matches!(go.source, PluginSource::UserAdded));
        assert!(matches!(go.installation, InstallationKind::SystemPath { .. }));
    }

    #[tokio::test]
    async fn get_plugin_returns_not_found_for_unknown_id() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());
        let err = host.get_plugin("nope").await.unwrap_err();
        assert!(matches!(err, LspHostError::PluginNotFound(_)));
    }

    #[tokio::test]
    async fn create_user_plugin_succeeds_for_unique_id() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());

        let input = UserPluginInput {
            id: "custom-rust".to_string(),
            display_name: "Custom Rust Analyzer".to_string(),
            language: "rust".to_string(),
            file_extensions: vec![".rs".to_string()],
            command: "rust-analyzer".to_string(),
            args: vec![],
            env_vars: HashMap::new(),
        };

        let plugin = host.create_user_plugin(input).await.unwrap();
        assert_eq!(plugin.id, "custom-rust");
        assert_eq!(plugin.display_name, "Custom Rust Analyzer");
        assert_eq!(plugin.language, "rust");
        assert_eq!(plugin.file_extensions, vec![".rs".to_string()]);
        assert!(matches!(plugin.source, PluginSource::UserAdded));
    }

    #[tokio::test]
    async fn create_user_plugin_rejects_duplicate_id() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());

        let input = UserPluginInput {
            id: "custom-rust".to_string(),
            display_name: "Custom Rust Analyzer".to_string(),
            language: "rust".to_string(),
            file_extensions: vec![".rs".to_string()],
            command: "rust-analyzer".to_string(),
            args: vec![],
            env_vars: HashMap::new(),
        };

        host.create_user_plugin(input.clone()).await.unwrap();
        let err = host.create_user_plugin(input).await.unwrap_err();
        assert!(matches!(err, LspHostError::InvalidConfig(_)));
        assert!(err.to_string().contains("already exists"));
    }

    #[tokio::test]
    async fn create_user_plugin_rejects_built_in_id_collision() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());

        let input = UserPluginInput {
            id: "pyrefly".to_string(), // collides with built-in
            display_name: "Custom Pyrefly".to_string(),
            language: "python".to_string(),
            file_extensions: vec![".py".to_string()],
            command: "pyrefly".to_string(),
            args: vec![],
            env_vars: HashMap::new(),
        };

        let err = host.create_user_plugin(input).await.unwrap_err();
        assert!(matches!(err, LspHostError::InvalidConfig(_)));
        assert!(err.to_string().contains("reserved by a built-in"));
    }

    #[tokio::test]
    async fn update_plugin_updates_user_added() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());

        let input = UserPluginInput {
            id: "custom-rust".to_string(),
            display_name: "Custom Rust Analyzer".to_string(),
            language: "rust".to_string(),
            file_extensions: vec![".rs".to_string()],
            command: "rust-analyzer".to_string(),
            args: vec![],
            env_vars: HashMap::new(),
        };

        host.create_user_plugin(input).await.unwrap();

        let update = PluginUpdateInput {
            display_name: Some("Updated Rust".to_string()),
            language: None,
            file_extensions: None,
            command: None,
            args: Some(vec!["--log".to_string(), "trace".to_string()]),
            enabled: Some(false),
        };

        let plugin = host.update_plugin("custom-rust", update).await.unwrap();
        assert_eq!(plugin.display_name, "Updated Rust");
        assert_eq!(plugin.runtime.args, vec!["--log", "trace"]);
        assert!(!plugin.default_enabled);
    }

    #[tokio::test]
    async fn update_plugin_writes_override_for_built_in() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool.clone(), temp_dir.path().to_path_buf());

        let update = PluginUpdateInput {
            display_name: None, // ignored for built-ins
            language: None,
            file_extensions: None,
            command: Some("/custom/pyrefly".to_string()),
            args: Some(vec!["--verbose".to_string()]),
            enabled: Some(false),
        };

        let plugin = host.update_plugin("pyrefly", update).await.unwrap();
        assert_eq!(plugin.runtime.command, "/custom/pyrefly");
        assert_eq!(plugin.runtime.args, vec!["--verbose"]);
        assert!(!plugin.default_enabled);

        // Verify override was written to DB
        let row: Option<(String, bool, Option<String>, String)> = sqlx::query_as(
            "SELECT plugin_id, enabled, custom_command, custom_args FROM lsp_plugin_overrides WHERE plugin_id = 'pyrefly'"
        )
        .fetch_optional(&pool)
        .await
        .unwrap();

        let (pid, enabled, cmd, args) = row.unwrap();
        assert_eq!(pid, "pyrefly");
        assert!(!enabled);
        assert_eq!(cmd.unwrap(), "/custom/pyrefly");
        assert_eq!(args, r#"["--verbose"]"#);
    }

    #[tokio::test]
    async fn delete_user_plugin_removes_row() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());

        let input = UserPluginInput {
            id: "custom-rust".to_string(),
            display_name: "Custom Rust Analyzer".to_string(),
            language: "rust".to_string(),
            file_extensions: vec![".rs".to_string()],
            command: "rust-analyzer".to_string(),
            args: vec![],
            env_vars: HashMap::new(),
        };

        host.create_user_plugin(input).await.unwrap();
        host.delete_user_plugin("custom-rust").await.unwrap();

        let err = host.get_plugin("custom-rust").await.unwrap_err();
        assert!(matches!(err, LspHostError::PluginNotFound(_)));
    }

    #[tokio::test]
    async fn delete_user_plugin_rejects_built_in() {
        let pool = fresh_pool().await;
        let temp_dir = tempfile::TempDir::new().unwrap();
        let host = LspHost::new(pool, temp_dir.path().to_path_buf());

        let err = host.delete_user_plugin("pyrefly").await.unwrap_err();
        assert!(matches!(err, LspHostError::InvalidConfig(_)));
        assert!(err.to_string().contains("built-in plugin"));
    }
}
