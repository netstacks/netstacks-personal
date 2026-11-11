#!/bin/sh
# Set as $SHELL for the agent so local terminal tabs get the user's real shell
# and tools on the host instead of the bare sandbox.
#
# The agent clears the environment before spawning a local PTY, so the session
# bus address has to be restored for flatpak-spawn.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"

# flatpak-spawn runs commands in the current directory, which must exist on the
# host, so this has to happen before the first host command.
case "$PWD" in
    "$HOME" | "$HOME"/*) ;;
    *) cd "$HOME" || exit 1 ;;
esac

host_shell=$(/usr/bin/flatpak-spawn --host getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
[ -n "$host_shell" ] || host_shell=/bin/sh

exec /app/bin/netstacks-no-ctty /usr/bin/flatpak-spawn --host --watch-bus \
    --env=TERM="${TERM:-xterm-256color}" \
    --env=SHELL="$host_shell" \
    "$host_shell" "$@"
