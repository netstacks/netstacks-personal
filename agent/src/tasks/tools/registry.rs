//! Tool registry for dynamic tool lookup
//!
//! Provides a central registry where tools can be registered and looked up
//! by name for agent invocation.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::SharedTool;

/// Definition of a tool for listing/discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Unique name of the tool
    pub name: String,
    /// Human-readable description
    pub description: String,
    /// JSON Schema for input arguments
    pub input_schema: serde_json::Value,
}

/// Registry for tools that can be invoked by agents
///
/// Provides registration, lookup, and listing of available tools.
pub struct ToolRegistry {
    tools: HashMap<String, SharedTool>,
}

impl ToolRegistry {
    /// Create a new empty tool registry
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a tool in the registry
    ///
    /// The tool is registered by its name. If a tool with the same name
    /// already exists, it will be replaced.
    pub fn register(&mut self, tool: SharedTool) {
        let name = tool.name().to_string();
        self.tools.insert(name, tool);
    }

    /// Get a tool by name
    ///
    /// Returns None if no tool with that name is registered.
    pub fn get(&self, name: &str) -> Option<SharedTool> {
        self.tools.get(name).cloned()
    }

    /// List all registered tools with their definitions
    ///
    /// Returns a vector of ToolDefinition structs containing
    /// name, description, and input schema for each tool.
    pub fn list_tools(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|tool| ToolDefinition {
                name: tool.name().to_string(),
                description: tool.description().to_string(),
                input_schema: tool.input_schema(),
            })
            .collect()
    }

    /// Check if a tool is registered
    pub fn _has_tool(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Get the number of registered tools
    pub fn _len(&self) -> usize {
        self.tools.len()
    }

    /// Check if the registry is empty
    pub fn _is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::Tool;
    use async_trait::async_trait;
    use std::sync::Arc;

    struct TestTool {
        name: String,
    }

    #[async_trait]
    impl Tool for TestTool {
        fn name(&self) -> &str {
            &self.name
        }

        fn description(&self) -> &str {
            "A test tool"
        }

        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({
                "type": "object",
                "properties": {
                    "input": { "type": "string" }
                }
            })
        }

        async fn execute(
            &self,
            _input: serde_json::Value,
            _task_id: &str,
        ) -> Result<super::super::ToolOutput, super::super::ToolError> {
            Ok(super::super::ToolOutput::success(serde_json::json!({"result": "ok"})))
        }
    }

    #[test]
    fn test_register_and_get() {
        let mut registry = ToolRegistry::new();
        let tool = Arc::new(TestTool {
            name: "test_tool".to_string(),
        });

        registry.register(tool.clone());

        assert!(registry._has_tool("test_tool"));
        assert!(registry.get("test_tool").is_some());
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn test_list_tools() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(TestTool {
            name: "tool1".to_string(),
        }));
        registry.register(Arc::new(TestTool {
            name: "tool2".to_string(),
        }));

        let tools = registry.list_tools();
        assert_eq!(tools.len(), 2);

        let names: Vec<_> = tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"tool1"));
        assert!(names.contains(&"tool2"));
    }
}
