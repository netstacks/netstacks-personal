#!/bin/bash
# NetStacks Update Signing Key Generator
#
# This script generates a public/private key pair for signing Tauri updates.
# Run this ONCE during initial setup. Store the private key SECURELY.
#
# Usage:
#   ./scripts/generate-updater-keys.sh
#
# Output:
#   - ~/.tauri/netstacks.key (private key - KEEP SECRET)
#   - ~/.tauri/netstacks.key.pub (public key - add to tauri.conf.json)

set -e

echo "=== NetStacks Update Signing Key Generator ==="
echo ""
echo "This will generate a key pair for signing app updates."
echo "The private key will be saved to: ~/.tauri/netstacks.key"
echo ""

# Create .tauri directory if it doesn't exist
mkdir -p ~/.tauri

# Check if keys already exist
if [ -f ~/.tauri/netstacks.key ]; then
    echo "WARNING: Key file already exists at ~/.tauri/netstacks.key"
    read -p "Overwrite? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# Generate the key pair using Tauri CLI
echo "Generating key pair..."
npx tauri signer generate -w ~/.tauri/netstacks.key

echo ""
echo "=== Keys Generated Successfully ==="
echo ""
echo "Private key: ~/.tauri/netstacks.key"
echo "  -> Keep this SECURE. Add to CI/CD secrets as TAURI_SIGNING_PRIVATE_KEY"
echo ""
echo "Public key:"
cat ~/.tauri/netstacks.key.pub
echo ""
echo ""
echo "Next steps:"
echo "1. Copy the public key above"
echo "2. Replace UPDATER_PUBKEY_PLACEHOLDER in frontend/src-tauri/tauri.conf.json"
echo "3. Add private key to your CI/CD secrets"
echo ""
