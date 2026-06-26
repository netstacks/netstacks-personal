// Topology API for saved topologies with CRUD operations

import type { Topology, DeviceType } from '../types/topology';
import type { Annotation } from '../types/annotations';
import { createDocument, type Document } from './docs';
import { getClient } from './client';

// Types for API requests/responses
import { logger } from '../lib/logger'
import { getErrorMessage } from './errors'
export interface SavedTopologyListItem {
  id: string;
  name: string;
  shared?: boolean;
  owner_id?: string;
  folder_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectionRequest {
  source_device_id: string;
  target_device_id: string;
  source_interface?: string;
  target_interface?: string;
  label?: string;
  // Enhanced routing and styling (Phase 27-02)
  waypoints?: string;      // JSON array of {x, y}
  curve_style?: string;    // straight, curved, orthogonal
  bundle_id?: string;
  bundle_index?: number;
  color?: string;
  line_style?: string;     // solid, dashed, dotted
  line_width?: number;
  notes?: string;
}

// List all saved topologies
export async function listTopologies(params?: { shared?: boolean; owner?: string }): Promise<SavedTopologyListItem[]> {
  const searchParams = new URLSearchParams();
  if (params?.shared !== undefined) searchParams.set('shared', String(params.shared));
  if (params?.owner) searchParams.set('owner', params.owner);
  const query = searchParams.toString();
  const { data } = await getClient().http.get(`/topologies${query ? `?${query}` : ''}`);
  return data;
}

// Create new topology from connected sessions
export async function createTopology(name: string, sessionIds: string[]): Promise<Topology> {
  const { data } = await getClient().http.post('/topologies', { name, session_ids: sessionIds });
  return transformBackendTopology(data);
}

// Backend response types (snake_case)
interface BackendDevice {
  id: string;
  topology_id: string;
  session_id?: string;
  x: number;
  y: number;
  device_type: string;
  name: string;
  host: string;
  created_at: string;
  updated_at: string;
  // Enrichment fields
  platform?: string;
  version?: string;
  model?: string;
  serial?: string;
  vendor?: string;
  primary_ip?: string;
  uptime?: string;
  status?: string;
  site?: string;
  role?: string;
  profile_id?: string;
  snmp_profile_id?: string;
  notes?: string;
}

interface BackendConnection {
  id: string;
  topology_id: string;
  source_device_id: string;
  target_device_id: string;
  source_interface?: string;
  target_interface?: string;
  protocol: string;
  label?: string;
  created_at: string;
  // Enhanced routing and styling (Phase 27-02)
  waypoints?: string;      // JSON array of {x, y}
  curve_style?: string;    // straight, curved, orthogonal
  bundle_id?: string;
  bundle_index?: number;
  color?: string;
  line_style?: string;     // solid, dashed, dotted
  line_width?: number;
  notes?: string;
}

interface BackendTopology {
  id: string;
  name: string;
  shared?: boolean;
  owner_id?: string;
  devices: BackendDevice[];
  connections: BackendConnection[];
  created_at: string;
  updated_at: string;
}

function parseWaypoints(raw: string | undefined, connectionId: string): { x: number; y: number }[] | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[topology] dropping malformed waypoints on connection ${connectionId}:`, err);
    return undefined;
  }
}

// Transform backend format (snake_case) to frontend format (camelCase)
function transformBackendTopology(data: BackendTopology): Topology {
  return {
    id: data.id,
    name: data.name,
    source: 'discovery',
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    devices: (data.devices || []).map(d => ({
      id: d.id,
      name: d.name,
      type: mapBackendDeviceType(d.device_type),
      status: (d.status as 'online' | 'offline' | 'warning' | 'unknown') || 'unknown',
      x: d.x,
      y: d.y,
      sessionId: d.session_id,
      profileId: d.profile_id,
      snmpProfileId: d.snmp_profile_id,
      primaryIp: d.primary_ip || d.host,
      platform: d.platform,
      vendor: d.vendor,
      version: d.version,
      model: d.model,
      serial: d.serial,
      uptime: d.uptime,
      site: d.site,
      role: d.role,
      notes: d.notes,
      isNeighbor: d.notes === 'discovery:neighbor' ? true : undefined,
    })),
    connections: (data.connections || []).map(c => ({
      id: c.id,
      sourceDeviceId: c.source_device_id,
      targetDeviceId: c.target_device_id,
      sourceInterface: c.source_interface,
      targetInterface: c.target_interface,
      status: 'active' as const,
      label: c.label,
      // Enhanced routing and styling (Phase 27-02)
      // A malformed waypoints blob on a single connection used to throw and
      // break the whole topology load. Treat it as "no waypoints" instead.
      waypoints: parseWaypoints(c.waypoints, c.id),
      curveStyle: c.curve_style as 'straight' | 'curved' | 'orthogonal' | undefined,
      bundleId: c.bundle_id,
      bundleIndex: c.bundle_index,
      color: c.color,
      lineStyle: c.line_style as 'solid' | 'dashed' | 'dotted' | undefined,
      lineWidth: c.line_width,
      notes: c.notes,
    })),
  };
}

// Get full topology with devices and connections
export async function getTopology(id: string): Promise<Topology> {
  const { data } = await getClient().http.get(`/topologies/${id}`);
  return transformBackendTopology(data);
}

// Update topology name
export async function updateTopologyName(id: string, name: string): Promise<void> {
  await getClient().http.put(`/topologies/${id}`, { name });
}

// Delete topology
export async function deleteTopology(id: string): Promise<void> {
  await getClient().http.delete(`/topologies/${id}`);
}

// Update device position
export async function updateDevicePosition(topologyId: string, deviceId: string, x: number, y: number): Promise<void> {
  await getClient().http.put(`/topologies/${topologyId}/devices/${deviceId}/position`, { x, y });
}

// Create a device in a topology (Phase 27-07)
export interface CreateDeviceRequest {
  name: string;
  type: string;
  x: number;
  y: number;
  session_id?: string;
  site?: string;
  role?: string;
  status?: string;
}

export async function createDevice(topologyId: string, req: CreateDeviceRequest): Promise<{ id: string }> {
  const { data } = await getClient().http.post(`/topologies/${topologyId}/devices`, {
    name: req.name,
    host: '', // No host for manually added devices
    device_type: req.type,
    x: req.x,
    y: req.y,
    session_id: req.session_id,
    site: req.site,
    role: req.role,
    status: req.status,
  });
  return data;
}

// Update a device (Phase 27-07)
export async function updateDevice(
  topologyId: string,
  deviceId: string,
  updates: Partial<{
    name: string;
    type: string;
    device_type: string;
    status: string;
    site: string;
    role: string;
    platform: string;
    vendor: string;
    version: string;
    model: string;
    serial: string;
    uptime: string;
    primary_ip: string;
    notes: string;
    profile_id: string;
    snmp_profile_id: string;
  }>
): Promise<void> {
  await getClient().http.put(`/topologies/${topologyId}/devices/${deviceId}/details`, updates);
}

// Delete a device from a topology (Phase 27-07)
export async function deleteDevice(topologyId: string, deviceId: string): Promise<void> {
  await getClient().http.delete(`/topologies/${topologyId}/devices/${deviceId}`);
}

// Update a connection (Phase 27-07)
export async function updateConnection(
  topologyId: string,
  connectionId: string,
  updates: Partial<{
    source_interface: string;
    target_interface: string;
    label: string;
    status: string;
    waypoints: string;
    curve_style: string;
    color: string;
    line_style: string;
    line_width: number;
    notes: string;
  }>
): Promise<void> {
  await getClient().http.put(`/topologies/${topologyId}/connections/${connectionId}`, updates);
}

// Create connection between devices
export async function createConnection(topologyId: string, req: CreateConnectionRequest): Promise<{ id: string }> {
  const { data } = await getClient().http.post(`/topologies/${topologyId}/connections`, req);
  return data;
}

// Request to add a neighbor device (discovered, not connected)
export interface AddNeighborDeviceRequest {
  name: string;
  host: string;
  device_type: string;
  x?: number;
  y?: number;
  profile_id?: string;
  snmp_profile_id?: string;
}

// Add a neighbor device (discovered via CDP/LLDP, not directly connected session)
export async function addNeighborDevice(
  topologyId: string,
  request: AddNeighborDeviceRequest
): Promise<{ id: string }> {
  logger.log('[addNeighborDevice] Sending request:', { topologyId, request });
  const { data } = await getClient().http.post(`/topologies/${topologyId}/devices`, request);
  return data;
}

// Delete connection
export async function deleteConnection(topologyId: string, connectionId: string): Promise<void> {
  await getClient().http.delete(`/topologies/${topologyId}/connections/${connectionId}`);
}

/**
 * Counterpart to TopologyTabEditor's exportToJson — parse a previously-
 * exported topology JSON blob and create a fresh topology with new IDs.
 *
 * Accepts both the wrapped export shape `{ version, exportedAt,
 * topology: {...} }` and a raw Topology object for flexibility. Throws
 * with a user-readable message on bad shape; the caller surfaces it via
 * showToast.
 */
export async function importTopologyFromJson(
  jsonText: string,
  options?: { nameOverride?: string },
): Promise<Topology> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Not valid JSON: ${getErrorMessage(err, String(err))}`);
  }

  // Unwrap the export envelope if present.
  const candidate = (parsed && typeof parsed === 'object' && 'topology' in parsed)
    ? (parsed as { topology: unknown }).topology
    : parsed;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Expected an object at the top level of the topology JSON');
  }

  const topo = candidate as Partial<Topology>;
  if (typeof topo.name !== 'string' || !topo.name.trim()) {
    throw new Error('Topology JSON is missing a `name` string');
  }
  if (!Array.isArray(topo.devices)) {
    throw new Error('Topology JSON is missing a `devices` array');
  }
  if (!Array.isArray(topo.connections)) {
    throw new Error('Topology JSON is missing a `connections` array');
  }

  const imported: Topology = {
    id: 'pending-import',
    name: options?.nameOverride?.trim() || topo.name,
    source: topo.source ?? 'discovery',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    devices: topo.devices as Topology['devices'],
    connections: topo.connections as Topology['connections'],
  };

  // saveTemporaryTopology already creates + adds devices + creates
  // connections with fresh IDs — exactly what we need for import.
  return saveTemporaryTopology(imported);
}

/**
 * Save a temporary topology to the database
 * Creates the topology, adds all devices, and creates all connections
 */
export async function saveTemporaryTopology(topology: Topology): Promise<Topology> {
  // Step 1: Create the topology (with empty session_ids since these are discovered devices)
  const created = await createTopology(topology.name, []);

  // Step 2: Map old device IDs to new device IDs
  const deviceIdMap = new Map<string, string>();

  // Step 3: Add each device
  for (const device of topology.devices) {
    const result = await addNeighborDevice(created.id, {
      name: device.name,
      host: device.primaryIp || '',
      device_type: device.type || 'unknown',
      x: device.x,
      y: device.y,
    });
    deviceIdMap.set(device.id, result.id);
  }

  // Step 4: Create each connection with mapped device IDs
  for (const conn of topology.connections) {
    const newSourceId = deviceIdMap.get(conn.sourceDeviceId);
    const newTargetId = deviceIdMap.get(conn.targetDeviceId);

    if (newSourceId && newTargetId) {
      await createConnection(created.id, {
        source_device_id: newSourceId,
        target_device_id: newTargetId,
        source_interface: conn.sourceInterface,
        target_interface: conn.targetInterface,
        label: conn.label,
      });
    }
  }

  // Step 5: Fetch and return the complete saved topology
  return getTopology(created.id);
}

// === Topology Sharing (Enterprise Mode) ===

/** Publish/unpublish a topology for team visibility */
export async function shareTopology(topologyId: string, shared: boolean): Promise<void> {
  await getClient().http.put(`/topologies/${topologyId}/share`, { shared });
}

// === Topology Snapshot Export (Phase 27-08) ===

/**
 * Topology snapshot for Phase 26 troubleshooting session integration
 * Contains both visual SVG representation and structured JSON data
 */
export interface TopologySnapshot {
  /** Source topology ID */
  topologyId: string;
  /** Topology name */
  topologyName: string;
  /** Timestamp when snapshot was created */
  timestamp: string;
  /** Devices included in snapshot */
  devices: Topology['devices'];
  /** Connections included in snapshot */
  connections: Topology['connections'];
  /** Annotations included in snapshot */
  annotations: Annotation[];
  /** SVG visual representation for embedding in documents */
  svgData: string;
  /** Full JSON export for re-import or analysis */
  jsonData: string;
}

/**
 * Generate SVG representation of a topology
 * Creates a standalone SVG string suitable for embedding or export
 */
export function generateTopologySvg(
  topology: Topology,
  annotations: Annotation[] = []
): string {
  const width = 1000;
  const height = 1000;
  const deviceSize = 40;

  // Interface status colors for SVG
  const INTERFACE_STATUS_COLORS: Record<string, string> = {
    'up': '#4caf50',
    'down': '#f44336',
    'admin-down': '#ff9800',
    'unknown': '#9e9e9e',
  };

  // Escape XML special characters in text nodes.
  const escapeXml = (text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  // Attribute values must escape the quote character that wraps them. We use
  // double-quoted attrs throughout this generator, so escaping " is enough,
  // but we still escape < and & for defense-in-depth against SVG injection
  // from annotation color/style strings (which the editor accepts as free text).
  const attr = (value: string | number | undefined): string => {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  };

  // Build SVG content
  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <style>
    .device-label { font: 11px sans-serif; fill: white; }
    .connection-line { stroke-width: 2; fill: none; }
    .connection-label { font: 10px sans-serif; fill: #4caf50; }
    .interface-label { font: 10px sans-serif; }
    .interface-bg { fill: rgba(30, 30, 30, 0.85); }
    .annotation-text { font-family: sans-serif; }
  </style>
  <rect width="100%" height="100%" fill="#1e1e1e"/>
`;

  // Draw grid
  svg += '  <g class="grid" stroke="#2a2a2a" stroke-width="1">\n';
  for (let i = 0; i <= 1000; i += 50) {
    svg += `    <line x1="${i}" y1="0" x2="${i}" y2="1000"/>\n`;
    svg += `    <line x1="0" y1="${i}" x2="1000" y2="${i}"/>\n`;
  }
  svg += '  </g>\n';

  // Draw connections
  svg += '  <g class="connections">\n';
  for (const conn of topology.connections) {
    const source = topology.devices.find(d => d.id === conn.sourceDeviceId);
    const target = topology.devices.find(d => d.id === conn.targetDeviceId);
    if (!source || !target) continue;

    const color = conn.color || (conn.status === 'active' ? '#4caf50' : conn.status === 'degraded' ? '#ff9800' : '#666666');
    const dashArray = conn.lineStyle === 'dashed' ? 'stroke-dasharray="8,4"' : conn.lineStyle === 'dotted' ? 'stroke-dasharray="2,4"' : '';

    // Draw connection line
    svg += `    <line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="${attr(color)}" ${dashArray} class="connection-line"/>\n`;

    // Calculate label positions (15%/85% along line)
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const sourceRatio = length < 100 ? 0.25 : 0.15;
    const targetRatio = length < 100 ? 0.75 : 0.85;

    // Draw source interface label
    if (conn.sourceInterface) {
      const labelX = source.x + dx * sourceRatio;
      const labelY = source.y + dy * sourceRatio;
      const statusColor = INTERFACE_STATUS_COLORS['unknown'];
      const labelText = conn.sourceInterface.length > 15 ? conn.sourceInterface.slice(0, 14) + '...' : conn.sourceInterface;
      svg += `    <rect x="${labelX - 40}" y="${labelY - 7}" width="80" height="14" rx="3" class="interface-bg"/>\n`;
      svg += `    <text x="${labelX}" y="${labelY + 3}" text-anchor="middle" fill="${statusColor}" class="interface-label">${escapeXml(labelText)}</text>\n`;
    }

    // Draw target interface label
    if (conn.targetInterface) {
      const labelX = source.x + dx * targetRatio;
      const labelY = source.y + dy * targetRatio;
      const statusColor = INTERFACE_STATUS_COLORS['unknown'];
      const labelText = conn.targetInterface.length > 15 ? conn.targetInterface.slice(0, 14) + '...' : conn.targetInterface;
      svg += `    <rect x="${labelX - 40}" y="${labelY - 7}" width="80" height="14" rx="3" class="interface-bg"/>\n`;
      svg += `    <text x="${labelX}" y="${labelY + 3}" text-anchor="middle" fill="${statusColor}" class="interface-label">${escapeXml(labelText)}</text>\n`;
    }

    // Draw connection label at midpoint
    if (conn.label) {
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      svg += `    <text x="${midX}" y="${midY}" text-anchor="middle" class="connection-label">${escapeXml(conn.label)}</text>\n`;
    }
  }
  svg += '  </g>\n';

  // Draw annotations
  if (annotations.length > 0) {
    svg += '  <g class="annotations">\n';
    for (const annotation of annotations) {
      if (annotation.type === 'text') {
        const pos = annotation.position;
        svg += `    <text x="${pos.x}" y="${pos.y}" `;
        svg += `fill="${attr(annotation.color)}" `;
        svg += `font-size="${attr(annotation.fontSize)}" `;
        svg += `font-weight="${attr(annotation.fontWeight)}" `;
        svg += `class="annotation-text">${escapeXml(annotation.content)}</text>\n`;
      } else if (annotation.type === 'shape') {
        const pos = annotation.position;
        const size = annotation.size;
        const fill = annotation.fillColor ? `fill="${attr(annotation.fillColor)}"` : 'fill="none"';
        const stroke = `stroke="${attr(annotation.strokeColor)}" stroke-width="${attr(annotation.strokeWidth)}"`;
        const dash = annotation.strokeStyle === 'dashed' ? 'stroke-dasharray="8,4"' : annotation.strokeStyle === 'dotted' ? 'stroke-dasharray="2,4"' : '';

        if (annotation.shapeType === 'rectangle') {
          svg += `    <rect x="${pos.x}" y="${pos.y}" width="${size.width}" height="${size.height}" ${fill} ${stroke} ${dash}/>\n`;
        } else if (annotation.shapeType === 'circle') {
          const rx = size.width / 2;
          const ry = size.height / 2;
          svg += `    <ellipse cx="${pos.x + rx}" cy="${pos.y + ry}" rx="${rx}" ry="${ry}" ${fill} ${stroke} ${dash}/>\n`;
        }
        // Add label inside shape if present
        if (annotation.label) {
          const cx = pos.x + size.width / 2;
          const cy = pos.y + size.height / 2;
          svg += `    <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${attr(annotation.strokeColor)}" class="annotation-text">${escapeXml(annotation.label)}</text>\n`;
        }
      } else if (annotation.type === 'line') {
        const points = annotation.points;
        if (points.length >= 2) {
          const stroke = `stroke="${attr(annotation.color)}" stroke-width="${attr(annotation.lineWidth)}"`;
          const dash = annotation.lineStyle === 'dashed' ? 'stroke-dasharray="8,4"' : annotation.lineStyle === 'dotted' ? 'stroke-dasharray="2,4"' : '';
          const pathData = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
          svg += `    <path d="${pathData}" fill="none" ${stroke} ${dash}/>\n`;
        }
      }
    }
    svg += '  </g>\n';
  }

  // Draw devices
  svg += '  <g class="devices">\n';
  for (const device of topology.devices) {
    const statusColor = device.status === 'online' ? '#4caf50' : device.status === 'warning' ? '#ff9800' : device.status === 'offline' ? '#f44336' : '#888888';

    // Device icon (simplified rectangle with status indicator)
    svg += `    <g transform="translate(${device.x}, ${device.y})">\n`;
    svg += `      <rect x="${-deviceSize/2}" y="${-deviceSize/2}" width="${deviceSize}" height="${deviceSize}" fill="#2d2d2d" stroke="${statusColor}" stroke-width="2" rx="4"/>\n`;

    // Device type initial
    const typeInitial = device.type.charAt(0).toUpperCase();
    svg += `      <text x="0" y="4" text-anchor="middle" fill="${statusColor}" font-size="14" font-weight="bold">${typeInitial}</text>\n`;

    // Device label
    svg += `      <text x="0" y="${deviceSize/2 + 14}" text-anchor="middle" class="device-label">${escapeXml(device.name)}</text>\n`;
    svg += '    </g>\n';
  }
  svg += '  </g>\n';

  svg += '</svg>';

  return svg;
}

/**
 * Create a complete topology snapshot for Phase 26 troubleshooting session integration
 * Returns SVG visual representation and JSON data for embedding in markdown documents
 */
export async function createTopologySnapshot(
  topologyId: string,
  annotations: Annotation[] = []
): Promise<TopologySnapshot> {
  // Fetch the topology data
  const topology = await getTopology(topologyId);

  // Generate SVG representation
  const svgData = generateTopologySvg(topology, annotations);

  // Create JSON export data
  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    topology: {
      id: topology.id,
      name: topology.name,
      source: topology.source,
      createdAt: topology.createdAt,
      updatedAt: topology.updatedAt,
      devices: topology.devices,
      connections: topology.connections,
    },
    annotations,
  };

  const jsonData = JSON.stringify(exportData, null, 2);

  return {
    topologyId,
    topologyName: topology.name,
    timestamp: new Date().toISOString(),
    devices: topology.devices,
    connections: topology.connections,
    annotations,
    svgData,
    jsonData,
  };
}

/**
 * Save a topology snapshot to the Docs system for documentation/archival
 */
export async function saveTopologyToDocs(
  topologyId: string,
  annotations: Annotation[] = []
): Promise<Document> {
  const snapshot = await createTopologySnapshot(topologyId, annotations);

  return createDocument({
    name: `${snapshot.topologyName} - ${new Date().toLocaleDateString()}`,
    category: 'backups',
    content_type: 'json',
    content: snapshot.jsonData,
  });
}

/**
 * Map backend device_type string to frontend DeviceType
 */
function mapBackendDeviceType(backendType: string): DeviceType {
  const typeMap: Record<string, DeviceType> = {
    'router': 'router',
    'switch': 'switch',
    'firewall': 'firewall',
    'server': 'server',
    'cloud': 'cloud',
    'access-point': 'access-point',
    'load-balancer': 'load-balancer',
    'wan-optimizer': 'wan-optimizer',
    'voice-gateway': 'voice-gateway',
    'wireless-controller': 'wireless-controller',
    'storage': 'storage',
    'virtual': 'virtual',
    'sd-wan': 'sd-wan',
    'iot': 'iot',
  };
  return typeMap[backendType] || 'unknown';
}

// ── Topology Folder Types ──

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateFolderData {
  name?: string;
  parent_id?: string | null;
  sort_order?: number;
}

export interface MoveFolderData {
  parent_id: string | null;
  sort_order: number;
}

// ── Topology Folder Operations ──

export async function listTopologyFolders(): Promise<Folder[]> {
  const { data } = await getClient().http.get('/topologies/folders');
  return data;
}

export async function createTopologyFolder(name: string, parentId?: string): Promise<Folder> {
  const { data } = await getClient().http.post('/topologies/folders', {
    name,
    parent_id: parentId || null,
  });
  return data;
}

export async function updateTopologyFolder(id: string, update: UpdateFolderData): Promise<Folder> {
  const { data } = await getClient().http.put(`/topologies/folders/${id}`, update);
  return data;
}

export async function deleteTopologyFolder(id: string): Promise<void> {
  await getClient().http.delete(`/topologies/folders/${id}`);
}

export async function moveTopologyFolder(id: string, data: MoveFolderData): Promise<Folder> {
  const { data: result } = await getClient().http.put(`/topologies/folders/${id}/move`, data);
  return result;
}

export async function moveTopology(id: string, update: { folder_id: string | null; sort_order: number }): Promise<void> {
  await getClient().http.put(`/topologies/${id}/move`, update);
}

export async function bulkDeleteTopologies(ids: string[]): Promise<{ deleted: number; failed: number }> {
  const { data } = await getClient().http.post('/topologies/bulk-delete', { ids });
  return data;
}
