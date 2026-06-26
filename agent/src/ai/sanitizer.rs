//! AI Data Sanitization Layer
//!
//! Scrubs credentials, secrets, and optionally network identifiers from all data
//! before it reaches external AI providers. Implements a SanitizingProvider decorator
//! that wraps any AiProvider transparently.

use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::providers::DataProvider;
use super::providers::{
    AiContext, AiError, AiProvider, AgentChatOptions, AgentContent, AgentContentBlock,
    AgentMessage, AgentResponse, ChatMessage, StreamEvent,
};

// =============================================================================
// Configuration Types
// =============================================================================

/// Sanitization configuration stored as a JSON setting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SanitizationConfig {
    /// Redact IPv4 addresses (10.0.0.1, 192.168.1.0/24)
    #[serde(default)]
    pub redact_ip_addresses: bool,
    /// Redact IPv6 addresses (fe80::1, 2001:db8::1)
    #[serde(default)]
    pub redact_ipv6_addresses: bool,
    /// Redact MAC addresses (00:1a:2b:3c:4d:5e, 001a.2b3c.4d5e)
    #[serde(default)]
    pub redact_mac_addresses: bool,
    /// Redact hostnames/FQDNs (router1.corp.example.com)
    #[serde(default)]
    pub redact_hostnames: bool,
    /// Redact usernames in config context (username admin)
    #[serde(default)]
    pub redact_usernames: bool,
    /// User-defined custom patterns
    #[serde(default)]
    pub custom_patterns: Vec<CustomPatternConfig>,
    /// Strings that should never be redacted (case-insensitive)
    #[serde(default)]
    pub allowlist: Vec<String>,
}

impl Default for SanitizationConfig {
    fn default() -> Self {
        Self {
            redact_ip_addresses: false,
            redact_ipv6_addresses: false,
            redact_mac_addresses: false,
            redact_hostnames: false,
            redact_usernames: false,
            custom_patterns: Vec::new(),
            allowlist: Vec::new(),
        }
    }
}

/// A user-defined custom regex pattern.
/// Accepts both `regex` and `pattern` field names for compatibility with controller.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomPatternConfig {
    pub name: String,
    #[serde(alias = "pattern")]
    pub regex: String,
    pub replacement: String,
}

// =============================================================================
// Compiled Pattern + Sanitizer
// =============================================================================

/// A compiled regex pattern with metadata
struct CompiledPattern {
    name: String,
    regex: Regex,
    replacement: String,
}

/// Result of sanitizing a string
#[derive(Debug, Clone, Serialize)]
pub struct SanitizedOutput {
    pub sanitized: String,
    pub redaction_count: usize,
    pub pattern_names: Vec<String>,
}

/// Core sanitizer engine holding compiled mandatory, optional, and custom patterns
pub struct Sanitizer {
    mandatory: Vec<CompiledPattern>,
    optional: Vec<CompiledPattern>,
    custom: Vec<CompiledPattern>,
    allowlist: Vec<String>,
}

impl Sanitizer {
    /// Build a Sanitizer from config, compiling all regex patterns
    pub fn from_config(config: &SanitizationConfig) -> Self {
        let mandatory = build_mandatory_patterns();
        let optional = build_optional_patterns(config);
        let custom = build_custom_patterns(&config.custom_patterns);
        let allowlist: Vec<String> = config
            .allowlist
            .iter()
            .map(|s| s.to_lowercase())
            .collect();

        Sanitizer {
            mandatory,
            optional,
            custom,
            allowlist,
        }
    }

    /// Sanitize a string, applying all active patterns with allowlist checking
    pub fn sanitize(&self, input: &str) -> SanitizedOutput {
        let mut result = input.to_string();
        let mut redaction_count = 0usize;
        let mut pattern_names: Vec<String> = Vec::new();

        // Apply patterns in order: mandatory, optional, custom
        for pattern in self.mandatory.iter().chain(self.optional.iter()).chain(self.custom.iter()) {
            let mut new_result = String::new();
            let mut last_end = 0;
            let mut matched = false;

            for mat in pattern.regex.find_iter(&result) {
                let matched_text = mat.as_str();
                // Check allowlist: if matched text contains any allowlisted string, skip
                if self.is_allowlisted(matched_text) {
                    new_result.push_str(&result[last_end..mat.end()]);
                } else {
                    new_result.push_str(&result[last_end..mat.start()]);
                    new_result.push_str(&pattern.replacement);
                    redaction_count += 1;
                    matched = true;
                }
                last_end = mat.end();
            }
            new_result.push_str(&result[last_end..]);

            if matched && !pattern_names.contains(&pattern.name) {
                pattern_names.push(pattern.name.clone());
            }
            result = new_result;
        }

        SanitizedOutput {
            sanitized: result,
            redaction_count,
            pattern_names,
        }
    }

    /// Check if a matched string is in the allowlist
    fn is_allowlisted(&self, text: &str) -> bool {
        let lower = text.to_lowercase();
        self.allowlist.iter().any(|a| lower.contains(a))
    }
}

// =============================================================================
// Pattern Builders
// =============================================================================

fn compile(name: &str, pattern: &str, replacement: &str) -> Option<CompiledPattern> {
    match Regex::new(pattern) {
        Ok(regex) => Some(CompiledPattern {
            name: name.to_string(),
            regex,
            replacement: replacement.to_string(),
        }),
        Err(e) => {
            tracing::warn!("Failed to compile sanitization pattern '{}': {}", name, e);
            None
        }
    }
}

fn build_mandatory_patterns() -> Vec<CompiledPattern> {
    let defs: Vec<(&str, &str, &str)> = vec![
        // 1. Cisco enable secret/password
        (
            "cisco_enable_secret",
            r"(?i)(enable\s+(?:secret|password)\s+\d\s+)\S+",
            "${1}[REDACTED]",
        ),
        // 2. Cisco password 7
        (
            "cisco_password_7",
            r"(?i)(password\s+7\s+)\S+",
            "${1}[REDACTED]",
        ),
        // 3. Cisco password 0
        (
            "cisco_password_0",
            r"(?i)(password\s+0\s+)\S+",
            "${1}[REDACTED]",
        ),
        // 4. SNMP community string
        (
            "snmp_community",
            r"(?i)(snmp-server\s+community\s+)\S+",
            "${1}[REDACTED]",
        ),
        // 5. SNMPv3 auth/priv keys
        (
            "snmp_v3_auth",
            r"(?i)((?:auth|priv)\s+(?:md5|sha|des|aes|aes128|aes192|aes256)\s+)\S+",
            "${1}[REDACTED]",
        ),
        // 6. TACACS key
        (
            "tacacs_key",
            r"(?i)(tacacs-server\s+.*?key\s+(?:\d\s+)?)\S+",
            "${1}[REDACTED]",
        ),
        // 7. RADIUS key
        (
            "radius_key",
            r"(?i)(radius-server\s+.*?key\s+(?:\d\s+)?)\S+",
            "${1}[REDACTED]",
        ),
        // 8. Juniper secret ($9$...)
        (
            "juniper_secret",
            r#"(?i)(secret\s+")(\$9\$[^"]+)"#,
            "${1}[REDACTED]",
        ),
        // 9. Juniper encrypted-password
        (
            "juniper_encrypted",
            r#"(?i)(encrypted-password\s+")([^"]+)"#,
            "${1}[REDACTED]",
        ),
        // 10. Arista secret (sha512/0/5/7)
        (
            "arista_secret",
            r"(?i)(secret\s+(?:sha512|0|5|7)\s+)\S+",
            "${1}[REDACTED]",
        ),
        // 11. Palo Alto <password>...</password>
        (
            "paloalto_password",
            r"(?i)(<password>)[^<]*(</password>)",
            "${1}[REDACTED]${2}",
        ),
        // 12. Palo Alto <key>...</key>
        (
            "paloalto_key",
            r"(?i)(<key>)[^<]*(</key>)",
            "${1}[REDACTED]${2}",
        ),
        // 13. Private key blocks
        (
            "private_key_block",
            r"-----BEGIN\s+[\w\s]*PRIVATE\s+KEY-----[\s\S]*?-----END\s+[\w\s]*PRIVATE\s+KEY-----",
            "[PRIVATE-KEY-REDACTED]",
        ),
        // 14. Certificate blocks
        (
            "certificate_block",
            r"-----BEGIN\s+CERTIFICATE-----[\s\S]*?-----END\s+CERTIFICATE-----",
            "[CERTIFICATE-REDACTED]",
        ),
        // 15. Generic API key/token/bearer patterns
        (
            "api_key_generic",
            r#"(?i)((?:api[_-]?key|api[_-]?token|bearer|access[_-]?token|auth[_-]?token)\s*[=:]\s*)['"]?[A-Za-z0-9_\-/.]{20,}['"]?"#,
            "${1}[REDACTED]",
        ),
        // 16. AWS Access Key ID
        (
            "aws_access_key",
            r"(?:^|[^A-Za-z0-9])(AKIA[0-9A-Z]{16})(?:[^A-Za-z0-9]|$)",
            "[AWS-KEY-REDACTED]",
        ),
        // 17. AWS Secret Access Key
        (
            "aws_secret_key",
            r"(?i)(aws_secret_access_key\s*[=:]\s*)\S+",
            "${1}[REDACTED]",
        ),
        // 18. Generic password patterns
        (
            "generic_password",
            r"(?i)((?:password|passwd|pass|pwd)\s*[=:]\s*)\S+",
            "${1}[REDACTED]",
        ),
        // 19. Generic secret/shared_key/pre_shared_key
        (
            "generic_secret",
            r"(?i)((?:secret|shared[_-]?key|pre[_-]?shared[_-]?key)\s*[=:]\s*)\S+",
            "${1}[REDACTED]",
        ),
    ];

    defs.into_iter()
        .filter_map(|(name, pattern, replacement)| compile(name, pattern, replacement))
        .collect()
}

fn build_optional_patterns(config: &SanitizationConfig) -> Vec<CompiledPattern> {
    let mut patterns = Vec::new();

    if config.redact_ip_addresses {
        if let Some(p) = compile(
            "ipv4_address",
            r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:/\d{1,2})?\b",
            "[IP-REDACTED]",
        ) {
            patterns.push(p);
        }
    }

    if config.redact_ipv6_addresses {
        if let Some(p) = compile(
            "ipv6_address",
            r"(?i)\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b|(?i)\b(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}\b|(?i)\b::(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}\b|(?i)\b[0-9a-f]{1,4}::(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4}\b",
            "[IPv6-REDACTED]",
        ) {
            patterns.push(p);
        }
    }

    if config.redact_mac_addresses {
        if let Some(p) = compile(
            "mac_address",
            r"(?i)\b(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}\b|(?i)\b(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}\b",
            "[MAC-REDACTED]",
        ) {
            patterns.push(p);
        }
    }

    if config.redact_hostnames {
        if let Some(p) = compile(
            "hostname_fqdn",
            r"\b[a-zA-Z][a-zA-Z0-9\-]*(?:\.[a-zA-Z][a-zA-Z0-9\-]*){2,}\b",
            "[HOST-REDACTED]",
        ) {
            patterns.push(p);
        }
    }

    if config.redact_usernames {
        if let Some(p) = compile(
            "username_context",
            r"(?i)(username\s+)\S+",
            "${1}[USER-REDACTED]",
        ) {
            patterns.push(p);
        }
    }

    patterns
}

fn build_custom_patterns(configs: &[CustomPatternConfig]) -> Vec<CompiledPattern> {
    configs
        .iter()
        .filter_map(|c| compile(&c.name, &c.regex, &c.replacement))
        .collect()
}

// =============================================================================
// Sanitizer Loading from Settings
// =============================================================================

/// Load sanitization config from settings and build a Sanitizer.
/// Returns a default (mandatory-only) sanitizer if no config is stored.
pub async fn load_sanitizer(provider: &dyn DataProvider) -> Sanitizer {
    let config = load_sanitization_config(provider).await;
    Sanitizer::from_config(&config)
}

/// Load just the SanitizationConfig from settings
pub async fn load_sanitization_config(provider: &dyn DataProvider) -> SanitizationConfig {
    match provider.get_setting("ai.sanitization_config").await {
        Ok(value) if !value.is_null() => {
            // Handle wrapped {value: "..."} format
            let inner = if let Some(obj) = value.as_object() {
                if let Some(v) = obj.get("value") {
                    v.clone()
                } else {
                    value
                }
            } else {
                value
            };

            if inner.is_null() {
                return SanitizationConfig::default();
            }

            // The inner value may be a JSON string that needs parsing
            let config_value: serde_json::Value = if let serde_json::Value::String(s) = &inner {
                match serde_json::from_str(s) {
                    Ok(parsed) => parsed,
                    Err(e) => {
                        tracing::warn!("Failed to parse sanitization config string: {}", e);
                        return SanitizationConfig::default();
                    }
                }
            } else {
                inner
            };

            match serde_json::from_value::<SanitizationConfig>(config_value) {
                Ok(config) => config,
                Err(e) => {
                    tracing::warn!("Failed to deserialize sanitization config: {}", e);
                    SanitizationConfig::default()
                }
            }
        }
        _ => SanitizationConfig::default(),
    }
}

// =============================================================================
// SanitizingProvider Decorator
// =============================================================================

/// A decorator that sanitizes all inputs before delegating to an inner AiProvider.
/// Automatically covers all current and future providers.
pub struct SanitizingProvider {
    inner: Box<dyn AiProvider>,
    sanitizer_cache: Arc<RwLock<Option<Sanitizer>>>,
    data_provider: Arc<dyn DataProvider>,
}

impl SanitizingProvider {
    pub fn new(
        inner: Box<dyn AiProvider>,
        sanitizer_cache: Arc<RwLock<Option<Sanitizer>>>,
        data_provider: Arc<dyn DataProvider>,
    ) -> Self {
        Self {
            inner,
            sanitizer_cache,
            data_provider,
        }
    }

    /// Sanitize a string using the cached sanitizer
    async fn sanitize_text(&self, input: &str) -> String {
        // Ensure cache is populated
        {
            let cache = self.sanitizer_cache.read().await;
            if let Some(ref sanitizer) = *cache {
                return sanitizer.sanitize(input).sanitized;
            }
        }
        // Cache miss — populate
        {
            let mut cache = self.sanitizer_cache.write().await;
            if cache.is_none() {
                let sanitizer = load_sanitizer(self.data_provider.as_ref()).await;
                *cache = Some(sanitizer);
            }
            if let Some(ref sanitizer) = *cache {
                return sanitizer.sanitize(input).sanitized;
            }
        }
        // Fallback: return original (shouldn't happen)
        input.to_string()
    }

    /// Sanitize a ChatMessage
    async fn sanitize_chat_message(&self, msg: ChatMessage) -> ChatMessage {
        ChatMessage {
            role: msg.role,
            content: self.sanitize_text(&msg.content).await,
        }
    }

    /// Sanitize AiContext fields
    async fn sanitize_context(&self, ctx: AiContext) -> AiContext {
        AiContext {
            selected_text: match ctx.selected_text {
                Some(t) => Some(self.sanitize_text(&t).await),
                None => None,
            },
            session_name: ctx.session_name,
            device: ctx.device,
            connection: ctx.connection,
            terminal: match ctx.terminal {
                Some(mut t) => {
                    if let Some(ref output) = t.recent_output {
                        t.recent_output = Some(self.sanitize_text(output).await);
                    }
                    Some(t)
                }
                None => None,
            },
            session_context: match ctx.session_context {
                Some(entries) => {
                    let mut sanitized = Vec::with_capacity(entries.len());
                    for mut entry in entries {
                        entry.issue = self.sanitize_text(&entry.issue).await;
                        if let Some(ref rc) = entry.root_cause {
                            entry.root_cause = Some(self.sanitize_text(rc).await);
                        }
                        if let Some(ref res) = entry.resolution {
                            entry.resolution = Some(self.sanitize_text(res).await);
                        }
                        if let Some(ref cmds) = entry.commands {
                            entry.commands = Some(self.sanitize_text(cmds).await);
                        }
                        sanitized.push(entry);
                    }
                    Some(sanitized)
                }
                None => None,
            },
            ai_profile: ctx.ai_profile,
            feature: ctx.feature,
        }
    }

    /// Sanitize an AgentMessage
    async fn sanitize_agent_message(&self, msg: AgentMessage) -> AgentMessage {
        AgentMessage {
            role: msg.role,
            content: match msg.content {
                AgentContent::Text(text) => {
                    AgentContent::Text(self.sanitize_text(&text).await)
                }
                AgentContent::Blocks(blocks) => {
                    let mut sanitized = Vec::with_capacity(blocks.len());
                    for block in blocks {
                        let sb = match block {
                            AgentContentBlock::Text { text } => {
                                AgentContentBlock::Text {
                                    text: self.sanitize_text(&text).await,
                                }
                            }
                            AgentContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            } => AgentContentBlock::ToolResult {
                                tool_use_id,
                                content: self.sanitize_text(&content).await,
                                is_error,
                            },
                            // ToolUse blocks contain AI-generated content (id, name, input)
                            // — these go TO the AI, not from user data, so skip sanitizing
                            other => other,
                        };
                        sanitized.push(sb);
                    }
                    AgentContent::Blocks(sanitized)
                }
            },
        }
    }
}

#[async_trait]
impl AiProvider for SanitizingProvider {
    async fn chat_completion(
        &self,
        messages: Vec<ChatMessage>,
        context: Option<AiContext>,
    ) -> Result<String, AiError> {
        // Sanitize all messages
        let mut sanitized_messages = Vec::with_capacity(messages.len());
        for msg in messages {
            sanitized_messages.push(self.sanitize_chat_message(msg).await);
        }

        // Sanitize context
        let sanitized_context = match context {
            Some(ctx) => Some(self.sanitize_context(ctx).await),
            None => None,
        };

        self.inner
            .chat_completion(sanitized_messages, sanitized_context)
            .await
    }

    async fn agent_chat(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Result<AgentResponse, AiError> {
        // Sanitize system prompt (may contain terminal output, device IPs, etc.)
        let sanitized_prompt = self.sanitize_text(&system_prompt).await;

        // Sanitize all messages
        let mut sanitized_messages = Vec::with_capacity(messages.len());
        for msg in messages {
            sanitized_messages.push(self.sanitize_agent_message(msg).await);
        }

        // Tools are schema definitions, not user data — pass through
        self.inner
            .agent_chat(sanitized_prompt, sanitized_messages, tools, options)
            .await
    }

    fn agent_chat_stream(
        &self,
        system_prompt: String,
        messages: Vec<AgentMessage>,
        tools: Option<Vec<serde_json::Value>>,
        options: Option<AgentChatOptions>,
    ) -> Pin<Box<dyn futures::Stream<Item = Result<StreamEvent, AiError>> + Send + '_>> {
        Box::pin(async_stream::stream! {
            // Sanitize system prompt (may contain terminal output, device IPs, etc.)
            let sanitized_prompt = self.sanitize_text(&system_prompt).await;

            // Sanitize all messages
            let mut sanitized_messages = Vec::with_capacity(messages.len());
            for msg in messages {
                sanitized_messages.push(self.sanitize_agent_message(msg).await);
            }

            // Forward to inner provider's stream
            let mut stream = self.inner.agent_chat_stream(sanitized_prompt, sanitized_messages, tools, options);
            use futures::StreamExt;
            while let Some(item) = stream.next().await {
                yield item;
            }
        })
    }

    fn provider_name(&self) -> &str {
        self.inner.provider_name()
    }
}

// =============================================================================
// Test sanitization (for the test endpoint)
// =============================================================================

/// Run sanitization on arbitrary text and return detailed results.
/// Always loads fresh config (bypasses cache) for testing.
pub async fn test_sanitization(
    provider: &dyn DataProvider,
    text: &str,
) -> SanitizedOutput {
    let sanitizer = load_sanitizer(provider).await;
    sanitizer.sanitize(text)
}
