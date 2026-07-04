//! Scripts module for Python automation scripts
//!
//! Handles CRUD operations for scripts and script execution.
//! Uses `uv` for Python management — downloaded on first use, uses PEP 723
//! inline script metadata for dependency resolution.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::FromRow;
use std::convert::Infallible;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::models::{format_datetime, parse_datetime, CliFlavor, NewScript, Script, ScriptOutput, UpdateScript};
use crate::providers::DataProvider;

// =============================================================================
// uv management
// =============================================================================

const UV_VERSION: &str = "0.6.12";

/// SHA-256 sums for each (arch, OS, ext) tuple of uv release artifacts.
///
/// AUDIT FIX (EXEC-012): the previous implementation `curl | tar`'d the
/// release archive with NO signature verification. A network-position
/// attacker who could MITM github.com (rare but real with intercepting
/// proxies) — or a compromise of Astral's release — would silently backdoor
/// every NetStacks installation that runs Python scripts. Hashes pulled
/// from the official `<artifact>.sha256` files published alongside the
/// 0.6.12 release. Bumping `UV_VERSION` MUST also update this table.
const UV_SHA256_SUMS: &[(&str, &str)] = &[
    ("uv-aarch64-apple-darwin.tar.gz",       "fab8db5b62da1e945524b8d1a9d4946fcc6d9b77ec0cab423d953e82159967ac"),
    ("uv-x86_64-apple-darwin.tar.gz",        "5b6ee08766de11dc49ee9e292333e8b46ef2ceaaa3ebb0388467e114fca2ed8c"),
    ("uv-aarch64-unknown-linux-gnu.tar.gz",  "d867553e5ea19f9cea08e564179d909c69ecfce5e7e382099d1844dbf1c9878c"),
    ("uv-x86_64-unknown-linux-gnu.tar.gz",   "eec3ccf53616e00905279a302bc043451bd96ca71a159a2ac3199452ac914c26"),
    ("uv-aarch64-pc-windows-msvc.zip",       "d72d8cf0633dc40198a868e906442bc6bacfa38c3b807c26bcbf3fc364af5d96"),
    ("uv-x86_64-pc-windows-msvc.zip",        "30fdf26c209f0cb7c97d3b08a26ab4e78ce5ae0e031b88798cbaccc0f24f452b"),
];

fn expected_uv_sha256(filename: &str) -> Option<&'static str> {
    UV_SHA256_SUMS.iter().find_map(|(name, hash)| (*name == filename).then_some(*hash))
}

/// Path to cached uv binary in data dir
fn uv_cache_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("netstacks")
        .join("uv")
        .join(UV_VERSION)
        .join("uv")
}

/// Download uv on first use, return path to binary.
///
/// AUDIT FIX (EXEC-012): the archive is fetched via `reqwest` (rustls TLS,
/// system-trust-store cert validation) into memory, hashed, compared
/// constant-time against the embedded SHA-256 for that artifact, and only
/// then unpacked. A hash mismatch aborts before any bytes are written to
/// disk — preventing both a hostile mirror and a successful MITM from
/// installing a tampered uv binary that would later run with full device
/// credentials in env (per EXEC-013).
pub async fn ensure_uv() -> Result<PathBuf, ScriptError> {
    use sha2::{Digest, Sha256};

    let cached = uv_cache_path();
    if cached.exists() {
        return Ok(cached);
    }

    let dir = cached.parent().unwrap().to_path_buf();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| ScriptError {
        error: format!("Failed to create uv cache dir: {}", e),
        code: "UV_DOWNLOAD_FAILED".to_string(),
    })?;

    let (os, ext) = if cfg!(target_os = "macos") {
        ("apple-darwin", "tar.gz")
    } else if cfg!(target_os = "linux") {
        ("unknown-linux-gnu", "tar.gz")
    } else {
        ("pc-windows-msvc", "zip")
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let filename = format!("uv-{}-{}.{}", arch, os, ext);
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{}/{}",
        UV_VERSION, filename
    );

    let expected_hash = expected_uv_sha256(&filename).ok_or_else(|| ScriptError {
        error: format!(
            "No SHA-256 pinned for uv artifact '{}'. Update UV_SHA256_SUMS in scripts.rs.",
            filename
        ),
        code: "UV_DOWNLOAD_FAILED".to_string(),
    })?;

    tracing::info!("Downloading uv v{} ({})...", UV_VERSION, filename);

    let bytes = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| ScriptError {
            error: format!("Failed to build HTTP client: {}", e),
            code: "UV_DOWNLOAD_FAILED".to_string(),
        })?
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| ScriptError {
            error: format!("Failed to download uv from {}: {}", url, e),
            code: "UV_DOWNLOAD_FAILED".to_string(),
        })?
        .bytes()
        .await
        .map_err(|e| ScriptError {
            error: format!("Failed to read uv download body: {}", e),
            code: "UV_DOWNLOAD_FAILED".to_string(),
        })?;

    // Constant-time SHA-256 compare. A mismatch must NEVER write the
    // tampered archive to disk.
    let actual = Sha256::digest(&bytes);
    let actual_hex: String = actual.iter().map(|b| format!("{:02x}", b)).collect();
    use subtle::ConstantTimeEq;
    let ok: bool = actual_hex.as_bytes().ct_eq(expected_hash.as_bytes()).into();
    if !ok {
        tracing::error!(
            target: "audit",
            expected = %expected_hash,
            actual = %actual_hex,
            url = %url,
            "uv download SHA-256 MISMATCH — refusing to install"
        );
        return Err(ScriptError {
            error: format!(
                "uv download integrity check failed (expected {}, got {}). \
                 Refusing to install — see audit log.",
                expected_hash, actual_hex
            ),
            code: "UV_INTEGRITY_FAILED".to_string(),
        });
    }

    // Hash matches — write the archive to a temp path and unpack.
    let archive_path = dir.join(format!("{}.download", filename));
    tokio::fs::write(&archive_path, &bytes)
        .await
        .map_err(|e| ScriptError {
            error: format!("Failed to write uv archive: {}", e),
            code: "UV_DOWNLOAD_FAILED".to_string(),
        })?;

    let dir_str = dir.display().to_string();
    let archive_str = archive_path.display().to_string();
    let unpack_status = if ext == "zip" {
        Command::new("unzip")
            .args(["-o", "-q", &archive_str, "-d", &dir_str])
            .status()
            .await
    } else {
        Command::new("tar")
            .args(["xzf", &archive_str, "-C", &dir_str, "--strip-components=1"])
            .status()
            .await
    }
    .map_err(|e| ScriptError {
        error: format!("Failed to spawn unpack: {}", e),
        code: "UV_DOWNLOAD_FAILED".to_string(),
    })?;

    let _ = tokio::fs::remove_file(&archive_path).await;

    if !unpack_status.success() {
        return Err(ScriptError {
            error: format!("uv unpack failed (exit {:?})", unpack_status.code()),
            code: "UV_DOWNLOAD_FAILED".to_string(),
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cached, std::fs::Permissions::from_mode(0o755)).map_err(
            |e| ScriptError {
                error: format!("Failed to set uv permissions: {}", e),
                code: "UV_DOWNLOAD_FAILED".to_string(),
            },
        )?;
    }

    tracing::info!(
        target: "audit",
        version = %UV_VERSION,
        path = %cached.display(),
        "uv downloaded and SHA-256 verified"
    );
    Ok(cached)
}

// =============================================================================
// PEP 723 inline script metadata
// =============================================================================

/// Check if script already has PEP 723 inline metadata
fn has_script_metadata(content: &str) -> bool {
    content.lines().any(|line| line.trim() == "# /// script")
}

/// Strip any existing PEP 723 metadata block from script content
fn strip_script_metadata(content: &str) -> String {
    let mut result = String::new();
    let mut in_metadata = false;

    for line in content.lines() {
        if line.trim() == "# /// script" {
            in_metadata = true;
            continue;
        }
        if in_metadata {
            if line.trim() == "# ///" {
                in_metadata = false;
                continue;
            }
            // Skip metadata lines (they start with #)
            if line.starts_with('#') {
                continue;
            }
            // If we hit a non-comment line while supposedly in metadata,
            // the block was malformed — stop stripping
            in_metadata = false;
        }
        result.push_str(line);
        result.push('\n');
    }
    result
}

/// Map Python module names to PyPI package names where they differ.
/// Modules not in this map are assumed to have the same PyPI name as the import.
fn module_to_pypi(module: &str) -> Option<&'static str> {
    match module {
        // Network automation
        "netmiko" => Some("netmiko"),
        "paramiko" => Some("paramiko"),
        "napalm" => Some("napalm"),
        "textfsm" => Some("textfsm"),
        "ntc_templates" => Some("ntc-templates"),
        "ttp" => Some("ttp"),
        "nornir" => Some("nornir"),
        "scrapli" => Some("scrapli"),
        "pysnmp" => Some("pysnmp"),
        "ncclient" => Some("ncclient"),
        "pynetbox" => Some("pynetbox"),
        "ciscoconfparse" => Some("ciscoconfparse"),

        // Common libraries with different PyPI names
        "yaml" => Some("pyyaml"),
        "bs4" => Some("beautifulsoup4"),
        "cv2" => Some("opencv-python"),
        "sklearn" => Some("scikit-learn"),
        "PIL" => Some("pillow"),
        "gi" => Some("PyGObject"),
        "attr" => Some("attrs"),
        "dateutil" => Some("python-dateutil"),
        "dotenv" => Some("python-dotenv"),
        "serial" => Some("pyserial"),
        "usb" => Some("pyusb"),
        "dns" => Some("dnspython"),

        // Common libraries (same name)
        "requests" => Some("requests"),
        "jinja2" => Some("jinja2"),
        "xmltodict" => Some("xmltodict"),
        "rich" => Some("rich"),
        "pandas" => Some("pandas"),
        "numpy" => Some("numpy"),
        "httpx" => Some("httpx"),
        "aiohttp" => Some("aiohttp"),
        "tabulate" => Some("tabulate"),
        "click" => Some("click"),
        "pydantic" => Some("pydantic"),
        "toml" => Some("toml"),
        "tomli" => Some("tomli"),
        "colorama" => Some("colorama"),
        "tqdm" => Some("tqdm"),
        "lxml" => Some("lxml"),
        "cryptography" => Some("cryptography"),
        "jwt" => Some("pyjwt"),
        "netaddr" => Some("netaddr"),

        // Standard library modules — no PyPI package needed
        "os" | "sys" | "re" | "json" | "csv" | "math" | "time" | "datetime"
        | "collections" | "itertools" | "functools" | "pathlib" | "typing"
        | "subprocess" | "shutil" | "tempfile" | "glob" | "fnmatch"
        | "io" | "string" | "textwrap" | "struct" | "copy" | "enum"
        | "abc" | "contextlib" | "dataclasses" | "logging" | "argparse"
        | "unittest" | "pdb" | "traceback" | "warnings" | "inspect"
        | "socket" | "http" | "urllib" | "email" | "html" | "xml"
        | "sqlite3" | "hashlib" | "hmac" | "secrets" | "base64"
        | "threading" | "multiprocessing" | "concurrent" | "asyncio"
        | "signal" | "uuid" | "pprint" | "dis" | "ast" | "token"
        | "tokenize" | "platform" | "locale" | "getpass" | "gettext"
        | "configparser" | "shelve" | "pickle" | "marshal" | "dbm"
        | "gzip" | "bz2" | "lzma" | "zipfile" | "tarfile" | "zlib"
        | "array" | "queue" | "heapq" | "bisect" | "weakref"
        | "types" | "codecs" | "unicodedata" | "difflib" | "statistics"
        | "decimal" | "fractions" | "random" | "cmath" | "operator"
        | "errno" | "ctypes" | "select" | "selectors" | "mmap"
        | "syslog" | "pty" | "tty" | "termios" | "fcntl" | "resource"
        | "grp" | "pwd" | "posixpath" | "ntpath" | "stat" | "fileinput"
        | "linecache" | "shlex" | "cmd" | "code" | "codeop"
        | "compileall" | "py_compile" | "symtable" | "pkgutil"
        | "importlib" | "runpy" | "builtins" | "__future__"
        | "ssl" | "ftplib" | "smtplib" | "imaplib" | "poplib"
        | "xmlrpc" | "ipaddress" | "mailbox" | "mimetypes"
        | "webbrowser" | "cgi" | "cgitb" | "wsgiref" | "atexit"
        | "sched" | "contextvars" | "graphlib" | "tomllib" => None,

        _ => Some("LOOKUP"), // sentinel: use module name as-is for PyPI
    }
}

/// Extract top-level import module names from Python source code
fn extract_imports(content: &str) -> Vec<String> {
    let mut modules = std::collections::HashSet::new();
    let import_re = Regex::new(r"(?m)^\s*import\s+([a-zA-Z_][a-zA-Z0-9_.]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_.]*)*)").unwrap();
    let from_re = Regex::new(r"(?m)^\s*from\s+([a-zA-Z_][a-zA-Z0-9_.]*)").unwrap();

    for cap in import_re.captures_iter(content) {
        let imports_str = cap.get(1).unwrap().as_str();
        for part in imports_str.split(',') {
            let module = part.split_whitespace().next().unwrap_or("").trim();
            if !module.is_empty() {
                // Take only top-level package name (e.g., "os.path" -> "os")
                let top = module.split('.').next().unwrap_or(module);
                modules.insert(top.to_string());
            }
        }
    }

    for cap in from_re.captures_iter(content) {
        let module = cap.get(1).unwrap().as_str();
        let top = module.split('.').next().unwrap_or(module);
        modules.insert(top.to_string());
    }

    let mut sorted: Vec<String> = modules.into_iter().collect();
    sorted.sort();
    sorted
}

/// Build PEP 723 inline script metadata from detected imports
fn build_script_metadata(content: &str) -> String {
    let imports = extract_imports(content);
    let mut deps: Vec<String> = Vec::new();

    for module in &imports {
        match module_to_pypi(module) {
            None => {} // stdlib, skip
            Some("LOOKUP") => {
                // Unknown module — assume PyPI name matches import name
                deps.push(format!("\"{}\"", module));
            }
            Some(pypi_name) => {
                deps.push(format!("\"{}\"", pypi_name));
            }
        }
    }

    if deps.is_empty() {
        // No third-party deps — still need metadata for uv --script
        return "# /// script\n# requires-python = \">=3.11\"\n# ///".to_string();
    }

    let mut meta = String::from("# /// script\n# requires-python = \">=3.11\"\n# dependencies = [\n");
    for (i, dep) in deps.iter().enumerate() {
        meta.push_str(&format!("#   {}", dep));
        if i < deps.len() - 1 {
            meta.push(',');
        }
        meta.push('\n');
    }
    meta.push_str("# ]\n# ///");
    meta
}

/// Prepare script with dynamically generated PEP 723 metadata based on imports.
/// Always strips existing metadata and regenerates from import analysis.
fn prepend_dynamic_metadata(content: &str) -> String {
    let clean = if has_script_metadata(content) {
        strip_script_metadata(content)
    } else {
        content.to_string()
    };
    let metadata = build_script_metadata(&clean);
    format!("{}\n{}", metadata, clean)
}

// =============================================================================
// main() wrapper for Windmill-style convention
// =============================================================================

/// Check if script has def main() but no if __name__ == "__main__" guard calling it
fn needs_main_wrapper(content: &str) -> bool {
    content.contains("def main(")
        && !(content.contains("if __name__") && content.contains("main("))
}

fn append_main_wrapper(content: &str) -> String {
    format!(
        "{}\n\nif __name__ == \"__main__\":\n    import json as _json, os as _os\n    _ns_args = _json.loads(_os.environ.get(\"NETSTACKS_ARGS\", \"{{}}\"))\n    _ns_result = main(**_ns_args)\n    if _ns_result is not None:\n        print(_ns_result if isinstance(_ns_result, str) else _json.dumps(_ns_result, indent=2, default=str))\n",
        content
    )
}

/// Scripts state containing database pool and data provider
pub struct ScriptsState {
    pub pool: SqlitePool,
    pub provider: Arc<dyn DataProvider>,
}

/// Options for running a script with device targeting
#[derive(Debug, Deserialize, Default)]
pub struct RunScriptOptions {
    #[serde(alias = "session_ids")]
    pub device_ids: Option<Vec<String>>,
    pub custom_input: Option<String>,
    #[serde(default = "default_execution_mode")]
    pub execution_mode: Option<String>,
    /// JSON-serialized main() arguments (Windmill-style convention)
    pub main_args: Option<String>,
}

fn default_execution_mode() -> Option<String> {
    Some("parallel".to_string())
}

/// Per-device result
#[derive(Debug, Serialize)]
struct ScriptDeviceResult {
    device_id: String,
    device_name: String,
    host: String,
    status: String,
    stdout: String,
    stderr: String,
    exit_code: i32,
    duration_ms: u64,
}

/// Map CliFlavor to netmiko device_type string
fn cli_flavor_to_netmiko(flavor: &CliFlavor) -> &'static str {
    match flavor {
        CliFlavor::Auto => "autodetect",
        CliFlavor::Linux => "linux",
        CliFlavor::CiscoIos => "cisco_ios",
        CliFlavor::CiscoIosXr => "cisco_xr",
        CliFlavor::CiscoNxos => "cisco_nxos",
        CliFlavor::Juniper => "juniper_junos",
        CliFlavor::Arista => "arista_eos",
        CliFlavor::Paloalto => "paloalto_panos",
        CliFlavor::Fortinet => "fortinet",
    }
}

/// Internal row type for scripts from SQLite
#[derive(Debug, FromRow)]
struct ScriptRow {
    id: String,
    name: String,
    content: String,
    is_template: i32,
    last_run_at: Option<String>,
    created_at: String,
    updated_at: String,
    /// AUDIT FIX (EXEC-014): provenance — `'user'`, `'ai'`, or `'template'`.
    #[sqlx(default)]
    created_by: Option<String>,
    /// AUDIT FIX (EXEC-014): approval flag for AI-authored scripts.
    #[sqlx(default)]
    approved: Option<i32>,
}

impl ScriptRow {
    fn into_script(self) -> Result<Script, String> {
        let last_run_at = self
            .last_run_at
            .map(|s| parse_datetime(&s))
            .transpose()?;

        Ok(Script {
            id: self.id,
            name: self.name,
            content: self.content,
            is_template: self.is_template != 0,
            last_run_at,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
            created_by: self.created_by.unwrap_or_else(|| "user".to_string()),
            approved: self.approved.map(|v| v != 0).unwrap_or(true),
        })
    }
}


/// API error response
#[derive(Debug, Serialize)]
pub struct ScriptError {
    pub error: String,
    pub code: String,
}

impl axum::response::IntoResponse for ScriptError {
    fn into_response(self) -> axum::response::Response {
        let status = match self.code.as_str() {
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "VALIDATION" => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self)).into_response()
    }
}

// === Script Endpoints ===

/// List all scripts
pub async fn list_scripts(
    State(state): State<Arc<ScriptsState>>,
) -> Result<Json<Vec<Script>>, ScriptError> {
    let rows: Vec<ScriptRow> =
        sqlx::query_as("SELECT * FROM scripts ORDER BY is_template DESC, name")
            .fetch_all(&state.pool)
            .await
            .map_err(|e| ScriptError {
                error: e.to_string(),
                code: "DATABASE_ERROR".to_string(),
            })?;

    let scripts: Result<Vec<Script>, _> = rows.into_iter().map(|r| r.into_script()).collect();
    scripts.map(Json).map_err(|e| ScriptError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Get a single script
pub async fn get_script(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
) -> Result<Json<Script>, ScriptError> {
    let row: ScriptRow = sqlx::query_as("SELECT * FROM scripts WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| ScriptError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| ScriptError {
            error: format!("Script not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    row.into_script()
        .map(Json)
        .map_err(|e| ScriptError {
            error: e,
            code: "PARSE_ERROR".to_string(),
        })
}

/// Create a new script.
///
/// AUDIT FIX (EXEC-014): every row carries a `created_by` ('user' / 'ai' /
/// 'template') and an `approved` flag. The frontend's AI side panel sets
/// `X-NetStacks-AI-Origin: true` on requests it makes on the AI's behalf;
/// in that case the row is tagged `'ai'` + `approved=0` and the script
/// cannot be run until the user explicitly calls
/// `POST /api/scripts/:id/approve`. Plain user-initiated POSTs (no header)
/// default to `'user'` + `approved=1`. Caller-supplied `created_by` is
/// ignored — only the header is trusted as a provenance signal so a
/// prompt-injected AI cannot self-promote.
pub async fn create_script(
    State(state): State<Arc<ScriptsState>>,
    headers: axum::http::HeaderMap,
    Json(new_script): Json<NewScript>,
) -> Result<(StatusCode, Json<Script>), ScriptError> {
    let ai_origin = headers
        .get("x-netstacks-ai-origin")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false);

    if ai_origin {
        let id = create_ai_script(&state.pool, &new_script.name, &new_script.content).await?;
        let script = get_script_by_id(&state.pool, &id).await?;
        return Ok((StatusCode::CREATED, Json(script)));
    }

    let id = Uuid::new_v4().to_string();
    let now = format_datetime(&Utc::now());
    let created_by = match new_script.created_by.as_deref() {
        Some("template") => "template",
        _ => "user",
    };

    sqlx::query(
        r#"
        INSERT INTO scripts (id, name, content, is_template, created_at, updated_at, created_by, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        "#,
    )
    .bind(&id)
    .bind(&new_script.name)
    .bind(&new_script.content)
    .bind(if new_script.is_template { 1 } else { 0 })
    .bind(&now)
    .bind(&now)
    .bind(created_by)
    .execute(&state.pool)
    .await
    .map_err(|e| ScriptError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let script = get_script_by_id(&state.pool, &id).await?;
    Ok((StatusCode::CREATED, Json(script)))
}

/// Internal helper: create an AI-authored script. Always tags `'ai'` +
/// `approved=0` regardless of caller-supplied fields. Used by
/// `/api/ai/generate-script` so prompt-injected AI cannot bypass the
/// approval gate.
pub async fn create_ai_script(
    pool: &SqlitePool,
    name: &str,
    content: &str,
) -> Result<String, ScriptError> {
    let id = Uuid::new_v4().to_string();
    let now = format_datetime(&Utc::now());
    sqlx::query(
        r#"
        INSERT INTO scripts (id, name, content, is_template, created_at, updated_at, created_by, approved)
        VALUES (?, ?, ?, 0, ?, ?, 'ai', 0)
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(content)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| ScriptError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;
    Ok(id)
}

/// User-initiated approval of an AI-authored script.
///
/// Once approved, the script can be run. Approval is sticky: editing the
/// script content via `PUT /api/scripts/:id` clears it again so the user
/// re-reviews any change.
pub async fn approve_script(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
) -> Result<Json<Script>, ScriptError> {
    let result = sqlx::query("UPDATE scripts SET approved = 1 WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| ScriptError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;
    if result.rows_affected() == 0 {
        return Err(ScriptError {
            error: format!("Script not found: {}", id),
            code: "NOT_FOUND".to_string(),
        });
    }
    tracing::warn!(target: "audit", script_id = %id, "AI-authored script approved by user");
    let script = get_script_by_id(&state.pool, &id).await?;
    Ok(Json(script))
}

/// Update an existing script
pub async fn update_script(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateScript>,
) -> Result<Json<Script>, ScriptError> {
    // Verify script exists
    let current = get_script_by_id(&state.pool, &id).await?;
    let now = format_datetime(&Utc::now());

    let prior_content = current.content.clone();
    let name = update.name.unwrap_or(current.name);
    let content = update.content.unwrap_or(current.content);
    let is_template = update.is_template.unwrap_or(current.is_template);

    // AUDIT FIX (EXEC-014): editing an AI-authored script clears its
    // approval flag so the user must re-review before running again.
    let content_changed = content != prior_content;
    let new_approved = if current.created_by == "ai" && content_changed {
        0i32
    } else if current.approved {
        1
    } else {
        0
    };

    sqlx::query(
        r#"
        UPDATE scripts
        SET name = ?, content = ?, is_template = ?, updated_at = ?, approved = ?
        WHERE id = ?
        "#,
    )
    .bind(&name)
    .bind(&content)
    .bind(if is_template { 1 } else { 0 })
    .bind(&now)
    .bind(new_approved)
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(|e| ScriptError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let script = get_script_by_id(&state.pool, &id).await?;
    Ok(Json(script))
}

/// Delete a script
pub async fn delete_script(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ScriptError> {
    let result = sqlx::query("DELETE FROM scripts WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| ScriptError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;

    if result.rows_affected() == 0 {
        return Err(ScriptError {
            error: format!("Script not found: {}", id),
            code: "NOT_FOUND".to_string(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Prepare script content for execution: prepend metadata if missing,
/// append main() wrapper if needed with main_args.
pub fn prepare_script_for_run(content: &str, main_args: Option<&str>) -> String {
    let mut prepared = prepend_dynamic_metadata(content);
    if main_args.is_some() && needs_main_wrapper(&prepared) {
        prepared = append_main_wrapper(&prepared);
    }
    prepared
}

/// Write prepared script to a temp file, returning the path.
async fn write_temp_script(content: &str) -> Result<PathBuf, ScriptError> {
    let tmp_dir = std::env::temp_dir();
    let filename = format!("ns_script_{}.py", Uuid::new_v4());
    let path = tmp_dir.join(filename);
    tokio::fs::write(&path, content).await.map_err(|e| ScriptError {
        error: format!("Failed to write temp script: {}", e),
        code: "EXECUTION_ERROR".to_string(),
    })?;
    Ok(path)
}

/// Run a script once with no device context (standalone mode)
pub async fn run_script_once(
    script_content: &str,
    custom_input: Option<&str>,
    main_args: Option<&str>,
) -> Result<ScriptOutput, ScriptError> {
    let start = Instant::now();
    let uv = ensure_uv().await?;
    let prepared = prepare_script_for_run(script_content, main_args);
    let script_path = write_temp_script(&prepared).await?;

    let mut cmd = Command::new(&uv);
    cmd.arg("run").arg("--quiet").arg("--script").arg(&script_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Don't inherit agent env — prevents NETSTACKS_AUTH_TOKEN and other secrets from leaking into scripts.
    cmd.env_clear();
    if let Ok(path) = std::env::var("PATH") { cmd.env("PATH", path); }
    if let Ok(home) = std::env::var("HOME") { cmd.env("HOME", home); }

    if let Some(input) = custom_input {
        cmd.env("NETSTACKS_INPUT", input);
    }
    if let Some(args) = main_args {
        cmd.env("NETSTACKS_ARGS", args);
    }

    let output = cmd.output().await.map_err(|e| ScriptError {
        error: format!("Failed to execute script: {}", e),
        code: "EXECUTION_ERROR".to_string(),
    })?;

    let _ = tokio::fs::remove_file(&script_path).await;
    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(ScriptOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        duration_ms,
    })
}

/// Device identity + serialized payload injected into a per-session script
/// run as `NETSTACKS_DEVICE*` env vars.
struct SessionScriptDevice<'a> {
    json: &'a str,
    host: &'a str,
    name: &'a str,
    device_type: &'a str,
}

/// Run a script for a single device/session with injected env vars
async fn run_script_for_session(
    uv_path: &std::path::Path,
    script_path: &std::path::Path,
    device: SessionScriptDevice<'_>,
    custom_input: Option<&str>,
    main_args: Option<&str>,
) -> ScriptDeviceResult {
    let SessionScriptDevice { json: device_json, host: device_host, name: device_name, device_type } = device;
    let start = Instant::now();

    let mut cmd = Command::new(uv_path);
    cmd.arg("run").arg("--quiet").arg("--script").arg(script_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env_clear();
    if let Ok(path) = std::env::var("PATH") { cmd.env("PATH", path); }
    if let Ok(home) = std::env::var("HOME") { cmd.env("HOME", home); }

    // Inject device environment variables
    cmd.env("NETSTACKS_DEVICE", device_json);
    cmd.env("NETSTACKS_DEVICE_HOST", device_host);
    cmd.env("NETSTACKS_DEVICE_NAME", device_name);
    cmd.env("NETSTACKS_DEVICE_TYPE", device_type);

    if let Some(input) = custom_input {
        cmd.env("NETSTACKS_INPUT", input);
    }
    if let Some(args) = main_args {
        cmd.env("NETSTACKS_ARGS", args);
    }

    let result = cmd.output().await;
    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(output) => ScriptDeviceResult {
            device_id: String::new(), // filled by caller
            device_name: device_name.to_string(),
            host: device_host.to_string(),
            status: if output.status.success() {
                "success".to_string()
            } else {
                "failed".to_string()
            },
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            duration_ms,
        },
        Err(e) => ScriptDeviceResult {
            device_id: String::new(),
            device_name: device_name.to_string(),
            host: device_host.to_string(),
            status: "failed".to_string(),
            stdout: String::new(),
            stderr: format!("Failed to execute: {}", e),
            exit_code: -1,
            duration_ms,
        },
    }
}

/// Build the multi-device output JSON
fn build_multi_device_output(
    results: Vec<ScriptDeviceResult>,
    execution_mode: &str,
) -> serde_json::Value {
    let total = results.len();
    let success_count = results.iter().filter(|r| r.status == "success").count();
    let failed_count = total - success_count;

    serde_json::json!({
        "status": if failed_count == 0 { "completed" } else { "partial_failure" },
        "execution_mode": execution_mode,
        "total_devices": total,
        "success_count": success_count,
        "failed_count": failed_count,
        "results": results.iter().map(|r| serde_json::json!({
            "device_id": r.device_id,
            "device_name": r.device_name,
            "host": r.host,
            "status": r.status,
            "stdout": r.stdout,
            "stderr": r.stderr,
            "exit_code": r.exit_code,
            "duration_ms": r.duration_ms,
        })).collect::<Vec<_>>()
    })
}

/// Run a script with optional device targeting
pub async fn run_script(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
    body: Option<Json<RunScriptOptions>>,
) -> Result<Json<serde_json::Value>, ScriptError> {
    let script = get_script_by_id(&state.pool, &id).await?;

    // AUDIT FIX (EXEC-014): refuse to run AI-authored scripts that the user
    // has not yet approved. The frontend should call `POST /api/scripts/:id/approve`
    // after a diff review.
    if !script.approved {
        return Err(ScriptError {
            error: format!(
                "Script '{}' was authored by the AI and has not been approved by the user. \
                 Review the contents and call POST /api/scripts/{}/approve before running.",
                script.name, id
            ),
            code: "APPROVAL_REQUIRED".to_string(),
        });
    }

    let options = body.map(|b| b.0).unwrap_or_default();
    let custom_input = options.custom_input.as_deref();
    let main_args = options.main_args.as_deref();
    let execution_mode = options
        .execution_mode
        .as_deref()
        .unwrap_or("parallel");

    // No sessions selected → run once in standalone mode
    let session_ids = match &options.device_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            let output = run_script_once(&script.content, custom_input, main_args).await?;
            return Ok(Json(serde_json::json!({
                "stdout": output.stdout,
                "stderr": output.stderr,
                "exit_code": output.exit_code,
                "duration_ms": output.duration_ms,
            })));
        }
    };

    // Resolve sessions and build device JSON for each
    let provider = &state.provider;
    let mut device_configs: Vec<(String, String, String, String, String)> = Vec::new(); // (id, name, host, type, device_json)

    for session_id in session_ids {
        let session = provider.get_session(session_id).await.map_err(|e| ScriptError {
            error: format!("Failed to get session {}: {}", session_id, e),
            code: "SESSION_ERROR".to_string(),
        })?;

        let profile = provider.get_profile(&session.profile_id).await.map_err(|e| ScriptError {
            error: format!("Failed to get profile for session {}: {}", session.name, e),
            code: "PROFILE_ERROR".to_string(),
        })?;

        let credential = provider
            .get_profile_credential(&session.profile_id)
            .await
            .map_err(|e| ScriptError {
                error: format!("Failed to decrypt credentials for {}: {}", session.name, e),
                code: "CREDENTIAL_ERROR".to_string(),
            })?;

        let device_type = cli_flavor_to_netmiko(&session.cli_flavor);

        let mut device_json = serde_json::json!({
            "host": session.host,
            "port": session.port,
            "device_type": device_type,
            "username": profile.username,
            "name": session.name,
        });

        // Add decrypted credential fields
        if let Some(cred) = &credential {
            if let Some(ref password) = cred.password {
                device_json["password"] = serde_json::json!(password);
            }
            if let Some(ref passphrase) = cred.key_passphrase {
                device_json["key_passphrase"] = serde_json::json!(passphrase);
            }
        }
        if let Some(ref key_path) = profile.key_path {
            device_json["key_file"] = serde_json::json!(key_path);
        }

        device_configs.push((
            session.id.clone(),
            session.name.clone(),
            session.host.clone(),
            device_type.to_string(),
            device_json.to_string(),
        ));
    }

    // Ensure uv is available and write prepared script to temp file
    let uv = ensure_uv().await?;
    let prepared = prepare_script_for_run(&script.content, main_args);
    let script_path = write_temp_script(&prepared).await?;

    // Execute per-device
    let mut results: Vec<ScriptDeviceResult> = Vec::new();

    if execution_mode == "sequential" {
        for (sid, name, host, dtype, djson) in &device_configs {
            let mut result = run_script_for_session(
                &uv,
                &script_path,
                SessionScriptDevice { json: djson, host, name, device_type: dtype },
                custom_input,
                main_args,
            )
            .await;
            result.device_id = sid.clone();
            results.push(result);
        }
    } else {
        // Parallel execution
        let mut handles = Vec::new();
        for (sid, name, host, dtype, djson) in device_configs {
            let uv_path = uv.clone();
            let sp = script_path.clone();
            let ci = custom_input.map(|s| s.to_string());
            let ma = main_args.map(|s| s.to_string());
            handles.push(tokio::spawn(async move {
                let mut result = run_script_for_session(
                    &uv_path,
                    &sp,
                    SessionScriptDevice { json: &djson, host: &host, name: &name, device_type: &dtype },
                    ci.as_deref(),
                    ma.as_deref(),
                )
                .await;
                result.device_id = sid;
                result
            }));
        }

        for handle in handles {
            match handle.await {
                Ok(result) => results.push(result),
                Err(e) => results.push(ScriptDeviceResult {
                    device_id: String::new(),
                    device_name: "unknown".to_string(),
                    host: "unknown".to_string(),
                    status: "failed".to_string(),
                    stdout: String::new(),
                    stderr: format!("Task join error: {}", e),
                    exit_code: -1,
                    duration_ms: 0,
                }),
            }
        }
    }

    // Clean up temp script file
    let _ = tokio::fs::remove_file(&script_path).await;

    // Update last_run_at
    let now = format_datetime(&Utc::now());
    let _ = sqlx::query("UPDATE scripts SET last_run_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&id)
        .execute(&state.pool)
        .await;

    let output = build_multi_device_output(results, execution_mode);
    Ok(Json(output))
}

/// Helper to get a script by ID
pub async fn get_script_by_id(pool: &SqlitePool, id: &str) -> Result<Script, ScriptError> {
    let row: ScriptRow = sqlx::query_as("SELECT * FROM scripts WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| ScriptError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| ScriptError {
            error: format!("Script not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    row.into_script().map_err(|e| ScriptError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

// =============================================================================
// main() parameter detection (Windmill-style convention)
// =============================================================================

/// A detected parameter from a script's main() function
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptParam {
    pub name: String,
    /// "str" | "int" | "float" | "bool" | "list" | "dict"
    pub param_type: String,
    pub default_value: Option<serde_json::Value>,
    pub required: bool,
}

/// Analysis result for a script
#[derive(Debug, Serialize)]
pub struct ScriptAnalysis {
    pub has_main: bool,
    pub params: Vec<ScriptParam>,
    pub has_inline_metadata: bool,
}

/// Locate the parameter list of `def main(...)` in a Python source file.
///
/// Returns the substring inside the outer parentheses, even when the signature
/// spans multiple lines or contains nested brackets / quoted strings. Returns
/// None if no `def main(` is found or the parens never close. The previous
/// regex-only version broke on common Python: multi-line `def main(\n    a,\n    b,\n)`,
/// `Tuple[int, int]` annotations, and dict defaults like `x = {"a": 1, "b": 2}`.
fn extract_main_params_str(content: &str) -> Option<String> {
    let header_re = Regex::new(r"(?m)^def\s+main\s*\(").unwrap();
    let m = header_re.find(content)?;
    let bytes = content.as_bytes();
    let start = m.end(); // first char inside the outer '('

    let mut depth: i32 = 1;
    let mut in_str: Option<u8> = None; // delimiter byte (' or ")
    let mut prev_backslash = false;
    let mut i = start;

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(delim) = in_str {
            if !prev_backslash && b == delim {
                in_str = None;
            }
            prev_backslash = !prev_backslash && b == b'\\';
        } else {
            match b {
                b'"' | b'\'' => in_str = Some(b),
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        // bytes[start..i] is the param list. It's a slice of
                        // valid UTF-8 because we only stopped on ASCII bytes.
                        return Some(content[start..i].to_string());
                    }
                }
                _ => {}
            }
            prev_backslash = false;
        }
        i += 1;
    }
    None
}

/// Split a Python parameter list on top-level commas. Commas inside brackets
/// or string literals are preserved.
fn split_top_level_commas(s: &str) -> Vec<String> {
    let bytes = s.as_bytes();
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str: Option<u8> = None;
    let mut prev_backslash = false;
    let mut start = 0usize;

    for i in 0..bytes.len() {
        let b = bytes[i];
        if let Some(delim) = in_str {
            if !prev_backslash && b == delim {
                in_str = None;
            }
            prev_backslash = !prev_backslash && b == b'\\';
            continue;
        }
        match b {
            b'"' | b'\'' => in_str = Some(b),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(s[start..i].to_string());
                start = i + 1;
            }
            _ => {}
        }
        prev_backslash = false;
    }
    if start < bytes.len() {
        parts.push(s[start..].to_string());
    } else if !s.is_empty() && bytes[bytes.len() - 1] == b',' {
        // trailing comma — push empty so the loop below skips it
        parts.push(String::new());
    }
    parts
}

/// Find the position of the top-level `=` (default-value separator) in a
/// single param, ignoring `=` inside brackets / quoted strings. Required
/// because annotations like `x: Dict[str, int] = {}` contain non-default `=`
/// only inside `{}` — actually they don't, but we still need to ignore `=`
/// inside `[]` for things like `x: Tuple[int, ...] = (1, 2)`.
fn find_top_level_eq(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth: i32 = 0;
    let mut in_str: Option<u8> = None;
    let mut prev_backslash = false;

    for (i, &b) in bytes.iter().enumerate() {
        if let Some(delim) = in_str {
            if !prev_backslash && b == delim {
                in_str = None;
            }
            prev_backslash = !prev_backslash && b == b'\\';
            continue;
        }
        match b {
            b'"' | b'\'' => in_str = Some(b),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b'=' if depth == 0 => return Some(i),
            _ => {}
        }
        prev_backslash = false;
    }
    None
}

/// Parse `def main(...)` signature and extract typed parameters.
fn detect_main_params(content: &str) -> Vec<ScriptParam> {
    let params_str = match extract_main_params_str(content) {
        Some(s) => s,
        None => return Vec::new(),
    };

    if params_str.trim().is_empty() {
        return Vec::new();
    }

    let mut params = Vec::new();
    for raw_param in split_top_level_commas(&params_str) {
        let raw = raw_param.trim();
        // Skip empties (trailing commas), self/cls, keyword-only marker (`*`),
        // and *args / **kwargs.
        if raw.is_empty() || raw == "self" || raw == "cls" || raw == "*" || raw == "/" {
            continue;
        }
        if raw.starts_with('*') {
            continue;
        }

        let (name_type, default_str) = match find_top_level_eq(raw) {
            Some(eq_pos) => (raw[..eq_pos].trim(), Some(raw[eq_pos + 1..].trim())),
            None => (raw, None),
        };

        // ':' for the type annotation is always at top level of the name_type
        // slice (there's no bracket nesting before the annotation), so a plain
        // find() is safe here.
        let (name, type_ann) = if let Some(colon_pos) = name_type.find(':') {
            (
                name_type[..colon_pos].trim(),
                Some(name_type[colon_pos + 1..].trim()),
            )
        } else {
            (name_type, None)
        };

        if name.is_empty() {
            continue;
        }

        let param_type = map_python_type(type_ann.unwrap_or(""));
        let is_optional = type_ann
            .map(|t| t.contains("Optional") || t.contains("| None"))
            .unwrap_or(false);

        let default_value = default_str.and_then(|d| parse_python_default(d, &param_type));

        params.push(ScriptParam {
            name: name.to_string(),
            param_type,
            required: default_str.is_none() && !is_optional,
            default_value,
        });
    }

    params
}

/// Map Python type annotations to our simplified type system
fn map_python_type(ann: &str) -> String {
    let ann = ann.trim();
    if ann.is_empty() {
        return "str".to_string();
    }

    // Strip Optional[] wrapper
    let inner = if ann.starts_with("Optional[") && ann.ends_with(']') {
        &ann[9..ann.len() - 1]
    } else if ann.contains("| None") {
        ann.split('|').next().unwrap_or(ann).trim()
    } else {
        ann
    };

    match inner {
        "int" => "int".to_string(),
        "float" => "float".to_string(),
        "bool" => "bool".to_string(),
        s if s.starts_with("list") || s.starts_with("List") => "list".to_string(),
        s if s.starts_with("dict") || s.starts_with("Dict") => "dict".to_string(),
        _ => "str".to_string(),
    }
}

/// Try to parse a Python default value literal to JSON
fn parse_python_default(val: &str, param_type: &str) -> Option<serde_json::Value> {
    let val = val.trim();
    if val == "None" {
        return Some(serde_json::Value::Null);
    }
    match param_type {
        "int" => val.parse::<i64>().ok().map(serde_json::Value::from),
        "float" => val.parse::<f64>().ok().map(serde_json::Value::from),
        "bool" => match val {
            "True" => Some(serde_json::Value::Bool(true)),
            "False" => Some(serde_json::Value::Bool(false)),
            _ => None,
        },
        "str" => {
            // Strip quotes
            if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                Some(serde_json::Value::String(val[1..val.len() - 1].to_string()))
            } else {
                Some(serde_json::Value::String(val.to_string()))
            }
        }
        _ => None,
    }
}

/// Analyze a script: detect main() params, check for inline metadata
pub async fn analyze_script(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
) -> Result<Json<ScriptAnalysis>, ScriptError> {
    let script = get_script_by_id(&state.pool, &id).await?;
    let params = detect_main_params(&script.content);
    Ok(Json(ScriptAnalysis {
        has_main: script.content.contains("def main("),
        params,
        has_inline_metadata: has_script_metadata(&script.content),
    }))
}

// =============================================================================
// Streaming script execution (SSE)
// =============================================================================

/// Run a script with real-time streaming output via SSE.
/// Sends events: status (phase updates), stderr (uv progress), stdout (script output), complete/error.
pub async fn run_script_stream(
    State(state): State<Arc<ScriptsState>>,
    Path(id): Path<String>,
    body: Option<Json<RunScriptOptions>>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ScriptError> {
    let script = get_script_by_id(&state.pool, &id).await?;

    // AUDIT FIX (EXEC-014): same approval gate applies to the streaming
    // endpoint — otherwise a prompt-injected AI could route around the
    // approval check by calling the SSE variant.
    if !script.approved {
        return Err(ScriptError {
            error: format!(
                "Script '{}' was authored by the AI and has not been approved by the user. \
                 Review the contents and call POST /api/scripts/{}/approve before running.",
                script.name, id
            ),
            code: "APPROVAL_REQUIRED".to_string(),
        });
    }

    let options = body.map(|b| b.0).unwrap_or_default();

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(100);

    tokio::spawn(async move {
        let start = Instant::now();

        // Phase 1: Ensure uv is available
        let _ = tx
            .send(Ok(Event::default()
                .event("status")
                .data("Setting up Python runtime...")))
            .await;

        let uv = match ensure_uv().await {
            Ok(uv) => uv,
            Err(e) => {
                let _ = tx
                    .send(Ok(Event::default().event("error").data(e.error)))
                    .await;
                return;
            }
        };

        // Phase 2: Prepare script
        let _ = tx
            .send(Ok(Event::default()
                .event("status")
                .data("Preparing script...")))
            .await;

        let prepared =
            prepare_script_for_run(&script.content, options.main_args.as_deref());
        let script_path = match write_temp_script(&prepared).await {
            Ok(p) => p,
            Err(e) => {
                let _ = tx
                    .send(Ok(Event::default().event("error").data(e.error)))
                    .await;
                return;
            }
        };

        // Phase 3: Run the script
        let _ = tx
            .send(Ok(Event::default()
                .event("status")
                .data("Running script (first run may take a moment while dependencies install)...")))
            .await;

        let mut cmd = Command::new(&uv);
        cmd.arg("run").arg("--quiet").arg("--script").arg(&script_path);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.env_clear();
        if let Ok(path) = std::env::var("PATH") { cmd.env("PATH", path); }
        if let Ok(home) = std::env::var("HOME") { cmd.env("HOME", home); }

        if let Some(ref input) = options.custom_input {
            cmd.env("NETSTACKS_INPUT", input);
        }
        if let Some(ref args) = options.main_args {
            cmd.env("NETSTACKS_ARGS", args);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data(format!("Failed to start script: {}", e))))
                    .await;
                let _ = tokio::fs::remove_file(&script_path).await;
                return;
            }
        };

        // Stream stderr (uv progress + script errors) in real-time.
        // .take() returns None only if something already consumed the handle —
        // can't happen on a freshly-spawned child today, but unwrap() would
        // panic the task with no SSE notification. Match instead so the
        // client sees the error and the channel closes cleanly.
        let stderr = match child.stderr.take() {
            Some(s) => s,
            None => {
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data("Internal: failed to capture script stderr")))
                    .await;
                let _ = tokio::fs::remove_file(&script_path).await;
                return;
            }
        };
        let tx_stderr = tx.clone();
        let stderr_handle = tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx_stderr
                    .send(Ok(Event::default().event("stderr").data(line)))
                    .await;
            }
        });

        // Stream stdout (script output) in real-time. Same defensive pattern.
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = tx
                    .send(Ok(Event::default()
                        .event("error")
                        .data("Internal: failed to capture script stdout")))
                    .await;
                let _ = tokio::fs::remove_file(&script_path).await;
                return;
            }
        };
        let tx_stdout = tx.clone();
        let stdout_handle = tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx_stdout
                    .send(Ok(Event::default().event("stdout").data(line)))
                    .await;
            }
        });

        // Wait for child to finish OR the SSE client to disconnect.
        // Without the second arm a long-running script (or `while True: pass`)
        // outlives the user closing the tab — the spawn task keeps reading,
        // the child keeps running, until the process self-terminates.
        let status = tokio::select! {
            status = child.wait() => status,
            _ = tx.closed() => {
                tracing::warn!("SSE client disconnected mid-run — killing script process");
                let _ = child.kill().await;
                stderr_handle.abort();
                stdout_handle.abort();
                let _ = tokio::fs::remove_file(&script_path).await;
                return;
            }
        };
        let _ = stderr_handle.await;
        let _ = stdout_handle.await;

        let exit_code = status
            .map(|s| s.code().unwrap_or(-1))
            .unwrap_or(-1);
        let duration_ms = start.elapsed().as_millis() as u64;

        let _ = tokio::fs::remove_file(&script_path).await;

        // Update last_run_at
        let now = format_datetime(&Utc::now());
        let _ = sqlx::query("UPDATE scripts SET last_run_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&script.id)
            .execute(&state.pool)
            .await;

        let _ = tx
            .send(Ok(Event::default().event("complete").data(
                serde_json::json!({
                    "exit_code": exit_code,
                    "duration_ms": duration_ms,
                })
                .to_string(),
            )))
            .await;
    });

    let stream = ReceiverStream::new(rx);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// Seed template scripts if they don't exist
pub async fn seed_templates(pool: &SqlitePool) -> Result<(), String> {
    // Check if templates already exist
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM scripts WHERE is_template = 1")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

    if count.0 > 0 {
        return Ok(()); // Templates already seeded
    }

    let templates = vec![
        (
            "Run show command",
            r#"#!/usr/bin/env python3
"""Run a show command on selected devices.

Select devices in the toolbar, set the command parameter, and click Run.
NetStacks runs this once per device with full SSH credentials injected.
"""

import os
import json
from netmiko import ConnectHandler

def main(command: str = "show version"):
    """Run a CLI command and return structured output."""
    device = json.loads(os.environ["NETSTACKS_DEVICE"])
    name = os.environ.get("NETSTACKS_DEVICE_NAME", device["host"])

    conn = ConnectHandler(
        device_type=device["device_type"],
        host=device["host"],
        username=device["username"],
        password=device.get("password", ""),
        port=device.get("port", 22),
    )
    output = conn.send_command(command)
    conn.disconnect()

    print(f"=== {name} ===")
    print(output)
    return {"device": name, "command": command, "lines": len(output.splitlines())}
"#,
        ),
        (
            "Config backup to file",
            r#"#!/usr/bin/env python3
"""Back up running-config from selected devices to local files.

Select devices, click Run. Configs saved to ~/netstacks-backups/
with device name and timestamp in the filename.
"""

import os
import json
from datetime import datetime
from netmiko import ConnectHandler

def main():
    """Backup running configuration to a local file."""
    device = json.loads(os.environ["NETSTACKS_DEVICE"])
    name = os.environ.get("NETSTACKS_DEVICE_NAME", device["host"])

    conn = ConnectHandler(
        device_type=device["device_type"],
        host=device["host"],
        username=device["username"],
        password=device.get("password", ""),
        port=device.get("port", 22),
    )
    config = conn.send_command("show running-config")
    conn.disconnect()

    # Save to file
    backup_dir = os.path.expanduser("~/netstacks-backups")
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{name}_{timestamp}.txt"
    filepath = os.path.join(backup_dir, filename)

    with open(filepath, "w") as f:
        f.write(config)

    print(f"Saved {len(config.splitlines())} lines to {filepath}")
    return {"device": name, "file": filepath, "lines": len(config.splitlines())}
"#,
        ),
        (
            "Find interface errors",
            r#"#!/usr/bin/env python3
"""Scan interfaces for CRC errors, input/output errors, and drops.

Select devices, click Run. Reports any interfaces with non-zero error
counters — useful for quick health checks across your network.
"""

import os
import json
import re
from netmiko import ConnectHandler

def main(threshold: int = 0):
    """Find interfaces with error counters above threshold."""
    device = json.loads(os.environ["NETSTACKS_DEVICE"])
    name = os.environ.get("NETSTACKS_DEVICE_NAME", device["host"])

    conn = ConnectHandler(
        device_type=device["device_type"],
        host=device["host"],
        username=device["username"],
        password=device.get("password", ""),
        port=device.get("port", 22),
    )
    output = conn.send_command("show interfaces")
    conn.disconnect()

    # Parse interface blocks and find errors
    issues = []
    current_iface = None
    for line in output.splitlines():
        # Match interface name (e.g. "Ethernet1 is up, line protocol is up")
        iface_match = re.match(r'^(\S+) is', line)
        if iface_match:
            current_iface = iface_match.group(1)
            continue

        if current_iface:
            # Look for error counters
            for pattern in [r'(\d+) input errors', r'(\d+) CRC', r'(\d+) output errors',
                           r'(\d+) collisions', r'(\d+) drops']:
                m = re.search(pattern, line)
                if m and int(m.group(1)) > threshold:
                    issues.append({
                        "interface": current_iface,
                        "counter": pattern.split(r')')[-1].strip(),
                        "value": int(m.group(1)),
                    })

    if issues:
        print(f"[{name}] Found {len(issues)} interface issues:")
        for issue in issues:
            print(f"  {issue['interface']}: {issue['value']}{issue['counter']}")
    else:
        print(f"[{name}] No interface errors above threshold ({threshold})")

    return {"device": name, "issues": issues, "clean": len(issues) == 0}
"#,
        ),
    ];

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let template_count = templates.len();
    for (name, content) in templates {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO scripts (id, name, content, is_template, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(content)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    tracing::info!("Seeded {} template scripts", template_count);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_line_signature_with_nested_generics() {
        let src = r#"
def main(
    devices: List[Dict[str, int]],
    options: Tuple[int, int] = (1, 2),
    name: str = "router-01",
    enabled: bool = True,
):
    pass
"#;
        let params = detect_main_params(src);
        assert_eq!(params.len(), 4);
        assert_eq!(params[0].name, "devices");
        assert_eq!(params[0].param_type, "list");
        assert!(params[0].required);
        assert_eq!(params[1].name, "options");
        assert!(!params[1].required);
        assert_eq!(params[2].name, "name");
        assert_eq!(params[2].param_type, "str");
        assert_eq!(
            params[2].default_value,
            Some(serde_json::Value::String("router-01".to_string()))
        );
        assert_eq!(params[3].name, "enabled");
        assert_eq!(params[3].param_type, "bool");
        assert_eq!(params[3].default_value, Some(serde_json::Value::Bool(true)));
    }

    #[test]
    fn dict_default_with_commas_inside() {
        let src = r#"def main(cfg: dict = {"a": 1, "b": 2}, name: str = "x"): pass"#;
        let params = detect_main_params(src);
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].name, "cfg");
        assert_eq!(params[0].param_type, "dict");
        assert_eq!(params[1].name, "name");
        assert_eq!(
            params[1].default_value,
            Some(serde_json::Value::String("x".to_string()))
        );
    }

    #[test]
    fn optional_and_pipe_none_are_not_required() {
        let src = r#"def main(a: Optional[int] = None, b: str | None = None): pass"#;
        let params = detect_main_params(src);
        assert_eq!(params.len(), 2);
        assert!(!params[0].required);
        assert!(!params[1].required);
    }

    #[test]
    fn skips_self_cls_args_kwargs_and_keyword_only_marker() {
        let src = r#"def main(self, cls, *args, **kwargs, *, x: int = 1): pass"#;
        let params = detect_main_params(src);
        // Only `x` should survive.
        assert_eq!(params.len(), 1);
        assert_eq!(params[0].name, "x");
    }

    #[test]
    fn no_main_returns_empty() {
        let src = r#"def helper(x): pass"#;
        assert!(detect_main_params(src).is_empty());
    }

    #[test]
    fn empty_params() {
        let src = r#"def main(): pass"#;
        assert!(detect_main_params(src).is_empty());
    }
}
