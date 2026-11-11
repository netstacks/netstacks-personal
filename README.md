# NetStacks Terminal

The SSH terminal that thinks with you.

SSH, Telnet, and SFTP with an encrypted credential vault, network-aware AI, and topology visualization. Built for network engineers.

[![License](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://netstacks.net/download)
[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_%2B_Rust-orange.svg)](https://tauri.app)

[Download](https://netstacks.net/download) &nbsp;&bull;&nbsp; [Documentation](https://www.netstacks.net/docs) &nbsp;&bull;&nbsp; [Blog](https://netstacks.hashnode.dev)

---

## What you get

- SSH / Telnet / SFTP with host-key TOFU and an encrypted credential vault
- AI assistant with vendor-aware knowledge packs and an output sanitizer
- SNMP polling, neighbor discovery, topology visualization
- Integrations with NetBox, LibreNMS, and Netdisco
- Customizable highlighting, snippets, custom commands, jump hosts, tunnels, scripts

## Install

Download the signed installer for your platform from [netstacks.net/download](https://netstacks.net/download).

| Platform | Format |
|---|---|
| macOS | .dmg (signed & notarized) |
| Windows | .exe / .msi (code-signed) |
| Linux | AppImage / .deb |

## Source code

NetStacks Terminal (the desktop app and its local agent) is free software under the
[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You may use,
study, modify, and redistribute it under those terms.

This repository is published automatically from NetStacks' development repository:
every change lands here as it is made, and every release is tagged (`vX.Y.Z`) at
the exact source it was built from. Because it is a mirror, pull requests are not
merged here; bug reports and feature requests are welcome as
[issues](https://github.com/netstacks/netstacks-personal/issues).

## Build from source

Requirements: Rust 1.95+, Node.js 20+, and on Linux the WebKitGTK 4.1 development
packages (Debian/Ubuntu: `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev
libayatana-appindicator3-dev librsvg2-dev`).

```sh
# 1. The local agent, staged as the app's sidecar binary
cargo build --release --locked --manifest-path agent/Cargo.toml
TARGET=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p frontend/src-tauri/binaries
cp agent/target/release/netstacks-agent frontend/src-tauri/binaries/netstacks-agent-$TARGET

# 2. The app
cd frontend
npm ci
npm run tauri:build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Signed installers and auto-updates are only produced by the official release builds.
On Linux you can instead build a Flatpak with `./builds/build-flatpak.sh`
(needs `flatpak` and Flathub).

## Quickstart

1. Launch NetStacks. The local agent starts automatically.
2. Set a master password to unlock the credential vault.
3. Add a session (Settings → Profiles, or the Sessions sidebar).
4. Connect.

## Backup & restore

All persistent state lives in a single SQLite database.

| Platform | Database |
|---|---|
| macOS | `~/Library/Application Support/netstacks/netstacks.db` |
| Linux | `~/.local/share/netstacks/netstacks.db` |
| Windows | `%APPDATA%\netstacks\netstacks.db` |

Stop the app, copy the file, restart to restore. Vault credentials are encrypted — you need your master password to use any backup.

## Security

To report a security issue privately, see [SECURITY.md](SECURITY.md).

## Support

See [SUPPORT.md](SUPPORT.md) or visit [netstacks.net](https://netstacks.net).
