//! Tunnel manager for persistent SSH port forwarding.
//!
//! Manages SSH connections and spawns local/dynamic forward listeners.
//! Connections are pooled by (host, port, profile_id, jump_host_id) so
//! multiple tunnels to the same SSH server share a single connection.

pub mod local_forward;
pub mod dynamic_forward;
pub mod health;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use russh::client;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::models::{AuthType, PortForwardType, Tunnel, TunnelRuntimeState, TunnelStatus};
use crate::providers::DataProvider;
use crate::ssh::{connect_and_authenticate, ClientHandler, SshAuth, SshConfig};

/// Source of an effective jump for pool keying. Two tunnels routing through
/// the same effective jump (regardless of source kind) share a connection.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub enum JumpKey {
    JumpHost(String),
    Session(String),
}

/// Key for connection pooling: (host, port, profile_id, effective_jump).
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct ConnectionKey {
    pub host: String,
    pub port: u16,
    pub profile_id: String,
    pub jump: Option<JumpKey>,
}

impl ConnectionKey {
    /// Compute the connection key for a tunnel, resolving the effective
    /// jump (tunnel override > profile default). Pool sharing keys on the
    /// resolved jump id so two tunnels that resolve to the same target
    /// share a single SSH connection.
    pub async fn from_tunnel_resolved(
        tunnel: &Tunnel,
        provider: &Arc<dyn DataProvider>,
    ) -> Result<Self, String> {
        // Tunnel-level explicit override wins (mutual exclusion is enforced
        // at write time in T1).
        let jump = if let Some(id) = &tunnel.jump_host_id {
            Some(JumpKey::JumpHost(id.clone()))
        } else if let Some(id) = &tunnel.jump_session_id {
            Some(JumpKey::Session(id.clone()))
        } else {
            // Inherit from profile.
            let profile = provider
                .get_profile(&tunnel.profile_id)
                .await
                .map_err(|e| {
                    format!(
                        "Failed to load profile '{}' for tunnel '{}': {}",
                        tunnel.profile_id, tunnel.name, e
                    )
                })?;
            if let Some(id) = profile.jump_host_id {
                Some(JumpKey::JumpHost(id))
            } else { profile.jump_session_id.map(JumpKey::Session) }
        };
        Ok(Self {
            host: tunnel.host.clone(),
            port: tunnel.port,
            profile_id: tunnel.profile_id.clone(),
            jump,
        })
    }
}

/// A pooled SSH connection shared by one or more tunnels.
pub struct PooledConnection {
    /// The russh client handle for opening channels.
    pub(crate) handle: client::Handle<ClientHandler>,
    /// IDs of tunnels currently using this connection.
    pub(crate) tunnel_ids: Vec<String>,
}

/// Runtime state for a single active tunnel.
pub(crate) struct ActiveTunnel {
    pub(crate) cancel: CancellationToken,
    pub(crate) _task: JoinHandle<()>,
    pub(crate) started_at: Instant,
    pub(crate) bytes_tx: Arc<AtomicU64>,
    pub(crate) bytes_rx: Arc<AtomicU64>,
    pub(crate) status: Mutex<TunnelStatus>,
    pub(crate) last_error: Mutex<Option<String>>,
    pub(crate) retry_count: Mutex<u32>,
    pub(crate) definition: Tunnel,
}

/// Manages tunnel lifecycle: SSH connection pooling, spawning listeners,
/// tracking runtime state.
pub struct TunnelManager {
    /// Pooled SSH connections keyed by (host, port, profile, jump_host).
    connections: RwLock<HashMap<ConnectionKey, Arc<Mutex<PooledConnection>>>>,
    /// Active tunnel runtime state keyed by tunnel ID.
    active_tunnels: RwLock<HashMap<String, ActiveTunnel>>,
    /// Data provider for credential/profile lookups.
    provider: Arc<dyn DataProvider>,
}

impl TunnelManager {
    /// Create a new TunnelManager.
    pub fn new(provider: Arc<dyn DataProvider>) -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            active_tunnels: RwLock::new(HashMap::new()),
            provider,
        }
    }

    /// Get an existing pooled connection or create a new one.
    ///
    /// Resolves credentials via the DataProvider, builds an SshConfig,
    /// and calls connect_and_authenticate.
    async fn get_or_create_connection(
        &self,
        key: &ConnectionKey,
        tunnel_id: &str,
    ) -> Result<Arc<Mutex<PooledConnection>>, String> {
        // Check for existing connection first
        {
            let conns = self.connections.read().await;
            if let Some(conn) = conns.get(key) {
                let mut guard = conn.lock().await;
                if !guard.tunnel_ids.contains(&tunnel_id.to_string()) {
                    guard.tunnel_ids.push(tunnel_id.to_string());
                }
                return Ok(conn.clone());
            }
        }

        // Resolve profile and credentials
        let profile = self
            .provider
            .get_profile(&key.profile_id)
            .await
            .map_err(|e| format!("Failed to get profile '{}': {}", key.profile_id, e))?;

        let credential = self
            .provider
            .get_profile_credential(&key.profile_id)
            .await
            .map_err(|e| format!("Failed to get credential for profile '{}': {}", key.profile_id, e))?;

        let auth = match profile.auth_type {
            AuthType::Password => {
                let pw = credential
                    .as_ref()
                    .and_then(|c| c.password.clone())
                    .ok_or_else(|| {
                        format!(
                            "No password found for profile '{}'. Configure credentials in profile settings.",
                            profile.name
                        )
                    })?;
                SshAuth::Password(pw)
            }
            AuthType::Key => {
                let path = profile.key_path.clone().ok_or_else(|| {
                    format!(
                        "No SSH key path found for profile '{}'. Configure key path in profile settings.",
                        profile.name
                    )
                })?;
                let passphrase = credential.as_ref().and_then(|c| c.key_passphrase.clone());
                SshAuth::KeyFile { path, passphrase }
            }
        };

        let target_cfg = SshConfig {
            host: key.host.clone(),
            port: key.port,
            username: profile.username.clone(),
            auth,
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        };

        // Route via russh ProxyJump if a jump is configured (host or session
        // kind), using the jump's own credentials. Otherwise connect direct.
        let handle = if let Some(jump_key) = &key.jump {
            let jump_ref = match jump_key {
                JumpKey::JumpHost(id) => crate::ws::JumpRef::JumpHost(id.clone()),
                JumpKey::Session(id) => crate::ws::JumpRef::Session(id.clone()),
            };
            let resolution = crate::ws::resolve_effective_jump(
                jump_ref,
                crate::ws::JumpRef::None,
                &self.provider,
            )
            .await
            .map_err(|e| format!("Tunnel '{}' jump resolve failed: {}", tunnel_id, e))?
            .ok_or_else(|| format!(
                "Tunnel '{}' jump resolved to None — internal inconsistency", tunnel_id
            ))?;

            let jump_auth = match resolution.profile.auth_type {
                AuthType::Password => {
                    let pw = resolution.credential
                        .as_ref()
                        .and_then(|c| c.password.clone())
                        .ok_or_else(|| {
                            format!(
                                "No password configured for jump '{}' (profile '{}'). \
                                 Configure credentials in profile settings.",
                                resolution.source.display_name(), resolution.profile.name
                            )
                        })?;
                    SshAuth::Password(pw)
                }
                AuthType::Key => {
                    let path = resolution.profile.key_path.clone().ok_or_else(|| {
                        format!(
                            "No SSH key path configured for jump '{}' (profile '{}').",
                            resolution.source.display_name(), resolution.profile.name
                        )
                    })?;
                    let passphrase = resolution.credential
                        .as_ref()
                        .and_then(|c| c.key_passphrase.clone());
                    SshAuth::KeyFile { path, passphrase }
                }
            };

            let jump_cfg = SshConfig {
                host: resolution.host.clone(),
                port: resolution.port,
                username: resolution.profile.username.clone(),
                auth: jump_auth,
                legacy_ssh: false,
                skip_keyboard_interactive: false,
            };

            let jump_name = resolution.source.display_name().to_string();
            crate::ssh::jump::connect_via_jump(&target_cfg, &jump_cfg, None)
                .await
                .map_err(|e| {
                    format!(
                        "SSH connection to {}:{} via jump '{}' failed: {}",
                        key.host, key.port, jump_name, e
                    )
                })?
        } else {
            connect_and_authenticate(&target_cfg, false).await.map_err(|e| {
                format!("SSH connection to {}:{} failed: {}", key.host, key.port, e)
            })?
        };

        let conn = Arc::new(Mutex::new(PooledConnection {
            handle,
            tunnel_ids: vec![tunnel_id.to_string()],
        }));

        let mut conns = self.connections.write().await;
        conns.insert(key.clone(), conn.clone());

        tracing::info!(
            "Opened SSH connection to {}:{} for tunnel {}",
            key.host,
            key.port,
            tunnel_id
        );

        Ok(conn)
    }

    /// Start a tunnel: establish SSH connection (if needed) and spawn listener.
    pub async fn start_tunnel(&self, tunnel: &Tunnel) -> Result<(), String> {
        // Check if already active
        {
            let active = self.active_tunnels.read().await;
            if active.contains_key(&tunnel.id) {
                return Err(format!("Tunnel '{}' is already running", tunnel.name));
            }
        }

        let key = ConnectionKey::from_tunnel_resolved(tunnel, &self.provider).await?;
        let conn = self.get_or_create_connection(&key, &tunnel.id).await?;

        let cancel = CancellationToken::new();
        let bytes_tx = Arc::new(AtomicU64::new(0));
        let bytes_rx = Arc::new(AtomicU64::new(0));

        let task = match tunnel.forward_type {
            PortForwardType::Local => {
                let remote_host = tunnel
                    .remote_host
                    .clone()
                    .ok_or("Local forward requires remote_host")?;
                let remote_port = tunnel
                    .remote_port
                    .ok_or("Local forward requires remote_port")?;

                let bind_address = tunnel.bind_address.clone();
                let local_port = tunnel.local_port;
                let cancel_clone = cancel.clone();
                let bytes_tx_clone = bytes_tx.clone();
                let bytes_rx_clone = bytes_rx.clone();
                let tunnel_name = tunnel.name.clone();

                tokio::spawn(async move {
                    if let Err(e) = local_forward::run_local_forward(
                        conn,
                        &bind_address,
                        local_port,
                        &remote_host,
                        remote_port,
                        cancel_clone,
                        local_forward::ForwardCounters { tx: bytes_tx_clone, rx: bytes_rx_clone },
                    )
                    .await
                    {
                        tracing::error!("Local forward '{}' exited with error: {}", tunnel_name, e);
                    }
                })
            }
            PortForwardType::Dynamic => {
                let bind_address = tunnel.bind_address.clone();
                let local_port = tunnel.local_port;
                let cancel_clone = cancel.clone();
                let bytes_tx_clone = bytes_tx.clone();
                let bytes_rx_clone = bytes_rx.clone();
                let tunnel_name = tunnel.name.clone();

                tokio::spawn(async move {
                    if let Err(e) = dynamic_forward::run_socks5_proxy(
                        conn,
                        &bind_address,
                        local_port,
                        cancel_clone,
                        bytes_tx_clone,
                        bytes_rx_clone,
                    )
                    .await
                    {
                        tracing::error!("SOCKS5 proxy '{}' exited with error: {}", tunnel_name, e);
                    }
                })
            }
            PortForwardType::Remote => {
                return Err("Remote forwarding not yet implemented".to_string());
            }
        };

        let active = ActiveTunnel {
            cancel,
            _task: task,
            started_at: Instant::now(),
            bytes_tx,
            bytes_rx,
            status: Mutex::new(TunnelStatus::Connected),
            last_error: Mutex::new(None),
            retry_count: Mutex::new(0),
            definition: tunnel.clone(),
        };

        let mut tunnels = self.active_tunnels.write().await;
        tunnels.insert(tunnel.id.clone(), active);

        tracing::info!(
            "Started tunnel '{}' ({}:{} -> {}:{})",
            tunnel.name,
            tunnel.bind_address,
            tunnel.local_port,
            tunnel.remote_host.as_deref().unwrap_or("*"),
            tunnel.remote_port.unwrap_or(0),
        );

        Ok(())
    }

    /// Insert a non-running placeholder entry so a tunnel that could not
    /// (re)connect stays visible as `Failed` rather than silently disappearing
    /// from the active list. Used by the health monitor when auto-reconnect is
    /// disabled or all retries are exhausted.
    pub(crate) async fn mark_failed(&self, tunnel: &Tunnel, error: String) {
        let placeholder = ActiveTunnel {
            cancel: CancellationToken::new(),
            _task: tokio::spawn(async {}),
            started_at: Instant::now(),
            bytes_tx: Arc::new(AtomicU64::new(0)),
            bytes_rx: Arc::new(AtomicU64::new(0)),
            status: Mutex::new(TunnelStatus::Failed),
            last_error: Mutex::new(Some(error)),
            retry_count: Mutex::new(0),
            definition: tunnel.clone(),
        };
        self.active_tunnels
            .write()
            .await
            .insert(tunnel.id.clone(), placeholder);
    }

    /// Stop a tunnel by ID: cancel the listener task and clean up the pooled
    /// connection if no other tunnels are using it.
    pub async fn stop_tunnel(&self, tunnel_id: &str) -> Result<(), String> {
        // Remove and cancel the active tunnel
        let active = {
            let mut tunnels = self.active_tunnels.write().await;
            tunnels.remove(tunnel_id)
        };

        match active {
            Some(t) => {
                t.cancel.cancel();
                tracing::info!("Stopped tunnel {}", tunnel_id);
            }
            None => {
                return Err(format!("Tunnel '{}' is not running", tunnel_id));
            }
        }

        // Clean up connections: remove tunnel_id from any PooledConnection,
        // and drop the connection if no tunnels remain.
        let mut conns = self.connections.write().await;
        let mut keys_to_remove = Vec::new();

        for (key, conn) in conns.iter() {
            let mut guard = conn.lock().await;
            guard.tunnel_ids.retain(|id| id != tunnel_id);
            if guard.tunnel_ids.is_empty() {
                keys_to_remove.push(key.clone());
            }
        }

        for key in keys_to_remove {
            conns.remove(&key);
            tracing::info!(
                "Closed SSH connection to {}:{} (no remaining tunnels)",
                key.host,
                key.port
            );
        }

        Ok(())
    }

    /// Start all enabled tunnels that have auto_start set.
    pub async fn start_all_auto(&self, tunnels: &[Tunnel]) {
        for tunnel in tunnels {
            if tunnel.enabled && tunnel.auto_start {
                if let Err(e) = self.start_tunnel(tunnel).await {
                    tracing::warn!(
                        "Failed to auto-start tunnel '{}': {}",
                        tunnel.name,
                        e
                    );
                }
            }
        }
    }

    /// Stop all running tunnels.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = {
            let tunnels = self.active_tunnels.read().await;
            tunnels.keys().cloned().collect()
        };

        for id in ids {
            if let Err(e) = self.stop_tunnel(&id).await {
                tracing::warn!("Error stopping tunnel {}: {}", id, e);
            }
        }
    }

    /// Get runtime state for all active tunnels.
    pub async fn get_all_states(&self) -> Vec<TunnelRuntimeState> {
        let tunnels = self.active_tunnels.read().await;
        let mut states = Vec::with_capacity(tunnels.len());

        for (id, t) in tunnels.iter() {
            let status = t.status.lock().await.clone();
            let last_error = t.last_error.lock().await.clone();
            let retry_count = *t.retry_count.lock().await;

            states.push(TunnelRuntimeState {
                id: id.clone(),
                status,
                uptime_secs: Some(t.started_at.elapsed().as_secs()),
                bytes_tx: t.bytes_tx.load(Ordering::Relaxed),
                bytes_rx: t.bytes_rx.load(Ordering::Relaxed),
                last_error,
                retry_count,
            });
        }

        states
    }

    /// Get stored Tunnel definitions for session tunnels (no lock acquisition beyond the read lock).
    pub async fn get_session_tunnel_definitions(&self) -> Vec<(String, Tunnel)> {
        let tunnels = self.active_tunnels.read().await;
        tunnels.iter()
            .filter(|(id, _)| id.starts_with("session:"))
            .map(|(id, t)| (id.clone(), t.definition.clone()))
            .collect()
    }

}
