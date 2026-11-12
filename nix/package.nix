# NetStacks Terminal, built from source for Nix and NixOS.
#
#   nix build .#netstacks     (or: nix run github:netstacks/netstacks-personal)
#
# The same build as the Flatpak (builds/flatpak), without the sandbox shims:
# the local agent with cargo, the UI with npm, then the Tauri shell with plain
# cargo, embedding the UI and finding the agent next to itself as its sidecar.
#
# Dependencies come straight from Cargo.lock and package-lock.json, so a version
# bump needs no hash changes here. The one hash to keep is outputHashes below:
# the netstacks-crypto git dependency, which changes only when its tag does.
{
  lib,
  stdenv,
  rustPlatform,
  buildNpmPackage,
  importNpmLock,
  nodejs_22,
  pkg-config,
  wrapGAppsHook3,
  makeDesktopItem,
  copyDesktopItems,
  webkitgtk_4_1,
  gtk3,
  libsoup_3,
  glib-networking,
  librsvg,
  libayatana-appindicator,
}:

let
  root = ../.;
  fs = lib.fileset;
  version = (lib.importJSON ../frontend/src-tauri/tauri.conf.json).version;

  # Git dependencies Cargo.lock cannot verify by itself.
  outputHashes = {
    "netstacks-credential-vault-0.1.0" = "sha256-E9Kcv6ry7wNKpe/imZcBCdcj97s1CB7eOeJYgHN/8OI=";
  };

  meta = {
    description = "AI-powered SSH terminal for network engineers";
    homepage = "https://github.com/netstacks/netstacks-personal";
    license = lib.licenses.agpl3Only;
    platforms = lib.platforms.linux;
  };

  # The local agent: SSH, SFTP, SNMP, the vault and the AI tools behind the UI.
  agent = rustPlatform.buildRustPackage {
    pname = "netstacks-agent";
    inherit version;
    src = fs.toSource {
      root = ../agent;
      fileset = fs.unions [
        ../agent/Cargo.toml
        ../agent/Cargo.lock
        ../agent/.cargo
        ../agent/src
        ../agent/tests
      ];
    };
    cargoLock = {
      lockFile = ../agent/Cargo.lock;
      inherit outputHashes;
    };
    # The test suite runs in CI; some tests start helper binaries and servers.
    doCheck = false;
    meta = meta // { mainProgram = "netstacks-agent"; };
  };

  # The UI, built to dist/ and embedded in the shell binary.
  ui = buildNpmPackage {
    pname = "netstacks-ui";
    inherit version;
    nodejs = nodejs_22;
    src = fs.toSource {
      root = ../frontend;
      fileset = fs.difference ../frontend (fs.unions [
        ../frontend/src-tauri
        (fs.maybeMissing ../frontend/node_modules)
        (fs.maybeMissing ../frontend/dist)
        (fs.maybeMissing ../frontend/dist-web)
      ]);
    };
    npmDeps = importNpmLock { npmRoot = ../frontend; };
    npmConfigHook = importNpmLock.npmConfigHook;
    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  };
in
rustPlatform.buildRustPackage {
  pname = "netstacks";
  inherit version;

  src = fs.toSource {
    inherit root;
    fileset = fs.unions [
      ../frontend/src-tauri
    ];
  };
  cargoRoot = "frontend/src-tauri";
  buildAndTestSubdir = "frontend/src-tauri";
  cargoLock.lockFile = ../frontend/src-tauri/Cargo.lock;

  nativeBuildInputs = [
    pkg-config
    wrapGAppsHook3
    copyDesktopItems
  ];
  buildInputs = [
    webkitgtk_4_1
    gtk3
    libsoup_3
    glib-networking
    librsvg
    libayatana-appindicator
  ];

  # Merged over tauri.conf.json at compile time. Nix updates the app, so the
  # built-in updater has nowhere to look.
  env.TAURI_CONFIG = builtins.toJSON { plugins.updater.endpoints = [ ]; };

  # tauri-build checks the UI and the sidecar exist when the shell compiles.
  preBuild = ''
    mkdir -p frontend/src-tauri/binaries
    cp -r ${ui} frontend/dist
    ln -s ${lib.getExe agent} \
      frontend/src-tauri/binaries/netstacks-agent-${stdenv.hostPlatform.rust.rustcTarget}
  '';

  doCheck = false;

  postInstall = ''
    # Tauri resolves the sidecar next to the running binary. tauri-build already
    # copied it into target/, so cargo installed a copy; point at the agent instead.
    ln -sf ${lib.getExe agent} $out/bin/netstacks-agent
    ln -s NetStacks $out/bin/netstacks
    for size in 32x32 64x64 128x128; do
      install -Dm644 frontend/src-tauri/icons/$size.png \
        $out/share/icons/hicolor/$size/apps/com.netstacks.terminal.png
    done
    install -Dm644 frontend/src-tauri/icons/128x128@2x.png \
      $out/share/icons/hicolor/256x256/apps/com.netstacks.terminal.png
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "com.netstacks.terminal";
      desktopName = "NetStacks";
      comment = meta.description;
      exec = "netstacks";
      icon = "com.netstacks.terminal";
      startupWMClass = "NetStacks";
      categories = [ "Network" "RemoteAccess" ];
      keywords = [ "ssh" "terminal" "network" "ai" ];
    })
  ];

  passthru = { inherit agent ui; };

  meta = meta // { mainProgram = "netstacks"; };
}
