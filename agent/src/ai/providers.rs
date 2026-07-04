//! AI provider implementations
//!
//! Supports multiple AI providers with a common trait interface.
//! - AnthropicProvider: Claude API (primary)
//! - MockProvider: Placeholder responses when no API key configured

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

/// Errors from AI providers
#[derive(Error, Debug)]
pub enum AiError {
    #[error("AI provider not configured: {0}")]
    NotConfigured(String),
    #[error("API request failed: {0}")]
    RequestFailed(String),
    #[error("Invalid response from AI provider: {0}")]
    InvalidResponse(String),
    #[error("Rate limited by AI provider")]
    RateLimited,
    #[error("Request timed out")]
    Timeout,
}

/// A message in the chat conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user", "assistant", "system"
    pub content: String,
}

/// Enhanced device context for network-aware AI assistance
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceContext {
    pub name: String,
    #[serde(rename = "type")]
    pub device_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,     // "IOS-XE", "NX-OS", "Junos"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,       // "Cisco", "Juniper", "Arista"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub status: String,
}

/// Protocol session on a connection
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProtocolSession {
    pub protocol: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Connection context for topology link awareness
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionContext {
    pub source_device: DeviceContext,
    pub source_interface: String,
    pub target_device: DeviceContext,
    pub target_interface: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocols: Option<Vec<ProtocolSession>>,
}

/// Terminal context parsed from buffer
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_output: Option<String>,  // Last ~50 lines
}

/// Session context entry - tribal knowledge about a device (Phase 14)
///
/// Field names stay snake_case (no rename_all): the frontend interface
/// (frontend/src/api/ai.ts SessionContextEntry) and the sibling struct the
/// sessions endpoint serializes (models.rs SessionContext) are both
/// snake_case, so this must match or /ai/chat deserialization fails.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionContextEntry {
    pub id: String,
    pub issue: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_ref: Option<String>,
    pub author: String,
    pub created_at: String,
}

/// Enhanced context passed to the AI for network-aware responses
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContext {
    /// Selected text from the terminal
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    /// Session name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// Device context (from topology or detected)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceContext>,
    /// Connection context (for topology link clicks)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionContext>,
    /// Terminal context (parsed from buffer)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalContext>,
    /// Session context - team knowledge for this device (Phase 14)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_context: Option<Vec<SessionContextEntry>>,
    /// AI Engineer profile (loaded from DB, not from frontend request)
    #[serde(skip)]
    pub ai_profile: Option<super::profile::AiEngineerProfile>,
    /// Which AI feature is making this request (controls profile segment selection)
    #[serde(skip)]
    pub feature: super::profile::AiFeature,
}

/// AI provider configuration (stored as JSON in settings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider")]
pub enum AiProviderConfig {
    #[serde(rename = "anthropic")]
    Anthropic {
        api_key: String,
        #[serde(default = "default_anthropic_model")]
        model: String,
        #[serde(default)]
        base_url: Option<String>,
        #[serde(default = "default_verify_ssl")]
        verify_ssl: bool,
    },
    #[serde(rename = "openai")]
    OpenAI {
        api_key: String,
        #[serde(default = "default_openai_model")]
        model: String,
        #[serde(default)]
        base_url: Option<String>,
        #[serde(default = "default_verify_ssl")]
        verify_ssl: bool,
    },
    #[serde(rename = "ollama")]
    Ollama {
        #[serde(default = "default_ollama_model")]
        model: String,
        #[serde(default = "default_ollama_url")]
        base_url: String,
        #[serde(default = "default_verify_ssl")]
        verify_ssl: bool,
    },
    #[serde(rename = "openrouter")]
    OpenRouter {
        api_key: String,
        #[serde(default = "default_openrouter_model")]
        model: String,
    },
    #[serde(rename = "litellm")]
    LiteLLM {
        #[serde(default = "default_litellm_model")]
        model: String,
        #[serde(default = "default_litellm_url")]
        base_url: String,
        #[serde(default)]
        api_key: Option<String>,
        #[serde(default = "default_verify_ssl")]
        verify_ssl: bool,
    },
    #[serde(rename = "custom")]
    Custom {
        api_key: String,
        model: String,
        base_url: String,
        /// OAuth2 configuration for client_credentials auth (optional).
        /// When set, OAuth2 tokens are used instead of the static api_key.
        #[serde(default)]
        oauth2: Option<super::oauth2::OAuth2Config>,
        /// API format: "openai" (default) or "gemini" (Vertex AI / Google Gemini).
        #[serde(default)]
        api_format: Option<String>,
        #[serde(default = "default_verify_ssl")]
        verify_ssl: bool,
    },
}

/// API format for custom providers.
#[derive(Debug, Clone, PartialEq)]
pub enum ApiFormat {
    /// OpenAI-compatible: POST {base_url}/chat/completions
    OpenAI,
    /// Gemini/Vertex AI: POST {base_url}/{model}:generateContent (auto-suffix
    /// only added when the model name does not already contain ':').
    Gemini,
    /// Anthropic on Vertex AI: POST {base_url}/{model}:rawPredict with
    /// Anthropic message body (anthropic_version + messages + max_tokens).
    /// Auto-suffix `:rawPredict` only added when model lacks ':'.
    VertexAnthropic,
}

/// Build a `{base_url}/{model}` URL, auto-appending `:{default_action}` only
/// when the model name doesn't already contain a `:` action suffix. Lets
/// users put `claude-sonnet-4-6:rawPredict` (or any other action) directly
/// in the Model field for endpoints that need a non-default action.
fn build_model_action_url(base_url: &str, model: &str, default_action: &str) -> String {
    if model.contains(':') {
        format!("{}/{}", base_url.trim_end_matches('/'), model)
    } else {
        format!("{}/{}:{}", base_url.trim_end_matches('/'), model, default_action)
    }
}

fn default_verify_ssl() -> bool { true }

fn default_anthropic_model() -> String {
    "claude-3-5-sonnet-20241022".to_string()
}

fn default_openai_model() -> String {
    "gpt-4o".to_string()
}

fn default_ollama_model() -> String {
    "llama3.2".to_string()
}

fn default_ollama_url() -> String {
    "http://localhost:11434".to_string()
}

fn default_openrouter_model() -> String {
    "anthropic/claude-3.5-sonnet".to_string()
}

fn default_litellm_model() -> String {
    "gpt-4o".to_string()
}

fn default_litellm_url() -> String {
    "http://localhost:4000".to_string()
}

// === Generic Agent Chat Types ===

/// Generic message for agent chat (works with any provider)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub role: String,
    pub content: AgentContent,
}

/// Content can be text or array of content blocks
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentContent {
    Text(String),
    Blocks(Vec<AgentContentBlock>),
}

/// Generic content block for agent chat
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentContentBlock {
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
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// Token usage from AI provider
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Total tokens (input + output) - some providers track this separately
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
}

/// Generic response from agent chat
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResponse {
    pub content: Vec<AgentContentBlock>,
    pub stop_reason: Option<String>,
    /// Token usage for this request
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

/// Events emitted during streaming agent chat
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    /// A chunk of text content from the AI
    #[serde(rename = "content_delta")]
    ContentDelta { text: String },
    /// AI wants to start a tool call
    #[serde(rename = "tool_use_start")]
    ToolUseStart { id: String, name: String },
    /// Incremental JSON input for the tool call
    #[serde(rename = "tool_input_delta")]
    ToolInputDelta { delta: String },
    /// Tool input is complete
    #[serde(rename = "tool_use_end")]
    ToolUseEnd,
    /// Stream is complete
    #[serde(rename = "done")]
    Done {
        stop_reason: Option<String>,
        usage: Option<TokenUsage>,
    },
    /// An error occurred
    #[serde(rename = "error")]
    Error { message: String },
}

/// Options for agent chat requests (temperature, max_tokens overrides)
#[derive(Debug, Clone)]
pub struct AgentChatOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// Trait for AI providers
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Send a chat completion request
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError>;

    /// Send an agent chat request with tool support
    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Default implementation for providers that don't support tool calling
        let _ = (system_prompt, messages, tools, options);
        Err(AiError::NotConfigured(format!(
            "{} does not support agent chat with tools",
            self.provider_name()
        )))
    }

    /// Stream agent chat responses as SSE events.
    /// Default implementation calls `agent_chat` and emits synthetic events.
    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let fut = self.agent_chat(system_prompt, messages, tools, options);
        Box::pin(async_stream::stream! {
            match fut.await {
                Ok(response) => {
                    for block in &response.content {
                        match block {
                            AgentContentBlock::Text { text } => {
                                yield Ok(StreamEvent::ContentDelta { text: text.clone() });
                            }
                            AgentContentBlock::ToolUse { id, name, input } => {
                                yield Ok(StreamEvent::ToolUseStart {
                                    id: id.clone(),
                                    name: name.clone(),
                                });
                                yield Ok(StreamEvent::ToolInputDelta {
                                    delta: serde_json::to_string(input).unwrap_or_default(),
                                });
                                yield Ok(StreamEvent::ToolUseEnd);
                            }
                            _ => {}
                        }
                    }
                    yield Ok(StreamEvent::Done {
                        stop_reason: response.stop_reason,
                        usage: response.usage,
                    });
                }
                Err(e) => {
                    yield Ok(StreamEvent::Error { message: e.to_string() });
                }
            }
        })
    }

    /// Get the provider name for display
    fn provider_name(&self) -> &str;
}

// === Anthropic Provider ===

/// Anthropic Claude API provider
pub struct AnthropicProvider {
    api_key: String,
    model: String,
    base_url: String,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: Option<String>, base_url: Option<String>, verify_ssl: bool) -> Result<Self, AiError> {
        let effective_url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .danger_accept_invalid_certs(!verify_ssl)
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            api_key,
            model: model.unwrap_or_else(default_anthropic_model),
            base_url: effective_url,
            client,
        })
    }
}

/// Anthropic API request format
#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
}

/// Anthropic-on-Vertex request format. Differs from native Anthropic in two
/// ways: the model is in the URL (not the body), and an `anthropic_version`
/// field selects the Vertex contract version.
#[derive(Debug, Serialize)]
struct VertexAnthropicRequest {
    anthropic_version: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
}

/// Anthropic-on-Vertex request format for agent chat — supports tools and
/// content-block messages (so tool_use round-trips work). Same wire shape as
/// native Anthropic agent requests minus the `model` field (the model is in
/// the URL on Vertex). Set `stream: Some(true)` for `:streamRawPredict`.
#[derive(Debug, Serialize)]
struct VertexAnthropicAgentRequest {
    anthropic_version: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicAgentMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

/// Anthropic API request format with tools (for agent chat)
#[derive(Debug, Serialize)]
pub struct AnthropicAgentRequest {
    pub model: String,
    pub max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    pub messages: Vec<AnthropicAgentMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

/// Agent message that can contain tool_use/tool_result content blocks
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicAgentMessage {
    pub role: String,
    pub content: AnthropicAgentContent,
}

/// Content can be a string or array of content blocks (for tool results)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnthropicAgentContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

/// A content block in Anthropic's API
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
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
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// Anthropic API response format
#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
    #[serde(default)]
    error: Option<AnthropicError>,
}

/// Anthropic API response format for agent (with tool_use support)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicAgentResponse {
    pub id: String,
    #[serde(rename = "type")]
    pub response_type: String,
    pub role: String,
    pub content: Vec<ContentBlock>,
    pub model: String,
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
    pub usage: AnthropicUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// Anthropic streaming event types (SSE)
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicStreamEvent {
    #[serde(rename = "message_start")]
    MessageStart {
        message: AnthropicStreamMessage,
    },
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: usize,
        content_block: AnthropicStreamContentBlock,
    },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta {
        #[serde(rename = "index")]
        _index: usize,
        delta: AnthropicStreamDelta,
    },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },
    #[serde(rename = "message_delta")]
    MessageDelta {
        delta: AnthropicMessageDelta,
        usage: Option<AnthropicUsage>,
    },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(rename = "ping")]
    Ping,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
struct AnthropicStreamMessage {
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicStreamContentBlock {
    #[serde(rename = "text")]
    Text {
        #[serde(rename = "text")]
        _text: String,
    },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicStreamDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Deserialize)]
struct AnthropicMessageDelta {
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicError {
    #[serde(rename = "type")]
    error_type: String,
    message: String,
}

use super::profile::AiEngineerProfile;

/// Default prompt used when no profile exists (pre-onboarding or fallback).
const DEFAULT_SYSTEM_PROMPT: &str = "You are a CCIE-level network engineering assistant in NetStacks. Provide concise, practical help for network operations. Always verify device state with show commands before making assertions.";

/// Build system prompt with profile-driven personality and context injection.
///
/// If a profile exists, compiles personality segments and knowledge packs
/// before appending device/session context. Falls back to a default prompt
/// if no profile is available. The `AiFeature` on the context controls
/// which profile segments are included (Chat gets everything, Agents skip
/// identity, ScriptGeneration gets lean packs, etc.).
fn build_system_prompt(
    context: &Option<AiContext>,
    _profile: Option<&AiEngineerProfile>,
) -> String {
    // Use profile from context if available, falling back to explicit parameter
    let ctx_profile = context.as_ref().and_then(|c| c.ai_profile.as_ref());
    let profile = ctx_profile.or(_profile);
    let feature = context.as_ref().map(|c| c.feature).unwrap_or_default();
    let mut prompt = if let Some(prof) = profile {
        // Profile exists: compile segments for this feature
        // Use 8000 chars as default budget (~2000 tokens)
        let max_chars = 8000;
        prof.compile_for_feature(feature, max_chars)
    } else {
        // No profile yet: use default with safety rules
        format!("{}\n\n{}", super::safety::SAFETY_RULES, DEFAULT_SYSTEM_PROMPT)
    };

    prompt.push_str("\n\n");

    if let Some(ctx) = context {
        // Device context
        if let Some(device) = &ctx.device {
            prompt.push_str(&format!(
                "Current device: {} ({}) at {}\n",
                device.name,
                device.vendor.as_deref().unwrap_or(&device.device_type),
                device.primary_ip.as_deref().unwrap_or("unknown IP")
            ));
            if let Some(platform) = &device.platform {
                prompt.push_str(&format!("Platform: {}\n", platform));
            }
            if let Some(site) = &device.site {
                prompt.push_str(&format!("Site: {}\n", site));
            }
            if let Some(role) = &device.role {
                prompt.push_str(&format!("Role: {}\n", role));
            }
            prompt.push_str(&format!("Status: {}\n", device.status));
        }

        // Connection context
        if let Some(conn) = &ctx.connection {
            prompt.push_str(&format!(
                "Connection: {} ({}) <-> {} ({})\n",
                conn.source_device.name, conn.source_interface,
                conn.target_device.name, conn.target_interface
            ));
            prompt.push_str(&format!("Link status: {}\n", conn.status));
            if let Some(protocols) = &conn.protocols {
                let proto_list: Vec<String> = protocols
                    .iter()
                    .map(|p| format!("{}: {}", p.protocol, p.state))
                    .collect();
                if !proto_list.is_empty() {
                    prompt.push_str(&format!("Protocols: {}\n", proto_list.join(", ")));
                }
            }
        }

        // Terminal context
        if let Some(term) = &ctx.terminal {
            if let Some(vendor) = &term.detected_vendor {
                prompt.push_str(&format!("Detected vendor: {}\n", vendor));
            }
            if let Some(platform) = &term.detected_platform {
                prompt.push_str(&format!("Detected platform: {}\n", platform));
            }
            if let Some(hostname) = &term.hostname {
                prompt.push_str(&format!("Device hostname: {}\n", hostname));
            }
            if let Some(output) = &term.recent_output {
                prompt.push_str(&format!("\nRecent terminal output:\n```\n{}\n```\n", output));
            }
        }

        // Selected text
        if let Some(selected) = &ctx.selected_text {
            prompt.push_str(&format!("\nUser selected text:\n```\n{}\n```\n", selected));
        }

        // Session name
        if let Some(session) = &ctx.session_name {
            prompt.push_str(&format!("Session: {}\n", session));
        }

        // Session context - team knowledge (Phase 14)
        if let Some(session_ctx) = &ctx.session_context {
            if !session_ctx.is_empty() {
                prompt.push_str("\n## Team Knowledge for This Device\n");
                prompt.push_str("Past troubleshooting notes from your team:\n");
                for entry in session_ctx.iter().take(5) {
                    prompt.push_str(&format!(
                        "\n### {} (by {}, {})\n",
                        entry.issue, entry.author, entry.created_at
                    ));
                    if let Some(root_cause) = &entry.root_cause {
                        prompt.push_str(&format!("Root cause: {}\n", root_cause));
                    }
                    if let Some(resolution) = &entry.resolution {
                        prompt.push_str(&format!("Resolution: {}\n", resolution));
                    }
                    if let Some(commands) = &entry.commands {
                        prompt.push_str(&format!("Helpful commands:\n```\n{}\n```\n", commands));
                    }
                    if let Some(ticket) = &entry.ticket_ref {
                        prompt.push_str(&format!("Related ticket: {}\n", ticket));
                    }
                }
                prompt.push_str("\nProactively mention relevant past issues when they might help the engineer.\n");
            }
        }
    }

    prompt
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        tracing::debug!("Anthropic request to {}", self.base_url);
        // Build system prompt with enhanced context
        let system_prompt = build_system_prompt(&context, None);

        // Convert messages to Anthropic format (filter out system messages, use them in system prompt)
        let anthropic_messages: Vec<AnthropicMessage> = messages
            .into_iter()
            .filter(|m| m.role != "system")
            .map(|m| AnthropicMessage {
                role: if m.role == "user" {
                    "user".to_string()
                } else {
                    "assistant".to_string()
                },
                content: m.content,
            })
            .collect();

        let request = AnthropicRequest {
            model: self.model.clone(),
            max_tokens: 4096,
            system: Some(system_prompt),
            messages: anthropic_messages,
            tools: None,
        };

        let response = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: AnthropicResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type, error.message
            )));
        }

        // Extract text from response
        api_response
            .content
            .into_iter()
            .find_map(|c| {
                if c.content_type == "text" {
                    c.text
                } else {
                    None
                }
            })
            .ok_or_else(|| AiError::InvalidResponse("No text content in response".to_string()))
    }

    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);

        // Convert generic messages to Anthropic format
        let anthropic_messages: Vec<AnthropicAgentMessage> = messages
            .into_iter()
            .map(|m| AnthropicAgentMessage {
                role: m.role,
                content: match m.content {
                    AgentContent::Text(text) => AnthropicAgentContent::Text(text),
                    AgentContent::Blocks(blocks) => AnthropicAgentContent::Blocks(
                        blocks.into_iter().map(|b| match b {
                            AgentContentBlock::Text { text } => ContentBlock::Text { text },
                            AgentContentBlock::ToolUse { id, name, input } => {
                                ContentBlock::ToolUse { id, name, input }
                            }
                            AgentContentBlock::ToolResult { tool_use_id, content, is_error } => {
                                ContentBlock::ToolResult { tool_use_id, content, is_error }
                            }
                        }).collect()
                    ),
                },
            })
            .collect();

        let request = AnthropicAgentRequest {
            model: self.model.clone(),
            max_tokens,
            system: Some(system_prompt),
            messages: anthropic_messages,
            tools,
        };

        let response = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            tracing::error!("Anthropic agent_chat error: HTTP {} - {}", status, &error_text);
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: AnthropicAgentResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse agent response: {}", e))
        })?;

        // Convert Anthropic response to generic format
        let content: Vec<AgentContentBlock> = api_response.content
            .into_iter()
            .map(|b| match b {
                ContentBlock::Text { text } => AgentContentBlock::Text { text },
                ContentBlock::ToolUse { id, name, input } => {
                    AgentContentBlock::ToolUse { id, name, input }
                }
                ContentBlock::ToolResult { tool_use_id, content, is_error } => {
                    AgentContentBlock::ToolResult { tool_use_id, content, is_error }
                }
            })
            .collect();

        // Convert Anthropic usage to generic format
        let usage = Some(TokenUsage {
            input_tokens: api_response.usage.input_tokens,
            output_tokens: api_response.usage.output_tokens,
            total_tokens: Some(api_response.usage.input_tokens + api_response.usage.output_tokens),
        });

        Ok(AgentResponse {
            content,
            stop_reason: api_response.stop_reason,
            usage,
        })
    }

    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);

        // Convert generic messages to Anthropic format
        let anthropic_messages: Vec<serde_json::Value> = messages
            .into_iter()
            .map(|m| {
                let content = match m.content {
                    AgentContent::Text(text) => serde_json::Value::String(text),
                    AgentContent::Blocks(blocks) => serde_json::json!(
                        blocks.into_iter().map(|b| match b {
                            AgentContentBlock::Text { text } => serde_json::json!({
                                "type": "text",
                                "text": text,
                            }),
                            AgentContentBlock::ToolUse { id, name, input } => serde_json::json!({
                                "type": "tool_use",
                                "id": id,
                                "name": name,
                                "input": input,
                            }),
                            AgentContentBlock::ToolResult { tool_use_id, content, is_error } => {
                                let mut v = serde_json::json!({
                                    "type": "tool_result",
                                    "tool_use_id": tool_use_id,
                                    "content": content,
                                });
                                if let Some(err) = is_error {
                                    v.as_object_mut().unwrap().insert("is_error".to_string(), serde_json::json!(err));
                                }
                                v
                            }
                        }).collect::<Vec<_>>()
                    ),
                };
                serde_json::json!({
                    "role": m.role,
                    "content": content,
                })
            })
            .collect();

        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": anthropic_messages,
        });
        if !system_prompt.is_empty() {
            body.as_object_mut().unwrap().insert("system".to_string(), serde_json::json!(system_prompt));
        }
        if let Some(t) = tools {
            if !t.is_empty() {
                body.as_object_mut().unwrap().insert("tools".to_string(), serde_json::json!(t));
            }
        }

        let url = format!("{}/v1/messages", self.base_url);
        let api_key = self.api_key.clone();
        let client = self.client.clone();

        Box::pin(async_stream::stream! {
            let response = client
                .post(&url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await;

            let response = match response {
                Ok(r) => r,
                Err(e) => {
                    if e.is_timeout() {
                        yield Err(AiError::Timeout);
                    } else {
                        yield Err(AiError::RequestFailed(e.to_string()));
                    }
                    return;
                }
            };

            let status = response.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                yield Err(AiError::RateLimited);
                return;
            }
            if !status.is_success() {
                let error_text = response.text().await.unwrap_or_default();
                yield Err(AiError::RequestFailed(format!("HTTP {}: {}", status, error_text)));
                return;
            }

            use futures::StreamExt;

            let mut byte_stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut input_tokens: u32 = 0;
            let mut output_tokens: u32 = 0;
            let mut stop_reason: Option<String> = None;
            let mut tool_use_indices = std::collections::HashSet::<usize>::new();

            while let Some(chunk_result) = byte_stream.next().await {
                let chunk = match chunk_result {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        yield Err(AiError::RequestFailed(format!("Stream read error: {}", e)));
                        return;
                    }
                };

                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Process complete lines from the buffer
                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() || line == "event: message_start" || line == "event: message_stop"
                        || line == "event: message_delta" || line == "event: content_block_start"
                        || line == "event: content_block_delta" || line == "event: content_block_stop"
                        || line == "event: ping" || line.starts_with("event:")
                    {
                        continue;
                    }

                    if let Some(data) = line.strip_prefix("data: ") {
                        let event: AnthropicStreamEvent = match serde_json::from_str(data) {
                            Ok(e) => e,
                            Err(e) => {
                                tracing::warn!("Failed to parse SSE event: {} — data: {}", e, data);
                                continue;
                            }
                        };

                        match event {
                            AnthropicStreamEvent::MessageStart { message } => {
                                if let Some(usage) = message.usage {
                                    input_tokens = usage.input_tokens;
                                }
                            }
                            AnthropicStreamEvent::ContentBlockStart { index, content_block } => {
                                match content_block {
                                    AnthropicStreamContentBlock::ToolUse { id, name } => {
                                        tool_use_indices.insert(index);
                                        yield Ok(StreamEvent::ToolUseStart { id, name });
                                    }
                                    AnthropicStreamContentBlock::Text { .. } => {
                                        // Text block starts — content arrives via deltas
                                    }
                                }
                            }
                            AnthropicStreamEvent::ContentBlockDelta { delta, .. } => {
                                match delta {
                                    AnthropicStreamDelta::TextDelta { text } => {
                                        yield Ok(StreamEvent::ContentDelta { text });
                                    }
                                    AnthropicStreamDelta::InputJsonDelta { partial_json } => {
                                        yield Ok(StreamEvent::ToolInputDelta { delta: partial_json });
                                    }
                                }
                            }
                            AnthropicStreamEvent::ContentBlockStop { index } => {
                                if tool_use_indices.remove(&index) {
                                    yield Ok(StreamEvent::ToolUseEnd);
                                }
                            }
                            AnthropicStreamEvent::MessageDelta { delta, usage } => {
                                if let Some(reason) = delta.stop_reason {
                                    stop_reason = Some(reason);
                                }
                                if let Some(u) = usage {
                                    output_tokens = u.output_tokens;
                                }
                            }
                            AnthropicStreamEvent::MessageStop => {
                                yield Ok(StreamEvent::Done {
                                    stop_reason: stop_reason.take(),
                                    usage: Some(TokenUsage {
                                        input_tokens,
                                        output_tokens,
                                        total_tokens: Some(input_tokens + output_tokens),
                                    }),
                                });
                            }
                            AnthropicStreamEvent::Ping | AnthropicStreamEvent::Unknown => {}
                        }
                    }
                }
            }
        })
    }

    fn provider_name(&self) -> &str {
        "Anthropic Claude"
    }
}

// === OpenAI Provider ===

/// OpenAI API provider (GPT-4, etc.)
/// Also used for custom OpenAI-compatible providers, optionally with OAuth2 auth.
/// Supports both OpenAI and Gemini (Vertex AI) request formats.
pub struct OpenAIProvider {
    api_key: String,
    model: String,
    base_url: String,
    client: reqwest::Client,
    /// Optional OAuth2 token manager for providers that use OAuth2 instead of
    /// static API keys. Stored as `Arc` so multiple providers built per-request
    /// share the same in-memory token cache (see
    /// `OAuth2TokenManager::get_or_create_shared`).
    oauth2: Option<Arc<super::oauth2::OAuth2TokenManager>>,
    /// Optional custom headers to include on all API requests (e.g., user_email for Apigee).
    custom_headers: std::collections::HashMap<String, String>,
    /// API request format (OpenAI or Gemini/Vertex AI).
    api_format: ApiFormat,
}

impl OpenAIProvider {
    pub fn new(api_key: String, model: Option<String>, base_url: Option<String>, verify_ssl: bool) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .danger_accept_invalid_certs(!verify_ssl)
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            api_key,
            model: model.unwrap_or_else(default_openai_model),
            base_url: base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            client,
            oauth2: None,
            custom_headers: std::collections::HashMap::new(),
            api_format: ApiFormat::OpenAI,
        })
    }

    /// Create a provider with OAuth2 client_credentials authentication.
    ///
    /// Reuses a process-wide `OAuth2TokenManager` for the given config so the
    /// token cache survives per-request provider construction. Without this,
    /// every chat turn would trigger a brand-new token fetch even though the
    /// previously-issued token is still good for ~30 minutes.
    pub fn with_oauth2(
        model: String,
        base_url: String,
        oauth2_config: super::oauth2::OAuth2Config,
        api_format: ApiFormat,
        verify_ssl: bool,
    ) -> Result<Self, AiError> {
        let custom_headers = oauth2_config.custom_headers.clone();
        let token_manager = super::oauth2::OAuth2TokenManager::get_or_create_shared(oauth2_config);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .danger_accept_invalid_certs(!verify_ssl)
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            api_key: String::new(),
            model,
            base_url,
            client,
            oauth2: Some(token_manager),
            custom_headers,
            api_format,
        })
    }

    /// Create a provider with static API key and specific format.
    pub fn with_format(
        api_key: String,
        model: String,
        base_url: String,
        api_format: ApiFormat,
        verify_ssl: bool,
    ) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .danger_accept_invalid_certs(!verify_ssl)
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            api_key,
            model,
            base_url,
            client,
            oauth2: None,
            custom_headers: std::collections::HashMap::new(),
            api_format,
        })
    }

    /// Get the auth token — from OAuth2 token manager if configured, otherwise static API key.
    async fn get_auth_token(&self) -> Result<String, AiError> {
        if let Some(ref oauth2) = self.oauth2 {
            oauth2.get_token().await.map_err(|e| AiError::RequestFailed(e.to_string()))
        } else {
            Ok(self.api_key.clone())
        }
    }

    /// Build a request with auth headers and custom headers applied.
    /// NOTE: do not set Content-Type here — `.json(&body)` already sets it.
    /// Setting it twice causes reqwest to emit a duplicate Content-Type header,
    /// which Apigee/Vertex rejects with a Pydantic body-validation error.
    fn apply_headers(&self, mut request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
        request = request.header("Authorization", format!("Bearer {}", token));
        for (key, value) in &self.custom_headers {
            request = request.header(key.as_str(), value.as_str());
        }
        request
    }
}

// ============================================================
// Gemini / Vertex AI request/response types
// ============================================================

/// Gemini API request format (Vertex AI / Google AI Studio)
#[derive(Debug, Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig", skip_serializing_if = "Option::is_none")]
    generation_config: Option<GeminiGenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GeminiToolDefinition>>,
}

#[derive(Debug, Serialize)]
struct GeminiContent {
    role: String,
    parts: Vec<GeminiRequestPart>,
}

/// A part in a Gemini request — can be text, function call, or function response
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum GeminiRequestPart {
    Text {
        text: String,
    },
    FunctionCall {
        #[serde(rename = "functionCall")]
        function_call: GeminiFunctionCall,
    },
    FunctionResponse {
        #[serde(rename = "functionResponse")]
        function_response: GeminiFunctionResponse,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GeminiFunctionCall {
    name: String,
    args: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct GeminiFunctionResponse {
    name: String,
    response: serde_json::Value,
}

/// Gemini tool definition (wraps function declarations)
#[derive(Debug, Serialize)]
struct GeminiToolDefinition {
    #[serde(rename = "functionDeclarations")]
    function_declarations: Vec<GeminiFunctionDeclaration>,
}

#[derive(Debug, Serialize)]
struct GeminiFunctionDeclaration {
    name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct GeminiGenerationConfig {
    #[serde(rename = "maxOutputTokens", skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

/// Gemini API response format
#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsageMetadata>,
    error: Option<GeminiError>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiCandidateContent>,
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidateContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

/// A part in a Gemini response — can be text or function call
#[derive(Debug, Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
    #[serde(rename = "functionCall")]
    function_call: Option<GeminiFunctionCall>,
}

#[derive(Debug, Deserialize)]
struct GeminiUsageMetadata {
    #[serde(rename = "promptTokenCount", default)]
    prompt_token_count: u32,
    #[serde(rename = "candidatesTokenCount", default)]
    candidates_token_count: u32,
}

#[derive(Debug, Deserialize)]
struct GeminiError {
    message: String,
    #[serde(default)]
    code: u16,
}

// ============================================================
// OpenAI request/response types
// ============================================================

/// OpenAI API request format
#[derive(Debug, Serialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

/// OpenAI API request format with tools
#[derive(Debug, Serialize)]
struct OpenAIAgentRequest {
    model: String,
    messages: Vec<OpenAIAgentMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<OpenAITool>>,
    /// Set to `true` for the streaming `/chat/completions?stream=true` path.
    /// Reused by every OpenAI-compatible provider (OpenAI, Ollama, OpenRouter,
    /// LiteLLM).
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    /// Asks OpenAI-compatible servers to include `usage` on the final stream
    /// chunk. Without this we don't know token counts after a streaming call.
    /// Most OpenAI-compat servers (Ollama, OpenRouter, LiteLLM) silently
    /// ignore the option if they don't support it.
    #[serde(rename = "stream_options", skip_serializing_if = "Option::is_none")]
    stream_options: Option<OpenAIStreamOptions>,
}

#[derive(Debug, Serialize)]
struct OpenAIStreamOptions {
    include_usage: bool,
}

#[derive(Debug, Serialize)]
struct OpenAIMessage {
    role: String,
    content: String,
}

/// OpenAI message with tool call support
#[derive(Debug, Clone, Serialize)]
struct OpenAIAgentMessage {
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAIToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

/// OpenAI tool definition (converted from Anthropic format)
#[derive(Debug, Clone, Serialize)]
struct OpenAITool {
    #[serde(rename = "type")]
    tool_type: String,
    function: OpenAIFunction,
}

#[derive(Debug, Clone, Serialize)]
struct OpenAIFunction {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<serde_json::Value>,
}

/// OpenAI tool call in response
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpenAIToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: String,
    function: OpenAIFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpenAIFunctionCall {
    name: String,
    arguments: String,
}

/// OpenAI API response format
#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
    #[serde(default)]
    error: Option<OpenAIError>,
}

/// OpenAI token usage
#[derive(Debug, Deserialize)]
struct OpenAIUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: Option<u32>,
}

/// OpenAI API response with tool calls
#[derive(Debug, Deserialize)]
struct OpenAIAgentResponse {
    choices: Vec<OpenAIAgentChoice>,
    #[serde(default)]
    error: Option<OpenAIError>,
    #[serde(default)]
    usage: Option<OpenAIUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: OpenAIResponseMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAIAgentChoice {
    message: OpenAIAgentResponseMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIAgentResponseMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAIToolCall>>,
}

#[derive(Debug, Deserialize)]
struct OpenAIError {
    message: String,
    #[serde(rename = "type")]
    error_type: Option<String>,
}

// ===== OpenAI-compatible streaming chunk types =====
// Used by OpenAI, Ollama (OpenAI-compatible mode), OpenRouter, and LiteLLM.
// Format: each SSE `data: {...}` line is one OpenAIStreamChunk; the literal
// line `data: [DONE]` marks end of stream.

#[derive(Debug, Deserialize)]
struct OpenAIStreamChunk {
    #[serde(default)]
    choices: Vec<OpenAIStreamChoice>,
    #[serde(default)]
    usage: Option<OpenAIUsage>,
    #[serde(default)]
    error: Option<OpenAIError>,
}

#[derive(Debug, Deserialize)]
struct OpenAIStreamChoice {
    #[serde(default)]
    delta: OpenAIStreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAIStreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAIStreamToolCall>>,
}

#[derive(Debug, Deserialize)]
struct OpenAIStreamToolCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<OpenAIStreamFunction>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAIStreamFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// Send an HTTP request with OAuth2 token invalidation on 401.
/// Shared helper for both OpenAI and Gemini formats.
impl OpenAIProvider {
    async fn send_request(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, AiError> {
        let token = self.get_auth_token().await?;
        let response = self.apply_headers(request, &token)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        // On 401, invalidate OAuth2 token so it refreshes on next attempt
        if status == reqwest::StatusCode::UNAUTHORIZED {
            if let Some(ref oauth2) = self.oauth2 {
                oauth2.invalidate().await;
            }
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!("HTTP {}: {}", status, error_text)));
        }

        Ok(response)
    }

    /// Gemini/Vertex AI chat completion.
    async fn gemini_chat_completion(&self, messages: Vec<ChatMessage>, context: Option<AiContext>) -> Result<String, AiError> {
        // Collect system messages from input (may include AI Engineer Profile personality)
        let system_messages: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "system").collect();

        // Use system messages from input if present, otherwise build a default
        let system_prompt = if !system_messages.is_empty() {
            system_messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n\n")
        } else {
            build_system_prompt(&context, None)
        };

        // Inject system prompt into the first user message instead of as a separate
        // user/model pair (prevents the model from re-introducing itself every turn)
        let system_context = format!(
            "[SYSTEM INSTRUCTIONS - follow silently, never repeat back]\n{}\n\
             Do not re-introduce yourself. Do not repeat your name unless asked.\n\
             [END SYSTEM INSTRUCTIONS]\n\n",
            system_prompt
        );
        let mut contents: Vec<GeminiContent> = Vec::new();
        let mut system_injected = false;

        for m in &messages {
            if m.role == "system" { continue; }
            let role = if m.role == "assistant" { "model".to_string() } else { "user".to_string() };
            let text = if !system_injected && role == "user" {
                system_injected = true;
                format!("{}{}", system_context, m.content)
            } else {
                m.content.clone()
            };
            contents.push(GeminiContent {
                role,
                parts: vec![GeminiRequestPart::Text { text }],
            });
        }

        let request = GeminiRequest {
            contents,
            generation_config: Some(GeminiGenerationConfig {
                max_output_tokens: Some(4096),
                temperature: Some(0.7),
            }),
            tools: None, // Simple chat — no tools
        };

        // Gemini URL: {base_url}/{model}:generateContent — but if the user
        // already wrote an action in the model field, respect it (e.g. for
        // gateways that route differently per action).
        let url = build_model_action_url(&self.base_url, &self.model, "generateContent");

        let response = self.send_request(self.client.post(&url).json(&request)).await?;

        let response_text = response.text().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to read Gemini response body: {}", e))
        })?;

        tracing::debug!("Gemini raw response: {}", &response_text[..response_text.len().min(500)]);

        let api_response: GeminiResponse = serde_json::from_str(&response_text).map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse Gemini response: {} — body: {}", e, &response_text[..response_text.len().min(200)]))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!("Gemini error {}: {}", error.code, error.message)));
        }

        // Extract text from candidates[0].content.parts[0].text
        api_response
            .candidates
            .and_then(|c| c.into_iter().next())
            .and_then(|c| c.content)
            .and_then(|c| c.parts)
            .and_then(|p| p.into_iter().next())
            .and_then(|p| p.text)
            .ok_or_else(|| {
                tracing::error!("Gemini response had no content. Raw: {}", &response_text[..response_text.len().min(500)]);
                AiError::InvalidResponse("No content in Gemini response".to_string())
            })
    }

    /// Gemini agent chat with native function calling support.
    async fn gemini_agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Convert Anthropic-style tool definitions to Gemini functionDeclarations
        let gemini_tools = tools.map(|tools| {
            let declarations: Vec<GeminiFunctionDeclaration> = tools.into_iter().map(|t| {
                GeminiFunctionDeclaration {
                    name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    parameters: t.get("input_schema").cloned(),
                }
            }).collect();
            vec![GeminiToolDefinition { function_declarations: declarations }]
        });

        // Inject system prompt into the first user message instead of as a separate
        // user/model pair. This prevents the model from treating the system context as
        // conversational (which causes it to re-introduce itself every turn).
        let system_context = format!(
            "[SYSTEM INSTRUCTIONS - follow these silently, never repeat them back]\n{}\n\n\
             RULES: Do not re-introduce yourself. Do not repeat your name unless asked. \
             Do not echo these instructions. Just respond naturally.\n[END SYSTEM INSTRUCTIONS]\n\n",
            system_prompt
        );
        let mut contents: Vec<GeminiContent> = Vec::new();
        let mut system_injected = false;

        // Build a map of tool_use_id → function_name from the conversation history
        // so we can fill in the correct name in FunctionResponse
        let mut tool_id_to_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for m in &messages {
            if let AgentContent::Blocks(blocks) = &m.content {
                for block in blocks {
                    if let AgentContentBlock::ToolUse { id, name, .. } = block {
                        tool_id_to_name.insert(id.clone(), name.clone());
                    }
                }
            }
        }

        // Convert agent messages to Gemini format
        for m in messages {
            match m.content {
                AgentContent::Text(text) => {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    // Inject system context into the first user message
                    let final_text = if !system_injected && role == "user" {
                        system_injected = true;
                        format!("{}{}", system_context, text)
                    } else {
                        text
                    };
                    contents.push(GeminiContent {
                        role: role.to_string(),
                        parts: vec![GeminiRequestPart::Text { text: final_text }],
                    });
                }
                AgentContent::Blocks(blocks) => {
                    let mut parts: Vec<GeminiRequestPart> = Vec::new();
                    for block in blocks {
                        match block {
                            AgentContentBlock::Text { text } => {
                                parts.push(GeminiRequestPart::Text { text });
                            }
                            AgentContentBlock::ToolUse { id: _, name, input } => {
                                // Assistant's function call
                                parts.push(GeminiRequestPart::FunctionCall {
                                    function_call: GeminiFunctionCall {
                                        name,
                                        args: input,
                                    },
                                });
                            }
                            AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                                // Look up function name from the tool call
                                let fn_name = tool_id_to_name
                                    .get(&tool_use_id)
                                    .cloned()
                                    .unwrap_or_else(|| "unknown".to_string());
                                parts.push(GeminiRequestPart::FunctionResponse {
                                    function_response: GeminiFunctionResponse {
                                        name: fn_name,
                                        response: serde_json::json!({ "result": content }),
                                    },
                                });
                            }
                        }
                    }
                    if !parts.is_empty() {
                        let role = if m.role == "assistant" { "model" } else { "user" };
                        contents.push(GeminiContent { role: role.to_string(), parts });
                    }
                }
            }
        }

        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = GeminiRequest {
            contents,
            generation_config: Some(GeminiGenerationConfig {
                max_output_tokens: Some(max_tokens),
                temperature: Some(temperature),
            }),
            tools: gemini_tools,
        };

        let url = build_model_action_url(&self.base_url, &self.model, "generateContent");
        let response = self.send_request(self.client.post(&url).json(&request)).await?;

        let response_text = response.text().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to read Gemini response: {}", e))
        })?;

        tracing::debug!("Gemini agent raw response: {}", &response_text[..response_text.len().min(500)]);

        let api_response: GeminiResponse = serde_json::from_str(&response_text).map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse Gemini response: {} — body: {}", e, &response_text[..response_text.len().min(200)]))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!("Gemini error {}: {}", error.code, error.message)));
        }

        // Extract content blocks from response (text and/or function calls)
        let candidate = api_response.candidates
            .and_then(|c| c.into_iter().next())
            .ok_or_else(|| AiError::InvalidResponse("No candidates in Gemini response".to_string()))?;

        let finish_reason = candidate.finish_reason.clone();
        let mut content: Vec<AgentContentBlock> = Vec::new();

        if let Some(gemini_content) = candidate.content {
            if let Some(parts) = gemini_content.parts {
                for part in parts {
                    if let Some(text) = part.text {
                        if !text.is_empty() {
                            content.push(AgentContentBlock::Text { text });
                        }
                    }
                    if let Some(fc) = part.function_call {
                        content.push(AgentContentBlock::ToolUse {
                            id: format!("call_{}", uuid::Uuid::new_v4()),
                            name: fc.name,
                            input: fc.args,
                        });
                    }
                }
            }
        }

        if content.is_empty() {
            tracing::error!("Gemini agent response had no content. Raw: {}", &response_text[..response_text.len().min(500)]);
            return Err(AiError::InvalidResponse("No content in Gemini agent response".to_string()));
        }

        // Map finish_reason to stop_reason
        // If there are tool calls, don't signal end_turn — the tool loop must continue
        let has_tool_calls = content.iter().any(|c| matches!(c, AgentContentBlock::ToolUse { .. }));
        let stop_reason = finish_reason.map(|r| match r.as_str() {
            "STOP" if has_tool_calls => "tool_use".to_string(),
            "STOP" => "end_turn".to_string(),
            "MAX_TOKENS" => "max_tokens".to_string(),
            _ => r,
        });

        let usage = api_response.usage_metadata.map(|u| TokenUsage {
            input_tokens: u.prompt_token_count,
            output_tokens: u.candidates_token_count,
            total_tokens: Some(u.prompt_token_count + u.candidates_token_count),
        });

        Ok(AgentResponse { content, stop_reason, usage })
    }

    /// Anthropic-on-Vertex chat completion. Uses `:rawPredict` action and the
    /// Anthropic message body schema (model lives in the URL, not the body).
    async fn vertex_anthropic_chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        let system_messages: Vec<&ChatMessage> = messages.iter().filter(|m| m.role == "system").collect();
        let system_prompt = if !system_messages.is_empty() {
            system_messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n\n")
        } else {
            build_system_prompt(&context, None)
        };

        let anthropic_messages: Vec<AnthropicMessage> = messages
            .into_iter()
            .filter(|m| m.role != "system")
            .map(|m| AnthropicMessage {
                role: if m.role == "user" { "user".to_string() } else { "assistant".to_string() },
                content: m.content,
            })
            .collect();

        let request = VertexAnthropicRequest {
            anthropic_version: "vertex-2023-10-16".to_string(),
            max_tokens: 4096,
            system: Some(system_prompt),
            messages: anthropic_messages,
        };

        let url = build_model_action_url(&self.base_url, &self.model, "rawPredict");
        let response = self.send_request(self.client.post(&url).json(&request)).await?;

        let response_text = response.text().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to read Vertex Anthropic response body: {}", e))
        })?;

        let api_response: AnthropicResponse = serde_json::from_str(&response_text).map_err(|e| {
            AiError::InvalidResponse(format!(
                "Failed to parse Vertex Anthropic response: {} — body: {}",
                e,
                &response_text[..response_text.len().min(200)]
            ))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type, error.message
            )));
        }

        api_response
            .content
            .into_iter()
            .find_map(|c| if c.content_type == "text" { c.text } else { None })
            .ok_or_else(|| AiError::InvalidResponse("No text content in Vertex Anthropic response".to_string()))
    }

    /// Anthropic-on-Vertex agent chat with full tool support.
    ///
    /// Wire format mirrors native Anthropic agent calls — same `system`,
    /// `messages` (with content blocks for tool_use/tool_result round-trips),
    /// `tools`, and `max_tokens` fields — except the model goes in the URL
    /// rather than the body, and `anthropic_version: "vertex-2023-10-16"` is
    /// required to pin the contract version.
    ///
    /// Auth and 401-invalidation are handled by `send_request` (OAuth2 bearer
    /// token from GCP IAM, refreshed on demand).
    async fn vertex_anthropic_agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);

        let anthropic_messages: Vec<AnthropicAgentMessage> = messages
            .into_iter()
            .map(|m| {
                let content = match m.content {
                    AgentContent::Text(text) => AnthropicAgentContent::Text(text),
                    AgentContent::Blocks(blocks) => AnthropicAgentContent::Blocks(
                        blocks.into_iter().map(agent_block_to_anthropic_block).collect(),
                    ),
                };
                AnthropicAgentMessage { role: m.role, content }
            })
            .collect();

        let request = VertexAnthropicAgentRequest {
            anthropic_version: "vertex-2023-10-16".to_string(),
            max_tokens,
            system: if system_prompt.is_empty() { None } else { Some(system_prompt) },
            messages: anthropic_messages,
            tools: tools.filter(|t| !t.is_empty()),
            stream: None,
        };

        let url = build_model_action_url(&self.base_url, &self.model, "rawPredict");
        let response = self.send_request(self.client.post(&url).json(&request)).await?;
        let response_text = response.text().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to read Vertex Anthropic agent response: {}", e))
        })?;

        let api_response: AnthropicAgentResponse = serde_json::from_str(&response_text).map_err(|e| {
            AiError::InvalidResponse(format!(
                "Failed to parse Vertex Anthropic agent response: {} — body: {}",
                e,
                &response_text[..response_text.len().min(400)]
            ))
        })?;

        let content: Vec<AgentContentBlock> = api_response
            .content
            .into_iter()
            .map(anthropic_block_to_agent_block)
            .collect();

        let usage = Some(TokenUsage {
            input_tokens: api_response.usage.input_tokens,
            output_tokens: api_response.usage.output_tokens,
            total_tokens: Some(api_response.usage.input_tokens + api_response.usage.output_tokens),
        });

        Ok(AgentResponse {
            content,
            stop_reason: api_response.stop_reason,
            usage,
        })
    }

    /// Anthropic-on-Vertex streaming agent chat. Hits `:streamRawPredict` and
    /// translates the standard Anthropic SSE event stream
    /// (message_start / content_block_start / content_block_delta /
    /// content_block_stop / message_delta / message_stop) into our generic
    /// `StreamEvent` enum so the frontend's existing handler works unchanged.
    fn vertex_anthropic_agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);

        let anthropic_messages: Vec<AnthropicAgentMessage> = messages
            .into_iter()
            .map(|m| {
                let content = match m.content {
                    AgentContent::Text(text) => AnthropicAgentContent::Text(text),
                    AgentContent::Blocks(blocks) => AnthropicAgentContent::Blocks(
                        blocks.into_iter().map(agent_block_to_anthropic_block).collect(),
                    ),
                };
                AnthropicAgentMessage { role: m.role, content }
            })
            .collect();

        let request = VertexAnthropicAgentRequest {
            anthropic_version: "vertex-2023-10-16".to_string(),
            max_tokens,
            system: if system_prompt.is_empty() { None } else { Some(system_prompt) },
            messages: anthropic_messages,
            tools: tools.filter(|t| !t.is_empty()),
            stream: Some(true),
        };

        let url = build_model_action_url(&self.base_url, &self.model, "streamRawPredict");

        Box::pin(async_stream::stream! {
            let response = match self.send_request(self.client.post(&url).json(&request)).await {
                Ok(r) => r,
                Err(e) => {
                    yield Err(e);
                    return;
                }
            };

            use futures::StreamExt;
            let mut byte_stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut input_tokens: u32 = 0;
            let mut output_tokens: u32 = 0;
            let mut stop_reason: Option<String> = None;
            let mut tool_use_indices = std::collections::HashSet::<usize>::new();

            while let Some(chunk_result) = byte_stream.next().await {
                let chunk = match chunk_result {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        yield Err(AiError::RequestFailed(format!("Stream read error: {}", e)));
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() || line.starts_with("event:") || line == ":" {
                        continue;
                    }
                    let Some(data) = line.strip_prefix("data: ") else { continue; };

                    let event: AnthropicStreamEvent = match serde_json::from_str(data) {
                        Ok(e) => e,
                        Err(e) => {
                            tracing::warn!("Vertex Anthropic SSE parse error: {} — data: {}", e, data);
                            continue;
                        }
                    };

                    match event {
                        AnthropicStreamEvent::MessageStart { message } => {
                            if let Some(usage) = message.usage {
                                input_tokens = usage.input_tokens;
                            }
                        }
                        AnthropicStreamEvent::ContentBlockStart { index, content_block } => {
                            match content_block {
                                AnthropicStreamContentBlock::ToolUse { id, name } => {
                                    tool_use_indices.insert(index);
                                    yield Ok(StreamEvent::ToolUseStart { id, name });
                                }
                                AnthropicStreamContentBlock::Text { .. } => {}
                            }
                        }
                        AnthropicStreamEvent::ContentBlockDelta { delta, .. } => {
                            match delta {
                                AnthropicStreamDelta::TextDelta { text } => {
                                    yield Ok(StreamEvent::ContentDelta { text });
                                }
                                AnthropicStreamDelta::InputJsonDelta { partial_json } => {
                                    yield Ok(StreamEvent::ToolInputDelta { delta: partial_json });
                                }
                            }
                        }
                        AnthropicStreamEvent::ContentBlockStop { index } => {
                            if tool_use_indices.remove(&index) {
                                yield Ok(StreamEvent::ToolUseEnd);
                            }
                        }
                        AnthropicStreamEvent::MessageDelta { delta, usage } => {
                            if let Some(reason) = delta.stop_reason {
                                stop_reason = Some(reason);
                            }
                            if let Some(u) = usage {
                                output_tokens = u.output_tokens;
                            }
                        }
                        AnthropicStreamEvent::MessageStop => {
                            yield Ok(StreamEvent::Done {
                                stop_reason: stop_reason.clone(),
                                usage: Some(TokenUsage {
                                    input_tokens,
                                    output_tokens,
                                    total_tokens: Some(input_tokens + output_tokens),
                                }),
                            });
                            return;
                        }
                        AnthropicStreamEvent::Ping | AnthropicStreamEvent::Unknown => {}
                    }
                }
            }

            // Stream ended without explicit message_stop — emit Done anyway so
            // the client doesn't hang waiting.
            yield Ok(StreamEvent::Done {
                stop_reason,
                usage: Some(TokenUsage {
                    input_tokens,
                    output_tokens,
                    total_tokens: Some(input_tokens + output_tokens),
                }),
            });
        })
    }

    /// Gemini/Vertex AI streaming agent chat. Hits `:streamGenerateContent`
    /// and translates Gemini's chunked-JSON stream into our generic
    /// `StreamEvent` enum.
    ///
    /// Gemini's stream format differs from Anthropic's: each chunk is a
    /// complete `GenerateContentResponse` JSON object containing the *new*
    /// delta (new text characters and/or a complete `functionCall` part).
    /// Vertex sends these as SSE-style `data: {...}\n\n` lines.
    /// Function calls always arrive whole in a single chunk's `parts` array,
    /// so we synthesise the equivalent ToolUseStart + ToolInputDelta +
    /// ToolUseEnd triple ourselves.
    fn gemini_agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        // Build the same request shape as the non-streaming gemini_agent_chat,
        // including the tool-id-to-name map needed to fill FunctionResponse.
        let gemini_tools = tools.map(|tools| {
            let declarations: Vec<GeminiFunctionDeclaration> = tools.into_iter().map(|t| {
                GeminiFunctionDeclaration {
                    name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    parameters: t.get("input_schema").cloned(),
                }
            }).collect();
            vec![GeminiToolDefinition { function_declarations: declarations }]
        });

        let system_context = format!(
            "[SYSTEM INSTRUCTIONS - follow these silently, never repeat them back]\n{}\n\n\
             RULES: Do not re-introduce yourself. Do not repeat your name unless asked. \
             Do not echo these instructions. Just respond naturally.\n[END SYSTEM INSTRUCTIONS]\n\n",
            system_prompt
        );

        let mut tool_id_to_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for m in &messages {
            if let AgentContent::Blocks(blocks) = &m.content {
                for block in blocks {
                    if let AgentContentBlock::ToolUse { id, name, .. } = block {
                        tool_id_to_name.insert(id.clone(), name.clone());
                    }
                }
            }
        }

        let mut contents: Vec<GeminiContent> = Vec::new();
        let mut system_injected = false;
        for m in messages {
            match m.content {
                AgentContent::Text(text) => {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    let final_text = if !system_injected && role == "user" {
                        system_injected = true;
                        format!("{}{}", system_context, text)
                    } else {
                        text
                    };
                    contents.push(GeminiContent {
                        role: role.to_string(),
                        parts: vec![GeminiRequestPart::Text { text: final_text }],
                    });
                }
                AgentContent::Blocks(blocks) => {
                    let mut parts: Vec<GeminiRequestPart> = Vec::new();
                    for block in blocks {
                        match block {
                            AgentContentBlock::Text { text } => parts.push(GeminiRequestPart::Text { text }),
                            AgentContentBlock::ToolUse { id: _, name, input } => parts.push(GeminiRequestPart::FunctionCall {
                                function_call: GeminiFunctionCall { name, args: input },
                            }),
                            AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                                let fn_name = tool_id_to_name.get(&tool_use_id).cloned().unwrap_or_else(|| "unknown".to_string());
                                parts.push(GeminiRequestPart::FunctionResponse {
                                    function_response: GeminiFunctionResponse {
                                        name: fn_name,
                                        response: serde_json::json!({ "result": content }),
                                    },
                                });
                            }
                        }
                    }
                    if !parts.is_empty() {
                        let role = if m.role == "assistant" { "model" } else { "user" };
                        contents.push(GeminiContent { role: role.to_string(), parts });
                    }
                }
            }
        }

        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);
        let request = GeminiRequest {
            contents,
            generation_config: Some(GeminiGenerationConfig {
                max_output_tokens: Some(max_tokens),
                temperature: Some(temperature),
            }),
            tools: gemini_tools,
        };

        // Vertex requires `?alt=sse` on streamGenerateContent for SSE framing;
        // without it the response is a streamed JSON array which is harder to
        // parse incrementally. The action also belongs in the URL (model can
        // already include a `:streamGenerateContent` suffix via build_model_action_url).
        let base_action_url = build_model_action_url(&self.base_url, &self.model, "streamGenerateContent");
        let url = if base_action_url.contains('?') {
            format!("{}&alt=sse", base_action_url)
        } else {
            format!("{}?alt=sse", base_action_url)
        };

        Box::pin(async_stream::stream! {
            let response = match self.send_request(self.client.post(&url).json(&request)).await {
                Ok(r) => r,
                Err(e) => {
                    yield Err(e);
                    return;
                }
            };

            use futures::StreamExt;
            let mut byte_stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut input_tokens: u32 = 0;
            let mut output_tokens: u32 = 0;
            let mut stop_reason: Option<String> = None;
            let mut had_tool_use = false;

            while let Some(chunk_result) = byte_stream.next().await {
                let chunk = match chunk_result {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        yield Err(AiError::RequestFailed(format!("Stream read error: {}", e)));
                        return;
                    }
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() || line.starts_with("event:") || line == ":" {
                        continue;
                    }
                    let Some(data) = line.strip_prefix("data: ") else { continue; };

                    let chunk_resp: GeminiResponse = match serde_json::from_str(data) {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!("Vertex Gemini SSE parse error: {} — data: {}", e, &data[..data.len().min(200)]);
                            continue;
                        }
                    };

                    if let Some(error) = chunk_resp.error {
                        yield Err(AiError::RequestFailed(format!("Gemini error {}: {}", error.code, error.message)));
                        return;
                    }

                    if let Some(usage) = chunk_resp.usage_metadata {
                        input_tokens = usage.prompt_token_count;
                        output_tokens = usage.candidates_token_count;
                    }

                    let candidate = match chunk_resp.candidates.and_then(|c| c.into_iter().next()) {
                        Some(c) => c,
                        None => continue,
                    };

                    if let Some(reason) = candidate.finish_reason.clone() {
                        stop_reason = Some(reason);
                    }

                    let parts = match candidate.content.and_then(|c| c.parts) {
                        Some(p) => p,
                        None => continue,
                    };

                    for part in parts {
                        if let Some(text) = part.text {
                            if !text.is_empty() {
                                yield Ok(StreamEvent::ContentDelta { text });
                            }
                        }
                        if let Some(fc) = part.function_call {
                            had_tool_use = true;
                            let id = format!("call_{}", uuid::Uuid::new_v4());
                            yield Ok(StreamEvent::ToolUseStart { id, name: fc.name });
                            yield Ok(StreamEvent::ToolInputDelta {
                                delta: serde_json::to_string(&fc.args).unwrap_or_else(|_| "{}".to_string()),
                            });
                            yield Ok(StreamEvent::ToolUseEnd);
                        }
                    }
                }
            }

            // Map Gemini's finish_reason to our generic stop_reason vocabulary
            // (matches non-streaming gemini_agent_chat for consistency).
            let mapped_reason = stop_reason.map(|r| match r.as_str() {
                "STOP" if had_tool_use => "tool_use".to_string(),
                "STOP" => "end_turn".to_string(),
                "MAX_TOKENS" => "max_tokens".to_string(),
                _ => r,
            });

            yield Ok(StreamEvent::Done {
                stop_reason: mapped_reason,
                usage: Some(TokenUsage {
                    input_tokens,
                    output_tokens,
                    total_tokens: Some(input_tokens + output_tokens),
                }),
            });
        })
    }

    /// Native streaming for plain OpenAI `/chat/completions?stream=true`.
    /// Reuses the shared OpenAI-compat stream parser (same one used by Ollama,
    /// OpenRouter, and LiteLLM — they all speak this wire format).
    fn openai_agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenAIAgentRequest {
            model: self.model.clone(),
            messages: agent_messages_to_openai_compat(system_prompt, messages),
            max_tokens,
            temperature: Some(temperature),
            tools: anthropic_tools_to_openai(tools),
            stream: Some(true),
            stream_options: Some(OpenAIStreamOptions { include_usage: true }),
        };

        let url = format!("{}/chat/completions", self.base_url);

        Box::pin(async_stream::stream! {
            let response = match self.send_request(self.client.post(&url).json(&request)).await {
                Ok(r) => r,
                Err(e) => {
                    yield Err(e);
                    return;
                }
            };
            let mut inner = parse_openai_compatible_stream(response);
            use futures::StreamExt;
            while let Some(event) = inner.next().await {
                yield event;
            }
        })
    }
}

/// Translate one of our generic agent content blocks into the wire-format
/// content block used by both native Anthropic and Anthropic-on-Vertex.
fn agent_block_to_anthropic_block(b: AgentContentBlock) -> ContentBlock {
    match b {
        AgentContentBlock::Text { text } => ContentBlock::Text { text },
        AgentContentBlock::ToolUse { id, name, input } => ContentBlock::ToolUse { id, name, input },
        AgentContentBlock::ToolResult { tool_use_id, content, is_error } => ContentBlock::ToolResult { tool_use_id, content, is_error },
    }
}

/// Inverse of `agent_block_to_anthropic_block` — used when turning an
/// Anthropic API response into our generic `AgentResponse`.
fn anthropic_block_to_agent_block(b: ContentBlock) -> AgentContentBlock {
    match b {
        ContentBlock::Text { text } => AgentContentBlock::Text { text },
        ContentBlock::ToolUse { id, name, input } => AgentContentBlock::ToolUse { id, name, input },
        ContentBlock::ToolResult { tool_use_id, content, is_error } => AgentContentBlock::ToolResult { tool_use_id, content, is_error },
    }
}

/// Convert generic agent messages into OpenAI-compatible chat-completion
/// messages. Honours the system prompt by prepending it as a system message.
/// Tool round-trips: ToolUse → assistant message with `tool_calls`, ToolResult
/// → message with `role: "tool"` and `tool_call_id`. Shared by every provider
/// that speaks OpenAI's chat completions message format (OpenAI, Ollama,
/// OpenRouter, LiteLLM) — used both for non-streaming and streaming paths.
fn agent_messages_to_openai_compat(
    system_prompt: String,
    messages: Vec<AgentMessage>,
) -> Vec<OpenAIAgentMessage> {
    let mut out: Vec<OpenAIAgentMessage> = Vec::with_capacity(messages.len() + 1);
    if !system_prompt.is_empty() {
        out.push(OpenAIAgentMessage {
            role: "system".to_string(),
            content: Some(system_prompt),
            tool_calls: None,
            tool_call_id: None,
        });
    }
    for m in messages {
        match m.content {
            AgentContent::Text(text) => {
                out.push(OpenAIAgentMessage {
                    role: m.role,
                    content: Some(text),
                    tool_calls: None,
                    tool_call_id: None,
                });
            }
            AgentContent::Blocks(blocks) => {
                for block in blocks {
                    match block {
                        AgentContentBlock::Text { text } => {
                            out.push(OpenAIAgentMessage {
                                role: m.role.clone(),
                                content: Some(text),
                                tool_calls: None,
                                tool_call_id: None,
                            });
                        }
                        AgentContentBlock::ToolUse { id, name, input } => {
                            out.push(OpenAIAgentMessage {
                                role: "assistant".to_string(),
                                content: None,
                                tool_calls: Some(vec![OpenAIToolCall {
                                    id,
                                    call_type: "function".to_string(),
                                    function: OpenAIFunctionCall {
                                        name,
                                        arguments: serde_json::to_string(&input).unwrap_or_default(),
                                    },
                                }]),
                                tool_call_id: None,
                            });
                        }
                        AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                            out.push(OpenAIAgentMessage {
                                role: "tool".to_string(),
                                content: Some(content),
                                tool_calls: None,
                                tool_call_id: Some(tool_use_id),
                            });
                        }
                    }
                }
            }
        }
    }
    out
}

/// Convert an Anthropic-style tool definition (the canonical wire shape we use
/// internally) into an OpenAI-compatible function tool definition. Used by
/// OpenAI, Ollama, OpenRouter, and LiteLLM — which all speak OpenAI's chat
/// completions tool format.
fn anthropic_tools_to_openai(tools: Option<Vec<serde_json::Value>>) -> Option<Vec<OpenAITool>> {
    tools.map(|tools| {
        tools.into_iter().map(|t| {
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let description = t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
            let parameters = t.get("input_schema").cloned();
            OpenAITool {
                tool_type: "function".to_string(),
                function: OpenAIFunction { name, description, parameters },
            }
        }).collect()
    })
}

/// Parse an OpenAI-compatible SSE chat-completions stream into our generic
/// `StreamEvent` enum. Used by every provider that speaks OpenAI's chat
/// completions wire format (OpenAI, Ollama in OpenAI-compat mode, OpenRouter,
/// LiteLLM).
///
/// OpenAI streaming differs from Anthropic in two important ways:
///
/// 1. Tool calls have no explicit "block stop" event mid-stream. The first
///    chunk for a tool call carries `id` + `function.name`; subsequent chunks
///    for the same `index` carry incremental `function.arguments` strings.
///    We have to detect "this is a new tool call" by tracking which indices
///    we've already seen, and we have to emit `ToolUseEnd` either when a new
///    tool-call index appears OR when the message finishes.
///
/// 2. Token usage is only present on the final chunk if the request includes
///    `stream_options: { include_usage: true }`. Callers should set that.
///
/// The literal line `data: [DONE]` marks end of stream.
fn parse_openai_compatible_stream(
    response: reqwest::Response,
) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send>> {
    Box::pin(async_stream::stream! {
        use futures::StreamExt;
        let mut byte_stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut input_tokens: u32 = 0;
        let mut output_tokens: u32 = 0;
        let mut stop_reason: Option<String> = None;
        // Tool calls in flight, keyed by their `index` field. Value is whether
        // we've already emitted ToolUseStart for that index (so we know to emit
        // ToolUseEnd before starting a new one or before ending the stream).
        let mut active_tool_index: Option<usize> = None;

        while let Some(chunk_result) = byte_stream.next().await {
            let chunk = match chunk_result {
                Ok(bytes) => bytes,
                Err(e) => {
                    yield Err(AiError::RequestFailed(format!("Stream read error: {}", e)));
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with("event:") || line == ":" {
                    continue;
                }
                let Some(data) = line.strip_prefix("data: ") else { continue; };

                // OpenAI marks end of stream with the literal "[DONE]" sentinel.
                if data.trim() == "[DONE]" {
                    if active_tool_index.take().is_some() {
                        yield Ok(StreamEvent::ToolUseEnd);
                    }
                    yield Ok(StreamEvent::Done {
                        stop_reason,
                        usage: Some(TokenUsage {
                            input_tokens,
                            output_tokens,
                            total_tokens: Some(input_tokens + output_tokens),
                        }),
                    });
                    return;
                }

                let chunk_resp: OpenAIStreamChunk = match serde_json::from_str(data) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!("OpenAI-compat SSE parse error: {} — data: {}", e, &data[..data.len().min(200)]);
                        continue;
                    }
                };

                if let Some(error) = chunk_resp.error {
                    yield Err(AiError::RequestFailed(format!(
                        "{}: {}",
                        error.error_type.unwrap_or_else(|| "error".to_string()),
                        error.message
                    )));
                    return;
                }

                if let Some(usage) = chunk_resp.usage {
                    input_tokens = usage.prompt_tokens;
                    output_tokens = usage.completion_tokens;
                }

                let Some(choice) = chunk_resp.choices.into_iter().next() else { continue; };

                if let Some(text) = choice.delta.content {
                    if !text.is_empty() {
                        // If a tool call was open, close it before emitting text.
                        if active_tool_index.take().is_some() {
                            yield Ok(StreamEvent::ToolUseEnd);
                        }
                        yield Ok(StreamEvent::ContentDelta { text });
                    }
                }

                if let Some(tool_calls) = choice.delta.tool_calls {
                    for tc in tool_calls {
                        // A new tool call starts when we see an index different
                        // from the currently-active one AND we have a name + id.
                        let starts_new = active_tool_index != Some(tc.index)
                            && tc.id.is_some()
                            && tc.function.as_ref().and_then(|f| f.name.as_ref()).is_some();

                        if starts_new {
                            if active_tool_index.take().is_some() {
                                yield Ok(StreamEvent::ToolUseEnd);
                            }
                            let id = tc.id.clone().unwrap_or_default();
                            let name = tc.function.as_ref()
                                .and_then(|f| f.name.clone())
                                .unwrap_or_default();
                            active_tool_index = Some(tc.index);
                            yield Ok(StreamEvent::ToolUseStart { id, name });
                        }

                        // Stream the incremental arguments JSON if present.
                        if let Some(func) = tc.function {
                            if let Some(args) = func.arguments {
                                if !args.is_empty() {
                                    yield Ok(StreamEvent::ToolInputDelta { delta: args });
                                }
                            }
                        }
                    }
                }

                if let Some(reason) = choice.finish_reason {
                    if active_tool_index.take().is_some() {
                        yield Ok(StreamEvent::ToolUseEnd);
                    }
                    // Map OpenAI finish_reason to our generic vocabulary —
                    // matches what the non-streaming OpenAI agent_chat path uses.
                    stop_reason = Some(match reason.as_str() {
                        "tool_calls" | "function_call" => "tool_use".to_string(),
                        "stop" => "end_turn".to_string(),
                        "length" => "max_tokens".to_string(),
                        _ => reason,
                    });
                }
            }
        }

        // Stream ended without an explicit [DONE] sentinel — emit Done so the
        // client doesn't hang.
        if active_tool_index.take().is_some() {
            yield Ok(StreamEvent::ToolUseEnd);
        }
        yield Ok(StreamEvent::Done {
            stop_reason,
            usage: Some(TokenUsage {
                input_tokens,
                output_tokens,
                total_tokens: Some(input_tokens + output_tokens),
            }),
        });
    })
}

#[async_trait]
impl AiProvider for OpenAIProvider {
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        // Dispatch to per-format request builder when applicable.
        if self.api_format == ApiFormat::Gemini {
            return self.gemini_chat_completion(messages, context).await;
        }
        if self.api_format == ApiFormat::VertexAnthropic {
            return self.vertex_anthropic_chat_completion(messages, context).await;
        }

        // Build system prompt with enhanced context
        let system_prompt = build_system_prompt(&context, None);

        // Convert messages to OpenAI format
        let mut openai_messages: Vec<OpenAIMessage> = vec![OpenAIMessage {
            role: "system".to_string(),
            content: system_prompt,
        }];

        for m in messages {
            if m.role != "system" {
                openai_messages.push(OpenAIMessage {
                    role: m.role,
                    content: m.content,
                });
            }
        }

        let request = OpenAIRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens: 4096,
            temperature: Some(0.7),
        };

        let url = format!("{}/chat/completions", self.base_url);

        let response = self.send_request(self.client.post(&url).json(&request)).await?;

        let api_response: OpenAIResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Extract text from response
        api_response
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| AiError::InvalidResponse("No content in response".to_string()))
    }

    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Gemini format: native function calling support
        if self.api_format == ApiFormat::Gemini {
            return self.gemini_agent_chat(system_prompt, messages, tools, options).await;
        }
        // Vertex Anthropic: full tool support via dedicated agent path.
        if self.api_format == ApiFormat::VertexAnthropic {
            return self.vertex_anthropic_agent_chat(system_prompt, messages, tools, options).await;
        }

        // Convert Anthropic-style tools to OpenAI format
        let openai_tools: Option<Vec<OpenAITool>> = tools.map(|tools| {
            tools.into_iter().map(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let description = t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                let parameters = t.get("input_schema").cloned();
                OpenAITool {
                    tool_type: "function".to_string(),
                    function: OpenAIFunction { name, description, parameters },
                }
            }).collect()
        });

        // Convert generic messages to OpenAI format
        let mut openai_messages: Vec<OpenAIAgentMessage> = vec![OpenAIAgentMessage {
            role: "system".to_string(),
            content: Some(system_prompt),
            tool_calls: None,
            tool_call_id: None,
        }];

        for m in messages {
            match m.content {
                AgentContent::Text(text) => {
                    openai_messages.push(OpenAIAgentMessage {
                        role: m.role,
                        content: Some(text),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                AgentContent::Blocks(blocks) => {
                    // Handle tool results - each becomes a separate message
                    for block in blocks {
                        match block {
                            AgentContentBlock::Text { text } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: m.role.clone(),
                                    content: Some(text),
                                    tool_calls: None,
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolUse { id, name, input } => {
                                // This is assistant message with tool call
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "assistant".to_string(),
                                    content: None,
                                    tool_calls: Some(vec![OpenAIToolCall {
                                        id,
                                        call_type: "function".to_string(),
                                        function: OpenAIFunctionCall {
                                            name,
                                            arguments: serde_json::to_string(&input).unwrap_or_default(),
                                        },
                                    }]),
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "tool".to_string(),
                                    content: Some(content),
                                    tool_calls: None,
                                    tool_call_id: Some(tool_use_id),
                                });
                            }
                        }
                    }
                }
            }
        }

        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenAIAgentRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens,
            temperature: Some(temperature),
            tools: openai_tools,
            stream: None,
            stream_options: None,
        };

        let url = format!("{}/chat/completions", self.base_url);

        let response = self.send_request(self.client.post(&url).json(&request)).await?;

        let api_response: OpenAIAgentResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Convert OpenAI response to generic format
        let choice = api_response.choices.into_iter().next()
            .ok_or_else(|| AiError::InvalidResponse("No choices in response".to_string()))?;

        let mut content: Vec<AgentContentBlock> = Vec::new();

        // Add text content if present
        if let Some(text) = choice.message.content {
            if !text.is_empty() {
                content.push(AgentContentBlock::Text { text });
            }
        }

        // Convert tool calls to tool_use blocks
        if let Some(tool_calls) = choice.message.tool_calls {
            for tc in tool_calls {
                let input: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                content.push(AgentContentBlock::ToolUse {
                    id: tc.id,
                    name: tc.function.name,
                    input,
                });
            }
        }

        // Map finish_reason to stop_reason
        let stop_reason = choice.finish_reason.map(|r| {
            match r.as_str() {
                "stop" => "end_turn".to_string(),
                "tool_calls" => "tool_use".to_string(),
                other => other.to_string(),
            }
        });

        // Convert OpenAI usage to generic format
        let usage = api_response.usage.map(|u| TokenUsage {
            input_tokens: u.prompt_tokens,
            output_tokens: u.completion_tokens,
            total_tokens: u.total_tokens.or(Some(u.prompt_tokens + u.completion_tokens)),
        });

        Ok(AgentResponse { content, stop_reason, usage })
    }

    /// Override the default trait stream impl so every API format uses its
    /// dedicated streaming endpoint (real progressive SSE) instead of
    /// buffering the whole response in `agent_chat` and synthesising a single
    /// batch of events at the end.
    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        match self.api_format {
            ApiFormat::VertexAnthropic => {
                self.vertex_anthropic_agent_chat_stream(system_prompt, messages, tools, options)
            }
            ApiFormat::Gemini => {
                self.gemini_agent_chat_stream(system_prompt, messages, tools, options)
            }
            ApiFormat::OpenAI => {
                self.openai_agent_chat_stream(system_prompt, messages, tools, options)
            }
        }
    }

    fn provider_name(&self) -> &str {
        "OpenAI"
    }
}

// === Ollama Provider ===

/// Ollama local AI provider (OpenAI-compatible API)
pub struct OllamaProvider {
    model: String,
    base_url: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(model: Option<String>, base_url: Option<String>, verify_ssl: bool) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120)) // Longer timeout for local models
            .danger_accept_invalid_certs(!verify_ssl)
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            model: model.unwrap_or_else(default_ollama_model),
            base_url: base_url.unwrap_or_else(default_ollama_url),
            client,
        })
    }
}

#[async_trait]
impl AiProvider for OllamaProvider {
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        // Build system prompt with enhanced context
        let system_prompt = build_system_prompt(&context, None);

        // Convert messages to OpenAI format (Ollama uses OpenAI-compatible API)
        let mut openai_messages: Vec<OpenAIMessage> = vec![OpenAIMessage {
            role: "system".to_string(),
            content: system_prompt,
        }];

        for m in messages {
            if m.role != "system" {
                openai_messages.push(OpenAIMessage {
                    role: m.role,
                    content: m.content,
                });
            }
        }

        let request = OpenAIRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens: 4096,
            temperature: Some(0.7),
        };

        // Ollama uses /v1/chat/completions endpoint
        let url = format!("{}/v1/chat/completions", self.base_url);

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            // No auth header for Ollama
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else if e.is_connect() {
                    AiError::NotConfigured(format!(
                        "Cannot connect to Ollama at {}. Is it running? Start with: ollama serve",
                        self.base_url
                    ))
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: OpenAIResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Extract text from response
        api_response
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| AiError::InvalidResponse("No content in response".to_string()))
    }

    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Try with tools first, fall back to simple chat if model doesn't support tools
        let result = self.try_agent_chat_with_tools(&system_prompt, &messages, &tools, &options).await;

        // If tools aren't supported, fall back to simple chat mode
        if let Err(AiError::RequestFailed(ref msg)) = result {
            if msg.contains("does not support tools") {
                tracing::info!("Model {} doesn't support tools, falling back to simple chat", self.model);
                return self.simple_chat_fallback(&system_prompt, &messages).await;
            }
        }

        result
    }

    /// Native streaming via Ollama's OpenAI-compatible `/v1/chat/completions`
    /// endpoint with `stream: true`. Reuses the shared OpenAI-compat parser.
    /// If the model returns a "does not support tools" error on the first
    /// chunk, we retry once without tools (mirrors the non-streaming
    /// `agent_chat` fallback).
    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);
        let openai_messages = agent_messages_to_openai_compat(system_prompt, messages);
        let openai_tools = anthropic_tools_to_openai(tools);

        let url = format!("{}/v1/chat/completions", self.base_url);
        let model = self.model.clone();
        let client = self.client.clone();
        let base_url = self.base_url.clone();

        Box::pin(async_stream::stream! {
            let request = OpenAIAgentRequest {
                model: model.clone(),
                messages: openai_messages.clone(),
                max_tokens,
                temperature: Some(temperature),
                tools: openai_tools.clone(),
                stream: Some(true),
                stream_options: Some(OpenAIStreamOptions { include_usage: true }),
            };

            let mut response = match client.post(&url).json(&request).send().await {
                Ok(r) => r,
                Err(e) => {
                    yield Err(if e.is_timeout() {
                        AiError::Timeout
                    } else if e.is_connect() {
                        AiError::NotConfigured(format!(
                            "Cannot connect to Ollama at {}. Is it running? Start with: ollama serve",
                            base_url
                        ))
                    } else {
                        AiError::RequestFailed(e.to_string())
                    });
                    return;
                }
            };

            // If the model rejected tools, retry once without them so streaming
            // still works on tool-less models (mirrors agent_chat fallback).
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if openai_tools.is_some() && body.contains("does not support tools") {
                    tracing::info!("Ollama model {} doesn't support tools, retrying stream without tools", model);
                    let retry = OpenAIAgentRequest {
                        model,
                        messages: openai_messages,
                        max_tokens,
                        temperature: Some(temperature),
                        tools: None,
                        stream: Some(true),
                        stream_options: Some(OpenAIStreamOptions { include_usage: true }),
                    };
                    response = match client.post(&url).json(&retry).send().await {
                        Ok(r) => r,
                        Err(e) => {
                            yield Err(AiError::RequestFailed(format!("Retry without tools failed: {}", e)));
                            return;
                        }
                    };
                    if !response.status().is_success() {
                        let s = response.status();
                        let b = response.text().await.unwrap_or_default();
                        yield Err(AiError::RequestFailed(format!("HTTP {}: {}", s, b)));
                        return;
                    }
                } else {
                    yield Err(AiError::RequestFailed(format!("HTTP {}: {}", status, body)));
                    return;
                }
            }

            let mut inner = parse_openai_compatible_stream(response);
            use futures::StreamExt;
            while let Some(event) = inner.next().await {
                yield event;
            }
        })
    }

    fn provider_name(&self) -> &str {
        "Ollama"
    }
}

impl OllamaProvider {
    /// Try agent chat with tools (may fail if model doesn't support tools)
    async fn try_agent_chat_with_tools(
        &self,
        system_prompt: &str,
        messages: &[AgentMessage],
        tools: &Option<Vec<serde_json::Value>>,
        options: &Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Convert Anthropic-style tools to OpenAI format (Ollama uses OpenAI-compatible API)
        let openai_tools: Option<Vec<OpenAITool>> = tools.as_ref().map(|tools| {
            tools.iter().map(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let description = t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                let parameters = t.get("input_schema").cloned();
                OpenAITool {
                    tool_type: "function".to_string(),
                    function: OpenAIFunction { name, description, parameters },
                }
            }).collect()
        });

        // Convert generic messages to OpenAI format
        let mut openai_messages: Vec<OpenAIAgentMessage> = vec![OpenAIAgentMessage {
            role: "system".to_string(),
            content: Some(system_prompt.to_string()),
            tool_calls: None,
            tool_call_id: None,
        }];

        for m in messages {
            match &m.content {
                AgentContent::Text(text) => {
                    openai_messages.push(OpenAIAgentMessage {
                        role: m.role.clone(),
                        content: Some(text.clone()),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                AgentContent::Blocks(blocks) => {
                    for block in blocks {
                        match block {
                            AgentContentBlock::Text { text } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: m.role.clone(),
                                    content: Some(text.clone()),
                                    tool_calls: None,
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolUse { id, name, input } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "assistant".to_string(),
                                    content: None,
                                    tool_calls: Some(vec![OpenAIToolCall {
                                        id: id.clone(),
                                        call_type: "function".to_string(),
                                        function: OpenAIFunctionCall {
                                            name: name.clone(),
                                            arguments: serde_json::to_string(&input).unwrap_or_default(),
                                        },
                                    }]),
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "tool".to_string(),
                                    content: Some(content.clone()),
                                    tool_calls: None,
                                    tool_call_id: Some(tool_use_id.clone()),
                                });
                            }
                        }
                    }
                }
            }
        }

        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenAIAgentRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens,
            temperature: Some(temperature),
            tools: openai_tools,
            stream: None,
            stream_options: None,
        };

        let url = format!("{}/v1/chat/completions", self.base_url);

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            // No auth header for Ollama
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else if e.is_connect() {
                    AiError::NotConfigured(format!(
                        "Cannot connect to Ollama at {}. Is it running? Start with: ollama serve",
                        self.base_url
                    ))
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: OpenAIAgentResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Convert OpenAI response to generic format
        let choice = api_response.choices.into_iter().next()
            .ok_or_else(|| AiError::InvalidResponse("No choices in response".to_string()))?;

        let mut content: Vec<AgentContentBlock> = Vec::new();

        if let Some(text) = choice.message.content {
            if !text.is_empty() {
                content.push(AgentContentBlock::Text { text });
            }
        }

        if let Some(tool_calls) = choice.message.tool_calls {
            for tc in tool_calls {
                let input: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                content.push(AgentContentBlock::ToolUse {
                    id: tc.id,
                    name: tc.function.name,
                    input,
                });
            }
        }

        let stop_reason = choice.finish_reason.map(|r| {
            match r.as_str() {
                "stop" => "end_turn".to_string(),
                "tool_calls" => "tool_use".to_string(),
                other => other.to_string(),
            }
        });

        // Convert Ollama usage to generic format (uses OpenAI-compatible API)
        let usage = api_response.usage.map(|u| TokenUsage {
            input_tokens: u.prompt_tokens,
            output_tokens: u.completion_tokens,
            total_tokens: u.total_tokens.or(Some(u.prompt_tokens + u.completion_tokens)),
        });

        Ok(AgentResponse { content, stop_reason, usage })
    }

    /// Fallback to simple chat without tools when model doesn't support function calling
    async fn simple_chat_fallback(
        &self,
        system_prompt: &str,
        messages: &[AgentMessage],
    ) -> Result<AgentResponse, AiError> {
        // Build simple chat messages
        let mut chat_messages: Vec<ChatMessage> = vec![ChatMessage {
            role: "system".to_string(),
            content: format!(
                "{}\n\nNote: This model does not support tool use, so I cannot run commands or interact with sessions directly. I'll provide guidance and recommendations instead.",
                system_prompt
            ),
        }];

        // Convert agent messages to simple chat messages
        for m in messages {
            match &m.content {
                AgentContent::Text(text) => {
                    chat_messages.push(ChatMessage {
                        role: m.role.clone(),
                        content: text.clone(),
                    });
                }
                AgentContent::Blocks(blocks) => {
                    // Extract just the text content from blocks
                    for block in blocks {
                        if let AgentContentBlock::Text { text } = block {
                            chat_messages.push(ChatMessage {
                                role: m.role.clone(),
                                content: text.clone(),
                            });
                        }
                    }
                }
            }
        }

        // Use simple chat completion
        // Note: Simple chat fallback doesn't track usage since chat_completion doesn't return it
        let response_text = self.chat_completion(chat_messages, None).await?;

        Ok(AgentResponse {
            content: vec![AgentContentBlock::Text { text: response_text }],
            stop_reason: Some("end_turn".to_string()),
            usage: None,
        })
    }
}

// === OpenRouter Provider ===

/// OpenRouter API request format (with transforms support)
#[derive(Debug, Serialize)]
struct OpenRouterRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    /// Transforms to apply (e.g., "middle-out" for automatic prompt compression)
    #[serde(skip_serializing_if = "Option::is_none")]
    transforms: Option<Vec<String>>,
}

/// OpenRouter API request format with tools (with transforms support)
#[derive(Debug, Serialize)]
struct OpenRouterAgentRequest {
    model: String,
    messages: Vec<OpenAIAgentMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<OpenAITool>>,
    /// Transforms to apply (e.g., "middle-out" for automatic prompt compression)
    #[serde(skip_serializing_if = "Option::is_none")]
    transforms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(rename = "stream_options", skip_serializing_if = "Option::is_none")]
    stream_options: Option<OpenAIStreamOptions>,
}

/// OpenRouter API provider (OpenAI-compatible at openrouter.ai)
pub struct OpenRouterProvider {
    api_key: String,
    model: String,
    client: reqwest::Client,
}

impl OpenRouterProvider {
    pub fn new(api_key: String, model: Option<String>) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            api_key,
            model: model.unwrap_or_else(default_openrouter_model),
            client,
        })
    }
}

#[async_trait]
impl AiProvider for OpenRouterProvider {
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        // Build system prompt with enhanced context
        let system_prompt = build_system_prompt(&context, None);

        // Convert messages to OpenAI format (OpenRouter uses OpenAI-compatible API)
        let mut openai_messages: Vec<OpenAIMessage> = vec![OpenAIMessage {
            role: "system".to_string(),
            content: system_prompt,
        }];

        for m in messages {
            if m.role != "system" {
                openai_messages.push(OpenAIMessage {
                    role: m.role,
                    content: m.content,
                });
            }
        }

        let request = OpenRouterRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens: 4096,
            temperature: Some(0.7),
            // Enable middle-out transform to automatically compress prompts that exceed context window
            transforms: Some(vec!["middle-out".to_string()]),
        };

        let response = self
            .client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://netstacks.net")
            .header("X-Title", "NetStacks")
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: OpenAIResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Extract text from response
        api_response
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| AiError::InvalidResponse("No content in response".to_string()))
    }

    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Convert Anthropic-style tools to OpenAI format
        let openai_tools: Option<Vec<OpenAITool>> = tools.map(|tools| {
            tools.into_iter().map(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let description = t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                let parameters = t.get("input_schema").cloned();
                OpenAITool {
                    tool_type: "function".to_string(),
                    function: OpenAIFunction { name, description, parameters },
                }
            }).collect()
        });

        // Convert generic messages to OpenAI format
        let mut openai_messages: Vec<OpenAIAgentMessage> = vec![OpenAIAgentMessage {
            role: "system".to_string(),
            content: Some(system_prompt),
            tool_calls: None,
            tool_call_id: None,
        }];

        for m in messages {
            match m.content {
                AgentContent::Text(text) => {
                    openai_messages.push(OpenAIAgentMessage {
                        role: m.role,
                        content: Some(text),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                AgentContent::Blocks(blocks) => {
                    for block in blocks {
                        match block {
                            AgentContentBlock::Text { text } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: m.role.clone(),
                                    content: Some(text),
                                    tool_calls: None,
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolUse { id, name, input } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "assistant".to_string(),
                                    content: None,
                                    tool_calls: Some(vec![OpenAIToolCall {
                                        id,
                                        call_type: "function".to_string(),
                                        function: OpenAIFunctionCall {
                                            name,
                                            arguments: serde_json::to_string(&input).unwrap_or_default(),
                                        },
                                    }]),
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "tool".to_string(),
                                    content: Some(content),
                                    tool_calls: None,
                                    tool_call_id: Some(tool_use_id),
                                });
                            }
                        }
                    }
                }
            }
        }

        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenRouterAgentRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens,
            temperature: Some(temperature),
            tools: openai_tools,
            // Enable middle-out transform to automatically compress prompts that exceed context window
            transforms: Some(vec!["middle-out".to_string()]),
            stream: None,
            stream_options: None,
        };

        let response = self
            .client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://netstacks.net")
            .header("X-Title", "NetStacks")
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: OpenAIAgentResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Convert OpenAI response to generic format
        let choice = api_response.choices.into_iter().next()
            .ok_or_else(|| AiError::InvalidResponse("No choices in response".to_string()))?;

        let mut content: Vec<AgentContentBlock> = Vec::new();

        if let Some(text) = choice.message.content {
            if !text.is_empty() {
                content.push(AgentContentBlock::Text { text });
            }
        }

        if let Some(tool_calls) = choice.message.tool_calls {
            for tc in tool_calls {
                let input: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                content.push(AgentContentBlock::ToolUse {
                    id: tc.id,
                    name: tc.function.name,
                    input,
                });
            }
        }

        let stop_reason = choice.finish_reason.map(|r| {
            match r.as_str() {
                "stop" => "end_turn".to_string(),
                "tool_calls" => "tool_use".to_string(),
                other => other.to_string(),
            }
        });

        let usage = api_response.usage.map(|u| TokenUsage {
            input_tokens: u.prompt_tokens,
            output_tokens: u.completion_tokens,
            total_tokens: u.total_tokens.or(Some(u.prompt_tokens + u.completion_tokens)),
        });

        Ok(AgentResponse { content, stop_reason, usage })
    }

    /// Native streaming via OpenRouter's OpenAI-compatible chat completions
    /// endpoint with `stream: true`. Reuses the shared OpenAI-compat parser.
    /// Bearer auth + the same NetStacks-identifying headers as `agent_chat`.
    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenRouterAgentRequest {
            model: self.model.clone(),
            messages: agent_messages_to_openai_compat(system_prompt, messages),
            max_tokens,
            temperature: Some(temperature),
            tools: anthropic_tools_to_openai(tools),
            transforms: Some(vec!["middle-out".to_string()]),
            stream: Some(true),
            stream_options: Some(OpenAIStreamOptions { include_usage: true }),
        };

        let api_key = self.api_key.clone();
        let client = self.client.clone();

        Box::pin(async_stream::stream! {
            let response = match client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .header("HTTP-Referer", "https://netstacks.net")
                .header("X-Title", "NetStacks")
                .json(&request)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    yield Err(if e.is_timeout() {
                        AiError::Timeout
                    } else {
                        AiError::RequestFailed(e.to_string())
                    });
                    return;
                }
            };

            let status = response.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                yield Err(AiError::RateLimited);
                return;
            }
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                yield Err(AiError::RequestFailed(format!("HTTP {}: {}", status, body)));
                return;
            }

            let mut inner = parse_openai_compatible_stream(response);
            use futures::StreamExt;
            while let Some(event) = inner.next().await {
                yield event;
            }
        })
    }

    fn provider_name(&self) -> &str {
        "OpenRouter"
    }
}

// === LiteLLM Provider ===

/// LiteLLM proxy provider (OpenAI-compatible local proxy)
pub struct LiteLLMProvider {
    model: String,
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl LiteLLMProvider {
    pub fn new(model: Option<String>, base_url: Option<String>, api_key: Option<String>, verify_ssl: bool) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120)) // Longer timeout for proxied requests
            .danger_accept_invalid_certs(!verify_ssl)
            .build()
            .map_err(|e| AiError::NotConfigured(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            model: model.unwrap_or_else(default_litellm_model),
            base_url: base_url.unwrap_or_else(default_litellm_url),
            api_key,
            client,
        })
    }
}

#[async_trait]
impl AiProvider for LiteLLMProvider {
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        // Build system prompt with enhanced context
        let system_prompt = build_system_prompt(&context, None);

        // Convert messages to OpenAI format
        let mut openai_messages: Vec<OpenAIMessage> = vec![OpenAIMessage {
            role: "system".to_string(),
            content: system_prompt,
        }];

        for m in messages {
            if m.role != "system" {
                openai_messages.push(OpenAIMessage {
                    role: m.role,
                    content: m.content,
                });
            }
        }

        let request = OpenAIRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens: 4096,
            temperature: Some(0.7),
        };

        let url = format!("{}/chat/completions", self.base_url);

        let mut req_builder = self
            .client
            .post(&url)
            .header("Content-Type", "application/json");

        // Add auth header if API key is provided
        if let Some(ref key) = self.api_key {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", key));
        }

        let response = req_builder
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else if e.is_connect() {
                    AiError::NotConfigured(format!(
                        "Cannot connect to LiteLLM at {}. Is it running? Start with: litellm --model gpt-4o",
                        self.base_url
                    ))
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: OpenAIResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Extract text from response
        api_response
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .ok_or_else(|| AiError::InvalidResponse("No content in response".to_string()))
    }

    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Convert Anthropic-style tools to OpenAI format
        let openai_tools: Option<Vec<OpenAITool>> = tools.map(|tools| {
            tools.into_iter().map(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let description = t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                let parameters = t.get("input_schema").cloned();
                OpenAITool {
                    tool_type: "function".to_string(),
                    function: OpenAIFunction { name, description, parameters },
                }
            }).collect()
        });

        // Convert generic messages to OpenAI format
        let mut openai_messages: Vec<OpenAIAgentMessage> = vec![OpenAIAgentMessage {
            role: "system".to_string(),
            content: Some(system_prompt),
            tool_calls: None,
            tool_call_id: None,
        }];

        for m in messages {
            match m.content {
                AgentContent::Text(text) => {
                    openai_messages.push(OpenAIAgentMessage {
                        role: m.role,
                        content: Some(text),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                AgentContent::Blocks(blocks) => {
                    for block in blocks {
                        match block {
                            AgentContentBlock::Text { text } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: m.role.clone(),
                                    content: Some(text),
                                    tool_calls: None,
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolUse { id, name, input } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "assistant".to_string(),
                                    content: None,
                                    tool_calls: Some(vec![OpenAIToolCall {
                                        id,
                                        call_type: "function".to_string(),
                                        function: OpenAIFunctionCall {
                                            name,
                                            arguments: serde_json::to_string(&input).unwrap_or_default(),
                                        },
                                    }]),
                                    tool_call_id: None,
                                });
                            }
                            AgentContentBlock::ToolResult { tool_use_id, content, .. } => {
                                openai_messages.push(OpenAIAgentMessage {
                                    role: "tool".to_string(),
                                    content: Some(content),
                                    tool_calls: None,
                                    tool_call_id: Some(tool_use_id),
                                });
                            }
                        }
                    }
                }
            }
        }

        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenAIAgentRequest {
            model: self.model.clone(),
            messages: openai_messages,
            max_tokens,
            temperature: Some(temperature),
            tools: openai_tools,
            stream: None,
            stream_options: None,
        };

        let url = format!("{}/chat/completions", self.base_url);

        let mut req_builder = self
            .client
            .post(&url)
            .header("Content-Type", "application/json");

        if let Some(ref key) = self.api_key {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", key));
        }

        let response = req_builder
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    AiError::Timeout
                } else if e.is_connect() {
                    AiError::NotConfigured(format!(
                        "Cannot connect to LiteLLM at {}. Is it running?",
                        self.base_url
                    ))
                } else {
                    AiError::RequestFailed(e.to_string())
                }
            })?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(AiError::RateLimited);
        }

        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AiError::RequestFailed(format!(
                "HTTP {}: {}",
                status, error_text
            )));
        }

        let api_response: OpenAIAgentResponse = response.json().await.map_err(|e| {
            AiError::InvalidResponse(format!("Failed to parse response: {}", e))
        })?;

        if let Some(error) = api_response.error {
            return Err(AiError::RequestFailed(format!(
                "{}: {}",
                error.error_type.unwrap_or_else(|| "error".to_string()),
                error.message
            )));
        }

        // Convert OpenAI response to generic format
        let choice = api_response.choices.into_iter().next()
            .ok_or_else(|| AiError::InvalidResponse("No choices in response".to_string()))?;

        let mut content: Vec<AgentContentBlock> = Vec::new();

        if let Some(text) = choice.message.content {
            if !text.is_empty() {
                content.push(AgentContentBlock::Text { text });
            }
        }

        if let Some(tool_calls) = choice.message.tool_calls {
            for tc in tool_calls {
                let input: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                content.push(AgentContentBlock::ToolUse {
                    id: tc.id,
                    name: tc.function.name,
                    input,
                });
            }
        }

        let stop_reason = choice.finish_reason.map(|r| {
            match r.as_str() {
                "stop" => "end_turn".to_string(),
                "tool_calls" => "tool_use".to_string(),
                other => other.to_string(),
            }
        });

        let usage = api_response.usage.map(|u| TokenUsage {
            input_tokens: u.prompt_tokens,
            output_tokens: u.completion_tokens,
            total_tokens: u.total_tokens.or(Some(u.prompt_tokens + u.completion_tokens)),
        });

        Ok(AgentResponse { content, stop_reason, usage })
    }

    /// Native streaming via LiteLLM's OpenAI-compatible chat completions
    /// endpoint with `stream: true`. Optional Bearer auth — same auth pattern
    /// as the non-streaming `agent_chat`.
    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(4096);
        let temperature = options.as_ref().and_then(|o| o.temperature).map(|t| t as f32).unwrap_or(0.7);

        let request = OpenAIAgentRequest {
            model: self.model.clone(),
            messages: agent_messages_to_openai_compat(system_prompt, messages),
            max_tokens,
            temperature: Some(temperature),
            tools: anthropic_tools_to_openai(tools),
            stream: Some(true),
            stream_options: Some(OpenAIStreamOptions { include_usage: true }),
        };

        let url = format!("{}/chat/completions", self.base_url);
        let api_key = self.api_key.clone();
        let client = self.client.clone();

        Box::pin(async_stream::stream! {
            let mut req_builder = client.post(&url).header("Content-Type", "application/json");
            if let Some(ref key) = api_key {
                req_builder = req_builder.header("Authorization", format!("Bearer {}", key));
            }

            let response = match req_builder.json(&request).send().await {
                Ok(r) => r,
                Err(e) => {
                    yield Err(if e.is_timeout() {
                        AiError::Timeout
                    } else if e.is_connect() {
                        AiError::NotConfigured(format!(
                            "Cannot connect to LiteLLM proxy at {}. Is it running?",
                            url
                        ))
                    } else {
                        AiError::RequestFailed(e.to_string())
                    });
                    return;
                }
            };

            let status = response.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                yield Err(AiError::RateLimited);
                return;
            }
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                yield Err(AiError::RequestFailed(format!("HTTP {}: {}", status, body)));
                return;
            }

            let mut inner = parse_openai_compatible_stream(response);
            use futures::StreamExt;
            while let Some(event) = inner.next().await {
                yield event;
            }
        })
    }

    fn provider_name(&self) -> &str {
        "LiteLLM"
    }
}

// === Mock Provider ===

/// Mock provider for when no API key is configured
pub struct MockProvider;

impl MockProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MockProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AiProvider for MockProvider {
    async fn chat_completion(
        &self,
        _messages: Vec<ChatMessage>,
        _context: Option<AiContext>,
    ) -> Result<String, AiError> {
        Err(AiError::NotConfigured(
            "AI not configured. Add your API key in Settings > AI to enable AI features."
                .to_string(),
        ))
    }

    fn provider_name(&self) -> &str {
        "Mock (Not Configured)"
    }
}

// === Provider Factory ===

/// Create an AI provider from configuration
pub fn create_provider(config: Option<AiProviderConfig>) -> Box<dyn AiProvider> {
    match config {
        Some(AiProviderConfig::Anthropic { api_key, model, base_url, verify_ssl }) => {
            if api_key.is_empty() {
                Box::new(MockProvider::new())
            } else {
                match AnthropicProvider::new(api_key, Some(model), base_url, verify_ssl) {
                    Ok(provider) => Box::new(provider),
                    Err(e) => {
                        tracing::error!("Failed to create Anthropic provider: {}", e);
                        Box::new(MockProvider::new())
                    }
                }
            }
        }
        Some(AiProviderConfig::OpenAI { api_key, model, base_url, verify_ssl }) => {
            if api_key.is_empty() {
                Box::new(MockProvider::new())
            } else {
                match OpenAIProvider::new(api_key, Some(model), base_url, verify_ssl) {
                    Ok(provider) => Box::new(provider),
                    Err(e) => {
                        tracing::error!("Failed to create OpenAI provider: {}", e);
                        Box::new(MockProvider::new())
                    }
                }
            }
        }
        Some(AiProviderConfig::Ollama { model, base_url, verify_ssl }) => {
            // Ollama doesn't need an API key
            match OllamaProvider::new(Some(model), Some(base_url), verify_ssl) {
                Ok(provider) => Box::new(provider),
                Err(e) => {
                    tracing::error!("Failed to create Ollama provider: {}", e);
                    Box::new(MockProvider::new())
                }
            }
        }
        Some(AiProviderConfig::OpenRouter { api_key, model }) => {
            if api_key.is_empty() {
                Box::new(MockProvider::new())
            } else {
                match OpenRouterProvider::new(api_key, Some(model)) {
                    Ok(provider) => Box::new(provider),
                    Err(e) => {
                        tracing::error!("Failed to create OpenRouter provider: {}", e);
                        Box::new(MockProvider::new())
                    }
                }
            }
        }
        Some(AiProviderConfig::LiteLLM { model, base_url, api_key, verify_ssl }) => {
            // LiteLLM doesn't require an API key (depends on proxy config)
            match LiteLLMProvider::new(Some(model), Some(base_url), api_key, verify_ssl) {
                Ok(provider) => Box::new(provider),
                Err(e) => {
                    tracing::error!("Failed to create LiteLLM provider: {}", e);
                    Box::new(MockProvider::new())
                }
            }
        }
        Some(AiProviderConfig::Custom { api_key, model, base_url, oauth2, api_format, verify_ssl }) => {
            // Determine API format: explicit setting > model name heuristic > default OpenAI
            let format = match api_format.as_deref() {
                Some("gemini") => ApiFormat::Gemini,
                Some("vertex-anthropic") => ApiFormat::VertexAnthropic,
                Some(_) => ApiFormat::OpenAI,
                None => {
                    // Heuristic: anthropic-on-vertex paths win first; then Gemini.
                    let lower_base = base_url.to_lowercase();
                    let lower_model = model.to_lowercase();
                    if (lower_base.contains("vertex") || lower_base.contains("anthropic"))
                        && (lower_model.starts_with("claude") || lower_model.contains(":rawpredict"))
                    {
                        tracing::info!("Auto-detected Vertex Anthropic format from model '{}' / base_url", model);
                        ApiFormat::VertexAnthropic
                    } else if lower_model.contains("gemini") || lower_base.contains("vertexai") || lower_base.contains("vertex-ai") {
                        tracing::info!("Auto-detected Gemini format from model '{}' / base_url", model);
                        ApiFormat::Gemini
                    } else {
                        ApiFormat::OpenAI
                    }
                }
            };
            tracing::debug!("Custom provider: model={}, format={:?}", model, format);
            if let Some(oauth2_config) = oauth2 {
                // OAuth2 client_credentials auth — token managed automatically
                match OpenAIProvider::with_oauth2(model, base_url, oauth2_config, format, verify_ssl) {
                    Ok(provider) => Box::new(provider),
                    Err(e) => {
                        tracing::error!("Failed to create OAuth2 custom provider: {}", e);
                        Box::new(MockProvider::new())
                    }
                }
            } else if api_key.is_empty() {
                Box::new(MockProvider::new())
            } else if format != ApiFormat::OpenAI {
                // Static API key with non-default format (Gemini or Vertex Anthropic)
                match OpenAIProvider::with_format(api_key, model, base_url, format, verify_ssl) {
                    Ok(provider) => Box::new(provider),
                    Err(e) => {
                        tracing::error!("Failed to create custom provider with format: {}", e);
                        Box::new(MockProvider::new())
                    }
                }
            } else {
                // Static API key auth — OpenAI-compatible format
                match OpenAIProvider::new(api_key, Some(model), Some(base_url), verify_ssl) {
                    Ok(provider) => Box::new(provider),
                    Err(e) => {
                        tracing::error!("Failed to create custom provider: {}", e);
                        Box::new(MockProvider::new())
                    }
                }
            }
        }
        None => Box::new(MockProvider::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_deserialization() {
        let json = r#"{"provider":"anthropic","api_key":"sk-test","model":"claude-sonnet-4-20250514"}"#;
        let config: AiProviderConfig = serde_json::from_str(json).unwrap();
        match config {
            AiProviderConfig::Anthropic { api_key, model, .. } => {
                assert_eq!(api_key, "sk-test");
                assert_eq!(model, "claude-sonnet-4-20250514");
            }
            _ => panic!("Expected Anthropic config"),
        }
    }

    #[test]
    fn test_mock_provider() {
        let provider = MockProvider::new();
        assert_eq!(provider.provider_name(), "Mock (Not Configured)");
    }
}
