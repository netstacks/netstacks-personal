//! Biometric vault unlock (macOS Touch ID).
//!
//! Stores the master password in the macOS Keychain (legacy generic-password
//! item) and gates store/retrieve calls behind an explicit
//! `LAContext.evaluatePolicy` Touch ID prompt. Retrieval feeds the password
//! into the existing `provider.unlock(password)` flow.
//!
//! ### Why not `kSecAttrAccessControl` with `BiometryCurrentSet`?
//!
//! That ACL works only with the macOS *Data Protection* keychain, which
//! requires the binary to be code-signed with a `keychain-access-groups`
//! entitlement. Dev cargo builds aren't signed — `SecItemAdd` returns
//! `errSecMissingEntitlement` (-34018). Doing the biometric check ourselves
//! via `LAContext` gives the same UX (Touch ID prompt) and works in any build.
//!
//! Trade-off: a process running as the same macOS user could theoretically
//! read the keychain item without going through our Touch ID gate. That's a
//! smaller threat than no biometric option at all and acceptable for a local
//! network-engineer tool. A signed production build can layer the Data
//! Protection ACL on top later by overriding `store`/`retrieve`.
//!
//! On non-macOS platforms every method is a graceful no-op / unsupported error.
//!
//! ### Stale-password handling
//!
//! There's no master-password CHANGE flow today (`set_master_password` errors
//! if a password already exists). If/when one is added, it MUST call
//! `BiometricVaultStore::delete()` and clear the `vault.biometric_enabled`
//! setting, otherwise the keychain entry will hold the old password.
//! Until then, the `/vault/biometric/unlock` endpoint self-heals: if the
//! retrieved password fails to unlock the vault it deletes the entry and
//! clears the setting, falling back to manual password entry.

use thiserror::Error;

/// Logical service name under which the master password is filed in the
/// keychain. Picked so it's findable via `security find-generic-password -s`.
/// Keychain access is macOS-only; the constant doesn't exist elsewhere.
#[cfg(target_os = "macos")]
pub const KEYCHAIN_SERVICE: &str = "net.netstacks.Terminal.vault";
/// Account/key within the service. We only ever store one password.
#[cfg(target_os = "macos")]
pub const KEYCHAIN_ACCOUNT: &str = "master_password";

// Variants are gated to the platform that constructs them so neither build
// carries a never-constructed variant: non-macOS only ever returns
// `Unsupported`; macOS returns the Touch ID / Keychain outcomes.
#[derive(Debug, Error)]
pub enum BiometricError {
    #[cfg(not(target_os = "macos"))]
    #[error("Biometric unlock is not supported on this platform")]
    Unsupported,
    #[cfg(target_os = "macos")]
    #[error("No biometric enrollment exists for the vault")]
    NotEnrolled,
    #[cfg(target_os = "macos")]
    #[error("User cancelled the biometric prompt")]
    UserCancelled,
    #[cfg(target_os = "macos")]
    #[error("Biometric failed: {0}")]
    Other(String),
}

pub struct BiometricVaultStore;

impl BiometricVaultStore {
    /// Whether biometric unlock is implemented on this build.
    pub fn is_supported() -> bool {
        cfg!(target_os = "macos")
    }

    /// Whether a keychain entry currently exists. Does NOT trigger Touch ID.
    pub fn is_enrolled() -> bool {
        #[cfg(target_os = "macos")]
        {
            macos::is_enrolled()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Store the password. Prompts for Touch ID first to confirm the user
    /// is physically present.
    pub async fn store(password: String) -> Result<(), BiometricError> {
        #[cfg(target_os = "macos")]
        {
            tokio::task::spawn_blocking(move || macos::store(&password))
                .await
                .map_err(|e| BiometricError::Other(format!("join error: {}", e)))?
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = password;
            Err(BiometricError::Unsupported)
        }
    }

    /// Prompt for Touch ID, then retrieve the stored password.
    pub async fn retrieve() -> Result<String, BiometricError> {
        #[cfg(target_os = "macos")]
        {
            tokio::task::spawn_blocking(macos::retrieve)
                .await
                .map_err(|e| BiometricError::Other(format!("join error: {}", e)))?
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(BiometricError::Unsupported)
        }
    }

    /// Remove the keychain entry. No biometric prompt — disabling Touch ID
    /// from settings shouldn't require fingerprint authentication.
    pub async fn delete() -> Result<(), BiometricError> {
        #[cfg(target_os = "macos")]
        {
            tokio::task::spawn_blocking(macos::delete)
                .await
                .map_err(|e| BiometricError::Other(format!("join error: {}", e)))?
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{BiometricError, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub(super) fn is_enrolled() -> bool {
        get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).is_ok()
    }

    pub(super) fn store(password: &str) -> Result<(), BiometricError> {
        prompt_biometric("Enable Touch ID for the NetStacks vault")?;
        set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, password.as_bytes())
            .map_err(|e| BiometricError::Other(format!("set_generic_password: {}", e)))
    }

    pub(super) fn retrieve() -> Result<String, BiometricError> {
        prompt_biometric("Unlock the NetStacks vault")?;
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(bytes) => std::str::from_utf8(&bytes)
                .map(|s| s.to_string())
                .map_err(|e| BiometricError::Other(format!("password not UTF-8: {}", e))),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("not found") || msg.contains("-25300") {
                    Err(BiometricError::NotEnrolled)
                } else {
                    Err(BiometricError::Other(format!("get_generic_password: {}", e)))
                }
            }
        }
    }

    pub(super) fn delete() -> Result<(), BiometricError> {
        match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("not found") || msg.contains("-25300") {
                    Ok(())
                } else {
                    Err(BiometricError::Other(format!("delete_generic_password: {}", e)))
                }
            }
        }
    }

    /// Drive `LAContext.evaluatePolicy` synchronously. The system shows a
    /// Touch ID prompt with the supplied reason; we block on a channel until
    /// the async callback fires.
    fn prompt_biometric(reason: &str) -> Result<(), BiometricError> {
        use block2::RcBlock;
        use objc2::rc::Retained;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};
        use std::sync::mpsc;

        // LAPolicyDeviceOwnerAuthenticationWithBiometrics. Strict biometric
        // only; no system-password fallback inside the prompt — the user's
        // master password remains the recovery path on the unlock screen.
        const LA_POLICY_BIOMETRICS: LAPolicy = LAPolicy(1);

        let context: Retained<LAContext> = unsafe { LAContext::new() };

        // Pre-flight: device must have biometrics enrolled.
        if let Err(err) = unsafe { context.canEvaluatePolicy_error(LA_POLICY_BIOMETRICS) } {
            return Err(BiometricError::Other(format!(
                "Touch ID is unavailable: {}",
                err
            )));
        }

        let reason_ns = NSString::from_str(reason);

        // evaluatePolicy:reply: dispatches its callback on a background queue.
        // Bridge it back to our blocking caller via a channel.
        let (tx, rx) = mpsc::channel::<Result<(), BiometricError>>();
        let block = RcBlock::new(move |success: Bool, error: *mut NSError| {
            let result = if success.as_bool() {
                Ok(())
            } else if error.is_null() {
                Err(BiometricError::Other(
                    "LAContext failure (no error object)".to_string(),
                ))
            } else {
                let err: &NSError = unsafe { &*error };
                let code = err.code();
                // LAErrorUserCancel = -2, LAErrorAppCancel = -9, LAErrorSystemCancel = -4
                if code == -2 || code == -9 || code == -4 {
                    Err(BiometricError::UserCancelled)
                } else {
                    Err(BiometricError::Other(format!(
                        "LAContext error code {}: {}",
                        code,
                        err.localizedDescription()
                    )))
                }
            };
            let _ = tx.send(result);
        });

        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                LA_POLICY_BIOMETRICS,
                &reason_ns,
                &block,
            );
        }

        rx.recv()
            .map_err(|e| BiometricError::Other(format!("LAContext channel: {}", e)))?
    }
}
