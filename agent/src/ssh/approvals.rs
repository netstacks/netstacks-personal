//! Host-key approval service (AUDIT FIX REMOTE-001).
//!
//! Replaces silent TOFU. When `verify_or_store` sees an unknown host, it
//! creates a pending approval, surfaces the SHA-256 fingerprint to the
//! frontend, and waits up to 2 minutes for the user to click Accept or
//! Reject in a modal. No new keys are written to known_hosts without
//! explicit user consent.
//!
//! ## Mechanics
//!
//! - Each pending request is tracked by a UUID. The russh handshake
//!   thread blocks on a `tokio::sync::oneshot` channel waiting for the
//!   user to resolve the prompt.
//! - The frontend polls `GET /api/host-keys/prompts` every ~750 ms while
//!   it has any in-flight connection. When a matching prompt appears, it
//!   shows the modal.
//! - User accepts → `POST /api/host-keys/prompts/:id/approve` resolves the
//!   oneshot with `true` → handshake continues and the key is stored.
//! - User rejects → `POST /api/host-keys/prompts/:id/reject` resolves with
//!   `false` → handshake aborts with a host-key `SshError::KeyError`.
//! - If no resolution arrives within `PROMPT_TIMEOUT`, the handshake
//!   aborts with a timeout `SshError::KeyError`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, RwLock};
use uuid::Uuid;

/// How long a pending host-key prompt may sit waiting for a user response
/// before the SSH handshake aborts. Short enough to surface a stuck UI,
/// long enough that the user can read the fingerprint and decide.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// What the user sees in the modal.
#[derive(Debug, Clone, Serialize)]
pub struct PendingPrompt {
    pub id: String,
    pub host: String,
    pub port: u16,
    /// Whether the host was previously trusted with a different key (true)
    /// or this is a brand-new host (false). UI surfaces this very
    /// differently — a changed key is the strong "MITM possible" signal.
    pub is_changed_key: bool,
    pub fingerprint: String,
    /// SHA-256 of the previously-trusted key, if any. UI shows side-by-side.
    pub previous_fingerprint: Option<String>,
    /// Wall-clock RFC3339 when the prompt was created. The frontend uses
    /// this to compute "expires in N s" for the modal countdown.
    pub created_at: String,
}

struct PendingState {
    info: PendingPrompt,
    sender: oneshot::Sender<bool>,
}

/// Shared host-key approval service. One instance per agent process.
#[derive(Default)]
pub struct HostKeyApprovalService {
    pending: RwLock<HashMap<String, PendingState>>,
}

impl HostKeyApprovalService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Create a pending prompt and await the user's decision.
    ///
    /// Called from `host_keys::verify_or_store` (synchronously inside the
    /// russh handshake) when an unknown or changed host key is presented.
    /// Blocks the handshake task until the prompt is resolved.
    pub async fn request_approval(
        &self,
        host: String,
        port: u16,
        fingerprint: String,
        is_changed_key: bool,
        previous_fingerprint: Option<String>,
    ) -> Result<bool, &'static str> {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        let info = PendingPrompt {
            id: id.clone(),
            host,
            port,
            is_changed_key,
            fingerprint,
            previous_fingerprint,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        tracing::warn!(
            target: "audit",
            id = %id,
            host = %info.host,
            port = info.port,
            fingerprint = %info.fingerprint,
            changed = info.is_changed_key,
            "host-key approval requested"
        );

        self.pending
            .write()
            .await
            .insert(id.clone(), PendingState { info, sender: tx });

        let result = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;

        // Always remove the prompt regardless of outcome — leaving stale
        // entries would let the frontend show modals for already-resolved
        // prompts.
        self.pending.write().await.remove(&id);

        match result {
            Ok(Ok(approved)) => {
                tracing::warn!(
                    target: "audit",
                    id = %id,
                    approved,
                    "host-key prompt resolved"
                );
                Ok(approved)
            }
            Ok(Err(_)) => Err("approval channel closed"),
            Err(_) => {
                tracing::warn!(target: "audit", id = %id, "host-key prompt timed out");
                Err("approval timed out")
            }
        }
    }

    /// REST endpoint backing: list all currently-pending prompts.
    pub async fn list_pending(&self) -> Vec<PendingPrompt> {
        self.pending
            .read()
            .await
            .values()
            .map(|p| p.info.clone())
            .collect()
    }

    /// REST endpoint backing: resolve a prompt with the user's decision.
    /// Returns `true` if the prompt existed and was resolved, `false` if
    /// it had already timed out / been resolved.
    pub async fn resolve(&self, id: &str, approved: bool) -> bool {
        let removed = self.pending.write().await.remove(id);
        match removed {
            Some(state) => {
                let _ = state.sender.send(approved);
                true
            }
            None => false,
        }
    }
}
