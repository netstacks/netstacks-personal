//! Server-side state for AI "config mode" (AUDIT FIX EXEC-002).
//!
//! Previously the AI's `agent-chat` request body carried an
//! `allow_config_changes: bool` that lifted the in-prompt safety rules. That
//! is a self-asserted toggle from a (potentially XSS-compromised) frontend.
//! We now require the user to call `POST /api/ai/config-mode/enable` with
//! the current master password; that flips a short-lived server-side flag
//! (default 5 min) that every device write path consults instead of trusting
//! the request body: the chat prompt, `/ai/command-check`, `/ai/ssh-execute`
//! and the background-task SSH tool + permission resolver.

use std::sync::Arc;

use tokio::sync::RwLock;

/// Default duration the config-mode override stays active after the user
/// re-authenticates. Picked to be long enough for an interactive conversation
/// but short enough that an unattended app does not stay in a destructive
/// state for hours.
pub const CONFIG_MODE_TTL_SECS: i64 = 300;

/// An active config-mode override.
#[derive(Debug, Clone, Copy)]
pub struct ConfigModeState {
    /// Wall-clock instant after which the state must be treated as off.
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// Shared handle: one per process, held by `AppState` and the task executor.
pub type ConfigModeHandle = Arc<RwLock<Option<ConfigModeState>>>;

/// Check whether AI config mode is currently active.
///
/// Read-locks the state, expires it lazily if the deadline has passed, and
/// returns true only when both the flag is set AND `expires_at > now()`.
pub async fn is_active(handle: &ConfigModeHandle) -> bool {
    let now = chrono::Utc::now();
    let snapshot = *handle.read().await;
    match snapshot {
        Some(s) if s.expires_at > now => true,
        Some(_) => {
            // Expired — clear lazily so the next caller sees the cleared
            // state without paying the lazy-clear cost again.
            let mut w = handle.write().await;
            if let Some(s) = *w {
                if s.expires_at <= chrono::Utc::now() {
                    *w = None;
                }
            }
            false
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn off_by_default() {
        let handle: ConfigModeHandle = Arc::new(RwLock::new(None));
        assert!(!is_active(&handle).await);
    }

    #[tokio::test]
    async fn active_until_expiry() {
        let handle: ConfigModeHandle = Arc::new(RwLock::new(Some(ConfigModeState {
            expires_at: chrono::Utc::now() + chrono::Duration::seconds(60),
        })));
        assert!(is_active(&handle).await);
    }

    #[tokio::test]
    async fn expired_state_is_cleared() {
        let handle: ConfigModeHandle = Arc::new(RwLock::new(Some(ConfigModeState {
            expires_at: chrono::Utc::now() - chrono::Duration::seconds(1),
        })));
        assert!(!is_active(&handle).await);
        assert!(handle.read().await.is_none());
    }
}
