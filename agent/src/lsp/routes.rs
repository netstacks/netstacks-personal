//! Axum route handlers for the LSP plugin system.
//!
//! Mounted under `/lsp` in `main.rs::create_app` (done in P2T9). The
//! WebSocket route uses `?token=...` query auth like `ws.rs::terminal_ws`.
//! REST endpoints are protected by the existing auth_middleware at mount
//! time.

use crate::lsp::host::{LspHost, LspHostError, PluginUpdateInput, UserPluginInput, WorkspaceKey};
use crate::lsp::test_cmd::{test_lsp_command, TestCommandInput};
use crate::lsp::types::{InstallStatus, LspPlugin};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

/// Axum state for LSP routes.
#[derive(Clone)]
pub struct LspState {
    pub host: Arc<LspHost>,
    pub auth_token: String,
}

/// HTTP routes for plugin management. Auth handled by middleware at mount time.
pub fn http_router(state: LspState) -> Router {
    Router::new()
        .route("/plugins", get(list_plugins))
        .route("/plugins", post(create_plugin))
        .route("/plugins/:id", put(update_plugin))
        .route("/plugins/:id", delete(delete_plugin))
        .route("/plugins/:id/install", post(install_plugin))
        .route("/plugins/test", post(test_plugin_command))
        .with_state(state)
}

/// Query-token-auth routes (WebSocket + SSE). These bypass the bearer
/// auth middleware because browser EventSource and WebSocket APIs can't
/// send custom headers — auth rides as `?token=...` and each handler
/// verifies it explicitly.
pub fn ws_router(state: LspState) -> Router {
    Router::new()
        .route("/ws/:plugin_id", get(lsp_websocket))
        .route("/plugins/:id/install-progress", get(install_progress))
        .with_state(state)
}

// ===== Plugin listing =====

#[derive(Serialize)]
struct PluginListItem {
    #[serde(flatten)]
    plugin: LspPlugin,
    #[serde(rename = "installStatus")]
    install_status: InstallStatus,
}

async fn list_plugins(State(state): State<LspState>) -> impl IntoResponse {
    match state.host.list_plugins().await {
        Ok(plugins) => {
            let items: Vec<PluginListItem> = plugins
                .into_iter()
                .map(|p| {
                    let install_status = state.host.compute_install_status(&p);
                    PluginListItem {
                        plugin: p,
                        install_status,
                    }
                })
                .collect();
            (StatusCode::OK, axum::Json(items)).into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, "list_plugins failed");
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
        }
    }
}

// ===== CRUD endpoints (Phase 5) =====

async fn create_plugin(
    State(state): State<LspState>,
    axum::Json(input): axum::Json<UserPluginInput>,
) -> impl IntoResponse {
    match state.host.create_user_plugin(input).await {
        Ok(plugin) => (StatusCode::CREATED, axum::Json(plugin)).into_response(),
        Err(LspHostError::InvalidConfig(msg)) => (StatusCode::CONFLICT, msg).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn update_plugin(
    State(state): State<LspState>,
    Path(id): Path<String>,
    axum::Json(input): axum::Json<PluginUpdateInput>,
) -> impl IntoResponse {
    match state.host.update_plugin(&id, input).await {
        Ok(plugin) => (StatusCode::OK, axum::Json(plugin)).into_response(),
        Err(LspHostError::PluginNotFound(_)) => {
            (StatusCode::NOT_FOUND, "plugin not found").into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

async fn delete_plugin(
    State(state): State<LspState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Try user-added removal first; if that errs with "built-in", fall through to uninstall (Phase 4).
    match state.host.delete_user_plugin(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(LspHostError::InvalidConfig(_)) => {
            // It's a built-in; route to uninstall (Phase 4 added this)
            match state.host.uninstall_plugin(&id).await {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            }
        }
        Err(LspHostError::PluginNotFound(_)) => {
            (StatusCode::NOT_FOUND, "plugin not found").into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn install_plugin(
    State(state): State<LspState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Kick off the install asynchronously and return 202 Accepted.
    match state.host.install_plugin(id.clone()).await {
        Ok(_rx) => {
            tracing::info!(plugin_id = %id, "install started");
            StatusCode::ACCEPTED.into_response()
        }
        Err(e) => {
            let status = if e.to_string().contains("already in progress") {
                StatusCode::CONFLICT
            } else if e.to_string().contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, e.to_string()).into_response()
        }
    }
}

async fn install_progress(
    State(state): State<LspState>,
    Path(id): Path<String>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    // Auth: query token must match the agent's session token (SSE, like WS, cannot send custom headers).
    let token_ok = query.token.as_deref() == Some(state.auth_token.as_str());
    if !token_ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    // Subscribe to the install progress channel for SSE streaming.
    let rx = match state.host.installs.get(&id) {
        Some(tx) => tx.subscribe(),
        None => {
            // No install in progress; check if plugin exists
            match state.host.get_plugin(&id).await {
                Ok(_) => {
                    return (
                        StatusCode::NOT_FOUND,
                        "no install in progress for this plugin",
                    )
                        .into_response()
                }
                Err(_) => {
                    return (StatusCode::NOT_FOUND, "plugin not found").into_response()
                }
            }
        }
    };

    let stream = BroadcastStream::new(rx);
    let event_stream = stream.filter_map(|result| async move {
        match result {
            Ok(event) => {
                let json = serde_json::to_string(&event).ok()?;
                Some(Ok::<_, Infallible>(Event::default().event("progress").data(json)))
            }
            Err(_) => None, // Lagged or closed; skip
        }
    });

    Sse::new(event_stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn test_plugin_command(
    axum::Json(input): axum::Json<TestCommandInput>,
) -> impl IntoResponse {
    let result = test_lsp_command(input).await;
    (StatusCode::OK, axum::Json(result)).into_response()
}

// ===== WebSocket: LSP JSON-RPC bridge =====

#[derive(Debug, Deserialize)]
struct WsQuery {
    /// Bearer token (same as the agent's auth_token).
    token: Option<String>,
    /// Workspace root (absolute path). When absent, use scratch mode.
    workspace: Option<String>,
    /// When `1`, force loose-file/scratch mode even if no workspace given.
    /// Phase 6 wires this up in earnest; for Phase 2 it's just an alternative
    /// to "no workspace param".
    scratch: Option<String>,
}

async fn lsp_websocket(
    ws: WebSocketUpgrade,
    State(state): State<LspState>,
    Path(plugin_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    // Auth: query token must match the agent's session token.
    let token_ok = query.token.as_deref() == Some(state.auth_token.as_str());
    if !token_ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    // Resolve workspace key
    let workspace_key = match (query.workspace.as_deref(), query.scratch.as_deref()) {
        (Some(path), _) => WorkspaceKey::Path(PathBuf::from(path)),
        (None, Some(_)) => WorkspaceKey::Scratch(Uuid::new_v4().to_string()),
        (None, None) => WorkspaceKey::Scratch(Uuid::new_v4().to_string()),
    };

    // Look up the session (spawn if needed)
    let session = match state.host.get_or_create_session(&plugin_id, workspace_key).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(plugin_id, error = %e, "get_or_create_session failed");
            return (StatusCode::NOT_FOUND, e.to_string()).into_response();
        }
    };

    ws.on_upgrade(move |socket| async move {
        bridge_websocket_to_session(socket, session).await;
    })
    .into_response()
}

/// Once upgraded, fan out child stdout → WebSocket and WebSocket → child stdin.
async fn bridge_websocket_to_session(
    socket: WebSocket,
    session: Arc<crate::lsp::session::LspSession>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut outbound = session.subscribe();
    let inbound = session.inbound_sender();

    // Task: drain LSP child stdout → WebSocket
    let outbound_task = tokio::spawn(async move {
        loop {
            match outbound.recv().await {
                Ok(body) => {
                    // Wrap the JSON body in a text WebSocket frame. The
                    // browser client (Phase 3) gets unframed JSON; LSP
                    // framing (Content-Length headers) only exists at the
                    // stdio boundary.
                    let text = match String::from_utf8(body) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if ws_tx.send(Message::Text(text)).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("LSP broadcast lagged {} messages for this client", n);
                    continue;
                }
                Err(RecvError::Closed) => return,
            }
        }
    });

    // Task: drain WebSocket → LSP child stdin
    let inbound_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if inbound.send(text.into_bytes()).await.is_err() {
                        return;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    if inbound.send(bytes.to_vec()).await.is_err() {
                        return;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => return,
                _ => {}
            }
        }
    });

    // Wait for either side to finish, then drop the other.
    tokio::select! {
        _ = outbound_task => {},
        _ = inbound_task => {},
    }

    // Note: we deliberately do NOT shut down the session here. Other
    // WebSocket clients may still be attached, and even if not, P2T11
    // will add a grace-period teardown. For Phase 2, the session lives
    // until the agent shuts down or explicit teardown is requested.
    let _ = Duration::from_secs(0); // no-op; reserved for grace-period logic in P2T11
}
