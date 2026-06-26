# Building NetStacks for macOS

This guide covers building NetStacks as a signed macOS application bundle (.app) and DMG installer for distribution.

## Prerequisites

- macOS 10.15 (Catalina) or later
- Xcode Command Line Tools: `xcode-select --install`
- Rust toolchain: `rustup default stable`
- Node.js 18+ and npm
- For code signing: Apple Developer account

## Quick Build (Unsigned Development)

Build an unsigned app for local development:

```bash
cd frontend
npm install
npm run build:macos
```

Output:
- `.app` bundle: `src-tauri/target/release/bundle/macos/NetStacks.app`
- `.dmg` installer: `src-tauri/target/release/bundle/dmg/NetStacks_1.0.0_aarch64.dmg`

## Universal Binary (ARM + Intel)

Build a universal binary for distribution to both Apple Silicon and Intel Macs:

```bash
# Install x86_64 target (required on ARM Macs)
rustup target add x86_64-apple-darwin

# Build universal binary
cd frontend
BUILD_UNIVERSAL=1 npm run build:macos:universal
```

## Code Signing for Distribution

### 1. Apple Developer Account Setup

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/)
2. Create a "Developer ID Application" certificate in Xcode:
   - Xcode > Settings > Accounts > Manage Certificates
   - Click + and select "Developer ID Application"

### 2. Find Your Signing Identity

```bash
security find-identity -v -p codesigning
```

Look for a certificate like:
```
"Developer ID Application: Your Name (TEAMID)"
```

### 3. Configure Signing

Set environment variable before building:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
npm run build:macos
```

Or update `frontend/src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAMID)"
    }
  }
}
```

### 4. Build Signed App

```bash
cd frontend
npm run build:macos
```

Verify signing:

```bash
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/NetStacks.app
codesign -dv --verbose=4 src-tauri/target/release/bundle/macos/NetStacks.app
```

## Notarization for Gatekeeper

macOS Gatekeeper requires notarization for apps distributed outside the App Store.

### 1. Create App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Security > App-Specific Passwords > Generate Password
3. Save the password securely

### 2. Store Credentials in Keychain

```bash
xcrun notarytool store-credentials "AC_PASSWORD" \
    --apple-id "your@email.com" \
    --team-id "YOURTEAMID" \
    --password "xxxx-xxxx-xxxx-xxxx"
```

### 3. Submit for Notarization

```bash
# Notarize the DMG
xcrun notarytool submit \
    src-tauri/target/release/bundle/dmg/NetStacks_1.0.0_aarch64.dmg \
    --keychain-profile "AC_PASSWORD" \
    --wait

# Check status (if needed)
xcrun notarytool log <submission-id> --keychain-profile "AC_PASSWORD"
```

### 4. Staple the Ticket

After successful notarization, staple the ticket to the DMG:

```bash
xcrun stapler staple src-tauri/target/release/bundle/dmg/NetStacks_1.0.0_aarch64.dmg
```

### 5. Verify Notarization

```bash
spctl --assess --type execute --verbose src-tauri/target/release/bundle/macos/NetStacks.app
```

Expected output: `NetStacks.app: accepted`

## Entitlements

The app uses custom entitlements (`frontend/src-tauri/entitlements.plist`) to enable:

| Entitlement | Purpose |
|-------------|---------|
| `com.apple.security.app-sandbox` = false | Disable sandbox for full terminal access |
| `com.apple.security.network.client` | SSH connections to remote hosts |
| `com.apple.security.network.server` | Local WebSocket API for frontend |
| `com.apple.security.files.user-selected.read-write` | Access SSH keys and configs |
| `com.apple.security.inherit` | Allow sidecar agent to inherit entitlements |

**Note:** Sandbox is disabled because SSH terminal applications require direct network and file system access that sandboxing restricts.

## Troubleshooting

### "App is damaged and can't be opened"

Clear quarantine attribute:
```bash
xattr -cr /Applications/NetStacks.app
```

### Gatekeeper blocks unsigned app

Allow in System Settings > Privacy & Security, or run:
```bash
sudo spctl --master-disable  # Temporarily disable (not recommended)
```

### Code signing fails

1. Verify certificate is valid: `security find-identity -v -p codesigning`
2. Check Keychain Access for certificate issues
3. Ensure Xcode license is accepted: `sudo xcodebuild -license accept`

### Notarization fails

1. Check for hardened runtime issues:
   ```bash
   codesign --verify --deep --strict --verbose=2 NetStacks.app
   ```
2. Review notarization log for specific errors:
   ```bash
   xcrun notarytool log <submission-id> --keychain-profile "AC_PASSWORD"
   ```

## CI/CD Integration

For automated builds, set these environment variables:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)"
export APPLE_ID="your@email.com"
export APPLE_TEAM_ID="YOURTEAMID"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # App-specific password
```

See `.github/workflows/release.yml` for GitHub Actions integration.

## Output Files

After a successful build:

| File | Location |
|------|----------|
| App Bundle | `frontend/src-tauri/target/release/bundle/macos/NetStacks.app` |
| DMG Installer | `frontend/src-tauri/target/release/bundle/dmg/NetStacks_*.dmg` |

## Related Documentation

- [Tauri macOS Bundling](https://v2.tauri.app/distribute/macos/)
- [Apple Code Signing Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Notarization Documentation](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
