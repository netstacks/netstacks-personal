#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Live handles to every custom menu item, keyed by the menu item id
/// used in `build_menu`. The frontend's MenuBridge pushes
/// enable/disable updates here via `set_menu_enabled_batch` so menu
/// items reflect the current ActiveContext (e.g. Reconnect greys out
/// when no terminal tab is active).
///
/// Predefined items (cut/copy/paste/quit/etc.) are not tracked — the
/// OS handles their enabled state natively based on focus.
///
/// Uses parking_lot::Mutex so a panic in any tauri::command handler
/// can't poison the lock and permanently break menu enable/disable
/// (the frontend's MenuBridge silently swallows the resulting Err
/// in set_menu_enabled_batch, leaving the user with stale menu state
/// and no signal).
pub struct MenuItemRegistry(pub parking_lot::Mutex<HashMap<String, MenuItem<tauri::Wry>>>);

/// Stores the sidecar auth token so the frontend can retrieve it via IPC command.
/// The token event may fire before the webview JS loads, so this provides a
/// reliable fallback for the frontend to get the token on demand.
struct SidecarToken(Mutex<Option<String>>);

/// Stores the sidecar's dynamically assigned port so the frontend can retrieve
/// it via IPC command. The agent binds an ephemeral port and prints it to stdout.
struct SidecarPort(Mutex<Option<u16>>);

/// Returns path to the TLS cert fingerprint flag file in the agent data directory.
/// Presence of this file (with matching content) means the cert is already in the
/// OS trust store — skips the install prompt on subsequent launches.
fn tls_cert_flag_path() -> std::path::PathBuf {
    const APP_ID: &str = "com.netstacks.terminal";
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME").map(|h| format!("{}/Library/Application Support/{}", h, APP_ID)).unwrap_or_default();
    #[cfg(target_os = "linux")]
    let base = std::env::var("HOME").map(|h| format!("{}/.local/share/{}", h, APP_ID)).unwrap_or_default();
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").map(|a| format!("{}\\{}", a, APP_ID)).unwrap_or_default();
    std::path::PathBuf::from(base).join("tls_installed.txt")
}

/// Cheap fingerprint: length + first 64 chars. Good enough for change detection.
fn cert_fingerprint(pem: &str) -> String {
    let trimmed = pem.trim();
    let prefix = &trimmed[..trimmed.len().min(64)];
    format!("{}:{}", trimmed.len(), prefix)
}

/// Path to the flag marking that the macOS Local Network access prompt has been
/// shown to this user. Presence of the file means we've already explained the
/// requirement and triggered the OS prompt — don't bother the user again.
#[cfg(target_os = "macos")]
fn lan_prompt_flag_path() -> std::path::PathBuf {
    const APP_ID: &str = "com.netstacks.terminal";
    let base = std::env::var("HOME")
        .map(|h| format!("{}/Library/Application Support/{}", h, APP_ID))
        .unwrap_or_default();
    std::path::PathBuf::from(base).join("lan_prompt_shown.txt")
}

// ---------------------------------------------------------------------------
// Controller TLS certificate trust (enterprise mode)
// ---------------------------------------------------------------------------

fn app_data_dir() -> std::path::PathBuf {
    const APP_ID: &str = "com.netstacks.terminal";
    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(|h| format!("{}/Library/Application Support/{}", h, APP_ID))
        .unwrap_or_default();
    #[cfg(target_os = "linux")]
    let base = std::env::var("HOME")
        .map(|h| format!("{}/.local/share/{}", h, APP_ID))
        .unwrap_or_default();
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA")
        .map(|a| format!("{}\\{}", a, APP_ID))
        .unwrap_or_default();
    std::path::PathBuf::from(base)
}

fn read_controller_url() -> Option<String> {
    let path = app_data_dir().join("app-config.json");
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("controllerUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('/').to_string())
}

fn cert_pin_path() -> std::path::PathBuf {
    app_data_dir().join("controller-cert.json")
}

/// Strip SHA256: prefix, remove colons, uppercase — canonical form for comparison.
fn normalize_fingerprint(fp: &str) -> String {
    let s = fp.trim();
    let s = s.strip_prefix("SHA256:").or_else(|| s.strip_prefix("sha256:")).unwrap_or(s);
    s.replace(':', "").to_uppercase()
}

fn read_cert_pin(controller_url: &str) -> Option<String> {
    let content = std::fs::read_to_string(cert_pin_path()).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get(controller_url)
        .and_then(|v| v.get("fingerprint"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn save_cert_pin(controller_url: &str, raw_fingerprint: &str) {
    let normalized = normalize_fingerprint(raw_fingerprint);
    let mut json = std::fs::read_to_string(cert_pin_path())
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json[controller_url] = serde_json::json!({ "fingerprint": normalized });
    if let Some(parent) = cert_pin_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        cert_pin_path(),
        serde_json::to_string_pretty(&json).unwrap_or_default(),
    );
}

/// Extract cert + fingerprint from a TLS handshake via the openssl CLI.
/// Returns (pem, raw_fingerprint) where fingerprint is "AA:BB:CC:..." (no prefix).
fn extract_cert_via_openssl(host: &str, port: u16) -> Result<(String, String), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let connect_arg = format!("{}:{}", host, port);
    let output = Command::new("openssl")
        .args(["s_client", "-showcerts", "-connect", &connect_arg, "-servername", host])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("openssl not available: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let begin = "-----BEGIN CERTIFICATE-----";
    let end_marker = "-----END CERTIFICATE-----";

    // Take the LAST cert in the chain (root CA).
    let mut last_pem: Option<&str> = None;
    let mut pos = 0usize;
    while let Some(start) = stdout[pos..].find(begin) {
        let abs_start = pos + start;
        if let Some(end) = stdout[abs_start..].find(end_marker) {
            let abs_end = abs_start + end + end_marker.len();
            last_pem = Some(&stdout[abs_start..abs_end]);
            pos = abs_end;
        } else {
            break;
        }
    }
    let pem = last_pem
        .ok_or("Could not extract certificate from TLS handshake")?;

    // Compute SHA-256 fingerprint
    let mut fp_cmd = Command::new("openssl")
        .args(["x509", "-fingerprint", "-sha256", "-noout"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("openssl fingerprint failed: {}", e))?;
    fp_cmd.stdin.as_mut()
        .ok_or("pipe error")?
        .write_all(pem.as_bytes())
        .map_err(|e| format!("write error: {}", e))?;
    drop(fp_cmd.stdin.take());
    let fp_output = fp_cmd.wait_with_output()
        .map_err(|e| format!("openssl wait error: {}", e))?;

    // Output is "SHA256 Fingerprint=AA:BB:CC:...\n" — extract after '='
    let fp_line = String::from_utf8_lossy(&fp_output.stdout);
    let raw_fp = fp_line.trim()
        .split('=')
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();

    if raw_fp.is_empty() {
        return Err("Could not compute certificate fingerprint".into());
    }

    Ok((pem.to_string(), raw_fp))
}

/// Install the Controller's self-signed CA into the OS trust store.
///
/// This is the sync sibling of `install_cert_os` (used by the agent path);
/// it has to be sync because `check_and_install_controller_cert` runs
/// inside `setup()` and uses dialog `blocking_show`, which would deadlock
/// the runtime if it awaited. The per-platform logic is intentionally
/// kept in lock-step with `install_cert_os`:
///
///   * **Linux** — `pkexec` to install into `/usr/local/share/ca-certificates/`
///     and refresh the system bundle. The earlier user-local
///     `~/.local/share/ca-certificates/` write was silently broken on
///     Pop!_OS / Ubuntu — that directory isn't consulted by
///     `update-ca-certificates` and WebKitGTK's GnuTLS+p11-kit doesn't
///     read it either, so the cert was "installed" but never trusted.
///   * **macOS** — `security add-trusted-cert` into the user's login
///     keychain (no admin password). The previous `-d`/`-p ssl` flags
///     targeted the admin domain and needed sudo.
///   * **Windows** — PowerShell `Import-Certificate` into HKCU/Root.
///     `certutil -user -addstore Root` pops a confirmation dialog that
///     can be missed by the user and stalls the install indefinitely.
fn install_cert_pem_sync(pem: &str) -> Result<(), String> {
    use std::io::Write;
    let pem = pem.trim();
    if !pem.starts_with("-----BEGIN CERTIFICATE-----") {
        return Err("Not a valid PEM certificate".into());
    }
    let dir = std::env::temp_dir().join("netstacks-cacert");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("install.pem");
    std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(pem.as_bytes()))
        .map_err(|e| format!("write error: {}", e))?;

    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("security")
        .args([
            "add-trusted-cert",
            "-r", "trustRoot",
            "-k", &format!("{}/Library/Keychains/login.keychain-db",
                std::env::var("HOME").unwrap_or_default()),
            path.to_str().unwrap_or_default(),
        ])
        .output()
        .map_err(|e| format!("security command failed: {}", e))?;

    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let cert = path.to_str().ok_or_else(|| "cert path has non-utf8 bytes".to_string())?;
        // Important: do NOT pass `-NonInteractive` here. Import-Certificate
        // writes to Cert:\CurrentUser\Root, which Windows treats as a
        // security-sensitive operation even for HKCU; the cmdlet pops the
        // OS "Are you sure you want to install this root certificate?"
        // confirmation. With -NonInteractive set the cmdlet refuses to run
        // and returns "UI is not allowed in this operation", which then
        // bubbles into the Tauri 'Cannot Connect' dialog as the failure
        // reason. CREATE_NO_WINDOW hides only the powershell.exe console;
        // the OS confirmation dialog (a separate window) still appears so
        // the user can click Yes to accept the new root.
        let script = format!(
            "Import-Certificate -FilePath '{}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null",
            cert.replace('\'', "''"),
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("powershell failed: {}", e))?
    };

    #[cfg(target_os = "linux")]
    let output = {
        let cert = path.to_str().ok_or_else(|| "cert path has non-utf8 bytes".to_string())?;
        let escaped = cert.replace('\'', "'\\''");
        let script = format!(
            "cp '{}' /usr/local/share/ca-certificates/netstacks-controller-ca.crt \
             && update-ca-certificates",
            escaped,
        );
        std::process::Command::new("pkexec")
            .args(["sh", "-c", &script])
            .output()
            .map_err(|e| format!(
                "Failed to run pkexec: {}. polkit is required for the GUI sudo prompt.",
                e,
            ))?
    };

    let _ = std::fs::remove_file(&path);
    if output.status.success() {
        Ok(())
    } else {
        let code = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Install failed (exit {}): {}", code, stderr.trim()))
    }
}

/// Extract the leaf (server) certificate's Subject Alternative Names via the
/// openssl CLI. Returns the DNS names and IP addresses the cert is valid for.
/// Uses `-text` (not `-ext`) so it also works with macOS's bundled LibreSSL.
fn get_cert_sans(host: &str, port: u16) -> Result<Vec<String>, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let connect_arg = format!("{}:{}", host, port);
    let s_client = Command::new("openssl")
        .args(["s_client", "-connect", &connect_arg, "-servername", host])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("openssl not available: {}", e))?;

    // `openssl x509` reads the FIRST cert on stdin — the leaf (server) cert.
    let mut x509 = Command::new("openssl")
        .args(["x509", "-noout", "-text"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("openssl x509 failed: {}", e))?;
    if let Some(mut stdin) = x509.stdin.take() {
        let _ = stdin.write_all(&s_client.stdout);
    }
    let out = x509.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);

    // The SAN extension prints as:
    //     X509v3 Subject Alternative Name:
    //         DNS:localhost, IP Address:127.0.0.1
    let mut sans = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.contains("Subject Alternative Name") {
            if let Some(values) = lines.next() {
                for part in values.split(',') {
                    let p = part.trim();
                    if let Some(v) = p.strip_prefix("DNS:") {
                        sans.push(v.trim().to_string());
                    } else if let Some(v) = p.strip_prefix("IP Address:") {
                        sans.push(v.trim().to_string());
                    }
                }
            }
            break;
        }
    }
    Ok(sans)
}

/// True if `host` is covered by the cert SANs (exact match, or a `*.domain`
/// wildcard covering a single leftmost label).
fn host_covered_by_sans(host: &str, sans: &[String]) -> bool {
    sans.iter().any(|s| {
        if s.eq_ignore_ascii_case(host) {
            return true;
        }
        if let Some(suffix) = s.strip_prefix("*.") {
            if let Some(dot) = host.find('.') {
                return host[dot + 1..].eq_ignore_ascii_case(suffix);
            }
        }
        false
    })
}

fn check_and_install_controller_cert(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let controller_url = match read_controller_url() {
        Some(url) if url.starts_with("https://") => url,
        _ => return,
    };

    let parsed = match reqwest::Url::parse(&controller_url) {
        Ok(u) => u,
        Err(_) => return,
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => return,
    };
    let port = parsed.port().unwrap_or(443);

    // Quick check: is TLS already trusted? (e.g. dev script already installed the cert)
    let already_trusted = std::process::Command::new("curl")
        .args(["-sf", "--max-time", "3", &format!("{}/health", controller_url)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if already_trusted {
        println!("[cert] Controller TLS already trusted");
        return;
    }

    let (pem, raw_fp) = match extract_cert_via_openssl(&host, port) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[cert] Cannot reach controller: {}", e);
            return;
        }
    };

    let display_fp = format!("SHA256:{}", raw_fp);

    // Diagnose a SAN mismatch BEFORE prompting to trust. If the address the user
    // is connecting to isn't in the certificate's SAN list, every OS rejects the
    // cert as invalid no matter what is trusted — so trusting it won't help.
    // Tell the user exactly what's wrong and the one-line controller-side fix.
    if let Ok(sans) = get_cert_sans(&host, port) {
        if !sans.is_empty() && !host_covered_by_sans(&host, &sans) {
            eprintln!(
                "[cert] SAN mismatch: connecting to '{}' but cert SANs are {:?}",
                host, sans
            );
            app.dialog()
                .message(format!(
                    "The Controller's certificate is not valid for the address you're using.\n\n\
                     You are connecting to:\n  {}\n\n\
                     But its certificate only covers:\n  {}\n\n\
                     Because '{}' isn't listed, your operating system rejects the \
                     certificate as invalid — trusting it will not help.\n\n\
                     Fix on the Controller:\n  \
                     1. Set TLS_SANS to include \"{}\" (comma-separate multiple names/IPs).\n  \
                     2. Restart the Controller — it re-issues its certificate to cover that address.",
                    controller_url,
                    sans.join(", "),
                    host,
                    host,
                ))
                .title("Controller Certificate — Address Not Covered")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
            return;
        }
    }

    if let Some(stored) = read_cert_pin(&controller_url) {
        if normalize_fingerprint(&stored) == normalize_fingerprint(&raw_fp) {
            println!("[cert] Controller certificate unchanged");
            return;
        }
        eprintln!("[cert] Controller certificate CHANGED");
        app.dialog()
            .message(format!(
                "The Controller's TLS certificate has changed!\n\n\
                 Controller: {}\n\n\
                 Previous: {}\n\
                 Current:  {}\n\n\
                 This could indicate a security issue.\n\
                 Contact your administrator.",
                controller_url,
                format!("SHA256:{}", stored),
                display_fp,
            ))
            .title("Certificate Changed")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show();
        return;
    }

    let accepted = app.dialog()
        .message(format!(
            "The Controller at {} uses a self-signed certificate.\n\n\
             Fingerprint:\n{}\n\n\
             Verify this matches your Controller's admin settings.\n\
             Trust this certificate?",
            controller_url, display_fp,
        ))
        .title("Untrusted Controller Certificate")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();

    if !accepted {
        println!("[cert] User declined certificate");
        return;
    }

    match install_cert_pem_sync(&pem) {
        Ok(()) => {
            save_cert_pin(&controller_url, &raw_fp);
            println!("[cert] Certificate installed and pinned");
            // Same constraint as the agent-cert path (line ~924): WebView2 /
            // WebKitGTK / WKWebView cache the trust store at process start,
            // so the just-installed cert isn't trusted in THIS process. The
            // pinning save above means this restart fires once — next launch
            // takes the early-return at the "already trusted" curl check.
            println!("[cert] Restarting app so WebView picks up the new trust store");
            app.restart();
        }
        Err(e) => {
            eprintln!("[cert] Install failed: {}", e);
            app.dialog()
                .message(format!("Failed to install certificate:\n\n{}", e))
                .title("Certificate Install Failed")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
        }
    }
}

/// Holds the sidecar child process so we can kill it when the app exits.
struct SidecarChild(Mutex<Option<CommandChild>>);

#[tauri::command]
fn get_sidecar_token(state: tauri::State<SidecarToken>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn get_sidecar_port(state: tauri::State<SidecarPort>) -> Option<u16> {
    *state.0.lock().unwrap()
}

/// Open a new full app window (same sidecar, independent UI).
/// Can be called from frontend or AI tools.
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle, url_params: Option<String>) -> Result<String, String> {
    use tauri::WebviewWindowBuilder;
    let window_id = format!("window-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());
    let url_path = match &url_params {
        Some(params) => format!("index.html?{}", params),
        None => "index.html".to_string(),
    };
    WebviewWindowBuilder::new(
        &app,
        &window_id,
        tauri::WebviewUrl::App(url_path.into()),
    )
    .title("NetStacks")
    .inner_size(1280.0, 800.0)
    .min_inner_size(800.0, 500.0)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;
    Ok(window_id)
}

/// Fetch the Controller's CA certificate info, bypassing TLS verification.
/// Used when the webview can't connect due to an untrusted self-signed cert.
///
/// AUDIT FIX: the URL is user-supplied and TLS verification is intentionally
/// disabled (we are bootstrapping trust in a self-signed cert). To prevent a
/// downgrade to plaintext or an alternate scheme being abused, parse the URL
/// and require https:// before issuing the request. The trust pivot still
/// happens at the human verification step in AuthProvider, which constant-time
/// compares the SHA-256 fingerprint against a value the user obtained
/// out-of-band.
#[tauri::command]
async fn fetch_controller_cert(controller_url: String) -> Result<serde_json::Value, String> {
    let parsed = reqwest::Url::parse(controller_url.trim_end_matches('/'))
        .map_err(|e| format!("Invalid controller URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err("Controller URL must use https://".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Controller URL must include a host".to_string());
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!("{}/api/tls/ca-certificate/info", parsed.as_str().trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to controller: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Controller returned status {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

/// Install a CA certificate into the user's OS trust store.
///
/// On macOS: adds to user login keychain (no admin password required)
/// On Windows: adds to user certificate store
/// On Linux: writes to ~/.local/share/ca-certificates and updates
///
/// AUDIT FIX (AUTH-003): the previous implementation accepted an arbitrary
/// `filename` from the frontend and joined it to the temp dir without
/// sanitization. `PathBuf::join` does not reject absolute paths or `..`
/// components, so a compromised webview could write arbitrary content (the
/// `pem_content` argument) to arbitrary user-writable locations.
///
/// We now:
///   1. Ignore the caller-supplied `filename` and use a fixed name.
///   2. Reject obviously-non-PEM content before writing it.
///   3. Place the temp file in a per-process subdir of the temp dir.
/// Open the given file in macOS Quick Look (spacebar preview).
/// Markdown files are rendered to HTML first and previewed as HTML — Quick
/// Look's built-in HTML renderer makes them look like a real document
/// instead of raw `#` syntax. No-op with an informative error on
/// Linux/Windows for now.
#[tauri::command]
async fn open_quicklook(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let target = render_markdown_if_needed(&path).unwrap_or_else(|_| path.clone());

        Command::new("qlmanage")
            .args(["-p", &target])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch qlmanage: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Quick Look is only available on macOS".into())
    }
}

/// If `path` is a markdown file, render it to a styled HTML temp file and
/// return that path. Otherwise return the original path.
#[cfg(target_os = "macos")]
fn render_markdown_if_needed(path: &str) -> std::io::Result<String> {
    use std::io::Write;

    let lower = path.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
        return Ok(path.to_string());
    }

    let source = std::fs::read_to_string(path)?;
    let parser = pulldown_cmark::Parser::new_ext(&source, pulldown_cmark::Options::all());
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, parser);

    let title = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Preview".to_string());

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
  body {{ font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #1d1d1f; background: #fff; max-width: 760px; margin: 32px auto; padding: 0 24px; }}
  h1, h2, h3, h4, h5, h6 {{ margin-top: 1.6em; margin-bottom: 0.4em; color: #1d1d1f; }}
  h1 {{ font-size: 1.9em; border-bottom: 1px solid #e2e2e6; padding-bottom: 0.3em; }}
  h2 {{ font-size: 1.45em; border-bottom: 1px solid #ececf0; padding-bottom: 0.25em; }}
  code, pre {{ font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 12.5px; }}
  code {{ background: #f5f5f7; padding: 0.1em 0.4em; border-radius: 4px; }}
  pre {{ background: #f5f5f7; padding: 12px 14px; border-radius: 6px; overflow: auto; }}
  pre code {{ background: transparent; padding: 0; }}
  a {{ color: #0066cc; text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  blockquote {{ border-left: 4px solid #e2e2e6; margin: 0; padding: 0.4em 1em; color: #555; }}
  table {{ border-collapse: collapse; }}
  th, td {{ border: 1px solid #e2e2e6; padding: 6px 10px; }}
  th {{ background: #f5f5f7; }}
  img {{ max-width: 100%; }}
  hr {{ border: 0; border-top: 1px solid #e2e2e6; margin: 1.6em 0; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #f5f5f7; background: #1d1d1f; }}
    code, pre {{ background: #2c2c2e; }}
    blockquote {{ border-left-color: #3a3a3c; color: #aaa; }}
    th {{ background: #2c2c2e; }}
    th, td {{ border-color: #3a3a3c; }}
    hr {{ border-top-color: #3a3a3c; }}
    a {{ color: #66b3ff; }}
  }}
</style>
</head>
<body>
{body}
</body>
</html>
"#
    );

    let dir = std::env::temp_dir().join("netstacks-quicklook");
    std::fs::create_dir_all(&dir)?;

    // Hash the path so re-previewing the same file reuses the same temp
    // (qlmanage caches by filename, so a stable name avoids stale renders).
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    path.hash(&mut hasher);
    let temp_name = format!("{:x}-{}.html", hasher.finish(), sanitize_filename(&title));
    let temp_path = dir.join(temp_name);

    let mut f = std::fs::File::create(&temp_path)?;
    f.write_all(html.as_bytes())?;
    drop(f);

    Ok(temp_path.to_string_lossy().to_string())
}

#[cfg(target_os = "macos")]
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Read an arbitrary file path as bytes. Used by the SFTP drag-drop
/// upload bridge — Tauri's `onDragDropEvent` hands us absolute paths
/// to whatever the user dragged from Finder/Explorer, and the fs
/// plugin's scoping system doesn't accept those arbitrary paths
/// without loosening the global scope. A bespoke command avoids
/// touching the fs plugin's scope and keeps the surface tight: this
/// command is the only entry point for reading caller-supplied
/// absolute paths, so any future audit / hardening lives in one
/// place.
///
/// Size cap: 5 GiB. Larger than that and we should be streaming, not
/// loading into a single Vec<u8> + serializing across the IPC bridge.
#[tauri::command]
async fn read_dropped_file(path: String) -> Result<Vec<u8>, String> {
    const MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
    let p = std::path::Path::new(&path);
    let meta = tokio::fs::metadata(p).await
        .map_err(|e| format!("Failed to stat dropped file: {}", e))?;
    if !meta.is_file() {
        return Err(format!(
            "Refusing to read: '{}' is not a regular file (directories aren't supported)",
            path,
        ));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "Refusing to read: file exceeds {} GiB upload cap",
            MAX_BYTES / (1024 * 1024 * 1024),
        ));
    }
    tokio::fs::read(p).await.map_err(|e| format!("Failed to read dropped file: {}", e))
}

#[tauri::command]
async fn install_ca_certificate(pem_content: String, filename: String) -> Result<String, String> {
    use std::io::Write;

    // Sanity check the PEM payload — reject anything that doesn't even look
    // like a CERTIFICATE block. Full X.509 validation is a TODO best done
    // with the `x509-parser` crate.
    let pem = pem_content.trim();
    if !pem.starts_with("-----BEGIN CERTIFICATE-----") || !pem.contains("-----END CERTIFICATE-----") {
        return Err("Refusing to install: payload is not a PEM-encoded CERTIFICATE block".into());
    }
    if pem_content.len() > 64 * 1024 {
        return Err("Refusing to install: PEM payload exceeds 64 KiB".into());
    }

    // Filename argument is logged but not used as a path component.
    tracing_log_filename(&filename);

    let temp_dir = std::env::temp_dir().join("netstacks-cacert");
    if let Err(e) = std::fs::create_dir_all(&temp_dir) {
        return Err(format!("Failed to prepare temp dir: {}", e));
    }
    let cert_path = temp_dir.join("install.pem");

    let mut file = std::fs::File::create(&cert_path)
        .map_err(|e| format!("Failed to write certificate: {}", e))?;
    file.write_all(pem.as_bytes())
        .map_err(|e| format!("Failed to write certificate: {}", e))?;
    drop(file);

    let result = install_cert_os(&cert_path).await;

    // Clean up temp file
    let _ = std::fs::remove_file(&cert_path);

    result
}

/// Best-effort logging of the (now-unused) caller-supplied filename. Helpful
/// for debugging while making clear this value is not on the critical path.
fn tracing_log_filename(filename: &str) {
    // Strip any path separators so we never accidentally log a full path.
    let safe = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .take(64)
        .collect::<String>();
    eprintln!("[install_ca_certificate] caller-supplied filename (ignored): {}", safe);
}

#[cfg(target_os = "macos")]
async fn install_cert_os(cert_path: &std::path::Path) -> Result<String, String> {
    // Install to user login keychain (no admin password needed)
    let output = std::process::Command::new("security")
        .args([
            "add-trusted-cert",
            "-r", "trustRoot",
            "-k", &format!("{}/Library/Keychains/login.keychain-db",
                std::env::var("HOME").unwrap_or_default()),
            cert_path.to_str().unwrap_or_default(),
        ])
        .output()
        .map_err(|e| format!("Failed to run security command: {}", e))?;

    if output.status.success() {
        Ok("CA certificate installed to macOS login keychain. Restart the app for changes to take effect.".into())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install certificate: {}", stderr))
    }
}

#[cfg(target_os = "windows")]
async fn install_cert_os(cert_path: &std::path::Path) -> Result<String, String> {
    // Use PowerShell Import-Certificate to write into HKCU\Root. The
    // previous `certutil -user -addstore Root` approach pops its own
    // dialog AND a console window; Import-Certificate runs cleanly with
    // CREATE_NO_WINDOW suppressing the console.
    //
    // Important: do NOT pass `-NonInteractive`. Writing to
    // Cert:\CurrentUser\Root triggers Windows' OS-level "Are you sure
    // you want to install this root certificate?" confirmation dialog —
    // adding a root CA is treated as security-sensitive even for HKCU.
    // With -NonInteractive the cmdlet refuses to run and returns
    // "UI is not allowed in this operation", which surfaces to the user
    // as a hard install failure. Without the flag the OS dialog appears,
    // the user clicks Yes once, and the cert is installed. This is the
    // Windows-native equivalent of macOS asking for the login keychain
    // password and Linux popping the polkit prompt — every platform has
    // a one-time user gesture for root-CA installs.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let cert = cert_path.to_str().ok_or_else(|| "cert path has non-utf8 bytes".to_string())?;
    let script = format!(
        "Import-Certificate -FilePath '{}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null",
        cert.replace('\'', "''")  // PowerShell single-quote escape
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run powershell (is it on PATH?): {}", e))?;

    if output.status.success() {
        Ok("CA certificate installed to Windows user trust store. Restart the app for changes to take effect.".into())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Import-Certificate failed: {}", stderr.trim()))
    }
}

/// On macOS, RFC1918 connections from a bundled app silently fail with
/// "No route to host" until the user grants Local Network access. The OS
/// prompt only fires after the first RFC1918/multicast attempt — and it
/// fires without context, so users don't know what they're being asked.
///
/// On first launch we show our own explanation dialog, then fire a one-shot
/// mDNS multicast send to deterministically trigger the OS prompt right
/// after the user dismisses our message. Multicast (224.0.0.251:5353) is
/// the most reliable trigger and doesn't depend on which subnet the user
/// is on. A flag file in Application Support records that we've done this,
/// so the dialog never appears twice for the same user.
#[cfg(target_os = "macos")]
fn maybe_prompt_for_lan_access(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let flag = lan_prompt_flag_path();
    if flag.exists() {
        return;
    }

    if let Some(parent) = flag.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    app.dialog()
        .message(
            "NetStacks needs permission to reach devices on your local network \
             (SSH, telnet, SNMP, discovery).\n\n\
             macOS will ask you to allow this on the next screen. Click Allow.\n\n\
             You can change this later in System Settings \u{2192} Privacy & Security \u{2192} Local Network.",
        )
        .title("Local Network Access Required")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| {
            // User dismissed — fire mDNS multicast send to trigger the OS prompt.
            // Errors are intentionally ignored: even a failed send registers the
            // app with TCC, which is the only thing we actually need.
            if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
                let _ = socket.send_to(b"\x00", "224.0.0.251:5353");
            }
            let _ = std::fs::write(&flag, "1");
        });
}

#[cfg(not(target_os = "macos"))]
fn maybe_prompt_for_lan_access(_app: &tauri::AppHandle) {}

#[cfg(target_os = "linux")]
async fn install_cert_os(cert_path: &std::path::Path) -> Result<String, String> {
    // Linux user-trust paths vary too much across distros and WebKitGTK
    // builds (GnuTLS vs NSS backends, p11-kit dir conventions) to be
    // reliable. update-ca-certificates is universal but requires root, so
    // we use pkexec to get a one-time graphical password prompt. The
    // fingerprint flag in the caller short-circuits subsequent launches,
    // so the prompt only appears the very first time (and again only if
    // the cert is ever regenerated). After install, every TLS client on
    // the box — including WebKitGTK regardless of which TLS backend it
    // links against — trusts the cert via the system anchor bundle.
    //
    // The earlier NSS-DB-only attempt did not work on Pop!_OS / Ubuntu
    // because WebKitGTK there uses GnuTLS+p11-kit, which doesn't consult
    // ~/.pki/nssdb.
    let cert = cert_path.to_str().ok_or_else(|| "cert path has non-utf8 bytes".to_string())?;
    // Single-quote escape the source path for the shell wrapper. The
    // destination filename is fixed so re-installs replace rather than
    // accumulate.
    let escaped = cert.replace('\'', "'\\''");
    let script = format!(
        "cp '{}' /usr/local/share/ca-certificates/netstacks-localhost.crt \
         && update-ca-certificates",
        escaped
    );

    let output = std::process::Command::new("pkexec")
        .args(["sh", "-c", &script])
        .output()
        .map_err(|e| format!(
            "Failed to run pkexec: {}. polkit is required for the GUI sudo prompt.",
            e
        ))?;

    if output.status.success() {
        Ok("CA certificate installed system-wide. Restart the app for changes to take effect.".into())
    } else {
        let code = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // pkexec exits ~126/127 when the user dismisses the password prompt.
        Err(format!("Cert install failed (pkexec exit {}): {}", code, stderr.trim()))
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SidecarToken(Mutex::new(None)))
        .manage(SidecarPort(Mutex::new(None)))
        .manage(SidecarChild(Mutex::new(None)))
        .manage(MenuItemRegistry(parking_lot::Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![get_sidecar_token, get_sidecar_port, install_ca_certificate, fetch_controller_cert, open_new_window, open_quicklook, set_menu_enabled_batch, read_dropped_file])
        .setup(|app| {
            // Build the native menu bar (macOS/Windows/Linux) and
            // stash the per-id MenuItem handles so the frontend's
            // MenuBridge can later toggle enable/disable state.
            let (menu, item_registry) = build_menu(app.handle())?;
            {
                let state: tauri::State<MenuItemRegistry> = app.state();
                // parking_lot::Mutex.lock() doesn't return Result —
                // can't be poisoned.
                let mut guard = state.0.lock();
                *guard = item_registry;
            }
            app.set_menu(menu)?;

            // Generate the sidecar auth token here (in the parent) and pass
            // it via env on spawn. Replaces the legacy stdout handoff for the
            // token:
            //   1) Removes stdout buffering / event-timing fragility on
            //      Windows + Linux (suspected cause of "backend not connected"
            //      at startup on those platforms).
            //   2) Keeps the token out of terminal scrollback and screen
            //      shares — env is process-private on all three OSes.
            // The agent prefers NETSTACKS_AUTH_TOKEN env (>= 32 chars) and
            // falls back to generate-and-print on stdout for --remote /
            // standalone launches, where SSH is the handoff channel.
            let sidecar_token: String = {
                use rand::Rng;
                let bytes: [u8; 32] = rand::thread_rng().gen();
                bytes.iter().map(|b| format!("{:02x}", b)).collect()
            };
            // Store before spawn so any IPC `get_sidecar_token` call from the
            // frontend that races the agent boot returns the right value.
            if let Some(state) = app.try_state::<SidecarToken>() {
                *state.0.lock().unwrap() = Some(sidecar_token.clone());
            }

            // Spawn the netstacks-agent sidecar with the token injected via env.
            // `--license-example` satisfies the agent's launch gate — see the
            // REQUIRED_LAUNCH_FLAG constant + is_gate_satisfied() in agent/src/main.rs.
            // It's a friction barrier (anti-double-click), not a security control;
            // the value is intentionally hard-coded here and on the agent side. When
            // real licensing lands this argument carries a server-validated token.
            let sidecar_command = app
                .shell()
                .sidecar("netstacks-agent")
                .unwrap()
                .args(["--license-example"])
                .env("NETSTACKS_AUTH_TOKEN", &sidecar_token);
            let (mut rx, child) =
                sidecar_command.spawn().expect("Failed to spawn netstacks-agent sidecar");

            // Mirror the event the old stdout parser used to emit, so any
            // frontend listener gets the token without polling.
            app.emit("sidecar-auth-token", sidecar_token).ok();

            // Store child process handle so we can kill it on app exit
            if let Some(state) = app.try_state::<SidecarChild>() {
                *state.0.lock().unwrap() = Some(child);
            }

            // Clone app handle for use in async task (needed to emit events to frontend)
            let app_handle = app.handle().clone();

            // Spawn a task to consume sidecar output (prevents blocking when buffer fills)
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line_str = String::from_utf8_lossy(&line);
                            if let Some(token) = line_str.strip_prefix("NETSTACKS_AUTH_TOKEN=") {
                                let token = token.trim().to_string();
                                if let Some(state) = app_handle.try_state::<SidecarToken>() {
                                    *state.0.lock().unwrap() = Some(token.clone());
                                }
                                app_handle.emit("sidecar-auth-token", token).unwrap();
                                println!("[sidecar] Auth token received and forwarded to frontend");
                            } else if let Some(port_str) = line_str.strip_prefix("NETSTACKS_PORT=") {
                                if let Ok(port) = port_str.trim().parse::<u16>() {
                                    if let Some(state) = app_handle.try_state::<SidecarPort>() {
                                        *state.0.lock().unwrap() = Some(port);
                                    }
                                    app_handle.emit("sidecar-port", port).unwrap();
                                    println!("[sidecar] Agent bound to port {}", port);
                                }
                            } else if let Some(cert_b64) = line_str.strip_prefix("NETSTACKS_TLS_CERT=") {
                                let pem_opt = base64::engine::general_purpose::STANDARD
                                    .decode(cert_b64.trim().as_bytes())
                                    .ok()
                                    .and_then(|b| String::from_utf8(b).ok());
                                if let Some(pem) = pem_opt {
                                    let app = app_handle.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let fingerprint = cert_fingerprint(&pem);
                                        let flag = tls_cert_flag_path();

                                        // Skip install if this exact cert was already trusted
                                        let already_done = std::fs::read_to_string(&flag)
                                            .map(|s| s.trim() == fingerprint)
                                            .unwrap_or(false);

                                        if already_done {
                                            app.emit("sidecar-tls-ready", ()).ok();
                                            return;
                                        }

                                        // First run or cert changed — install into OS trust store.
                                        // macOS will prompt once for login password; subsequent
                                        // launches are silently skipped by the check above.
                                        match install_ca_certificate(pem, "netstacks-local.crt".into()).await {
                                            Ok(_) => {
                                                let _ = std::fs::write(&flag, fingerprint);
                                                // First-time install: WebView2 / WebKitGTK / WKWebView
                                                // cache the trust store at process start, so the
                                                // just-installed cert isn't trusted in THIS process.
                                                // Restart automatically so the user doesn't have to
                                                // kill + relaunch manually. The fingerprint-flag
                                                // short-circuit above means this only fires once.
                                                app.restart();
                                            }
                                            Err(e) => {
                                                eprintln!("[sidecar] TLS cert install failed: {}", e);
                                                // Emit anyway so app doesn't hang; HTTPS may fail
                                                app.emit("sidecar-tls-ready", ()).ok();
                                            }
                                        }
                                    });
                                }
                            } else {
                                println!("[sidecar] {}", line_str);
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar err] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(status) => {
                            eprintln!("[sidecar] terminated with status: {:?}", status);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            println!("netstacks-agent sidecar started");

            // First-run only: explain macOS Local Network requirement and
            // trigger the OS prompt. No-op on other platforms and on
            // subsequent launches.
            maybe_prompt_for_lan_access(app.handle());
            check_and_install_controller_cert(app.handle());

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Handle custom menu item clicks and emit frontend events
            let id = event.id();

            // Handle "New Window" directly (opens a full second app instance)
            if id.as_ref() == "new-window" {
                use tauri::WebviewWindowBuilder;
                let window_id = format!("window-{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis());
                let _ = WebviewWindowBuilder::new(
                    app,
                    &window_id,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("NetStacks")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 500.0)
                .build();
                return;
            }

            // Every other menu item just emits `menu://<id>`. The
            // frontend's MenuBridge maps that to a CommandRegistry id
            // and dispatches. Keeping the Rust side data-free means
            // adding a new menu item is one line in build_menu() and
            // one line in MENU_ID_TO_COMMAND — no Rust round-trip.
            let event_name = format!("menu://{}", id.as_ref());
            app.emit(&event_name, ()).ok();
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill the sidecar agent when the app exits
                if let Some(state) = app.try_state::<SidecarChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        println!("[sidecar] Killing agent process on app exit");
                        let _ = child.kill();
                    }
                }
            }
        });
}

/// Build the native menu bar with platform-appropriate structure.
/// On macOS: NetStacks app menu + File/Edit/View/Session/Window/Help
/// On Windows/Linux: File (with Settings/Exit) + Edit/View/Session/Window/Help (with About)
#[allow(unused_mut)] // mut needed on Windows/Linux for conditional menu items
/// Build the native menu bar and return both the assembled menu AND
/// a registry of every custom MenuItem keyed by its id. The registry
/// lets the frontend's MenuBridge enable/disable items in response to
/// ActiveContext changes via the `set_menu_enabled_batch` command.
fn build_menu(
    handle: &tauri::AppHandle,
) -> Result<(Menu<tauri::Wry>, HashMap<String, MenuItem<tauri::Wry>>), tauri::Error> {
    let mut menu_builder = MenuBuilder::new(handle);
    let mut items: HashMap<String, MenuItem<tauri::Wry>> = HashMap::new();
    // Tiny helper so each item registration is one line and we can't
    // forget to clone into the registry.
    macro_rules! track {
        ($id:expr, $item:expr) => {{
            let item = $item;
            items.insert($id.to_string(), item.clone());
            item
        }};
    }

    // === macOS App Menu ===
    // On macOS, the first submenu becomes the system app menu
    #[cfg(target_os = "macos")]
    {
        let about = track!("about", MenuItemBuilder::with_id("about", "About NetStacks")
            .build(handle)?);
        let settings = track!("settings", MenuItemBuilder::with_id("settings", "Settings\u{2026}")
            .accelerator("CmdOrCtrl+,")
            .build(handle)?);

        let app_menu = SubmenuBuilder::new(handle, "NetStacks")
            .item(&about)
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::services(handle, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(handle, None)?)
            .item(&PredefinedMenuItem::hide_others(handle, None)?)
            .item(&PredefinedMenuItem::show_all(handle, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(handle, Some("Quit NetStacks"))?)
            .build()?;
        menu_builder = menu_builder.item(&app_menu);
    }

    // === File Menu ===
    let new_session = track!("new-session", MenuItemBuilder::with_id("new-session", "New Session")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?);
    let new_terminal = track!("new-terminal", MenuItemBuilder::with_id("new-terminal", "New Terminal Tab")
        .accelerator("CmdOrCtrl+T")
        .build(handle)?);
    let new_document = track!("new-document", MenuItemBuilder::with_id("new-document", "New Document")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?);
    let quick_connect = track!("quick-connect", MenuItemBuilder::with_id("quick-connect", "Quick Connect\u{2026}")
        .accelerator("CmdOrCtrl+Shift+Q")
        .build(handle)?);
    let save = track!("save", MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(handle)?);
    let close_tab = track!("close-tab", MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(handle)?);

    let mut file_builder = SubmenuBuilder::new(handle, "File")
        .item(&new_session)
        .item(&new_terminal)
        .item(&new_document)
        .separator()
        .item(&quick_connect)
        .separator()
        .item(&save)
        .separator()
        .item(&close_tab);

    // On Windows/Linux, add Settings and Exit to File menu
    #[cfg(not(target_os = "macos"))]
    {
        let settings = track!("settings", MenuItemBuilder::with_id("settings", "Settings\u{2026}")
            .accelerator("CmdOrCtrl+,")
            .build(handle)?);
        file_builder = file_builder
            .separator()
            .item(&settings)
            .separator()
            .item(&PredefinedMenuItem::quit(handle, Some("Exit"))?);
    }

    let file_menu = file_builder.build()?;

    // === Edit Menu ===
    let find = track!("find", MenuItemBuilder::with_id("find", "Find\u{2026}")
        .accelerator("CmdOrCtrl+F")
        .build(handle)?);

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .separator()
        .item(&find)
        .build()?;

    // === View Menu ===
    let command_palette = track!("command-palette", MenuItemBuilder::with_id("command-palette", "Command Palette\u{2026}")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(handle)?);
    let toggle_sidebar = track!("toggle-sidebar", MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(handle)?);
    let toggle_ai_panel = track!("toggle-ai-panel", MenuItemBuilder::with_id("toggle-ai-panel", "Toggle AI Panel")
        .accelerator("CmdOrCtrl+I")
        .build(handle)?);
    let zoom_reset = track!("zoom-reset", MenuItemBuilder::with_id("zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(handle)?);
    let zoom_in = track!("zoom-in", MenuItemBuilder::with_id("zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(handle)?);
    let zoom_out = track!("zoom-out", MenuItemBuilder::with_id("zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(handle)?);

    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&command_palette)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_ai_panel)
        .separator()
        .item(&zoom_reset)
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    // === Session Menu ===
    let reconnect = track!("reconnect", MenuItemBuilder::with_id("reconnect", "Reconnect")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(handle)?);
    let toggle_multi_send = track!("toggle-multi-send", MenuItemBuilder::with_id("toggle-multi-send", "Toggle Multi-Send")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(handle)?);
    let connect_selected = track!("connect-selected", MenuItemBuilder::with_id("connect-selected", "Connect Selected Sessions")
        .accelerator("CmdOrCtrl+Shift+Return")
        .build(handle)?);
    let start_troubleshooting = track!("start-troubleshooting",
        MenuItemBuilder::with_id("start-troubleshooting", "Start Troubleshooting\u{2026}")
            .accelerator("CmdOrCtrl+Shift+K")
            .build(handle)?);

    let open_remote_window = track!("open-remote-window",
        MenuItemBuilder::with_id("open-remote-window", "Open Remote Window\u{2026}").build(handle)?);

    let session_menu = SubmenuBuilder::new(handle, "Session")
        .item(&reconnect)
        .item(&toggle_multi_send)
        .separator()
        .item(&connect_selected)
        .separator()
        .item(&open_remote_window)
        .separator()
        .item(&start_troubleshooting)
        .build()?;

    // === Tools Menu ===
    // Settings tab shortcuts — clicking jumps the user to the relevant
    // Settings tab. Commands handle the actual openSettingsTab(tab)
    // call (registered in App.tsx alongside the existing settings
    // command), so this menu is data-only here.
    let open_quick_actions = track!("open-quick-actions",
        MenuItemBuilder::with_id("open-quick-actions", "Quick Actions\u{2026}").build(handle)?);
    let open_snippets = track!("open-snippets",
        MenuItemBuilder::with_id("open-snippets", "Snippets\u{2026}").build(handle)?);
    let open_mapped_keys = track!("open-mapped-keys",
        MenuItemBuilder::with_id("open-mapped-keys", "Mapped Keys\u{2026}").build(handle)?);
    let open_vault = track!("open-vault",
        MenuItemBuilder::with_id("open-vault", "Credential Vault\u{2026}").build(handle)?);
    let open_recordings = track!("open-recordings",
        MenuItemBuilder::with_id("open-recordings", "Recordings\u{2026}").build(handle)?);
    let open_layouts = track!("open-layouts",
        MenuItemBuilder::with_id("open-layouts", "Saved Layouts\u{2026}").build(handle)?);
    let open_session_logs = track!("open-session-logs",
        MenuItemBuilder::with_id("open-session-logs", "Session Logs\u{2026}").build(handle)?);
    let open_host_keys = track!("open-host-keys",
        MenuItemBuilder::with_id("open-host-keys", "Trusted Host Keys\u{2026}").build(handle)?);

    let tools_menu = SubmenuBuilder::new(handle, "Tools")
        .item(&open_quick_actions)
        .item(&open_snippets)
        .item(&open_mapped_keys)
        .separator()
        .item(&open_vault)
        .item(&open_host_keys)
        .separator()
        .item(&open_recordings)
        .item(&open_session_logs)
        .item(&open_layouts)
        .build()?;

    // === AI Menu ===
    let open_ai_settings = track!("open-ai-settings",
        MenuItemBuilder::with_id("open-ai-settings", "AI Settings\u{2026}").build(handle)?);
    let open_mcp_servers = track!("open-mcp-servers",
        MenuItemBuilder::with_id("open-mcp-servers", "MCP Servers\u{2026}").build(handle)?);
    let open_ai_memory = track!("open-ai-memory",
        MenuItemBuilder::with_id("open-ai-memory", "AI Memory\u{2026}").build(handle)?);
    let toggle_ai_chat = track!("toggle-ai-chat",
        MenuItemBuilder::with_id("toggle-ai-chat", "Toggle AI Chat Panel")
            .accelerator("CmdOrCtrl+J")
            .build(handle)?);

    let ai_menu = SubmenuBuilder::new(handle, "AI")
        .item(&toggle_ai_chat)
        .separator()
        .item(&open_ai_settings)
        .item(&open_mcp_servers)
        .item(&open_ai_memory)
        .build()?;

    // === Window Menu ===
    let new_window = track!("new-window", MenuItemBuilder::with_id("new-window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?);
    let next_tab = track!("next-tab", MenuItemBuilder::with_id("next-tab", "Show Next Tab")
        .accelerator("CmdOrCtrl+Shift+]")
        .build(handle)?);
    let prev_tab = track!("previous-tab", MenuItemBuilder::with_id("previous-tab", "Show Previous Tab")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(handle)?);
    // Tabs submenu — close-all / close-to-right / reopen-closed
    // already implemented on TabGroup's context menu; surfacing them
    // in the native menu makes the tab management discoverable.
    let close_all_tabs = track!("close-all-tabs",
        MenuItemBuilder::with_id("close-all-tabs", "Close All Tabs")
            .accelerator("CmdOrCtrl+Shift+W")
            .build(handle)?);
    let close_tabs_right = track!("close-tabs-right",
        MenuItemBuilder::with_id("close-tabs-right", "Close Tabs to the Right").build(handle)?);
    let reopen_closed_tab = track!("reopen-closed-tab",
        MenuItemBuilder::with_id("reopen-closed-tab", "Reopen Closed Tab")
            .accelerator("CmdOrCtrl+Shift+T")
            .build(handle)?);

    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&new_window)
        .separator()
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .separator()
        .item(&close_all_tabs)
        .item(&close_tabs_right)
        .item(&reopen_closed_tab)
        .build()?;

    // === Help Menu ===
    let open_docs = track!("open-docs", MenuItemBuilder::with_id("open-docs", "NetStacks Documentation")
        .build(handle)?);

    let mut help_builder = SubmenuBuilder::new(handle, "Help")
        .item(&open_docs);

    // On Windows/Linux, add About to Help menu (on macOS it's in the app menu)
    #[cfg(not(target_os = "macos"))]
    {
        let about = track!("about", MenuItemBuilder::with_id("about", "About NetStacks")
            .build(handle)?);
        help_builder = help_builder
            .separator()
            .item(&about);
    }

    let help_menu = help_builder.build()?;

    // Build the complete menu bar. Order follows macOS HIG: app menu,
    // File, Edit, View, then domain-specific menus (Session, Tools, AI)
    // before Window/Help.
    let menu = menu_builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&session_menu)
        .item(&tools_menu)
        .item(&ai_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok((menu, items))
}

/// Frontend → backend: set the enabled state on a batch of menu items
/// by id. Unknown ids are silently skipped so the frontend can ship
/// command updates for items that may not exist in this build.
///
/// The frontend (MenuBridge) calls this every time the ActiveContext
/// changes or a new command registers — so the menu reflects what's
/// actually available right now.
#[tauri::command]
fn set_menu_enabled_batch(
    state: tauri::State<'_, MenuItemRegistry>,
    items: Vec<MenuEnabledUpdate>,
) -> Result<(), String> {
    // parking_lot::Mutex — infallible lock, no poison handling.
    let registry = state.0.lock();
    for update in items {
        if let Some(item) = registry.get(&update.id) {
            // Tauri's set_enabled returns Result; we ignore individual
            // failures so one bad item doesn't break the whole batch.
            let _ = item.set_enabled(update.enabled);
        }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct MenuEnabledUpdate {
    id: String,
    enabled: bool,
}
