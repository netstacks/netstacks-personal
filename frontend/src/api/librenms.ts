// LibreNMS API client for device and neighbor discovery
import { getClient, getCurrentMode } from './client';

/**
 * LibreNMS source configuration (stored locally)
 */
export interface LibreNmsSource {
  id: string;
  name: string;
  api_resource_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * LibreNMS device from API
 */
export interface LibreNmsDevice {
  device_id: number;
  hostname: string;
  sysName: string | null;
  ip: string;
  type: string;        // network, server, etc.
  hardware: string | null;    // Model
  os: string | null;          // Operating system
  status: number;      // 1 = up, 0 = down
}

/**
 * LibreNMS link/neighbor from API.
 *
 * The local_port_* fields are populated only when the link list was
 * requested with `?stats=true` (see getLibreNmsDeviceLinks options). They
 * represent statistics for the *local* side of the link; the remote side's
 * stats live on the *remote* device's link record.
 */
export interface LibreNmsLink {
  id: number;
  local_device_id: number;
  local_port_id: number;
  local_port: string;      // Interface name
  remote_hostname: string;
  remote_port: string;
  protocol: string;        // cdp, lldp, etc.
  // Port-statistics enrichment (only present when stats=true was requested)
  local_port_in_rate_bps?: number;
  local_port_out_rate_bps?: number;
  local_port_speed_bps?: number;
  local_port_in_errors?: number;
  local_port_out_errors?: number;
  local_port_oper_status?: string;
}

/**
 * Request to create a new LibreNMS source
 */
export interface NewLibreNmsSource {
  name: string;
  api_resource_id: string;
}

/**
 * Request to update a LibreNMS source (all fields optional)
 */
export interface UpdateLibreNmsSource {
  name?: string;
  api_resource_id?: string;
}

/**
 * Test connection response
 */
export interface TestLibreNmsResponse {
  success: boolean;
  message: string;
  version: string | null;
}

// ============================================
// Source Management (Local CRUD)
// ============================================

/**
 * List all configured LibreNMS sources
 */
export async function listLibreNmsSources(): Promise<LibreNmsSource[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/librenms-sources');
  return data;
}

/**
 * Get a single LibreNMS source
 */
export async function getLibreNmsSource(id: string): Promise<LibreNmsSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('LibreNMS sources are not available in enterprise mode');
  const { data } = await getClient().http.get(`/librenms-sources/${id}`);
  return data;
}

/**
 * Create a new LibreNMS source
 */
export async function createLibreNmsSource(
  name: string,
  api_resource_id: string
): Promise<LibreNmsSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('LibreNMS sources are not available in enterprise mode');
  try {
    const { data } = await getClient().http.post('/librenms-sources', { name, api_resource_id });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || `Failed to create LibreNMS source`);
  }
}

/**
 * Update an existing LibreNMS source
 */
export async function updateLibreNmsSource(
  id: string,
  update: UpdateLibreNmsSource
): Promise<LibreNmsSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('LibreNMS sources are not available in enterprise mode');
  try {
    const { data } = await getClient().http.put(`/librenms-sources/${id}`, update);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || `Failed to update LibreNMS source`);
  }
}

/**
 * Delete a LibreNMS source
 */
export async function deleteLibreNmsSource(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('LibreNMS sources are not available in enterprise mode');
  await getClient().http.delete(`/librenms-sources/${id}`);
}

/**
 * Test LibreNMS connection
 */
export async function testLibreNmsConnection(
  sourceId: string
): Promise<TestLibreNmsResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, message: 'Not available in enterprise mode', version: null };
  const { data } = await getClient().http.post(`/librenms-sources/${sourceId}/test`, {});
  return data;
}

/**
 * Test LibreNMS connection directly (without saving source)
 */
export async function testLibreNmsDirect(
  url: string,
  token: string
): Promise<TestLibreNmsResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, message: 'Not available in enterprise mode', version: null };
  const { data } = await getClient().http.post('/librenms/test', { url, token });
  return data;
}

// ============================================
// Device Queries (Proxied through backend)
// ============================================

/**
 * Get all devices from a LibreNMS source
 */
export async function getLibreNmsDevices(sourceId: string): Promise<LibreNmsDevice[]> {
  if (getCurrentMode() === 'enterprise') return [];
  try {
    const { data } = await getClient().http.get(`/librenms-sources/${sourceId}/devices`);
    return data.devices || [];
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || `Failed to get LibreNMS devices`);
  }
}

/**
 * Get links/neighbors for a specific device. Pass `{ stats: true }` to
 * have the backend additionally fetch /api/v0/ports/{port_id} for each
 * link and populate the local_port_* fields on each LibreNmsLink. Note
 * this slows the request roughly N requests worth (8-way concurrent on
 * the backend) so only opt in when port stats are actually rendered.
 */
export async function getLibreNmsDeviceLinks(
  sourceId: string,
  hostname: string,
  options?: { stats?: boolean }
): Promise<LibreNmsLink[]> {
  if (getCurrentMode() === 'enterprise') return [];
  try {
    const params: Record<string, string> = {};
    if (options?.stats) params.stats = 'true';
    const { data } = await getClient().http.get(
      `/librenms-sources/${sourceId}/devices/${encodeURIComponent(hostname)}/links`,
      { params }
    );
    return data.links || [];
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || `Failed to get LibreNMS device links`);
  }
}

/**
 * Get all links from a LibreNMS source
 */
export async function getLibreNmsAllLinks(sourceId: string): Promise<LibreNmsLink[]> {
  if (getCurrentMode() === 'enterprise') return [];
  try {
    const { data } = await getClient().http.get(`/librenms-sources/${sourceId}/links`);
    return data.links || [];
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || `Failed to get LibreNMS links`);
  }
}

/**
 * Result of a bulk topology import from LibreNMS.
 */
export interface LibreNmsImportTopologyResult {
  devicesCreated: number;
  connectionsCreated: number;
  devicesSkipped: number;
  connectionsSkipped: number;
}

/**
 * Import all devices and L2 links from a LibreNMS source into a topology.
 * Returns counts of devices/connections created vs skipped (duplicates +
 * dangling neighbor refs).
 */
export async function importLibreNmsTopology(
  sourceId: string,
  topologyId: string,
  includeConnections = true
): Promise<LibreNmsImportTopologyResult> {
  if (getCurrentMode() === 'enterprise') {
    throw new Error('LibreNMS topology import is not available in enterprise mode');
  }
  try {
    const { data } = await getClient().http.post(
      `/librenms-sources/${sourceId}/import-topology`,
      { topology_id: topologyId, include_connections: includeConnections }
    );
    return {
      devicesCreated: data.devices_created ?? 0,
      connectionsCreated: data.connections_created ?? 0,
      devicesSkipped: data.devices_skipped ?? 0,
      connectionsSkipped: data.connections_skipped ?? 0,
    };
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } };
    throw new Error(axiosErr.response?.data?.error || 'Failed to import topology from LibreNMS');
  }
}
