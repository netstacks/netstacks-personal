//! End-to-end integration test for the LSP plugin host.
//!
//! Boots an axum test server with the LSP router, registers a user-added
//! plugin pointing at the fake-lsp fixture, connects via WebSocket, and
//! round-trips an LSP `initialize` request through the whole stack.

use netstacks_agent::lsp::{http_router, ws_router, LspHost, LspState};
use sqlx::sqlite::SqlitePoolOptions;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::timeout;

/// Merged HTTP+WS router. Previously a library helper; it is only needed by this
/// integration test, so it lives here rather than in the shipped crate.
fn router(state: LspState) -> axum::Router {
    http_router(state.clone()).merge(ws_router(state))
}

fn fake_lsp_path() -> PathBuf {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let bin = PathBuf::from(manifest).join("tests/fixtures/fake-lsp/target/release/fake-lsp");
    if !bin.exists() {
        let status = std::process::Command::new("cargo")
            .args(["build", "--release"])
            .current_dir(bin.parent().unwrap().parent().unwrap())
            .status()
            .expect("cargo build fake-lsp");
        assert!(status.success(), "failed to build fake-lsp");
    }
    bin
}

async fn fresh_pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query(
        r#"CREATE TABLE lsp_plugins (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            language TEXT NOT NULL,
            file_extensions TEXT NOT NULL,
            command TEXT NOT NULL,
            args TEXT NOT NULL,
            env_vars TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"CREATE TABLE lsp_plugin_overrides (
            plugin_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            custom_command TEXT,
            custom_args TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

#[tokio::test]
async fn end_to_end_ws_initialize_round_trip() {
    let pool = fresh_pool().await;
    let fake_lsp = fake_lsp_path();

    // Register the fake LSP as a user-added plugin
    sqlx::query(
        "INSERT INTO lsp_plugins (id, display_name, language, file_extensions, command, args, enabled) \
         VALUES ('fake', 'Fake LSP', 'plaintext', '[\".fake\"]', ?1, '[]', 1)",
    )
    .bind(fake_lsp.to_string_lossy().to_string())
    .execute(&pool)
    .await
    .unwrap();

    // Build the state + router
    let data_dir = tempfile::TempDir::new().unwrap();
    let host = Arc::new(LspHost::new(pool, data_dir.path().to_path_buf()));
    let state = LspState {
        host,
        auth_token: "test-token".to_string(),
    };
    let app = router(state);

    // Spin up an ephemeral TCP listener
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Verify HTTP route: GET /plugins
    let resp = reqwest::get(format!("http://{}/plugins", addr)).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 2, "should have Pyrefly + fake");
    // Find the fake plugin
    let fake = arr.iter().find(|p| p["id"] == "fake").expect("fake plugin");
    assert_eq!(fake["displayName"], "Fake LSP");

    // Connect WebSocket: /ws/fake?token=test-token
    let url = format!("ws://{}/ws/fake?token=test-token", addr);
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("connect");
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // Send initialize as a text frame (JSON, no LSP Content-Length headers
    // at the WS layer — the agent adds those when forwarding to stdio)
    let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#;
    ws.send(Message::Text(init.to_string().into())).await.expect("send init");

    // Receive the response
    let msg = timeout(Duration::from_secs(10), ws.next())
        .await
        .expect("ws timeout")
        .expect("no message")
        .expect("ws error");
    let text = match msg {
        Message::Text(t) => t,
        other => panic!("unexpected message kind: {:?}", other),
    };
    let v: serde_json::Value = serde_json::from_str(&text).expect("parse");
    assert_eq!(v["id"], 1);
    assert_eq!(v["result"]["serverInfo"]["name"], "fake-lsp");

    let _ = ws.close(None).await;
}

#[tokio::test]
async fn ws_rejects_invalid_token() {
    let pool = fresh_pool().await;
    let fake_lsp = fake_lsp_path();
    sqlx::query(
        "INSERT INTO lsp_plugins (id, display_name, language, file_extensions, command, args, enabled) \
         VALUES ('fake', 'Fake LSP', 'plaintext', '[\".fake\"]', ?1, '[]', 1)",
    )
    .bind(fake_lsp.to_string_lossy().to_string())
    .execute(&pool)
    .await
    .unwrap();

    let data_dir = tempfile::TempDir::new().unwrap();
    let state = LspState {
        host: Arc::new(LspHost::new(pool, data_dir.path().to_path_buf())),
        auth_token: "correct-token".to_string(),
    };
    let app = router(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let url = format!("ws://{}/ws/fake?token=wrong-token", addr);
    let result = tokio_tungstenite::connect_async(url).await;
    // Connection should fail with 401
    assert!(result.is_err(), "expected WS upgrade to fail with wrong token");
}

#[tokio::test]
async fn crud_endpoints_create_update_delete() {
    let pool = fresh_pool().await;
    let data_dir = tempfile::TempDir::new().unwrap();
    let state = LspState {
        host: Arc::new(LspHost::new(pool, data_dir.path().to_path_buf())),
        auth_token: "test-token".to_string(),
    };
    let app = router(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let base_url = format!("http://{}", addr);

    // Create a new user-added plugin
    let create_body = serde_json::json!({
        "id": "my-go-lsp",
        "display_name": "My Go LSP",
        "language": "go",
        "file_extensions": [".go"],
        "command": "gopls",
        "args": ["serve"],
        "env_vars": {}
    });

    let resp = client
        .post(format!("{}/plugins", base_url))
        .json(&create_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201, "create should return 201 Created");
    let plugin: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(plugin["id"], "my-go-lsp");
    assert_eq!(plugin["displayName"], "My Go LSP");
    assert_eq!(plugin["source"], "user-added");

    // Update the plugin
    let update_body = serde_json::json!({
        "display_name": "Updated Go LSP",
        "args": ["serve", "-verbose"]
    });

    let resp = client
        .put(format!("{}/plugins/my-go-lsp", base_url))
        .json(&update_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let updated: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(updated["displayName"], "Updated Go LSP");
    assert_eq!(updated["runtime"]["args"], serde_json::json!(["serve", "-verbose"]));

    // List plugins (should have Pyrefly + my-go-lsp)
    let resp = client.get(format!("{}/plugins", base_url)).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let list: serde_json::Value = resp.json().await.unwrap();
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 2, "should have Pyrefly + my-go-lsp");

    // Delete the user-added plugin
    let resp = client
        .delete(format!("{}/plugins/my-go-lsp", base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204, "delete should return 204 No Content");

    // Verify it's gone
    let resp = client.get(format!("{}/plugins", base_url)).send().await.unwrap();
    let list: serde_json::Value = resp.json().await.unwrap();
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 1, "should only have Pyrefly after delete");
}

#[tokio::test]
async fn crud_create_rejects_duplicate_id() {
    let pool = fresh_pool().await;
    let data_dir = tempfile::TempDir::new().unwrap();
    let state = LspState {
        host: Arc::new(LspHost::new(pool, data_dir.path().to_path_buf())),
        auth_token: "test-token".to_string(),
    };
    let app = router(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let base_url = format!("http://{}", addr);

    let create_body = serde_json::json!({
        "id": "my-go-lsp",
        "display_name": "My Go LSP",
        "language": "go",
        "file_extensions": [".go"],
        "command": "gopls",
        "args": ["serve"],
        "env_vars": {}
    });

    // First create succeeds
    let resp = client
        .post(format!("{}/plugins", base_url))
        .json(&create_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);

    // Second create with same id fails
    let resp = client
        .post(format!("{}/plugins", base_url))
        .json(&create_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 409, "duplicate id should return 409 Conflict");
}

#[tokio::test]
async fn crud_update_built_in_writes_override() {
    let pool = fresh_pool().await;
    let data_dir = tempfile::TempDir::new().unwrap();
    let state = LspState {
        host: Arc::new(LspHost::new(pool, data_dir.path().to_path_buf())),
        auth_token: "test-token".to_string(),
    };
    let app = router(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let base_url = format!("http://{}", addr);

    // Update built-in Pyrefly
    let update_body = serde_json::json!({
        "command": "/custom/pyrefly",
        "enabled": false
    });

    let resp = client
        .put(format!("{}/plugins/pyrefly", base_url))
        .json(&update_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let updated: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(updated["runtime"]["command"], "/custom/pyrefly");
    assert_eq!(updated["defaultEnabled"], false);
}
