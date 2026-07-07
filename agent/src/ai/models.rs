//! Live model listing for AI providers. Pure response parsers + network
//! fetchers + a short TTL cache. Keys are read from the vault by the handler;
//! this module never sees the vault.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// One selectable model as shown in the settings picker.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

/// Process-wide TTL cache of fetched model lists, keyed by provider id.
pub struct ModelCache {
    ttl: Duration,
    entries: Mutex<HashMap<String, (Instant, Vec<ModelInfo>)>>,
}

impl ModelCache {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl, entries: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, provider: &str) -> Option<Vec<ModelInfo>> {
        let entries = self.entries.lock().ok()?;
        let (stored_at, models) = entries.get(provider)?;
        if stored_at.elapsed() > self.ttl {
            return None;
        }
        Some(models.clone())
    }

    pub fn put(&self, provider: &str, models: Vec<ModelInfo>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(provider.to_string(), (Instant::now(), models));
        }
    }
}

/// Global 1-hour cache used by the HTTP handler.
pub fn global_cache() -> &'static ModelCache {
    static CACHE: OnceLock<ModelCache> = OnceLock::new();
    CACHE.get_or_init(|| ModelCache::new(Duration::from_secs(3600)))
}

/// Build a reqwest client honoring the verify_ssl toggle.
fn build_client(verify_ssl: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .danger_accept_invalid_certs(!verify_ssl)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

async fn get_json(req: reqwest::RequestBuilder, provider: &str) -> Result<serde_json::Value, String> {
    let resp = req.send().await.map_err(|e| format!("{provider} request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{provider} returned {status}: {}", text.trim()));
    }
    serde_json::from_str(&text).map_err(|e| format!("{provider} sent invalid JSON: {e}"))
}

/// Parse an OpenAI-style `{ "data": [{ "id": ... }] }` list.
/// Covers OpenAI, OpenRouter, LiteLLM, and custom OpenAI-format gateways.
pub fn parse_openai_style(body: &serde_json::Value) -> Vec<ModelInfo> {
    body.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                    let display_name = m
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(ModelInfo { id, display_name })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse Anthropic's `{ "data": [{ "id": ..., "display_name": ... }] }`.
pub fn parse_anthropic(body: &serde_json::Value) -> Vec<ModelInfo> {
    body.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                    let display_name = m
                        .get("display_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(ModelInfo { id, display_name })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse Ollama's `{ "models": [{ "name": ... }] }`.
pub fn parse_ollama(body: &serde_json::Value) -> Vec<ModelInfo> {
    body.get("models")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let name = m.get("name").and_then(|v| v.as_str())?.to_string();
                    Some(ModelInfo { id: name.clone(), display_name: name })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch and normalize the model list for a provider. `base_url` overrides the
/// provider default; `api_format` applies only to `custom`.
pub async fn fetch_models(
    provider: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    verify_ssl: bool,
    api_format: Option<&str>,
) -> Result<Vec<ModelInfo>, String> {
    let client = build_client(verify_ssl)?;
    let trim = |u: &str| u.trim_end_matches('/').to_string();

    match provider {
        "anthropic" => {
            let key = api_key.filter(|k| !k.is_empty())
                .ok_or_else(|| "No API key saved for anthropic. Add one in Settings → AI → Anthropic.".to_string())?;
            let base = base_url.filter(|u| !u.is_empty()).map(trim)
                .unwrap_or_else(|| "https://api.anthropic.com".to_string());
            let body = get_json(
                client.get(format!("{base}/v1/models"))
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01"),
                provider,
            ).await?;
            Ok(parse_anthropic(&body))
        }
        "openai" => {
            let key = api_key.filter(|k| !k.is_empty())
                .ok_or_else(|| "No API key saved for openai. Add one in Settings → AI → OpenAI.".to_string())?;
            let base = base_url.filter(|u| !u.is_empty()).map(trim)
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            let body = get_json(client.get(format!("{base}/models")).bearer_auth(key), provider).await?;
            Ok(parse_openai_style(&body))
        }
        "openrouter" => {
            let base = base_url.filter(|u| !u.is_empty()).map(trim)
                .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string());
            let mut req = client.get(format!("{base}/models"));
            if let Some(key) = api_key.filter(|k| !k.is_empty()) {
                req = req.bearer_auth(key);
            }
            let body = get_json(req, provider).await?;
            Ok(parse_openai_style(&body))
        }
        "litellm" => {
            let base = base_url.filter(|u| !u.is_empty()).map(trim)
                .unwrap_or_else(|| "http://localhost:4000".to_string());
            let mut req = client.get(format!("{base}/v1/models"));
            if let Some(key) = api_key.filter(|k| !k.is_empty()) {
                req = req.bearer_auth(key);
            }
            let body = get_json(req, provider).await?;
            Ok(parse_openai_style(&body))
        }
        "ollama" => {
            let base = base_url.filter(|u| !u.is_empty()).map(trim)
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            let body = get_json(client.get(format!("{base}/api/tags")), provider).await?;
            Ok(parse_ollama(&body))
        }
        "custom" => {
            let base = base_url.filter(|u| !u.is_empty()).map(trim)
                .ok_or_else(|| "Set a Base URL for the custom provider to list models.".to_string())?;
            match api_format.unwrap_or("openai") {
                "openai" => {
                    let mut req = client.get(format!("{base}/v1/models"));
                    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
                        req = req.bearer_auth(key);
                    }
                    let body = get_json(req, provider).await?;
                    Ok(parse_openai_style(&body))
                }
                "gemini" => {
                    let mut url = format!("{base}/models");
                    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
                        url = format!("{url}?key={key}");
                    }
                    let body = get_json(client.get(url), provider).await?;
                    // Gemini uses `models[].name`; reuse the ollama shape which reads models[].name.
                    Ok(parse_ollama(&body))
                }
                other => Err(format!(
                    "Model listing isn't supported for custom api_format '{other}'. Add models manually."
                )),
            }
        }
        other => Err(format!("Unsupported AI provider '{other}'.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_openai_style_ids_and_names() {
        let body = json!({ "data": [
            { "id": "gpt-4o", "name": "GPT-4o" },
            { "id": "gpt-4o-mini" }
        ]});
        let models = parse_openai_style(&body);
        assert_eq!(models, vec![
            ModelInfo { id: "gpt-4o".into(), display_name: "GPT-4o".into() },
            ModelInfo { id: "gpt-4o-mini".into(), display_name: "gpt-4o-mini".into() },
        ]);
    }

    #[test]
    fn parses_anthropic_display_name() {
        let body = json!({ "data": [
            { "id": "claude-sonnet-4-20250514", "display_name": "Claude Sonnet 4" }
        ]});
        let models = parse_anthropic(&body);
        assert_eq!(models, vec![ModelInfo {
            id: "claude-sonnet-4-20250514".into(),
            display_name: "Claude Sonnet 4".into(),
        }]);
    }

    #[test]
    fn parses_ollama_names() {
        let body = json!({ "models": [ { "name": "llama3.2:latest" } ] });
        let models = parse_ollama(&body);
        assert_eq!(models, vec![ModelInfo {
            id: "llama3.2:latest".into(),
            display_name: "llama3.2:latest".into(),
        }]);
    }

    #[test]
    fn returns_empty_on_unexpected_shape() {
        assert!(parse_openai_style(&json!({ "oops": true })).is_empty());
        assert!(parse_anthropic(&json!([])).is_empty());
        assert!(parse_ollama(&json!(null)).is_empty());
    }

    #[test]
    fn cache_hit_then_expiry() {
        use std::time::Duration;
        let cache = ModelCache::new(Duration::from_millis(50));
        assert!(cache.get("openai").is_none());
        cache.put("openai", vec![ModelInfo { id: "gpt-4o".into(), display_name: "gpt-4o".into() }]);
        assert_eq!(cache.get("openai").unwrap().len(), 1);
        std::thread::sleep(Duration::from_millis(60));
        assert!(cache.get("openai").is_none(), "entry should expire after ttl");
    }

    #[tokio::test]
    async fn fetch_rejects_unsupported_provider() {
        let err = fetch_models("bogus", None, None, true, None).await.unwrap_err();
        assert!(err.contains("bogus") || err.to_lowercase().contains("unsupported"), "got: {err}");
    }

    #[tokio::test]
    async fn fetch_requires_key_for_anthropic() {
        let err = fetch_models("anthropic", None, None, true, None).await.unwrap_err();
        assert!(err.to_lowercase().contains("api key"), "got: {err}");
    }
}
