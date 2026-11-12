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
APP_ID="net.netstacks.Terminal"
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

echo "[1/4] Ensuring SDK and builder are installed..."
flatpak install --user -y --noninteractive flathub \
    org.flatpak.Builder \
    org.gnome.Sdk//51 \
    org.gnome.Platform//51 \
    org.freedesktop.Sdk.Extension.rust-stable//26.08 \
    org.freedesktop.Sdk.Extension.node22//26.08

# The build is offline: regenerate the source lists when an input is newer than
# them (always in a private checkout, never in a fresh public clone that has them).
echo "[2/4] Offline source lists..."
GEN="$SCRIPT_DIR/flatpak/generated"
STALE=false
for out in cargo-sources.json node-sources.json "$APP_ID.metainfo.xml"; do
    [ -f "$GEN/$out" ] || STALE=true
done
for src in agent/Cargo.lock frontend/src-tauri/Cargo.lock frontend/package-lock.json \
          frontend/src-tauri/tauri.conf.json CHANGELOG.md "builds/flatpak/$APP_ID.metainfo.xml"; do
    for out in cargo-sources.json node-sources.json "$APP_ID.metainfo.xml"; do
        [ "$PROJECT_ROOT/$src" -nt "$GEN/$out" ] && STALE=true
    done
done
if $STALE; then
    "$SCRIPT_DIR/flatpak-sources.sh" "$PROJECT_ROOT"
else
    echo "  up to date"
fi

echo "[3/4] Building (first build takes a while)..."
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"
cd "$PROJECT_ROOT"
flatpak run org.flatpak.Builder --user --force-clean \
    --state-dir="$WORK_DIR/state" \
    --repo="$WORK_DIR/repo" \
    "$WORK_DIR/build" \
    "$MANIFEST"

echo "[4/4] Creating bundle..."
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
