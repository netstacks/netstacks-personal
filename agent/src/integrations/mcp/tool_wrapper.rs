//! MCP Tool Wrapper - Adapts MCP tools to the agent Tool trait
//!
//! Allows MCP tools to be used seamlessly within the ReAct loop
//! by implementing the same Tool interface as built-in tools.

use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::tasks::tools::{Tool, ToolError, ToolOutput};
use super::McpClientManager;

/// Wrapper that exposes an MCP tool through the agent Tool trait.
///
/// MCP tools are prefixed with "mcp_{server_id}_" to avoid name collisions
/// with built-in tools. For example: "mcp_filesystem_read_file"
pub struct McpToolWrapper {
    /// Server ID this tool belongs to
    server_id: String,
    /// Original tool name from MCP server
    tool_name: String,
    /// Full prefixed name: mcp_{server_id}_{tool_name}
    full_name: String,
    /// Tool description (includes server type/name prefix for AI context)
    description: String,
    /// JSON Schema for input arguments
    input_schema: serde_json::Value,
    /// Reference to the MCP client manager for invoking tools
    manager: Arc<RwLock<McpClientManager>>,
}

impl McpToolWrapper {
    /// Create a new MCP tool wrapper
    ///
    /// # Arguments
    /// * `server_id` - ID of the MCP server providing this tool
    /// * `server_name` - Human-readable name of the MCP server
    /// * `server_type` - Category of the server (search, database, filesystem, etc.)
    /// * `tool_name` - Original name of the tool on the MCP server
    /// * `description` - Human-readable description of what the tool does
    /// * `input_schema` - JSON Schema for the tool's input arguments
    /// * `manager` - Reference to the MCP client manager
    pub fn new(
        server_id: String,
        server_name: String,
        server_type: String,
        tool_name: String,
        description: Option<String>,
        input_schema: serde_json::Value,
        manager: Arc<RwLock<McpClientManager>>,
    ) -> Self {
        // Sanitize full_name to match Anthropic's tool name pattern: ^[a-zA-Z0-9_-]{1,128}$
        // Replace colons and any other invalid chars with underscores
        let full_name = format!("mcp_{}_{}", server_id, tool_name)
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect::<String>();
        // Truncate to 128 chars max
        let full_name = if full_name.len() > 128 { full_name[..128].to_string() } else { full_name };
        let base_desc = description.unwrap_or_else(|| "MCP tool".to_string());
        let description = format!("[MCP:{} - {}] {}", server_type, server_name, base_desc);
        Self {
            server_id,
            tool_name,
            full_name,
            description,
            input_schema,
            manager,
        }
    }

    /// Get the server ID this tool belongs to (test-only accessor).
    #[cfg(test)]
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    /// Get the original tool name without prefix (test-only accessor).
    #[cfg(test)]
    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }
}

#[async_trait]
impl Tool for McpToolWrapper {
    fn name(&self) -> &str {
        &self.full_name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> serde_json::Value {
        self.input_schema.clone()
    }

    async fn execute(&self, input: serde_json::Value, task_id: &str) -> Result<ToolOutput, ToolError> {
        tracing::info!(
            task_id = %task_id,
            tool = %self.full_name,
            server_id = %self.server_id,
            "Executing MCP tool"
        );

        // AUDIT FIX (EXEC-008): validate AI-supplied arguments against the
        // tool's `input_schema` before forwarding to the MCP server. The
        // model used to be able to send any JSON shape it wanted — extra
        // fields a community MCP server might silently honour, missing
        // required fields, wrong types, etc. We now:
        //   - Reject inputs that aren't a JSON object when the schema
        //     declares object type.
        //   - Reject required fields that are missing or null.
        //   - Reject extra properties not declared in `properties`
        //     (closed-world). MCP servers can still relax this by
        //     declaring `additionalProperties: true` in their schema.
        //   - Audit-log every block.
        if let Err(e) = validate_against_schema(&input, &self.input_schema) {
            tracing::warn!(
                target: "audit",
                task_id = %task_id,
                tool = %self.full_name,
                violation = %e,
                "MCP tool argument schema violation — refused"
            );
            return Err(ToolError::InvalidInput(format!(
                "argument schema violation for {}: {}",
                self.full_name, e
            )));
        }

        // Get read lock on manager and call tool
        let manager = self.manager.read().await;

        let result = manager
            .call_tool(&self.server_id, &self.tool_name, input)
            .await
            .map_err(|e| {
                tracing::error!(
                    task_id = %task_id,
                    tool = %self.full_name,
                    error = %e,
                    "MCP tool call failed"
                );
                ToolError::ExecutionFailed(e.to_string())
            })?;

        // Extract text content from MCP response
        // Content is Annotated<RawContent>, which derefs to RawContent
        // RawContent has as_text() method to get text content
        let output_text: String = result
            .content
            .iter()
            .filter_map(|c| {
                // Use Deref to access RawContent methods
                c.as_text().map(|text_content| text_content.text.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n");

        // Check if the MCP call reported an error
        if result.is_error.unwrap_or(false) {
            tracing::warn!(
                task_id = %task_id,
                tool = %self.full_name,
                "MCP tool returned error"
            );
            Ok(ToolOutput::failure(output_text))
        } else {
            tracing::debug!(
                task_id = %task_id,
                tool = %self.full_name,
                output_len = output_text.len(),
                "MCP tool executed successfully"
            );
            Ok(ToolOutput::success(serde_json::json!({
                "result": output_text
            })))
        }
    }
}

/// AUDIT FIX (EXEC-008): minimal JSON-Schema-style validator for the
/// subset of features MCP tool input schemas typically use.
///
/// Honours: `type` (object/string/number/boolean/array), `required`
/// (array of property names), `properties` (closed-world unless
/// `additionalProperties: true`).
///
/// Anything more elaborate (oneOf, pattern, format, etc.) is currently
/// passed through — those are concerns the MCP server itself should
/// validate. This validator's job is to refuse the obviously-wrong shapes
/// that prompt-injected LLMs emit.
fn validate_against_schema(input: &serde_json::Value, schema: &serde_json::Value) -> Result<(), String> {
    let schema_obj = match schema.as_object() {
        Some(o) => o,
        None => return Ok(()), // unschemated — nothing to enforce
    };

    let declared_type = schema_obj.get("type").and_then(|v| v.as_str()).unwrap_or("object");

    match declared_type {
        "object" => {
            let input_obj = match input.as_object() {
                Some(o) => o,
                None => return Err("expected object".to_string()),
            };
            // required
            if let Some(required) = schema_obj.get("required").and_then(|v| v.as_array()) {
                for r in required {
                    if let Some(name) = r.as_str() {
                        match input_obj.get(name) {
                            None | Some(serde_json::Value::Null) => {
                                return Err(format!("required property '{}' missing", name));
                            }
                            _ => {}
                        }
                    }
                }
            }
            // closed-world properties (default true unless schema explicitly
            // declares additionalProperties: true)
            let allow_extra = schema_obj
                .get("additionalProperties")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !allow_extra {
                if let Some(props) = schema_obj.get("properties").and_then(|v| v.as_object()) {
                    for key in input_obj.keys() {
                        if !props.contains_key(key) {
                            return Err(format!(
                                "unexpected property '{}' (not in schema; \
                                 set additionalProperties:true to allow)",
                                key
                            ));
                        }
                    }
                }
            }
            // recurse into nested properties
            if let Some(props) = schema_obj.get("properties").and_then(|v| v.as_object()) {
                for (key, sub_schema) in props {
                    if let Some(sub_value) = input_obj.get(key) {
                        validate_against_schema(sub_value, sub_schema)
                            .map_err(|e| format!("at '{}': {}", key, e))?;
                    }
                }
            }
            Ok(())
        }
        "string" => input.as_str().map(|_| ()).ok_or_else(|| "expected string".to_string()),
        "number" | "integer" => input.as_f64().map(|_| ()).ok_or_else(|| "expected number".to_string()),
        "boolean" => input.as_bool().map(|_| ()).ok_or_else(|| "expected boolean".to_string()),
        "array" => input.as_array().map(|_| ()).ok_or_else(|| "expected array".to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_full_name_format() {
        let manager = Arc::new(RwLock::new(McpClientManager::new()));
        let wrapper = McpToolWrapper::new(
            "filesystem".to_string(),
            "Filesystem Server".to_string(),
            "filesystem".to_string(),
            "read_file".to_string(),
            Some("Read a file".to_string()),
            serde_json::json!({"type": "object"}),
            manager,
        );

        assert_eq!(wrapper.name(), "mcp_filesystem_read_file");
        assert_eq!(wrapper.server_id(), "filesystem");
        assert_eq!(wrapper.tool_name(), "read_file");
        assert_eq!(wrapper.description(), "[MCP:filesystem - Filesystem Server] Read a file");
    }

    #[test]
    fn test_default_description() {
        let manager = Arc::new(RwLock::new(McpClientManager::new()));
        let wrapper = McpToolWrapper::new(
            "server".to_string(),
            "My Server".to_string(),
            "custom".to_string(),
            "tool".to_string(),
            None,
            serde_json::json!({}),
            manager,
        );

        assert_eq!(wrapper.description(), "[MCP:custom - My Server] MCP tool");
    }
}
