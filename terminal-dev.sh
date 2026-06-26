#!/bin/bash
set -e

# =============================================================================
# NetStacks Terminal Dev Script
# Builds sidecar agent and launches Tauri desktop app
#
# Usage: ./terminal-dev.sh [-e [URL]|-s] [--skip-sidecar] [--clean] [--sweep]
#   -e [URL]        Enterprise mode (default: https://localhost:3000)
#                   Optional URL overrides the controller address.
#                   Examples: -e https://192.168.50.77:3000
#                             -e (uses default localhost)
#   -s              Standalone (Personal Mode) — local agent, full features
#   --skip-sidecar  Skip Rust agent build (frontend-only changes)
#   --clean         Nuke local state before launching: SQLite DB, app config,
#                   webview localStorage/IndexedDB, and trusted Controller CA.
#                   Use when starting fresh or after format-breaking changes.
#   --sweep         Prune build artifacts to reclaim disk without losing
#                   incremental compilation. Removes release builds, cross-
#                   compile targets, dist output, and caches. Safe for dev.
#
# Default: enterprise mode (-e)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/agent"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
CONFIG_DIR="$HOME/Library/Application Support/com.netstacks.terminal"
CONFIG_FILE="$CONFIG_DIR/app-config.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Parse flags
SKIP_SIDECAR=false
CLEAN=false
SWEEP=false
MODE="enterprise"
CONTROLLER_URL="https://localhost:3000"
ARGS=("$@")
i=0
while [ $i -lt ${#ARGS[@]} ]; do
    arg="${ARGS[$i]}"
    case $arg in
        -e)
            MODE="enterprise"
            # Check if next arg is a URL (not a flag)
            next=$((i + 1))
            if [ $next -lt ${#ARGS[@]} ] && [[ "${ARGS[$next]}" == http* ]]; then
                CONTROLLER_URL="${ARGS[$next]}"
                i=$next
            fi
            ;;
        -s|-p) MODE="standalone" ;;
        --skip-sidecar) SKIP_SIDECAR=true ;;
        --clean) CLEAN=true ;;
        --sweep) SWEEP=true ;;
        --help|-h)
            echo "Usage: ./terminal-dev.sh [-e [URL]|-s] [--skip-sidecar] [--clean] [--sweep]"
            echo "  -e [URL]        Enterprise mode (default: https://localhost:3000)"
            echo "  -s              Standalone Personal Mode (local agent, full features)"
            echo "  --skip-sidecar  Skip Rust agent build"
            echo "  --clean         Nuke local state (DB, config, webview storage, CA cert)"
            echo "  --sweep         Prune build artifacts (release builds, caches, dist output)"
            echo ""
            echo "Examples:"
            echo "  ./terminal-dev.sh -e                              # localhost controller"
            echo "  ./terminal-dev.sh -e https://192.168.50.77:3000   # remote controller"
            echo "  ./terminal-dev.sh -s                              # standalone mode"
            echo "  ./terminal-dev.sh -s --clean                      # standalone, fresh start"
            echo "  ./terminal-dev.sh --sweep                         # reclaim disk then launch"
            exit 0
            ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
    i=$((i + 1))
done

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD} NetStacks Terminal Dev Environment${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Artifact size check ────────────────────────────────────────────────────
_dir_size_bytes() { du -sk "$1" 2>/dev/null | cut -f1 || echo 0; }
_format_size() {
    local kb=$1
    if [ "$kb" -ge 1048576 ]; then
        echo "$(echo "scale=1; $kb/1048576" | bc) GB"
    elif [ "$kb" -ge 1024 ]; then
        echo "$(echo "scale=0; $kb/1024" | bc) MB"
    else
        echo "${kb} KB"
    fi
}

AGENT_TARGET_KB=$(_dir_size_bytes "$AGENT_DIR/target")
TAURI_TARGET_KB=$(_dir_size_bytes "$FRONTEND_DIR/src-tauri/target")
NODE_MODULES_KB=$(_dir_size_bytes "$FRONTEND_DIR/node_modules")
TOTAL_KB=$((AGENT_TARGET_KB + TAURI_TARGET_KB + NODE_MODULES_KB))
THRESHOLD_KB=$((10 * 1048576))  # 10 GB

if $SWEEP; then
    BEFORE_KB=$TOTAL_KB
    echo -e "${CYAN}[sweep]${NC} Pruning build artifacts..."

    # Remove release builds (dev only needs debug)
    for dir in "$AGENT_DIR/target/release" "$FRONTEND_DIR/src-tauri/target/release"; do
        if [ -d "$dir" ]; then
            SIZE=$(_format_size "$(_dir_size_bytes "$dir")")
            rm -rf "$dir"
            echo -e "  Removed ${dir##*/netstacks-terminal/} (${SIZE})"
        fi
    done

    # Remove cross-compile target dirs (keep only native debug)
    NATIVE_TARGET=$(rustc -vV 2>/dev/null | grep host | cut -d' ' -f2)
    for dir in "$AGENT_DIR/target" "$FRONTEND_DIR/src-tauri/target"; do
        if [ -d "$dir" ]; then
            for triple_dir in "$dir"/*/; do
                triple=$(basename "$triple_dir")
                # Skip non-target dirs (build, debug, .cargo-lock, etc.)
                [[ "$triple" == *"-"* ]] || continue
                [ "$triple" = "$NATIVE_TARGET" ] && continue
                SIZE=$(_format_size "$(_dir_size_bytes "$triple_dir")")
                rm -rf "$triple_dir"
                echo -e "  Removed cross-compile target: ${triple} (${SIZE})"
            done
        fi
    done

    # Clear frontend caches and dist output
    for rel in frontend/dist frontend/dist-web frontend/node_modules/.cache; do
        if [ -d "$SCRIPT_DIR/$rel" ]; then
            SIZE=$(_format_size "$(_dir_size_bytes "$SCRIPT_DIR/$rel")")
            rm -rf "${SCRIPT_DIR:?}/$rel"
            echo -e "  Removed ${rel} (${SIZE})"
        fi
    done

    # Remove stale .db files from project dirs
    for dir in "$AGENT_DIR" "$FRONTEND_DIR"; do
        find "$dir" -maxdepth 1 -name "*.db" -o -name "*.db-shm" -o -name "*.db-wal" 2>/dev/null | while read -r f; do
            rm -f "$f"
            echo -e "  Removed stale DB: ${f##*/netstacks-terminal/}"
        done
    done

    # Report savings
    AFTER_AGENT=$(_dir_size_bytes "$AGENT_DIR/target")
    AFTER_TAURI=$(_dir_size_bytes "$FRONTEND_DIR/src-tauri/target")
    AFTER_NODE=$(_dir_size_bytes "$FRONTEND_DIR/node_modules")
    AFTER_KB=$((AFTER_AGENT + AFTER_TAURI + AFTER_NODE))
    RECLAIMED_KB=$((BEFORE_KB - AFTER_KB))
    echo -e "  ${GREEN}Reclaimed: $(_format_size $RECLAIMED_KB)${NC} ($(_format_size $BEFORE_KB) -> $(_format_size $AFTER_KB))"
    echo ""

elif [ "$TOTAL_KB" -ge "$THRESHOLD_KB" ]; then
    echo -e "${YELLOW}  Build artifacts: $(_format_size $TOTAL_KB)${NC}"
    echo -e "    agent/target:   $(_format_size $AGENT_TARGET_KB)"
    echo -e "    tauri/target:   $(_format_size $TAURI_TARGET_KB)"
    echo -e "    node_modules:   $(_format_size $NODE_MODULES_KB)"
    echo -e "  ${YELLOW}Tip: ./terminal-dev.sh --sweep to prune without losing incremental builds${NC}"
    echo -e "  ${YELLOW}     ./builds/clean.sh for a full reset (cold rebuild after)${NC}"
    echo ""
fi

# ── Step 1: Kill stray processes ─────────────────────────────────────────────
echo -e "${CYAN}[1/4]${NC} Killing stray processes..."

# Kill by port
for port in 5173 5174; do
    pids=$(lsof -ti:$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "  Killing processes on port $port"
        echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
done

# Kill by name
for pattern in "tauri dev" "netstacks-agent" "cargo-tauri"; do
    if pgrep -f "$pattern" > /dev/null 2>&1; then
        echo "  Killing: $pattern"
        pkill -f "$pattern" 2>/dev/null || true
    fi
done

sleep 1

# ── Step 1.5: Nuke local state (--clean) ────────────────────────────────────
if $CLEAN; then
    echo -e "${CYAN}[1.5]${NC} ${YELLOW}Nuking local state${NC} (--clean)..."

    # SQLite database — agent stores it under dirs::data_local_dir()/netstacks/
    # which on macOS is ~/Library/Application Support/netstacks/. We delete
    # only the *.db* files, NOT the parent directory (it may contain
    # unrelated data like Python venvs).
    DB_DIR="$HOME/Library/Application Support/netstacks"
    for f in netstacks.db netstacks.db-shm netstacks.db-wal netstacks.db-journal; do
        if [ -f "$DB_DIR/$f" ]; then
            rm -f "$DB_DIR/$f"
            echo "  Removed: $DB_DIR/$f"
        fi
    done

    # App config (regenerated in step 2 from the mode flag)
    if [ -f "$CONFIG_FILE" ]; then
        rm -f "$CONFIG_FILE"
        echo "  Removed: $CONFIG_FILE"
    fi

    # Controller CA fingerprint cache (forces re-trust on next enterprise launch)
    FINGERPRINT_CACHE="$CONFIG_DIR/.ca-fingerprint"
    if [ -f "$FINGERPRINT_CACHE" ]; then
        rm -f "$FINGERPRINT_CACHE"
        echo "  Removed: $FINGERPRINT_CACHE"
    fi

    # Frontend webview state — localStorage, IndexedDB, cookies, cache
    WEBKIT_DIR="$HOME/Library/WebKit/com.netstacks.terminal/WebsiteData"
    if [ -d "$WEBKIT_DIR" ]; then
        rm -rf "$WEBKIT_DIR"
        echo "  Removed: $WEBKIT_DIR (frontend localStorage/IndexedDB)"
    fi

    # Trusted Controller CA in macOS keychain (re-installed on next enterprise launch)
    if security find-certificate -c "NetStacks Controller CA" ~/Library/Keychains/login.keychain-db > /dev/null 2>&1; then
        security delete-certificate -c "NetStacks Controller CA" ~/Library/Keychains/login.keychain-db 2>/dev/null \
            && echo "  Removed: NetStacks Controller CA from login keychain"
    fi

    echo -e "  ${GREEN}Local state cleared${NC}"
fi

# ── Step 2: Set app mode ────────────────────────────────────────────────────
echo -e "${CYAN}[2/4]${NC} Setting mode: ${BOLD}${MODE}${NC}"

mkdir -p "$CONFIG_DIR"

if [ "$MODE" = "enterprise" ]; then
    cat > "$CONFIG_FILE" << EOF
{
  "controllerUrl": "${CONTROLLER_URL}"
}
EOF
    echo "  Config: controllerUrl = ${CONTROLLER_URL}"
else
    cat > "$CONFIG_FILE" << 'EOF'
{
  "controllerUrl": null
}
EOF
    echo "  Config: controllerUrl = null (local agent)"
fi

# ── Step 2.5: TLS CA trust (enterprise only) ──────────────────────────────
if [ "$MODE" = "enterprise" ]; then
    echo -e "${CYAN}[2.5]${NC} Checking TLS trust for ${CONTROLLER_URL}..."

    # Use system curl (reads macOS keychain) — Homebrew curl uses OpenSSL and won't
    SYSCURL=/usr/bin/curl

    # Test if TLS is already trusted
    if $SYSCURL -s --connect-timeout 3 "${CONTROLLER_URL}/health" > /dev/null 2>&1; then
        echo -e "  ${GREEN}TLS already trusted${NC}"
    else
        # Fetch the CA cert (skip verification for bootstrap)
        CA_TMP="/tmp/netstacks-ca-bootstrap.pem"
        FINGERPRINT_CACHE="$CONFIG_DIR/.ca-fingerprint"

        if $SYSCURL -sk --connect-timeout 5 "${CONTROLLER_URL}/api/tls/ca-certificate" -o "$CA_TMP" 2>/dev/null && [ -s "$CA_TMP" ] && grep -q "BEGIN CERTIFICATE" "$CA_TMP"; then
            FINGERPRINT=$(openssl x509 -in "$CA_TMP" -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//')

            # Check if this CA is already installed (fingerprint matches previous)
            if [ -f "$FINGERPRINT_CACHE" ] && [ "$(cat "$FINGERPRINT_CACHE")" = "$FINGERPRINT" ]; then
                echo -e "  ${GREEN}CA cert already installed${NC} (${DIM}${FINGERPRINT:0:20}...${NC})"
            else
                echo -e "  CA fingerprint: ${YELLOW}${FINGERPRINT}${NC}"

                # Remove old NetStacks CA cert if present, then install new one
                security delete-certificate -c "NetStacks Controller CA" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
                if security add-trusted-cert -d -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db "$CA_TMP" 2>/dev/null; then
                    echo -e "  ${GREEN}CA certificate installed to macOS keychain${NC}"
                    echo "$FINGERPRINT" > "$FINGERPRINT_CACHE"
                else
                    echo -e "  ${YELLOW}Could not auto-install CA cert (may need password prompt)${NC}"
                fi
            fi
            rm -f "$CA_TMP"
        else
            echo -e "  ${YELLOW}Controller not reachable at ${CONTROLLER_URL} — skipping TLS setup${NC}"
            echo -e "  ${DIM}Start the controller first, or the Terminal will show TLS errors${NC}"
            rm -f "$CA_TMP"
        fi
    fi
fi

# ── Step 3: Build sidecar ───────────────────────────────────────────────────
if $SKIP_SIDECAR; then
    echo -e "${CYAN}[3/4]${NC} Skipping sidecar build (--skip-sidecar)"
else
    echo -e "${CYAN}[3/4]${NC} Building sidecar..."
    cd "$AGENT_DIR"
    cargo build

    # Detect architecture using Rust's target (not uname, which lies under Rosetta)
    TARGET_TRIPLE=$(rustc -vV | grep host | cut -d' ' -f2)
    if [[ -z "$TARGET_TRIPLE" ]]; then
        echo -e "${RED}Failed to detect Rust target triple${NC}"
        exit 1
    fi

    # Copy binary to Tauri binaries directory
    BINARIES_DIR="$FRONTEND_DIR/src-tauri/binaries"
    mkdir -p "$BINARIES_DIR"
    cp "target/debug/netstacks-agent" "$BINARIES_DIR/netstacks-agent-$TARGET_TRIPLE"
    echo -e "  ${GREEN}Sidecar ready${NC} ($TARGET_TRIPLE)"

    # Check if the Linux remote agent binary matches the current version.
    # Docker cross-compile is too slow for dev, but warn loudly if stale.
    REMOTE_AGENT_VERSION_FILE="$FRONTEND_DIR/src-tauri/resources/remote-agents/version.txt"
    CURRENT_VERSION=$(grep '"version"' "$FRONTEND_DIR/src-tauri/tauri.conf.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
    REMOTE_AGENT_VERSION=$(cat "$REMOTE_AGENT_VERSION_FILE" 2>/dev/null || echo "MISSING")
    if [ "$REMOTE_AGENT_VERSION" != "$CURRENT_VERSION" ]; then
        echo ""
        echo -e "  ${YELLOW}WARNING: Linux remote agent binary is stale!${NC}"
        echo -e "  ${YELLOW}  Local agent: ${CURRENT_VERSION}  Remote binary: ${REMOTE_AGENT_VERSION}${NC}"
        echo -e "  ${YELLOW}  Run: ./builds/build-remote-agent.sh${NC}"
        echo ""
    fi
fi

# ── Step 4: Launch Tauri ─────────────────────────────────────────────────────
echo -e "${CYAN}[4/4]${NC} Starting Tauri..."
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD} Terminal Launching${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
if [ "$MODE" = "enterprise" ]; then
    echo -e "  ${BOLD}Mode:${NC}        ${CYAN}enterprise${NC}"
    echo -e "  ${BOLD}Controller:${NC}  ${CONTROLLER_URL}"
    echo -e "  ${BOLD}Plugins:${NC}     Enable via controller (./controller-dev.sh --with-plugins)"
else
    echo -e "  ${BOLD}Mode:${NC}        ${GREEN}standalone${NC} (Personal Mode)"
    echo -e "  ${BOLD}Agent:${NC}       localhost (ephemeral port — check sidecar output)"
fi
echo ""
echo -e "  ${CYAN}Press Ctrl+C to stop${NC}"
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd "$FRONTEND_DIR"
npm run tauri:dev
