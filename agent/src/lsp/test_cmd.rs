//! LSP command testing utility.
//!
//! Spawns a candidate LSP command, sends an `initialize` request, and validates
//! the response to verify the command is a working LSP server.

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Input for testing an LSP command.
#[derive(Debug, Deserialize)]
pub struct TestCommandInput {
    pub command: String,
    pub args: Vec<String>,
}

/// Result of testing an LSP command.
#[derive(Debug, Serialize)]
pub struct TestCommandResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
}

/// Test an LSP command by spawning it and sending an `initialize` request.
///
/// Returns success if the server responds with valid LSP JSON-RPC.
pub async fn test_lsp_command(input: TestCommandInput) -> TestCommandResult {
    let mut cmd = Command::new(&input.command);
    cmd.args(&input.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return TestCommandResult {
                success: false,
                error_message: Some(format!("failed to spawn: {}", e)),
                stderr: None,
            }
        }
    };

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    // Send LSP initialize
    let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#;
    let header = format!("Content-Length: {}\r\n\r\n", init.len());
    let _ = stdin.write_all(header.as_bytes()).await;
    let _ = stdin.write_all(init).await;
    let _ = stdin.flush().await;

    // Wait for response with 5s timeout
    let mut buf = vec![0u8; 4096];
    let read_result = timeout(Duration::from_secs(5), stdout.read(&mut buf)).await;

    // Capture some stderr regardless
    let mut stderr_buf = String::new();
    let _ = timeout(Duration::from_millis(100), stderr.read_to_string(&mut stderr_buf)).await;

    // Kill the child
    let _ = child.kill().await;

    match read_result {
        Ok(Ok(n)) if n > 0 => {
            // Check the response looks like LSP
            let response = String::from_utf8_lossy(&buf[..n]);
            if response.contains("Content-Length:") && response.contains("\"jsonrpc\"") {
                TestCommandResult {
                    success: true,
                    error_message: None,
                    stderr: None,
                }
            } else {
                TestCommandResult {
                    success: false,
                    error_message: Some(format!(
                        "Got response but it doesn't look like LSP: {}",
                        response.chars().take(200).collect::<String>()
                    )),
                    stderr: Some(stderr_buf),
                }
            }
        }
        Ok(Ok(_)) => TestCommandResult {
            success: false,
            error_message: Some("Process produced no output before timeout".into()),
            stderr: Some(stderr_buf),
        },
        Ok(Err(e)) => TestCommandResult {
            success: false,
            error_message: Some(format!("I/O error reading response: {}", e)),
            stderr: Some(stderr_buf),
        },
        Err(_) => TestCommandResult {
            success: false,
            error_message: Some("Timed out waiting for LSP response (5s)".into()),
            stderr: Some(stderr_buf),
        },
    }
}
