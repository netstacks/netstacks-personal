# NetStacks Terminal

The SSH terminal that thinks with you.

SSH, Telnet, and SFTP with an encrypted credential vault, network-aware AI, and topology visualization. Built for network engineers.

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

This repository publishes the frontend and agent source code for transparency and community review. You are welcome to read, study, and audit the code.

**Running NetStacks requires the official signed binaries from [netstacks.net/download](https://netstacks.net/download).** The source here is published for inspection, not for self-building.

See [LICENSE](LICENSE) for the full terms.

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
