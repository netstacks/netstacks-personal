//! Device Query Tool - Query network devices by filter criteria

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use tracing::info;

use super::{Tool, ToolError, ToolOutput};

/// Tool for querying network devices by criteria
pub struct DeviceQueryTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize, Default)]
struct DeviceQueryInput {
    vendor: Option<String>,
    site: Option<String>,
    role: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct DeviceInfo {
    session_id: String,
    name: String,
    host: String,
    cli_flavor: Option<String>,
}

/// Maximum devices to return (prevent context explosion)
const MAX_RESULTS: usize = 50;

impl DeviceQueryTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Build SQL query with dynamic filters
    fn build_query(params: &DeviceQueryInput) -> (String, Vec<String>) {
        let mut query = String::from(
            r#"
            SELECT
                s.id as session_id,
                s.name,
                s.host,
                s.cli_flavor
            FROM sessions s
            WHERE 1=1
            "#,
        );

        let mut param_values: Vec<String> = Vec::new();

        // Filter by cli_flavor as vendor proxy (e.g., cisco-ios, juniper, arista)
        if let Some(ref vendor) = params.vendor {
            query.push_str(" AND LOWER(s.cli_flavor) LIKE LOWER(?)");
            param_values.push(format!("%{}%", vendor));
        }

        // Filter by name (partial match)
        if let Some(ref name) = params.name {
            query.push_str(" AND LOWER(s.name) LIKE LOWER(?)");
            param_values.push(format!("%{}%", name));
        }

        // Site and role: search in session name as heuristic
        // In the future, these could be stored as separate columns or in metadata
        if let Some(ref site) = params.site {
            query.push_str(" AND LOWER(s.name) LIKE LOWER(?)");
            param_values.push(format!("%{}%", site));
        }

        if let Some(ref role) = params.role {
            query.push_str(" AND LOWER(s.name) LIKE LOWER(?)");
            param_values.push(format!("%{}%", role));
        }

        query.push_str(&format!(" ORDER BY s.name LIMIT {}", MAX_RESULTS + 1));

        (query, param_values)
    }
}

#[async_trait]
impl Tool for DeviceQueryTool {
    fn name(&self) -> &str {
        "query_devices"
    }

    fn description(&self) -> &str {
        "Query network devices by filter criteria (vendor, site, role, name). \
         Returns devices with session IDs that can be used with execute_ssh_command. \
         Results are limited to 50 devices - use filters to narrow down."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "vendor": {
                    "type": "string",
                    "description": "Filter by vendor/CLI flavor (e.g., 'cisco', 'juniper', 'arista')"
                },
                "site": {
                    "type": "string",
                    "description": "Filter by site name (searches in device name)"
                },
                "role": {
                    "type": "string",
                    "description": "Filter by device role (e.g., 'router', 'switch', 'firewall')"
                },
                "name": {
                    "type": "string",
                    "description": "Filter by device name (partial match)"
                }
            },
            "additionalProperties": false
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: DeviceQueryInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!(
            task_id = %task_id,
            vendor = ?params.vendor,
            site = ?params.site,
            role = ?params.role,
            name = ?params.name,
            "Device query tool invoked"
        );

        let (query, param_values) = Self::build_query(&params);

        // Execute query with dynamic parameters
        let mut sql_query = sqlx::query_as::<_, DeviceInfo>(&query);
        for param in &param_values {
            sql_query = sql_query.bind(param);
        }

        let devices: Vec<DeviceInfo> = sql_query
            .fetch_all(&self.pool)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("Query failed: {}", e)))?;

        let truncated = devices.len() > MAX_RESULTS;
        let result_count = std::cmp::min(devices.len(), MAX_RESULTS);
        let devices: Vec<DeviceInfo> = devices.into_iter().take(MAX_RESULTS).collect();

        // Transform for output with vendor derived from cli_flavor
        let output_devices: Vec<serde_json::Value> = devices
            .into_iter()
            .map(|d| {
                // Derive vendor from cli_flavor for clearer output
                let vendor = d.cli_flavor.as_ref().map(|f| {
                    if f.contains("cisco") {
                        "cisco"
                    } else if f.contains("juniper") {
                        "juniper"
                    } else if f.contains("arista") {
                        "arista"
                    } else if f.contains("paloalto") {
                        "paloalto"
                    } else if f.contains("fortinet") {
                        "fortinet"
                    } else {
                        f.as_str()
                    }
                });

                json!({
                    "session_id": d.session_id,
                    "name": d.name,
                    "host": d.host,
                    "vendor": vendor,
                    "cli_flavor": d.cli_flavor,
                    // Echo back filters for context (helps agent understand results)
                    "site_filter": params.site,
                    "role_filter": params.role,
                })
            })
            .collect();

        info!(
            task_id = %task_id,
            count = result_count,
            truncated = truncated,
            "Device query completed"
        );

        Ok(ToolOutput {
            success: true,
            output: json!({
                "count": result_count,
                "truncated": truncated,
                "devices": output_devices,
                "note": if truncated {
                    Some("Results limited to 50 devices. Use more specific filters to narrow down.")
                } else if result_count == 0 {
                    Some("No devices found matching the filter criteria.")
                } else {
                    None
                }
            }),
            error: None,
        })
    }
}
