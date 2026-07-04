//! docs_kb — NetStacks usage documentation bundled into the agent binary.
//!
//! A small, curated knowledge pack (concepts, integrations, NetBox, Crawler,
//! enrichment, AI/documents) embedded via `include_str!` so the AI can read it
//! offline to help users understand and set up the app. Exposed over HTTP at
//! `/docs-kb` and surfaced to the assistant via the `search_netstacks_docs` /
//! `read_netstacks_doc` tools.

/// One bundled documentation topic.
pub struct KbDoc {
    pub slug: &'static str,
    pub title: &'static str,
    pub content: &'static str,
}

pub static DOCS: &[KbDoc] = &[
    KbDoc {
        slug: "concepts",
        title: "Concepts: API Resources vs Integrations",
        content: include_str!("concepts.md"),
    },
    KbDoc {
        slug: "netbox",
        title: "Setting up NetBox",
        content: include_str!("netbox.md"),
    },
    KbDoc {
        slug: "crawler-netdisco",
        title: "Crawler = Netdisco",
        content: include_str!("crawler-netdisco.md"),
    },
    KbDoc {
        slug: "enrichment",
        title: "Enrichment: sources and token matchers",
        content: include_str!("enrichment.md"),
    },
    KbDoc {
        slug: "ai-and-documents",
        title: "AI setup and Documents",
        content: include_str!("ai-and-documents.md"),
    },
];

/// Fetch one doc by slug.
pub fn get(slug: &str) -> Option<&'static KbDoc> {
    DOCS.iter().find(|d| d.slug == slug)
}

/// The topic index: (slug, title) for every bundled doc.
pub fn index() -> Vec<(&'static str, &'static str)> {
    DOCS.iter().map(|d| (d.slug, d.title)).collect()
}

/// A search hit: slug, title, and a short snippet.
pub struct KbHit {
    pub slug: &'static str,
    pub title: &'static str,
    pub snippet: String,
}

/// Case-insensitive keyword search over title + content, ranked by hit count.
pub fn search(query: &str) -> Vec<KbHit> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, &'static KbDoc)> = Vec::new();
    for d in DOCS {
        let hay = format!("{} {}", d.title, d.content).to_lowercase();
        let score: usize = terms.iter().map(|t| hay.matches(t.as_str()).count()).sum();
        if score > 0 {
            scored.push((score, d));
        }
    }
    scored.sort_by_key(|s| std::cmp::Reverse(s.0));
    scored
        .into_iter()
        .map(|(_, d)| KbHit {
            slug: d.slug,
            title: d.title,
            // First ~200 chars as a snippet (char-safe). The AI reads the full
            // doc via read_netstacks_doc when it wants detail.
            snippet: d.content.chars().take(200).collect::<String>().trim().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_and_get_work() {
        assert!(!index().is_empty());
        assert!(get("concepts").is_some());
        assert!(get("nope").is_none());
    }

    #[test]
    fn search_finds_netdisco_and_ranks() {
        let hits = search("netdisco crawler");
        assert!(!hits.is_empty());
        assert_eq!(hits[0].slug, "crawler-netdisco");
    }

    #[test]
    fn search_empty_query_is_empty() {
        assert!(search("   ").is_empty());
    }
}
