//! AI-powered semantic highlighting for terminal output
//!
//! Analyzes terminal output to detect errors, warnings, security issues,
//! and anomalies without explicit regex rules.

use std::collections::HashSet;
use serde::{Deserialize, Serialize};

/// AI highlight analysis mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HighlightMode {
    /// Detect errors and warnings
    Errors,
    /// Detect security concerns (exposed credentials, suspicious activity)
    Security,
    /// Detect unusual values (high CPU, odd ports, unexpected states)
    Anomalies,
}

impl HighlightMode {
    /// Get the prompt description for this mode
    pub fn prompt_description(&self) -> &'static str {
        match self {
            HighlightMode::Errors => {
                "errors and warnings. Look for:
- Error messages (error, fail, fatal, exception, denied, refused, timeout)
- Warning messages (warn, warning, deprecated, caution)
- Stack traces and error codes
- Failed operations or commands
- Connection failures or timeouts
- Network protocol problems:
  * BGP sessions NOT in Established state (Idle, Connect, Active, OpenSent, OpenConfirm)
  * OSPF adjacencies NOT in Full state
  * Interface down, err-disabled, or administratively shut
  * Non-zero interface error counters (CRC, input errors, output errors, collisions)"
            }
            HighlightMode::Security => {
                "security concerns. Look for:
- Exposed credentials (passwords, API keys, tokens appearing in output)
- Suspicious network activity (unexpected connections, unusual ports)
- Permission issues that could indicate vulnerabilities
- Authentication failures
- Certificate or encryption warnings
- Plaintext sensitive data"
            }
            HighlightMode::Anomalies => {
                "anomalies and unusual values. Look for:
- Resource metrics outside normal ranges (CPU > 90%, memory > 95%, disk > 90%)
- Unusual port numbers (especially in ephemeral range when unexpected)
- Unexpected process states (zombie, stopped, defunct)
- Unusual user IDs or permissions (root where unexpected, world-writable)
- Time values that seem wrong (dates in the future, very old timestamps)
- Count/size values that seem too high or too low
- Network protocol states indicating problems:
  * BGP neighbors NOT in Established state (Idle, Connect, Active, OpenSent, OpenConfirm are all problematic)
  * OSPF neighbors NOT in Full state (Down, Init, 2-Way, ExStart, Exchange, Loading are concerning)
  * Interface errors: CRC errors, input/output errors, collisions, runts, giants (non-zero counts)
  * Interface status: administratively down, err-disabled, not connected
  * Interfaces running at lower speed than expected (e.g., 100Mbps on a GigabitEthernet)
  * High interface utilization (near line rate)
  * Spanning-tree topology changes or blocking states
  * HSRP/VRRP standby when expected to be active (or vice versa)
  * Any routing protocol showing 0 received/accepted prefixes when peers are configured"
            }
        }
    }
}

/// Highlight type for categorizing detections
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HighlightType {
    Error,
    Warning,
    Security,
    Anomaly,
    Info,
}

impl HighlightType {
    /// Get the default color for this highlight type
    pub fn _default_color(&self) -> &'static str {
        match self {
            HighlightType::Error => "#ff6b6b",      // Red
            HighlightType::Warning => "#ffa726",    // Orange
            HighlightType::Security => "#ba68c8",   // Purple
            HighlightType::Anomaly => "#4dd0e1",    // Cyan
            HighlightType::Info => "#64b5f6",       // Blue
        }
    }
}

/// A single AI-detected highlight
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIHighlight {
    /// Line number (0-indexed)
    #[serde(default)]
    pub line: usize,
    /// Start column within the line
    #[serde(default)]
    pub start: usize,
    /// End column within the line
    #[serde(default)]
    pub end: usize,
    /// The matched text
    pub text: String,
    /// Type of highlight
    #[serde(rename = "type")]
    pub highlight_type: HighlightType,
    /// Confidence score (0.0 to 1.0)
    pub confidence: f64,
    /// Human-readable reason for the highlight
    pub reason: String,
}

/// Request for AI highlight analysis
#[derive(Debug, Deserialize)]
pub struct AnalyzeHighlightsRequest {
    /// Terminal output to analyze
    pub output: String,
    /// Analysis mode
    pub mode: HighlightMode,
    /// Optional CLI flavor for context (e.g., "cisco-ios", "linux")
    pub cli_flavor: Option<String>,
    /// Optional provider override (uses default if not specified)
    pub provider: Option<String>,
    /// Optional model override (uses provider default if not specified)
    pub model: Option<String>,
}

/// Response from AI highlight analysis
#[derive(Debug, Serialize)]
pub struct AnalyzeHighlightsResponse {
    /// Detected highlights
    pub highlights: Vec<AIHighlight>,
}

/// Build the system prompt for highlight analysis
pub fn build_system_prompt(mode: HighlightMode, cli_flavor: Option<&str>) -> String {
    let cli_context = cli_flavor
        .map(|f| format!("\nThe output is from a {} system.", f))
        .unwrap_or_default();

    format!(
        r#"You analyze network/terminal CLI output and flag problems. Identify {mode_desc}{cli_context}

RESPONSE FORMAT — you MUST follow this exactly:
- Respond with ONLY a raw JSON array. No markdown, no explanation, no wrapping object.
- First character must be [ and last must be ]
- If nothing to flag, respond with exactly: []

Each element needs only "text", "type", "confidence", and "reason":
{{"text":"<exact text to highlight, copied verbatim from the output>","type":"<error|warning|security|anomaly|info>","confidence":<0.0-1.0>,"reason":"<brief explanation>"}}

The "text" field MUST be an exact substring from the output that can be found with a text search. Copy it character-for-character.

EXAMPLE — given this input:
Router#show ip bgp summary
Neighbor        AS  State
10.0.0.1      65001 Connect
10.0.0.2      65002 Established

You respond:
[{{"text":"Connect","type":"error","confidence":0.95,"reason":"BGP neighbor 10.0.0.1 in Connect state, not Established"}}]

Do NOT include line/start/end numbers. Do NOT return objects. ONLY the JSON array."#,
        mode_desc = mode.prompt_description()
    )
}

/// Parse AI response into highlights, handling any JSON format gracefully.
/// Models may return: a JSON array, a markdown-wrapped array, a JSON object
/// with various field names, or even a free-form description. We try to
/// extract useful highlights from whatever format is returned.
///
/// The `original_output` parameter is used to resolve text positions —
/// when the model returns highlights without line/column numbers, we search
/// the original output to find where the text appears.
pub fn parse_ai_response(response: &str, original_output: &str) -> Vec<AIHighlight> {
    let json_str = extract_json(response);

    // 1. Try parsing as our exact expected array format
    if let Ok(highlights) = serde_json::from_str::<Vec<AIHighlight>>(json_str) {
        let filtered: Vec<_> = highlights.into_iter()
            .filter(|h| h.confidence >= 0.0 && h.confidence <= 1.0)
            .collect();
        if !filtered.is_empty() {
            return resolve_positions(filtered, original_output);
        }
    }

    // 2. Try parsing as a generic JSON value and extract highlights from any structure
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(json_str) {
        let highlights = extract_highlights_from_value(&value);
        if !highlights.is_empty() {
            return resolve_positions(highlights, original_output);
        }
    }

    tracing::debug!("Failed to parse AI highlight response from: {}", &response[..response.len().min(300)]);
    Vec::new()
}

/// Resolve text positions by searching the original output.
/// When the AI returns highlights without valid line/start/end positions,
/// we find the text in the original output and fill in the positions.
/// If the same text appears on multiple lines, a highlight is created for
/// each occurrence so that every instance is decorated in the terminal.
fn resolve_positions(highlights: Vec<AIHighlight>, original_output: &str) -> Vec<AIHighlight> {
    let lines: Vec<&str> = original_output.lines().collect();
    let mut result = Vec::new();
    let mut expanded_texts: HashSet<String> = HashSet::new();

    for mut h in highlights {
        if h.text.trim().is_empty() || h.text == "\t" {
            h.text = extract_keyword_from_reason(&h.reason, &lines);
        }

        if !h.text.is_empty() && h.start == 0 && h.end == 0 {
            if expanded_texts.contains(&h.text) {
                continue;
            }
            expanded_texts.insert(h.text.clone());

            for (i, line) in lines.iter().enumerate() {
                if let Some(pos) = line.find(&h.text) {
                    let mut cloned = h.clone();
                    cloned.line = i;
                    cloned.start = pos;
                    cloned.end = pos + h.text.len();
                    result.push(cloned);
                }
            }
            continue;
        }

        if h.end <= h.start && !h.text.is_empty() {
            h.end = h.start + h.text.len();
        }

        result.push(h);
    }

    result.into_iter().filter(|h| !h.text.is_empty() && h.end > h.start).collect()
}

/// Extract a keyword from the AI's reason text that we can search for in the output.
/// Looks for known network protocol states and terms.
fn extract_keyword_from_reason(reason: &str, lines: &[&str]) -> String {
    // Known problematic states that appear in CLI output
    let keywords = [
        "Connect", "Active", "Idle", "OpenSent", "OpenConfirm",
        "err-disabled", "down", "administratively down",
        "Init", "2-Way", "ExStart", "Exchange", "Loading",
        "Blocking", "Listening", "Learning",
        "% Invalid input", "% Ambiguous command",
        "error", "denied", "refused", "timeout", "failed",
    ];

    for keyword in &keywords {
        if reason.contains(keyword) {
            // Verify this keyword actually exists in the output
            for line in lines {
                if line.contains(keyword) {
                    return keyword.to_string();
                }
            }
        }
    }

    // Fallback: try to find any quoted text in the reason
    if let Some(start) = reason.find('"') {
        if let Some(end) = reason[start + 1..].find('"') {
            let quoted = &reason[start + 1..start + 1 + end];
            if !quoted.is_empty() {
                for line in lines {
                    if line.contains(quoted) {
                        return quoted.to_string();
                    }
                }
            }
        }
    }

    String::new()
}

/// Extract highlights from any JSON value structure.
/// Handles: arrays of highlight objects, objects with "highlights"/"issues"/"findings" fields,
/// and objects with "issue"/"severity" fields (common model deviation).
fn extract_highlights_from_value(value: &serde_json::Value) -> Vec<AIHighlight> {
    match value {
        serde_json::Value::Array(arr) => {
            // Try to parse each element as an AIHighlight
            let mut highlights = Vec::new();
            for item in arr {
                if let Ok(h) = serde_json::from_value::<AIHighlight>(item.clone()) {
                    if h.confidence >= 0.0 && h.confidence <= 1.0 {
                        highlights.push(h);
                    }
                } else {
                    // Item doesn't match our schema — try to convert from alternative format
                    if let Some(h) = convert_alt_format_to_highlight(item) {
                        highlights.push(h);
                    }
                }
            }
            highlights
        }
        serde_json::Value::Object(obj) => {
            // Check for known wrapper fields
            for key in &["highlights", "issues", "findings", "results", "problems", "errors"] {
                if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
                    let highlights = extract_highlights_from_value(&serde_json::Value::Array(arr.clone()));
                    if !highlights.is_empty() {
                        return highlights;
                    }
                }
            }
            // Single object with issue/severity — convert it directly
            if let Some(h) = convert_alt_format_to_highlight(value) {
                return vec![h];
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Convert an alternative JSON format (e.g., {"severity": "critical", "issue": "..."})
/// into our AIHighlight format. Used when models don't follow the exact schema.
fn convert_alt_format_to_highlight(value: &serde_json::Value) -> Option<AIHighlight> {
    let obj = value.as_object()?;

    // Extract the issue description from various field names
    let reason = obj.get("reason")
        .or_else(|| obj.get("issue"))
        .or_else(|| obj.get("description"))
        .or_else(|| obj.get("message"))
        .or_else(|| obj.get("detail"))
        .or_else(|| obj.get("problem"))
        .and_then(|v| v.as_str())
        .unwrap_or("Issue detected")
        .to_string();

    // Extract the matched text
    let text = obj.get("text")
        .or_else(|| obj.get("value"))
        .or_else(|| obj.get("match"))
        .or_else(|| obj.get("keyword"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Extract severity and map to highlight type
    let severity = obj.get("severity")
        .or_else(|| obj.get("type"))
        .or_else(|| obj.get("level"))
        .or_else(|| obj.get("category"))
        .and_then(|v| v.as_str())
        .unwrap_or("warning");

    let highlight_type = match severity.to_lowercase().as_str() {
        "error" | "critical" | "fatal" => HighlightType::Error,
        "warning" | "warn" | "medium" => HighlightType::Warning,
        "security" | "vulnerability" => HighlightType::Security,
        "anomaly" | "unusual" => HighlightType::Anomaly,
        "info" | "low" | "informational" => HighlightType::Info,
        s if s.contains("error") || s.contains("critical") || s.contains("down") => HighlightType::Error,
        s if s.contains("warn") => HighlightType::Warning,
        s if s.contains("security") => HighlightType::Security,
        _ => HighlightType::Warning,
    };

    let confidence = obj.get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.85);

    let line = obj.get("line")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let start = obj.get("start")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let end = obj.get("end")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| (start + text.len()) as u64) as usize;

    // Must have either a reason or text to be useful
    if reason == "Issue detected" && text.is_empty() {
        return None;
    }

    Some(AIHighlight {
        line,
        start,
        end,
        text,
        highlight_type,
        confidence,
        reason,
    })
}

/// Extract JSON content from response, handling markdown code blocks.
/// Returns the inner JSON string (array or object).
fn extract_json(response: &str) -> &str {
    let trimmed = response.trim();

    // Direct JSON array or object
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        return trimmed;
    }

    // Extract from ```json code block
    if let Some(start) = trimmed.find("```json") {
        let after_start = &trimmed[start + 7..];
        if let Some(end) = after_start.find("```") {
            return after_start[..end].trim();
        }
    }

    // Extract from generic ``` code block
    if let Some(start) = trimmed.find("```") {
        let after_start = &trimmed[start + 3..];
        if let Some(end) = after_start.find("```") {
            let body_start = after_start[..end].find('\n').map(|i| i + 1).unwrap_or(0);
            return after_start[body_start..end].trim();
        }
    }

    // Last resort: find first [ or { in the response
    if let Some(pos) = trimmed.find('[') {
        return &trimmed[pos..];
    }
    if let Some(pos) = trimmed.find('{') {
        return &trimmed[pos..];
    }

    "[]"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json() {
        // Direct JSON
        assert_eq!(extract_json("[]"), "[]");
        assert_eq!(extract_json(r#"[{"line": 0}]"#), r#"[{"line": 0}]"#);
        assert_eq!(extract_json(r#"{"issue": "test"}"#), r#"{"issue": "test"}"#);

        // With whitespace
        assert_eq!(extract_json("  []  "), "[]");

        // In markdown code block
        let markdown = r#"```json
[{"line": 0}]
```"#;
        assert_eq!(extract_json(markdown), r#"[{"line": 0}]"#);

        // Object in markdown code block
        let markdown_obj = r#"```json
{"severity": "critical", "issue": "test"}
```"#;
        assert_eq!(extract_json(markdown_obj), r#"{"severity": "critical", "issue": "test"}"#);
    }

    const SAMPLE_OUTPUT: &str = "Router#show ip bgp summary\nNeighbor        AS  State\n10.0.0.1      65001 Connect\n10.0.0.2      65002 Established";

    #[test]
    fn test_parse_ai_response_array() {
        let response = r#"[{"text": "Connect", "type": "error", "confidence": 0.95, "reason": "BGP not established"}]"#;
        let highlights = parse_ai_response(response, SAMPLE_OUTPUT);
        assert_eq!(highlights.len(), 1);
        assert_eq!(highlights[0].line, 2);
        assert_eq!(highlights[0].text, "Connect");
        assert_eq!(highlights[0].confidence, 0.95);
    }

    #[test]
    fn test_parse_resolves_positions() {
        // Model returns text but no positions
        let response = r#"[{"line":0,"start":0,"end":0,"text":"Connect","type":"error","confidence":0.9,"reason":"BGP down"}]"#;
        let highlights = parse_ai_response(response, SAMPLE_OUTPUT);
        assert_eq!(highlights.len(), 1);
        assert_eq!(highlights[0].line, 2); // Found on line 2
        assert!(highlights[0].start > 0);  // Found correct column
    }

    #[test]
    fn test_parse_alt_format_object() {
        let response = r#"{"severity": "critical", "issue": "BGP neighbor in Connect state"}"#;
        let highlights = parse_ai_response(response, SAMPLE_OUTPUT);
        assert_eq!(highlights.len(), 1);
        assert_eq!(highlights[0].text, "Connect");
        assert_eq!(highlights[0].line, 2);
    }

    #[test]
    fn test_parse_alt_format_wrapped_array() {
        let response = r#"{"issues": [{"severity": "critical", "issue": "BGP down", "text": "Connect"}]}"#;
        let highlights = parse_ai_response(response, SAMPLE_OUTPUT);
        assert_eq!(highlights.len(), 1);
        assert_eq!(highlights[0].text, "Connect");
    }

    #[test]
    fn test_parse_empty_response() {
        assert_eq!(parse_ai_response("[]", SAMPLE_OUTPUT).len(), 0);
        assert_eq!(parse_ai_response("invalid", SAMPLE_OUTPUT).len(), 0);
    }

    #[test]
    fn test_resolve_expands_to_all_occurrences() {
        let output = "Neighbor  AS  State\n10.0.0.1  65001 Connect\n10.0.0.2  65002 Connect\n10.0.0.3  65003 Established\n10.0.0.4  65004 Connect";
        let response = r#"[{"text":"Connect","type":"error","confidence":0.9,"reason":"BGP neighbors in Connect state"}]"#;
        let highlights = parse_ai_response(response, output);
        assert_eq!(highlights.len(), 3);
        assert_eq!(highlights[0].line, 1);
        assert_eq!(highlights[1].line, 2);
        assert_eq!(highlights[2].line, 4);
    }

    #[test]
    fn test_resolve_deduplicates_same_text() {
        let output = "Neighbor  AS  State\n10.0.0.1  65001 Connect\n10.0.0.2  65002 Connect";
        let response = r#"[{"text":"Connect","type":"error","confidence":0.9,"reason":"reason 1"},{"text":"Connect","type":"error","confidence":0.9,"reason":"reason 2"}]"#;
        let highlights = parse_ai_response(response, output);
        assert_eq!(highlights.len(), 2);
    }
}
