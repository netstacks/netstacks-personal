// API client for NetStacksCrawler source management
// NetStacksCrawler provides L2 topology discovery via CDP/LLDP neighbor data

import { getClient, getCurrentMode } from './client';

// NetStacksCrawler source configuration
export interface NetStacksCrawlerSource {
  id: string;
  name: string;
  api_resource_id: string;
  created_at: string;
  updated_at: string;
}

// Request to create a new NetStacksCrawler source
export interface NewNetStacksCrawlerSource {
  name: string;
  api_resource_id: string;
}

// Request to update a NetStacksCrawler source
export interface UpdateNetStacksCrawlerSource {
  name?: string;
  api_resource_id?: string;
}

// Test connection response
export interface TestNetStacksCrawlerResponse {
  success: boolean;
  message: string;
}

// NetStacksCrawler device from API
export interface NetStacksCrawlerDevice {
  ip: string;
  dns?: string | null;
  name?: string | null;
  model?: string | null;
  os?: string | null;
  os_ver?: string | null;
  vendor?: string | null;
  serial?: string | null;
  uptime?: number | null;
  last_discover?: string | null;
}

// NetStacksCrawler neighbor/link from API
export interface NetStacksCrawlerNeighbor {
  port: string;
  remote_ip?: string | null;
  remote_dns?: string | null;
  remote_port?: string | null;
  remote_type?: string | null;
  remote_model?: string | null;
  remote_os?: string | null;
  protocol?: string | null;
}

// Device link from report/devicelinks
export interface NetStacksCrawlerDeviceLink {
  left_ip: string;
  left_dns?: string | null;
  left_port?: string | null;
  right_ip: string;
  right_dns?: string | null;
  right_port?: string | null;
  speed?: string | null;
  protocol?: string | null;
}

// Search result from /api/v1/search/device
export interface NetStacksCrawlerSearchResult {
  ip: string;
  dns?: string | null;
  name?: string | null;
  vendor?: string | null;
  model?: string | null;
  os?: string | null;
}

// List all NetStacksCrawler sources
export async function listNetStacksCrawlerSources(): Promise<NetStacksCrawlerSource[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/netstacks-crawler-sources');
  return data;
}

// Get a single NetStacksCrawler source by ID
export async function getNetStacksCrawlerSource(id: string): Promise<NetStacksCrawlerSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetStacksCrawler sources are not available in enterprise mode');
  const { data } = await getClient().http.get(`/netstacks-crawler-sources/${id}`);
  return data;
}

// Create a new NetStacksCrawler source
export async function createNetStacksCrawlerSource(source: NewNetStacksCrawlerSource): Promise<NetStacksCrawlerSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetStacksCrawler sources are not available in enterprise mode');
  try {
    const { data } = await getClient().http.post('/netstacks-crawler-sources', source);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string } } };
    const responseData = axiosErr.response?.data;
    if (responseData?.code === 'VAULT_LOCKED') {
      throw new Error('Vault is locked. Go to Settings -> Security to unlock with your master password.');
    }
    throw new Error(responseData?.error || 'Failed to create NetStacksCrawler source');
  }
}

// Update an existing NetStacksCrawler source
export async function updateNetStacksCrawlerSource(id: string, update: UpdateNetStacksCrawlerSource): Promise<NetStacksCrawlerSource> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetStacksCrawler sources are not available in enterprise mode');
  const { data } = await getClient().http.put(`/netstacks-crawler-sources/${id}`, update);
  return data;
}

// Delete a NetStacksCrawler source
export async function deleteNetStacksCrawlerSource(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('NetStacksCrawler sources are not available in enterprise mode');
  await getClient().http.delete(`/netstacks-crawler-sources/${id}`);
}

// Test connection to an existing NetStacksCrawler source
export async function testNetStacksCrawlerSource(id: string): Promise<TestNetStacksCrawlerResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, message: 'Not available in enterprise mode' };
  try {
    const { data } = await getClient().http.post(`/netstacks-crawler-sources/${id}/test`);
    return data;
  } catch {
    return { success: false, message: 'Request failed' };
  }
}

// Test connection with URL and credentials (for new sources before creation)
export async function testNetStacksCrawlerConnection(
  url: string,
  authType: 'basic' | 'api_key',
  credential: string,
  username?: string
): Promise<TestNetStacksCrawlerResponse> {
  if (getCurrentMode() === 'enterprise') return { success: false, message: 'Not available in enterprise mode' };
  try {
    const { data } = await getClient().http.post('/netstacks-crawler/test', {
      url,
      auth_type: authType,
      username,
      credential,
    });
    return data;
  } catch {
    return { success: false, message: 'Request failed' };
  }
}

// Get all devices from NetStacksCrawler
export async function getNetStacksCrawlerDevices(sourceId: string): Promise<NetStacksCrawlerDevice[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netstacks-crawler-sources/${sourceId}/devices`);
  return data;
}

// Get neighbors for a specific device
export async function getNetStacksCrawlerNeighbors(sourceId: string, deviceIp: string): Promise<NetStacksCrawlerNeighbor[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netstacks-crawler-sources/${sourceId}/devices/${encodeURIComponent(deviceIp)}/neighbors`);
  return data;
}

// Get all device links (CDP/LLDP discovered connections)
export async function getNetStacksCrawlerDeviceLinks(sourceId: string): Promise<NetStacksCrawlerDeviceLink[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netstacks-crawler-sources/${sourceId}/devicelinks`);
  return data;
}

// Search for devices by name/IP
export async function searchNetStacksCrawlerDevices(sourceId: string, query: string): Promise<NetStacksCrawlerSearchResult[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get(`/netstacks-crawler-sources/${sourceId}/search`, {
    params: { q: query },
  });
  return data;
}

/**
 * Result of a bulk topology import from NetStacks-Crawler.
 */
export interface NetStacksCrawlerImportTopologyResult {
  devicesCreated: number;
  connectionsCreated: number;
  devicesSkipped: number;
  connectionsSkipped: number;
}

/**
 * Import all devices and L2 links from a NetStacks-Crawler source into
 * a topology. Links come from the global devicelinks report.
 */
export async function importNetStacksCrawlerTopology(
  sourceId: string,
  topologyId: string,
  includeConnections = true
): Promise<NetStacksCrawlerImportTopologyResult> {
  if (getCurrentMode() === 'enterprise') {
    throw new Error('NetStacks-Crawler topology import is not available in enterprise mode');
  }
  try {
    const { data } = await getClient().http.post(
      `/netstacks-crawler-sources/${sourceId}/import-topology`,
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
    throw new Error(axiosErr.response?.data?.error || 'Failed to import topology from NetStacks-Crawler');
  }
}
