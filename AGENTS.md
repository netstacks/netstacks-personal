# NetStacks Terminal — Agent Instructions

NetStacks is a Tauri v2 desktop app for network engineers (SSH/Telnet/SFTP, AI assistant, SNMP, topology viz). Two-process architecture: **Rust Agent** (Axum backend, `agent/`) and **React Frontend** (Vite + Tauri shell, `frontend/`).

## Cursor Cloud specific instructions

### System dependencies (Linux, pre-installed in VM)

The Tauri build requires: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `patchelf`, `build-essential`. These are installed via the VM setup and must not be removed.

### Rust toolchain

Rust 1.85+ is required (crate `block-buffer` uses `edition2024`). The VM has `rustup` with stable defaulted to 1.95+. If builds fail with `feature edition2024 is required`, run `rustup update stable && rustup default stable`.

### Running services for development

| Service | Command | Port | Notes |
|---|---|---|---|
| Rust Agent | `cd agent && cargo run -- --port 8080` | 8080 (HTTPS, self-signed) | Always uses TLS; pass `--port` to set a fixed port (default: ephemeral) |
| Vite Dev Server | `cd frontend && npm run dev` | 5173 | Serves React frontend with HMR |
| Tauri Desktop | `cd frontend && npm run tauri:dev` | — | Spawns agent sidecar + WebView window (requires display) |

In Cloud Agent VMs (headless), use the **Agent + Vite** combination. The Tauri desktop mode requires a display server and is not available in headless VMs.

The frontend in browser-only mode (`npm run dev`) connects directly to `https://127.0.0.1:<port>` — it does **not** route through the Vite proxy for API calls. A "Backend connection error" in the browser is expected because the self-signed TLS cert is not trusted and the Tauri auth token is absent. This does not affect the agent API or the build process.

### Key commands

| Task | Command | Working dir |
|---|---|---|
| Install frontend deps | `npm install` | `frontend/` |
| Lint (frontend) | `npm run lint` | `frontend/` |
| Typecheck (frontend) | `npm run typecheck` | `frontend/` |
| Unit tests (frontend) | `npm run test` | `frontend/` |
| Pact tests (frontend) | `npm run test:pact` | `frontend/` |
| Build agent | `cargo build` | `agent/` |
| Test agent | `cargo test` | `agent/` |
| Format agent | `cargo fmt` | `agent/` |

### Known pre-existing issues

- `npm run lint` reports ~213 errors and ~93 warnings (pre-existing in the codebase).
- `npm run test` — 2 tests in `src/App.test.tsx` fail due to a missing `getRemoteAgentHost` mock export (pre-existing). All other 80 tests pass.
- `cargo build` emits 3 dead-code warnings about `BiometricError` variants (macOS-only code on Linux).

### Database

SQLite is embedded — no external DB server needed. The agent auto-creates and migrates `netstacks.db` at startup in the platform's app-data directory.

### External dependency

The `netstacks-credential-vault` crate is fetched from `github.com/netstacks/netstacks-crypto.git` (tag `v0.1.0`) during `cargo build`. First builds require network access.
