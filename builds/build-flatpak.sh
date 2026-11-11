#!/usr/bin/env bash
# NetStacks Flatpak Build Script (standalone / Personal Mode)
# Builds a single-file .flatpak bundle using the Flathub GNOME SDK.
#
# Usage:
#   ./builds/build-flatpak.sh            # Build the bundle
#   ./builds/build-flatpak.sh --install  # Build, then install for this user

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_ID="com.netstacks.terminal"
MANIFEST="$SCRIPT_DIR/flatpak/$APP_ID.yml"
WORK_DIR="$SCRIPT_DIR/output/flatpak"
OUTPUT_DIR="$SCRIPT_DIR/output/linux"

VERSION=$(grep '"version"' "$PROJECT_ROOT/frontend/src-tauri/tauri.conf.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
ARCH=$(uname -m)
BUNDLE="$OUTPUT_DIR/NetStacks_${VERSION}_${ARCH}.flatpak"

DO_INSTALL=false
for arg in "$@"; do
    case $arg in
        --install) DO_INSTALL=true ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

command -v flatpak >/dev/null || { echo "ERROR: flatpak not found."; exit 1; }

echo "=== NetStacks Flatpak Build ==="
echo "  Version: $VERSION"
echo "  Arch:    $ARCH"
echo ""

echo "[1/3] Ensuring SDK and builder are installed..."
flatpak install --user -y --noninteractive flathub \
    org.flatpak.Builder \
    org.gnome.Sdk//49 \
    org.gnome.Platform//49 \
    org.freedesktop.Sdk.Extension.rust-stable//25.08 \
    org.freedesktop.Sdk.Extension.node22//25.08

echo "[2/3] Building (first build takes a while)..."
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"
cd "$PROJECT_ROOT"
flatpak run org.flatpak.Builder --user --force-clean \
    --state-dir="$WORK_DIR/state" \
    --repo="$WORK_DIR/repo" \
    "$WORK_DIR/build" \
    "$MANIFEST"

echo "[3/3] Creating bundle..."
flatpak build-bundle \
    --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo \
    "$WORK_DIR/repo" "$BUNDLE" "$APP_ID"

echo ""
echo "=== Build Complete ==="
echo "  Bundle: $BUNDLE ($(du -sh "$BUNDLE" | cut -f1))"

if $DO_INSTALL; then
    flatpak install --user -y --noninteractive --reinstall "$BUNDLE"
    echo "  Installed. Run: flatpak run $APP_ID"
fi
