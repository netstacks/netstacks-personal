//! Enrichment engine — `POST /enrich` endpoint and supporting machinery.
//!
//! Takes a token from a terminal session (interface name, IP, MAC, VLAN),
//! matches it against the configured token patterns, then queries every
//! configured enrichment source in parallel and returns merged JSON.
//!
//! All matcher logic, source queries, and caching live here so the webview
//! side stays a dumb renderer.

pub mod cache;
pub mod config;
pub mod matcher;
pub mod oui;
pub mod pipeline;

pub use cache::EnrichmentCache;
pub use matcher::MatcherRegistry;
pub use pipeline::{ActiveSources, Pipeline};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct EnrichRequest {
    pub token: String,
    pub session_id: Option<String>,
    pub cli_flavor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnrichResponse {
    pub token: String,
    pub token_type: Option<String>,
    pub matcher_name: Option<String>,
    pub sources: HashMap<String, serde_json::Value>,
    /// Per-source error messages for sources that failed (HTTP 4xx/5xx,
    /// network errors, etc). 404s and empty results are NOT errors — they
    /// just leave the source out of `sources`. Surfacing these lets the UI
    /// distinguish "no data" from "couldn't fetch data" (e.g. rate limited).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub errors: HashMap<String, String>,
    pub cached: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveMatcher {
    pub name: String,
    pub patterns: Vec<String>,
    pub cli_flavors: Vec<String>,
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveMatchersResponse {
    pub matchers: Vec<ActiveMatcher>,
    pub crawler_available: bool,
    pub netbox_available: bool,
}
