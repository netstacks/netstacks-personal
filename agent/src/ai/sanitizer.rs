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

use super::providers::{
    AgentChatOptions, AgentContent, AgentContentBlock, AgentMessage, AgentResponse, AiContext,
    AiError, AiProvider, ChatMessage, StreamEvent,
};
use crate::providers::DataProvider;

// =============================================================================
// Configuration Types
// =============================================================================

/// Sanitization configuration stored as a JSON setting
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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

impl SanitizationConfig {
    /// The same custom patterns and allowlist, with every network-identifier
    /// redaction (IPs, MACs, hostnames, usernames) switched off. The mandatory
    /// credential patterns always apply. Used for local-only data such as
    /// clipboard history, where addresses are exactly what gets re-pasted.
    pub fn credentials_only(self) -> Self {
        Self {
            redact_ip_addresses: false,
            redact_ipv6_addresses: false,
            redact_mac_addresses: false,
            redact_hostnames: false,
            redact_usernames: false,
            ..self
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
    /// Whether hostname redaction is on; also gates literal redaction of the
    /// device names/hostnames a request's context carries.
    redact_hostnames: bool,
}

impl Sanitizer {
    /// Build a Sanitizer from config, compiling all regex patterns
    pub fn from_config(config: &SanitizationConfig) -> Self {
        let mandatory = build_mandatory_patterns();
        let optional = build_optional_patterns(config);
        let custom = build_custom_patterns(&config.custom_patterns);
        let allowlist: Vec<String> = config.allowlist.iter().map(|s| s.to_lowercase()).collect();

        Sanitizer {
            mandatory,
            optional,
            custom,
            allowlist,
            redact_hostnames: config.redact_hostnames,
        }
    }

    /// Sanitize a string, applying all active patterns with allowlist checking
    pub fn sanitize(&self, input: &str) -> SanitizedOutput {
        self.sanitize_with_extra(input, &[])
    }

    /// Literal patterns for identity values (device names, hostnames, the
    /// session name) taken from a request's context. A bare hostname such as
    /// `router1` matches no generic rule, so the exact values the context
    /// carries are redacted wherever they appear. Empty unless hostname
    /// redaction is enabled.
    fn identity_patterns(&self, terms: &[String]) -> Vec<CompiledPattern> {
        if !self.redact_hostnames {
            return Vec::new();
        }
        let mut terms: Vec<&str> = terms
            .iter()
            .map(|t| t.trim())
            .filter(|t| t.chars().count() >= 3)
            .collect();
        // Longest first so "core-rtr-01.lab" is not split by "core-rtr-01".
        terms.sort_by_key(|t| std::cmp::Reverse(t.len()));
        terms.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        terms
            .into_iter()
            .filter_map(|term| {
                let is_word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
                let lead = if is_word(term.chars().next()) { r"\b" } else { "" };
                let trail = if is_word(term.chars().last()) { r"\b" } else { "" };
                compile(
                    "context_hostname",
                    &format!("(?i){}{}{}", lead, regex::escape(term), trail),
                    "[HOST-REDACTED]",
                )
            })
            .collect()
    }

    /// `sanitize`, with `extra` patterns applied before the configured ones.
    fn sanitize_with_extra(&self, input: &str, extra: &[CompiledPattern]) -> SanitizedOutput {
        let mut result = input.to_string();
        let mut redaction_count = 0usize;
        let mut pattern_names: Vec<String> = Vec::new();

        // Apply patterns in order: request-specific, mandatory, optional, custom
        for pattern in extra
            .iter()
            .chain(self.mandatory.iter())
            .chain(self.optional.iter())
            .chain(self.custom.iter())
        {
            let mut new_result = String::new();
            let mut last_end = 0;
            let mut matched = false;

            for caps in pattern.regex.captures_iter(&result) {
                let mat = caps.get(0).expect("group 0 always participates in a match");
                let matched_text = mat.as_str();
                // Check allowlist: if matched text contains any allowlisted string, skip
                if self.is_allowlisted(matched_text) {
                    new_result.push_str(&result[last_end..mat.end()]);
                } else {
                    new_result.push_str(&result[last_end..mat.start()]);
                    // Expand `${1}`-style group references so the safe prefix
                    // ("enable secret 5 ") survives and only the value is redacted.
                    caps.expand(&pattern.replacement, &mut new_result);
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
        // Bare hostnames in CLI prompts: `router1#`, `core-rtr-01(config)#`,
        // `admin@mx1>`. Two-character minimum keeps FRR route codes (`K>*`) intact.
        if let Some(p) = compile(
            "hostname_prompt",
            r"(?m)^([A-Za-z0-9_.\-]+@)?[A-Za-z][A-Za-z0-9_.\-]+(\([A-Za-z0-9_./\-]*\))?([#>])",
            "${1}[HOST-REDACTED]${2}${3}",
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
// Simple-chat request sanitization
// =============================================================================

/// Identity values the context carries (device names, hostnames, session
/// name). Providers print these into the system prompt, and bare names like
/// `router1` match no generic rule, so they are redacted literally.
fn context_identity_terms(ctx: &AiContext) -> Vec<String> {
    let mut terms = Vec::new();
    if let Some(name) = &ctx.session_name {
        terms.push(name.clone());
    }
    if let Some(device) = &ctx.device {
        terms.push(device.name.clone());
    }
    if let Some(conn) = &ctx.connection {
        terms.push(conn.source_device.name.clone());
        terms.push(conn.target_device.name.clone());
    }
    if let Some(hostname) = ctx.terminal.as_ref().and_then(|t| t.hostname.as_ref()) {
        terms.push(hostname.clone());
    }
    terms
}

/// Apply `f` to every string in a JSON value, recursively.
fn map_json_strings(value: &mut serde_json::Value, f: &dyn Fn(&str) -> String) {
    match value {
        serde_json::Value::String(s) => *s = f(s),
        serde_json::Value::Array(items) => {
            for item in items {
                map_json_strings(item, f);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                map_json_strings(item, f);
            }
        }
        _ => {}
    }
}

/// Sanitize a simple `chat_completion` request: every message and every
/// user-originated string in the context (session name, device, connection,
/// terminal, team notes). The context is walked generically through its
/// serialized form so a field added later cannot bypass redaction. When
/// hostname redaction is on, the context's own device names and hostnames are
/// also redacted wherever they occur.
fn sanitize_chat_request(
    sanitizer: &Sanitizer,
    messages: Vec<ChatMessage>,
    context: Option<AiContext>,
) -> (Vec<ChatMessage>, Option<AiContext>) {
    let terms = context.as_ref().map(context_identity_terms).unwrap_or_default();
    let extra = sanitizer.identity_patterns(&terms);
    let clean = |text: &str| sanitizer.sanitize_with_extra(text, &extra).sanitized;

    let messages = messages
        .into_iter()
        .map(|m| ChatMessage {
            role: m.role,
            content: clean(&m.content),
        })
        .collect();

    let context = context.map(|ctx| {
        // Not serialized (loaded server-side, not user context): carried over.
        let ai_profile = ctx.ai_profile.clone();
        let feature = ctx.feature;
        let sanitized = serde_json::to_value(&ctx)
            .and_then(|mut value| {
                map_json_strings(&mut value, &clean);
                serde_json::from_value::<AiContext>(value)
            })
            .unwrap_or_else(|e| {
                // Never forward the unsanitized original.
                tracing::warn!("Failed to sanitize AI context, dropping it: {}", e);
                AiContext::default()
            });
        AiContext {
            ai_profile,
            feature,
            ..sanitized
        }
    });

    (messages, context)
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

    /// The cached sanitizer, loading it from settings on first use.
    async fn cached_sanitizer(&self) -> tokio::sync::RwLockReadGuard<'_, Option<Sanitizer>> {
        {
            let cache = self.sanitizer_cache.read().await;
            if cache.is_some() {
                return cache;
            }
        }
        {
            let mut cache = self.sanitizer_cache.write().await;
            if cache.is_none() {
                *cache = Some(load_sanitizer(self.data_provider.as_ref()).await);
            }
        }
        self.sanitizer_cache.read().await
    }

    /// Sanitize a string using the cached sanitizer
    async fn sanitize_text(&self, input: &str) -> String {
        let cache = self.cached_sanitizer().await;
        match cache.as_ref() {
            Some(sanitizer) => sanitizer.sanitize(input).sanitized,
            // Cache cleared between populate and read: never send unsanitized.
            None => load_sanitizer(self.data_provider.as_ref())
                .await
                .sanitize(input)
                .sanitized,
        }
    }

    /// Sanitize an AgentMessage
    async fn sanitize_agent_message(&self, msg: AgentMessage) -> AgentMessage {
        AgentMessage {
            role: msg.role,
            content: match msg.content {
                AgentContent::Text(text) => AgentContent::Text(self.sanitize_text(&text).await),
                AgentContent::Blocks(blocks) => {
                    let mut sanitized = Vec::with_capacity(blocks.len());
                    for block in blocks {
                        let sb = match block {
                            AgentContentBlock::Text { text } => AgentContentBlock::Text {
                                text: self.sanitize_text(&text).await,
                            },
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
        let (sanitized_messages, sanitized_context) = {
            let fresh;
            let cache = self.cached_sanitizer().await;
            let sanitizer = match cache.as_ref() {
                Some(sanitizer) => sanitizer,
                None => {
                    fresh = load_sanitizer(self.data_provider.as_ref()).await;
                    &fresh
                }
            };
            sanitize_chat_request(sanitizer, messages, context)
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
pub async fn test_sanitization(provider: &dyn DataProvider, text: &str) -> SanitizedOutput {
    let sanitizer = load_sanitizer(provider).await;
    sanitizer.sanitize(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitizer() -> Sanitizer {
        Sanitizer::from_config(&SanitizationConfig::default())
    }

    #[test]
    fn replacement_keeps_captured_prefix() {
        let out = sanitizer()
            .sanitize("enable secret 5 $1$abcd$WxYz123\nsnmp-server community s3cr3t RO");
        assert_eq!(
            out.sanitized,
            "enable secret 5 [REDACTED]\nsnmp-server community [REDACTED] RO"
        );
        assert!(
            !out.sanitized.contains("${1}"),
            "group references must be expanded: {}",
            out.sanitized
        );
        // arista_secret re-matches the already-redacted enable line, so the count is >= 2.
        assert!(out.redaction_count >= 2, "{}", out.redaction_count);
    }

    #[test]
    fn paloalto_keeps_both_tags() {
        let out = sanitizer().sanitize("<password>hunter2</password>");
        assert_eq!(out.sanitized, "<password>[REDACTED]</password>");
    }

    fn redacting() -> Sanitizer {
        Sanitizer::from_config(&SanitizationConfig {
            redact_ip_addresses: true,
            redact_hostnames: true,
            ..Default::default()
        })
    }

    #[test]
    fn bare_hostname_in_cli_prompt_is_redacted() {
        let out = redacting().sanitize(
            "router1#show ip int brief\ncore-rtr-01(config)#interface Gi0/1\nadmin@mx1> show route\nK>* 0.0.0.0/0 via eth0",
        );
        for name in ["router1", "core-rtr-01", "mx1"] {
            assert!(!out.sanitized.contains(name), "{name} leaked: {}", out.sanitized);
        }
        assert!(out.sanitized.contains("[HOST-REDACTED](config)#interface"), "{}", out.sanitized);
        assert!(out.sanitized.contains("admin@[HOST-REDACTED]> show route"), "{}", out.sanitized);
        // Single-letter FRR route codes are not prompts.
        assert!(out.sanitized.contains("K>* "), "{}", out.sanitized);
    }

    #[test]
    fn context_identity_terms_only_apply_with_hostname_redaction() {
        let terms = vec!["router1".to_string(), "ab".to_string()];
        assert!(sanitizer().identity_patterns(&terms).is_empty());
        let s = redacting();
        let extra = s.identity_patterns(&terms);
        // Too-short values are skipped rather than redacting every "ab".
        assert_eq!(extra.len(), 1);
        let out = s.sanitize_with_extra("ping from Router1 to router10", &extra);
        assert_eq!(out.sanitized, "ping from [HOST-REDACTED] to router10");
    }

    /// Minimal HTTP/1.1 server: captures one request body, answers with an
    /// Anthropic-shaped response.
    async fn capture_one_request() -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let len = text[..split]
                        .lines()
                        .find_map(|l| {
                            let l = l.to_ascii_lowercase();
                            l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if raw.len() >= split + 4 + len || n == 0 {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let body = r#"{"content":[{"type":"text","text":"ok"}]}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&raw).to_string()
        });
        (url, handle)
    }

    /// 1.3: on the simple `chat_completion` path, context identifiers must not
    /// reach the provider. Drives SanitizingProvider -> AnthropicProvider ->
    /// real HTTP request and inspects the outbound body.
    #[tokio::test]
    async fn chat_completion_outbound_request_has_no_context_identifiers() {
        use super::super::providers::{
            AnthropicProvider, ConnectionContext, DeviceContext, TerminalContext,
        };

        let (url, server) = capture_one_request().await;
        let inner = AnthropicProvider::new("sk-test".into(), Some("claude-opus-5".into()), Some(url), true)
            .unwrap();
        let pool = sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap();
        let data: Arc<dyn DataProvider> = Arc::new(crate::providers::LocalDataProvider::new(pool));
        let cache = Arc::new(RwLock::new(Some(redacting())));
        let provider = SanitizingProvider::new(Box::new(inner), cache, data);

        let device = |name: &str, ip: &str| DeviceContext {
            name: name.into(),
            device_type: "router".into(),
            primary_ip: Some(ip.into()),
            site: Some("site 10.9.9.9".into()),
            ..Default::default()
        };
        let context = AiContext {
            session_name: Some("edge-session-7".into()),
            device: Some(device("core-rtr-01", "10.1.2.3")),
            connection: Some(ConnectionContext {
                source_device: device("core-rtr-01", "10.1.2.3"),
                source_interface: "Gi0/0 to 10.5.5.5".into(),
                target_device: device("router1", "10.4.4.4"),
                target_interface: "Gi0/1".into(),
                status: "up".into(),
                protocols: None,
            }),
            terminal: Some(TerminalContext {
                hostname: Some("router1".into()),
                recent_output: Some("router1#show ip int brief\nGi0/0 10.4.4.4 up".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "Why is router1 dropping BGP to core-rtr-01 in edge-session-7?".into(),
        }];

        let reply = provider.chat_completion(messages, Some(context)).await.unwrap();
        assert_eq!(reply, "ok");
        let request = server.await.unwrap();
        assert!(request.contains("[HOST-REDACTED]"), "{request}");
        for leaked in [
            "router1", "core-rtr-01", "edge-session-7", "10.1.2.3", "10.4.4.4", "10.5.5.5", "10.9.9.9",
        ] {
            assert!(!request.contains(leaked), "{leaked} reached the provider:\n{request}");
        }
    }

    #[test]
    fn assertion_status_is_not_a_password() {
        let out =
            sanitizer().sanitize("  assertion [PASS] CONTAINS: pre 200 (text found in output)");
        assert_eq!(out.redaction_count, 0, "{}", out.sanitized);
    }
}
