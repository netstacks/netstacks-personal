//! Integrations module for external service connections
//!
//! Provides clients and configuration for MCP (Model Context Protocol) servers,
//! SMTP email services, and other external integrations.

pub mod mcp;
pub mod smtp;

pub use mcp::{McpClientManager, McpServerConfig, McpToolWrapper};
pub use smtp::{EmailService, SmtpConfig};
