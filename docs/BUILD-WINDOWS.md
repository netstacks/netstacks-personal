# Windows Build Guide

This guide covers building NetStacks for Windows, including code signing for trusted distribution.

## Prerequisites

- Windows 10 or 11 (x64)
- [Rust](https://rustup.rs/) with MSVC toolchain
- [Node.js](https://nodejs.org/) 18+
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with C++ workload

## Building

### Quick Build

From the `frontend` directory:

```powershell
npm run build:windows
```

This command:
1. Builds the netstacks-agent sidecar (Rust)
2. Stages the sidecar binary with correct naming
3. Builds the Tauri application with MSI and NSIS installers

### Manual Steps

If you need to run steps individually:

```powershell
# Build the Rust sidecar
cd agent
cargo build --release

# Stage the sidecar
cd ../frontend
npm run stage:sidecar

# Build Tauri app
npm run tauri:build
```

## Output

After a successful build, installers are located in:

```
frontend/src-tauri/target/release/bundle/
  msi/
    NetStacks_1.0.0_x64.msi         # MSI installer (enterprise deployment)
  nsis/
    NetStacks_1.0.0_x64-setup.exe   # NSIS installer (consumer distribution)
```

### MSI vs NSIS

- **MSI**: Best for enterprise deployment via Group Policy, SCCM, Intune
- **NSIS**: Best for consumer distribution, provides familiar install wizard

## Code Signing

Code signing is required for trusted distribution. Without signing:
- Windows SmartScreen will show "Unknown Publisher" warning
- Users must click "More info" > "Run anyway"
- Enterprise deployments may be blocked

### Certificate Types

| Type | Cost | SmartScreen | Notes |
|------|------|-------------|-------|
| EV Code Signing | ~$400/yr | Immediate trust | Hardware token required |
| OV Code Signing | ~$200/yr | Build reputation | Software-based |
| Self-Signed | Free | No trust | Testing only |

**Recommendation**: Start with OV certificate for initial releases, upgrade to EV once established.

### Setting Up Code Signing

1. **Purchase a certificate** from a trusted CA:
   - DigiCert, Sectigo, GlobalSign, etc.
   - EV certificates require identity verification and hardware token

2. **Install the certificate** in Windows Certificate Store:
   ```powershell
   # Import PFX file
   Import-PfxCertificate -FilePath "certificate.pfx" -CertStoreLocation "Cert:\CurrentUser\My"
   ```

3. **Get the certificate thumbprint**:
   ```powershell
   Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*Your Company*" }
   ```

4. **Configure Tauri** in `frontend/src-tauri/tauri.conf.json`:
   ```json
   {
     "bundle": {
       "windows": {
         "certificateThumbprint": "YOUR_THUMBPRINT_HERE",
         "digestAlgorithm": "sha256",
         "timestampUrl": "http://timestamp.digicert.com"
       }
     }
   }
   ```

### Using signtool Manually

If you need to sign binaries manually:

```powershell
# Sign with certificate from store
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a "NetStacks.exe"

# Sign with PFX file
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /f "certificate.pfx" /p "password" "NetStacks.exe"

# Verify signature
signtool verify /pa "NetStacks.exe"
```

### Timestamp Servers

Always use timestamping - it ensures signatures remain valid after certificate expiration:

- DigiCert: `http://timestamp.digicert.com`
- Sectigo: `http://timestamp.sectigo.com`
- GlobalSign: `http://timestamp.globalsign.com/tsa/r6advanced1`

## CI/CD Integration

### GitHub Actions

```yaml
name: Build Windows

on:
  push:
    tags: ['v*']

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup Rust
        uses: dtolnay/rust-action@stable

      - name: Install dependencies
        run: |
          cd frontend
          npm ci

      - name: Build application
        run: |
          cd frontend
          npm run build:windows
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}

      - name: Sign with Azure SignTool (optional)
        run: |
          # For EV certificates with Azure Key Vault
          AzureSignTool sign -kvu ${{ secrets.AZURE_KEY_VAULT_URI }} ^
            -kvi ${{ secrets.AZURE_CLIENT_ID }} ^
            -kvs ${{ secrets.AZURE_CLIENT_SECRET }} ^
            -kvc ${{ secrets.AZURE_CERT_NAME }} ^
            -tr http://timestamp.digicert.com ^
            -td sha256 ^
            "frontend/src-tauri/target/release/bundle/nsis/*.exe"

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: windows-installers
          path: |
            frontend/src-tauri/target/release/bundle/msi/*.msi
            frontend/src-tauri/target/release/bundle/nsis/*.exe
```

## SmartScreen Reputation

Windows SmartScreen checks application reputation:

1. **First Release**: Shows "Unknown Publisher" warning
2. **Build Reputation**: After ~2,000 downloads with no malware reports
3. **EV Certificate**: Immediately trusted, bypasses reputation check

Tips for building reputation:
- Distribute through reputable channels
- Submit to Windows Defender for analysis
- Use consistent signing certificate
- Avoid frequent certificate changes

## Troubleshooting

### "signtool not found"

Install Windows SDK or use Visual Studio Developer Command Prompt:
```powershell
# Add signtool to PATH
$env:PATH += ";C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64"
```

### Certificate not found

Ensure certificate is in correct store:
```powershell
# List certificates
certutil -store My
```

### Timestamp server timeout

Try alternate timestamp server or retry:
```powershell
signtool sign /tr http://timestamp.sectigo.com /td sha256 /fd sha256 /a "NetStacks.exe"
```

### MSI build fails

Ensure WiX Toolset is installed:
```powershell
# WiX is bundled with Tauri, but if issues occur:
winget install WiX.WiX3
```

## Testing Installation

After building, test the installer:

1. Run installer as non-admin user
2. Verify app installs to `%LOCALAPPDATA%\NetStacks`
3. Launch app from Start Menu
4. Verify sidecar starts (check Task Manager for `netstacks-agent.exe`)
5. Test SSH connection
6. Run uninstaller, verify clean removal

## Resources

- [Tauri Windows Bundling](https://v2.tauri.app/develop/bundling/)
- [Microsoft Code Signing](https://docs.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools)
- [WiX Toolset](https://wixtoolset.org/)
- [NSIS](https://nsis.sourceforge.io/)
