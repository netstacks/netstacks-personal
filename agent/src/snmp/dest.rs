//! Resolve a [`SnmpDest`] from a profile and an optional session-level jump.
//!
//! Centralizes the "should this SNMP call go through a jump?" decision so
//! every caller (per-call API endpoints, batch discovery, traceroute hop
//! resolution, live WebSocket interface stats) follows identical rules:
//!
//! 1. If the caller supplies a session-level jump (a request field, or a
//!    session whose `jump_*` is set), use it.
//! 2. Otherwise, if the caller named a profile and that profile has a
//!    `jump_host_id` or `jump_session_id` configured, use it.
//! 3. Otherwise, return [`SnmpDest::Direct`].
//!
//! Errors come back as `String` because most callers don't care about HTTP
//! status codes — the API handler wraps the result, and discovery/ws log
//! the message and continue.

use std::sync::Arc;

use crate::providers::DataProvider;
use crate::snmp::SnmpDest;
use crate::ws::{resolve_effective_jump, JumpRef};

/// Resolve a [`SnmpDest`] for `(target_host, target_port)` using the
/// session-level jump (if supplied) and the profile's configured jump
/// (if `profile_id` is given). Returns [`SnmpDest::Direct`] when neither
/// resolves to a jump.
pub async fn snmp_dest_for(
    provider: &Arc<dyn DataProvider>,
    target_host: &str,
    target_port: u16,
    session_jump: JumpRef,
    profile_id: Option<&str>,
) -> Result<SnmpDest, String> {
    // Profile-level fallback only kicks in when the caller didn't supply a
    // session-level jump — `resolve_effective_jump` itself prefers session
    // when set, so we keep the second arg `None` to avoid double-application.
    let profile_level = if session_jump.is_none() {
        if let Some(pid) = profile_id {
            match provider.get_profile(pid).await {
                Ok(p) => {
                    let jr = JumpRef::from_pair(
                        p.jump_host_id.as_deref(),
                        p.jump_session_id.as_deref(),
                    );
                    tracing::info!(
                        "snmp_dest_for: profile '{}' (id={}) jump_host_id={:?} jump_session_id={:?} → {:?}",
                        p.name, pid, p.jump_host_id, p.jump_session_id, jr
                    );
                    jr
                }
                // Profile-load failure is not fatal: drop to direct. The
                // caller's actual SNMP attempt will surface a clearer error
                // if the device is unreachable.
                Err(e) => {
                    tracing::warn!("snmp_dest_for: profile id={} load failed: {}", pid, e);
                    JumpRef::None
                }
            }
        } else {
            JumpRef::None
        }
    } else {
        tracing::info!("snmp_dest_for: session-level jump set, ignoring profile-level");
        JumpRef::None
    };

    tracing::info!(
        "snmp_dest_for: target={}:{} session_jump={:?} profile_level={:?} profile_id={:?}",
        target_host, target_port, session_jump, profile_level, profile_id
    );

    let resolution = resolve_effective_jump(session_jump, profile_level, provider)
        .await
        .map_err(|e| format!("Failed to resolve jump: {}", e))?;

    let Some(r) = resolution else {
        tracing::debug!(
            "snmp_dest_for: no jump resolved → Direct({}:{})",
            target_host, target_port
        );
        return Ok(SnmpDest::direct(target_host, target_port));
    };

    tracing::debug!(
        "snmp_dest_for: jump '{}' at {}:{} → ViaJump (target={}:{})",
        r.source.display_name(), r.host, r.port, target_host, target_port
    );

    let auth = match r.profile.auth_type {
        crate::models::AuthType::Password => {
            let password = r
                .credential
                .as_ref()
                .and_then(|c| c.password.clone())
                .ok_or_else(|| {
                    format!(
                        "Jump '{}' has no stored password (profile '{}'). \
                         Configure credentials in profile settings.",
                        r.source.display_name(),
                        r.profile.name
                    )
                })?;
            crate::ssh::SshAuth::Password(password)
        }
        crate::models::AuthType::Key => {
            let path = r.profile.key_path.clone().ok_or_else(|| {
                format!(
                    "Jump '{}' (profile '{}') has no SSH key path configured.",
                    r.source.display_name(),
                    r.profile.name
                )
            })?;
            let passphrase = r
                .credential
                .as_ref()
                .and_then(|c| c.key_passphrase.clone());
            crate::ssh::SshAuth::KeyFile { path, passphrase }
        }
    };

    let jump_cfg = crate::ssh::SshConfig {
        host: r.host.clone(),
        port: r.port,
        username: r.profile.username.clone(),
        auth,
        legacy_ssh: false,
        skip_keyboard_interactive: false,
    };

    Ok(SnmpDest::ViaJump {
        jump: jump_cfg,
        target_host: target_host.to_string(),
        target_port,
    })
}
