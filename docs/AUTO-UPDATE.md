# NetStacks Auto-Update System

This document describes the automatic update system for the NetStacks desktop application, built on Tauri's updater plugin.

## Overview

NetStacks uses Tauri's built-in updater plugin to provide seamless, secure automatic updates. The system:

1. Checks for updates on application startup (with a 3-second delay)
2. Notifies users when updates are available
3. Downloads and installs updates with progress feedback
4. Relaunches the application after successful installation

## Architecture

### Components

| Component | Purpose |
|-----------|---------|
| `tauri-plugin-updater` | Rust plugin for update checking and installation |
| `tauri-plugin-process` | Rust plugin for application relaunch |
| `UpdateChecker.tsx` | React component for update UI |
| Update Server | HTTP endpoint serving update manifests |

### Update Flow

```
App Launch
    |
    v
[3s delay] --> Check Update Endpoint
                    |
                    v
              +-----+-----+
              |           |
         No Update    Update Found
              |           |
              v           v
           (done)    Show Banner
                          |
                    User clicks "Install"
                          |
                          v
                    Download Update
                          |
                          v
                    Verify Signature
                          |
                          v
                    Install Update
                          |
                          v
                    Relaunch App
```

## Configuration

### Tauri Configuration

The updater is configured in `frontend/src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_HERE",
      "endpoints": [
        "https://releases.netstacks.net/{{target}}/{{arch}}/{{current_version}}"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

**Template Variables:**
- `{{target}}` - OS target (e.g., `darwin`, `linux`, `windows`)
- `{{arch}}` - Architecture (e.g., `x86_64`, `aarch64`)
- `{{current_version}}` - Current app version (e.g., `1.0.0`)

### Update Server Endpoint

The update server must respond with a JSON manifest:

```json
{
  "version": "1.1.0",
  "notes": "Bug fixes and performance improvements",
  "pub_date": "2024-01-15T12:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "url": "https://releases.netstacks.net/downloads/NetStacks_1.1.0_x64.app.tar.gz",
      "signature": "BASE64_SIGNATURE_HERE"
    },
    "darwin-aarch64": {
      "url": "https://releases.netstacks.net/downloads/NetStacks_1.1.0_aarch64.app.tar.gz",
      "signature": "BASE64_SIGNATURE_HERE"
    },
    "linux-x86_64": {
      "url": "https://releases.netstacks.net/downloads/NetStacks_1.1.0_amd64.AppImage",
      "signature": "BASE64_SIGNATURE_HERE"
    },
    "windows-x86_64": {
      "url": "https://releases.netstacks.net/downloads/NetStacks_1.1.0_x64-setup.nsis.zip",
      "signature": "BASE64_SIGNATURE_HERE"
    }
  }
}
```

If no update is available, return HTTP 204 No Content.

## Signing Updates

### Generate Keys

Run the key generation script once during initial setup:

```bash
cd frontend
./scripts/generate-updater-keys.sh
```

This creates:
- `~/.tauri/netstacks.key` - Private key (keep secure!)
- `~/.tauri/netstacks.key.pub` - Public key (add to tauri.conf.json)

### Sign Release Artifacts

When building a release:

```bash
# Sign the release artifact
tauri signer sign -k ~/.tauri/netstacks.key \
  target/release/bundle/macos/NetStacks.app.tar.gz

# Output is a .sig file with the base64 signature
```

### CI/CD Integration

Store the private key as a CI/CD secret:

1. Add `TAURI_SIGNING_PRIVATE_KEY` secret with the base64-encoded private key
2. Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is password-protected

Example GitHub Actions workflow:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}

- name: Build and sign release
  run: npm run tauri build
```

## Publishing Updates

### Workflow

1. **Bump Version**: Update version in `tauri.conf.json` and `package.json`
2. **Build Release**: Run platform builds (see platform-specific docs)
3. **Sign Artifacts**: Tauri signs automatically when `TAURI_SIGNING_PRIVATE_KEY` is set
4. **Upload Artifacts**: Upload to the netstacks.net release hosting (`https://releases.netstacks.net/...`)
5. **Update Manifest**: Update the version manifest served at `https://releases.netstacks.net/{target}/{arch}/{current_version}` so existing installs see the new release

### Self-Hosted Update Server

You can implement a simple static file server or dynamic endpoint:

**Static Files (recommended for small teams):**
```
/updates/
  darwin/
    x86_64/
      latest.json
    aarch64/
      latest.json
  linux/
    x86_64/
      latest.json
  windows/
    x86_64/
      latest.json
```


## User Experience

### Update Banner

When an update is available, a banner appears in the bottom-right corner:

- **Update Available**: Shows new version number
- **Install Now**: Downloads and installs the update
- **Later**: Dismisses banner until next app launch

### Progress Indication

During download:
- Progress bar shows download percentage
- Percentage text updates in real-time

### Error Handling

If update fails:
- Error message shown in banner
- User can retry or dismiss
- Errors logged to console for debugging

## Troubleshooting

### Update Check Fails

1. Verify network connectivity
2. Check endpoint URL is correct
3. Verify server returns proper JSON or 204
4. Check browser console for errors

### Signature Verification Fails

1. Ensure public key in `tauri.conf.json` matches signing key
2. Verify artifact wasn't modified after signing
3. Re-sign with correct private key

### Update Doesn't Apply (Windows)

1. Check user has write permissions to install directory
2. Try running as administrator
3. Check Windows Defender isn't blocking

### Update Doesn't Apply (macOS)

1. Check app is properly code-signed
2. Verify Gatekeeper allows the update
3. Check `/Applications` permissions

## Security Considerations

1. **Never commit private keys** to version control
2. **Use strong key passwords** in CI/CD
3. **Verify update server HTTPS** certificate
4. **Pin update server certificate** if possible
5. **Audit signing keys** periodically

## API Reference

### UpdateChecker Props

The `UpdateChecker` component requires no props and auto-initializes on mount.

### Tauri Commands (Internal)

- `plugin:updater|check` - Check for updates
- `plugin:updater|download_and_install` - Download and install update
- `plugin:process|restart` - Restart the application

## Related Documentation

- [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/)
- [BUILD-MACOS.md](./BUILD-MACOS.md)
- [BUILD-WINDOWS.md](./BUILD-WINDOWS.md)
- [BUILD-LINUX.md](./BUILD-LINUX.md)
