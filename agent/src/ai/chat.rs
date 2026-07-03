//! AI chat API endpoints
//!
//! Provides HTTP endpoints for AI chat and script generation.

use axum::{
    extract::State,
    http::StatusCode,
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::Arc;

use crate::api::AppState;

use super::providers::{
    create_provider, AiContext, AiError, AiProvider, AiProviderConfig, ChatMessage,
    AgentMessage, AgentContent, AgentContentBlock, AgentResponse, AgentChatOptions, TokenUsage,
    StreamEvent,
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

    // Check onboarding state
    let is_onboarded = crate::db::ai_profile::is_onboarded(&state.pool)
        .await
        .unwrap_or(false);

    // Load AI provider config - use per-request overrides if present, otherwise diagnostic error loading
    let config = if req.provider.is_some() || req.model.is_some() {
        let (cfg, _) = load_ai_config_with_overrides(&state, req.provider.as_deref(), req.model.as_deref()).await;
        cfg
    } else {
        match load_ai_config_or_error(&state).await {
            Ok(cfg) => Some(cfg),
            Err(reason) => {
                tracing::warn!("AI config load failed: {}", reason);
                return Err(AiApiError {
                    error: reason,
                    code: "NOT_CONFIGURED".to_string(),
                });
            }
        }
    };

    // Create provider and make request (with sanitization)
    let provider = wrap_provider(create_provider(config), &state);

    if !is_onboarded {
        // Onboarding mode: use onboarding system prompt
        let mut onboarding_messages = vec![ChatMessage {
            role: "system".to_string(),
            content: super::onboarding::ONBOARDING_SYSTEM_PROMPT.to_string(),
        }];
        onboarding_messages.extend(req.messages.clone());

        let response = provider.chat_completion(onboarding_messages, None).await?;

        // Extract profile fields from the conversation (best-effort, non-blocking)
        let all_messages: Vec<ChatMessage> = req.messages.iter()
            .chain(std::iter::once(&ChatMessage {
                role: "assistant".to_string(),
                content: response.clone(),
            }))
            .cloned()
            .collect();

        // Spawn extraction as background task to not block the response
        let pool = state.pool.clone();
        let extraction_provider = wrap_provider(
            create_provider(
                if req.provider.is_some() || req.model.is_some() {
                    let (cfg, _) = load_ai_config_with_overrides(&state, req.provider.as_deref(), req.model.as_deref()).await;
                    cfg
                } else {
                    load_ai_config_or_error(&state).await.ok()
                }
            ),
            &state,
        );
        tokio::spawn(async move {
            // Re-check onboarding — user may have completed it via Settings while we were chatting
            let already_onboarded = crate::db::ai_profile::is_onboarded(&pool)
                .await
                .unwrap_or(false);
            if already_onboarded {
                return;
            }
            if let Ok(update) = super::onboarding::extract_profile_fields(
                extraction_provider.as_ref(),
                &all_messages,
            ).await {
                let mut profile = crate::db::ai_profile::get_profile(&pool)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                update.apply_to(&mut profile);

                if let Err(e) = crate::db::ai_profile::upsert_profile(&pool, &profile).await {
                    tracing::warn!("Failed to save onboarding profile update: {}", e);
                }
            }
        });

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
        None => ai_profile.map(|p| {
            let mut ctx = super::providers::AiContext::default();
            ctx.ai_profile = Some(p);
            ctx
        }),
    };
    let response = provider.chat_completion(req.messages, context).await?;
    Ok(Json(ChatResponse { response, onboarding: None }))
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

    // Load AI provider config - use per-request overrides if present, otherwise diagnostic error loading
    let config = if req.provider.is_some() || req.model.is_some() {
        let (cfg, _) = load_ai_config_with_overrides(&state, req.provider.as_deref(), req.model.as_deref()).await;
        cfg
    } else {
        match load_ai_config_or_error(&state).await {
            Ok(cfg) => Some(cfg),
            Err(reason) => {
                return Err(AiApiError {
                    error: reason,
                    code: "NOT_CONFIGURED".to_string(),
                });
            }
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
        let personality = profile.compile_for_feature(
            super::profile::AiFeature::ScriptGeneration,
            8000,
        );
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
            (
                response.to_string(),
                "Script generated by AI".to_string(),
            )
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

fn default_verify_ssl() -> bool { true }

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
        Ok(_) => return (Err("AI provider not configured. Go to Settings > AI to select a provider and model.".into()), None),
        Err(e) => return (Err(format!("Failed to read AI settings: {}", e)), None),
    };

    // The frontend may wrap the value as {"value": "<json string>"}.
    let inner_value = if let Some(obj) = settings_value.as_object() {
        obj.get("value").cloned().unwrap_or(serde_json::Value::Null)
    } else {
        settings_value
    };
    if inner_value.is_null() {
        return (Err("AI provider not configured. Go to Settings > AI to select a provider and model.".into()), None);
    }
    let config_value: serde_json::Value = if let serde_json::Value::String(s) = &inner_value {
        match serde_json::from_str(s) {
            Ok(parsed) => parsed,
            Err(e) => return (Err(format!("Invalid AI settings format: {}", e)), None),
        }
    } else {
        inner_value
    };
    let settings: AiSettingsConfig = match serde_json::from_value(config_value) {
        Ok(c) => c,
        Err(e) => return (Err(format!("Failed to parse AI settings: {}", e)), None),
    };

    // System prompt is independent of provider/key resolution — keep it even if
    // the config build below fails.
    let custom_prompt = settings.system_prompt.clone().filter(|s| !s.is_empty());

    // --- Resolve effective provider + model (overrides win; no hardcoded model) ---
    let provider_name = provider_override
        .filter(|p| !p.is_empty())
        .unwrap_or(settings.provider.as_str());

    let model = match model_override
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string())
        .or_else(|| Some(settings.model.clone()).filter(|m| !m.is_empty()))
    {
        Some(m) => m,
        None => {
            return (
                Err(format!("No model configured for {}. Choose a model in Settings > AI.", provider_name)),
                custom_prompt,
            );
        }
    };

    let base_url = settings.base_url.clone();
    let verify_ssl = settings.verify_ssl;

    // --- Providers that don't require a vault API key ---
    if provider_name == "ollama" {
        let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
        return (Ok(AiProviderConfig::Ollama { model, base_url: url, verify_ssl }), custom_prompt);
    }
    if provider_name == "litellm" {
        let url = base_url.unwrap_or_else(|| "http://localhost:4000".to_string());
        let api_key = dp.get_api_key("ai.litellm").await.ok().flatten();
        return (Ok(AiProviderConfig::LiteLLM { model, base_url: url, api_key, verify_ssl }), custom_prompt);
    }
    if provider_name == "custom" {
        let api_key = dp.get_api_key("ai.custom").await.ok().flatten().unwrap_or_default();
        let oauth2 = if settings.auth_mode.as_deref() == Some("oauth2") {
            match (settings.oauth2_token_url.clone(), settings.oauth2_client_id.clone()) {
                (Some(token_url), Some(client_id)) if !token_url.is_empty() && !client_id.is_empty() => {
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
        return (
            Ok(AiProviderConfig::Custom {
                api_key,
                model,
                base_url: base_url.unwrap_or_default(),
                oauth2,
                api_format: settings.api_format.clone(),
                verify_ssl,
            }),
            custom_prompt,
        );
    }

    // --- Keyed providers: require an unlocked vault + a non-empty key ---
    if !dp.is_unlocked() {
        return (Err("Vault is locked. Unlock the vault to access AI API keys.".into()), custom_prompt);
    }
    let key_type = format!("ai.{}", provider_name);
    let api_key = match dp.get_api_key(&key_type).await {
        Ok(Some(key)) if !key.is_empty() => key,
        Ok(Some(_)) => return (Err(format!("API key for {} is empty. Update it in Settings > AI.", provider_name)), custom_prompt),
        Ok(None) => return (Err(format!("No API key found for {}. Add your API key in Settings > AI.", provider_name)), custom_prompt),
        Err(e) => return (Err(format!("Failed to read API key for {}: {}", provider_name, e)), custom_prompt),
    };

    let config = match provider_name {
        "anthropic" => Ok(AiProviderConfig::Anthropic { api_key, model, base_url, verify_ssl }),
        "openai" => Ok(AiProviderConfig::OpenAI { api_key, model, base_url, verify_ssl }),
        "openrouter" => {
            // Convenience: a bare `claude-*` slug on OpenRouter needs the
            // `anthropic/` vendor prefix to resolve.
            let model = if !model.contains('/') && model.contains("claude") {
                format!("anthropic/{}", model)
            } else {
                model
            };
            Ok(AiProviderConfig::OpenRouter { api_key, model })
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
    load_ai_config(data_provider, provider_override, model_override).await.0.ok()
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

/// Prepared context for agent chat requests (shared between streaming and non-streaming)
pub(crate) struct AgentChatContext {
    pub system_prompt: String,
    pub provider: Box<dyn AiProvider>,
    pub messages: Vec<AgentMessage>,
    pub tools: Option<Vec<serde_json::Value>>,
    pub max_tokens: Option<u32>,
    pub is_onboarded: bool,
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

    // Check onboarding state
    let is_onboarded = crate::db::ai_profile::is_onboarded(&state.pool)
        .await
        .unwrap_or(false);

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
    ).await;
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
                    blocks.into_iter().map(|b| match b {
                        AgentChatBlock::Text { text } => AgentContentBlock::Text { text },
                        AgentChatBlock::ToolUse { id, name, input } => {
                            AgentContentBlock::ToolUse { id, name, input }
                        }
                        AgentChatBlock::ToolResult { tool_use_id, content, is_error } => {
                            AgentContentBlock::ToolResult { tool_use_id, content, is_error }
                        }
                    }).collect()
                ),
            },
        })
        .collect();

    // Use system prompt: onboarding > request override > saved config > default
    // When onboarded, prepend the AI engineer profile personality to the system prompt
    let mut system_prompt = if !is_onboarded && req_system_prompt.is_none() {
        super::onboarding::ONBOARDING_SYSTEM_PROMPT.to_string()
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

        let personality = profile.compile_for_feature(
            super::profile::AiFeature::Agents,
            8000,
        );
        format!("{}\n\n{}", personality, base_prompt)
    };

    // Inject AI memories into system prompt
    let memories_result: Vec<(String, String)> = sqlx::query_as(
        "SELECT content, category FROM ai_memory ORDER BY updated_at DESC LIMIT 30"
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    if !memories_result.is_empty() {
        let memory_lines: Vec<String> = memories_result.iter()
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
        is_onboarded,
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
    let messages_for_extraction = if !ctx.is_onboarded {
        Some(ctx.messages.clone())
    } else {
        None
    };

    // Make the agent chat request (works with any provider that supports it)
    let response: AgentResponse = match ctx.provider
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
    if let Some(extraction_messages) = messages_for_extraction {
        if let Some(response_text) = &text {
            // Build ChatMessage list for extraction from agent messages
            let mut chat_messages: Vec<ChatMessage> = extraction_messages.iter()
                .filter_map(|m| {
                    let content = match &m.content {
                        AgentContent::Text(t) => t.clone(),
                        AgentContent::Blocks(blocks) => blocks.iter()
                            .filter_map(|b| match b {
                                AgentContentBlock::Text { text } => Some(text.clone()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    };
                    if content.is_empty() { None } else {
                        Some(ChatMessage { role: m.role.clone(), content })
                    }
                })
                .collect();
            chat_messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: response_text.clone(),
            });

            let pool = state.pool.clone();
            let extraction_provider = wrap_provider(
                create_provider(
                    load_ai_config_with_overrides(&state, ctx.provider_override.as_deref(), ctx.model_override.as_deref()).await.0
                ),
                &state,
            );
            tokio::spawn(async move {
                // Re-check onboarding — user may have completed it via Settings while we were chatting
                let already_onboarded = crate::db::ai_profile::is_onboarded(&pool)
                    .await
                    .unwrap_or(false);
                if already_onboarded {
                    return;
                }
                if let Ok(update) = super::onboarding::extract_profile_fields(
                    extraction_provider.as_ref(),
                    &chat_messages,
                ).await {
                    let mut profile = crate::db::ai_profile::get_profile(&pool)
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_default();

                    update.apply_to(&mut profile);

                    if let Err(e) = crate::db::ai_profile::upsert_profile(&pool, &profile).await {
                        tracing::warn!("Failed to save onboarding profile update: {}", e);
                    }
                }
            });
        }
    }

    Ok(Json(AgentChatResponse {
        text,
        tool_use,
        stop_reason: response.stop_reason,
        usage: response.usage,
    }))
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

    let sse_stream = async_stream::stream! {
        use futures::StreamExt;

        let mut stream = provider.agent_chat_stream(
            system_prompt,
            messages,
            tools,
            options,
        );

        while let Some(result) = stream.next().await {
            match result {
                Ok(event) => {
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
    };

    Ok(Sse::new(sse_stream))
}

/// Load AI configuration with system prompt from settings + vault
/// Returns both the provider config and the custom system prompt (if set)
/// Load AI configuration with a descriptive error on failure.
/// Used by chat_completion to return actionable error messages.
async fn load_ai_config_or_error(state: &AppState) -> Result<AiProviderConfig, String> {
    load_ai_config(state.provider.as_ref(), None, None).await.0
}

/// Load AI configuration with optional provider/model overrides from a request.
/// Thin wrapper over [`load_ai_config`]; returns config + system prompt.
async fn load_ai_config_with_overrides(
    state: &AppState,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> (Option<AiProviderConfig>, Option<String>) {
    let (config, prompt) = load_ai_config(state.provider.as_ref(), provider_override, model_override).await;
    (config.ok(), prompt)
}

// === AI Highlight Analysis Endpoint ===

use super::highlight::{
    AnalyzeHighlightsRequest, AnalyzeHighlightsResponse, build_system_prompt, parse_ai_response,
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
        tracing::debug!("Truncating highlight analysis input from {} to 10000 bytes", req.output.len());
        &req.output[..req.output.floor_char_boundary(10000)]
    } else {
        &req.output
    };

    // Load AI provider config, with optional per-feature overrides
    let (config, _) = load_ai_config_with_overrides(
        &state,
        req.provider.as_deref(),
        req.model.as_deref(),
    ).await;

    // Create provider and make request (with sanitization)
    let provider = wrap_provider(create_provider(config), &state);

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

    Ok(Json(AnalyzeHighlightsResponse {
        highlights,
    }))
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
    let result = super::sanitizer::test_sanitization(
        state.provider.as_ref(),
        &req.text,
    )
    .await;

    Ok(Json(SanitizationTestResponse {
        sanitized: result.sanitized,
        redaction_count: result.redaction_count,
        pattern_names: result.pattern_names,
    }))
}

// === AI Engineer Profile Endpoints ===

use super::profile::AiEngineerProfile;

/// GET /api/ai/profile — returns the current profile or null
pub async fn get_ai_profile(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match crate::db::ai_profile::get_profile(&state.pool).await {
        Ok(profile) => Json(serde_json::json!({ "profile": profile })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// PUT /api/ai/profile — create or update the profile
pub async fn update_ai_profile(
    State(state): State<Arc<AppState>>,
    Json(profile): Json<AiEngineerProfile>,
) -> impl IntoResponse {
    match crate::db::ai_profile::upsert_profile(&state.pool, &profile).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// DELETE /api/ai/profile — delete profile (triggers re-onboarding)
pub async fn reset_ai_profile(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match crate::db::ai_profile::delete_profile(&state.pool).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// GET /api/ai/profile/status — check if onboarding is complete
pub async fn get_ai_profile_status(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match crate::db::ai_profile::is_onboarded(&state.pool).await {
        Ok(onboarded) => Json(serde_json::json!({ "onboarded": onboarded })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() }))).into_response(),
    }
}

/// GET /api/ai/knowledge-pack-sizes — returns sizes of all knowledge packs for budget visualization
pub async fn get_knowledge_pack_sizes() -> impl IntoResponse {
    let sizes = crate::ai::knowledge_packs::get_pack_sizes();
    let core_size = crate::ai::knowledge_packs::core_pack().len();
    let total_budget: usize = 5000; // max_context_chars(8000) - reserved(3000)

    let packs: Vec<serde_json::Value> = sizes.iter().map(|(category, name, size)| {
        serde_json::json!({
            "category": category,
            "name": name,
            "size": size,
        })
    }).collect();

    Json(serde_json::json!({
        "total_budget": total_budget,
        "core_size": core_size,
        "available_budget": total_budget.saturating_sub(core_size),
        "packs": packs,
    }))
}
