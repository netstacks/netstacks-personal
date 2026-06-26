//! OAuth2 token management for AI providers.
//!
//! Supports client_credentials grant type for enterprise API gateways
//! like Apigee that sit in front of AI services (Vertex AI, etc.).
//!
//! Tokens are cached in-memory and refreshed automatically before expiry.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
// parking_lot::Mutex doesn't poison on panic — keeps the registry usable
// after any single token-fetch crash.
use parking_lot::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// OAuth2 configuration for client_credentials grant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuth2Config {
    /// Token endpoint URL (e.g., "https://api.example.com/oauth/token")
    pub token_url: String,
    /// OAuth2 client ID
    pub client_id: String,
    /// OAuth2 client secret
    pub client_secret: String,
    /// Additional custom headers to include on API requests (e.g., user_email)
    #[serde(default)]
    pub custom_headers: std::collections::HashMap<String, String>,
    /// Verify TLS certificates (default true). Set false to accept self-signed certs.
    #[serde(default = "default_true")]
    pub verify_ssl: bool,
}

/// A cached OAuth2 token with expiry tracking.
#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    /// When this token was fetched
    fetched_at: Instant,
    /// How long the token is valid (from the server's expires_in field)
    expires_in: Duration,
}

impl CachedToken {
    /// Check if the token is still valid (with 60-second safety margin).
    fn is_valid(&self) -> bool {
        let elapsed = self.fetched_at.elapsed();
        let margin = Duration::from_secs(60);
        elapsed + margin < self.expires_in
    }
}

/// Token response from OAuth2 token endpoint.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
    // Accepted from the OAuth2 token response for forward-compat but not read;
    // `_` prefix silences dead_code, serde(rename) keeps the wire field name.
    #[serde(rename = "token_type")]
    _token_type: Option<String>,
}

fn default_expires_in() -> u64 {
    1800 // 30 minutes default
}

fn default_true() -> bool { true }

/// Manages OAuth2 tokens with automatic caching and refresh.
///
/// Thread-safe — can be shared across async tasks via Arc.
#[derive(Clone)]
pub struct OAuth2TokenManager {
    config: OAuth2Config,
    client: reqwest::Client,
    cached_token: Arc<RwLock<Option<CachedToken>>>,
}

/// Process-wide registry of token managers, deduplicated by OAuth2 config.
///
/// Each NetStacks chat request currently constructs a fresh `AiProvider`
/// (`create_provider(config)` is called per request — see `ai/chat.rs`).
/// Without this registry, every request would also construct a fresh
/// `OAuth2TokenManager` with an empty `cached_token`, causing a new token
/// fetch on every single chat turn — even when the previously-issued token
/// has 29 minutes of life left.
///
/// We key on (token_url, client_id, client_secret) so that a config change
/// (e.g., user rotates their secret in Settings) gets a fresh manager
/// without breaking in-flight requests using the old config.
fn registry() -> &'static StdMutex<HashMap<String, Arc<OAuth2TokenManager>>> {
    static REGISTRY: OnceLock<StdMutex<HashMap<String, Arc<OAuth2TokenManager>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn config_cache_key(config: &OAuth2Config) -> String {
    format!("{}|{}|{}|{}", config.token_url, config.client_id, config.client_secret, config.verify_ssl)
}

impl OAuth2TokenManager {
    /// Create a new token manager with the given OAuth2 configuration.
    ///
    /// Prefer `get_or_create_shared` for chat hot paths so the token cache
    /// survives across per-request provider constructions.
    pub fn new(config: OAuth2Config) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .danger_accept_invalid_certs(!config.verify_ssl)
            .build()
            .expect("Failed to create HTTP client for OAuth2");

        Self {
            config,
            client,
            cached_token: Arc::new(RwLock::new(None)),
        }
    }

    /// Return a process-wide-shared `OAuth2TokenManager` for the given config.
    ///
    /// All callers passing the same (token_url, client_id, client_secret)
    /// triple get the same `Arc<OAuth2TokenManager>` — and therefore the
    /// same in-memory token cache — so a token issued with `expires_in=1799`
    /// is reused for nearly half an hour instead of being re-fetched on
    /// every chat call.
    ///
    /// The registry uses a sync `parking_lot::Mutex` so this stays
    /// callable from sync constructors. The held critical section is tiny
    /// (HashMap lookup + clone of an Arc) so the sync lock has no perf
    /// cost on the hot path. The token cache itself remains
    /// `tokio::sync::RwLock`-based for the read-heavy `get_token` path.
    pub fn get_or_create_shared(config: OAuth2Config) -> Arc<Self> {
        let key = config_cache_key(&config);
        let mut registry = registry().lock();
        if let Some(existing) = registry.get(&key) {
            return existing.clone();
        }
        let manager = Arc::new(Self::new(config));
        registry.insert(key, manager.clone());
        manager
    }

    /// Get a valid access token, fetching or refreshing as needed.
    pub async fn get_token(&self) -> Result<String, OAuth2Error> {
        // Check cached token first (read lock)
        {
            let cache = self.cached_token.read().await;
            if let Some(ref token) = *cache {
                if token.is_valid() {
                    return Ok(token.access_token.clone());
                }
            }
        }

        // Token expired or missing — fetch a new one (write lock)
        let mut cache = self.cached_token.write().await;
        // Double-check after acquiring write lock (another task may have refreshed)
        if let Some(ref token) = *cache {
            if token.is_valid() {
                return Ok(token.access_token.clone());
            }
        }

        tracing::info!("OAuth2: fetching new token from {}", self.config.token_url);
        let new_token = self.fetch_token().await?;
        let access_token = new_token.access_token.clone();
        *cache = Some(new_token);
        Ok(access_token)
    }

    /// Invalidate the cached token (e.g., after a 401 response).
    pub async fn invalidate(&self) {
        let mut cache = self.cached_token.write().await;
        *cache = None;
        tracing::info!("OAuth2: token invalidated, will re-fetch on next request");
    }

    /// Fetch a new token from the OAuth2 token endpoint using client_credentials grant.
    async fn fetch_token(&self) -> Result<CachedToken, OAuth2Error> {
        let response = self
            .client
            .post(&self.config.token_url)
            .basic_auth(&self.config.client_id, Some(&self.config.client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await
            .map_err(|e| OAuth2Error::RequestFailed(format!("Token request failed: {}", e)))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(OAuth2Error::TokenError(format!(
                "Token endpoint returned {}: {}",
                status, body
            )));
        }

        let token_response: TokenResponse = response
            .json()
            .await
            .map_err(|e| OAuth2Error::ParseError(format!("Failed to parse token response: {}", e)))?;

        tracing::info!(
            "OAuth2: token acquired, expires in {} seconds",
            token_response.expires_in
        );

        Ok(CachedToken {
            access_token: token_response.access_token,
            fetched_at: Instant::now(),
            expires_in: Duration::from_secs(token_response.expires_in),
        })
    }
}

/// Errors that can occur during OAuth2 token management.
#[derive(Debug, thiserror::Error)]
pub enum OAuth2Error {
    #[error("OAuth2 request failed: {0}")]
    RequestFailed(String),

    #[error("OAuth2 token error: {0}")]
    TokenError(String),

    #[error("OAuth2 parse error: {0}")]
    ParseError(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cached_token_validity() {
        let token = CachedToken {
            access_token: "test".to_string(),
            fetched_at: Instant::now(),
            expires_in: Duration::from_secs(3600),
        };
        assert!(token.is_valid());
    }

    #[test]
    fn test_cached_token_expired() {
        let token = CachedToken {
            access_token: "test".to_string(),
            fetched_at: Instant::now() - Duration::from_secs(3700),
            expires_in: Duration::from_secs(3600),
        };
        assert!(!token.is_valid());
    }
}
