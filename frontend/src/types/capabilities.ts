/**
 * Feature availability information.
 * Mirrors the Controller Feature model.
 */
export interface Feature {
  name: string;
  enabled: boolean;
  version?: string;
  requires_config?: boolean;
}

/** Column definition for plugin table view. */
export interface PluginColumnDef {
  key: string;
  label: string;
  width?: string;
}

/** Action button definition for plugin panels. */
export interface PluginActionDef {
  id: string;
  label: string;
  endpoint: string;
  method?: string;   // defaults to POST
  confirm?: string;  // confirmation message before executing
  style?: 'primary' | 'danger' | 'default';
}

/** Terminal panel definition from a plugin manifest. */
export interface PluginTerminalPanelInfo {
  id: string;
  label: string;
  icon?: string;
  data_endpoint: string;
  columns?: PluginColumnDef[];
  actions?: PluginActionDef[];
  refresh_interval_seconds?: number;
}

/** Plugin capability returned in CapabilitiesResponse. */
export interface PluginCapability {
  name: string;
  display_name: string;
  terminal_panels: PluginTerminalPanelInfo[];
}

/**
 * Capabilities response from Controller.
 * Describes available features and versions for feature discovery.
 */
export interface CapabilitiesResponse {
  version: string;
  license_tier: 'standalone' | 'team' | 'enterprise';
  instance_name?: string;  // Controller display name
  features: Feature[];
  plugins?: PluginCapability[];  // Optional for backward compat
  permissions?: string[];  // User's RBAC permissions (enterprise only)
}

/**
 * Capability check result for UI components.
 */
export interface CapabilityCheck {
  enabled: boolean;
  tooltip?: string;
}

/**
 * Known enterprise feature names.
 * Used for type-safe feature checking.
 */
export type EnterpriseFeature =
  | 'central_ssh'
  | 'central_ai'
  | 'rbac'
  | 'audit_logging'
  | 'templates'
  | 'service_stacks'
  | 'mops'
  | 'scheduled_tasks'
  | 'alerts'
  | 'incidents'
  | 'shared_docs'
  | 'shared_topology'
  | 'sso'
  | 'knowledge_base'
  | 'central_sftp'
  | 'terminal_deenrollment';

/**
 * Known local-only feature names.
 * Available in standalone mode (basic: terminal only; professional: all local features).
 */
export type LocalFeature =
  | 'local_terminal'
  | 'local_topology'
  | 'local_docs'
  | 'local_custom_prompts'
  | 'local_session_recording'
  | 'local_integrations'
  | 'local_ai_tools'
  | 'local_sftp';

/**
 * All known feature names.
 */
export type FeatureName = EnterpriseFeature | LocalFeature;
