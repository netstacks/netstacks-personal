//! Tiny fake LSP server for testing the agent's LSP host.
//!
//! Speaks LSP-over-stdio: reads `Content-Length: N\r\n\r\n{json}` frames,
//! writes the same format. Implements only what Phase 2 integration tests need.
//!
//! Behavior:
//!   - `initialize` request → respond with minimal capabilities + serverInfo
//!   - `initialized` notification → silent
//!   - `textDocument/didOpen` notification → emit `publishDiagnostics` with a
//!     single fake diagnostic so the test can assert round-tripping works
//!   - `shutdown` request → respond with null result
//!   - `exit` notification → process::exit(0)
//!   - anything else → silently ignored

use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::process;

fn main() {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let frame = match read_frame(&mut stdin) {
            Ok(Some(b)) => b,
            Ok(None) => return, // EOF: parent closed stdin
            Err(e) => {
                eprintln!("fake-lsp read error: {}", e);
                return;
            }
        };

        let msg: Value = match serde_json::from_slice(&frame) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("fake-lsp invalid json: {}", e);
                continue;
            }
        };

        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = msg.get("id").cloned();

        match method {
            "initialize" => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "capabilities": {
                            "textDocumentSync": 1, // Full sync
                            "diagnosticProvider": { "interFileDependencies": false, "workspaceDiagnostics": false }
                        },
                        "serverInfo": { "name": "fake-lsp", "version": "0.1.0" }
                    }
                });
                write_frame(&mut stdout, &response);
            }
            "initialized" => {
                // Notification: no response.
            }
            "textDocument/didOpen" => {
                let uri = msg.pointer("/params/textDocument/uri").cloned().unwrap_or(json!(""));
                let diag = json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": uri,
                        "diagnostics": [{
                            "range": {
                                "start": { "line": 0, "character": 0 },
                                "end":   { "line": 0, "character": 1 }
                            },
                            "severity": 1,
                            "source": "fake-lsp",
                            "message": "FAKE-LSP-DIAG: this is a test"
                        }]
                    }
                });
                write_frame(&mut stdout, &diag);
            }
            "shutdown" => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null
                });
                write_frame(&mut stdout, &response);
            }
            "exit" => {
                process::exit(0);
            }
            _ => {
                // Unknown method: silently ignore. Tests only assert on
                // specific behaviors, and we want unimplemented methods
                // to be harmless rather than fatal.
            }
        }
    }
}

/// Read one LSP frame: `Content-Length: N\r\n\r\n{body}`.
/// Returns Ok(Some(body)) on success, Ok(None) on EOF, Err on protocol error.
fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }

        // Header line. The blank line `\r\n` (just `\r\n` after the headers) ends the section.
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix("Content-Length: ") {
            content_length = Some(rest.trim().parse().map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("invalid Content-Length: {}", e))
            })?);
        }
        // Other headers (e.g. Content-Type) are ignored.
    }

    let len = content_length.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length header")
    })?;

    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Write one LSP frame.
fn write_frame<W: Write>(writer: &mut W, value: &Value) {
    let body = serde_json::to_vec(value).expect("serialize JSON");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    if let Err(e) = writer.write_all(header.as_bytes()).and_then(|_| writer.write_all(&body)).and_then(|_| writer.flush()) {
        eprintln!("fake-lsp write error: {}", e);
    }
}
