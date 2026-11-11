use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatcherConfig {
    /// Unique identifier — used as `matcher_name` in enrich responses.
    pub name: String,

    /// Regex patterns. The first one to match wins.
    pub patterns: Vec<String>,

    /// Only activate when the session's CLI flavor is in this list. Empty list
    /// means activate for all flavors.
    #[serde(default)]
    pub cli_flavors: Vec<String>,

    /// Names of enrichment sources to run when this matcher fires.
    pub enrich: Vec<String>,

    /// Higher priority wins when multiple matchers' patterns overlap.
    #[serde(default)]
    pub priority: i32,

    /// If the regex has capture groups, use this group as the token to look up
    /// (1-indexed). Defaults to the full match (group 0).
    #[serde(default)]
    pub capture_group: Option<usize>,
}
