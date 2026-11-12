#!/usr/bin/env bash
# Generate the Flatpak's offline source lists from the lockfiles.
#
#   builds/flatpak-sources.sh <tree> [<out-dir>]
#
# Flathub builds without network access, so every crate and npm package is
# listed as a source with its checksum. This writes, into <out-dir> (default
# <tree>/builds/flatpak/generated):
#
#   cargo-sources.json   both Cargo.lock files (agent, Tauri shell), merged,
#                        because the cargo generator writes one cargo/config
#   node-sources.json    frontend/package-lock.json
#   net.netstacks.Terminal.metainfo.xml
#                        the metainfo with its <releases> filled in from
#                        tauri.conf.json and CHANGELOG.md
#
# The lists are generated, never edited and never committed in the private
# repository: CI writes them into the public export (public-sync.yml), and
# build-flatpak.sh writes them for local builds.
#
# Needs git and python3 with aiohttp, pyyaml and tomlkit. The generators are
# Flathub's own (flatpak-builder-tools), pinned below and verified by commit.
set -euo pipefail

TOOLS_REPO=https://github.com/flatpak/flatpak-builder-tools.git
TOOLS_COMMIT=9d86d336a39b9af38b86f114b6ce5820fe260f91

TREE="$(cd "${1:?Usage: $0 <tree> [<out-dir>]}" && pwd)"
OUT="${2:-$TREE/builds/flatpak/generated}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

python3 -c 'import aiohttp, yaml, tomlkit' 2>/dev/null || {
    echo "ERROR: python3 with aiohttp, pyyaml and tomlkit is required."
    echo "  pip install aiohttp pyyaml tomlkit"
    echo "  or on Nix: nix shell --impure --expr '(builtins.getFlake \"nixpkgs\").legacyPackages.\${builtins.currentSystem}.python3.withPackages (p: [ p.aiohttp p.pyyaml p.tomlkit ])'"
    exit 1
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A cache keyed by commit, so repeated local builds do not clone again.
TOOLS="${XDG_CACHE_HOME:-$HOME/.cache}/netstacks/flatpak-builder-tools-$TOOLS_COMMIT"
if [ ! -d "$TOOLS/.git" ]; then
    rm -rf "$TOOLS"
    git init -q "$TOOLS"
    git -C "$TOOLS" fetch -q --depth 1 "$TOOLS_REPO" "$TOOLS_COMMIT"
    git -C "$TOOLS" checkout -q FETCH_HEAD
fi
[ "$(git -C "$TOOLS" rev-parse HEAD)" = "$TOOLS_COMMIT" ] || {
    echo "ERROR: $TOOLS is not at $TOOLS_COMMIT; delete it and run again."
    exit 1
}

echo "[1/3] Cargo sources (agent + Tauri shell)..."
python3 - "$TREE/agent/Cargo.lock" "$TREE/frontend/src-tauri/Cargo.lock" "$WORK/Cargo.lock" <<'PY'
import sys, tomlkit
seen, packages = set(), []
for path in sys.argv[1:3]:
    lock = tomlkit.parse(open(path).read())
    for p in lock["package"]:
        key = (str(p["name"]), str(p["version"]), str(p.get("source", "")))
        if key not in seen:
            seen.add(key)
            packages.append(p)
out = tomlkit.document()
out["version"] = 4
out["package"] = tomlkit.aot()
for p in packages:
    out["package"].append(p)
open(sys.argv[3], "w").write(tomlkit.dumps(out))
PY
python3 "$TOOLS/cargo/flatpak-cargo-generator.py" "$WORK/Cargo.lock" -o "$OUT/cargo-sources.json"

echo "[2/3] npm sources (frontend)..."
( cd "$TREE/frontend" && PYTHONPATH="$TOOLS/node" python3 -m flatpak_node_generator \
    --no-requests-cache npm package-lock.json -o "$OUT/node-sources.json" )

echo "[3/3] AppStream releases..."
# The metainfo with a <release> for each "## [X.Y.Z] - YYYY-MM-DD" in CHANGELOG.md,
# newest first, plus the current version if the CHANGELOG has no section for it yet.
python3 - "$TREE" "$OUT/net.netstacks.Terminal.metainfo.xml" <<'PY'
import datetime, json, re, sys
tree, out = sys.argv[1], sys.argv[2]
version = json.load(open(f"{tree}/frontend/src-tauri/tauri.conf.json"))["version"]
releases = re.findall(r"^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})", open(f"{tree}/CHANGELOG.md").read(), re.M)
if version not in [v for v, _ in releases]:
    releases.insert(0, (version, datetime.date.today().isoformat()))
url = "https://github.com/netstacks/netstacks-personal/releases/tag/v{}"
xml = "\n".join(
    f'    <release version="{v}" date="{d}">\n      <url type="details">{url.format(v)}</url>\n    </release>'
    for v, d in releases
)
src = open(f"{tree}/builds/flatpak/net.netstacks.Terminal.metainfo.xml").read()
marker = re.compile(r"^ *<!-- RELEASES:.*-->$", re.M)
if not marker.search(src):
    sys.exit("ERROR: the metainfo has no RELEASES marker")
open(out, "w").write(marker.sub(lambda _: xml, src))
PY

echo "  $(grep -c '"url"' "$OUT/cargo-sources.json") crates, $(grep -c '"url"' "$OUT/node-sources.json") npm packages, $(grep -c '<release ' "$OUT/net.netstacks.Terminal.metainfo.xml") releases -> $OUT"
