//! `SecretString` — a `String` newtype that redacts itself in Debug output.
//!
//! Used for password / token / passphrase fields on request structs so a
//! casual `tracing::debug!("{:?}", req)` can't leak the secret to logs.
//! Replaces the per-struct hand-rolled Debug impls that previously had to
//! be written and maintained for every request type that carried a
//! secret (5 such structs in api.rs alone).

use serde::{Deserialize, Serialize};

/// A `String` that prints as `[REDACTED]` in Debug output.
///
/// Serde-transparent so JSON / TOML / form decoding sees a plain string.
/// Use `.expose()` (or `.as_ref()`) at the point of consumption to get
/// the underlying `&str`; the name makes the intentional disclosure
/// readable at call sites.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    /// Read the underlying string. The name is deliberately distinctive
    /// — call sites are easy to grep for when reviewing where secrets are
    /// actually consumed. For construction use `From<String>` /
    /// `From<&str>` or rely on serde to deserialize one.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl AsRef<str> for SecretString {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for SecretString {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}
