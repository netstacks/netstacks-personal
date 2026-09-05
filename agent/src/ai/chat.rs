//! AI chat API endpoints
//!
//! Provides HTTP endpoints for AI chat and script generation.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use crate::api::AppState;

use super::providers::{
    create_provider, AgentChatOptions, AgentContent, AgentContentBlock, AgentMessage,
    AgentResponse, AiContext, AiError, AiProvider, AiProviderConfig, ChatMessage, StreamEvent,
    TokenUsage,
};
use super::sanitizer::SanitizingProvider;

/// Wrap an AI provider with the sanitization layer
fn wrap_provider(inner: Box<dyn AiProvider>, state: &AppState) -> Box<dyn AiProvider> {
    Box::new(SanitizingProvider::new(
        inner,
        state.sanitizer.clone(),
        state.provider.clone(),
    ))
}

// === Error Response ===

/// AI API error response
#[derive(Debug, Serialize)]
pub struct AiApiError {
    pub error: String,
    pub code: String,
}

impl IntoResponse for AiApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self.code.as_str() {
            "NOT_CONFIGURED" => StatusCode::SERVICE_UNAVAILABLE,
            "UNAUTHORIZED" => StatusCode::UNAUTHORIZED,
            "RATE_LIMITED" => StatusCode::TOO_MANY_REQUESTS,
            "TIMEOUT" => StatusCode::GATEWAY_TIMEOUT,
            "BAD_REQUEST" => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        (status, Json(self)).into_response()
    }
}

impl From<AiError> for AiApiError {
    fn from(err: AiError) -> Self {
        let (code, error) = match &err {
            AiError::NotConfigured(msg) => ("NOT_CONFIGURED".to_string(), msg.clone()),
            AiError::RateLimited => (
                "RATE_LIMITED".to_string(),
                "Rate limited by AI provider. Please wait and try again.".to_string(),
            ),
            AiError::Timeout => (
                "TIMEOUT".to_string(),
                "AI request timed out. Please try again.".to_string(),
            ),
            AiError::RequestFailed(msg) => ("PROVIDER_ERROR".to_string(), msg.clone()),
            AiError::Unauthorized(msg) => ("UNAUTHORIZED".to_string(), msg.clone()),
            AiError::BadRequest(msg) => ("BAD_REQUEST".to_string(), msg.clone()),
            AiError::InvalidResponse(msg) => ("PROVIDER_ERROR".to_string(), msg.clone()),
        };

        AiApiError { error, code }
    }
}

// === Chat Completion Endpoint ===

/// Request body for chat completion
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub context: Option<AiContext>,
    /// Optional provider override (uses saved settings if not specified)
    #[serde(default)]
    pub provider: Option<String>,
    /// Optional model override (uses saved settings if not specified)
    #[serde(default)]
    pub model: Option<String>,
    /// Explicit opt-in to the AI Engineer onboarding interview. Only the side
    /// panel's setup conversation sets this; helper features (autocomplete,
    /// commit messages, digests…) never do, so they are not hijacked by the
    /// interviewer prompt or profile extraction (NS-AI-33).
    #[serde(default)]
    pub onboarding: bool,
}

/// Response body for chat completion
#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub response: String,
    /// True when the AI is in onboarding mode (building user profile)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onboarding: Option<bool>,
}

/// POST /api/ai/chat - Chat completion endpoint
pub async fn chat_completion(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, AiApiError> {
    // Validate request
    if req.messages.is_empty() {
        return Err(AiApiError {
            error: "Messages array cannot be empty".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    let onboarding_mode = onboarding_interview_requested(&state, req.onboarding).await;

    // Load AI provider config (honouring per-request provider/model overrides).
    // Surface the REAL reason on failure instead of silently falling back to
    // the Mock provider's generic "AI not configured" message.
    let config =
        match load_ai_config_with_overrides(&state, req.provider.as_deref(), req.model.as_deref())
            .await
            .0
        {
            Ok(cfg) => Some(cfg),
            Err(reason) => {
                tracing::warn!("AI config load failed: {}", reason);
                return Err(AiApiError {
                    error: reason,
                    code: "NOT_CONFIGURED".to_string(),
                });
            }
        };

    // Create provider and make request (with sanitization)
    let provider = wrap_provider(create_provider(config), &state);

    if onboarding_mode {
        // Onboarding mode: use onboarding system prompt
        let mut onboarding_messages = vec![ChatMessage {
            role: "system".to_string(),
            content: super::onboarding::ONBOARDING_SYSTEM_PROMPT.to_string(),
        }];
        onboarding_messages.extend(req.messages.clone());

        let response = provider.chat_completion(onboarding_messages, None).await?;

        // Extract profile fields from the conversation (best-effort, non-blocking)
        let all_messages: Vec<ChatMessage> = req
            .messages
            .iter()
            .chain(std::iter::once(&ChatMessage {
                role: "assistant".to_string(),
                content: response.clone(),
            }))
            .cloned()
            .collect();

        spawn_profile_extraction(state.clone(), all_messages, req.provider.clone(), req.model.clone());

        return Ok(Json(ChatResponse {
            response,
            onboarding: Some(true),
        }));
    }

    // Normal mode: load profile and inject into context for profile-driven prompt
    let ai_profile = crate::db::ai_profile::get_profile(&state.pool)
        .await
        .ok()
        .flatten();
    let context = match req.context {
        Some(mut ctx) => {
            ctx.ai_profile = ai_profile;
            Some(ctx)
        }
        None => ai_profile.map(|p| super::providers::AiContext {
            ai_profile: Some(p),
            ..Default::default()
        }),
    };
    let response = provider.chat_completion(req.messages, context).await?;
    Ok(Json(ChatResponse {
        response,
        onboarding: None,
    }))
}

// === Generate Script Endpoint ===

/// Request body for script generation
#[derive(Debug, Deserialize)]
pub struct GenerateScriptRequest {
    pub prompt: String,
    /// Optional provider override (uses saved settings if not specified)
    #[serde(default)]
    pub provider: Option<String>,
    /// Optional model override (uses saved settings if not specified)
    #[serde(default)]
    pub model: Option<String>,
}

/// Response body for script generation
#[derive(Debug, Serialize)]
pub struct GenerateScriptResponse {
    pub script: String,
    pub explanation: String,
}

/// System prompt for script generation
const SCRIPT_SYSTEM_PROMPT: &str = r#"You are a network automation script generator. You MUST generate Python scripts only — never bash, shell, or any other language.

Output format:
1. First, output the Python script in a ```python code block (you MUST use the ```python fence, not a plain ``` fence)
2. Then, provide a brief explanation of what the script does

Guidelines:
- Always use Python 3 — never generate bash/shell scripts
- Include proper error handling
- Add comments explaining key sections
- Use subprocess for running CLI commands
- Use netmiko or paramiko for SSH when needed
- Follow network automation best practices
- Keep scripts practical and production-ready"#;

/// POST /api/ai/generate-script - Generate a network automation script
pub async fn generate_script(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GenerateScriptRequest>,
) -> Result<Json<GenerateScriptResponse>, AiApiError> {
    // Validate request
    if req.prompt.trim().is_empty() {
        return Err(AiApiError {
            error: "Prompt cannot be empty".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    // Load AI provider config (honouring per-request overrides); surface the
    // real failure reason rather than degrading to the Mock provider.
    let config =
        match load_ai_config_with_overrides(&state, req.provider.as_deref(), req.model.as_deref())
            .await
            .0
        {
            Ok(cfg) => Some(cfg),
            Err(reason) => {
                return Err(AiApiError {
                    error: reason,
                    code: "NOT_CONFIGURED".to_string(),
                });
            }
        };

    // Create provider (with sanitization)
    let provider = wrap_provider(create_provider(config), &state);

    // Check for custom script prompt in settings
    let script_prompt = match state.provider.get_setting("ai.script_prompt").await {
        Ok(value) if !value.is_null() => {
            let inner = if let Some(obj) = value.as_object() {
                obj.get("value").and_then(|v| v.as_str()).map(String::from)
            } else {
                value.as_str().map(String::from)
            };
            match inner {
                Some(s) if !s.is_empty() => s,
                _ => SCRIPT_SYSTEM_PROMPT.to_string(),
            }
        }
        _ => SCRIPT_SYSTEM_PROMPT.to_string(),
    };

    // Prepend AI engineer profile expertise for script generation (lean segments)
    let ai_profile = crate::db::ai_profile::get_profile(&state.pool)
        .await
        .ok()
        .flatten();
    let system_content = if let Some(profile) = ai_profile {
        let personality =
            profile.compile_for_feature(super::profile::AiFeature::ScriptGeneration, 8000);
        format!("{}\n\n{}", personality, script_prompt)
    } else {
        script_prompt
    };

    // Build messages for script generation
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_content,
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("Generate a Python script for: {}", req.prompt),
        },
    ];

    // Make request
    let response = provider.chat_completion(messages, None).await?;

    // Parse script and explanation from response
    let (script, explanation) = parse_script_response(&response);

    Ok(Json(GenerateScriptResponse {
        script,
        explanation,
    }))
}

/// Parse script and explanation from AI response
fn parse_script_response(response: &str) -> (String, String) {
    // Look for code blocks in the response
    let code_block_start = response.find("```python").or_else(|| response.find("```"));
    let code_block_end = if code_block_start.is_some() {
        response.rfind("```")
    } else {
        None
    };

    match (code_block_start, code_block_end) {
        (Some(start), Some(end)) if end > start => {
            // Find the actual start of code (after the opening ```)
            let code_start = response[start..]
                .find('\n')
                .map(|i| start + i + 1)
                .unwrap_or(start);

            let script = response[code_start..end].trim().to_string();
            let explanation = response[end + 3..].trim().to_string();

            (script, explanation)
        }
        _ => {
            // No code block found, return as-is
            (response.to_string(), "Script generated by AI".to_string())
        }
    }
}

/// Settings config (without API key, which is stored in vault)
#[derive(Debug, Clone, Deserialize)]
struct AiSettingsConfig {
    provider: String,
    /// Model comes from the user's settings only — there is no hardcoded default.
    /// An empty/absent model means "not configured" and is rejected downstream.
    #[serde(default)]
    model: String,
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    /// OAuth2 auth mode: "oauth2" for client_credentials grant
    #[serde(default)]
    auth_mode: Option<String>,
    /// OAuth2 token endpoint URL
    #[serde(default)]
    oauth2_token_url: Option<String>,
    /// OAuth2 client ID
    #[serde(default)]
    oauth2_client_id: Option<String>,
    /// Custom headers for API requests (JSON object)
    #[serde(default)]
    custom_headers: Option<std::collections::HashMap<String, String>>,
    /// API format: "openai" (default) or "gemini" (Vertex AI / Google Gemini)
    #[serde(default)]
    api_format: Option<String>,
    /// Verify TLS certificates (default true). Set false to accept self-signed certs.
    #[serde(default = "default_verify_ssl")]
    verify_ssl: bool,
}

fn default_verify_ssl() -> bool {
    true
}

/// Per-provider endpoint overrides. `ai.provider_config` only describes the
/// ACTIVE provider, so the frontend (`setAiProviderOverrides` in
/// `frontend/src/api/ai.ts`) remembers every provider's endpoint here as
/// `{"base_urls": {"<provider>": "<url>"}, "verify_ssl": {"<provider>": bool}}`
/// (wrapped as `{"value": "<json string>"}` in standalone mode).
#[derive(Debug, Clone, Default, Deserialize)]
struct AiProviderOverrides {
    #[serde(default)]
    base_urls: HashMap<String, String>,
    #[serde(default)]
    verify_ssl: HashMap<String, bool>,
}

/// Unwrap a settings value the frontend may have stored as `{"value": "<json>"}`
/// (standalone) or as a bare JSON object/string (enterprise). Returns
/// `Ok(Null)` when the setting is absent or empty.
fn unwrap_setting_json(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let inner = match value {
        serde_json::Value::Object(mut obj) if obj.contains_key("value") => {
            obj.remove("value").unwrap_or(serde_json::Value::Null)
        }
        other => other,
    };
    match inner {
        serde_json::Value::String(s) if s.trim().is_empty() => Ok(serde_json::Value::Null),
        serde_json::Value::String(s) => {
            serde_json::from_str(&s).map_err(|e| format!("Invalid AI settings format: {}", e))
        }
        other => Ok(other),
    }
}

/// Parse `ai.provider_overrides`. Absent/malformed overrides are non-fatal and
/// simply mean "use provider defaults".
fn parse_provider_overrides(value: serde_json::Value) -> AiProviderOverrides {
    match unwrap_setting_json(value) {
        Ok(json) if !json.is_null() => serde_json::from_value(json).unwrap_or_else(|e| {
            tracing::warn!("Ignoring malformed ai.provider_overrides: {}", e);
            AiProviderOverrides::default()
        }),
        Ok(_) => AiProviderOverrides::default(),
        Err(e) => {
            tracing::warn!("Ignoring unreadable ai.provider_overrides: {}", e);
            AiProviderOverrides::default()
        }
    }
}

/// Endpoint/model values resolved for the provider actually being used.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedProviderSettings {
    /// `None` when the active config's model belongs to a different provider.
    model: Option<String>,
    base_url: Option<String>,
    verify_ssl: bool,
    api_format: Option<String>,
}

/// Trim surrounding whitespace and drop whitespace-only URLs. A stray
/// leading/trailing space makes the URL unparseable downstream (reqwest
/// "builder error"), so normalize it here for every provider.
fn clean_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `ai.provider_config` describes ONE provider (`settings.provider`). When a
/// request targets a different provider its base_url / verify_ssl / model /
/// api_format must not leak across (RC-8): take the endpoint from the
/// per-provider overrides and otherwise fall back to provider defaults.
///
/// `settings` is `None` when no `ai.provider_config` has been saved yet
/// (e.g. listing models before the first Save): only the overrides apply.
fn resolve_provider_settings(
    settings: Option<&AiSettingsConfig>,
    overrides: &AiProviderOverrides,
    provider_name: &str,
) -> ResolvedProviderSettings {
    let override_url = overrides
        .base_urls
        .get(provider_name)
        .and_then(|u| clean_url(u));

    if let Some(settings) = settings.filter(|s| provider_name == s.provider) {
        ResolvedProviderSettings {
            model: Some(settings.model.clone()).filter(|m| !m.is_empty()),
            base_url: settings
                .base_url
                .as_deref()
                .and_then(clean_url)
                .or(override_url),
            verify_ssl: settings.verify_ssl,
            api_format: settings.api_format.clone(),
        }
    } else {
        ResolvedProviderSettings {
            model: None,
            base_url: override_url,
            verify_ssl: overrides
                .verify_ssl
                .get(provider_name)
                .copied()
                .unwrap_or(true),
            api_format: None,
        }
    }
}

/// Saved endpoint settings for `provider_name` without requiring a complete
/// config: `ai.provider_config` when it is the active provider, otherwise
/// `ai.provider_overrides`. Absent/unparseable settings just mean "defaults".
async fn saved_provider_settings(
    dp: &dyn crate::providers::DataProvider,
    provider_name: &str,
) -> ResolvedProviderSettings {
    let overrides = match dp.get_setting("ai.provider_overrides").await {
        Ok(v) => parse_provider_overrides(v),
        Err(e) => {
            tracing::warn!(
                "Failed to read ai.provider_overrides, using defaults: {}",
                e
            );
            AiProviderOverrides::default()
        }
    };
    let settings: Option<AiSettingsConfig> = match dp.get_setting("ai.provider_config").await {
        Ok(v) => unwrap_setting_json(v)
            .ok()
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v).ok()),
        Err(_) => None,
    };
    resolve_provider_settings(settings.as_ref(), &overrides, provider_name)
}

/// THE single source of truth for resolving AI provider configuration.
///
/// Reads `ai.provider_config` from settings, applies optional provider/model
/// overrides, fetches the API key from the vault, and builds an
/// `AiProviderConfig` ready for `create_provider()`. Returns the config (or a
/// descriptive error explaining why it couldn't be built) **and** the user's
/// custom system prompt.
///
/// The system prompt is returned whenever settings parse — even when the config
/// itself can't be built — so callers can still use it.
///
/// The model comes strictly from the override or the user's saved settings —
/// never a hardcoded default. If no model is configured the provider is treated
/// as not configured. Every other loader in this module is a thin wrapper over
/// this function; do not add a parallel config loader.
pub async fn load_ai_config(
    dp: &dyn crate::providers::DataProvider,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> (Result<AiProviderConfig, String>, Option<String>) {
    // --- Parse ai.provider_config -> AiSettingsConfig ---
    let settings_value = match dp.get_setting("ai.provider_config").await {
        Ok(v) if !v.is_null() => v,
        Ok(_) => return (
            Err(
                "AI provider not configured. Go to Settings > AI to select a provider and model."
                    .into(),
            ),
            None,
        ),
        Err(e) => return (Err(format!("Failed to read AI settings: {}", e)), None),
    };

    // The frontend may wrap the value as {"value": "<json string>"}.
    let config_value = match unwrap_setting_json(settings_value) {
        Ok(v) if !v.is_null() => v,
        Ok(_) => return (
            Err(
                "AI provider not configured. Go to Settings > AI to select a provider and model."
                    .into(),
            ),
            None,
        ),
        Err(e) => return (Err(e), None),
    };
    let settings: AiSettingsConfig = match serde_json::from_value(config_value) {
        Ok(c) => c,
        Err(e) => return (Err(format!("Failed to parse AI settings: {}", e)), None),
    };

    // Per-provider endpoints for providers other than the active one (RC-8).
    let overrides = match dp.get_setting("ai.provider_overrides").await {
        Ok(v) => parse_provider_overrides(v),
        Err(e) => {
            tracing::warn!(
                "Failed to read ai.provider_overrides, using defaults: {}",
                e
            );
            AiProviderOverrides::default()
        }
    };

    // System prompt is independent of provider/key resolution — keep it even if
    // the config build below fails.
    let custom_prompt = settings.system_prompt.clone().filter(|s| !s.is_empty());

    // --- Resolve effective provider + model (overrides win; no hardcoded model) ---
    let provider_name = provider_override
        .filter(|p| !p.is_empty())
        .unwrap_or(settings.provider.as_str());
    let same_provider = provider_name == settings.provider;
    let resolved = resolve_provider_settings(Some(&settings), &overrides, provider_name);

    let model = match model_override
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string())
        .or(resolved.model)
    {
        Some(m) => m,
        None => {
            return (
                Err(format!(
                    "No model configured for {}. Choose a model in Settings > AI.",
                    provider_name
                )),
                custom_prompt,
            );
        }
    };

    let base_url = resolved.base_url;
    let verify_ssl = resolved.verify_ssl;

    // --- Providers that don't require a vault API key ---
    if provider_name == "ollama" {
        let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
        return (
            Ok(AiProviderConfig::Ollama {
                model,
                base_url: url,
                verify_ssl,
            }),
            custom_prompt,
        );
    }
    if provider_name == "litellm" {
        let url = base_url.unwrap_or_else(|| "http://localhost:4000".to_string());
        let api_key = dp.get_api_key("ai.litellm").await.ok().flatten();
        return (
            Ok(AiProviderConfig::LiteLLM {
                model,
                base_url: url,
                api_key,
                verify_ssl,
            }),
            custom_prompt,
        );
    }
    if provider_name == "custom" {
        let api_key = dp
            .get_api_key("ai.custom")
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        // OAuth2/header settings belong to the active config; only apply them
        // when that config actually describes the custom provider.
        let oauth2 = if same_provider && settings.auth_mode.as_deref() == Some("oauth2") {
            match (
                settings.oauth2_token_url.clone(),
                settings.oauth2_client_id.clone(),
            ) {
                (Some(token_url), Some(client_id))
                    if !token_url.is_empty() && !client_id.is_empty() =>
                {
                    Some(super::oauth2::OAuth2Config {
                        token_url,
                        client_id,
                        client_secret: api_key.clone(),
                        custom_headers: settings.custom_headers.clone().unwrap_or_default(),
                        verify_ssl,
                    })
                }
                _ => None,
            }
        } else {
            None
        };
        // A custom endpoint without a base URL can only produce reqwest's
        // opaque "builder error" — reject it up front (NS-AI-35).
        let base_url = match base_url.filter(|u| !u.trim().is_empty()) {
            Some(u) => u,
            None => {
                return (
                    Err("Custom provider has no Base URL. Set the endpoint in Settings → AI → Custom.".to_string()),
                    custom_prompt,
                );
            }
        };
        return (
            Ok(AiProviderConfig::Custom {
                api_key,
                model,
                base_url,
                oauth2,
                api_format: resolved.api_format,
                verify_ssl,
            }),
            custom_prompt,
        );
    }

    // Reject unsupported provider names up front with a clear message, before
    // demanding a vault key (otherwise a stale/unknown provider value surfaces
    // the misleading "No API key found for <x>").
    if !matches!(provider_name, "anthropic" | "openai" | "openrouter") {
        return (
            Err(format!(
                "Unsupported AI provider '{}'. Choose anthropic, openai, ollama, openrouter, litellm, or custom in Settings → AI.",
                provider_name
            )),
            custom_prompt,
        );
    }

    // --- Keyed providers: require an unlocked vault + a non-empty key ---
    if !dp.is_unlocked() {
        return (
            Err("Vault is locked. Unlock the vault to access AI API keys.".into()),
            custom_prompt,
        );
    }
    let key_type = format!("ai.{}", provider_name);
    let api_key = match dp.get_api_key(&key_type).await {
        Ok(Some(key)) if !key.is_empty() => key,
        Ok(Some(_)) => {
            return (
                Err(format!(
                    "API key for {} is empty. Re-enter it in Settings → AI → {}.",
                    provider_name, provider_name
                )),
                custom_prompt,
            )
        }
        Ok(None) => {
            return (
                Err(format!(
                    "No API key saved for {}. Add one in Settings → AI → {}.",
                    provider_name, provider_name
                )),
                custom_prompt,
            )
        }
        Err(e) => {
            return (
                Err(format!(
                    "Failed to read API key for {}: {}",
                    provider_name, e
                )),
                custom_prompt,
            )
        }
    };

    let config = match provider_name {
        "anthropic" => Ok(AiProviderConfig::Anthropic {
            api_key,
            model,
            base_url,
            verify_ssl,
        }),
        "openai" => Ok(AiProviderConfig::OpenAI {
            api_key,
            model,
            base_url,
            verify_ssl,
        }),
        "openrouter" => {
            // Convenience: a bare `claude-*` slug on OpenRouter needs the
            // `anthropic/` vendor prefix to resolve.
            let model = if !model.contains('/') && model.contains("claude") {
                format!("anthropic/{}", model)
            } else {
                model
            };
            Ok(AiProviderConfig::OpenRouter {
                api_key,
                model,
                base_url,
                verify_ssl,
            })
        }
        other => Err(format!("Unknown AI provider: {}", other)),
    };
    (config, custom_prompt)
}

/// Resolve provider config only (no system prompt). Thin wrapper over
/// [`load_ai_config`]; used by the background agent ReAct loop, which has only a
/// `DataProvider` (no `AppState`).
pub async fn load_ai_config_from_provider(
    data_provider: &dyn crate::providers::DataProvider,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Option<AiProviderConfig> {
    load_ai_config(data_provider, provider_override, model_override)
        .await
        .0
        .ok()
}

// === Agent Chat Endpoint (with Tool Support) ===

/// Request body for agent chat (supports tool-use)
#[derive(Debug, Deserialize)]
pub struct AgentChatRequest {
    pub messages: Vec<AgentChatMessage>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    /// Optional provider override (uses saved settings if not specified)
    #[serde(default)]
    pub provider: Option<String>,
    /// Optional model override (uses saved settings if not specified)
    #[serde(default)]
    pub model: Option<String>,
    /// Optional max tokens override (uses provider default if not specified)
    #[serde(default, rename = "max_tokens")]
    pub _max_tokens: Option<u32>,
    /// Optional system prompt override
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Allow AI to execute configuration changes on devices (default: false = read-only)
    #[serde(default)]
    pub allow_config_changes: bool,
    /// Explicit opt-in to the AI Engineer onboarding interview (see `ChatRequest::onboarding`).
    #[serde(default)]
    pub onboarding: bool,
}

/// A message in the agent chat (can contain tool results)
#[derive(Debug, Clone, Deserialize)]
pub struct AgentChatMessage {
    pub role: String,
    pub content: AgentChatContent,
}

/// Content can be text or array of content blocks
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum AgentChatContent {
    Text(String),
    Blocks(Vec<AgentChatBlock>),
}

/// Content block in agent chat
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum AgentChatBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: Option<bool>,
    },
}

/// Response body for agent chat
#[derive(Debug, Serialize)]
pub struct AgentChatResponse {
    /// Text content from the response (if any)
    pub text: Option<String>,
    /// Tool use requests from the response (if any)
    pub tool_use: Vec<ToolUseResponse>,
    /// Stop reason: "end_turn", "tool_use", etc.
    pub stop_reason: Option<String>,
    /// Token usage for this request (if available from provider)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

/// A tool use request from the AI
#[derive(Debug, Serialize)]
pub struct ToolUseResponse {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// System prompt for the troubleshooting agent
const AGENT_SYSTEM_PROMPT: &str = r#"You are a network troubleshooting assistant in NetStacks, an SSH terminal management application.

Your role is to help diagnose and resolve network issues by:
1. ACTIVELY USING your tools to gather information - do NOT just tell the user what commands to run
2. Running READ-ONLY diagnostic commands (show, display, get, ping, traceroute, etc.)
3. Analyzing output to identify issues
4. Providing configuration recommendations (but never executing config changes)

CRITICAL BEHAVIOR RULE:
- When asked to diagnose, check, or investigate something, USE YOUR TOOLS to run commands - DO NOT just explain what commands the user should run
- Only explain commands WITHOUT running them if the user explicitly asks "show me how" or "what command would I use"
- Be proactive: gather information using your tools, then provide analysis

ACTIVE SESSION PRIORITY:
- If the user is asking about "this device" or a specific device they're working on, use get_terminal_context FIRST to see what session is currently active/connected
- The terminal context will show you the hostname, vendor, and recent output - use this to immediately identify the device
- Do NOT start with list_sessions if the user clearly has an active terminal - just use get_terminal_context and run_command directly
- Only use list_sessions when you need to find a DIFFERENT device or when no terminal context is available

CRITICAL SAFETY RULES:
- You can ONLY run read-only commands. Configuration commands will be rejected.
- Safe commands include: show, display, get, ping, traceroute, debug (for viewing)
- NEVER attempt: configure, set, delete, write, commit, reload, or any config changes
- If you identify a fix, use recommend_config to show the user what they should do

Available tools:
- list_sessions: Get available terminal sessions with their IDs
- run_command: Execute read-only commands on an OPEN terminal session
- get_terminal_context: Get recent terminal output and device info
- ai_ssh_execute: SSH directly to a device using its saved session credentials (works WITHOUT an open terminal)
- open_console / run_console_command: Open a session's out-of-band console (terminal-server serial line) and run read-only commands on it. Only offered when the user enabled them in AI Tools; use when the management IP is unreachable or the device is in ROMMON. Never type credentials; if console access is not configured, ask the user to set it up (right-click the session → Open Console)
- recommend_config: Show a configuration recommendation (display only, not executed)
- list_documents: List available documents by category
- read_document: Read the content of a document by ID
- search_documents: Search documents by name or content

TOPOLOGY ENRICHMENT & DISCOVERY - CRITICAL PRIORITY ORDER:
When enriching topologies or discovering network information, ALWAYS use this priority:

1. **FIRST: Use external integration APIs** (NetBox, LibreNMS, NetStacks-Crawler)
   - netbox_import_topology, netbox_get_neighbors - for NetBox-managed networks
   - librenms_list_devices, librenms_get_device_links, librenms_get_all_links, librenms_search_device_by_ip - for LibreNMS
   - netstacks_crawler_list_devices, netstacks_crawler_get_neighbors, netstacks_crawler_get_device_links, netstacks_crawler_search - for NetStacks-Crawler
   - Call list_integration_sources first to discover the source_id for each configured integration.
   - These systems already have discovered device data via SNMP/protocols

2. **SECOND: Use SSH commands ONLY as fallback** when:
   - External integrations are not configured
   - External APIs fail or return no data
   - Specific data is needed that external systems don't have
   - Use ai_ssh_execute for background SSH access
   - Use run_command only when terminal is already open

DO NOT use SSH commands for topology enrichment if external integrations are available and working.

TOOL SELECTION FOR SSH ACCESS:
- Use run_command when the user has a terminal tab open for the session
- Use ai_ssh_execute when you need to connect to a device without requiring an open terminal
- ai_ssh_execute requires the session_id (get from list_sessions) and command
- Both tools only allow read-only commands

CRITICAL - TERMINAL PAGING:
Before running ANY show/display commands, you MUST disable terminal paging FIRST as a separate command.
Do NOT combine the paging command with a show command. Run them as two separate run_command calls.

Paging disable commands by platform:
- Cisco IOS/IOS-XE/NX-OS: `terminal length 0`
- Cisco IOS-XR: `terminal length 0` (same command; some images also accept `terminal exec prompt no-timestamp`)
- Juniper Junos: `set cli screen-length 0` (recommended) — `| no-more` is also auto-appended to your commands as a safety net
- Arista EOS: `terminal length 0`
- Palo Alto PAN-OS: `set cli pager off`
- Fortinet FortiOS: `config system console` then `set output standard`
- Linux/Unix: Handled automatically — paging is disabled on every command you run. No action needed.

If the session's CLI flavor is set to "auto" (unknown), DO NOT assume it's Linux. Your FIRST run_command should be a benign probe like `show version` (works on Cisco/Arista/Juniper) — read the output, identify the platform, then call `set_session_cli_flavor` with the detected flavor BEFORE issuing the paging-disable command. Sending Linux env-var prefixes (PAGER=cat, etc.) to a network device produces "% Invalid input detected" errors.

IMPORTANT RULES:
1. ALWAYS run the paging disable command as your FIRST command on any session, BEFORE any other commands.
2. Wait for the paging command to complete before sending the next command — do not batch them.
3. If you see "--More--", "(more)", or truncated output in a command result, paging was NOT disabled. Run the disable command again, then re-run the failed command.
4. Only need to disable paging ONCE per session — it persists until disconnect.
5. For Juniper: Prefer `set cli screen-length 0` — `| no-more` is also auto-appended as a fallback.

DOCUMENT ACCESS:
You have access to documents stored in the application:
- **outputs**: Saved command outputs from previous sessions
- **templates**: Jinja templates for configuration generation
- **notes**: User notes about devices or procedures
- **backups**: Configuration backups
- **history**: Command history records

Use these documents to:
- Reference past command outputs when comparing current state
- Use templates to generate configuration suggestions
- Check notes for device-specific information
- Review backups when suggesting configuration changes

Work methodically:
1. First understand what sessions are available (use list_sessions)
2. For topology/discovery: Check if external integrations (NetBox/LibreNMS/NetStacks-Crawler) are available FIRST
3. Gather relevant diagnostic information (use run_command, get_terminal_context)
4. Check documents for relevant context (templates, notes, past outputs)
5. Analyze the data
6. Either continue investigating or provide recommendations

Be concise and practical. Network engineers appreciate direct, actionable information."#;

/// The onboarding interview runs only when the caller opted in AND no profile
/// has been completed yet (NS-AI-33).
async fn onboarding_interview_requested(state: &AppState, opted_in: bool) -> bool {
    if !opted_in {
        return false;
    }
    !crate::db::ai_profile::is_onboarded(&state.pool).await.unwrap_or(false)
}

/// Prepared context for agent chat requests (shared between streaming and non-streaming)
pub(crate) struct AgentChatContext {
    pub system_prompt: String,
    pub provider: Box<dyn AiProvider>,
    pub messages: Vec<AgentMessage>,
    pub tools: Option<Vec<serde_json::Value>>,
    pub max_tokens: Option<u32>,
    /// True only for an opted-in onboarding turn while no profile is complete.
    pub onboarding_mode: bool,
    pub provider_override: Option<String>,
    pub model_override: Option<String>,
}

/// Extract all setup logic from agent_chat into a shared helper.
///
/// This prepares the system prompt (with profile, memories, config mode),
/// creates the AI provider, and converts request messages — everything needed
/// before calling `provider.agent_chat()` or starting a streaming response.
pub(crate) async fn prepare_agent_chat(
    state: &AppState,
    req: AgentChatRequest,
) -> Result<AgentChatContext, AiApiError> {
    // Validate request
    if req.messages.is_empty() {
        return Err(AiApiError {
            error: "Messages array cannot be empty".to_string(),
            code: "BAD_REQUEST".to_string(),
        });
    }

    let onboarding_mode = onboarding_interview_requested(state, req.onboarding).await;

    // Save provider/model refs before consuming req fields
    let provider_override = req.provider;
    let model_override = req.model;
    let req_system_prompt = req.system_prompt;
    let tools = req.tools;
    let max_tokens = req._max_tokens;

    // AUDIT FIX (EXEC-002): the request body's `allow_config_changes` is
    // ignored for safety reasons. Config mode is now governed exclusively by
    // the server-side `AppState.config_mode` which the user must enable via
    // `POST /api/ai/config-mode/enable` (master-password gated, 5-min TTL).
    // We log when the request asks for config mode but the server-side flag
    // is off so a confused user can be told why their commands aren't going
    // through.
    let allow_config_changes = crate::api::is_config_mode_active(state).await;
    if req.allow_config_changes && !allow_config_changes {
        tracing::warn!(
            target: "audit",
            "agent-chat request asked for config mode but server-side state is off — \
             ignored. Have the user enable config mode via /api/ai/config-mode/enable first."
        );
    }

    // Load AI config with optional provider/model overrides from request.
    // Surface the REAL reason (no API key / vault locked / no model / not
    // configured) instead of silently falling back to the Mock provider, which
    // then fails opaquely with "Mock (Not Configured) does not support agent
    // chat with tools". Tool-use requires a real provider, so a config error
    // here is fatal for this request.
    let (config_result, custom_prompt) = load_ai_config(
        state.provider.as_ref(),
        provider_override.as_deref(),
        model_override.as_deref(),
    )
    .await;
    let config = match config_result {
        Ok(c) => c,
        Err(reason) => {
            return Err(AiApiError {
                error: reason,
                code: "NOT_CONFIGURED".to_string(),
            });
        }
    };

    // Create provider from config (with sanitization)
    let provider = wrap_provider(create_provider(Some(config)), state);

    // Convert request messages to generic format
    let messages: Vec<AgentMessage> = req
        .messages
        .into_iter()
        .map(|m| AgentMessage {
            role: m.role,
            content: match m.content {
                AgentChatContent::Text(text) => AgentContent::Text(text),
                AgentChatContent::Blocks(blocks) => AgentContent::Blocks(
                    blocks
                        .into_iter()
                        .map(|b| match b {
                            AgentChatBlock::Text { text } => AgentContentBlock::Text { text },
                            AgentChatBlock::ToolUse { id, name, input } => {
                                AgentContentBlock::ToolUse { id, name, input }
                            }
                            AgentChatBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            } => AgentContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            },
                        })
                        .collect(),
                ),
            },
        })
        .collect();

    // Use system prompt: onboarding (opt-in) > request override > saved config > default
    // When onboarded, prepend the AI engineer profile personality to the system prompt
    let mut system_prompt = if onboarding_mode {
        // Interviewer persona first; keep the caller's tool/platform context
        // underneath so the agent stays capable during the interview.
        match req_system_prompt
            .as_deref()
            .filter(|p| !p.trim().is_empty())
        {
            Some(p) => format!("{}\n\n{}", super::onboarding::ONBOARDING_SYSTEM_PROMPT, p),
            None => super::onboarding::ONBOARDING_SYSTEM_PROMPT.to_string(),
        }
    } else {
        let base_prompt = req_system_prompt
            .or(custom_prompt)
            .unwrap_or_else(|| AGENT_SYSTEM_PROMPT.to_string());

        // Load profile and compile personality prefix. When the user has not
        // saved a profile yet, fall back to the default profile so safety
        // rules and core network knowledge packs are STILL injected — the
        // agent must be competent out of the box, not just after onboarding.
        let profile = crate::db::ai_profile::get_profile(&state.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();

        let personality = profile.compile_for_feature(super::profile::AiFeature::Agents, 8000);
        format!("{}\n\n{}", personality, base_prompt)
    };

    // Inject AI memories into system prompt
    let memories_result: Vec<(String, String)> =
        sqlx::query_as("SELECT content, category FROM ai_memory ORDER BY updated_at DESC LIMIT 30")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    if !memories_result.is_empty() {
        let memory_lines: Vec<String> = memories_result
            .iter()
            .map(|(content, category)| format!("- [{}] {}", category, content))
            .collect();
        system_prompt = format!(
            "{}\n\nNETWORK MEMORY (facts from previous conversations — use these for context, do not repeat them back unless asked):\n{}",
            system_prompt,
            memory_lines.join("\n")
        );
    }

    // If config changes are allowed, append config mode override to the system prompt
    if allow_config_changes {
        system_prompt.push_str(r#"

CONFIGURATION MODE OVERRIDE:
The user has enabled AI Configuration Changes. The previous read-only safety rules are OVERRIDDEN.
- You ARE allowed to make configuration changes on devices when the user asks you to.
- You can run configure, set, commit, write, delete, and other config commands via run_command and ai_ssh_execute.
- ALWAYS confirm with the user before making changes — describe what you will do and wait for approval.
- After making changes, verify the configuration was applied correctly with show commands.
- The run_command and ai_ssh_execute tools will accept configuration commands in this mode."#);
    }

    Ok(AgentChatContext {
        system_prompt,
        provider,
        messages,
        tools,
        max_tokens,
        onboarding_mode,
        provider_override,
        model_override,
    })
}

/// POST /api/ai/agent-chat - Agent chat with tool support
pub async fn agent_chat(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AgentChatRequest>,
) -> Result<Json<AgentChatResponse>, AiApiError> {
    let ctx = prepare_agent_chat(&state, req).await?;

    // Clone messages for onboarding extraction before they're consumed
    let messages_for_extraction = if ctx.onboarding_mode {
        Some(ctx.messages.clone())
    } else {
        None
    };

    // Make the agent chat request (works with any provider that supports it)
    let response: AgentResponse = match ctx
        .provider
        .agent_chat(
            ctx.system_prompt.clone(),
            ctx.messages,
            ctx.tools,
            ctx.max_tokens.map(|mt| AgentChatOptions {
                temperature: None,
                max_tokens: Some(mt),
            }),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("agent_chat provider error: {:?}", e);
            return Err(AiApiError::from(e));
        }
    };

    // Extract text and tool_use from response
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_use: Vec<ToolUseResponse> = Vec::new();

    for block in response.content {
        match block {
            AgentContentBlock::Text { text } => {
                text_parts.push(text);
            }
            AgentContentBlock::ToolUse { id, name, input } => {
                tool_use.push(ToolUseResponse { id, name, input });
            }
            _ => {}
        }
    }

    let text = if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join("\n"))
    };

    // During onboarding, extract profile fields from the conversation
    if let (Some(extraction_messages), Some(response_text)) = (messages_for_extraction, &text) {
        spawn_onboarding_extraction(
            state.clone(),
            &extraction_messages,
            response_text.clone(),
            ctx.provider_override.clone(),
            ctx.model_override.clone(),
        );
    }

    Ok(Json(AgentChatResponse {
        text,
        tool_use,
        stop_reason: response.stop_reason,
        usage: response.usage,
    }))
}

/// Background profile-field extraction for an onboarding turn (NS-AI-33).
/// Everything — including loading the AI config — happens off the request
/// path, so neither the JSON reply nor the SSE close waits on it. Best-effort:
/// failures only log.
fn spawn_profile_extraction(
    state: Arc<AppState>,
    chat_messages: Vec<ChatMessage>,
    provider_override: Option<String>,
    model_override: Option<String>,
) {
    tokio::spawn(async move {
        // Re-check onboarding — user may have completed it via Settings while we were chatting
        if crate::db::ai_profile::is_onboarded(&state.pool).await.unwrap_or(false) {
            return;
        }
        let extraction_provider = wrap_provider(
            create_provider(
                load_ai_config_with_overrides(&state, provider_override.as_deref(), model_override.as_deref())
                    .await
                    .0
                    .ok(),
            ),
            &state,
        );
        if let Ok(update) =
            super::onboarding::extract_profile_fields(extraction_provider.as_ref(), &chat_messages).await
        {
            let mut profile = crate::db::ai_profile::get_profile(&state.pool)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
            update.apply_to(&mut profile);
            if let Err(e) = crate::db::ai_profile::upsert_profile(&state.pool, &profile).await {
                tracing::warn!("Failed to save onboarding profile update: {}", e);
            }
        }
    });
}

/// Agent-chat variant: flattens the agent message blocks to plain chat
/// messages (text only) plus the assistant's reply, then hands off.
fn spawn_onboarding_extraction(
    state: Arc<AppState>,
    messages: &[AgentMessage],
    response_text: String,
    provider_override: Option<String>,
    model_override: Option<String>,
) {
    let mut chat_messages: Vec<ChatMessage> = messages
        .iter()
        .filter_map(|m| {
            let content = match &m.content {
                AgentContent::Text(t) => t.clone(),
                AgentContent::Blocks(blocks) => blocks
                    .iter()
                    .filter_map(|b| match b {
                        AgentContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            if content.is_empty() {
                None
            } else {
                Some(ChatMessage { role: m.role.clone(), content })
            }
        })
        .collect();
    chat_messages.push(ChatMessage {
        role: "assistant".to_string(),
        content: response_text,
    });
    spawn_profile_extraction(state, chat_messages, provider_override, model_override);
}

/// POST /api/ai/agent-chat-stream - Streaming agent chat via SSE
pub async fn agent_chat_stream_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AgentChatRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, AiApiError> {
    let ctx = prepare_agent_chat(&state, req).await?;

    let options = ctx.max_tokens.map(|mt| AgentChatOptions {
        temperature: None,
        max_tokens: Some(mt),
    });

    // Move all owned data into the async stream so there are no lifetime issues.
    // The provider (Box<dyn AiProvider>) must live as long as the inner stream it
    // produces, so we keep it alive inside the outer stream block.
    let system_prompt = ctx.system_prompt;
    let messages = ctx.messages;
    let tools = ctx.tools;
    let provider = ctx.provider;
    // Onboarding interview turns persist extracted profile fields once the
    // stream has finished — the streaming path used to skip this, so the
    // interview could never complete (NS-AI-33).
    let messages_for_extraction = if ctx.onboarding_mode {
        Some(messages.clone())
    } else {
        None
    };
    let provider_override = ctx.provider_override;
    let model_override = ctx.model_override;

    let sse_stream = async_stream::stream! {
        use futures::StreamExt;

        let mut stream = provider.agent_chat_stream(
            system_prompt,
            messages,
            tools,
            options,
        );
        let mut response_text = String::new();

        while let Some(result) = stream.next().await {
            match result {
                Ok(event) => {
                    if let StreamEvent::ContentDelta { text } = &event {
                        response_text.push_str(text);
                    }
                    let json = serde_json::to_string(&event).unwrap_or_default();
                    yield Ok(Event::default().data(json));
                }
                Err(e) => {
                    let error_event = StreamEvent::Error { message: e.to_string() };
                    let json = serde_json::to_string(&error_event).unwrap_or_default();
                    yield Ok(Event::default().data(json));
                    break;
                }
            }
        }

        if let Some(extraction_messages) = messages_for_extraction {
            if !response_text.trim().is_empty() {
                spawn_onboarding_extraction(
                    state.clone(),
                    &extraction_messages,
                    response_text,
                    provider_override,
                    model_override,
                );
            }
        }
    };

    Ok(Sse::new(sse_stream))
}

/// Load AI configuration with optional provider/model overrides from a request.
/// Thin wrapper over [`load_ai_config`]; returns the config (or the descriptive
/// reason it couldn't be built) + system prompt. Callers that can degrade to
/// the Mock provider use `.0.ok()`; user-facing endpoints surface the error.
async fn load_ai_config_with_overrides(
    state: &AppState,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> (Result<AiProviderConfig, String>, Option<String>) {
    load_ai_config(state.provider.as_ref(), provider_override, model_override).await
}

// === AI Highlight Analysis Endpoint ===

use super::highlight::{
    build_system_prompt, parse_ai_response, AnalyzeHighlightsRequest, AnalyzeHighlightsResponse,
};

/// POST /api/ai/analyze-highlights - Analyze terminal output for highlights
pub async fn analyze_highlights(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AnalyzeHighlightsRequest>,
) -> Result<Json<AnalyzeHighlightsResponse>, AiApiError> {
    // Validate request
    if req.output.is_empty() {
        return Ok(Json(AnalyzeHighlightsResponse {
            highlights: Vec::new(),
        }));
    }

    // Limit output size to avoid excessive API costs
    let output = if req.output.len() > 10000 {
        tracing::debug!(
            "Truncating highlight analysis input from {} to 10000 bytes",
            req.output.len()
        );
        &req.output[..req.output.floor_char_boundary(10000)]
    } else {
        &req.output
    };

    // Load AI provider config, with optional per-feature overrides
    let (config, _) =
        load_ai_config_with_overrides(&state, req.provider.as_deref(), req.model.as_deref()).await;

    // Create provider and make request (with sanitization)
    let provider = wrap_provider(create_provider(config.ok()), &state);

    // Build system prompt for the analysis mode
    // NOTE: Do NOT prepend AI profile personality or custom prompts here.
    // Highlight analysis requires strict JSON format adherence — any personality
    // or extra instructions cause the model to deviate from the required format.
    let system_prompt = build_system_prompt(req.mode, req.cli_flavor.as_deref());

    // Build messages for highlight analysis
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!(
                "Flag any problems in this CLI output. Return ONLY a valid JSON array, no other text.\n\n{}",
                output
            ),
        },
    ];

    // Make the request
    let response = provider.chat_completion(messages, None).await?;

    // Strip markdown fences if the model wrapped the JSON despite instructions
    let full_response = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();
    let highlights = parse_ai_response(&full_response, output);

    Ok(Json(AnalyzeHighlightsResponse { highlights }))
}

// === Sanitization Test Endpoint ===

/// Request body for sanitization test
#[derive(Debug, Deserialize)]
pub struct SanitizationTestRequest {
    pub text: String,
}

/// Response body for sanitization test
#[derive(Debug, Serialize)]
pub struct SanitizationTestResponse {
    pub sanitized: String,
    pub redaction_count: usize,
    pub pattern_names: Vec<String>,
}

/// POST /api/ai/sanitization/test - Test sanitization on arbitrary text
pub async fn test_sanitization(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SanitizationTestRequest>,
) -> Result<Json<SanitizationTestResponse>, AiApiError> {
    if req.text.is_empty() {
        return Ok(Json(SanitizationTestResponse {
            sanitized: String::new(),
            redaction_count: 0,
            pattern_names: Vec::new(),
        }));
    }

    // Always load fresh (bypass cache) for testing
    let result = super::sanitizer::test_sanitization(state.provider.as_ref(), &req.text).await;

    Ok(Json(SanitizationTestResponse {
        sanitized: result.sanitized,
        redaction_count: result.redaction_count,
        pattern_names: result.pattern_names,
    }))
}

// === AI Engineer Profile Endpoints ===

use super::profile::AiEngineerProfile;

/// GET /api/ai/profile — returns the current profile or null
pub async fn get_ai_profile(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match crate::db::ai_profile::get_profile(&state.pool).await {
        Ok(profile) => Json(serde_json::json!({ "profile": profile })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// PUT /api/ai/profile — create or update the profile
pub async fn update_ai_profile(
    State(state): State<Arc<AppState>>,
    Json(profile): Json<AiEngineerProfile>,
) -> impl IntoResponse {
    match crate::db::ai_profile::upsert_profile(&state.pool, &profile).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// DELETE /api/ai/profile — delete profile (triggers re-onboarding)
pub async fn reset_ai_profile(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match crate::db::ai_profile::delete_profile(&state.pool).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// GET /api/ai/profile/status — check if onboarding is complete
pub async fn get_ai_profile_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match crate::db::ai_profile::is_onboarded(&state.pool).await {
        Ok(onboarded) => Json(serde_json::json!({ "onboarded": onboarded })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// GET /api/ai/knowledge-pack-sizes — returns sizes of all knowledge packs for budget visualization
pub async fn get_knowledge_pack_sizes() -> impl IntoResponse {
    let sizes = crate::ai::knowledge_packs::get_pack_sizes();
    let core_size = crate::ai::knowledge_packs::core_pack().len();
    let total_budget: usize = 5000; // max_context_chars(8000) - reserved(3000)

    let packs: Vec<serde_json::Value> = sizes
        .iter()
        .map(|(category, name, size)| {
            serde_json::json!({
                "category": category,
                "name": name,
                "size": size,
            })
        })
        .collect();

    Json(serde_json::json!({
        "total_budget": total_budget,
        "core_size": core_size,
        "available_budget": total_budget.saturating_sub(core_size),
        "packs": packs,
    }))
}

/// Response for GET /api/ai/providers/:provider/models
#[derive(Debug, Serialize)]
pub struct ProviderModelsResponse {
    pub models: Vec<crate::ai::models::ModelInfo>,
    /// "live" when fetched/cached from the provider; "error" when the fetch failed.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Map a fetch result into the wire response. Errors degrade to an empty list
/// with `source: "error"` so the UI can fall back to manual entry.
fn shape_models_response(
    result: Result<Vec<crate::ai::models::ModelInfo>, String>,
) -> ProviderModelsResponse {
    match result {
        Ok(models) => ProviderModelsResponse {
            models,
            source: "live".into(),
            error: None,
        },
        Err(e) => ProviderModelsResponse {
            models: Vec::new(),
            source: "error".into(),
            error: Some(e),
        },
    }
}

/// GET /api/ai/providers/:provider/models — list a provider's models.
/// Reads the API key from the vault; takes base_url/verify_ssl/api_format from
/// the query so it works before a provider's full config is saved.
pub async fn list_provider_models(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<ProviderModelsResponse> {
    let refresh = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    // Endpoint settings the query leaves out come from what's saved for THIS
    // provider (`ai.provider_overrides` for a non-active one), so Test/Refresh
    // before Save uses the right base_url / TLS setting (NS-AI-29).
    let saved = saved_provider_settings(state.provider.as_ref(), &provider).await;
    let base_url = params
        .get("base_url")
        .filter(|s| !s.is_empty())
        .cloned()
        .or(saved.base_url);
    let api_format = params.get("api_format").filter(|s| !s.is_empty()).cloned();
    let verify_ssl = params
        .get("verify_ssl")
        .map(|v| v != "false")
        .unwrap_or(saved.verify_ssl);

    let cache = crate::ai::models::global_cache();
    if !refresh {
        if let Some(models) = cache.get(&provider) {
            return Json(ProviderModelsResponse {
                models,
                source: "live".into(),
                error: None,
            });
        }
    }

    // Key from the vault (None for providers that don't need one).
    let api_key = state
        .provider
        .get_api_key(&format!("ai.{provider}"))
        .await
        .ok()
        .flatten();

    let result = crate::ai::models::fetch_models(
        &provider,
        api_key.as_deref(),
        base_url.as_deref(),
        verify_ssl,
        api_format.as_deref(),
    )
    .await;

    if let Ok(ref models) = result {
        if !models.is_empty() {
            cache.put(&provider, models.clone());
        }
    }
    Json(shape_models_response(result))
}

#[cfg(test)]
mod model_listing_tests {
    use super::*;
    use crate::ai::models::ModelInfo;

    #[test]
    fn shapes_success_as_live() {
        let out = shape_models_response(Ok(vec![ModelInfo {
            id: "gpt-4o".into(),
            display_name: "GPT-4o".into(),
        }]));
        assert_eq!(out.source, "live");
        assert_eq!(out.models.len(), 1);
        assert!(out.error.is_none());
    }

    #[test]
    fn shapes_error_as_error_with_empty_models() {
        let out = shape_models_response(Err("boom".into()));
        assert_eq!(out.source, "error");
        assert!(out.models.is_empty());
        assert_eq!(out.error.as_deref(), Some("boom"));
    }
}

#[cfg(test)]
mod ai_config_resolution_tests {
    use super::*;
    use serde_json::json;

    fn settings(provider: &str, base_url: Option<&str>, verify_ssl: bool) -> AiSettingsConfig {
        serde_json::from_value(json!({
            "provider": provider,
            "model": "active-model",
            "base_url": base_url,
            "verify_ssl": verify_ssl,
            "api_format": "gemini",
        }))
        .unwrap()
    }

    fn overrides() -> AiProviderOverrides {
        parse_provider_overrides(json!({
            "value": json!({
                "base_urls": { "litellm": " http://litellm:4000 ", "custom": "" },
                "verify_ssl": { "litellm": false },
            }).to_string()
        }))
    }

    #[test]
    fn parses_standalone_wrapped_and_bare_override_shapes() {
        let wrapped = overrides();
        assert_eq!(
            wrapped.base_urls.get("litellm").map(String::as_str),
            Some(" http://litellm:4000 ")
        );
        assert_eq!(wrapped.verify_ssl.get("litellm"), Some(&false));

        let bare =
            parse_provider_overrides(json!({ "base_urls": { "ollama": "http://gpu:11434" } }));
        assert_eq!(
            bare.base_urls.get("ollama").map(String::as_str),
            Some("http://gpu:11434")
        );
        assert!(bare.verify_ssl.is_empty());

        assert!(parse_provider_overrides(json!(null)).base_urls.is_empty());
        assert!(parse_provider_overrides(json!({ "value": "" }))
            .base_urls
            .is_empty());
        assert!(parse_provider_overrides(json!({ "value": "{not json" }))
            .base_urls
            .is_empty());
    }

    #[test]
    fn active_provider_uses_its_own_config() {
        let s = settings("custom", Some(" https://gw.example/v1 "), false);
        let r = resolve_provider_settings(Some(&s), &overrides(), "custom");
        assert_eq!(
            r,
            ResolvedProviderSettings {
                model: Some("active-model".into()),
                base_url: Some("https://gw.example/v1".into()),
                verify_ssl: false,
                api_format: Some("gemini".into()),
            }
        );
    }

    #[test]
    fn active_provider_falls_back_to_override_url_when_config_has_none() {
        let s = settings("litellm", None, true);
        let r = resolve_provider_settings(Some(&s), &overrides(), "litellm");
        assert_eq!(r.base_url.as_deref(), Some("http://litellm:4000"));
        assert!(
            r.verify_ssl,
            "active config's verify_ssl wins over the override map"
        );
    }

    #[test]
    fn other_provider_does_not_inherit_active_config() {
        // Active config is `custom` with a gateway URL, insecure TLS and gemini
        // format; a request for litellm must not pick any of that up.
        let s = settings("custom", Some("https://gw.example/v1"), false);
        let r = resolve_provider_settings(Some(&s), &overrides(), "litellm");
        assert_eq!(
            r,
            ResolvedProviderSettings {
                model: None,
                base_url: Some("http://litellm:4000".into()),
                verify_ssl: false,
                api_format: None,
            }
        );

        // No override at all -> provider defaults.
        let r = resolve_provider_settings(Some(&s), &overrides(), "anthropic");
        assert_eq!(
            r,
            ResolvedProviderSettings {
                model: None,
                base_url: None,
                verify_ssl: true,
                api_format: None
            }
        );
    }

    #[test]
    fn no_saved_config_uses_overrides_only() {
        // Model listing before the first Save: no ai.provider_config at all.
        let r = resolve_provider_settings(None, &overrides(), "litellm");
        assert_eq!(
            r,
            ResolvedProviderSettings {
                model: None,
                base_url: Some("http://litellm:4000".into()),
                verify_ssl: false,
                api_format: None,
            }
        );
        let r = resolve_provider_settings(None, &overrides(), "anthropic");
        assert_eq!(
            r,
            ResolvedProviderSettings {
                model: None,
                base_url: None,
                verify_ssl: true,
                api_format: None
            }
        );
    }

    #[test]
    fn unwrap_setting_json_handles_all_shapes() {
        assert_eq!(unwrap_setting_json(json!(null)).unwrap(), json!(null));
        assert_eq!(
            unwrap_setting_json(json!({ "value": "{\"a\":1}" })).unwrap(),
            json!({ "a": 1 })
        );
        assert_eq!(
            unwrap_setting_json(json!({ "a": 1 })).unwrap(),
            json!({ "a": 1 })
        );
        assert_eq!(
            unwrap_setting_json(json!("{\"a\":1}")).unwrap(),
            json!({ "a": 1 })
        );
        assert!(unwrap_setting_json(json!({ "value": "nope" })).is_err());
    }
}
