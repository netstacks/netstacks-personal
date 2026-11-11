import { getCurrentMode, isClientInitialized, getClient } from '../api/client';
import type { AppMode } from '../types/config';

import { logger } from '../lib/logger'
interface ModeInfo {
  /** Current app mode */
  mode: AppMode;
  /** True if running in Enterprise mode (talking to a Controller) */
  isEnterprise: boolean;
  /** True if running in standalone Personal Mode (bundled Local Agent) */
  isStandalone: boolean;
  /** True if Enterprise features (templates, stacks, etc.) are available */
  hasEnterpriseFeatures: boolean;
  /** True if client has been initialized */
  isInitialized: boolean;
  /** Controller URL (Enterprise mode only) */
  controllerUrl: string | null;
}

// Frozen mode: captured on first read after initialization
// Provides defense-in-depth against runtime mode switching (AUTH-06)
let frozenMode: AppMode | null = null;

/**
 * Hook for accessing app mode information.
 * Use this to conditionally render Enterprise-only features.
 *
 * Mode is frozen on first read after initialization. Changing mode requires app restart.
 * See AUTH-06 for mode isolation requirements.
 *
 * @example
 * const { isEnterprise, hasEnterpriseFeatures } = useMode();
 * if (hasEnterpriseFeatures) {
 *   // Show templates, stacks, etc.
 * }
 */
export function useMode(): ModeInfo {
  // Simple synchronous check - client should be initialized by the time components render
  // The main.tsx initializes the client before rendering
  const initialized = isClientInitialized();

  if (!initialized) {
    return {
      mode: 'standalone' as AppMode,
      isEnterprise: false,
      isStandalone: true,
      hasEnterpriseFeatures: false,
      isInitialized: false,
      controllerUrl: null,
    };
  }

  // Freeze mode on first read - provides defense-in-depth against runtime mode changes
  if (frozenMode === null) {
    frozenMode = getCurrentMode() ?? 'standalone';
    logger.log('[useMode] Mode frozen at:', frozenMode);
  }

  const mode = frozenMode;
  const client = getClient();

  return {
    mode,
    isEnterprise: mode === 'enterprise',
    isStandalone: mode !== 'enterprise',
    hasEnterpriseFeatures: client.hasEnterpriseFeatures,
    isInitialized: true,
    controllerUrl: mode === 'enterprise' ? (client.baseUrl ?? null) : null,
  };
}
