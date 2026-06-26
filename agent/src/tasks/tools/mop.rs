//! MOP (Method of Procedure) Tools - AI-callable operations for MOP plan and execution management
//!
//! Provides tools for:
//! - Plan management: create, list, get, add/edit/remove steps
//! - Execution control: execute step, execute phase, pause, abort
//! - Analysis: analyze output, compare snapshots, get status

use async_trait::async_trait;
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use sqlx::sqlite::SqlitePool;
use tracing::info;

use super::{Tool, ToolError, ToolOutput};

// =============================================================================
// Plan Management Tool — CRUD operations on MOP plans
// =============================================================================

pub struct MopPlanTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct MopPlanInput {
    action: String, // create, list, get, add_steps, edit_step, remove_steps, export, import
    plan_id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    steps: Option<Vec<StepInput>>,
    _step_id: Option<String>,
    _command: Option<String>,
    _step_type: Option<String>,
    package_json: Option<String>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
struct StepInput {
    step_type: String,
    command: String,
    description: Option<String>,
    expected_output: Option<String>,
}

impl MopPlanTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Tool for MopPlanTool {
    fn name(&self) -> &str {
        "mop_plan"
    }

    fn description(&self) -> &str {
        "Manage MOP (Method of Procedure) plans. Create plans, add steps, list plans, \
         or modify existing plans. Plans define reusable network change procedures \
         with pre-checks, changes, post-checks, and rollback steps."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "list", "get", "add_steps", "edit_step", "remove_steps", "export", "import"],
                    "description": "Action to perform: create a new plan, list all plans, get a specific plan, add steps, edit a step, remove steps, export as JSON package, or import from JSON package"
                },
                "plan_id": {
                    "type": "string",
                    "description": "Plan ID (required for get, add_steps, edit_step, remove_steps)"
                },
                "name": {
                    "type": "string",
                    "description": "Plan name (required for create)"
                },
                "description": {
                    "type": "string",
                    "description": "Plan description (optional for create)"
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "step_type": { "type": "string", "enum": ["pre_check", "change", "post_check", "rollback"] },
                            "command": { "type": "string" },
                            "description": { "type": "string" },
                            "expected_output": { "type": "string" }
                        },
                        "required": ["step_type", "command"]
                    },
                    "description": "Steps to add (for create or add_steps)"
                },
                "step_id": {
                    "type": "string",
                    "description": "Step ID to edit or remove"
                },
                "command": {
                    "type": "string",
                    "description": "New command text (for edit_step)"
                },
                "step_type": {
                    "type": "string",
                    "description": "New step type (for edit_step)"
                },
                "package_json": {
                    "type": "string",
                    "description": "JSON string of a MOP package to import (for import action)"
                }
            },
            "required": ["action"]
        })
    }

    async fn execute(&self, input: serde_json::Value, task_id: &str) -> Result<ToolOutput, ToolError> {
        let params: MopPlanInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!("[Task {}] MOP plan tool: action={}", task_id, params.action);

        match params.action.as_str() {
            "create" => {
                let name = params.name.unwrap_or_else(|| "Untitled MOP".to_string());
                let id = uuid::Uuid::new_v4().to_string();

                let steps_json = if let Some(steps) = &params.steps {
                    serde_json::to_string(steps).unwrap_or_else(|_| "[]".to_string())
                } else {
                    "[]".to_string()
                };

                sqlx::query(
                    "INSERT INTO changes (id, name, description, mop_steps, created_by) VALUES (?, ?, ?, ?, 'ai')"
                )
                .bind(&id)
                .bind(&name)
                .bind(params.description.as_deref())
                .bind(&steps_json)
                .execute(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to create plan: {}", e)))?;

                Ok(ToolOutput::success(json!({
                    "plan_id": id,
                    "name": name,
                    "message": "MOP plan created successfully"
                })))
            }

            "list" => {
                let plans: Vec<(String, String, String, String)> = sqlx::query_as(
                    "SELECT id, name, status, created_at FROM changes ORDER BY updated_at DESC LIMIT 20"
                )
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to list plans: {}", e)))?;

                let results: Vec<serde_json::Value> = plans
                    .iter()
                    .map(|(id, name, status, created_at)| {
                        json!({
                            "id": id,
                            "name": name,
                            "status": status,
                            "created_at": created_at,
                        })
                    })
                    .collect();

                Ok(ToolOutput::success(json!({
                    "plans": results,
                    "count": results.len()
                })))
            }

            "get" => {
                let plan_id = params.plan_id.ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;

                let plan: Option<(String, String, Option<String>, String, String, String)> = sqlx::query_as(
                    "SELECT id, name, description, status, mop_steps, created_at FROM changes WHERE id = ?"
                )
                .bind(&plan_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get plan: {}", e)))?;

                match plan {
                    Some((id, name, desc, status, steps_json, created_at)) => {
                        let steps: serde_json::Value = serde_json::from_str(&steps_json).unwrap_or(json!([]));
                        Ok(ToolOutput::success(json!({
                            "id": id,
                            "name": name,
                            "description": desc,
                            "status": status,
                            "steps": steps,
                            "created_at": created_at,
                        })))
                    }
                    None => Ok(ToolOutput::failure(format!("Plan {} not found", plan_id))),
                }
            }

            "add_steps" => {
                let plan_id = params.plan_id.ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;
                let new_steps = params.steps.ok_or_else(|| ToolError::InvalidInput("steps required".into()))?;

                // Get existing steps
                let existing: Option<(String,)> = sqlx::query_as(
                    "SELECT mop_steps FROM changes WHERE id = ?"
                )
                .bind(&plan_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get plan: {}", e)))?;

                let existing = existing.ok_or_else(|| ToolError::ExecutionFailed(format!("Plan {} not found", plan_id)))?;
                let mut steps: Vec<serde_json::Value> = serde_json::from_str(&existing.0).unwrap_or_default();

                for s in &new_steps {
                    steps.push(json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "type": s.step_type,
                        "command": s.command,
                        "description": s.description,
                        "expected_output": s.expected_output,
                    }));
                }

                let steps_json = serde_json::to_string(&steps).unwrap_or_else(|_| "[]".to_string());
                sqlx::query("UPDATE changes SET mop_steps = ?, updated_at = datetime('now') WHERE id = ?")
                    .bind(&steps_json)
                    .bind(&plan_id)
                    .execute(&self.pool)
                    .await
                    .map_err(|e| ToolError::ExecutionFailed(format!("Failed to update plan: {}", e)))?;

                Ok(ToolOutput::success(json!({
                    "added": new_steps.len(),
                    "total_steps": steps.len(),
                    "message": format!("Added {} steps to plan", new_steps.len())
                })))
            }

            "edit_step" | "remove_steps" => {
                Ok(ToolOutput::success(json!({
                    "message": format!("Action '{}' acknowledged — use the MOP workspace UI for step editing", params.action)
                })))
            }

            "export" => {
                let plan_id = params.plan_id.ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;

                let plan: Option<(String, String, Option<String>, String, String, String)> = sqlx::query_as(
                    "SELECT id, name, description, status, mop_steps, created_by FROM changes WHERE id = ?"
                )
                .bind(&plan_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get plan: {}", e)))?;

                match plan {
                    Some((_id, name, desc, _status, steps_json, author)) => {
                        let steps: Vec<serde_json::Value> = serde_json::from_str(&steps_json).unwrap_or_default();
                        let pkg_steps: Vec<serde_json::Value> = steps.iter().enumerate().map(|(i, s)| {
                            json!({
                                "order": s.get("order").and_then(|v| v.as_i64()).unwrap_or(i as i64 + 1),
                                "step_type": s.get("type").or_else(|| s.get("step_type")).and_then(|v| v.as_str()).unwrap_or("change"),
                                "command": s.get("command").and_then(|v| v.as_str()).unwrap_or(""),
                                "description": s.get("description").and_then(|v| v.as_str()),
                                "expected_output": s.get("expected_output").and_then(|v| v.as_str()),
                                "execution_source": s.get("execution_source").and_then(|v| v.as_str()),
                                "quick_action_id": s.get("quick_action_id").and_then(|v| v.as_str()),
                                "quick_action_variables": s.get("quick_action_variables"),
                                "script_id": s.get("script_id").and_then(|v| v.as_str()),
                                "script_args": s.get("script_args"),
                                "paired_step_id": s.get("paired_step_id").and_then(|v| v.as_str()),
                                "output_format": s.get("output_format").and_then(|v| v.as_str()),
                            })
                        }).collect();

                        let package = json!({
                            "format": "netstacks-mop",
                            "version": "1.0",
                            "exported_at": Utc::now().to_rfc3339(),
                            "source": "NetStacks Terminal AI",
                            "mop": {
                                "name": name,
                                "description": desc,
                                "author": author,
                                "steps": pkg_steps,
                            },
                            "metadata": {
                                "tags": [],
                                "platform_hints": [],
                                "lineage": { "revision": 1 },
                                "review": { "reviewers": [], "comments": [] },
                                "custom": {},
                            }
                        });

                        Ok(ToolOutput::success(json!({
                            "package": package,
                            "message": format!("MOP '{}' exported as JSON package ({} steps)", name, pkg_steps.len())
                        })))
                    }
                    None => Ok(ToolOutput::failure(format!("Plan {} not found", plan_id))),
                }
            }

            "import" => {
                let pkg_json = params.package_json.ok_or_else(|| ToolError::InvalidInput("package_json required".into()))?;
                let pkg: serde_json::Value = serde_json::from_str(&pkg_json)
                    .map_err(|e| ToolError::InvalidInput(format!("Invalid package JSON: {}", e)))?;

                let format = pkg.get("format").and_then(|v| v.as_str()).unwrap_or("");
                if format != "netstacks-mop" {
                    return Err(ToolError::InvalidInput(format!("Unknown format: '{}', expected 'netstacks-mop'", format)));
                }

                let mop = pkg.get("mop").ok_or_else(|| ToolError::InvalidInput("Missing 'mop' field in package".into()))?;
                let name = mop.get("name").and_then(|v| v.as_str()).unwrap_or("Imported MOP").to_string();
                let description = mop.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                let pkg_steps = mop.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();

                if pkg_steps.is_empty() {
                    return Err(ToolError::InvalidInput("Package has no steps".into()));
                }

                // Convert package steps to MOP steps with new UUIDs
                let mut mop_steps: Vec<serde_json::Value> = Vec::new();
                for s in &pkg_steps {
                    mop_steps.push(json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "order": s.get("order").and_then(|v| v.as_i64()).unwrap_or(mop_steps.len() as i64 + 1),
                        "type": s.get("step_type").and_then(|v| v.as_str()).unwrap_or("change"),
                        "step_type": s.get("step_type").and_then(|v| v.as_str()).unwrap_or("change"),
                        "command": s.get("command").and_then(|v| v.as_str()).unwrap_or(""),
                        "description": s.get("description").and_then(|v| v.as_str()),
                        "expected_output": s.get("expected_output").and_then(|v| v.as_str()),
                        "status": "pending",
                        "execution_source": s.get("execution_source").and_then(|v| v.as_str()),
                        "quick_action_id": s.get("quick_action_id").and_then(|v| v.as_str()),
                        "quick_action_variables": s.get("quick_action_variables"),
                        "script_id": s.get("script_id").and_then(|v| v.as_str()),
                        "script_args": s.get("script_args"),
                        "paired_step_id": s.get("paired_step_id").and_then(|v| v.as_str()),
                        "output_format": s.get("output_format").and_then(|v| v.as_str()),
                    }));
                }

                let id = uuid::Uuid::new_v4().to_string();
                let steps_json = serde_json::to_string(&mop_steps).unwrap_or_else(|_| "[]".to_string());

                sqlx::query(
                    "INSERT INTO changes (id, name, description, mop_steps, created_by) VALUES (?, ?, ?, ?, 'ai-import')"
                )
                .bind(&id)
                .bind(&name)
                .bind(description.as_deref())
                .bind(&steps_json)
                .execute(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to import plan: {}", e)))?;

                Ok(ToolOutput::success(json!({
                    "plan_id": id,
                    "name": name,
                    "steps_imported": mop_steps.len(),
                    "message": format!("MOP '{}' imported successfully ({} steps)", name, mop_steps.len())
                })))
            }

            _ => Err(ToolError::InvalidInput(format!("Unknown action: {}", params.action))),
        }
    }
}

// =============================================================================
// Execution Control Tool — Run steps, phases, pause, abort
// =============================================================================

pub struct MopExecutionTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct MopExecutionInput {
    action: String, // get_status, list, execute_step, execute_phase, pause, abort
    execution_id: Option<String>,
    _step_id: Option<String>,
    _phase: Option<String>,
}

impl MopExecutionTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Tool for MopExecutionTool {
    fn name(&self) -> &str {
        "mop_execution"
    }

    fn description(&self) -> &str {
        "Control MOP execution. Get execution status, list executions, or retrieve step results. \
         Use the MOP workspace UI to actually run steps — this tool provides status and results."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["get_status", "list"],
                    "description": "Action: get_status for a specific execution, list for all executions"
                },
                "execution_id": {
                    "type": "string",
                    "description": "Execution ID (required for get_status)"
                }
            },
            "required": ["action"]
        })
    }

    async fn execute(&self, input: serde_json::Value, task_id: &str) -> Result<ToolOutput, ToolError> {
        let params: MopExecutionInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!("[Task {}] MOP execution tool: action={}", task_id, params.action);

        match params.action.as_str() {
            "list" => {
                let executions: Vec<(String, String, String, String, String)> = sqlx::query_as(
                    "SELECT id, name, status, control_mode, created_at FROM mop_executions ORDER BY created_at DESC LIMIT 20"
                )
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to list executions: {}", e)))?;

                let results: Vec<serde_json::Value> = executions.iter().map(|(id, name, status, mode, created)| {
                    json!({ "id": id, "name": name, "status": status, "control_mode": mode, "created_at": created })
                }).collect();

                Ok(ToolOutput::success(json!({ "executions": results, "count": results.len() })))
            }

            "get_status" => {
                let exec_id = params.execution_id.ok_or_else(|| ToolError::InvalidInput("execution_id required".into()))?;

                let exec: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
                    "SELECT id, name, status, control_mode, current_phase, started_at, completed_at FROM mop_executions WHERE id = ?"
                )
                .bind(&exec_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get execution: {}", e)))?;

                match exec {
                    Some((id, name, status, mode, phase, started, completed)) => {
                        // Get device count and step results
                        let device_count: (i64,) = sqlx::query_as(
                            "SELECT COUNT(*) FROM mop_execution_devices WHERE execution_id = ?"
                        )
                        .bind(&id)
                        .fetch_one(&self.pool)
                        .await
                        .unwrap_or((0,));

                        let step_counts: Vec<(String, i64)> = sqlx::query_as(
                            "SELECT s.status, COUNT(*) FROM mop_execution_steps s \
                             JOIN mop_execution_devices d ON s.execution_device_id = d.id \
                             WHERE d.execution_id = ? GROUP BY s.status"
                        )
                        .bind(&id)
                        .fetch_all(&self.pool)
                        .await
                        .unwrap_or_default();

                        let step_summary: serde_json::Value = step_counts.iter()
                            .map(|(status, count)| (status.clone(), json!(count)))
                            .collect::<serde_json::Map<String, serde_json::Value>>()
                            .into();

                        Ok(ToolOutput::success(json!({
                            "id": id,
                            "name": name,
                            "status": status,
                            "control_mode": mode,
                            "current_phase": phase,
                            "started_at": started,
                            "completed_at": completed,
                            "device_count": device_count.0,
                            "step_summary": step_summary,
                        })))
                    }
                    None => Ok(ToolOutput::failure(format!("Execution {} not found", exec_id))),
                }
            }

            _ => Err(ToolError::InvalidInput(format!("Unknown action: {}", params.action))),
        }
    }
}

// =============================================================================
// Analysis Tool — Analyze outputs, compare snapshots, generate documents
// =============================================================================

pub struct MopAnalysisTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct MopAnalysisInput {
    action: String, // analyze_output, get_step_results, get_device_results
    execution_id: String,
    device_id: Option<String>,
    _step_id: Option<String>,
}

impl MopAnalysisTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl Tool for MopAnalysisTool {
    fn name(&self) -> &str {
        "mop_analysis"
    }

    fn description(&self) -> &str {
        "Analyze MOP execution results. Get step outputs, device results, and compare \
         pre/post snapshots. Use this to review what happened during a MOP execution."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["get_step_results", "get_device_results"],
                    "description": "Action: get_step_results for step-level details, get_device_results for device-level summary"
                },
                "execution_id": {
                    "type": "string",
                    "description": "Execution ID to analyze"
                },
                "device_id": {
                    "type": "string",
                    "description": "Specific device ID (optional, for filtering)"
                }
            },
            "required": ["action", "execution_id"]
        })
    }

    async fn execute(&self, input: serde_json::Value, task_id: &str) -> Result<ToolOutput, ToolError> {
        let params: MopAnalysisInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!("[Task {}] MOP analysis tool: action={}", task_id, params.action);

        match params.action.as_str() {
            "get_device_results" => {
                let devices: Vec<(String, Option<String>, Option<String>, String, Option<String>, Option<String>)> = sqlx::query_as(
                    "SELECT id, device_name, device_host, status, started_at, completed_at \
                     FROM mop_execution_devices WHERE execution_id = ? ORDER BY device_order"
                )
                .bind(&params.execution_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get devices: {}", e)))?;

                let results: Vec<serde_json::Value> = devices.iter().map(|(id, name, host, status, started, completed)| {
                    json!({
                        "id": id,
                        "device_name": name,
                        "device_host": host,
                        "status": status,
                        "started_at": started,
                        "completed_at": completed,
                    })
                }).collect();

                Ok(ToolOutput::success(json!({ "devices": results })))
            }

            "get_step_results" => {
                let query = if let Some(ref dev_id) = params.device_id {
                    sqlx::query_as::<_, (String, String, String, String, String, Option<String>, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)>(
                        "SELECT s.id, s.step_type, s.command, s.status, COALESCE(s.output, ''), s.ai_feedback, s.duration_ms, \
                         s.execution_source, s.quick_action_id, s.script_id, s.paired_step_id, s.output_format \
                         FROM mop_execution_steps s \
                         WHERE s.execution_device_id = ? ORDER BY s.step_order"
                    )
                    .bind(dev_id)
                    .fetch_all(&self.pool)
                    .await
                } else {
                    sqlx::query_as::<_, (String, String, String, String, String, Option<String>, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)>(
                        "SELECT s.id, s.step_type, s.command, s.status, COALESCE(s.output, ''), s.ai_feedback, s.duration_ms, \
                         s.execution_source, s.quick_action_id, s.script_id, s.paired_step_id, s.output_format \
                         FROM mop_execution_steps s \
                         JOIN mop_execution_devices d ON s.execution_device_id = d.id \
                         WHERE d.execution_id = ? ORDER BY d.device_order, s.step_order"
                    )
                    .bind(&params.execution_id)
                    .fetch_all(&self.pool)
                    .await
                };

                let steps = query.map_err(|e| ToolError::ExecutionFailed(format!("Failed to get steps: {}", e)))?;

                let results: Vec<serde_json::Value> = steps.iter().map(|(id, stype, cmd, status, output, feedback, duration, exec_source, qa_id, script_id, paired_id, out_fmt)| {
                    json!({
                        "id": id,
                        "step_type": stype,
                        "command": cmd,
                        "status": status,
                        "output": if output.len() > 1000 { &output[..1000] } else { output.as_str() },
                        "ai_feedback": feedback,
                        "duration_ms": duration,
                        "execution_source": exec_source,
                        "quick_action_id": qa_id,
                        "script_id": script_id,
                        "paired_step_id": paired_id,
                        "output_format": out_fmt,
                    })
                }).collect();

                Ok(ToolOutput::success(json!({ "steps": results, "count": results.len() })))
            }

            _ => Err(ToolError::InvalidInput(format!("Unknown action: {}", params.action))),
        }
    }
}
