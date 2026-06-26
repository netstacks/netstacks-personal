import type { InternalAxiosRequestConfig } from 'axios';

/**
 * Inject org_id as a query parameter for plugin API routes.
 * Plugin endpoints require org_id to scope data to the correct organization.
 *
 * NOTE: The admin-ui (controller/admin-ui/src/api/client.ts) has an identical
 * check inline. If this logic changes, update both locations.
 */
export function injectOrgIdForPlugins(
  config: InternalAxiosRequestConfig,
  orgId: string | undefined
): void {
  if (config.url?.startsWith('/plugins/') && orgId) {
    config.params = { ...config.params, org_id: orgId };
  }
}
