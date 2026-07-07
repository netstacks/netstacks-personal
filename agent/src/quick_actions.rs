//! Quick Actions execution engine
//!
//! Handles executing API calls with auth resolution, variable substitution,
//! and JSON path extraction.

use crate::models::*;
use std::collections::HashMap;
use std::time::Instant;

/// Extract a value from JSON using a simple dot-bracket path.
///
/// Supports paths like:
/// - `name` → obj["name"]
/// - `result[0]` → obj["result"][0]
/// - `result[0].name.txrate` → obj["result"][0]["name"]["txrate"]
/// - `data.items[2].value` → obj["data"]["items"][2]["value"]
pub fn json_extract(value: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    let segments = parse_path_segments(path);
    json_extract_segments(value, &segments)
}

/// Recursive walker so [*] can fan out: when we hit an All segment we
/// apply the remaining segments to every element of the current array
/// and collect the results into a new array.
fn json_extract_segments(value: &serde_json::Value, segments: &[PathSegment]) -> Option<serde_json::Value> {
    let Some((head, rest)) = segments.split_first() else {
        return Some(value.clone());
    };
    match head {
        PathSegment::Key(key) => {
            let next = value.get(key)?;
            json_extract_segments(next, rest)
        }
        PathSegment::Index(idx) => {
            let next = value.get(*idx)?;
            json_extract_segments(next, rest)
        }
        PathSegment::All => {
            let arr = value.as_array()?;
            let collected: Vec<serde_json::Value> = arr
                .iter()
                .filter_map(|el| json_extract_segments(el, rest))
                .collect();
            Some(serde_json::Value::Array(collected))
        }
    }
}

enum PathSegment {
    Key(String),
    Index(usize),
    /// `[*]` — apply remaining segments to every element of an array.
    All,
}

fn parse_path_segments(path: &str) -> Vec<PathSegment> {
    let mut segments = Vec::new();
    let mut chars = path.chars().peekable();
    let mut current_key = String::new();

    while let Some(&ch) = chars.peek() {
        match ch {
            '.' => {
                if !current_key.is_empty() {
                    segments.push(PathSegment::Key(current_key.clone()));
                    current_key.clear();
                }
                chars.next();
            }
            '[' => {
                if !current_key.is_empty() {
                    segments.push(PathSegment::Key(current_key.clone()));
                    current_key.clear();
                }
                chars.next(); // consume '['
                let mut idx_str = String::new();
                while let Some(&c) = chars.peek() {
                    if c == ']' {
                        chars.next();
                        break;
                    }
                    idx_str.push(c);
                    chars.next();
                }
                if idx_str.trim() == "*" {
                    segments.push(PathSegment::All);
                } else if let Ok(idx) = idx_str.parse::<usize>() {
                    segments.push(PathSegment::Index(idx));
                } else {
                    // Treat as string key (for map access like ["key"])
                    let key = idx_str.trim_matches('"').trim_matches('\'').to_string();
                    segments.push(PathSegment::Key(key));
                }
            }
            _ => {
                current_key.push(ch);
                chars.next();
            }
        }
    }

    if !current_key.is_empty() {
        segments.push(PathSegment::Key(current_key));
    }

    segments
}

/// Substitute `{{variable}}` placeholders in a string with values from a map.
///
/// AUDIT FIX (EXEC-015): values that contain CR/LF are rejected so they
/// cannot inject HTTP header lines via the header-substitution path. We do
/// the rejection here (in the shared substitution helper) so every call site
/// that ultimately produces an HTTP request benefits.
pub(crate) fn substitute_variables(template: &str, variables: &HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in variables {
        let safe_value = if value.contains('\r') || value.contains('\n') {
            tracing::warn!(
                target: "audit",
                key = %key,
                "quick-action variable contained CR/LF; replaced with literal placeholder"
            );
            "<rejected: CR/LF not allowed in variable value>".to_string()
        } else {
            value.clone()
        };
        result = result.replace(&format!("{{{{{}}}}}", key), &safe_value);
    }
    result
}

/// Build an HTTP client with the resource's SSL and timeout settings.
fn build_http_client(resource: &ApiResource) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(!resource.verify_ssl)
        .timeout(std::time::Duration::from_secs(resource.timeout_secs as u64))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Result of running a single auth-flow step in isolation. Used by the
/// per-step Test button so users can debug each step independently.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthStepTestResult {
    /// Whether the step succeeded end-to-end (HTTP success + parse + extract).
    pub success: bool,
    /// HTTP status code returned by the step's URL. 0 if the request failed
    /// before getting a response (network error / DNS / TLS).
    pub status_code: u16,
    /// Final URL the request was sent to (post-substitution), so the user can
    /// see exactly what got hit.
    pub url: String,
    /// First 1000 chars of the response body. Truncated for UI sanity.
    pub response_preview: Option<String>,
    /// The extracted value (the thing that would be stored as the next
    /// variable). Always a string; non-string JSON gets `.to_string()`d.
    pub extracted_value: Option<String>,
    /// The variable name the value would be stored under, mirrored back so
    /// the UI can label it without re-reading the step config.
    pub store_as: String,
    /// Human-readable error if anything went wrong.
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// Execute a single auth-flow step against the given resource and return a
/// rich result for the UI's per-step test feature. Does NOT chain into other
/// steps — it's a debug primitive.
pub async fn test_auth_step(
    resource: &ApiResource,
    credentials: Option<&StoredApiResourceCredential>,
    step: &AuthFlowStep,
    extra_variables: &HashMap<String, String>,
) -> AuthStepTestResult {
    let start = Instant::now();

    // Build base variables from credentials + caller-supplied vars (caller
    // may have additional `{{var}}` placeholders to substitute, e.g. captured
    // outputs from a prior step the user pasted in).
    let mut variables: HashMap<String, String> = HashMap::new();
    if let Some(creds) = credentials {
        if let Some(u) = &creds.username {
            variables.insert("username".to_string(), u.clone());
        }
        if let Some(p) = &creds.password {
            variables.insert("password".to_string(), p.clone());
        }
    }
    for (k, v) in extra_variables {
        variables.insert(k.clone(), v.clone());
    }

    let resolved_path = substitute_variables(&step.path, &variables);
    let url = format!(
        "{}/{}",
        resource.base_url.trim_end_matches('/'),
        resolved_path.trim_start_matches('/'),
    );

    let client = match build_http_client(resource) {
        Ok(c) => c,
        Err(e) => {
            return AuthStepTestResult {
                success: false,
                status_code: 0,
                url,
                response_preview: None,
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!("Failed to build HTTP client: {}", e)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let method: reqwest::Method = match step.method.parse() {
        Ok(m) => m,
        Err(_) => {
            return AuthStepTestResult {
                success: false,
                status_code: 0,
                url,
                response_preview: None,
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!("Invalid HTTP method: {}", step.method)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let mut req = client.request(method, &url);
    for (k, v) in &step.headers {
        req = req.header(k, substitute_variables(v, &variables));
    }
    if step.use_basic_auth {
        match (variables.get("username"), variables.get("password")) {
            (Some(u), Some(p)) if !u.is_empty() => {
                req = req.basic_auth(u, Some(p));
            }
            _ => {
                return AuthStepTestResult {
                    success: false,
                    status_code: 0,
                    url,
                    response_preview: None,
                    extracted_value: None,
                    store_as: step.store_as.clone(),
                    error: Some(
                        "Basic Auth is required by this step but the resource has no username/password stored.".to_string(),
                    ),
                    duration_ms: start.elapsed().as_millis() as u64,
                };
            }
        }
    }
    if let Some(body_template) = &step.body {
        if !body_template.is_empty() {
            let body = substitute_variables(body_template, &variables);
            req = req.header("Content-Type", "application/json").body(body);
        }
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return AuthStepTestResult {
                success: false,
                status_code: 0,
                url,
                response_preview: None,
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!("Request failed: {}", e)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    let preview: String = body_text.chars().take(1000).collect();

    if !status.is_success() {
        return AuthStepTestResult {
            success: false,
            status_code: status.as_u16(),
            url,
            response_preview: Some(preview),
            extracted_value: None,
            store_as: step.store_as.clone(),
            error: Some(format!("Endpoint returned HTTP {}", status)),
            duration_ms: start.elapsed().as_millis() as u64,
        };
    }

    // Parse + extract.
    let json: serde_json::Value = match serde_json::from_str(&body_text) {
        Ok(v) => v,
        Err(e) => {
            return AuthStepTestResult {
                success: false,
                status_code: status.as_u16(),
                url,
                response_preview: Some(preview),
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!(
                    "Response was not JSON ({}). Check the Headers — most APIs require Accept: application/json.",
                    e
                )),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let extracted = match json_extract(&json, &step.extract_path) {
        Some(v) => v,
        None => {
            return AuthStepTestResult {
                success: false,
                status_code: status.as_u16(),
                url,
                response_preview: Some(preview),
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!(
                    "Failed to extract '{}' from response. Verify the JSON path matches the response body shown above.",
                    step.extract_path
                )),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let extracted_str = match &extracted {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    };

    AuthStepTestResult {
        success: true,
        status_code: status.as_u16(),
        url,
        response_preview: Some(preview),
        extracted_value: Some(extracted_str),
        store_as: step.store_as.clone(),
        error: None,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

/// Execute a quick action against its API resource.
///
/// This function:
/// 1. Resolves authentication (including multi-step flows)
/// 2. Substitutes variables in path, headers, and body
/// 3. Makes the HTTP request
/// 4. Extracts a value from the JSON response if json_extract_path is set
///
/// Pass `cache: Some(&state.auth_cache)` from API handlers to enable cached
/// multi-step auth vars and 401-driven refresh. Pass `None` for one-shot
/// inline calls / tests where caching the result is undesirable.
pub async fn execute_action(
    resource: &ApiResource,
    credentials: Option<&StoredApiResourceCredential>,
    request: crate::api_resource_client::RequestSpec<'_>,
    cache: Option<&crate::api_resource_client::AuthCache>,
) -> QuickActionResult {
    use crate::api_resource_client::{ApiResourceClient, RequestSpec};
    let RequestSpec { method, path, headers, body, json_extract_path, user_variables } = request;
    let mut client = match ApiResourceClient::new(resource.clone(), credentials.cloned()) {
        Ok(c) => c,
        Err(e) => {
            return QuickActionResult {
                success: false,
                status_code: 0,
                extracted_value: None,
                raw_body: None,
                error: Some(format!("Failed to build HTTP client: {}", e)),
                duration_ms: 0,
                sent_url: None,
                sent_headers: None,
                warning: None,
                raw_text: None,
                content_type: None,
            };
        }
    };
    if let Some(cache) = cache {
        client.set_cache(cache.clone());
    }
    client
        .execute(method, path, headers, body, json_extract_path, user_variables)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_extract_simple_key() {
        let json = serde_json::json!({"name": "test", "value": 42});
        assert_eq!(json_extract(&json, "name"), Some(serde_json::json!("test")));
        assert_eq!(json_extract(&json, "value"), Some(serde_json::json!(42)));
    }

    #[test]
    fn test_json_extract_nested() {
        let json = serde_json::json!({"data": {"name": "test"}});
        assert_eq!(json_extract(&json, "data.name"), Some(serde_json::json!("test")));
    }

    #[test]
    fn test_json_extract_array() {
        let json = serde_json::json!({"result": [{"txrate": 1000}, {"txrate": 2000}]});
        assert_eq!(json_extract(&json, "result[0].txrate"), Some(serde_json::json!(1000)));
        assert_eq!(json_extract(&json, "result[1].txrate"), Some(serde_json::json!(2000)));
    }

    #[test]
    fn test_json_extract_missing() {
        let json = serde_json::json!({"name": "test"});
        assert_eq!(json_extract(&json, "missing"), None);
        assert_eq!(json_extract(&json, "name.nested"), None);
    }

    #[test]
    fn test_json_extract_wildcard_collects_into_array() {
        let json = serde_json::json!({
            "macs": [
                { "router_ip": "10.0.0.1" },
                { "router_ip": "10.0.0.2" },
                { "router_ip": "10.0.0.3" },
            ]
        });
        assert_eq!(
            json_extract(&json, "macs[*].router_ip"),
            Some(serde_json::json!(["10.0.0.1", "10.0.0.2", "10.0.0.3"]))
        );
    }

    #[test]
    fn test_json_extract_user_shape_macs_router_ip() {
        let json = serde_json::json!({
            "macs": [
                {
                    "active": 1,
                    "dns": null,
                    "ip": "10.79.1.178",
                    "mac": "ac:a0:9d:b9:31:fb",
                    "router_ip": "10.247.80.35",
                    "router_name": "agg501-gprod.rap02.gi-vw.viasat.us",
                    "time_first": "2025-08-25 16:19:15.451875",
                    "time_last": "2026-05-17 15:53:35.268889"
                }
            ]
        });
        assert_eq!(
            json_extract(&json, "macs[0].router_ip"),
            Some(serde_json::json!("10.247.80.35"))
        );
    }

    #[test]
    fn test_substitute_variables() {
        let mut vars = HashMap::new();
        vars.insert("username".to_string(), "admin".to_string());
        vars.insert("token".to_string(), "abc123".to_string());

        assert_eq!(
            substitute_variables("Bearer {{token}}", &vars),
            "Bearer abc123"
        );
        assert_eq!(
            substitute_variables("/api/users/{{username}}/data", &vars),
            "/api/users/admin/data"
        );
    }
}
