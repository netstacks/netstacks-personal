//! In-memory cache for enrichment results.
//!
//! Keyed by (session_host, token_type, token). Host-scoped so the same IP
//! on different sessions doesn't collide. TTL-based with a single
//! periodic-cleanup pass on get/insert to avoid unbounded growth.

use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Cached enrichment hit: (matcher_name, sources, errors).
pub type CachedEnrichment = (String, HashMap<String, Value>, HashMap<String, String>);

#[derive(Debug, Clone)]
struct CacheEntry {
    sources: HashMap<String, Value>,
    errors: HashMap<String, String>,
    matcher_name: String,
    inserted_at: Instant,
}

#[derive(Debug)]
pub struct EnrichmentCache {
    entries: HashMap<String, CacheEntry>,
    ttl: Duration,
    last_cleanup: Instant,
}

impl EnrichmentCache {
    pub fn new(ttl_seconds: u64) -> Self {
        Self {
            entries: HashMap::new(),
            ttl: Duration::from_secs(ttl_seconds),
            last_cleanup: Instant::now(),
        }
    }

    fn make_key(session_host: &str, token_type: &str, token: &str) -> String {
        format!("{}|{}|{}", session_host, token_type, token)
    }

    pub fn get(
        &mut self,
        session_host: &str,
        token_type: &str,
        token: &str,
    ) -> Option<CachedEnrichment> {
        self.maybe_cleanup();
        let key = Self::make_key(session_host, token_type, token);
        match self.entries.get(&key) {
            Some(entry) if entry.inserted_at.elapsed() < self.ttl => Some((
                entry.matcher_name.clone(),
                entry.sources.clone(),
                entry.errors.clone(),
            )),
            _ => None,
        }
    }

    pub fn insert(
        &mut self,
        session_host: &str,
        token_type: &str,
        token: &str,
        matcher_name: String,
        sources: HashMap<String, Value>,
        errors: HashMap<String, String>,
    ) {
        let key = Self::make_key(session_host, token_type, token);
        self.entries.insert(
            key,
            CacheEntry {
                sources,
                errors,
                matcher_name,
                inserted_at: Instant::now(),
            },
        );
    }

    /// Periodically drop expired entries. Runs at most once per minute.
    fn maybe_cleanup(&mut self) {
        if self.last_cleanup.elapsed() < Duration::from_secs(60) {
            return;
        }
        let ttl = self.ttl;
        self.entries.retain(|_, v| v.inserted_at.elapsed() < ttl);
        self.last_cleanup = Instant::now();
    }
}
