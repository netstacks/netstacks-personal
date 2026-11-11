//! Search endpoint — aggregates matches across entity types.

use std::sync::Arc;
use axum::{extract::{Query, State}, Json};
use serde::{Deserialize, Serialize};
use crate::api::AppState;

#[derive(Serialize, PartialEq, Debug)]
pub struct SearchHit {
    pub r#type: String,
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub score: i32,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
}

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: Option<String>,
    pub types: Option<String>,
    pub limit: Option<usize>,
}

/// Rank a candidate string against the query. None = no match.
/// exact (100) > prefix (60) > substring (30), case-insensitive.
pub fn score_match(haystack: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return None;
    }
    let h = haystack.to_lowercase();
    let n = needle.to_lowercase();
    if h == n {
        Some(100)
    } else if h.starts_with(&n) {
        Some(60)
    } else if h.contains(&n) {
        Some(30)
    } else {
        None
    }
}

fn wants(types: &Option<Vec<String>>, t: &str) -> bool {
    match types {
        None => true,
        Some(v) => v.iter().any(|x| x == t),
    }
}

/// GET /search — aggregate matches across entity types via the provider
/// and db layers. Reuses existing list_* methods so enterprise parity is
/// automatic (same provider trait backs both modes).
pub async fn search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchParams>,
) -> Json<SearchResponse> {
    let q = params.q.unwrap_or_default();
    let limit = params.limit.unwrap_or(30).min(100);
    let types: Option<Vec<String>> = params.types.map(|s| {
        s.split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect()
    });

    let mut hits: Vec<SearchHit> = Vec::new();
    if q.trim().is_empty() {
        return Json(SearchResponse { results: hits });
    }

    // Sessions
    if wants(&types, "session") {
        if let Ok(sessions) = state.provider.list_sessions().await {
            for s in sessions {
                if let Some(score) = score_match(&s.name, &q) {
                    hits.push(SearchHit {
                        r#type: "session".into(),
                        id: s.id.clone(),
                        title: s.name.clone(),
                        subtitle: Some(s.host.clone()),
                        score,
                    });
                }
            }
        }
    }

    // Topologies
    if wants(&types, "topology") {
        if let Ok(tops) = state.provider.list_topologies().await {
            for t in tops {
                if let Some(score) = score_match(&t.name, &q) {
                    hits.push(SearchHit {
                        r#type: "topology".into(),
                        id: t.id.clone(),
                        title: t.name.clone(),
                        subtitle: None,
                        score,
                    });
                }
            }
        }
    }

    // MOP templates
    if wants(&types, "mop") {
        if let Ok(mops) = state.provider.list_mop_templates().await {
            for m in mops {
                if let Some(score) = score_match(&m.name, &q) {
                    hits.push(SearchHit {
                        r#type: "mop".into(),
                        id: m.id.clone(),
                        title: m.name.clone(),
                        subtitle: None,
                        score,
                    });
                }
            }
        }
    }

    // quick-action & snippet omitted from v1 search: no first-class opener yet (see plan follow-ups)

    // Bundled KB docs (in-memory FTS)
    if wants(&types, "doc") {
        for h in crate::docs_kb::search(&q) {
            hits.push(SearchHit {
                r#type: "doc".into(),
                id: h.slug.to_string(),
                title: h.title.to_string(),
                subtitle: Some("Documentation".into()),
                score: 40,
            });
        }
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    hits.truncate(limit);
    Json(SearchResponse { results: hits })
}

#[cfg(test)]
mod tests {
    use super::score_match;

    #[test]
    fn exact_beats_prefix_beats_substring_beats_none() {
        let exact = score_match("core-rtr-1", "core-rtr-1").unwrap();
        let prefix = score_match("core-rtr-1", "core").unwrap();
        let substr = score_match("core-rtr-1", "rtr").unwrap();
        assert!(exact > prefix && prefix > substr);
        assert_eq!(score_match("core-rtr-1", "xyz"), None);
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert!(score_match("Core-RTR-1", "core").is_some());
    }
}
