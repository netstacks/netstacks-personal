// NetBox DCIM API client for topology import

import { getClient, getCurrentMode } from './client';
import type { CliFlavor } from './sessions';
import type {
  NetBoxConfig,
  NetBoxDeviceFilter,
  Device,
  Connection,
  Topology,
  DeviceType,
} from '../types/topology';
import { mapNetBoxRoleToDeviceType } from '../types/topology';

/**
 * NetBox API device response
 */
export interface NetBoxDevice {
  id: number;
  name: string;
  device_role?: {
    id: number;
    slug: string;
    name: string;
  } | null;
  device_type?: {
    id: number;
    slug: string;
    model: string;
    manufacturer?: {
      id: number;
      slug: string;
      name: string;
    } | null;
  } | null;
  platform?: {
    id: number;
    slug: string;
    name: string;
  } | null;
  primary_ip?: {
    id: number;
    address?: string;
    display?: string;
  } | null;
  site?: {
    id: number;
    slug: string;
    name: string;
  } | null;
  status: {
    value: string;
    label: string;
  };
}

/**
 * NetBox interface response with connected endpoints
 */
export interface NetBoxInterface {
  id: number;
  name: string;
  device: { id: number; name: string };
  type: { value: string; label: string };
  enabled: boolean;
  connected_endpoints?: Array<{
    id: number;
    name: string;
    device: { id: number; name: string };
  }>;
  cable?: { id: number; label: string };
}

/**
 * Simplified neighbor representation for topology building
 */
export interface NetBoxNeighbor {
  deviceId: number;
  deviceName: string;
  localInterface: string;
  remoteInterface: string;
  cableId?: number;
  cableLabel?: string;
}

/**
 * NetBox API cable termination
 */
interface NetBoxTermination {
  object_id: number;
  object_type: string;
  object: {
    id: number;
    device?: {
      id: number;
      name: string;
    };
    name?: string;
  };
}

/**
 * NetBox API cable response
 */
export interface NetBoxCable {
  id: number;
  a_terminations: NetBoxTermination[];
  b_terminations: NetBoxTermination[];
  status: {
    value: string;
    label: string;
  };
  label?: string;
}

/**
 * NetBox paginated response
 */
interface NetBoxPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * Build API URL with proper formatting (supports array params)
 */
function buildApiUrl(config: NetBoxConfig, path: string, params?: Record<string, string | string[]>): string {
  const baseUrl = config.url.replace(/\/$/, '');
  const url = new URL(`${baseUrl}/api${path}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) {
        if (Array.isArray(value)) {
          // For array values, append each value (NetBox supports ?key=val1&key=val2)
          value.forEach(v => {
            if (v) url.searchParams.append(key, v);
          });
        } else {
          url.searchParams.set(key, value);
        }
      }
    });
  }

  return url.toString();
}

/**
 * Make authenticated API request to NetBox
 */
async function netboxFetch<T>(
  config: NetBoxConfig,
  path: string,
  params?: Record<string, string | string[]>
): Promise<T> {
  const url = buildApiUrl(config, path, params);

  const response = await fetch(url, {
    headers: {
      'Authorization': `Token ${config.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`NetBox API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Test NetBox API connectivity (via backend proxy for SSL bypass)
 */
export async function checkNetBoxConnection(config: NetBoxConfig): Promise<boolean> {
  if (getCurrentMode() === 'enterprise') return false;
  try {
    const { data } = await getClient().http.post('/netbox/test', { url: config.url, token: config.token, verify_ssl: config.verify_ssl ?? true });
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Fetch devices from NetBox with multi-value filter support (via backend proxy for SSL bypass)
 */
export async function fetchDevices(
  config: NetBoxConfig,
  filters?: NetBoxDeviceFilter & { name?: string }
): Promise<NetBoxDevice[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const body: {
    url: string;
    token: string;
    verify_ssl?: boolean;
    name?: string;
    sites?: string[];
    roles?: string[];
    manufacturers?: string[];
    platforms?: string[];
    statuses?: string[];
    tags?: string[];
  } = {
    url: config.url,
    token: config.token,
    verify_ssl: config.verify_ssl ?? true,
  };

  // Name filter (exact hostname match)
  if (filters?.name) {
    body.name = filters.name;
  }

  // Site filter (single or multi)
  if (filters?.sites && filters.sites.length > 0) {
    body.sites = filters.sites;
  } else if (filters?.site) {
    body.sites = [filters.site];
  }

  // Role filter (single or multi)
  if (filters?.roles && filters.roles.length > 0) {
    body.roles = filters.roles;
  } else if (filters?.role) {
    body.roles = [filters.role];
  }

  // Manufacturer filter (vendor)
  if (filters?.manufacturers && filters.manufacturers.length > 0) {
    body.manufacturers = filters.manufacturers;
  }

  // Platform filter
  if (filters?.platforms && filters.platforms.length > 0) {
    body.platforms = filters.platforms;
  }

  // Status filter
  if (filters?.statuses && filters.statuses.length > 0) {
    body.statuses = filters.statuses;
  }

  // Tag filter
  if (filters?.tags && filters.tags.length > 0) {
    body.tags = filters.tags;
  }

  // Long timeout (5 min): backend paginates synchronously through all matching devices.
  // Slow NetBox + small page size can push the call past axios's default 30s.
  const { data: devices } = await getClient().http.post('/netbox/proxy/devices', body, {
    timeout: 300000,
  });
  return devices;
}

/**
 * Fetch a single device from NetBox by exact hostname match.
 * Returns the device data if found, or null if no match.
 */
export async function fetchDeviceByName(
  config: NetBoxConfig,
  hostname: string
): Promise<NetBoxDevice | null> {
  const devices = await fetchDevices(config, { name: hostname });
  return devices.length > 0 ? devices[0] : null;
}

/**
 * Count devices matching filters (for preview) - via backend proxy for SSL bypass
 */
export async function countDevices(
  config: NetBoxConfig,
  filters?: NetBoxDeviceFilter
): Promise<number> {
  if (getCurrentMode() === 'enterprise') return 0;
  const body: {
    url: string;
    token: string;
    verify_ssl: boolean;
    sites?: string[];
    roles?: string[];
    manufacturers?: string[];
    platforms?: string[];
    statuses?: string[];
    tags?: string[];
  } = {
    url: config.url,
    token: config.token,
    verify_ssl: config.verify_ssl ?? true,
  };

  // Apply filters
  if (filters?.sites && filters.sites.length > 0) {
    body.sites = filters.sites;
  } else if (filters?.site) {
    body.sites = [filters.site];
  }

  if (filters?.roles && filters.roles.length > 0) {
    body.roles = filters.roles;
  } else if (filters?.role) {
    body.roles = [filters.role];
  }

  if (filters?.manufacturers && filters.manufacturers.length > 0) {
    body.manufacturers = filters.manufacturers;
  }

  if (filters?.platforms && filters.platforms.length > 0) {
    body.platforms = filters.platforms;
  }

  if (filters?.statuses && filters.statuses.length > 0) {
    body.statuses = filters.statuses;
  }

  if (filters?.tags && filters.tags.length > 0) {
    body.tags = filters.tags;
  }

  const { data } = await getClient().http.post('/netbox/proxy/devices/count', body);
  return data.count;
}

/**
 * Fetch cables for a set of devices.
 *
 * NetBox doesn't support `device_id__in` filtering on /dcim/cables/, so we
 * issue one request per device. Within a chunk we run those requests in
 * parallel (a NetBox import for a 500-device site used to take minutes;
 * sequential + O(N²) dedup was the bottleneck) and we dedup by cable id
 * with a Set instead of a linear `find`.
 */
export async function fetchCables(
  config: NetBoxConfig,
  deviceIds: number[]
): Promise<NetBoxCable[]> {
  if (deviceIds.length === 0) {
    return [];
  }

  const allCables: NetBoxCable[] = [];
  const seenCableIds = new Set<number>();
  // Cap concurrency so we don't open hundreds of sockets against a small NetBox.
  const concurrency = 10;

  for (let i = 0; i < deviceIds.length; i += concurrency) {
    const batch = deviceIds.slice(i, i + concurrency);
    const responses = await Promise.all(
      batch.map(deviceId =>
        netboxFetch<NetBoxPaginatedResponse<NetBoxCable>>(
          config,
          '/dcim/cables/',
          { device_id: deviceId.toString(), limit: '500' }
        ).catch(error => {
          console.warn(`Failed to fetch cables for device ${deviceId}:`, error);
          return null;
        })
      )
    );

    for (const response of responses) {
      if (!response) continue;
      for (const cable of response.results) {
        if (!seenCableIds.has(cable.id)) {
          seenCableIds.add(cable.id);
          allCables.push(cable);
        }
      }
    }
  }

  return allCables;
}

// ============================================================================
// Topology Discovery Functions
// ============================================================================

/**
 * Fetch all pages of a paginated NetBox response
 */
async function fetchAllPages<T>(
  config: NetBoxConfig,
  path: string,
  params?: Record<string, string>
): Promise<T[]> {
  const allResults: T[] = [];
  let nextUrl: string | null = null;

  // First request
  const firstResponse = await netboxFetch<NetBoxPaginatedResponse<T>>(config, path, params);
  allResults.push(...firstResponse.results);
  nextUrl = firstResponse.next;

  // Fetch subsequent pages if any
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        'Authorization': `Token ${config.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`NetBox API error: ${response.status} ${response.statusText}`);
    }
    const data: NetBoxPaginatedResponse<T> = await response.json();
    allResults.push(...data.results);
    nextUrl = data.next;
  }

  return allResults;
}

/**
 * Get interfaces for a device from NetBox
 */
export async function getDeviceInterfaces(
  config: NetBoxConfig,
  deviceId: number
): Promise<NetBoxInterface[]> {
  return fetchAllPages<NetBoxInterface>(config, '/dcim/interfaces/', {
    device_id: deviceId.toString(),
    limit: '500',
  });
}

/**
 * Get cables connected to a device from NetBox
 */
export async function getDeviceCables(
  config: NetBoxConfig,
  deviceId: number
): Promise<NetBoxCable[]> {
  return fetchAllPages<NetBoxCable>(config, '/dcim/cables/', {
    device_id: deviceId.toString(),
    limit: '500',
  });
}

/**
 * Get neighbors (connected devices) for a device.
 *
 * Walks BOTH interfaces (`connected_endpoints`) AND cables. Used to fall
 * back to cables only when `connected_endpoints` came back empty, which
 * meant partial NetBox data produced partial neighbor lists. Now both
 * paths contribute and `seenPairs` dedups the overlap.
 *
 * Both paths still only look at termination index 0 — split / multi-
 * terminated cables remain truncated, but that's a NetBox modeling
 * decision and out of scope for this fix.
 */
export async function getDeviceNeighbors(
  config: NetBoxConfig,
  deviceId: number
): Promise<NetBoxNeighbor[]> {
  const neighbors: NetBoxNeighbor[] = [];
  const seenPairs = new Set<string>();

  // Approach 1: interfaces with connected_endpoints populated
  try {
    const interfaces = await getDeviceInterfaces(config, deviceId);

    for (const iface of interfaces) {
      if (iface.connected_endpoints && iface.connected_endpoints.length > 0) {
        for (const endpoint of iface.connected_endpoints) {
          if (endpoint.device) {
            const pairKey = `${deviceId}-${endpoint.device.id}-${iface.name}-${endpoint.name}`;
            if (!seenPairs.has(pairKey)) {
              seenPairs.add(pairKey);
              neighbors.push({
                deviceId: endpoint.device.id,
                deviceName: endpoint.device.name,
                localInterface: iface.name,
                remoteInterface: endpoint.name,
                cableId: iface.cable?.id,
                cableLabel: iface.cable?.label,
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to fetch interfaces for device ${deviceId}:`, error);
  }

  // Approach 2: cables (always runs — completes any neighbors that approach 1 missed)
  try {
    const cables = await getDeviceCables(config, deviceId);

    for (const cable of cables) {
      const aTermination = cable.a_terminations[0];
      const bTermination = cable.b_terminations[0];

      if (!aTermination || !bTermination) continue;

      let localTerm = aTermination;
      let remoteTerm = bTermination;

      if (bTermination.object?.device?.id === deviceId) {
        localTerm = bTermination;
        remoteTerm = aTermination;
      }

      if (!remoteTerm.object?.device?.id) continue;

      const pairKey = `${deviceId}-${remoteTerm.object.device.id}-${localTerm.object?.name || ''}-${remoteTerm.object?.name || ''}`;
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        neighbors.push({
          deviceId: remoteTerm.object.device.id,
          deviceName: remoteTerm.object.device.name,
          localInterface: localTerm.object?.name || 'unknown',
          remoteInterface: remoteTerm.object?.name || 'unknown',
          cableId: cable.id,
          cableLabel: cable.label,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to fetch cables for device ${deviceId}:`, error);
  }

  return neighbors;
}

/**
 * Map NetBox device status to our DeviceStatus
 */
function mapNetBoxStatus(status?: string | null): Device['status'] {
  if (!status) return 'unknown';
  switch (status.toLowerCase()) {
    case 'active':
      return 'online';
    case 'offline':
    case 'failed':
    case 'decommissioning':
      return 'offline';
    case 'planned':
    case 'staged':
      return 'warning';
    default:
      return 'unknown';
  }
}

/**
 * Calculate device positions in a grid layout
 */
function calculateDevicePositions(devices: Device[]): void {
  // Group devices by type for layout
  const groups: Record<DeviceType, Device[]> = {
    'cloud': [],
    'firewall': [],
    'router': [],
    'switch': [],
    'server': [],
    'access-point': [],
    'load-balancer': [],
    'wan-optimizer': [],
    'voice-gateway': [],
    'wireless-controller': [],
    'storage': [],
    'virtual': [],
    'sd-wan': [],
    'iot': [],
    'unknown': [],
  };

  devices.forEach(device => {
    groups[device.type].push(device);
  });

  // Layout parameters
  const rows: DeviceType[] = ['cloud', 'firewall', 'router', 'switch', 'server', 'access-point', 'unknown'];
  const rowHeight = 1000 / (rows.length + 1);

  rows.forEach((type, rowIndex) => {
    const rowDevices = groups[type];
    if (rowDevices.length === 0) return;

    const y = (rowIndex + 1) * rowHeight;
    const colWidth = 1000 / (rowDevices.length + 1);

    rowDevices.forEach((device, colIndex) => {
      device.x = (colIndex + 1) * colWidth;
      device.y = y;
    });
  });
}

/**
 * Import topology from NetBox DCIM
 */
export async function importTopologyFromNetBox(
  config: NetBoxConfig,
  siteFilter?: string
): Promise<Topology> {
  // Fetch devices
  const netboxDevices = await fetchDevices(config, {
    site: siteFilter,
  });

  // Transform to our Device format
  const devices: Device[] = netboxDevices.map(nbDevice => ({
    id: `netbox-${nbDevice.id}`,
    name: nbDevice.name,
    type: mapNetBoxRoleToDeviceType(nbDevice.device_role?.slug),
    status: mapNetBoxStatus(nbDevice.status?.value),
    x: 0, // Will be calculated
    y: 0, // Will be calculated
    netboxId: nbDevice.id,
    site: nbDevice.site?.name,
    role: nbDevice.device_role?.name,
    platform: nbDevice.platform?.name,
    primaryIp: (nbDevice.primary_ip?.address || nbDevice.primary_ip?.display)?.split('/')[0], // Remove CIDR notation
  }));

  // Calculate positions
  calculateDevicePositions(devices);

  // Fetch cables
  const deviceIds = netboxDevices.map(d => d.id);
  const cables = await fetchCables(config, deviceIds);

  // Transform cables to connections
  const deviceIdMap = new Map(devices.map(d => [d.netboxId, d.id]));
  const connections: Connection[] = [];

  for (const cable of cables) {
    // Get device IDs from terminations
    const aTermination = cable.a_terminations[0];
    const bTermination = cable.b_terminations[0];

    if (!aTermination?.object?.device?.id || !bTermination?.object?.device?.id) {
      continue; // Skip non-device terminations
    }

    const sourceDeviceId = deviceIdMap.get(aTermination.object.device.id);
    const targetDeviceId = deviceIdMap.get(bTermination.object.device.id);

    if (!sourceDeviceId || !targetDeviceId) {
      continue; // Device not in our topology
    }

    connections.push({
      id: `cable-${cable.id}`,
      sourceDeviceId,
      targetDeviceId,
      sourceInterface: aTermination.object.name,
      targetInterface: bTermination.object.name,
      status: cable.status.value === 'connected' ? 'active' : 'inactive',
      label: cable.label,
      cableId: cable.id.toString(),
    });
  }

  const now = new Date().toISOString();

  return {
    id: `netbox-${Date.now()}`,
    name: siteFilter ? `NetBox: ${siteFilter}` : 'NetBox Import',
    devices,
    connections,
    source: 'netbox',
    siteFilter,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Session Import Functions
// ============================================================================

/**
 * NetBox site response
 */
export interface NetBoxSite {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox device role response
 */
export interface NetBoxRole {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox manufacturer response
 */
export interface NetBoxManufacturer {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox platform response
 */
export interface NetBoxPlatform {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox tag response
 */
export interface NetBoxTag {
  id: number;
  slug: string;
  name: string;
  color: string;
}

/**
 * Per-reason counts attached to the import result for the report panel.
 */
export interface SessionImportCounts {
  /** Devices returned by NetBox after server-side filtering. */
  fetched: number;
  /** Subset of fetched devices that have a primary IP. */
  with_primary_ip: number;
  /** Sessions successfully created (== result.sessions_created). */
  created: number;
  /** Devices skipped because a matching session already exists in the DB. */
  already_exists: number;
  /** Devices skipped because no profile could be resolved. */
  no_profile: number;
  /** Devices skipped because they had no primary IP. */
  no_primary_ip: number;
  /** Devices dropped because their site folder could not be created. */
  folder_failed: number;
  /** Devices the backend rejected on session creation. */
  create_failed: number;
  /** Existing session count read for dedup (sanity check). */
  existing_sessions: number;
}

/**
 * Session import result
 */
export interface SessionImportResult {
  sessions_created: number;
  folders_created: number;
  skipped: number;
  warnings: string[];
  /** Optional structured breakdown (set when import completes; absent on early return). */
  counts?: SessionImportCounts;
}

/**
 * Session import filter options (supports single or multi-value)
 */
export interface SessionImportFilter {
  /** Single site slug (legacy) */
  site?: string;
  /** Multiple site slugs */
  sites?: string[];
  /** Single role slug (legacy) */
  role?: string;
  /** Multiple role slugs */
  roles?: string[];
  /** Manufacturer slugs */
  manufacturers?: string[];
  /** Platform slugs */
  platforms?: string[];
  /** Status values */
  statuses?: string[];
  /** Tag slugs */
  tags?: string[];
}

/**
 * Fetch available sites from NetBox (via backend proxy for SSL bypass)
 */
export async function fetchSites(config: NetBoxConfig): Promise<NetBoxSite[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/sites', { url: config.url, token: config.token, verify_ssl: config.verify_ssl ?? true });
  return data;
}

/**
 * Fetch available device roles from NetBox (via backend proxy)
 */
export async function fetchRoles(config: NetBoxConfig): Promise<NetBoxRole[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/roles', { url: config.url, token: config.token, verify_ssl: config.verify_ssl ?? true });
  return data;
}

/**
 * Fetch available manufacturers (vendors) from NetBox (via backend proxy)
 */
export async function fetchManufacturers(config: NetBoxConfig): Promise<NetBoxManufacturer[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/manufacturers', { url: config.url, token: config.token, verify_ssl: config.verify_ssl ?? true });
  return data;
}

/**
 * Fetch available platforms from NetBox (via backend proxy)
 */
export async function fetchPlatforms(config: NetBoxConfig): Promise<NetBoxPlatform[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/platforms', { url: config.url, token: config.token, verify_ssl: config.verify_ssl ?? true });
  return data;
}

/**
 * Fetch available tags from NetBox (via backend proxy)
 */
export async function fetchTags(config: NetBoxConfig): Promise<NetBoxTag[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/tags', { url: config.url, token: config.token, verify_ssl: config.verify_ssl ?? true });
  return data;
}

/**
 * NetBox device status values (fixed list)
 */
export const NETBOX_DEVICE_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'planned', label: 'Planned' },
  { value: 'staged', label: 'Staged' },
  { value: 'failed', label: 'Failed' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'decommissioning', label: 'Decommissioning' },
  { value: 'offline', label: 'Offline' },
];

/**
 * Source configuration for import (from saved NetBox source)
 */
export interface ImportSourceConfig {
  sourceId: string;
  defaultProfileId: string | null;
  profileMappings: {
    by_site: Record<string, string>;
    by_role: Record<string, string>;
  };
  cliFlavorMappings: {
    by_manufacturer: Record<string, CliFlavor>;
    by_platform: Record<string, CliFlavor>;
  };
}

/**
 * Resolve profile ID for a device based on source profile mappings
 * Priority: role mapping > site mapping > default profile
 */
function resolveProfileId(
  device: { site?: { slug: string } | null; device_role?: { slug: string } | null },
  sourceConfig: ImportSourceConfig | null
): string | null {
  if (!sourceConfig) return null;

  // Check role mapping first (higher priority)
  const roleSlug = device.device_role?.slug;
  if (roleSlug && sourceConfig.profileMappings.by_role[roleSlug]) {
    return sourceConfig.profileMappings.by_role[roleSlug];
  }

  // Check site mapping
  const siteSlug = device.site?.slug;
  if (siteSlug && sourceConfig.profileMappings.by_site[siteSlug]) {
    return sourceConfig.profileMappings.by_site[siteSlug];
  }

  // Fall back to default profile
  return sourceConfig.defaultProfileId;
}

/**
 * Existing session info for duplicate detection
 */
interface ExistingSession {
  id: string;
  name: string;
  host: string;
  netbox_device_id: number | null;
  netbox_source_id: string | null;
}

/**
 * Resolve CLI flavor for a device using user-configured mappings on the source.
 * Precedence: platform mapping > manufacturer mapping > 'auto' (let connect-time
 * detection take over). No more substring guessing — orgs configure their own
 * NetBox conventions via the source dialog.
 */
function resolveCliFlavor(
  device: NetBoxDevice,
  mappings: ImportSourceConfig['cliFlavorMappings'],
): CliFlavor {
  const platformSlug = device.platform?.slug?.toLowerCase();
  if (platformSlug && mappings.by_platform[platformSlug]) {
    return mappings.by_platform[platformSlug];
  }
  const mfrSlug = device.device_type?.manufacturer?.slug?.toLowerCase();
  if (mfrSlug && mappings.by_manufacturer[mfrSlug]) {
    return mappings.by_manufacturer[mfrSlug];
  }
  return 'auto';
}

/**
 * Import NetBox devices as NetStacks sessions
 */
export async function importDevicesAsSessions(
  config: NetBoxConfig,
  filters: SessionImportFilter,
  createSessionFn: (session: {
    name: string;
    host: string;
    folder_id?: string | null;
    profile_id: string;
    netbox_device_id?: number | null;
    netbox_source_id?: string | null;
    cli_flavor?: CliFlavor;
  }) => Promise<{ id: string }>,
  createFolderFn: (name: string) => Promise<{ id: string }>,
  listFoldersFn: () => Promise<{ id: string; name: string }[]>,
  sourceConfig: ImportSourceConfig,
  listSessionsFn?: () => Promise<ExistingSession[]>
): Promise<SessionImportResult> {
  const result: SessionImportResult = {
    sessions_created: 0,
    folders_created: 0,
    skipped: 0,
    warnings: [],
  };

  // Fetch devices from NetBox
  const devices = await fetchDevices(config, filters);

  // Filter to only devices with primary_ip (check both address and display fields)
  let noIpCount = 0;
  const devicesWithIp = devices.filter(device => {
    const ipAddress = device.primary_ip?.address || device.primary_ip?.display;
    if (!ipAddress) {
      noIpCount++;
      result.skipped++;
      result.warnings.push(`Skipped ${device.name}: no primary IP`);
      return false;
    }
    return true;
  });

  if (devicesWithIp.length === 0) {
    return result;
  }

  // Get existing folders
  const existingFolders = await listFoldersFn();
  const folderMap = new Map(existingFolders.map(f => [f.name, f.id]));

  // Get existing sessions for duplicate detection
  const existingSessions = listSessionsFn ? await listSessionsFn() : [];

  // Build lookup maps for duplicate detection
  // Map by netbox_device_id + netbox_source_id (for re-sync detection)
  const sessionsByNetBoxId = new Map<string, ExistingSession>();
  // Map by name + host (for fallback duplicate detection)
  const sessionsByNameHost = new Map<string, ExistingSession>();

  for (const session of existingSessions) {
    // Key by NetBox device ID if present
    if (session.netbox_device_id && session.netbox_source_id) {
      sessionsByNetBoxId.set(`${session.netbox_source_id}:${session.netbox_device_id}`, session);
    }
    // Key by name + host for fallback detection
    sessionsByNameHost.set(`${session.name}:${session.host}`, session);
  }

  // Group devices by site
  const devicesBySite = new Map<string, typeof devicesWithIp>();
  for (const device of devicesWithIp) {
    const siteName = device.site?.name || 'Unsorted';
    if (!devicesBySite.has(siteName)) {
      devicesBySite.set(siteName, []);
    }
    devicesBySite.get(siteName)!.push(device);
  }

  // Create folders and sessions
  let alreadyExistsCount = 0;
  let noProfileCount = 0;
  let createFailCount = 0;
  let folderFailDeviceCount = 0;
  for (const [siteName, siteDevices] of devicesBySite) {
    // Create folder if it doesn't exist
    let folderId = folderMap.get(siteName);
    if (!folderId) {
      try {
        const folder = await createFolderFn(siteName);
        folderId = folder.id;
        folderMap.set(siteName, folderId);
        result.folders_created++;
      } catch (error) {
        result.warnings.push(`Failed to create folder ${siteName} (${siteDevices.length} devices skipped): ${error}`);
        folderFailDeviceCount += siteDevices.length;
        continue;
      }
    }

    // Create sessions for each device
    for (const device of siteDevices) {
      try {
        // Strip CIDR notation from IP (e.g., "192.168.1.1/24" -> "192.168.1.1")
        // Use address field, fall back to display field
        const ipValue = device.primary_ip!.address || device.primary_ip!.display || '';
        const host = ipValue.split('/')[0];

        // Check for existing session (duplicate detection)
        let existingSession: ExistingSession | undefined;

        // First, check by NetBox device ID (most reliable for re-syncs)
        if (sourceConfig) {
          const netboxKey = `${sourceConfig.sourceId}:${device.id}`;
          existingSession = sessionsByNetBoxId.get(netboxKey);
        }

        // Fallback: check by name + host
        if (!existingSession) {
          const nameHostKey = `${device.name}:${host}`;
          existingSession = sessionsByNameHost.get(nameHostKey);
        }

        if (existingSession) {
          // Session already exists - skip it
          alreadyExistsCount++;
          result.skipped++;
          result.warnings.push(`Skipped ${device.name}: session already exists`);
          continue;
        }

        // Resolve profile ID from source mappings
        const profileId = resolveProfileId(device, sourceConfig);

        // Profile is required - skip if no profile can be resolved
        if (!profileId) {
          noProfileCount++;
          result.skipped++;
          result.warnings.push(`Skipped ${device.name}: no credential profile configured`);
          continue;
        }

        // Resolve CLI flavor from source's per-manufacturer/per-platform mappings
        const cliFlavor = resolveCliFlavor(device, sourceConfig.cliFlavorMappings);

        await createSessionFn({
          name: device.name,
          host,
          folder_id: folderId,
          profile_id: profileId,
          netbox_device_id: device.id,
          netbox_source_id: sourceConfig.sourceId,
          cli_flavor: cliFlavor,
        });
        result.sessions_created++;
      } catch (error) {
        createFailCount++;
        // Extract the most useful piece of an axios error — the server's response body
        // when present, otherwise the message. Default toString() is unhelpful.
        const err = error as { message?: string; response?: { data?: { error?: string } | string } };
        const responseData = err?.response?.data;
        const serverMsg =
          typeof responseData === 'string'
            ? responseData
            : responseData?.error ?? err?.message ?? String(error);
        result.warnings.push(`Failed to create session for ${device.name}: ${serverMsg}`);
      }
    }
  }

  // Per-reason counts attached to the result so the import dialog can render a
  // proper report. The dialog is responsible for displaying these — no console
  // spam, no blocking alerts.
  result.counts = {
    fetched: devices.length,
    with_primary_ip: devicesWithIp.length,
    created: result.sessions_created,
    already_exists: alreadyExistsCount,
    no_profile: noProfileCount,
    no_primary_ip: noIpCount,
    folder_failed: folderFailDeviceCount,
    create_failed: createFailCount,
    existing_sessions: existingSessions.length,
  };

  return result;
}

// === IP Address Lookup (for traceroute enrichment) ===

/**
 * NetBox IP address result from IPAM search
 */
export interface NetBoxIpAddress {
  id: number;
  address: string;
  assigned_object?: {
    id: number;
    name: string;
    device?: { id: number; name: string };
  } | null;
}

/**
 * Search NetBox IPAM for an IP address.
 * Returns the IP address record with assigned device and interface info.
 * Uses backend proxy for SSL bypass.
 */
export async function fetchIpAddress(
  config: NetBoxConfig,
  ipAddress: string
): Promise<NetBoxIpAddress | null> {
  if (getCurrentMode() === 'enterprise') return null;
  try {
    const { data } = await getClient().http.post('/netbox/proxy/ip-addresses', {
      url: config.url,
      token: config.token,
      address: ipAddress,
      verify_ssl: config.verify_ssl ?? true,
    });

    if (!data || data === null) return null;

    return data as NetBoxIpAddress;
  } catch {
    return null;
  }
}
