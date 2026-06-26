#!/bin/bash
# Build netstacks-agent sidecar for Tauri bundling
# This script builds the Rust agent and copies it to the Tauri binaries directory

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_DIR="$FRONTEND_DIR/../agent"
BINARIES_DIR="$FRONTEND_DIR/src-tauri/binaries"

echo "Building netstacks-agent sidecar..."

cd "$AGENT_DIR"

# Detect platform and architecture
OS=$(uname -s)
ARCH=$(uname -m)

# Determine Tauri target triple
if [[ "$OS" == "Darwin" ]]; then
    if [[ "$ARCH" == "arm64" ]]; then
        TARGET_TRIPLE="aarch64-apple-darwin"
    else
        TARGET_TRIPLE="x86_64-apple-darwin"
    fi
elif [[ "$OS" == "Linux" ]]; then
    TARGET_TRIPLE="x86_64-unknown-linux-gnu"
elif [[ "$OS" == "MINGW"* || "$OS" == "CYGWIN"* ]]; then
    TARGET_TRIPLE="x86_64-pc-windows-msvc"
else
    echo "Unsupported OS: $OS"
    exit 1
fi

echo "Building for target: $TARGET_TRIPLE"

# Build release binary
cargo build --release

# Create binaries directory
mkdir -p "$BINARIES_DIR"

# Copy binary with Tauri naming convention (name-target)
# Tauri expects: binaries/netstacks-agent-<target-triple>[.exe]
if [[ "$OS" == "MINGW"* || "$OS" == "CYGWIN"* ]]; then
    cp target/release/netstacks-agent.exe "$BINARIES_DIR/netstacks-agent-$TARGET_TRIPLE.exe"
else
    cp target/release/netstacks-agent "$BINARIES_DIR/netstacks-agent-$TARGET_TRIPLE"
fi

echo "Sidecar binary: $BINARIES_DIR/netstacks-agent-$TARGET_TRIPLE"

# Optional: Build universal binary on macOS ARM
if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" && "$BUILD_UNIVERSAL" == "1" ]]; then
    echo "Building x86_64 target for universal binary..."
    cargo build --release --target x86_64-apple-darwin

    echo "Creating universal binary..."
    lipo -create \
        target/release/netstacks-agent \
        target/x86_64-apple-darwin/release/netstacks-agent \
        -output "$BINARIES_DIR/netstacks-agent-universal-apple-darwin"

    echo "Universal binary: $BINARIES_DIR/netstacks-agent-universal-apple-darwin"
fi

echo "Sidecar build complete!"
