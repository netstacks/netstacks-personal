use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use crate::api::{ApiError, AppState};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct GitAccount {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub host: Option<String>,
    pub auth_method: String,
    #[serde(skip_serializing)]
    pub credential: String,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct GitAccountView {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub host: Option<String>,
    pub auth_method: String,
    pub has_credential: bool,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<GitAccount> for GitAccountView {
    fn from(a: GitAccount) -> Self {
        GitAccountView {
            id: a.id,
            name: a.name,
            provider: a.provider,
            host: a.host,
            auth_method: a.auth_method,
            has_credential: !a.credential.is_empty(),
            is_default: a.is_default,
            created_at: a.created_at,
            updated_at: a.updated_at,
        }
    }
}

// ── List ──────────────────────────────────────────────────────────────────

pub async fn list_accounts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let accounts: Vec<GitAccount> = sqlx::query_as("SELECT * FROM git_accounts ORDER BY name")
        .fetch_all(&state.pool)
        .await
        .map_err(|e| ApiError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;
    let views: Vec<GitAccountView> = accounts.into_iter().map(GitAccountView::from).collect();
    Ok(Json(serde_json::json!({ "accounts": views })))
}

// ── Create ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateAccountRequest {
    pub name: String,
    pub provider: String,
    pub host: Option<String>,
    pub auth_method: Option<String>,
    pub credential: Option<String>,
    pub is_default: Option<bool>,
}

pub async fn create_account(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAccountRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = uuid::Uuid::new_v4().to_string();
    let auth_method = req.auth_method.unwrap_or_else(|| "pat".to_string());
    let credential = req.credential.unwrap_or_default();
    let is_default = req.is_default.unwrap_or(false);

    if is_default {
        sqlx::query("UPDATE git_accounts SET is_default = 0")
            .execute(&state.pool)
            .await
            .map_err(|e| ApiError {
                error: e.to_string(),
                code: "DATABASE_ERROR".to_string(),
            })?;
    }

    sqlx::query(
        "INSERT INTO git_accounts (id, name, provider, host, auth_method, credential, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&req.name)
    .bind(&req.provider)
    .bind(&req.host)
    .bind(&auth_method)
    .bind(&credential)
    .bind(is_default)
    .execute(&state.pool)
    .await
    .map_err(|e| ApiError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    Ok(Json(serde_json::json!({ "id": id })))
}

// ── Update ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateAccountRequest {
    pub id: String,
    pub name: Option<String>,
    pub provider: Option<String>,
    pub host: Option<String>,
    pub auth_method: Option<String>,
    pub credential: Option<String>,
    pub is_default: Option<bool>,
}

pub async fn update_account(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateAccountRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let existing: GitAccount = sqlx::query_as("SELECT * FROM git_accounts WHERE id = ?")
        .bind(&req.id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| ApiError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| ApiError {
            error: "Account not found".to_string(),
            code: "NOT_FOUND".to_string(),
        })?;

    let name = req.name.unwrap_or(existing.name);
    let provider = req.provider.unwrap_or(existing.provider);
    let host = req.host.or(existing.host);
    let auth_method = req.auth_method.unwrap_or(existing.auth_method);
    let credential = req.credential.unwrap_or(existing.credential);
    let is_default = req.is_default.unwrap_or(existing.is_default);

    if is_default {
        sqlx::query("UPDATE git_accounts SET is_default = 0")
            .execute(&state.pool)
            .await
            .map_err(|e| ApiError {
                error: e.to_string(),
                code: "DATABASE_ERROR".to_string(),
            })?;
    }

    sqlx::query(
        "UPDATE git_accounts SET name = ?, provider = ?, host = ?, auth_method = ?, credential = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(&name)
    .bind(&provider)
    .bind(&host)
    .bind(&auth_method)
    .bind(&credential)
    .bind(is_default)
    .bind(&req.id)
    .execute(&state.pool)
    .await
    .map_err(|e| ApiError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Delete ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    pub id: String,
}

pub async fn delete_account(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DeleteAccountRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    sqlx::query("DELETE FROM git_accounts WHERE id = ?")
        .bind(&req.id)
        .execute(&state.pool)
        .await
        .map_err(|e| ApiError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;

    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Test Connection ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TestConnectionRequest {
    pub provider: String,
    pub host: Option<String>,
    pub credential: String,
}

pub async fn test_connection(
    Json(req): Json<TestConnectionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let url = match req.provider.as_str() {
        "github" => "https://api.github.com/user".to_string(),
        "github-enterprise" => {
            let host = req.host.as_deref().unwrap_or("github.com");
            format!("{}/api/v3/user", host.trim_end_matches('/'))
        }
        "gitlab" | "gitlab-selfhosted" => {
            let host = req.host.as_deref().unwrap_or("https://gitlab.com");
            format!("{}/api/v4/user", host.trim_end_matches('/'))
        }
        "gitea" => {
            let host = req.host.as_deref().unwrap_or("https://gitea.com");
            format!("{}/api/v1/user", host.trim_end_matches('/'))
        }
        "bitbucket" => "https://api.bitbucket.org/2.0/user".to_string(),
        _ => return Err(ApiError {
            error: format!("Unknown provider: {}", req.provider),
            code: "VALIDATION".to_string(),
        }),
    };

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", req.credential))
        .header("User-Agent", "NetStacks")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            let username = body.get("login")
                .or_else(|| body.get("username"))
                .or_else(|| body.get("display_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            Ok(Json(serde_json::json!({ "connected": true, "username": username })))
        }
        Ok(r) => {
            Ok(Json(serde_json::json!({ "connected": false, "error": format!("HTTP {}", r.status()) })))
        }
        Err(e) => {
            Ok(Json(serde_json::json!({ "connected": false, "error": e.to_string() })))
        }
    }
}
