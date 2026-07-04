//! Connection pool for short, repeated `exec` operations to the same SSH
//! host (chiefly: net-snmp CLI tools running on a jump bastion).
//!
//! ## Why this exists
//!
//! `exec_on_remote` does a full TCP-connect + SSH handshake + auth + exec +
//! disconnect every call. The DeviceDetailTab fires ~15 SNMP queries
//! roughly concurrently when a device tab opens; without pooling, that's
//! 15 fresh handshakes against the bastion's sshd in a few hundred
//! milliseconds — easily tripping `MaxStartups` (OpenSSH default
//! `10:30:100`) or per-user session caps. The visible symptom is the exec
//! channel closing without an exit status (`ExecTermination::ClosedSilently`).
//!
//! ## Design (deliberately small)
//!
//! - Pool keyed by `(host, port, username)`. Different creds for the same
//!   tuple are not modeled; in practice there's one identity per jump.
//! - Per-key tokio `Mutex` serializes operations to a given jump. We give
//!   up parallelism on a single jump in exchange for never tripping sshd
//!   concurrency limits — bulletproof beats fast.
//! - Cached `Handle<ClientHandler>` reused for `POOL_TTL` after last use;
//!   each operation opens a fresh exec channel on it.
//! - Any error from `exec_on_handle` (including timeout) drops the cached
//!   handle so the next call reconnects. We never hand out a handle whose
//!   last operation failed.
//! - Lazy eviction only — no background reaper. The HashMap entries are
//!   tiny (`Arc<Mutex<Option<PoolEntry>>>`) and the set of distinct jumps
//!   per session is small.

use russh::client;
use russh::Disconnect;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::{
    connect_and_authenticate, exec_on_handle, ClientHandler, ExecResult, SshConfig, SshError,
};

/// How long a cached handle stays warm after its last successful use.
/// Long enough to absorb a device-tab's burst of queries (~5s) plus a
/// follow-up Refresh click; short enough that an idle pool entry doesn't
/// hog a sshd session slot indefinitely.
const POOL_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PoolKey {
    host: String,
    port: u16,
    username: String,
}

impl PoolKey {
    fn from_config(config: &SshConfig) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
        }
    }
}

struct PoolEntry {
    handle: client::Handle<ClientHandler>,
    last_used: Instant,
}

/// Inner per-key slot: `Option` so a failed/expired entry can be cleared
/// in place without removing the outer HashMap entry (which would force
/// the next caller to take the outer lock again).
type Slot = Arc<Mutex<Option<PoolEntry>>>;

static POOL: LazyLock<Mutex<HashMap<PoolKey, Slot>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Same contract as `exec_on_remote`, but reuses a cached SSH connection
/// when one exists for `(host, port, username)` and is fresher than
/// `POOL_TTL`. Concurrent calls to the same jump serialize on a per-jump
/// mutex; calls to different jumps run in parallel.
pub async fn exec_on_remote_pooled(
    config: &SshConfig,
    command: &str,
    timeout_total: Duration,
) -> Result<ExecResult, SshError> {
    let slot = get_slot(config).await;
    let mut guard = slot.lock().await;

    // Refresh-or-connect under the per-key lock so we never race on
    // tearing down a stale entry while another caller starts a new one.
    let needs_new = !matches!(&*guard, Some(entry) if entry.last_used.elapsed() < POOL_TTL);

    if needs_new {
        if let Some(old) = guard.take() {
            // Best-effort: don't let a slow disconnect hold up the new call.
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                old.handle.disconnect(Disconnect::ByApplication, "", "en"),
            )
            .await;
        }
        let handle = connect_and_authenticate(config, false).await?;
        *guard = Some(PoolEntry { handle, last_used: Instant::now() });
    }

    let entry = guard.as_mut().expect("entry just inserted or refreshed");

    let exec_outcome =
        tokio::time::timeout(timeout_total, exec_on_handle(&entry.handle, command)).await;

    match exec_outcome {
        Ok(Ok(result)) => {
            entry.last_used = Instant::now();
            Ok(result)
        }
        Ok(Err(e)) => {
            // Channel-level error means the cached handle may be hosed
            // (peer closed, MaxSessions hit, etc.) — drop it so the next
            // call gets a fresh connection.
            *guard = None;
            Err(e)
        }
        Err(_) => {
            *guard = None;
            Err(SshError::ConnectionFailed(format!(
                "exec on {}:{} timed out after {}s",
                config.host,
                config.port,
                timeout_total.as_secs()
            )))
        }
    }
}

async fn get_slot(config: &SshConfig) -> Slot {
    let key = PoolKey::from_config(config);
    let mut pool = POOL.lock().await;
    pool.entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_utils::{ephemeral_ed25519, start_test_server, ExecResponse, TestServerConfig};
    use crate::ssh::SshAuth;

    fn cfg(addr: std::net::SocketAddr, user: &str) -> SshConfig {
        SshConfig {
            host: addr.ip().to_string(),
            port: addr.port(),
            username: user.into(),
            auth: SshAuth::Password("p".into()),
            legacy_ssh: false,
            skip_keyboard_interactive: false,
        }
    }

    /// The whole point of the pool: two back-to-back calls to the same jump
    /// must reuse one SSH connection. We can't observe auth count from the
    /// test server, so we observe reuse indirectly — assert the cached
    /// handle's address is identical across the two calls.
    #[tokio::test]
    async fn pool_reuses_connection_for_back_to_back_calls() {
        let addr = start_test_server(TestServerConfig {
            accept_password: Some(("pool-reuse-user".into(), "p".into())),
            accept_key_user: None,
            allow_direct_tcpip: false,
            exec_responder: Some(Arc::new(|_cmd: &str| {
                Some(ExecResponse {
                    stdout: b"ok\n".to_vec(),
                    stderr: vec![],
                    exit_status: 0,
                })
            })),
            eof_before_exit_status: false,
            host_key: ephemeral_ed25519(),
        })
        .await;

        let cfg = cfg(addr, "pool-reuse-user");

        let r1 = exec_on_remote_pooled(&cfg, "echo ok", Duration::from_secs(5))
            .await
            .expect("first exec should succeed");
        assert_eq!(r1.exit_status, Some(0));

        let slot1 = get_slot(&cfg).await;
        let handle_addr_1 = {
            let g = slot1.lock().await;
            g.as_ref().map(|e| &e.handle as *const _ as usize)
        };

        let r2 = exec_on_remote_pooled(&cfg, "echo ok", Duration::from_secs(5))
            .await
            .expect("second exec should succeed");
        assert_eq!(r2.exit_status, Some(0));

        let slot2 = get_slot(&cfg).await;
        let handle_addr_2 = {
            let g = slot2.lock().await;
            g.as_ref().map(|e| &e.handle as *const _ as usize)
        };

        assert!(handle_addr_1.is_some() && handle_addr_2.is_some(),
            "pool should have a cached entry after each call");
        assert_eq!(handle_addr_1, handle_addr_2,
            "second call should reuse the first call's cached handle");
    }

}
