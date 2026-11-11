//! MCP (Model Context Protocol) client integration
//!
//! Enables connecting to external MCP servers to discover and invoke tools.
//! The tool_wrapper module adapts MCP tools to the agent's Tool trait for
//! seamless integration with the ReAct loop.

pub mod client;
pub mod tool_wrapper;

pub use client::{McpClientManager, McpServerConfig};
pub use tool_wrapper::McpToolWrapper;
