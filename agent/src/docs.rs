//! Documents module for managing outputs, templates, backups, and history
//!
//! Handles CRUD operations for documents with category-based organization.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::FromRow;
use std::sync::Arc;
use uuid::Uuid;

use crate::models::{format_datetime, parse_datetime, ContentType, Document, DocumentCategory, DocumentVersion, DocumentVersionMeta, NewDocument, UpdateDocument};
use crate::providers::DataProvider;

/// Documents state containing database pool and a vault accessor for
/// Secure Notes (Notes-category documents are encrypted at rest).
pub struct DocsState {
    pub pool: SqlitePool,
    pub provider: Arc<dyn DataProvider>,
}

/// Categories that are stored encrypted at rest. The body is run through
/// the user's vault on write and decrypted on read.
fn is_secure_category(category: &DocumentCategory) -> bool {
    matches!(category, DocumentCategory::Notes)
}

/// Internal row type for documents from SQLite
#[derive(Debug, FromRow)]
struct DocumentRow {
    id: String,
    name: String,
    category: String,
    content_type: String,
    content: String,
    encrypted_content: Option<Vec<u8>>,
    parent_folder: Option<String>,
    session_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl DocumentRow {
    /// Convert a raw row into the API Document. If the row has
    /// encrypted_content, attempt to decrypt via the provided vault. When
    /// the vault is locked, return the document with `content=""` and
    /// `locked=true` so the UI can render a lock placeholder.
    fn into_document(self, provider: &dyn DataProvider) -> Result<Document, String> {
        let category = DocumentCategory::from_str(&self.category)
            .ok_or_else(|| format!("Invalid category: {}", self.category))?;
        let content_type = ContentType::from_str(&self.content_type)
            .ok_or_else(|| format!("Invalid content_type: {}", self.content_type))?;

        let (content, encrypted, locked) = match self.encrypted_content {
            Some(blob) if !blob.is_empty() => {
                if provider.is_unlocked() {
                    match provider.vault_decrypt_string(&blob) {
                        Ok(plain) => (plain, true, false),
                        Err(e) => return Err(format!("Failed to decrypt note: {}", e)),
                    }
                } else {
                    (String::new(), true, true)
                }
            }
            _ => (self.content, false, false),
        };

        Ok(Document {
            id: self.id,
            name: self.name,
            category,
            content_type,
            content,
            parent_folder: self.parent_folder,
            session_id: self.session_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
            encrypted,
            locked,
        })
    }
}

/// Internal row type for document versions from SQLite
#[derive(Debug, FromRow)]
struct DocumentVersionRow {
    id: String,
    document_id: String,
    content: String,
    encrypted_content: Option<Vec<u8>>,
    created_at: String,
}

impl DocumentVersionRow {
    fn into_version(self, provider: &dyn DataProvider) -> Result<DocumentVersion, String> {
        let content = match self.encrypted_content {
            Some(blob) if !blob.is_empty() => {
                if provider.is_unlocked() {
                    provider
                        .vault_decrypt_string(&blob)
                        .map_err(|e| format!("Failed to decrypt version: {}", e))?
                } else {
                    return Err("Vault is locked - unlock to view encrypted version".to_string());
                }
            }
            _ => self.content,
        };
        Ok(DocumentVersion {
            id: self.id,
            document_id: self.document_id,
            content,
            created_at: parse_datetime(&self.created_at)?,
        })
    }

    fn into_version_meta(self) -> Result<DocumentVersionMeta, String> {
        Ok(DocumentVersionMeta {
            id: self.id,
            document_id: self.document_id,
            created_at: parse_datetime(&self.created_at)?,
        })
    }
}


/// API error response
#[derive(Debug, Serialize)]
pub struct DocsError {
    pub error: String,
    pub code: String,
}

impl axum::response::IntoResponse for DocsError {
    fn into_response(self) -> axum::response::Response {
        let status = match self.code.as_str() {
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "VALIDATION" => StatusCode::BAD_REQUEST,
            "VAULT_LOCKED" => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self)).into_response()
    }
}

fn vault_locked_err() -> DocsError {
    DocsError {
        error: "Vault is locked - unlock with master password to access secure notes".into(),
        code: "VAULT_LOCKED".into(),
    }
}

/// Query parameters for listing documents
#[derive(Debug, Deserialize)]
pub struct ListDocsQuery {
    pub category: Option<String>,
    pub parent_folder: Option<String>,
}

// === Document Endpoints ===

/// List all documents with optional filters
pub async fn list_documents(
    State(state): State<Arc<DocsState>>,
    Query(query): Query<ListDocsQuery>,
) -> Result<Json<Vec<Document>>, DocsError> {
    let rows: Vec<DocumentRow> = match (&query.category, &query.parent_folder) {
        (Some(category), Some(folder)) => {
            sqlx::query_as(
                "SELECT * FROM documents WHERE category = ? AND parent_folder = ? ORDER BY name",
            )
            .bind(category)
            .bind(folder)
            .fetch_all(&state.pool)
            .await
        }
        (Some(category), None) => {
            sqlx::query_as("SELECT * FROM documents WHERE category = ? ORDER BY name")
                .bind(category)
                .fetch_all(&state.pool)
                .await
        }
        (None, Some(folder)) => {
            sqlx::query_as("SELECT * FROM documents WHERE parent_folder = ? ORDER BY name")
                .bind(folder)
                .fetch_all(&state.pool)
                .await
        }
        (None, None) => {
            sqlx::query_as("SELECT * FROM documents ORDER BY category, name")
                .fetch_all(&state.pool)
                .await
        }
    }
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let provider = state.provider.as_ref();
    let documents: Result<Vec<Document>, _> = rows.into_iter().map(|r| r.into_document(provider)).collect();
    documents.map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Get a single document
pub async fn get_document(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
) -> Result<Json<Document>, DocsError> {
    let row: DocumentRow = sqlx::query_as("SELECT * FROM documents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    row.into_document(state.provider.as_ref()).map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Create a new document. Notes-category bodies are encrypted via the vault;
/// the vault must be unlocked.
pub async fn create_document(
    State(state): State<Arc<DocsState>>,
    Json(new_doc): Json<NewDocument>,
) -> Result<(StatusCode, Json<Document>), DocsError> {
    let id = Uuid::new_v4().to_string();
    let now = format_datetime(&Utc::now());

    let (plain_content, encrypted_content): (String, Option<Vec<u8>>) =
        if is_secure_category(&new_doc.category) {
            if !state.provider.is_unlocked() {
                return Err(vault_locked_err());
            }
            let blob = state
                .provider
                .vault_encrypt_string(&new_doc.content)
                .map_err(|e| DocsError {
                    error: format!("Failed to encrypt note: {}", e),
                    code: "ENCRYPTION_ERROR".to_string(),
                })?;
            (String::new(), Some(blob))
        } else {
            (new_doc.content.clone(), None)
        };

    sqlx::query(
        r#"
        INSERT INTO documents (id, name, category, content_type, content, encrypted_content, parent_folder, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&new_doc.name)
    .bind(new_doc.category.as_str())
    .bind(new_doc.content_type.as_str())
    .bind(&plain_content)
    .bind(&encrypted_content)
    .bind(&new_doc.parent_folder)
    .bind(&new_doc.session_id)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let doc = get_document_by_id(&state.pool, &id, state.provider.as_ref()).await?;
    Ok((StatusCode::CREATED, Json(doc)))
}

/// Update an existing document. If the (new or unchanged) category is a
/// secure category, the body is encrypted; the prior version snapshot
/// preserves whatever encryption state the previous content was in.
pub async fn update_document(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateDocument>,
) -> Result<Json<Document>, DocsError> {
    // Pull the raw row so we can preserve the existing ciphertext for the
    // version snapshot without round-tripping through the vault.
    let raw: DocumentRow = sqlx::query_as("SELECT * FROM documents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    let current_category = DocumentCategory::from_str(&raw.category)
        .ok_or_else(|| DocsError {
            error: format!("Invalid category: {}", raw.category),
            code: "PARSE_ERROR".to_string(),
        })?;
    let current_content_type = ContentType::from_str(&raw.content_type)
        .ok_or_else(|| DocsError {
            error: format!("Invalid content_type: {}", raw.content_type),
            code: "PARSE_ERROR".to_string(),
        })?;
    let current_was_encrypted = raw.encrypted_content.as_ref().map(|v| !v.is_empty()).unwrap_or(false);

    let new_category = update.category.clone().unwrap_or(current_category);
    let secure_after = is_secure_category(&new_category);

    // If we're going to encrypt (or are already encrypted), require unlocked
    // vault. We need the vault to (a) decrypt the prior version content for
    // the snapshot if needed, (b) encrypt the new content.
    if (current_was_encrypted || secure_after) && !state.provider.is_unlocked() {
        return Err(vault_locked_err());
    }

    let now = format_datetime(&Utc::now());

    // Snapshot the prior content. Preserve encryption — if the prior was
    // encrypted, store its ciphertext as-is into document_versions; if it
    // was plaintext, store it as plaintext.
    let version_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO document_versions (id, document_id, content, encrypted_content, created_at)
        VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(&version_id)
    .bind(&id)
    .bind(&raw.content)
    .bind(&raw.encrypted_content)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let name = update.name.unwrap_or(raw.name);
    let content_type = update.content_type.unwrap_or(current_content_type);

    // Resolve the new plaintext content. If unchanged, decrypt the prior
    // ciphertext (we know vault is unlocked at this point).
    let new_plaintext = match update.content {
        Some(v) => v,
        None => {
            if current_was_encrypted {
                state
                    .provider
                    .vault_decrypt_string(raw.encrypted_content.as_deref().unwrap_or(&[]))
                    .map_err(|e| DocsError {
                        error: format!("Failed to decrypt prior note for update: {}", e),
                        code: "ENCRYPTION_ERROR".to_string(),
                    })?
            } else {
                raw.content.clone()
            }
        }
    };

    let (plain_for_db, enc_for_db): (String, Option<Vec<u8>>) = if secure_after {
        let blob = state
            .provider
            .vault_encrypt_string(&new_plaintext)
            .map_err(|e| DocsError {
                error: format!("Failed to encrypt note: {}", e),
                code: "ENCRYPTION_ERROR".to_string(),
            })?;
        (String::new(), Some(blob))
    } else {
        (new_plaintext, None)
    };

    let parent_folder = match update.parent_folder {
        Some(v) => v,
        None => raw.parent_folder,
    };
    let session_id = match update.session_id {
        Some(v) => v,
        None => raw.session_id,
    };

    sqlx::query(
        r#"
        UPDATE documents
        SET name = ?, category = ?, content_type = ?, content = ?, encrypted_content = ?, parent_folder = ?, session_id = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&name)
    .bind(new_category.as_str())
    .bind(content_type.as_str())
    .bind(&plain_for_db)
    .bind(&enc_for_db)
    .bind(&parent_folder)
    .bind(&session_id)
    .bind(&now)
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let doc = get_document_by_id(&state.pool, &id, state.provider.as_ref()).await?;
    Ok(Json(doc))
}

/// Delete a document
pub async fn delete_document(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, DocsError> {
    let result = sqlx::query("DELETE FROM documents WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;

    if result.rows_affected() == 0 {
        return Err(DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Helper to get a document by ID, decrypting Notes via the vault.
async fn get_document_by_id(pool: &SqlitePool, id: &str, provider: &dyn DataProvider) -> Result<Document, DocsError> {
    let row: DocumentRow = sqlx::query_as("SELECT * FROM documents WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    row.into_document(provider).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

// === Version History Endpoints ===

/// List all versions of a document (metadata only, no content)
pub async fn list_versions(
    State(state): State<Arc<DocsState>>,
    Path(document_id): Path<String>,
) -> Result<Json<Vec<DocumentVersionMeta>>, DocsError> {
    // Verify document exists
    let _ = get_document_by_id(&state.pool, &document_id, state.provider.as_ref()).await?;

    let rows: Vec<DocumentVersionRow> = sqlx::query_as(
        "SELECT id, document_id, content, encrypted_content, created_at FROM document_versions WHERE document_id = ? ORDER BY created_at DESC",
    )
    .bind(&document_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let versions: Result<Vec<DocumentVersionMeta>, _> =
        rows.into_iter().map(|r| r.into_version_meta()).collect();
    versions.map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Get a single version with full content
pub async fn get_version(
    State(state): State<Arc<DocsState>>,
    Path(version_id): Path<String>,
) -> Result<Json<DocumentVersion>, DocsError> {
    let row: DocumentVersionRow = sqlx::query_as(
        "SELECT id, document_id, content, encrypted_content, created_at FROM document_versions WHERE id = ?",
    )
    .bind(&version_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?
    .ok_or_else(|| DocsError {
        error: format!("Version not found: {}", version_id),
        code: "NOT_FOUND".to_string(),
    })?;

    let was_encrypted = row.encrypted_content.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
    if was_encrypted && !state.provider.is_unlocked() {
        return Err(vault_locked_err());
    }

    row.into_version(state.provider.as_ref()).map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Restore a document to a previous version
/// Creates a new version from current content, then copies version content to document
pub async fn restore_version(
    State(state): State<Arc<DocsState>>,
    Path((document_id, version_id)): Path<(String, String)>,
) -> Result<Json<Document>, DocsError> {
    // Pull raw rows for both — we need to preserve ciphertext as-is rather
    // than decrypt-then-re-encrypt (which would change the nonce on every
    // restore for no benefit).
    let current_raw: DocumentRow = sqlx::query_as("SELECT * FROM documents WHERE id = ?")
        .bind(&document_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| DocsError {
            error: format!("Document not found: {}", document_id),
            code: "NOT_FOUND".to_string(),
        })?;

    let version_row: DocumentVersionRow = sqlx::query_as(
        "SELECT id, document_id, content, encrypted_content, created_at FROM document_versions WHERE id = ? AND document_id = ?",
    )
    .bind(&version_id)
    .bind(&document_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?
    .ok_or_else(|| DocsError {
        error: format!("Version not found: {}", version_id),
        code: "NOT_FOUND".to_string(),
    })?;

    let either_encrypted = current_raw.encrypted_content.as_ref().map(|v| !v.is_empty()).unwrap_or(false)
        || version_row.encrypted_content.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
    if either_encrypted && !state.provider.is_unlocked() {
        return Err(vault_locked_err());
    }

    let now = format_datetime(&Utc::now());

    // Snapshot the current content as a new version, preserving its
    // encryption state.
    let new_version_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO document_versions (id, document_id, content, encrypted_content, created_at)
        VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(&new_version_id)
    .bind(&document_id)
    .bind(&current_raw.content)
    .bind(&current_raw.encrypted_content)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    sqlx::query(
        r#"
        UPDATE documents
        SET content = ?, encrypted_content = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&version_row.content)
    .bind(&version_row.encrypted_content)
    .bind(&now)
    .bind(&document_id)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let doc = get_document_by_id(&state.pool, &document_id, state.provider.as_ref()).await?;
    Ok(Json(doc))
}

// === Template Rendering ===

/// Request to render a Jinja template
#[derive(Debug, Deserialize)]
pub struct RenderTemplateRequest {
    pub variables: serde_json::Value,
}

/// Response from rendering a template
#[derive(Debug, Serialize)]
pub struct RenderTemplateResponse {
    pub output: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Render a Jinja template with provided variables
pub async fn render_template(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
    Json(req): Json<RenderTemplateRequest>,
) -> Result<Json<RenderTemplateResponse>, DocsError> {
    // Get the document
    let doc = get_document_by_id(&state.pool, &id, state.provider.as_ref()).await?;

    // Verify it's a Jinja template
    if doc.content_type != ContentType::Jinja {
        return Err(DocsError {
            error: format!("Document is not a Jinja template (type: {:?})", doc.content_type),
            code: "VALIDATION".to_string(),
        });
    }

    // Render the template using minijinja
    let result = render_jinja_template(&doc.content, &req.variables);

    match result {
        Ok(output) => Ok(Json(RenderTemplateResponse {
            output,
            success: true,
            error: None,
        })),
        Err(e) => Ok(Json(RenderTemplateResponse {
            output: String::new(),
            success: false,
            error: Some(e),
        })),
    }
}

/// One-shot migration: encrypt any existing plaintext Notes-category
/// documents (and their version snapshots) using the unlocked vault.
/// Idempotent — rows that already have `encrypted_content` are left alone.
/// Safe to call from the unlock paths; runs in the background and just
/// logs failures (we don't want to fail the unlock if a single note
/// can't be encrypted for some reason).
pub async fn migrate_unencrypted_notes_in_background(
    pool: SqlitePool,
    provider: Arc<dyn DataProvider>,
) {
    tokio::spawn(async move {
        if !provider.is_unlocked() {
            return;
        }
        let notes_cat = DocumentCategory::Notes.as_str();

        // Migrate document rows
        let rows: Vec<(String, String)> = match sqlx::query_as(
            "SELECT id, content FROM documents WHERE category = ? AND (encrypted_content IS NULL OR length(encrypted_content) = 0) AND length(content) > 0"
        )
        .bind(notes_cat)
        .fetch_all(&pool)
        .await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Secure Notes migration: failed to scan documents: {}", e);
                return;
            }
        };

        if !rows.is_empty() {
            tracing::info!("Secure Notes migration: encrypting {} existing note(s)", rows.len());
        }

        for (id, plaintext) in rows {
            match provider.vault_encrypt_string(&plaintext) {
                Ok(blob) => {
                    if let Err(e) = sqlx::query(
                        "UPDATE documents SET content = '', encrypted_content = ? WHERE id = ?"
                    )
                    .bind(&blob)
                    .bind(&id)
                    .execute(&pool)
                    .await {
                        tracing::warn!("Secure Notes migration: failed to update {}: {}", id, e);
                    }
                }
                Err(e) => {
                    tracing::warn!("Secure Notes migration: failed to encrypt {}: {}", id, e);
                }
            }
        }

        // Migrate version snapshots whose parent doc is a note
        let v_rows: Vec<(String, String)> = match sqlx::query_as(
            "SELECT v.id, v.content FROM document_versions v
             JOIN documents d ON d.id = v.document_id
             WHERE d.category = ?
             AND (v.encrypted_content IS NULL OR length(v.encrypted_content) = 0)
             AND length(v.content) > 0"
        )
        .bind(notes_cat)
        .fetch_all(&pool)
        .await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Secure Notes migration: failed to scan versions: {}", e);
                return;
            }
        };

        for (id, plaintext) in v_rows {
            match provider.vault_encrypt_string(&plaintext) {
                Ok(blob) => {
                    if let Err(e) = sqlx::query(
                        "UPDATE document_versions SET content = '', encrypted_content = ? WHERE id = ?"
                    )
                    .bind(&blob)
                    .bind(&id)
                    .execute(&pool)
                    .await {
                        tracing::warn!("Secure Notes migration: failed to update version {}: {}", id, e);
                    }
                }
                Err(e) => {
                    tracing::warn!("Secure Notes migration: failed to encrypt version {}: {}", id, e);
                }
            }
        }
    });
}

/// Render a Jinja template string with variables
fn render_jinja_template(template: &str, variables: &serde_json::Value) -> Result<String, String> {
    use minijinja::Environment;

    let mut env = Environment::new();
    env.add_template("template", template)
        .map_err(|e| format!("Template parse error: {}", e))?;

    let tmpl = env.get_template("template")
        .map_err(|e| format!("Template error: {}", e))?;

    // Convert JSON value to minijinja Value
    let ctx = json_to_minijinja_value(variables);

    tmpl.render(ctx)
        .map_err(|e| format!("Render error: {}", e))
}

/// Convert serde_json::Value to minijinja::Value
fn json_to_minijinja_value(json: &serde_json::Value) -> minijinja::Value {
    match json {
        serde_json::Value::Null => minijinja::Value::UNDEFINED,
        serde_json::Value::Bool(b) => minijinja::Value::from(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                minijinja::Value::from(i)
            } else if let Some(f) = n.as_f64() {
                minijinja::Value::from(f)
            } else {
                minijinja::Value::UNDEFINED
            }
        }
        serde_json::Value::String(s) => minijinja::Value::from(s.as_str()),
        serde_json::Value::Array(arr) => {
            let values: Vec<minijinja::Value> = arr.iter().map(json_to_minijinja_value).collect();
            minijinja::Value::from(values)
        }
        serde_json::Value::Object(obj) => {
            let map: std::collections::BTreeMap<String, minijinja::Value> = obj
                .iter()
                .map(|(k, v)| (k.clone(), json_to_minijinja_value(v)))
                .collect();
            minijinja::Value::from_iter(map)
        }
    }
}
