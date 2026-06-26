//! Compiled regex registry for the enrichment engine.
//!
//! `EnrichmentMatcher` rows from the DB are compiled once and stored sorted by
//! priority descending. `find_matcher()` returns the highest-priority match
//! that also satisfies the CLI-flavor gate (if any).

use crate::enrich::config::MatcherConfig;
use crate::models::EnrichmentMatcher;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Arc;

/// A compiled matcher — its config plus the compiled regex patterns.
#[derive(Debug)]
pub struct CompiledMatcher {
    pub config: MatcherConfig,
    pub regexes: Vec<Regex>,
}

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub matcher_name: String,
    pub token_normalized: String,
    pub enrich_sources: Vec<String>,
}

#[derive(Debug)]
pub struct MatcherRegistry {
    /// Sorted by `priority` descending so the first hit wins.
    matchers: Vec<Arc<CompiledMatcher>>,
}

impl MatcherRegistry {
    /// Build a registry from DB-loaded matchers + a source-id → source-name
    /// lookup table. The pipeline calls sources by name, so we resolve the
    /// matcher's source_ids to names here at load time.
    pub fn from_db(matchers: &[EnrichmentMatcher], sources_by_id: &HashMap<String, String>) -> Self {
        let mut compiled: Vec<Arc<CompiledMatcher>> = matchers
            .iter()
            .filter_map(|m| {
                let regexes: Result<Vec<Regex>, _> =
                    m.patterns.iter().map(|p| Regex::new(p)).collect();
                let regexes = match regexes {
                    Ok(rs) => rs,
                    Err(e) => {
                        tracing::warn!(matcher = %m.name, error = %e, "matcher regex failed to compile — skipped");
                        return None;
                    }
                };
                let enrich_sources: Vec<String> = m.source_ids.iter()
                    .filter_map(|sid| sources_by_id.get(sid).cloned())
                    .collect();
                let config = MatcherConfig {
                    name: m.name.clone(),
                    patterns: m.patterns.clone(),
                    cli_flavors: m.cli_flavors.clone(),
                    enrich: enrich_sources,
                    priority: m.priority,
                    capture_group: None,
                };
                Some(Arc::new(CompiledMatcher { config, regexes }))
            })
            .collect();
        compiled.sort_by(|a, b| b.config.priority.cmp(&a.config.priority));
        Self { matchers: compiled }
    }

    /// Find the highest-priority matcher whose pattern matches `token` and
    /// whose `cli_flavors` filter accepts the given session flavor (if any).
    pub fn find_matcher(&self, token: &str, cli_flavor: Option<&str>) -> Option<MatchResult> {
        for m in &self.matchers {
            // CLI flavor gate
            if !m.config.cli_flavors.is_empty() {
                match cli_flavor {
                    Some(flavor) if m.config.cli_flavors.iter().any(|f| f == flavor) => {}
                    _ => continue,
                }
            }
            // Pattern test
            for re in &m.regexes {
                if let Some(caps) = re.captures(token) {
                    let normalized = if let Some(g) = m.config.capture_group {
                        caps.get(g).map(|c| c.as_str().to_string())
                    } else {
                        caps.get(0).map(|c| c.as_str().to_string())
                    };
                    if let Some(n) = normalized {
                        return Some(MatchResult {
                            matcher_name: m.config.name.clone(),
                            token_normalized: n,
                            enrich_sources: m.config.enrich.clone(),
                        });
                    }
                }
            }
        }
        None
    }

    /// All matchers currently registered. Used by the `/enrich/active-matchers`
    /// endpoint after filtering by which sources are actually configured.
    pub fn all_matchers(&self) -> &[Arc<CompiledMatcher>] {
        &self.matchers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_matcher(name: &str, patterns: &[&str], cli_flavors: &[&str], priority: i32, source_ids: &[&str]) -> crate::models::EnrichmentMatcher {
        crate::models::EnrichmentMatcher {
            id: name.to_string(),
            name: name.to_string(),
            description: String::new(),
            patterns: patterns.iter().map(|s| s.to_string()).collect(),
            cli_flavors: cli_flavors.iter().map(|s| s.to_string()).collect(),
            priority,
            is_builtin: false,
            source_ids: source_ids.iter().map(|s| s.to_string()).collect(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn matches_ipv4() {
        let matchers = [make_matcher("ipv4", &[r"\b(?:\d{1,3}\.){3}\d{1,3}\b"], &[], 10, &["src1"])];
        let sources_by_id = [("src1".to_string(), "dns_ptr".to_string())].into_iter().collect();
        let r = MatcherRegistry::from_db(&matchers, &sources_by_id);
        let m = r.find_matcher("10.1.1.1", None).expect("should match");
        assert_eq!(m.matcher_name, "ipv4");
        assert_eq!(m.token_normalized, "10.1.1.1");
    }

    #[test]
    fn cli_flavor_gating_excludes_non_matching() {
        let matchers = [make_matcher("junos", &[r"ge-\d+/\d+/\d+"], &["juniper"], 10, &[])];
        let r = MatcherRegistry::from_db(&matchers, &Default::default());
        assert!(r.find_matcher("ge-0/0/0", Some("juniper")).is_some());
        assert!(r.find_matcher("ge-0/0/0", Some("cisco-ios")).is_none());
        assert!(r.find_matcher("ge-0/0/0", None).is_none());
    }

    #[test]
    fn higher_priority_wins() {
        let matchers = [
            make_matcher("low",  &["foo"], &[], 1, &["sx"]),
            make_matcher("high", &["foo"], &[], 5, &["sy"]),
        ];
        let r = MatcherRegistry::from_db(&matchers, &Default::default());
        let m = r.find_matcher("foo", None).unwrap();
        assert_eq!(m.matcher_name, "high");
    }
}
