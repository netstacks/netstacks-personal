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

use crate::models::{MopStep, MopVariable};

use super::{Tool, ToolError, ToolOutput};

// =============================================================================
// Plan Management Tool — CRUD operations on MOP plans
// =============================================================================

pub struct MopPlanTool {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
struct MopPlanInput {
    action: String, // create, list, get, add_steps, edit_step, remove_steps, set_variables, export, import
    plan_id: Option<String>,
    name: Option<String>,
    /// Plan description (create) or new step description (edit_step).
    description: Option<String>,
    steps: Option<Vec<StepInput>>,
    /// Plan-level `{{name}}` variables (create / set_variables).
    variables: Option<Vec<VariableInput>>,
    step_id: Option<String>,
    step_ids: Option<Vec<String>>,
    command: Option<String>,
    step_type: Option<String>,
    expected_output: Option<String>,
    package_json: Option<String>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
struct StepInput {
    step_type: String,
    command: String,
    description: Option<String>,
    expected_output: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VariableInput {
    name: String,
    value: Option<String>,
    description: Option<String>,
    required: Option<bool>,
}

/// Validate and convert tool variable inputs into stored `MopVariable`s
/// (same rules as `POST /changes`: valid, unique names).
fn build_variables(inputs: &[VariableInput]) -> Result<Vec<MopVariable>, ToolError> {
    let mut out: Vec<MopVariable> = Vec::with_capacity(inputs.len());
    for v in inputs {
        if !MopVariable::is_valid_name(&v.name) {
            return Err(ToolError::InvalidInput(format!(
                "Invalid variable name '{}': use letters, digits and '_', not starting with a digit (device.* is reserved)",
                v.name
            )));
        }
        if out.iter().any(|existing| existing.name == v.name) {
            return Err(ToolError::InvalidInput(format!(
                "Variable '{}' is declared more than once",
                v.name
            )));
        }
        out.push(MopVariable {
            name: v.name.clone(),
            value: v.value.clone().unwrap_or_default(),
            description: v.description.clone().filter(|d| !d.trim().is_empty()),
            required: v.required.unwrap_or(false),
        });
    }
    Ok(out)
}

/// Step types the Change model / execution engine understands.
const STEP_TYPES: [&str; 5] = [
    "pre_check",
    "change",
    "post_check",
    "rollback",
    "api_action",
];

fn validate_step_type(step_type: &str) -> Result<(), ToolError> {
    if STEP_TYPES.contains(&step_type) {
        Ok(())
    } else {
        Err(ToolError::InvalidInput(format!(
            "Invalid step_type '{}'; expected one of {}",
            step_type,
            STEP_TYPES.join(", ")
        )))
    }
}

fn validate_command(command: &str) -> Result<(), ToolError> {
    if command.trim().is_empty() {
        Err(ToolError::InvalidInput(
            "Step command must not be blank".into(),
        ))
    } else {
        Ok(())
    }
}

/// Step type of a stored step, tolerating the legacy `"type"` key some
/// older AI-written plans carry.
fn stored_step_type(step: &serde_json::Value) -> &str {
    step.get("step_type")
        .or_else(|| step.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("change")
}

/// Next `order` within a section: one past the highest order already used
/// by steps of the same type (1-based, matching the workspace UI).
fn next_order_in_section(steps: &[serde_json::Value], step_type: &str) -> i32 {
    steps
        .iter()
        .filter(|s| stored_step_type(s) == step_type)
        .map(|s| s.get("order").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
        .max()
        .unwrap_or(0)
        + 1
}

/// A complete, pending `MopStep` — every field the Change model requires is
/// set explicitly so the stored JSON always deserializes.
fn new_mop_step(
    step_type: &str,
    command: &str,
    description: Option<String>,
    expected_output: Option<String>,
    order: i32,
) -> MopStep {
    MopStep {
        id: uuid::Uuid::new_v4().to_string(),
        order,
        step_type: step_type.to_string(),
        command: command.to_string(),
        description,
        expected_output,
        status: "pending".to_string(),
        output: None,
        executed_at: None,
        execution_source: None,
        quick_action_id: None,
        quick_action_variables: None,
        script_id: None,
        script_args: None,
        paired_step_id: None,
        output_format: None,
        ai_feedback: None,
        device_scope: None,
        device_ids: None,
        deploy_metadata: None,
    }
}

/// Validate and convert tool step inputs into stored step values, assigning
/// per-section orders that continue from `existing`.
fn build_steps(
    existing: &[serde_json::Value],
    inputs: &[StepInput],
) -> Result<Vec<serde_json::Value>, ToolError> {
    let mut all: Vec<serde_json::Value> = existing.to_vec();
    let mut built = Vec::with_capacity(inputs.len());
    for s in inputs {
        validate_step_type(&s.step_type)?;
        validate_command(&s.command)?;
        let order = next_order_in_section(&all, &s.step_type);
        let step = new_mop_step(
            &s.step_type,
            &s.command,
            s.description.clone(),
            s.expected_output.clone(),
            order,
        );
        let value = serde_json::to_value(step)
            .map_err(|e| ToolError::ExecutionFailed(format!("Failed to serialize step: {}", e)))?;
        all.push(value.clone());
        built.push(value);
    }
    Ok(built)
}

impl MopPlanTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn load_steps(&self, plan_id: &str) -> Result<Vec<serde_json::Value>, ToolError> {
        let row: Option<(String,)> = sqlx::query_as("SELECT mop_steps FROM changes WHERE id = ?")
            .bind(plan_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get plan: {}", e)))?;
        let (steps_json,) =
            row.ok_or_else(|| ToolError::ExecutionFailed(format!("Plan {} not found", plan_id)))?;
        serde_json::from_str(&steps_json).map_err(|e| {
            ToolError::ExecutionFailed(format!("Plan {} has unreadable mop_steps: {}", plan_id, e))
        })
    }

    async fn save_steps(
        &self,
        plan_id: &str,
        steps: &[serde_json::Value],
    ) -> Result<(), ToolError> {
        let steps_json = serde_json::to_string(steps)
            .map_err(|e| ToolError::ExecutionFailed(format!("Failed to serialize steps: {}", e)))?;
        sqlx::query("UPDATE changes SET mop_steps = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(&steps_json)
            .bind(plan_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("Failed to update plan: {}", e)))?;
        Ok(())
    }

    /// `cli_flavor` of the session a plan is linked to (for export
    /// `platform_hints`); `None` when unlinked or the flavor is `auto`.
    async fn linked_session_flavor(&self, plan_id: &str) -> Option<String> {
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT s.cli_flavor FROM changes c JOIN sessions s ON s.id = c.session_id WHERE c.id = ?"
        )
        .bind(plan_id)
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten();
        row.and_then(|(flavor,)| flavor)
            .filter(|f| !f.is_empty() && f != "auto")
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
         with pre-checks, changes, post-checks, and rollback steps. Step commands may \
         use {{name}} placeholders: declare each name in the plan's `variables` (with a \
         default value; `required: true` when every device must supply one) and the \
         executor substitutes them per device. {{device.host}}, {{device.name}} and \
         {{device.type}} are built in and need no declaration."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "list", "get", "add_steps", "edit_step", "remove_steps", "set_variables", "export", "import"],
                    "description": "Action to perform: create a new plan, list all plans, get a specific plan, add steps, edit a step, remove steps, set_variables (replace the plan's {{name}} variables), export as JSON package, or import from JSON package"
                },
                "plan_id": {
                    "type": "string",
                    "description": "Plan ID (required for get, add_steps, edit_step, remove_steps, export)"
                },
                "name": {
                    "type": "string",
                    "description": "Plan name (required for create)"
                },
                "description": {
                    "type": "string",
                    "description": "Plan description (for create) or new step description (for edit_step)"
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
                    "description": "Steps to add (for create or add_steps). Commands may contain {{name}} placeholders declared in `variables`."
                },
                "variables": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "description": "Placeholder name (letters, digits, '_'; used as {{name}} in commands)" },
                            "value": { "type": "string", "description": "Default value (may be empty)" },
                            "description": { "type": "string" },
                            "required": { "type": "boolean", "description": "Every device must have a non-empty value before execution starts" }
                        },
                        "required": ["name"]
                    },
                    "description": "Plan-level variables (for create or set_variables). The whole list replaces the stored one on set_variables."
                },
                "step_id": {
                    "type": "string",
                    "description": "Step ID to edit (edit_step) or remove (remove_steps)"
                },
                "step_ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Step IDs to remove (remove_steps)"
                },
                "command": {
                    "type": "string",
                    "description": "New command text (for edit_step)"
                },
                "step_type": {
                    "type": "string",
                    "enum": ["pre_check", "change", "post_check", "rollback"],
                    "description": "New step type (for edit_step)"
                },
                "expected_output": {
                    "type": "string",
                    "description": "New expected output / assertions (for edit_step)"
                },
                "package_json": {
                    "type": "string",
                    "description": "JSON string of a MOP package to import (for import action)"
                }
            },
            "required": ["action"]
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: MopPlanInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!("[Task {}] MOP plan tool: action={}", task_id, params.action);

        match params.action.as_str() {
            "create" => {
                let name = params.name.unwrap_or_else(|| "Untitled MOP".to_string());
                if name.trim().is_empty() {
                    return Err(ToolError::InvalidInput(
                        "Plan name must not be blank".into(),
                    ));
                }
                let id = uuid::Uuid::new_v4().to_string();

                let steps = build_steps(&[], params.steps.as_deref().unwrap_or(&[]))?;
                let steps_json = serde_json::to_string(&steps).map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to serialize steps: {}", e))
                })?;
                let variables = build_variables(params.variables.as_deref().unwrap_or(&[]))?;
                let variables_json = serde_json::to_string(&variables).map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to serialize variables: {}", e))
                })?;

                sqlx::query(
                    "INSERT INTO changes (id, name, description, mop_steps, variables, created_by) VALUES (?, ?, ?, ?, ?, 'ai')"
                )
                .bind(&id)
                .bind(&name)
                .bind(params.description.as_deref())
                .bind(&steps_json)
                .bind(&variables_json)
                .execute(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to create plan: {}", e)))?;

                Ok(ToolOutput::success(json!({
                    "plan_id": id,
                    "name": name,
                    "steps": steps,
                    "variables": variables,
                    "message": format!("MOP plan created successfully with {} steps and {} variable(s)", steps.len(), variables.len())
                })))
            }

            "set_variables" => {
                let plan_id = params
                    .plan_id
                    .ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;
                let inputs = params
                    .variables
                    .ok_or_else(|| ToolError::InvalidInput("variables required".into()))?;
                let variables = build_variables(&inputs)?;
                let variables_json = serde_json::to_string(&variables).map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to serialize variables: {}", e))
                })?;
                let result = sqlx::query(
                    "UPDATE changes SET variables = ?, updated_at = datetime('now') WHERE id = ?",
                )
                .bind(&variables_json)
                .bind(&plan_id)
                .execute(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to update plan: {}", e)))?;
                if result.rows_affected() == 0 {
                    return Ok(ToolOutput::failure(format!("Plan {} not found", plan_id)));
                }
                Ok(ToolOutput::success(json!({
                    "plan_id": plan_id,
                    "variables": variables,
                    "message": format!("Plan now declares {} variable(s)", variables.len())
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
                let plan_id = params
                    .plan_id
                    .ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;

                let plan: Option<(String, String, Option<String>, String, String, String, String)> = sqlx::query_as(
                    "SELECT id, name, description, status, mop_steps, variables, created_at FROM changes WHERE id = ?"
                )
                .bind(&plan_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get plan: {}", e)))?;

                match plan {
                    Some((id, name, desc, status, steps_json, variables_json, created_at)) => {
                        let steps: serde_json::Value =
                            serde_json::from_str(&steps_json).unwrap_or(json!([]));
                        let variables: serde_json::Value =
                            serde_json::from_str(&variables_json).unwrap_or(json!([]));
                        Ok(ToolOutput::success(json!({
                            "id": id,
                            "name": name,
                            "description": desc,
                            "status": status,
                            "steps": steps,
                            "variables": variables,
                            "created_at": created_at,
                        })))
                    }
                    None => Ok(ToolOutput::failure(format!("Plan {} not found", plan_id))),
                }
            }

            "add_steps" => {
                let plan_id = params
                    .plan_id
                    .ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;
                let new_steps = params
                    .steps
                    .ok_or_else(|| ToolError::InvalidInput("steps required".into()))?;

                let mut steps = self.load_steps(&plan_id).await?;
                let added = build_steps(&steps, &new_steps)?;
                steps.extend(added.iter().cloned());
                self.save_steps(&plan_id, &steps).await?;

                Ok(ToolOutput::success(json!({
                    "added": added.len(),
                    "steps": added,
                    "total_steps": steps.len(),
                    "message": format!("Added {} steps to plan", added.len())
                })))
            }

            "edit_step" => {
                let plan_id = params
                    .plan_id
                    .ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;
                let step_id = params
                    .step_id
                    .ok_or_else(|| ToolError::InvalidInput("step_id required".into()))?;
                if let Some(t) = params.step_type.as_deref() {
                    validate_step_type(t)?;
                }
                if let Some(c) = params.command.as_deref() {
                    validate_command(c)?;
                }

                let mut steps = self.load_steps(&plan_id).await?;
                let Some(step) = steps
                    .iter_mut()
                    .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(step_id.as_str()))
                else {
                    return Ok(ToolOutput::failure(format!(
                        "Step {} not found in plan {}",
                        step_id, plan_id
                    )));
                };
                let Some(obj) = step.as_object_mut() else {
                    return Ok(ToolOutput::failure(format!(
                        "Step {} is not an object",
                        step_id
                    )));
                };

                let mut changed = Vec::new();
                if let Some(t) = params.step_type {
                    obj.insert("step_type".into(), json!(t));
                    obj.remove("type");
                    changed.push("step_type");
                }
                if let Some(c) = params.command {
                    obj.insert("command".into(), json!(c));
                    changed.push("command");
                }
                if let Some(d) = params.description {
                    obj.insert("description".into(), json!(d));
                    changed.push("description");
                }
                if let Some(e) = params.expected_output {
                    obj.insert("expected_output".into(), json!(e));
                    changed.push("expected_output");
                }
                if changed.is_empty() {
                    return Err(ToolError::InvalidInput(
                        "edit_step needs at least one of command, step_type, description, expected_output".into(),
                    ));
                }
                let updated = step.clone();
                self.save_steps(&plan_id, &steps).await?;

                Ok(ToolOutput::success(json!({
                    "step": updated,
                    "changed": changed,
                    "message": format!("Updated {} on step {}", changed.join(", "), step_id)
                })))
            }

            "remove_steps" => {
                let plan_id = params
                    .plan_id
                    .ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;
                let mut ids: Vec<String> = params.step_ids.unwrap_or_default();
                if let Some(single) = params.step_id {
                    ids.push(single);
                }
                if ids.is_empty() {
                    return Err(ToolError::InvalidInput(
                        "step_id or step_ids required".into(),
                    ));
                }

                let steps = self.load_steps(&plan_id).await?;
                let before = steps.len();
                let mut remaining: Vec<serde_json::Value> = steps
                    .into_iter()
                    .filter(|s| {
                        !s.get("id")
                            .and_then(|v| v.as_str())
                            .is_some_and(|id| ids.iter().any(|x| x == id))
                    })
                    .collect();
                let removed = before - remaining.len();
                if removed == 0 {
                    return Ok(ToolOutput::failure(format!(
                        "No steps matching {:?} in plan {}",
                        ids, plan_id
                    )));
                }
                // A removed step's pairing partner keeps its own step; only the link goes.
                for s in remaining.iter_mut() {
                    let paired = s
                        .get("paired_step_id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    if paired.is_some_and(|p| ids.contains(&p)) {
                        if let Some(obj) = s.as_object_mut() {
                            obj.remove("paired_step_id");
                        }
                    }
                }
                self.save_steps(&plan_id, &remaining).await?;

                Ok(ToolOutput::success(json!({
                    "removed": removed,
                    "total_steps": remaining.len(),
                    "message": format!("Removed {} step(s) from plan", removed)
                })))
            }

            "export" => {
                let plan_id = params
                    .plan_id
                    .ok_or_else(|| ToolError::InvalidInput("plan_id required".into()))?;

                let plan: Option<(String, String, Option<String>, String, String, String)> = sqlx::query_as(
                    "SELECT id, name, description, status, mop_steps, created_by FROM changes WHERE id = ?"
                )
                .bind(&plan_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get plan: {}", e)))?;

                match plan {
                    Some((_id, name, desc, _status, steps_json, author)) => {
                        let steps: Vec<serde_json::Value> =
                            serde_json::from_str(&steps_json).unwrap_or_default();
                        let pkg_steps: Vec<serde_json::Value> = steps.iter().enumerate().map(|(i, s)| {
                            json!({
                                "order": s.get("order").and_then(|v| v.as_i64()).unwrap_or(i as i64 + 1),
                                "step_type": stored_step_type(s),
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

                        let platform_hints: Vec<String> = self
                            .linked_session_flavor(&plan_id)
                            .await
                            .into_iter()
                            .collect();

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
                                "platform_hints": platform_hints,
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
                let pkg_json = params
                    .package_json
                    .ok_or_else(|| ToolError::InvalidInput("package_json required".into()))?;
                let pkg: serde_json::Value = serde_json::from_str(&pkg_json)
                    .map_err(|e| ToolError::InvalidInput(format!("Invalid package JSON: {}", e)))?;

                let format = pkg.get("format").and_then(|v| v.as_str()).unwrap_or("");
                if format != "netstacks-mop" {
                    return Err(ToolError::InvalidInput(format!(
                        "Unknown format: '{}', expected 'netstacks-mop'",
                        format
                    )));
                }

                let mop = pkg.get("mop").ok_or_else(|| {
                    ToolError::InvalidInput("Missing 'mop' field in package".into())
                })?;
                let name = mop
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Imported MOP")
                    .to_string();
                let description = mop
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let pkg_steps = mop
                    .get("steps")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();

                if pkg_steps.is_empty() {
                    return Err(ToolError::InvalidInput("Package has no steps".into()));
                }

                // Convert package steps to MOP steps with new UUIDs
                let mut mop_steps: Vec<serde_json::Value> = Vec::new();
                for s in &pkg_steps {
                    let step_type = stored_step_type(s);
                    validate_step_type(step_type)?;
                    let command = s.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    validate_command(command)?;
                    let order = s
                        .get("order")
                        .and_then(|v| v.as_i64())
                        .map(|o| o as i32)
                        .unwrap_or_else(|| next_order_in_section(&mop_steps, step_type));
                    let opt_str =
                        |key: &str| s.get(key).and_then(|v| v.as_str()).map(str::to_string);
                    let step = MopStep {
                        execution_source: opt_str("execution_source"),
                        quick_action_id: opt_str("quick_action_id"),
                        quick_action_variables: s
                            .get("quick_action_variables")
                            .filter(|v| !v.is_null())
                            .cloned(),
                        script_id: opt_str("script_id"),
                        script_args: s.get("script_args").filter(|v| !v.is_null()).cloned(),
                        paired_step_id: opt_str("paired_step_id"),
                        output_format: opt_str("output_format"),
                        ..new_mop_step(
                            step_type,
                            command,
                            opt_str("description"),
                            opt_str("expected_output"),
                            order,
                        )
                    };
                    mop_steps.push(serde_json::to_value(step).map_err(|e| {
                        ToolError::ExecutionFailed(format!("Failed to serialize step: {}", e))
                    })?);
                }

                let id = uuid::Uuid::new_v4().to_string();
                let steps_json =
                    serde_json::to_string(&mop_steps).unwrap_or_else(|_| "[]".to_string());

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

            _ => Err(ToolError::InvalidInput(format!(
                "Unknown action: {}",
                params.action
            ))),
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

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: MopExecutionInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!(
            "[Task {}] MOP execution tool: action={}",
            task_id, params.action
        );

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

                Ok(ToolOutput::success(
                    json!({ "executions": results, "count": results.len() }),
                ))
            }

            "get_status" => {
                let exec_id = params
                    .execution_id
                    .ok_or_else(|| ToolError::InvalidInput("execution_id required".into()))?;

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
                            "SELECT COUNT(*) FROM mop_execution_devices WHERE execution_id = ?",
                        )
                        .bind(&id)
                        .fetch_one(&self.pool)
                        .await
                        .unwrap_or((0,));

                        let step_counts: Vec<(String, i64)> = sqlx::query_as(
                            "SELECT s.status, COUNT(*) FROM mop_execution_steps s \
                             JOIN mop_execution_devices d ON s.execution_device_id = d.id \
                             WHERE d.execution_id = ? GROUP BY s.status",
                        )
                        .bind(&id)
                        .fetch_all(&self.pool)
                        .await
                        .unwrap_or_default();

                        let step_summary: serde_json::Value = step_counts
                            .iter()
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
                    None => Ok(ToolOutput::failure(format!(
                        "Execution {} not found",
                        exec_id
                    ))),
                }
            }

            _ => Err(ToolError::InvalidInput(format!(
                "Unknown action: {}",
                params.action
            ))),
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

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: MopAnalysisInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid input: {}", e)))?;

        info!(
            "[Task {}] MOP analysis tool: action={}",
            task_id, params.action
        );

        match params.action.as_str() {
            "get_device_results" => {
                let devices: Vec<(
                    String,
                    Option<String>,
                    Option<String>,
                    String,
                    Option<String>,
                    Option<String>,
                )> = sqlx::query_as(
                    "SELECT id, device_name, device_host, status, started_at, completed_at \
                     FROM mop_execution_devices WHERE execution_id = ? ORDER BY device_order",
                )
                .bind(&params.execution_id)
                .fetch_all(&self.pool)
                .await
                .map_err(|e| ToolError::ExecutionFailed(format!("Failed to get devices: {}", e)))?;

                let results: Vec<serde_json::Value> = devices
                    .iter()
                    .map(|(id, name, host, status, started, completed)| {
                        json!({
                            "id": id,
                            "device_name": name,
                            "device_host": host,
                            "status": status,
                            "started_at": started,
                            "completed_at": completed,
                        })
                    })
                    .collect();

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

                let steps = query.map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to get steps: {}", e))
                })?;

                let results: Vec<serde_json::Value> = steps
                    .iter()
                    .map(
                        |(
                            id,
                            stype,
                            cmd,
                            status,
                            output,
                            feedback,
                            duration,
                            exec_source,
                            qa_id,
                            script_id,
                            paired_id,
                            out_fmt,
                        )| {
                            json!({
                                "id": id,
                                "step_type": stype,
                                "command": cmd,
                                "status": status,
                                "output": &output[..output.floor_char_boundary(1000)],
                                "ai_feedback": feedback,
                                "duration_ms": duration,
                                "execution_source": exec_source,
                                "quick_action_id": qa_id,
                                "script_id": script_id,
                                "paired_step_id": paired_id,
                                "output_format": out_fmt,
                            })
                        },
                    )
                    .collect();

                Ok(ToolOutput::success(
                    json!({ "steps": results, "count": results.len() }),
                ))
            }

            _ => Err(ToolError::InvalidInput(format!(
                "Unknown action: {}",
                params.action
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory DB with the base schema (the tool only touches `changes`
    /// and `sessions`, both fully defined in schema.sql). One connection so
    /// every query sees the same `:memory:` database.
    async fn test_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../db/schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    /// Stored steps must always round-trip through the Change model.
    async fn stored_steps(pool: &SqlitePool, plan_id: &str) -> Vec<MopStep> {
        let (raw,): (String,) = sqlx::query_as("SELECT mop_steps FROM changes WHERE id = ?")
            .bind(plan_id)
            .fetch_one(pool)
            .await
            .unwrap();
        serde_json::from_str::<Vec<MopStep>>(&raw).unwrap_or_else(|e| {
            panic!("stored mop_steps do not deserialize as Vec<MopStep>: {e}\n{raw}")
        })
    }

    async fn create_plan(tool: &MopPlanTool, steps: serde_json::Value) -> String {
        let out = tool
            .execute(
                json!({ "action": "create", "name": "Test MOP", "steps": steps }),
                "t",
            )
            .await
            .unwrap();
        assert!(out.success, "{:?}", out.error);
        out.output["plan_id"].as_str().unwrap().to_string()
    }

    #[test]
    fn build_steps_validates_type_and_command() {
        let bad_type = build_steps(
            &[],
            &[StepInput {
                step_type: "verify".into(),
                command: "show ver".into(),
                description: None,
                expected_output: None,
            }],
        );
        assert!(matches!(bad_type, Err(ToolError::InvalidInput(_))));
        let blank = build_steps(
            &[],
            &[StepInput {
                step_type: "change".into(),
                command: "  ".into(),
                description: None,
                expected_output: None,
            }],
        );
        assert!(matches!(blank, Err(ToolError::InvalidInput(_))));
    }

    #[test]
    fn new_mop_step_round_trips_through_model() {
        let step = new_mop_step("pre_check", "show version", Some("d".into()), None, 1);
        let value = serde_json::to_value(&step).unwrap();
        assert_eq!(value["status"], "pending");
        assert_eq!(value["order"], 1);
        assert!(
            value.get("type").is_none(),
            "legacy `type` key must not be written"
        );
        let back: MopStep = serde_json::from_value(value).unwrap();
        assert_eq!(back.id, step.id);
        assert_eq!(back.step_type, "pre_check");
        assert!(back.output.is_none() && back.executed_at.is_none());
    }

    #[tokio::test]
    async fn create_writes_complete_steps_with_per_section_order() {
        let pool = test_pool().await;
        let tool = MopPlanTool::new(pool.clone());
        let plan_id = create_plan(&tool, json!([
            { "step_type": "pre_check", "command": "show ip bgp summary" },
            { "step_type": "change", "command": "router bgp 65000", "description": "enter bgp" },
            { "step_type": "pre_check", "command": "show ip route summary", "expected_output": "CONTAINS: Total" },
        ])).await;

        let steps = stored_steps(&pool, &plan_id).await;
        assert_eq!(steps.len(), 3);
        assert_eq!(
            steps.iter().map(|s| s.order).collect::<Vec<_>>(),
            vec![1, 1, 2]
        );
        assert!(steps
            .iter()
            .all(|s| s.status == "pending" && s.output.is_none() && s.executed_at.is_none()));
        assert!(steps.iter().all(|s| uuid::Uuid::parse_str(&s.id).is_ok()));
        assert_eq!(steps[1].description.as_deref(), Some("enter bgp"));
        assert_eq!(steps[2].expected_output.as_deref(), Some("CONTAINS: Total"));
    }

    #[tokio::test]
    async fn create_and_set_variables_round_trip_through_model() {
        let pool = test_pool().await;
        let tool = MopPlanTool::new(pool.clone());
        let out = tool
            .execute(
                json!({
                    "action": "create",
                    "name": "VLAN add",
                    "steps": [{ "step_type": "change", "command": "vlan {{vlan}}" }],
                    "variables": [
                        { "name": "vlan", "value": "100", "required": true },
                        { "name": "desc", "description": "port description" }
                    ]
                }),
                "t",
            )
            .await
            .unwrap();
        assert!(out.success, "{:?}", out.error);
        let plan_id = out.output["plan_id"].as_str().unwrap().to_string();
        let (raw,): (String,) = sqlx::query_as("SELECT variables FROM changes WHERE id = ?")
            .bind(&plan_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let stored: Vec<MopVariable> = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(
            (
                stored[0].name.as_str(),
                stored[0].value.as_str(),
                stored[0].required
            ),
            ("vlan", "100", true)
        );
        assert_eq!(
            (
                stored[1].name.as_str(),
                stored[1].value.as_str(),
                stored[1].required
            ),
            ("desc", "", false)
        );

        let bad = tool
            .execute(json!({ "action": "set_variables", "plan_id": plan_id, "variables": [{ "name": "1bad" }] }), "t")
            .await;
        assert!(matches!(bad, Err(ToolError::InvalidInput(_))));
        let dup = build_variables(&[
            VariableInput {
                name: "a".into(),
                value: None,
                description: None,
                required: None,
            },
            VariableInput {
                name: "a".into(),
                value: None,
                description: None,
                required: None,
            },
        ]);
        assert!(matches!(dup, Err(ToolError::InvalidInput(_))));

        let out = tool
            .execute(json!({ "action": "set_variables", "plan_id": plan_id, "variables": [{ "name": "site", "value": "nyc" }] }), "t")
            .await
            .unwrap();
        assert!(out.success, "{:?}", out.error);
        let got = tool
            .execute(json!({ "action": "get", "plan_id": plan_id }), "t")
            .await
            .unwrap();
        assert_eq!(got.output["variables"][0]["name"], "site");
        assert_eq!(got.output["variables"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn add_edit_remove_steps() {
        let pool = test_pool().await;
        let tool = MopPlanTool::new(pool.clone());
        let plan_id = create_plan(
            &tool,
            json!([{ "step_type": "change", "command": "conf t" }]),
        )
        .await;

        // add_steps continues the section numbering
        let out = tool
            .execute(
                json!({ "action": "add_steps", "plan_id": plan_id, "steps": [
                    { "step_type": "change", "command": "interface Gi0/1" },
                    { "step_type": "post_check", "command": "show int Gi0/1" },
                ]}),
                "t",
            )
            .await
            .unwrap();
        assert!(out.success);
        let steps = stored_steps(&pool, &plan_id).await;
        assert_eq!(steps.len(), 3);
        assert_eq!((steps[1].step_type.as_str(), steps[1].order), ("change", 2));
        assert_eq!(
            (steps[2].step_type.as_str(), steps[2].order),
            ("post_check", 1)
        );
        let target = steps[1].id.clone();
        let post = steps[2].id.clone();

        // edit_step changes only the provided fields
        let out = tool
            .execute(
                json!({
                    "action": "edit_step", "plan_id": plan_id, "step_id": target,
                    "command": "interface Gi0/2", "expected_output": "NOT_CONTAINS: Invalid"
                }),
                "t",
            )
            .await
            .unwrap();
        assert!(out.success, "{:?}", out.error);
        let steps = stored_steps(&pool, &plan_id).await;
        let edited = steps.iter().find(|s| s.id == target).unwrap();
        assert_eq!(edited.command, "interface Gi0/2");
        assert_eq!(
            edited.expected_output.as_deref(),
            Some("NOT_CONTAINS: Invalid")
        );
        assert_eq!(edited.step_type, "change");
        assert_eq!(edited.order, 2);

        // edit_step rejects bad input / unknown step
        assert!(matches!(
            tool.execute(json!({ "action": "edit_step", "plan_id": plan_id, "step_id": target, "step_type": "nope" }), "t").await,
            Err(ToolError::InvalidInput(_))
        ));
        let missing = tool.execute(json!({ "action": "edit_step", "plan_id": plan_id, "step_id": "ghost", "command": "x" }), "t").await.unwrap();
        assert!(!missing.success);

        // pair post-check to the change, then remove the change: partner keeps its step, loses the link
        let mut raw: Vec<serde_json::Value> = serde_json::from_str(
            &sqlx::query_as::<_, (String,)>("SELECT mop_steps FROM changes WHERE id = ?")
                .bind(&plan_id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .0,
        )
        .unwrap();
        raw[2]["paired_step_id"] = json!(target);
        sqlx::query("UPDATE changes SET mop_steps = ? WHERE id = ?")
            .bind(serde_json::to_string(&raw).unwrap())
            .bind(&plan_id)
            .execute(&pool)
            .await
            .unwrap();

        let out = tool
            .execute(
                json!({ "action": "remove_steps", "plan_id": plan_id, "step_ids": [target] }),
                "t",
            )
            .await
            .unwrap();
        assert!(out.success, "{:?}", out.error);
        assert_eq!(out.output["removed"], 1);
        let steps = stored_steps(&pool, &plan_id).await;
        assert_eq!(steps.len(), 2);
        assert!(steps.iter().all(|s| s.id != target));
        let partner = steps.iter().find(|s| s.id == post).unwrap();
        assert!(partner.paired_step_id.is_none());

        let none = tool
            .execute(
                json!({ "action": "remove_steps", "plan_id": plan_id, "step_id": "ghost" }),
                "t",
            )
            .await
            .unwrap();
        assert!(!none.success);
    }

    #[tokio::test]
    async fn export_fills_platform_hints_from_linked_session() {
        let pool = test_pool().await;
        let tool = MopPlanTool::new(pool.clone());
        sqlx::query("INSERT INTO sessions (id, name, host, username, auth_type, cli_flavor) VALUES ('s1', 'R1', '10.0.0.1', 'admin', 'password', 'cisco-ios')")
            .execute(&pool).await.unwrap();
        let plan_id = create_plan(
            &tool,
            json!([{ "step_type": "pre_check", "command": "show ver" }]),
        )
        .await;
        sqlx::query("UPDATE changes SET session_id = 's1' WHERE id = ?")
            .bind(&plan_id)
            .execute(&pool)
            .await
            .unwrap();

        let out = tool
            .execute(json!({ "action": "export", "plan_id": plan_id }), "t")
            .await
            .unwrap();
        assert!(out.success);
        assert_eq!(
            out.output["package"]["metadata"]["platform_hints"],
            json!(["cisco-ios"])
        );
        assert_eq!(
            out.output["package"]["mop"]["steps"][0]["step_type"],
            "pre_check"
        );

        // Unlinked plan (or `auto` flavor) → no hints
        let unlinked = create_plan(&tool, json!([])).await;
        let out = tool
            .execute(json!({ "action": "export", "plan_id": unlinked }), "t")
            .await
            .unwrap();
        assert_eq!(
            out.output["package"]["metadata"]["platform_hints"],
            json!([])
        );
    }

    #[tokio::test]
    async fn import_writes_complete_steps() {
        let pool = test_pool().await;
        let tool = MopPlanTool::new(pool.clone());
        let pkg = json!({ "format": "netstacks-mop", "mop": { "name": "Imported", "steps": [
            { "step_type": "change", "command": "no shutdown", "execution_source": "cli" },
            { "step_type": "post_check", "command": "show int", "order": 7 },
        ]}});
        let out = tool
            .execute(
                json!({ "action": "import", "package_json": pkg.to_string() }),
                "t",
            )
            .await
            .unwrap();
        assert!(out.success, "{:?}", out.error);
        let steps = stored_steps(&pool, out.output["plan_id"].as_str().unwrap()).await;
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].execution_source.as_deref(), Some("cli"));
        assert_eq!(steps[1].order, 7);
    }
}
