#!/bin/sh
# Flatpak entry point: prepares the sandbox, then starts the unmodified app.
set -eu

# The agent and shell use $HOME/.local/share while Tauri and the database use
# XDG_DATA_HOME. Flatpak points those at different places; align them.
export XDG_DATA_HOME="$HOME/.local/share"
data_dir="$XDG_DATA_HOME/com.netstacks.terminal"

# Per-app certificate trust: populated by pkexec-shim.sh, read by
# netstacks-trust-shim.c.
export NETSTACKS_TRUST_ANCHORS="$data_dir/trust/anchors"
mkdir -p "$NETSTACKS_TRUST_ANCHORS"

# agent.lock stores a PID, but each `flatpak run` has its own PID namespace, so
# a PID from another sandbox can name an unrelated process here, including the
# new agent itself. Allow one sandbox at a time (the fd stays open for the
# app's lifetime), which makes any existing agent.lock stale and safe to clear.
exec 9>"$data_dir/instance.lock"
if ! flock -n 9; then
    echo "NetStacks is already running." >&2
    exit 1
fi
rm -f "$data_dir/agent.lock"

export LD_PRELOAD=/app/lib/netstacks-trust-shim.so

exec /app/bin/NetStacks "$@"
