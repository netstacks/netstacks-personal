use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::models::{ApiResource, ApiResourceAuthType, AuthFlowStep, StoredApiResourceCredential};

/// Classify a response body: valid JSON -> (Some(json), None); non-JSON
/// non-empty -> (None, Some(text)); empty/whitespace -> (None, None).
pub(crate) fn classify_response_body(text: String) -> (Option<serde_json::Value>, Option<String>) {
    if text.trim().is_empty() {
        return (None, None);
    }
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => (Some(v), None),
        Err(_) => (None, Some(text)),
    }
}

#[cfg(test)]
mod classify_body_tests {
    use super::classify_response_body;
    #[test]
    fn valid_json_returns_value_no_text() {
        let (v, t) = classify_response_body("{\"a\":1}".to_string());
        assert!(v.is_some());
        assert!(t.is_none());
    }
    #[test]
    fn html_returns_text_no_value() {
        let (v, t) = classify_response_body("<!DOCTYPE html><html>login</html>".to_string());
        assert!(v.is_none());
        assert_eq!(t.as_deref(), Some("<!DOCTYPE html><html>login</html>"));
    }
    #[test]
    fn empty_returns_none_none() {
        let (v, t) = classify_response_body("   ".to_string());
        assert!(v.is_none());
        assert!(t.is_none());
    }
}

/// One cached set of extracted multi-step auth variables.
#[derive(Debug, Clone)]
pub struct AuthCacheEntry {
    pub vars: HashMap<String, String>,
    pub expires_at: Instant,
}

/// Process-wide cache of extracted multi-step auth variables, keyed by the
/// API resource id. Stored on `AppState` so every handler that builds an
/// `ApiResourceClient` via `from_id` shares the same cache and avoids
/// re-running the login flow on every request.
pub type AuthCache = Arc<RwLock<HashMap<String, AuthCacheEntry>>>;

/// Build a fresh, empty `AuthCache`. Used at process startup in `main.rs`.
pub fn new_auth_cache() -> AuthCache {
    Arc::new(RwLock::new(HashMap::new()))
}

#[derive(Debug, thiserror::Error)]
pub enum ApiResourceClientError {
    #[error("provider error: {0}")]
    Provider(#[from] crate::providers::ProviderError),
    #[error("API resource not found: {0}")]
    ResourceNotFound(String),
    #[error("http client error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("auth flow error: {0}")]
    AuthFlow(String),
}

pub struct ApiResourceClient {
    resource: ApiResource,
    creds: Option<StoredApiResourceCredential>,
    http: reqwest::Client,
    /// Optional shared cache of extracted multi-step auth vars. `None` for
    /// clients built via `new()` (i.e. unit tests / one-shot inline calls);
    /// `Some` whenever the client is built via `from_id` with a cache passed
    /// in by the caller (typically an API handler reading from `AppState`).
    cache: Option<AuthCache>,
}

impl ApiResourceClient {
    pub fn new(
        resource: ApiResource,
        creds: Option<StoredApiResourceCredential>,
    ) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(!resource.verify_ssl)
            .timeout(std::time::Duration::from_secs(resource.timeout_secs.max(1) as u64))
            .build()?;
        Ok(Self { resource, creds, http, cache: None })
    }

    /// Attach a shared `AuthCache` after construction. Used by
    /// `quick_actions::execute_action` so callers that already built the
    /// resource + creds themselves (rather than going through `from_id`) can
    /// still share the process-wide cache.
    pub fn set_cache(&mut self, cache: AuthCache) {
        self.cache = Some(cache);
    }

    pub async fn from_id(
        provider: &Arc<dyn crate::providers::DataProvider>,
        id: &str,
        cache: Option<&AuthCache>,
    ) -> Result<Self, ApiResourceClientError> {
        let resource = provider
            .get_api_resource(id)
            .await
            .map_err(ApiResourceClientError::Provider)?
            .ok_or_else(|| ApiResourceClientError::ResourceNotFound(id.into()))?;
        let creds = provider
            .get_api_resource_credentials(id)
            .await
            .map_err(ApiResourceClientError::Provider)?;
        let mut client = Self::new(resource, creds).map_err(ApiResourceClientError::Http)?;
        client.cache = cache.cloned();
        Ok(client)
    }

    /// Build a request with default headers, builtin auth, and custom headers
    /// applied — substituting `vars` into custom-header `{{templates}}`.
    /// `send_authed` calls this with the resolved multi-step vars; tests call it
    /// directly with an explicit (often empty) map.
    fn build_request(
        &self,
        method: reqwest::Method,
        path: &str,
        vars: &HashMap<String, String>,
    ) -> reqwest::RequestBuilder {
        let url = join_url(&self.resource.base_url, path);
        let mut rb = self.http.request(method, &url);

        // Apply default_headers (JSON object: { "Header-Name": "value" })
        if let Some(map) = self.resource.default_headers.as_object() {
            for (k, v) in map {
                if let Some(vs) = v.as_str() {
                    rb = rb.header(k, vs);
                }
            }
        }

        // Built-in auth (Bearer/Basic/ApiKeyHeader), then custom_headers layered
        // on top, with `vars` ({{api_key}} etc.) substituted in.
        rb = self.apply_builtin_auth(rb);
        self.apply_custom_headers(rb, vars)
    }

    /// Send an authenticated request and return the raw response.
    ///
    /// Resolves multi-step auth vars (cached via `get_or_refresh_auth_vars`) and
    /// applies builtin auth + custom headers WITH those vars — so MultiStep
    /// resources and custom headers referencing `{{variables}}` authenticate
    /// correctly. `auth_type = None` simply sends no auth (works against open
    /// endpoints). On a 401 for a MultiStep resource, the cached auth vars are
    /// evicted and the request is retried exactly once.
    pub async fn send_authed(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::Response, ApiResourceClientError> {
        let resp = self.send_authed_once(method.clone(), path).await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED
            && matches!(self.resource.auth_type, ApiResourceAuthType::MultiStep)
        {
            self.evict_auth_cache().await;
            return self.send_authed_once(method, path).await;
        }
        Ok(resp)
    }

    async fn send_authed_once(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::Response, ApiResourceClientError> {
        // Empty map for non-MultiStep resources; the resolved login vars
        // (e.g. `{{api_key}}`) for MultiStep ones.
        let vars = self.get_or_refresh_auth_vars().await?;
        self.build_request(method, path, &vars)
            .send()
            .await
            .map_err(ApiResourceClientError::Http)
    }

    /// Apply the resource's built-in auth scheme to a request. CustomHeader
    /// and MultiStep are handled separately by `apply_custom_headers` (which
    /// is layered on top of every auth type).
    fn apply_builtin_auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        use crate::models::ApiResourceAuthType::*;
        let creds = self.creds.as_ref();
        match &self.resource.auth_type {
            None => rb,
            BearerToken => {
                if let Some(token) = creds.and_then(|c| c.token.as_ref()) {
                    rb.header("Authorization", format!("Bearer {}", token))
                } else { rb }
            }
            Basic => {
                if let (Some(user), Some(pass)) = (
                    creds.and_then(|c| c.username.as_ref()),
                    creds.and_then(|c| c.password.as_ref())
                ) {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD
                        .encode(format!("{}:{}", user, pass));
                    rb.header("Authorization", format!("Basic {}", b64))
                } else { rb }
            }
            ApiKeyHeader => {
                let header = self.resource.auth_header_name.as_deref().unwrap_or("X-API-Key");
                let token = creds.and_then(|c| c.token.as_deref()).unwrap_or("");
                rb.header(header, token)
            }
            // CustomHeader: no built-in auth; entire scheme is the templated
            // custom_headers list, handled by apply_custom_headers.
            CustomHeader => rb,
            // MultiStep auth flows are applied via run_auth_flow() — the
            // resulting variables go through apply_custom_headers when callers
            // template them (`{{api_key}}` etc.) into custom_headers entries.
            MultiStep => rb,
        }
    }

    /// Apply user-defined `custom_headers` on top of the built-in auth. For
    /// every entry, substitute `{{token}}` (vault credential, if any) and any
    /// variables from `extracted_vars` (typically produced by `run_auth_flow`).
    ///
    /// This runs for EVERY auth type — it's the layered "after auth" pass.
    /// If `auth_type = CustomHeader` and `custom_headers` is empty, fall back
    /// to the legacy single-header form derived from auth_header_name/prefix.
    fn apply_custom_headers(
        &self,
        rb: reqwest::RequestBuilder,
        extracted_vars: &HashMap<String, String>,
    ) -> reqwest::RequestBuilder {
        use crate::quick_actions::substitute_variables;
        let token = self.creds.as_ref().and_then(|c| c.token.as_deref()).unwrap_or("");

        // Build a substitution map = extracted_vars + {{token}}. extracted_vars
        // wins on conflict (token is a built-in convenience, callers can
        // override with their own var named "token").
        let mut subs: HashMap<String, String> = HashMap::new();
        subs.insert("token".to_string(), token.to_string());
        for (k, v) in extracted_vars {
            subs.insert(k.clone(), v.clone());
        }

        let headers = self.resource.custom_headers.as_array()
            .map(|arr| arr.iter().filter_map(|v| {
                let obj = v.as_object()?;
                let name = obj.get("name")?.as_str()?;
                let value = obj.get("value")?.as_str()?;
                Some((name.to_string(), substitute_variables(value, &subs)))
            }).collect::<Vec<_>>())
            .unwrap_or_default();

        if !headers.is_empty() {
            let mut out = rb;
            for (name, value) in headers {
                out = out.header(name, value);
            }
            out
        } else if matches!(self.resource.auth_type, crate::models::ApiResourceAuthType::CustomHeader) {
            // Legacy single-header fallback (only for CustomHeader auth type)
            if let Some(header_name) = self.resource.auth_header_name.as_deref() {
                let prefix = self.resource.auth_header_prefix.as_deref().unwrap_or("");
                rb.header(header_name, format!("{}{}", prefix, token))
            } else {
                rb
            }
        } else {
            rb
        }
    }

    /// Execute every step in `resource.auth_flow` in order, accumulating
    /// extracted values as `{{variables}}` for subsequent steps. Returns the
    /// final variable map (including the seeded `username`/`password` from
    /// stored credentials, if any).
    ///
    /// If the resource has no `auth_flow`, returns the seeded credentials map
    /// (which may be empty).
    pub async fn run_auth_flow(&self) -> Result<HashMap<String, String>, ApiResourceClientError> {
        let mut vars = self.seed_vars_from_creds();
        let Some(steps) = self.resource.auth_flow.as_ref() else {
            return Ok(vars);
        };
        for (i, step) in steps.iter().enumerate() {
            let (_resp_json, extracted) = self
                .execute_auth_step(step, &vars)
                .await
                .map_err(|e| ApiResourceClientError::AuthFlow(format!("step {}: {}", i + 1, e)))?;
            let value = extracted.ok_or_else(|| {
                ApiResourceClientError::AuthFlow(format!(
                    "step {}: extract_path '{}' not found in response",
                    i + 1,
                    step.extract_path
                ))
            })?;
            vars.insert(step.store_as.clone(), value);
        }
        Ok(vars)
    }

    /// Return the cached multi-step auth variables for this resource if they
    /// exist and are still within the TTL; otherwise re-run `run_auth_flow`,
    /// store the result in the shared cache (if one is attached), and return
    /// the fresh map.
    ///
    /// For non-MultiStep resources, always returns an empty map — the caller
    /// still applies `{{token}}` substitution via `apply_custom_headers`.
    pub async fn get_or_refresh_auth_vars(
        &self,
    ) -> Result<HashMap<String, String>, ApiResourceClientError> {
        if !matches!(self.resource.auth_type, ApiResourceAuthType::MultiStep) {
            return Ok(HashMap::new());
        }
        // Try cache first.
        if let Some(cache) = &self.cache {
            let read = cache.read().await;
            if let Some(entry) = read.get(&self.resource.id) {
                if entry.expires_at > Instant::now() {
                    return Ok(entry.vars.clone());
                }
            }
        }
        // Cache miss / expired / no cache attached — run the flow.
        let vars = self.run_auth_flow().await?;
        if let Some(cache) = &self.cache {
            // TTL heuristic: 100 * timeout_secs, capped at 1h. timeout_secs is
            // a proxy for "how slow is this API"; faster APIs get refreshed
            // more often, slower ones get a longer cache window. Cap at 1h to
            // keep credentials from going stale silently if a token issuer
            // rotates keys.
            let raw_ttl = Duration::from_secs(
                (self.resource.timeout_secs.max(1) as u64).saturating_mul(100),
            );
            let ttl = raw_ttl.min(Duration::from_secs(3600));
            cache.write().await.insert(
                self.resource.id.clone(),
                AuthCacheEntry { vars: vars.clone(), expires_at: Instant::now() + ttl },
            );
        }
        Ok(vars)
    }

    /// Drop this resource's entry from the shared auth-var cache. Called
    /// before a 401 retry so the next request re-runs the auth flow.
    pub async fn evict_auth_cache(&self) {
        if let Some(cache) = &self.cache {
            cache.write().await.remove(&self.resource.id);
        }
    }

    /// Seed the variable map with `username`/`password` from stored credentials,
    /// matching the legacy `resolve_multi_step_auth` behaviour.
    fn seed_vars_from_creds(&self) -> HashMap<String, String> {
        let mut vars = HashMap::new();
        if let Some(c) = &self.creds {
            if let Some(u) = &c.username {
                vars.insert("username".into(), u.clone());
            }
            if let Some(p) = &c.password {
                vars.insert("password".into(), p.clone());
            }
        }
        vars
    }

    /// Shared implementation: substitute variables in path/headers/body, send
    /// the request, parse the response as JSON, optionally extract a value.
    /// Returns `(raw_json, extracted_string)`.
    async fn execute_auth_step(
        &self,
        step: &AuthFlowStep,
        vars: &HashMap<String, String>,
    ) -> Result<(serde_json::Value, Option<String>), String> {
        use crate::quick_actions::{json_extract, substitute_variables};

        let resolved_path = substitute_variables(&step.path, vars);
        let url = format!(
            "{}/{}",
            self.resource.base_url.trim_end_matches('/'),
            resolved_path.trim_start_matches('/'),
        );
        let method: reqwest::Method = step
            .method
            .parse()
            .map_err(|_| format!("invalid HTTP method: {}", step.method))?;
        let mut req = self.http.request(method, &url);

        // Per-step headers (templated), applied before body so the body's
        // Content-Type override wins.
        for (k, v) in &step.headers {
            req = req.header(k, substitute_variables(v, vars));
        }

        if step.use_basic_auth {
            match (vars.get("username"), vars.get("password")) {
                (Some(u), Some(p)) if !u.is_empty() => {
                    req = req.basic_auth(u, Some(p));
                }
                _ => {
                    return Err(
                        "step requires Basic Auth but no username/password is stored".into(),
                    );
                }
            }
        }

        if let Some(body_template) = &step.body {
            if !body_template.is_empty() {
                let body = substitute_variables(body_template, vars);
                req = req.header("Content-Type", "application/json").body(body);
            }
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("request failed: {}", e))?;
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let snippet: String = body_text.chars().take(200).collect();
            return Err(format!("HTTP {}: {}", status, snippet));
        }
        let json: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
            let snippet: String = body_text.chars().take(200).collect();
            format!("response was not JSON ({}): {}", e, snippet)
        })?;
        let extracted = json_extract(&json, &step.extract_path).map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string().trim_matches('"').to_string(),
        });
        Ok((json, extracted))
    }
}

/// Borrowed description of one API call: method, path, headers, body,
/// extraction path, and user-supplied variables. Groups the request
/// parameters so the executors stay at a sane arity.
#[derive(Clone, Copy)]
pub struct RequestSpec<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: &'a serde_json::Value,
    pub body: Option<&'a str>,
    pub json_extract_path: Option<&'a str>,
    pub user_variables: &'a HashMap<String, String>,
}

impl ApiResourceClient {
    /// Execute an arbitrary API call against this resource. Performs variable
    /// substitution in path/headers/body, resolves multi-step auth if
    /// configured, sends the request, and optionally extracts a value from the
    /// JSON response.
    ///
    /// Mirrors the legacy `quick_actions::execute_action` behaviour so that
    /// callers can be migrated incrementally.
    ///
    /// On 401 with a MultiStep resource, evicts the cached auth vars and
    /// retries the entire call once (re-running the auth flow). Further
    /// 401s are returned to the caller — we never loop on retries.
    pub async fn execute(
        &self,
        method: &str,
        path: &str,
        headers: &serde_json::Value,
        body: Option<&str>,
        json_extract_path: Option<&str>,
        user_variables: &HashMap<String, String>,
    ) -> crate::models::QuickActionResult {
        let spec = RequestSpec { method, path, headers, body, json_extract_path, user_variables };
        self.execute_inner(spec, true).await
    }

    /// Internal request runner. `allow_retry=true` enables one 401-driven
    /// re-auth + retry (for MultiStep resources). The retry recurses with
    /// `allow_retry=false` so we never loop.
    fn execute_inner<'a>(
        &'a self,
        spec: RequestSpec<'a>,
        allow_retry: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = crate::models::QuickActionResult> + Send + 'a>> {
        Box::pin(async move {
            self.execute_once(spec, allow_retry).await
        })
    }

    /// Actual one-shot send. Pulled out so the recursive `execute_inner`
    /// future can be `Send` without dragging an unboxed recursive type into
    /// the trait signature.
    async fn execute_once(
        &self,
        spec: RequestSpec<'_>,
        allow_retry: bool,
    ) -> crate::models::QuickActionResult {
        let RequestSpec { method, path, headers, body, json_extract_path, user_variables } = spec;
        use crate::models::{ApiResourceAuthType, QuickActionResult};
        use crate::quick_actions::{json_extract, substitute_variables};
        use std::time::Instant;

        let start = Instant::now();

        // Build base variables from decrypted credentials
        let mut variables: HashMap<String, String> = HashMap::new();
        if let Some(creds) = self.creds.as_ref() {
            if let Some(username) = &creds.username {
                variables.insert("username".to_string(), username.clone());
            }
            if let Some(password) = &creds.password {
                variables.insert("password".to_string(), password.clone());
            }
        }

        // Collect built-in variable names (credentials + auth flow store_as names)
        let mut built_in_keys: std::collections::HashSet<String> = ["username", "password"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        if let Some(steps) = &self.resource.auth_flow {
            for step in steps {
                built_in_keys.insert(step.store_as.clone());
            }
        }

        // Merge user-provided variables, but never override built-in vars
        for (key, value) in user_variables {
            if !built_in_keys.contains(key) {
                variables.insert(key.clone(), value.clone());
            }
        }

        // Resolve auth (cached if MultiStep + cache attached; otherwise runs
        // the flow once and stores the result for the next call).
        if matches!(self.resource.auth_type, ApiResourceAuthType::MultiStep)
            && self.resource.auth_flow.is_some()
        {
            match self.get_or_refresh_auth_vars().await {
                Ok(resolved) => {
                    // Preserve user-provided (non-built-in) variables on top
                    // of the resolved auth-flow output.
                    let mut merged = resolved;
                    for (k, v) in &variables {
                        if !merged.contains_key(k) {
                            merged.insert(k.clone(), v.clone());
                        }
                    }
                    variables = merged;
                }
                Err(e) => {
                    return QuickActionResult {
                        success: false,
                        status_code: 0,
                        extracted_value: None,
                        raw_body: None,
                        error: Some(format!("Auth flow failed: {}", e)),
                        duration_ms: start.elapsed().as_millis() as u64,
                        sent_url: None,
                        sent_headers: None,
                        warning: None,
                        raw_text: None,
                        content_type: None,
                        response_headers: None,
                    };
                }
            }
        }

        // Build the request URL
        let resolved_path = substitute_variables(path, &variables);
        let url = format!(
            "{}/{}",
            self.resource.base_url.trim_end_matches('/'),
            resolved_path.trim_start_matches('/')
        );

        let http_method: reqwest::Method = match method.parse() {
            Ok(m) => m,
            Err(_) => {
                return QuickActionResult {
                    success: false,
                    status_code: 0,
                    extracted_value: None,
                    raw_body: None,
                    error: Some(format!("Invalid HTTP method: {}", method)),
                    duration_ms: start.elapsed().as_millis() as u64,
                    sent_url: None,
                    sent_headers: None,
                    warning: None,
                    raw_text: None,
                    content_type: None,
                        response_headers: None,
                };
            }
        };

        let mut req = self.http.request(http_method, &url);

        // Content-negotiating APIs (e.g. NetDisco) return their HTML web UI
        // unless the request explicitly accepts JSON. The whole api-resource
        // subsystem parses responses as JSON, so default to
        // `Accept: application/json` — but only when the user hasn't set an
        // Accept header themselves (via default/action/custom headers), so
        // their choice always wins.
        let user_set_accept = self.resource.default_headers.as_object()
                .map(|o| o.keys().any(|k| k.eq_ignore_ascii_case("accept")))
                .unwrap_or(false)
            || headers.as_object()
                .map(|o| o.keys().any(|k| k.eq_ignore_ascii_case("accept")))
                .unwrap_or(false)
            || self.resource.custom_headers.as_array()
                .map(|arr| arr.iter().any(|v| v.as_object()
                    .and_then(|o| o.get("name"))
                    .and_then(|n| n.as_str())
                    .map(|n| n.eq_ignore_ascii_case("accept"))
                    .unwrap_or(false)))
                .unwrap_or(false);
        if !user_set_accept {
            req = req.header(reqwest::header::ACCEPT, "application/json");
        }

        // Apply default headers from resource
        if let Some(obj) = self.resource.default_headers.as_object() {
            for (k, v) in obj {
                if let Some(val) = v.as_str() {
                    req = req.header(k, substitute_variables(val, &variables));
                }
            }
        }

        // Apply action-specific headers
        if let Some(obj) = headers.as_object() {
            for (k, v) in obj {
                if let Some(val) = v.as_str() {
                    req = req.header(k, substitute_variables(val, &variables));
                }
            }
        }

        // Apply built-in auth (Bearer/Basic/ApiKeyHeader) using decrypted vault
        // creds. CustomHeader and MultiStep are handled by the layered
        // apply_custom_headers pass below (which also receives the multi-step
        // extracted vars so `{{api_key}}` etc. resolve correctly).
        req = self.apply_builtin_auth(req);
        // Layered: substitute {{token}} + any extracted multi-step variables
        // into custom_headers values, and apply them. Runs for every auth type.
        req = self.apply_custom_headers(req, &variables);

        // Apply body with variable substitution. JSON is the default
        // Content-Type; a Content-Type supplied in the resource's default
        // headers or the request's own headers wins (raw text / form bodies
        // from the API client tab).
        if let Some(body_template) = body {
            let resolved_body = substitute_variables(body_template, &variables);
            let has_content_type = [self.resource.default_headers.as_object(), headers.as_object()]
                .into_iter()
                .flatten()
                .flat_map(|obj| obj.keys())
                .any(|k| k.eq_ignore_ascii_case("content-type"));
            if !has_content_type {
                req = req.header("Content-Type", "application/json");
            }
            req = req.body(resolved_body);
        }

        // Snapshot URL+headers for diagnostic surfacing. try_clone only fails
        // for builders carrying a streaming body — we never do that here.
        let (sent_url, sent_headers) = match req.try_clone().and_then(|c| c.build().ok()) {
            Some(r) => {
                let url = Some(r.url().to_string());
                let headers: Vec<(String, String)> = r
                    .headers()
                    .iter()
                    .map(|(k, v)| {
                        let value = v.to_str().unwrap_or("<binary>").to_string();
                        (k.to_string(), redact_if_sensitive(k.as_str(), value))
                    })
                    .collect();
                (url, Some(headers))
            }
            None => (None, None),
        };

        // Execute request
        let response = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                return QuickActionResult {
                    success: false,
                    status_code: 0,
                    extracted_value: None,
                    raw_body: None,
                    error: Some(format!("Request failed: {}", e)),
                    duration_ms: start.elapsed().as_millis() as u64,
                    sent_url,
                    sent_headers,
                    warning: None,
                    raw_text: None,
                    content_type: None,
                        response_headers: None,
                };
            }
        };

        let status_code = response.status().as_u16();
        let success = response.status().is_success();

        // 401 auto-refresh: if this is a MultiStep resource and we have a
        // cache, evict it and retry the entire call once. Avoids the loop
        // case by passing allow_retry=false to the recursive call.
        if status_code == 401
            && allow_retry
            && matches!(self.resource.auth_type, ApiResourceAuthType::MultiStep)
        {
            drop(response);
            self.evict_auth_cache().await;
            return self
                .execute_inner(spec, false)
                .await;
        }

        // Capture Content-Type (borrow headers before consuming the body),
        // then read the body as text and classify. Non-JSON bodies (e.g. an
        // HTML login page) are kept as raw_text so the UI can show them.
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let response_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| {
                let value = v.to_str().unwrap_or("<binary>").to_string();
                (k.to_string(), redact_if_sensitive(k.as_str(), value))
            })
            .collect();
        let body_text = response.text().await.unwrap_or_default();
        let (raw_body, raw_text) = classify_response_body(body_text);

        // Extract value if path is specified
        let extracted_value = if let (Some(extract_path), Some(ref body_json)) =
            (json_extract_path, &raw_body)
        {
            json_extract(body_json, extract_path)
        } else {
            None
        };

        QuickActionResult {
            success,
            status_code,
            extracted_value,
            raw_body,
            error: if !success {
                Some(format!("HTTP {}", status_code))
            } else {
                None
            },
            duration_ms: start.elapsed().as_millis() as u64,
            sent_url,
            sent_headers,
            warning: None,
            raw_text,
            content_type,
            response_headers: Some(response_headers),
        }
    }
}

/// Redact known-sensitive headers to last 4 chars when long enough to be
/// real. Short/templated values like `{{api_key}}` are surfaced verbatim
/// so users can spot unsubstituted templates.
fn redact_if_sensitive(header_name: &str, value: String) -> String {
    let lower = header_name.to_ascii_lowercase();
    let sensitive = lower.contains("authorization")
        || lower.contains("token")
        || lower.contains("api-key")
        || lower.contains("apikey")
        || lower.contains("x-auth")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("cookie");
    if sensitive && value.len() > 12 && !value.contains("{{") {
        let tail = &value[value.len().saturating_sub(4)..];
        format!("…{}", tail)
    } else {
        value
    }
}

fn join_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = if path.starts_with('/') { path.to_string() } else { format!("/{}", path) };
    format!("{}{}", base, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn fake_resource() -> ApiResource {
        ApiResource {
            id: "r1".into(),
            name: "Test".into(),
            base_url: "https://example.com".into(),
            auth_type: ApiResourceAuthType::None,
            auth_header_name: None,
            auth_header_prefix: None,
            auth_flow: None,
            default_headers: serde_json::json!({}),
            custom_headers: serde_json::json!([]),
            verify_ssl: true,
            timeout_secs: 30,
            has_credentials: false,
            test_path: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn constructs_client_from_resource() {
        let c = ApiResourceClient::new(fake_resource(), None).unwrap();
        assert_eq!(c.resource.base_url, "https://example.com");
    }

    #[test]
    fn request_joins_base_url_with_path() {
        let mut r = fake_resource();
        r.base_url = "https://api.example.com/v2".into();
        r.default_headers = serde_json::json!({ "Accept": "application/json" });
        let c = ApiResourceClient::new(r, None).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/devices", &HashMap::new()).build().unwrap();
        assert_eq!(req.url().as_str(), "https://api.example.com/v2/devices");
        assert_eq!(req.headers().get("Accept").unwrap(), "application/json");
    }

    #[tokio::test]
    async fn from_id_loads_resource_via_provider() {
        use crate::models::CreateApiResourceRequest;
        use crate::providers::{DataProvider, LocalDataProvider};
        use std::sync::Arc;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = crate::db::init_db(&db_path).await.unwrap();
        let provider: Arc<dyn DataProvider> = Arc::new(LocalDataProvider::new(pool));

        let req = CreateApiResourceRequest {
            name: "Test Resource".into(),
            base_url: "https://example.com".into(),
            auth_type: ApiResourceAuthType::None,
            auth_token: None,
            auth_username: None,
            auth_password: None,
            auth_header_name: None,
            auth_header_prefix: None,
            auth_flow: None,
            default_headers: serde_json::json!({}),
            custom_headers: serde_json::json!([]),
            verify_ssl: true,
            timeout_secs: 30,
            test_path: None,
        };
        let created = provider.create_api_resource(&req).await.unwrap();

        let c = ApiResourceClient::from_id(&provider, &created.id, None).await.unwrap();
        assert_eq!(c.resource.id, created.id);
    }

    #[test]
    fn bearer_token_auth_adds_authorization() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::BearerToken;
        let creds = StoredApiResourceCredential {
            token: Some("abc123".into()),
            username: None,
            password: None,
        };
        let c = ApiResourceClient::new(r, Some(creds)).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        assert_eq!(req.headers().get("Authorization").unwrap(), "Bearer abc123");
    }

    #[test]
    fn basic_auth_adds_base64_authorization() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::Basic;
        let creds = StoredApiResourceCredential {
            token: None,
            username: Some("alice".into()),
            password: Some("s3cret".into()),
        };
        let c = ApiResourceClient::new(r, Some(creds)).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        // base64("alice:s3cret") = YWxpY2U6czNjcmV0
        assert_eq!(req.headers().get("Authorization").unwrap(), "Basic YWxpY2U6czNjcmV0");
    }

    #[test]
    fn api_key_header_auth_uses_configured_header() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::ApiKeyHeader;
        r.auth_header_name = Some("X-Custom-Key".into());
        let creds = StoredApiResourceCredential {
            token: Some("k-42".into()),
            username: None, password: None,
        };
        let c = ApiResourceClient::new(r, Some(creds)).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        assert_eq!(req.headers().get("X-Custom-Key").unwrap(), "k-42");
    }

    #[test]
    fn custom_headers_apply_on_top_of_bearer_token_auth() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::BearerToken;
        r.custom_headers = serde_json::json!([
            { "name": "X-Tenant", "value": "acme" },
        ]);
        let creds = StoredApiResourceCredential { token: Some("tok-1".into()), username: None, password: None };
        let c = ApiResourceClient::new(r, Some(creds)).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        assert_eq!(req.headers().get("Authorization").unwrap(), "Bearer tok-1");
        assert_eq!(req.headers().get("X-Tenant").unwrap(), "acme");
    }

    #[test]
    fn custom_headers_apply_on_top_of_basic_auth_with_token_substitution() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::Basic;
        r.custom_headers = serde_json::json!([
            { "name": "X-Trace", "value": "trace-{{token}}" },
        ]);
        let creds = StoredApiResourceCredential {
            token: Some("traceval".into()),
            username: Some("u".into()),
            password: Some("p".into()),
        };
        let c = ApiResourceClient::new(r, Some(creds)).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        assert!(req.headers().get("Authorization").unwrap().to_str().unwrap().starts_with("Basic "));
        assert_eq!(req.headers().get("X-Trace").unwrap(), "trace-traceval");
    }

    #[test]
    fn custom_headers_apply_on_top_of_none_auth() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::None;
        r.custom_headers = serde_json::json!([
            { "name": "X-Static", "value": "v1" },
        ]);
        let c = ApiResourceClient::new(r, None).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        assert_eq!(req.headers().get("X-Static").unwrap(), "v1");
        assert!(req.headers().get("Authorization").is_none());
    }

    #[test]
    fn custom_header_list_with_token_substitution() {
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::CustomHeader;
        r.custom_headers = serde_json::json!([
            { "name": "Authorization", "value": "Token {{token}}" },
            { "name": "X-Tenant", "value": "acme" }
        ]);
        let creds = StoredApiResourceCredential {
            token: Some("abc123".into()), username: None, password: None,
        };
        let c = ApiResourceClient::new(r, Some(creds)).unwrap();
        let req = c.build_request(reqwest::Method::GET, "/", &HashMap::new()).build().unwrap();
        assert_eq!(req.headers().get("Authorization").unwrap(), "Token abc123");
        assert_eq!(req.headers().get("X-Tenant").unwrap(), "acme");
    }

    #[tokio::test]
    async fn multi_step_auth_flow_extracts_variables() {
        use axum::{routing::post, Json, Router};
        use crate::models::AuthFlowStep;
        use serde_json::{json, Value};
        use std::collections::HashMap;
        use tokio::net::TcpListener;

        // Mock server: POST /login → {"access":"tok-xyz"}
        let app = Router::new().route(
            "/login",
            post(|Json(body): Json<Value>| async move {
                assert_eq!(body["user"], "alice");
                Json(json!({ "access": "tok-xyz" }))
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut headers = HashMap::new();
        headers.insert("Accept".to_string(), "application/json".to_string());

        let mut r = fake_resource();
        r.base_url = format!("http://{}", addr);
        r.auth_type = ApiResourceAuthType::MultiStep;
        r.auth_flow = Some(vec![AuthFlowStep {
            method: "POST".into(),
            path: "/login".into(),
            body: Some(r#"{"user":"{{username}}"}"#.into()),
            headers,
            use_basic_auth: false,
            extract_path: "access".into(),
            store_as: "tok".into(),
        }]);
        r.has_credentials = true;

        let creds = StoredApiResourceCredential {
            token: None,
            username: Some("alice".into()),
            password: None,
        };
        let client = ApiResourceClient::new(r, Some(creds)).unwrap();
        let vars = client.run_auth_flow().await.unwrap();
        assert_eq!(vars.get("tok").map(|s| s.as_str()), Some("tok-xyz"));
        // username seed is also present
        assert_eq!(vars.get("username").map(|s| s.as_str()), Some("alice"));
    }

    /// Build a MultiStep resource pointing at a mock server that counts how
    /// many times `/login` was hit. Returns (resource, login_count). The
    /// Quick-Action-shaped `execute` call lands at `/resource` and reads
    /// `{"ok": true}` back so the request itself always succeeds.
    async fn build_login_counting_resource() -> (ApiResource, Arc<std::sync::atomic::AtomicUsize>, String) {
        use axum::{routing::{get, post}, Json, Router};
        use serde_json::{json, Value};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::net::TcpListener;

        let counter = Arc::new(AtomicUsize::new(0));
        let c2 = counter.clone();

        let app = Router::new()
            .route(
                "/login",
                post(move |Json(_): Json<Value>| {
                    let c = c2.clone();
                    async move {
                        let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                        Json(json!({ "access": format!("tok-{}", n) }))
                    }
                }),
            )
            .route("/resource", get(|| async { Json(json!({"ok": true})) }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{}", addr);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut r = fake_resource();
        r.id = "cache-res".into();
        r.base_url = base_url.clone();
        r.auth_type = ApiResourceAuthType::MultiStep;
        r.auth_flow = Some(vec![AuthFlowStep {
            method: "POST".into(),
            path: "/login".into(),
            body: Some(r#"{"u":"x"}"#.into()),
            headers: HashMap::new(),
            use_basic_auth: false,
            extract_path: "access".into(),
            store_as: "api_key".into(),
        }]);
        r.custom_headers = serde_json::json!([
            { "name": "Authorization", "value": "Bearer {{api_key}}" }
        ]);
        r.has_credentials = true;

        (r, counter, base_url)
    }

    #[tokio::test]
    async fn cached_auth_vars_are_reused_within_ttl() {
        use std::sync::atomic::Ordering;

        let (resource, login_count, _) = build_login_counting_resource().await;
        let cache = new_auth_cache();

        let mut client = ApiResourceClient::new(resource, None).unwrap();
        client.set_cache(cache.clone());

        // Two back-to-back calls. The second should NOT re-hit /login.
        let r1 = client.execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new()).await;
        assert!(r1.success, "first call failed: {:?}", r1.error);
        let r2 = client.execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new()).await;
        assert!(r2.success, "second call failed: {:?}", r2.error);

        assert_eq!(
            login_count.load(Ordering::SeqCst),
            1,
            "login flow should have run exactly once (cache hit on 2nd call)"
        );
    }

    #[tokio::test]
    async fn evict_auth_cache_forces_reauth() {
        use std::sync::atomic::Ordering;

        let (resource, login_count, _) = build_login_counting_resource().await;
        let cache = new_auth_cache();
        let mut client = ApiResourceClient::new(resource, None).unwrap();
        client.set_cache(cache.clone());

        client.execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new()).await;
        assert_eq!(login_count.load(Ordering::SeqCst), 1);

        client.evict_auth_cache().await;

        client.execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new()).await;
        assert_eq!(
            login_count.load(Ordering::SeqCst),
            2,
            "after evict, next call should re-run the login flow"
        );
    }

    #[tokio::test]
    async fn expired_cache_entry_triggers_refresh() {
        use std::sync::atomic::Ordering;

        let (resource, login_count, _) = build_login_counting_resource().await;
        let cache = new_auth_cache();
        let mut client = ApiResourceClient::new(resource, None).unwrap();
        client.set_cache(cache.clone());

        // First call populates cache.
        client.execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new()).await;
        assert_eq!(login_count.load(Ordering::SeqCst), 1);

        // Manually expire the entry by rewriting expires_at to the past.
        {
            let mut w = cache.write().await;
            let entry = w.get_mut("cache-res").unwrap();
            entry.expires_at = Instant::now() - Duration::from_secs(1);
        }

        // Next call should refresh.
        client.execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new()).await;
        assert_eq!(
            login_count.load(Ordering::SeqCst),
            2,
            "expired cache entry should be refreshed"
        );
    }

    #[tokio::test]
    async fn execute_retries_once_on_401_and_re_runs_auth_flow() {
        use axum::{extract::Request, middleware::{from_fn, Next}, response::Response, routing::{get, post}, Json, Router};
        use axum::http::StatusCode;
        use serde_json::{json, Value};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::net::TcpListener;

        // /login increments a counter and returns {"access": "k<n>"}.
        // /resource returns 401 unless Authorization == "Bearer k2" (i.e. the
        // SECOND login result). With a pre-populated cache holding k1, the
        // first call sends k1 -> 401, triggers eviction + refresh, the next
        // login returns k2, and the retry sends k2 -> 200.
        let login_count = Arc::new(AtomicUsize::new(0));
        let lc = login_count.clone();

        async fn require_k2(req: Request, next: Next) -> Response {
            let auth = req.headers().get("Authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            if auth == "Bearer k2" {
                next.run(req).await
            } else {
                let mut resp = Response::new(axum::body::Body::from("nope"));
                *resp.status_mut() = StatusCode::UNAUTHORIZED;
                resp
            }
        }

        let app = Router::new()
            .route(
                "/login",
                post(move |Json(_): Json<Value>| {
                    let c = lc.clone();
                    async move {
                        let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                        Json(json!({ "access": format!("k{}", n) }))
                    }
                }),
            )
            .route(
                "/resource",
                get(|| async { Json(json!({ "ok": true })) }).route_layer(from_fn(require_k2)),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });

        let mut r = fake_resource();
        r.id = "retry-res".into();
        r.base_url = format!("http://{}", addr);
        r.auth_type = ApiResourceAuthType::MultiStep;
        r.auth_flow = Some(vec![AuthFlowStep {
            method: "POST".into(),
            path: "/login".into(),
            body: Some(r#"{}"#.into()),
            headers: HashMap::new(),
            use_basic_auth: false,
            extract_path: "access".into(),
            store_as: "api_key".into(),
        }]);
        r.custom_headers = serde_json::json!([
            { "name": "Authorization", "value": "Bearer {{api_key}}" }
        ]);

        let cache = new_auth_cache();
        // Pre-populate the cache with a stale k1 entry so the first attempt
        // sends Bearer k1 -> 401, then the retry re-runs login (which now
        // returns k2) and succeeds.
        {
            let mut w = cache.write().await;
            let mut vars = HashMap::new();
            vars.insert("api_key".to_string(), "k1".to_string());
            w.insert(
                "retry-res".to_string(),
                AuthCacheEntry {
                    vars,
                    expires_at: Instant::now() + Duration::from_secs(3600),
                },
            );
        }
        // Make the pre-pop count as 1 login hit (the test mocks it as if we
        // had hit /login once before; advance the counter to match).
        login_count.fetch_add(1, Ordering::SeqCst);

        let mut client = ApiResourceClient::new(r, None).unwrap();
        client.set_cache(cache.clone());

        let result = client
            .execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new())
            .await;

        assert!(result.success, "retry should have succeeded; got {:?}", result.error);
        assert_eq!(result.status_code, 200);
        // 1 (pre-pop) + 1 (refresh after 401) = 2
        assert_eq!(
            login_count.load(Ordering::SeqCst),
            2,
            "login flow should have run once for refresh (plus the pre-pop)"
        );
    }

    #[tokio::test]
    async fn execute_does_not_loop_on_persistent_401() {
        use axum::{routing::{get, post}, Json, Router};
        use axum::http::StatusCode;
        use serde_json::{json, Value};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::net::TcpListener;

        // /resource ALWAYS returns 401, even after refresh. We should still
        // bail after exactly one retry, not loop forever.
        let resource_hits = Arc::new(AtomicUsize::new(0));
        let rh = resource_hits.clone();

        let app = Router::new()
            .route("/login", post(|Json(_): Json<Value>| async {
                Json(json!({ "access": "whatever" }))
            }))
            .route("/resource", get(move || {
                let c = rh.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::UNAUTHORIZED, "still 401")
                }
            }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });

        let mut r = fake_resource();
        r.id = "loop-res".into();
        r.base_url = format!("http://{}", addr);
        r.auth_type = ApiResourceAuthType::MultiStep;
        r.auth_flow = Some(vec![AuthFlowStep {
            method: "POST".into(),
            path: "/login".into(),
            body: Some(r#"{}"#.into()),
            headers: HashMap::new(),
            use_basic_auth: false,
            extract_path: "access".into(),
            store_as: "api_key".into(),
        }]);

        let cache = new_auth_cache();
        let mut client = ApiResourceClient::new(r, None).unwrap();
        client.set_cache(cache);

        let result = client
            .execute("GET", "/resource", &serde_json::json!({}), None, None, &HashMap::new())
            .await;

        assert!(!result.success);
        assert_eq!(result.status_code, 401);
        // Exactly 2 hits: initial + one retry. Never more.
        assert_eq!(resource_hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn non_multistep_auth_skips_cache_lookup() {
        // Non-MultiStep resources should always return an empty var map from
        // get_or_refresh_auth_vars and never touch the cache.
        let mut r = fake_resource();
        r.auth_type = ApiResourceAuthType::BearerToken;
        let cache = new_auth_cache();
        let mut client = ApiResourceClient::new(r, None).unwrap();
        client.set_cache(cache.clone());

        let vars = client.get_or_refresh_auth_vars().await.unwrap();
        assert!(vars.is_empty());
        assert!(cache.read().await.is_empty(), "cache should remain untouched for non-MultiStep");
    }

    #[tokio::test]
    async fn execute_substitutes_vars_and_extracts_json() {
        use axum::{extract::Path, routing::get, Json, Router};
        use serde_json::json;
        use tokio::net::TcpListener;

        // Mock server: GET /devices/:id → {"data":{"hostname":"r1.lab"}}
        let app = Router::new().route(
            "/devices/:id",
            get(|Path(id): Path<String>| async move {
                assert_eq!(id, "42");
                Json(json!({"data": {"hostname": "r1.lab"}}))
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut r = fake_resource();
        r.base_url = format!("http://{}", addr);
        let client = ApiResourceClient::new(r, None).unwrap();
        let mut vars = HashMap::new();
        vars.insert("id".into(), "42".into());
        let result = client
            .execute(
                "GET",
                "/devices/{{id}}",
                &serde_json::json!({}),
                None,
                Some("data.hostname"),
                &vars,
            )
            .await;
        assert!(result.success, "request failed: {:?}", result.error);
        assert_eq!(result.status_code, 200);
        assert_eq!(result.extracted_value, Some(serde_json::json!("r1.lab")));
    }

    #[tokio::test]
    async fn send_authed_runs_multistep_flow_and_applies_custom_header() {
        use axum::{extract::Request, middleware::{from_fn, Next}, response::Response, routing::{get, post}, Json, Router};
        use axum::http::StatusCode;
        use serde_json::{json, Value};
        use tokio::net::TcpListener;

        // /resource returns 200 only when Authorization == "Bearer tok123".
        // A bare request() (no auth flow) would send no/blank auth and 401;
        // send_authed must run the login flow and apply the resolved
        // {{api_key}} custom header.
        async fn require_tok(req: Request, next: Next) -> Response {
            let auth = req.headers().get("Authorization")
                .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            if auth == "Bearer tok123" {
                next.run(req).await
            } else {
                let mut resp = Response::new(axum::body::Body::from("nope"));
                *resp.status_mut() = StatusCode::UNAUTHORIZED;
                resp
            }
        }

        let app = Router::new()
            .route("/login", post(|Json(_): Json<Value>| async {
                Json(json!({ "access": "tok123" }))
            }))
            .route("/resource", get(|| async { Json(json!({ "ok": true })) })
                .route_layer(from_fn(require_tok)));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });

        let mut r = fake_resource();
        r.id = "authed-res".into();
        r.base_url = format!("http://{}", addr);
        r.auth_type = ApiResourceAuthType::MultiStep;
        r.auth_flow = Some(vec![AuthFlowStep {
            method: "POST".into(),
            path: "/login".into(),
            body: Some(r#"{}"#.into()),
            headers: HashMap::new(),
            use_basic_auth: false,
            extract_path: "access".into(),
            store_as: "api_key".into(),
        }]);
        r.custom_headers = serde_json::json!([
            { "name": "Authorization", "value": "Bearer {{api_key}}" }
        ]);

        let mut client = ApiResourceClient::new(r, None).unwrap();
        client.set_cache(new_auth_cache());

        let resp = client
            .send_authed(reqwest::Method::GET, "/resource")
            .await
            .expect("send_authed should not error");
        assert_eq!(
            resp.status(),
            reqwest::StatusCode::OK,
            "multi-step auth flow should have run and applied the resolved header"
        );
    }

    #[tokio::test]
    async fn send_authed_with_no_auth_sends_no_authorization_header() {
        use axum::{extract::Request, routing::get, Json, Router};
        use serde_json::json;
        use tokio::net::TcpListener;

        let app = Router::new().route("/open", get(|req: Request| async move {
            let has_auth = req.headers().contains_key("Authorization");
            Json(json!({ "has_auth": has_auth }))
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });

        let mut r = fake_resource();
        r.base_url = format!("http://{}", addr);
        r.auth_type = ApiResourceAuthType::None;

        let client = ApiResourceClient::new(r, None).unwrap();
        let resp = client
            .send_authed(reqwest::Method::GET, "/open")
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(
            body["has_auth"],
            serde_json::json!(false),
            "no-auth resource must not send an Authorization header"
        );
    }
}
