#!/bin/sh
# Stands in for pkexec inside the sandbox, where neither polkit nor the system
# CA directory exist. On Linux the app runs exactly:
#
#   pkexec sh -c "cp '<pem>' /usr/local/share/ca-certificates/netstacks-<x>.crt \
#                 && update-ca-certificates"
#
# That one command is honoured by copying the certificate into the per-app
# anchors directory set up by netstacks-launcher.sh. Anything else is refused.
set -eu

refuse() {
    echo "pkexec is not available in the NetStacks Flatpak sandbox" >&2
    exit 126
}

[ "$#" -eq 3 ] && [ "$1" = sh ] && [ "$2" = -c ] || refuse
script=$3

prefix="' /usr/local/share/ca-certificates/netstacks-"
suffix=".crt && update-ca-certificates"
case "$script" in
    "cp '"*"$prefix"*"$suffix") ;;
    *) refuse ;;
esac

src=${script#"cp '"}
src=${src%%"$prefix"*}
name=${script##*"$prefix"}
name=${name%"$suffix"}

case "$src" in */netstacks-cacert/install.pem) ;; *) refuse ;; esac
case "$name" in *[!a-z-]* | "") refuse ;; esac
grep -q -- '-----BEGIN CERTIFICATE-----' "$src" || refuse

install -m 644 "$src" "$NETSTACKS_TRUST_ANCHORS/netstacks-$name.crt"
