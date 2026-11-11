#!/bin/bash
# Build netstacks-agent sidecar for Linux
# This script compiles the Rust agent binary for Linux distributions
set -e

echo "Building netstacks-agent sidecar for Linux..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/../../agent"

cd "$AGENT_DIR"

# Build release binary
cargo build --release

echo "Sidecar build complete!"
echo "Binary: $AGENT_DIR/target/release/netstacks-agent"
