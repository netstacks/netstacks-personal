//! Concurrency-permit handle that can release the semaphore slot while a
//! task is parked waiting for a human, then re-acquire it before resuming
//! real work. See Feature B: a parked free-form question must NOT hold a
//! semaphore slot, or several parked questions deadlock the cap-N pool.

use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

/// Wraps the active permit and the semaphore so the react loop can drop the
/// slot during a human park and re-acquire it on resume.
pub struct PermitGuard {
    semaphore: Arc<Semaphore>,
    /// `None` while parked (slot released); `Some` while holding the slot.
    permit: Option<OwnedSemaphorePermit>,
}

/// Re-acquire failed (semaphore closed) or the task was cancelled while
/// parked. The caller must treat either as a fail-closed terminal outcome.
pub enum ReacquireError {
    Cancelled,
    SemaphoreClosed,
}

impl PermitGuard {
    pub fn new(semaphore: Arc<Semaphore>, permit: OwnedSemaphorePermit) -> Self {
        Self {
            semaphore,
            permit: Some(permit),
        }
    }

    /// Drop the held permit, freeing the slot for another task. Idempotent.
    pub fn release(&mut self) {
        // Dropping the OwnedSemaphorePermit returns the slot to the semaphore.
        self.permit = None;
    }

    /// Re-acquire a slot. Cancel-aware: if the task is cancelled while we wait
    /// for a free slot, return `Cancelled` instead of blocking indefinitely.
    /// A no-op if the guard already holds a permit.
    pub async fn reacquire(
        &mut self,
        cancel_token: &CancellationToken,
    ) -> Result<(), ReacquireError> {
        if self.permit.is_some() {
            return Ok(()); // already holding
        }
        let sem = self.semaphore.clone();
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => Err(ReacquireError::Cancelled),
            res = sem.acquire_owned() => {
                match res {
                    Ok(p) => {
                        self.permit = Some(p);
                        Ok(())
                    }
                    Err(_) => Err(ReacquireError::SemaphoreClosed),
                }
            }
        }
    }
}
