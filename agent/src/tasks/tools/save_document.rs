//! `save_document` — persist an agent-generated artifact as a NetStacks
//! document the user can open in a tab and view side-by-side (split screen).
//!
//! Non-mutating with respect to network devices: it writes a local app
//! document (the same `documents` store the editor uses), so it does not gate
//! on per-tool approval. Use it to save deliverables (reports, configs, drafts,
//! CSV/JSON/markdown) instead of only printing them into the transcript.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use tracing::info;
use uuid::Uuid;

use super::{Tool, ToolError, ToolOutput};

const VALID_CATEGORIES: &[&str] = &[
    "outputs", "templates", "notes", "backups", "history", "troubleshooting", "mops",
];
const VALID_CONTENT_TYPES: &[&str] = &[
    "csv", "json", "jinja", "config", "text", "markdown", "recording",
];

#[derive(Debug, Deserialize)]
struct SaveDocumentInput {
    name: String,
    content: String,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    category: Option<String>,
}

pub struct SaveDocumentTool {
    pool: SqlitePool,
}

impl SaveDocumentTool {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Read the user-configured default category/folder for AI-agent document
    /// saves (mirrored from the frontend setting `documents.aiAgentDefault`).
    /// Returns (category, folder), each None if unset/unparseable.
    async fn read_ai_agent_default(&self) -> (Option<String>, Option<String>) {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM settings WHERE key = ?")
                .bind("documents.aiAgentDefault")
                .fetch_optional(&self.pool)
                .await
                .ok()
                .flatten();
        if let Some((value,)) = row {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&value) {
                let category = v.get("category").and_then(|c| c.as_str()).map(str::to_string);
                let folder = v
                    .get("folder")
                    .and_then(|f| f.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string);
                return (category, folder);
            }
        }
        (None, None)
    }
}

#[async_trait]
impl Tool for SaveDocumentTool {
    fn name(&self) -> &str {
        "save_document"
    }

    fn description(&self) -> &str {
        "Save a generated artifact (report, config, notes, CSV, JSON, markdown) \
         as a NetStacks document the user can open in a tab and view side-by-side. \
         Use this to persist deliverables you produce — analyses, drafts, \
         summaries, configs — instead of only printing them. Returns the \
         document id."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Document title." },
                "content": { "type": "string", "description": "The full document content." },
                "content_type": {
                    "type": "string",
                    "enum": VALID_CONTENT_TYPES,
                    "description": "Defaults to 'markdown'."
                },
                "category": {
                    "type": "string",
                    "enum": VALID_CATEGORIES,
                    "description": "Defaults to 'outputs'."
                }
            },
            "required": ["name", "content"],
            "additionalProperties": false
        })
    }

    async fn execute(
        &self,
        input: serde_json::Value,
        task_id: &str,
    ) -> Result<ToolOutput, ToolError> {
        let params: SaveDocumentInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(format!("Invalid save_document input: {}", e)))?;
        if params.name.trim().is_empty() {
            return Err(ToolError::InvalidInput("name must not be empty".into()));
        }

        // When the AI omits category, fall back to the user-configured default
        // (mirrored from the frontend), then to "outputs". The configured folder
        // (if any) becomes the document's parent folder.
        let (default_category, default_folder) = self.read_ai_agent_default().await;
        let content_type = params.content_type.unwrap_or_else(|| "markdown".to_string());
        let category = params
            .category
            .or(default_category)
            .unwrap_or_else(|| "outputs".to_string());
        if !VALID_CONTENT_TYPES.contains(&content_type.as_str()) {
            return Err(ToolError::InvalidInput(format!(
                "invalid content_type '{}'",
                content_type
            )));
        }
        if !VALID_CATEGORIES.contains(&category.as_str()) {
            return Err(ToolError::InvalidInput(format!(
                "invalid category '{}'",
                category
            )));
        }

        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"INSERT INTO documents
               (id, name, category, content_type, content, parent_folder, session_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)"#,
        )
        .bind(&id)
        .bind(&params.name)
        .bind(&category)
        .bind(&content_type)
        .bind(&params.content)
        .bind(&default_folder)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| ToolError::ExecutionFailed(format!("failed to save document: {}", e)))?;

        info!(task_id = %task_id, document_id = %id, name = %params.name, "agent saved document artifact");

        Ok(ToolOutput::success(json!({
            "saved": true,
            "document_id": id,
            "name": params.name,
            "category": category,
            "content_type": content_type,
        })))
    }
}
