import { create } from 'zustand';
import type {
  CapabilitiesResponse,
  CapabilityCheck,
  Feature,
  FeatureName,
  PluginTerminalPanelInfo,
} from '../types/capabilities';
import { getClient } from '../api/client';

import { getErrorMessage } from '../api/errors'
/**
 * Capabilities store state interface.
 */
interface CapabilitiesState {
  // Current capabilities from Controller
  capabilities: CapabilitiesResponse | null;

  // User's RBAC permissions ('*' = all permissions, enterprise sends specific keys)
  permissions: string[];

  // Loading state
  isLoading: boolean;

  // Error state
  error: string | null;

  // Actions
  fetchCapabilities: () => Promise<void>;
  hasFeature: (name: FeatureName) => boolean;
  hasPermission: (key: string) => boolean;
  getFeature: (name: FeatureName) => Feature | undefined;
  isEnterprise: () => boolean;
  isStandalone: () => boolean;
  getPluginPanels: () => Array<{ pluginName: string; displayName: string; panel: PluginTerminalPanelInfo }>;
  hasPlugin: (name: string) => boolean;
  clearError: () => void;
}

/**
 * Standalone mode capabilities — full local feature set.
 * Personal Mode is free, open-source, and has no tier gates.
 */
const STANDALONE_CAPABILITIES: CapabilitiesResponse = {
  version: '1.0',
  license_tier: 'standalone',
  features: [
    { name: 'local_terminal', enabled: true },
    { name: 'local_topology', enabled: true },
    { name: 'local_docs', enabled: true },
    { name: 'local_custom_prompts', enabled: true },
    { name: 'local_session_recording', enabled: true },
    { name: 'local_integrations', enabled: true },
    { name: 'local_ai_tools', enabled: true },
    { name: 'mops', enabled: true },
    { name: 'local_sftp', enabled: true },
  ],
};

/**
 * Capabilities store for enterprise feature discovery.
 *
 * In enterprise mode, fetches capabilities from Controller at login.
 * In standalone mode (basic/professional), returns hardcoded local capabilities.
 */
export const useCapabilitiesStore = create<CapabilitiesState>((set, get) => ({
  capabilities: null,
  permissions: [],
  isLoading: false,
  error: null,

  /**
   * Fetch capabilities from Controller (enterprise mode).
   * In standalone mode, returns the full local feature set (no tier gates).
   */
  fetchCapabilities: async () => {
    set({ isLoading: true, error: null });

    try {
      const client = getClient();

      // Standalone (Personal Mode): full local feature set, always.
      if (client.mode !== 'enterprise') {
        set({
          capabilities: STANDALONE_CAPABILITIES,
          permissions: ['*'],
          isLoading: false,
        });
        return;
      }

      // Enterprise mode: fetch from Controller
      const response = await client.http.get<CapabilitiesResponse>('/capabilities');

      // Merge local features into enterprise capabilities.
      // Local features run in the Terminal app, not the Controller,
      // so they should always be available regardless of license tier.
      const LOCAL_FEATURES: FeatureName[] = [
        'local_terminal', 'local_topology', 'local_docs',
        'local_custom_prompts', 'local_session_recording',
        'local_integrations', 'local_ai_tools',
      ];
      const caps = response.data;
      if (!caps || !Array.isArray(caps.features)) {
        console.warn('[CapabilitiesStore] Invalid capabilities response, falling back to standalone');
        set({ capabilities: STANDALONE_CAPABILITIES, isLoading: false });
        return;
      }
      const existingNames = new Set(caps.features.map(f => f.name));
      for (const name of LOCAL_FEATURES) {
        if (!existingNames.has(name)) {
          caps.features.push({ name, enabled: true });
        }
      }

      set({
        capabilities: caps,
        permissions: caps.permissions ?? [],
        isLoading: false,
      });
    } catch (error) {
      console.error('[CapabilitiesStore] Failed to fetch capabilities:', error);

      // On error, fall back to the standalone capability set so the app
      // remains usable when the Controller is unreachable.
      set({
        capabilities: STANDALONE_CAPABILITIES,
        isLoading: false,
        error: getErrorMessage(error, 'Failed to fetch capabilities'),
      });
    }
  },

  /**
   * Check if a feature is enabled.
   */
  hasFeature: (name: FeatureName) => {
    const { capabilities } = get();
    if (!capabilities) return false;

    const feature = capabilities.features.find((f) => f.name === name);
    return feature?.enabled ?? false;
  },

  /**
   * Check if the user has a specific RBAC permission.
   * In standalone mode, permissions is ['*'] so all checks pass.
   * Before capabilities are loaded in enterprise mode, returns false (deny by default).
   */
  hasPermission: (key: string) => {
    const { permissions, capabilities } = get()
    // If capabilities haven't loaded yet and we're in enterprise mode, deny by default
    // to prevent showing tabs before RBAC is resolved
    if (!capabilities && getClient().mode === 'enterprise') return false
    if (permissions.includes('*')) return true
    return permissions.includes(key)
  },

  /**
   * Get full feature information.
   */
  getFeature: (name: FeatureName) => {
    const { capabilities } = get();
    if (!capabilities) return undefined;

    return capabilities.features.find((f) => f.name === name);
  },

  /**
   * Check if running in enterprise mode (team or enterprise tier).
   */
  isEnterprise: () => {
    const { capabilities } = get();
    if (!capabilities) return false;

    return capabilities.license_tier === 'enterprise' || capabilities.license_tier === 'team';
  },

  /**
   * Check if running in standalone mode (not enterprise).
   */
  isStandalone: () => {
    // Check client mode directly — don't depend on capabilities being loaded
    // This prevents a flash of all tabs showing before capabilities arrive
    const client = getClient();
    if (client.mode === 'enterprise') return false;

    return true;
  },

  /**
   * Get all plugin panels from enabled plugins.
   * Returns flat list of all plugin panels for sidebar rendering.
   */
  getPluginPanels: () => {
    const { capabilities } = get();
    if (!capabilities || !capabilities.plugins) {
      return [];
    }

    const result: Array<{ pluginName: string; displayName: string; panel: PluginTerminalPanelInfo }> = [];

    for (const plugin of capabilities.plugins) {
      for (const panel of plugin.terminal_panels) {
        result.push({
          pluginName: plugin.name,
          displayName: plugin.display_name,
          panel,
        });
      }
    }

    return result;
  },

  /**
   * Check if a plugin is enabled (present in capabilities).
   */
  hasPlugin: (name: string) => {
    const { capabilities } = get();
    if (!capabilities || !capabilities.plugins) return false;
    return capabilities.plugins.some((p) => p.name === name);
  },

  /**
   * Clear error state.
   */
  clearError: () => {
    set({ error: null });
  },
}));

/**
 * React hook for checking feature availability.
 * Returns capability check result with enabled state and optional tooltip.
 *
 * @param featureName - The feature to check
 * @returns Capability check result
 *
 * @example
 * ```tsx
 * const { enabled, tooltip } = useCapability('central_ssh');
 * return (
 *   <button disabled={!enabled} title={tooltip}>
 *     Connect SSH
 *   </button>
 * );
 * ```
 */
export function useCapability(featureName: FeatureName): CapabilityCheck {
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature);
  const isEnterprise = useCapabilitiesStore((s) => s.isEnterprise);

  // Check if we're in standalone mode trying to access an enterprise feature
  const enterpriseFeatures = new Set([
    'central_ssh',
    'central_ai',
    'rbac',
    'audit_logging',
    'templates',
    'service_stacks',
    'mops',
    'scheduled_tasks',
    'alerts',
    'incidents',
    'shared_docs',
    'shared_topology',
    'sso',
    'knowledge_base',
  ]);

  const isEnterpriseFeature = enterpriseFeatures.has(featureName);

  // If standalone mode and enterprise feature, always disabled
  if (!isEnterprise() && isEnterpriseFeature) {
    return {
      enabled: false,
      tooltip: 'Available in Enterprise',
    };
  }

  // Otherwise check feature flag
  const enabled = hasFeature(featureName);

  if (!enabled && isEnterpriseFeature) {
    return {
      enabled: false,
      tooltip: 'Upgrade required',
    };
  }

  return { enabled };
}
