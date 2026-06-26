use axum::Json;
use serde::{Deserialize, Serialize};
use crate::api::ApiError;
use crate::git::GitOps;

// ── Shared request base ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct WorkspaceRoot {
    pub workspace_root: String,
}

/// Reject paths that are empty, relative, contain a `..` traversal component, or
/// carry control/NUL characters. This is a localhost dev tool, so a workspace or
/// clone destination may legitimately live anywhere on the user's disk — we do
/// not confine to a root — but these guards stop a hostile caller (e.g. a
/// compromised webview) from steering writes via traversal tricks.
fn validate_workspace_path(path: &str) -> Result<(), ApiError> {
    let invalid = |msg: &str| ApiError {
        error: msg.to_string(),
        code: "INVALID_PATH".to_string(),
    };
    if path.trim().is_empty() {
        return Err(invalid("Path must not be empty"));
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(invalid("Path must not contain control characters"));
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(invalid("Path must be absolute"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(invalid("Path must not contain '..' segments"));
    }
    Ok(())
}

// ── Status ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GitStatusResponse {
    pub is_repo: bool,
    pub branch: Option<crate::git::GitBranchInfo>,
    pub files: Vec<crate::git::GitFileStatus>,
}

pub async fn git_status(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let is_repo = ops.is_repo().await;
    if !is_repo {
        return Ok(Json(GitStatusResponse { is_repo: false, branch: None, files: vec![] }));
    }
    let (branch, files) = tokio::join!(ops.branch_info(), ops.status());
    Ok(Json(GitStatusResponse {
        is_repo: true,
        branch: branch.unwrap_or(None),
        files: files.map_err(ApiError::from)?,
    }))
}

// ── Diff ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitDiffRequest {
    pub workspace_root: String,
    pub path: Option<String>,
    /// When true, return the staged diff (git diff --cached) — what will be
    /// committed. When false/omitted, return the working-tree diff (unstaged
    /// changes). Default false preserves the original API behavior.
    #[serde(default)]
    pub staged: bool,
}

pub async fn git_diff(
    Json(req): Json<GitDiffRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let diff = ops
        .diff_with_options(req.path.as_deref(), req.staged)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "diff": diff })))
}

// ── Log ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitLogRequest {
    pub workspace_root: String,
    pub limit: Option<usize>,
    pub path: Option<String>,
}

pub async fn git_log(
    Json(req): Json<GitLogRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let commits = ops
        .log(req.limit.unwrap_or(50), req.path.as_deref())
        .await
        .map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "commits": commits })))
}

// ── Blame ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitBlameRequest {
    pub workspace_root: String,
    pub path: String,
}

pub async fn git_blame(
    Json(req): Json<GitBlameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let lines = ops.blame(&req.path).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "lines": lines })))
}

// ── Stage / Unstage / Revert ───────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitPathsRequest {
    pub workspace_root: String,
    pub paths: Vec<String>,
}

pub async fn git_stage(
    Json(req): Json<GitPathsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let path_refs: Vec<&str> = req.paths.iter().map(|s| s.as_str()).collect();
    ops.stage(&path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn git_unstage(
    Json(req): Json<GitPathsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let path_refs: Vec<&str> = req.paths.iter().map(|s| s.as_str()).collect();
    ops.unstage(&path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn git_revert(
    Json(req): Json<GitPathsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let path_refs: Vec<&str> = req.paths.iter().map(|s| s.as_str()).collect();
    ops.revert(&path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Commit ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitCommitRequest {
    pub workspace_root: String,
    pub message: String,
    pub paths: Option<Vec<String>>,
}

pub async fn git_commit(
    Json(req): Json<GitCommitRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let paths = req.paths.unwrap_or_default();
    let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    let commit = ops.commit(&req.message, &path_refs).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "commit": commit })))
}

// ── Push / Pull / Fetch ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitPushRequest {
    pub workspace_root: String,
    pub force: Option<bool>,
}

pub async fn git_push(
    Json(req): Json<GitPushRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.push(req.force.unwrap_or(false)).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitPullRequest {
    pub workspace_root: String,
    pub rebase: Option<bool>,
}

pub async fn git_pull(
    Json(req): Json<GitPullRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.pull(req.rebase.unwrap_or(false)).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn git_fetch(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.fetch().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Branches ───────────────────────────────────────────────────────────────

pub async fn git_list_branches(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let branches = ops.list_branches().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "branches": branches })))
}

#[derive(Deserialize)]
pub struct GitBranchRequest {
    pub workspace_root: String,
    pub name: String,
    pub from: Option<String>,
}

pub async fn git_create_branch(
    Json(req): Json<GitBranchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.create_branch(&req.name, req.from.as_deref()).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitSwitchRequest {
    pub workspace_root: String,
    pub name: String,
}

pub async fn git_switch_branch(
    Json(req): Json<GitSwitchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.switch_branch(&req.name).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitDeleteBranchRequest {
    pub workspace_root: String,
    pub name: String,
    pub force: Option<bool>,
}

pub async fn git_delete_branch(
    Json(req): Json<GitDeleteBranchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.delete_branch(&req.name, req.force.unwrap_or(false)).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
pub struct GitMergeRequest {
    pub workspace_root: String,
    pub branch: String,
}

pub async fn git_merge(
    Json(req): Json<GitMergeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.merge(&req.branch).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Stash ──────────────────────────────────────────────────────────────────

pub async fn git_list_stashes(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let stashes = ops.list_stashes().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "stashes": stashes })))
}

#[derive(Deserialize)]
pub struct GitStashRequest {
    pub workspace_root: String,
    pub action: String,
    pub index: Option<usize>,
}

pub async fn git_stash(
    Json(req): Json<GitStashRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.stash(&req.action, req.index).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Init ───────────────────────────────────────────────────────────────────

pub async fn git_init(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.init().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Commit Amend ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitCommitAmendRequest {
    pub workspace_root: String,
    pub message: String,
}

pub async fn git_commit_amend(
    Json(req): Json<GitCommitAmendRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let commit = ops.commit_amend(&req.message).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "commit": commit })))
}

// ── Rebase Plan ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitRebasePlanRequest {
    pub workspace_root: String,
    pub count: Option<usize>,
}

pub async fn git_rebase_plan(
    Json(req): Json<GitRebasePlanRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let n = req.count.unwrap_or(20);
    let commits = ops.rebase_plan(n).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "commits": commits })))
}

// ── Rebase Apply ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitRebaseApplyRequest {
    pub workspace_root: String,
    pub base_hash: String,
    pub plan: Vec<crate::git::RebasePlanItem>,
}

pub async fn git_rebase_apply(
    Json(req): Json<GitRebaseApplyRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.rebase_apply(&req.base_hash, &req.plan).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Rebase Abort ──────────────────────────────────────────────────────────

pub async fn git_rebase_abort(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    ops.rebase_abort().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Generate Commit Message ───────────────────────────────────────────────

pub async fn git_generate_commit_message(
    Json(req): Json<WorkspaceRoot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ops = GitOps::new(&req.workspace_root);
    let message = ops.generate_commit_message().await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "message": message })))
}

// ── Clone ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct GitCloneRequest {
    pub url: String,
    pub destination: String,
}

pub async fn git_clone(
    Json(req): Json<GitCloneRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    validate_workspace_path(&req.destination)?;
    // Restrict the remote to network transports — blocks `file://`, `ext::`
    // (arbitrary command), and leading-dash option injection into `git clone`.
    let url = req.url.trim();
    let url_ok = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git@");
    if !url_ok {
        return Err(ApiError {
            error: "Clone URL must use https://, http://, ssh://, or git@".to_string(),
            code: "INVALID_URL".to_string(),
        });
    }
    GitOps::clone_repo(url, &req.destination).await.map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ── Open File Signal ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OpenFileRequest {
    pub workspace_root: String,
    pub path: String,
    pub line: Option<usize>,
}

pub async fn open_file(
    Json(req): Json<OpenFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    validate_workspace_path(&req.workspace_root)?;
    let sep = if req.workspace_root.contains('/') { "/" } else { "\\" };
    let ns_dir = format!("{}{}.netstacks", req.workspace_root, sep);
    let signal_path = format!("{}{}open-request.json", ns_dir, sep);

    let _ = tokio::fs::create_dir_all(&ns_dir).await;

    let signal = serde_json::json!({
        "path": req.path,
        "line": req.line,
    });

    let signal_json = serde_json::to_string_pretty(&signal)
        .map_err(|e| ApiError { error: format!("Failed to serialize signal: {}", e), code: "IO_ERROR".to_string() })?;
    tokio::fs::write(&signal_path, signal_json)
        .await
        .map_err(|e| ApiError {
            error: format!("Failed to write open-request signal: {}", e),
            code: "IO_ERROR".to_string(),
        })?;

    Ok(Json(serde_json::json!({ "success": true })))
}
