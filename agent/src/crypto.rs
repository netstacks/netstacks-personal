//! Cryptographic utilities for credential encryption.
//!
//! Thin facade over the audited `netstacks-credential-vault` crate
//! (open-source — see https://github.com/netstacks/netstacks-crypto).
//!
//! Uses AES-256-GCM for authenticated encryption with Argon2id key derivation.

use netstacks_credential_vault::{CredentialVault, MasterKey, VaultError};
use rand::RngCore;
use thiserror::Error;

/// Salt size in bytes (passed to Argon2id)
pub const SALT_SIZE: usize = 32;

/// AES-256-GCM nonce size (96 bits / 12 bytes)
const NONCE_SIZE: usize = 12;

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Encryption failed")]
    EncryptionFailed,
    #[error("Decryption failed - wrong password or corrupted data")]
    DecryptionFailed,
    #[error("Invalid data format")]
    InvalidFormat,
}

impl From<VaultError> for CryptoError {
    fn from(e: VaultError) -> Self {
        match e {
            VaultError::KeyDerivation | VaultError::InvalidKey => Self::DecryptionFailed,
            VaultError::Encryption => Self::EncryptionFailed,
            VaultError::Decryption => Self::DecryptionFailed,
            VaultError::InvalidCiphertext => Self::InvalidFormat,
        }
    }
}

/// Encrypted blob with the salt that was used to derive the encryption key.
///
/// On-disk layout: `salt(32) || nonce(12) || ciphertext`. The `blob` field
/// holds `nonce || ciphertext` together, matching `CredentialVault`'s output.
#[derive(Debug, Clone)]
pub struct EncryptedData {
    pub salt: [u8; SALT_SIZE],
    pub blob: Vec<u8>,
}

impl EncryptedData {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(SALT_SIZE + self.blob.len());
        out.extend_from_slice(&self.salt);
        out.extend_from_slice(&self.blob);
        out
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, CryptoError> {
        if data.len() < SALT_SIZE + NONCE_SIZE {
            return Err(CryptoError::InvalidFormat);
        }
        let mut salt = [0u8; SALT_SIZE];
        salt.copy_from_slice(&data[..SALT_SIZE]);
        let blob = data[SALT_SIZE..].to_vec();
        Ok(Self { salt, blob })
    }
}

/// Generate a cryptographically random salt
pub fn generate_salt() -> [u8; SALT_SIZE] {
    let mut salt = [0u8; SALT_SIZE];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Derive a `CredentialVault` from a password + salt using Argon2id.
///
/// This is the slow path (Argon2id is intentionally expensive). After the
/// vault is unlocked once, callers should cache the resulting `CredentialVault`
/// and use `encrypt_with_vault` / `decrypt_with_vault` for subsequent ops.
pub fn derive_vault(password: &str, salt: &[u8; SALT_SIZE]) -> Result<CredentialVault, CryptoError> {
    let mk = MasterKey::derive(password.as_bytes(), salt)?;
    Ok(mk.create_vault()?)
}

/// Encrypt plaintext using a master password (slow per-call Argon2id derivation)
pub fn encrypt(plaintext: &str, master_password: &str) -> Result<EncryptedData, CryptoError> {
    let salt = generate_salt();
    let vault = derive_vault(master_password, &salt)?;
    let blob = vault.encrypt(plaintext.as_bytes())?;
    Ok(EncryptedData { salt, blob })
}

/// Decrypt ciphertext using a master password (slow per-call Argon2id derivation)
pub fn decrypt(encrypted: &EncryptedData, master_password: &str) -> Result<String, CryptoError> {
    let vault = derive_vault(master_password, &encrypted.salt)?;
    let plaintext = vault.decrypt(&encrypted.blob)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed)
}

/// Encrypt plaintext using a pre-derived vault (fast path — use after unlock)
pub fn encrypt_with_vault(
    plaintext: &str,
    vault: &CredentialVault,
    salt: &[u8; SALT_SIZE],
) -> Result<EncryptedData, CryptoError> {
    let blob = vault.encrypt(plaintext.as_bytes())?;
    Ok(EncryptedData { salt: *salt, blob })
}

/// Decrypt ciphertext using a pre-derived vault (fast path — use after unlock)
pub fn decrypt_with_vault(
    encrypted: &EncryptedData,
    vault: &CredentialVault,
) -> Result<String, CryptoError> {
    let plaintext = vault.decrypt(&encrypted.blob)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = "my_secret_password";
        let master_password = "master_password_long_enough";

        let encrypted = encrypt(plaintext, master_password).unwrap();
        let decrypted = decrypt(&encrypted, master_password).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_wrong_password_fails() {
        let plaintext = "my_secret_password";
        let master_password = "master_password_long_enough";
        let wrong_password = "different_password_entirely";

        let encrypted = encrypt(plaintext, master_password).unwrap();
        let result = decrypt(&encrypted, wrong_password);

        assert!(result.is_err());
    }

    #[test]
    fn test_serialization_roundtrip() {
        let plaintext = "my_secret_password";
        let master_password = "master_password_long_enough";

        let encrypted = encrypt(plaintext, master_password).unwrap();
        let bytes = encrypted.to_bytes();
        let restored = EncryptedData::from_bytes(&bytes).unwrap();
        let decrypted = decrypt(&restored, master_password).unwrap();

        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_vault_roundtrip() {
        let salt = generate_salt();
        let vault = derive_vault("master_password_long_enough", &salt).unwrap();

        let encrypted = encrypt_with_vault("payload", &vault, &salt).unwrap();
        let decrypted = decrypt_with_vault(&encrypted, &vault).unwrap();

        assert_eq!(decrypted, "payload");
    }

    #[test]
    fn test_unique_nonces_per_encryption() {
        let salt = generate_salt();
        let vault = derive_vault("master_password_long_enough", &salt).unwrap();

        let a = encrypt_with_vault("same plaintext", &vault, &salt).unwrap();
        let b = encrypt_with_vault("same plaintext", &vault, &salt).unwrap();

        assert_ne!(a.blob, b.blob);
    }
}
