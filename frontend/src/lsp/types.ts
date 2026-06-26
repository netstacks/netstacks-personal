/**
 * Plugin descriptor types mirroring `agent/src/lsp/types.rs`.
 *
 * Field names are camelCase to match the Rust serde rename_all = "camelCase".
 * Enum values are kebab-case strings (rename_all = "kebab-case" in Rust).
 */

export type PluginSource = 'built-in' | 'user-added';

export type InstallStatus =
  | 'installed'
  | 'not-installed'
  | 'installing'
  | 'installed-but-unusable'
  | 'unavailable'
  | 'disabled';

export interface OnDemandSource {
  url: string;
  sha256: string;
  binaryPath: string;
}

export type InstallationKind =
  | {
      kind: 'on-demand-download';
      version: string;
      sources: Record<string, OnDemandSource>;
    }
  | {
      kind: 'bundled';
      binary: string;
      args: string[];
    }
  | {
      kind: 'system-path';
      defaultCommand: string;
    };

export interface RuntimeConfig {
  command: string;
  args: string[];
}

export interface LspPlugin {
  id: string;
  displayName: string;
  language: string;
  fileExtensions: string[];
  defaultEnabled: boolean;
  unavailableInEnterprise: boolean;
  source: PluginSource;
  installation: InstallationKind;
  runtime: RuntimeConfig;
}

/**
 * Shape returned by `GET /lsp/plugins`: the descriptor plus the computed
 * install status (which depends on what's on disk, the mode, etc.).
 */
export interface LspPluginListItem extends LspPlugin {
  installStatus: InstallStatus;
}
