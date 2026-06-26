### The SSH Terminal that thinks with you.

SSH, Telnet, and SFTP with an encrypted credential vault, network-aware AI, and topology visualization.
Built for network engineers. Open source under Apache 2.0.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/netstacks/netstacks-terminal/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://netstacks.net/download)
[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_%2B_Rust-orange.svg)](https://tauri.app)

[Download](https://netstacks.net/download) &nbsp;&bull;&nbsp; [Documentation](https://www.netstacks.net/docs) &nbsp;&bull;&nbsp; [Blog](https://netstacks.hashnode.dev)

</div>

---

<div align="center">

<img src="CoPilotDemo.gif" alt="NetStacks AI CoPilot Demo" width="800" />

</div>

---

# NetStacks Terminal

NetStacks is a desktop terminal for network engineers — SSH/Telnet/SFTP, an
AI assistant that understands network gear, an encrypted credential vault,
and topology visualization. This repository contains the **NetStacks
Terminal** and the **Local Agent** that runs alongside it in Personal Mode.

This is the open, free, single-user side of NetStacks. The closed,
commercial Controller (multi-user vault, RBAC, audit log, plugins) is a
separate product; see [Open core](#open-core) below.

## What you get

- Tauri-based desktop app (macOS, Windows, Linux) — single window, multi-tab
- SSH / Telnet / SFTP with host-key TOFU and a credential vault
- AI assistant with vendor-aware knowledge packs, opt-in tools, and an
  output sanitizer that strips secrets before they reach the model
- SNMP polling, neighbor discovery, topology visualization
- Integrations with NetBox, LibreNMS, and Netdisco
- Customizable highlighting, snippets, custom commands, jump hosts,
  tunnels, scripts

All features. No tier gates. No phone-home. Free forever for individuals.

## Install

Download the signed installer for your platform from
<https://netstacks.net/download> (.dmg for macOS, .exe / .msi for
Windows, AppImage / .deb for Linux). All installers are code-signed and
notarized.

To build from source instead, see `docs/BUILD-LINUX.md`,
`docs/BUILD-MACOS.md`, and `docs/BUILD-WINDOWS.md`.

## Quickstart

1. Launch NetStacks. The Local Agent starts as a sidecar process.
2. Set a master password to unlock the credential vault.
3. Add a session (Settings → Profiles, or the Sessions sidebar).
4. Connect.

## Open core

NetStacks is open-core. This repository, the Local Agent, and the audited
crypto primitives at [netstacks-crypto](https://github.com/netstacks/netstacks-crypto)
are open source under Apache 2.0. The Controller — which provides
multi-user features (shared vault, RBAC, audit logs, plugins) — is
commercial software sold separately for teams and enterprises.

The architecture has two modes:

- **Personal Mode** (this repo): Tauri Terminal + bundled Local Agent.
  Single user, single machine. The agent does SSH, holds the vault, runs
  AI integration. Free, open source, no telemetry, no license check.
- **Enterprise Mode** (commercial Controller): same Tauri Terminal, no
  Local Agent — the Tauri shell talks to a customer-hosted Controller that
  does multi-user SSH proxying, shared vault, RBAC, scheduling, plugins.

If you only need NetStacks for yourself, you only need this repository.

For commercial Controller licensing or support contracts, see
<https://netstacks.net>.

## Status

NetStacks is built and maintained by a small team. Bug fixes and feature
work ship continuously, and we triage incoming issues against a documented
support boundary — see `SUPPORT.md`. Teams that need response-time
guarantees, named contacts, or implementation help can purchase a support
contract — see <https://netstacks.net/support>.

## Backup & restore

All persistent state lives in a single SQLite database — sessions, profiles,
encrypted vault credentials, topologies, and history. Backing up the app
means backing up that file.

**Locations**

| Platform | Database |
|---|---|
| macOS | `~/Library/Application Support/netstacks/netstacks.db` |
| Linux | `~/.local/share/netstacks/netstacks.db` |
| Windows | `%APPDATA%\netstacks\netstacks.db` |

The `~/Library/Application Support/com.netstacks.terminal/` directory
(macOS — analogous paths on Linux/Windows) holds the local TLS cert and
`app-config.json`. The cert auto-regenerates, so you only need to back up
`app-config.json` if you've configured an Enterprise Controller URL.

**Backup**

While the app is **stopped**, a plain copy is fine:

```bash
cp ~/Library/Application\ Support/netstacks/netstacks.db ~/netstacks.db.backup
```

While the app is **running**, use SQLite's atomic backup so you don't
capture mid-transaction state. Note: use `$HOME` (or a full path) inside
the quoted `.backup` argument — `~` doesn't expand there:

```bash
sqlite3 ~/Library/Application\ Support/netstacks/netstacks.db \
  ".backup $HOME/netstacks.db.backup"
```

The database uses `journal_mode=delete` (no `-wal` / `-shm` siblings to
worry about).

**Restore**

Stop the app, drop the backup back in place, restart, unlock the vault
with your master password.

**About the master password**

Vault entries (SSH passwords, API tokens, SNMP communities) are encrypted
inside the database with a key derived from your master password. The .db
file alone won't leak credentials — but you must remember the master
password to use the backup. If you lose it, the encrypted vault entries
are unrecoverable.

## Documentation

- Build from source: `docs/BUILD-LINUX.md`, `docs/BUILD-MACOS.md`, `docs/BUILD-WINDOWS.md`
- Auto-update: `docs/AUTO-UPDATE.md`
- Reporting security issues: `SECURITY.md`
- Asking for help: `SUPPORT.md`
- Contributing: `CONTRIBUTING.md`

## License

Apache License 2.0 — see [LICENSE](LICENSE).

`netstacks-credential-vault` (the credential vault crate, used by both this
agent and the closed Controller) is also Apache 2.0 and available at
<https://github.com/netstacks/netstacks-crypto>.
