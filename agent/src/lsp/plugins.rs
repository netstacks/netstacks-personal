//! Built-in plugin descriptors.
//!
//! Hard-coded list of LSP plugins that ship with the agent. v1 is empty —
//! Phase 4 adds the Pyrefly descriptor. Adding a new built-in plugin is
//! a one-line append to `BUILT_IN_PLUGINS` plus the matching frontend
//! descriptor in `frontend/src/lsp/plugins.ts`.

use crate::lsp::types::{InstallationKind, LspPlugin, OnDemandSource, PluginSource, RuntimeConfig};
use std::collections::HashMap;

pub fn built_in_plugins() -> Vec<LspPlugin> {
    vec![pyrefly_descriptor()]
}

/// Pyrefly: Python LSP server with fast static analysis.
///
/// Downloaded on-demand from PyPI. SHA-256 hashes are pinned to version 1.0.0.
fn pyrefly_descriptor() -> LspPlugin {
    let mut sources = HashMap::new();

    sources.insert(
        "macos-x86_64".into(),
        OnDemandSource {
            url: "https://files.pythonhosted.org/packages/f4/c6/90788819bac9c61dd7bacba53b79f3c12d47ccbe5e51b3d6d89f2387e1d2/pyrefly-1.0.0-py3-none-macosx_10_12_x86_64.whl".into(),
            sha256: "e355a0908555348ed4b9585ef25c76ff566673e345c866c325f1633f44d890b6".into(),
            binary_path: "pyrefly".into(),
        },
    );

    sources.insert(
        "macos-arm64".into(),
        OnDemandSource {
            url: "https://files.pythonhosted.org/packages/82/91/a3cf2a1e87d336eaa804a1e6fc93266faf6dc2a97eecdbc7eae289628022/pyrefly-1.0.0-py3-none-macosx_11_0_arm64.whl".into(),
            sha256: "a7038efc3a40f8294edee339895633cf22db268c0d434cdbcbefc34f78a9ecc3".into(),
            binary_path: "pyrefly".into(),
        },
    );

    sources.insert(
        "linux-x86_64".into(),
        OnDemandSource {
            url: "https://files.pythonhosted.org/packages/61/16/cfa2d61a4aa1e1f7bca48bb37acd01c6a09db4864b16a54f9587092765ff/pyrefly-1.0.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl".into(),
            sha256: "1382d5b1fcdb49a4de9f34d112d2bddf290a78ff93ee8149492ad5f1077ddffc".into(),
            binary_path: "pyrefly".into(),
        },
    );

    sources.insert(
        "linux-arm64".into(),
        OnDemandSource {
            url: "https://files.pythonhosted.org/packages/cd/ab/74d1e11e737e99b1c003ecc5d7d2e846c4ea1f328966bfdbbd0ac63fad0a/pyrefly-1.0.0-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.whl".into(),
            sha256: "da331ca515ed1c08791da2b5f664cf9c1294c48fd802133262e7d5d51e0f4416".into(),
            binary_path: "pyrefly".into(),
        },
    );

    sources.insert(
        "windows-x86_64".into(),
        OnDemandSource {
            url: "https://files.pythonhosted.org/packages/be/ad/1d23be700b6b2ddaeb362360c7145917a8edbbf7240ae428d40541772fce/pyrefly-1.0.0-py3-none-win_amd64.whl".into(),
            sha256: "c8abcb0f2082e83c890375128f9cff4aa4d3f210b85eea7b3046c1ae764e77f5".into(),
            binary_path: "pyrefly.exe".into(),
        },
    );

    sources.insert(
        "windows-arm64".into(),
        OnDemandSource {
            url: "https://files.pythonhosted.org/packages/8c/38/16589134f3012fd097a10dcc85771555f1a5fb76e04b682597180743af30/pyrefly-1.0.0-py3-none-win_arm64.whl".into(),
            sha256: "d150fa9e40e8392832be81c3bcfc0497c146674ce4d0f8e04e1ec29e775ffb8c".into(),
            binary_path: "pyrefly.exe".into(),
        },
    );

    LspPlugin {
        id: "pyrefly".into(),
        display_name: "Pyrefly".into(),
        language: "python".into(),
        file_extensions: vec![".py".into(), ".pyi".into()],
        default_enabled: true,
        unavailable_in_enterprise: true,
        source: PluginSource::BuiltIn,
        installation: InstallationKind::OnDemandDownload {
            version: "1.0.0".into(),
            sources,
        },
        runtime: RuntimeConfig {
            // Overridden at runtime with absolute path post-install
            command: "pyrefly".into(),
            args: vec!["lsp".into()],
        },
    }
}
