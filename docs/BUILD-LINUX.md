# Building NetStacks for Linux

This guide covers building NetStacks for Linux distributions, including AppImage, .deb, and .rpm packages.

## Prerequisites

### System Requirements

- Linux x86_64 (amd64) system
- Node.js 18+ and npm
- Rust 1.70+ with Cargo
- Build essentials (gcc, make, etc.)

### Distribution-Specific Dependencies

#### Ubuntu/Debian

```bash
sudo apt update
sudo apt install -y \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    librsvg2-dev \
    libayatana-appindicator3-dev \
    patchelf
```

#### Fedora/RHEL

```bash
sudo dnf install -y \
    @development-tools \
    openssl-devel \
    gtk3-devel \
    webkit2gtk4.1-devel \
    librsvg2-devel \
    libappindicator-gtk3-devel \
    patchelf \
    rpm-build  # Required for .rpm packages
```

#### Arch Linux

```bash
sudo pacman -S --needed \
    base-devel \
    openssl \
    gtk3 \
    webkit2gtk-4.1 \
    librsvg \
    libappindicator-gtk3 \
    patchelf
```

### Installing Rust

If Rust is not installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

## Building

### Quick Build (All Package Types)

```bash
cd frontend
npm install
npm run build:linux
```

This will produce:
- AppImage in `src-tauri/target/release/bundle/appimage/`
- .deb in `src-tauri/target/release/bundle/deb/`
- .rpm in `src-tauri/target/release/bundle/rpm/` (if rpmbuild is available)

### Build Specific Package Types

#### AppImage Only

```bash
npm run build:linux:appimage
```

AppImage is the most portable format - it runs on most Linux distributions without installation.

#### Debian Package Only

```bash
npm run build:linux:deb
```

Best for Ubuntu, Debian, Linux Mint, and derivatives.

#### RPM Package Only

```bash
npm run build:linux:rpm
```

Requires `rpmbuild` to be installed. Best for Fedora, RHEL, CentOS, openSUSE.

## Installation

### AppImage

```bash
chmod +x NetStacks_*_amd64.AppImage
./NetStacks_*_amd64.AppImage
```

Or move to a system location:

```bash
sudo mv NetStacks_*_amd64.AppImage /opt/netstacks/
sudo ln -s /opt/netstacks/NetStacks_*_amd64.AppImage /usr/local/bin/netstacks
```

### Debian Package

```bash
sudo dpkg -i netstacks_*_amd64.deb
# If there are dependency errors:
sudo apt install -f
```

Or with apt:

```bash
sudo apt install ./netstacks_*_amd64.deb
```

### RPM Package

```bash
sudo rpm -i netstacks-*.rpm
# Or with dnf:
sudo dnf install ./netstacks-*.rpm
```

## Verification

After installation, verify the app works:

1. **Launch Application**
   - From command line: `netstacks`
   - From application menu: Search for "NetStacks" in your desktop environment

2. **Check Desktop Integration**
   - Look for NetStacks in the Network category of your application menu
   - Icon should appear correctly

3. **Test SSH Connection**
   - Create a new session
   - Connect to an SSH host
   - Verify terminal works correctly

4. **Verify Sidecar**
   - Check that AI features work
   - The agent process should start automatically

## Troubleshooting

### WebKit Errors

If you see WebKit-related errors:

```bash
# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-0

# Fedora
sudo dnf install webkit2gtk4.1
```

### AppImage Won't Run

```bash
# Make it executable
chmod +x NetStacks_*.AppImage

# If FUSE is missing:
sudo apt install libfuse2  # Ubuntu/Debian
sudo dnf install fuse-libs  # Fedora
```

### Missing Dependencies on .deb Install

```bash
sudo apt install -f
# Or manually install missing packages:
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0
```

### Desktop Entry Not Appearing

After installing via .deb or .rpm, you may need to refresh the desktop database:

```bash
update-desktop-database ~/.local/share/applications/
```

### Sidecar Not Starting

Check if the agent binary exists and is executable:

```bash
# For installed packages
ls -la /usr/lib/netstacks/binaries/
# For AppImage (extracted)
./NetStacks_*.AppImage --appimage-extract
ls -la squashfs-root/usr/lib/netstacks/binaries/
```

## Build Output Locations

After running `npm run build:linux`:

```
frontend/src-tauri/target/release/bundle/
├── appimage/
│   └── NetStacks_1.0.0_amd64.AppImage
├── deb/
│   └── netstacks_1.0.0_amd64.deb
└── rpm/
    └── netstacks-1.0.0-1.x86_64.rpm
```

## Cross-Distribution Testing

For comprehensive testing, verify on:

| Distribution    | Package Type | Notes                          |
|-----------------|--------------|--------------------------------|
| Ubuntu 22.04+   | .deb         | Primary target                 |
| Ubuntu 22.04+   | AppImage     | Alternative portable option    |
| Debian 12+      | .deb         | Should work identically        |
| Fedora 38+      | .rpm         | Primary RPM target             |
| Fedora 38+      | AppImage     | Alternative portable option    |
| Arch Linux      | AppImage     | Most reliable option           |
| Linux Mint 21+  | .deb         | Ubuntu-based, should work      |

## Notes

- The AppImage format is recommended for maximum compatibility
- .deb packages have better desktop integration on Debian-based systems
- .rpm packages integrate well with Fedora/RHEL package management
- All package types include the netstacks-agent sidecar binary
