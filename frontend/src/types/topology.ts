// Topology data types for 2D and 3D visualization
// Supports NetBox DCIM import and progressive discovery

/**
 * Network protocol types for visualization
 */
export type ProtocolType = 'bgp' | 'ospf' | 'stp' | 'vxlan' | 'generic';

/**
 * Protocol session state
 */
export type ProtocolState = 'established' | 'idle' | 'active' | 'down';

/**
 * Traffic direction for protocol visualization
 */
export type ProtocolDirection = 'bidirectional' | 'source-to-target' | 'target-to-source';

/**
 * Protocol session/adjacency on a connection
 */
export interface ProtocolSession {
  /** Protocol type */
  protocol: ProtocolType;
  /** Session state (established, idle, etc.) */
  state: ProtocolState;
  /** Traffic direction for visualization */
  direction: ProtocolDirection;
  /** Optional label (e.g., "eBGP AS65001") */
  label?: string;
}

/**
 * Protocol colors for 3D visualization
 */
export const PROTOCOL_COLORS: Record<ProtocolType, string> = {
  bgp: '#2196f3', // blue
  ospf: '#4caf50', // green
  stp: '#ff9800', // orange
  vxlan: '#9c27b0', // purple
  generic: '#9e9e9e', // gray
};

/**
 * Device type classification - maps to NetBox device_role.slug
 */
export type DeviceType =
  | 'router'
  | 'switch'
  | 'firewall'
  | 'server'
  | 'cloud'
  | 'access-point'
  | 'load-balancer'
  | 'wan-optimizer'
  | 'voice-gateway'
  | 'wireless-controller'
  | 'storage'
  | 'virtual'
  | 'sd-wan'
  | 'iot'
  | 'unknown';

/**
 * Device operational status
 */
export type DeviceStatus = 'online' | 'offline' | 'warning' | 'unknown';

/**
 * Network device representation
 */
export interface Device {
  /** Unique device identifier */
  id: string;
  /** Display name */
  name: string;
  /** Device type for icon/behavior */
  type: DeviceType;
  /** Current operational status */
  status: DeviceStatus;
  /** Canvas X position (0-1000 coordinate space) */
  x: number;
  /** Canvas Y position (0-1000 coordinate space) */
  y: number;
  /** Link to NetStacks session for click-to-connect */
  sessionId?: string;
  /** Profile ID for SSH/credentials (from session or discovery) */
  profileId?: string;
  /** SNMP profile ID for interface stats polling (may differ from SSH profile) */
  snmpProfileId?: string;
  /** NetBox device ID for enrichment */
  netboxId?: number;
  /** NetBox site name */
  site?: string;
  /** NetBox device role */
  role?: string;
  /** Platform/OS (IOS, NX-OS, Junos, etc.) */
  platform?: string;
  /** Management IP address */
  primaryIp?: string;
  /** Vendor (Arista, Cisco, Juniper, etc.) */
  vendor?: string;
  /** Software version */
  version?: string;
  /** Hardware model */
  model?: string;
  /** Serial number */
  serial?: string;
  /** Uptime string */
  uptime?: string;
  /** Additional metadata */
  metadata?: Record<string, string>;
  /** Whether this device is a discovered neighbor (not a connected session). Persisted via notes field containing 'discovery:neighbor'. */
  isNeighbor?: boolean;
  /** Backend notes field (used to persist neighbor status) */
  notes?: string;
}

/**
 * Connection/link status
 */
export type ConnectionStatus = 'active' | 'inactive' | 'degraded';

/**
 * Waypoint for connection routing (bend points)
 */
export interface ConnectionWaypoint {
  /** X position in 0-1000 coordinate space */
  x: number;
  /** Y position in 0-1000 coordinate space */
  y: number;
}

/**
 * Curve style for connection routing
 */
export type CurveStyle = 'straight' | 'curved' | 'orthogonal';

/**
 * Line style for connection rendering
 */
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * Network connection between devices
 */
export interface Connection {
  /** Unique connection identifier */
  id: string;
  /** Source device ID */
  sourceDeviceId: string;
  /** Target device ID */
  targetDeviceId: string;
  /** Source interface (e.g., "Gi0/1") */
  sourceInterface?: string;
  /** Target interface */
  targetInterface?: string;
  /** Connection status */
  status: ConnectionStatus;
  /** Display label */
  label?: string;
  /** NetBox cable ID */
  cableId?: string;
  /** NetBox circuit ID for WAN links */
  circuitId?: string;
  /** Protocol sessions on this connection */
  protocols?: ProtocolSession[];

  // === Enhanced routing and styling (Phase 27-02) ===

  /** Waypoints for connection routing (bend points in 0-1000 space) */
  waypoints?: ConnectionWaypoint[];
  /** Curve style for connection rendering */
  curveStyle?: CurveStyle;

  /** Bundle ID for grouping multiple connections */
  bundleId?: string;
  /** Position in bundle for offset calculation */
  bundleIndex?: number;

  /** Custom color (overrides status color) */
  color?: string;
  /** Line style for rendering */
  lineStyle?: LineStyle;
  /** Line width in pixels (default 2) */
  lineWidth?: number;

  /** Embedded notes for documentation */
  notes?: string;
}

/**
 * Topology source type
 */
export type TopologySource = 'netbox' | 'discovery' | 'manual' | 'mock';

/**
 * Complete topology with devices and connections
 */
export interface Topology {
  /** Unique topology identifier */
  id: string;
  /** Display name */
  name: string;
  /** Devices in the topology */
  devices: Device[];
  /** Connections between devices */
  connections: Connection[];
  /** Source of topology data */
  source: TopologySource;
  /** NetBox site filter if imported from specific site */
  siteFilter?: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * NetBox API configuration
 */
export interface NetBoxConfig {
  /** NetBox API URL (e.g., "https://netbox.example.com") */
  url: string;
  /** API authentication token */
  token: string;
  /** Verify TLS certificates (default true). Set false to accept self-signed certs. */
  verify_ssl?: boolean;
}

/**
 * NetBox device filter options (supports single or multi-value)
 */
export interface NetBoxDeviceFilter {
  /** Filter by site slug(s) */
  site?: string;
  sites?: string[];
  /** Filter by device role slug(s) */
  role?: string;
  roles?: string[];
  /** Filter by manufacturer slug(s) */
  manufacturers?: string[];
  /** Filter by platform slug(s) */
  platforms?: string[];
  /** Filter by status value(s) */
  statuses?: string[];
  /** Filter by tag slug(s) */
  tags?: string[];
}

/**
 * Map NetBox device_role.slug to DeviceType
 */
export function mapNetBoxRoleToDeviceType(roleSlug?: string | null): DeviceType {
  if (!roleSlug) return 'unknown';
  const normalizedRole = roleSlug.toLowerCase();

  // Load balancer detection
  if (
    normalizedRole.includes('load-balancer') ||
    normalizedRole.includes('lb') ||
    normalizedRole.includes('f5') ||
    normalizedRole.includes('citrix')
  ) {
    return 'load-balancer';
  }

  // WAN optimizer detection
  if (
    normalizedRole.includes('wan-optimizer') ||
    normalizedRole.includes('wan-opt') ||
    normalizedRole.includes('riverbed') ||
    normalizedRole.includes('silver-peak')
  ) {
    return 'wan-optimizer';
  }

  // Voice gateway detection
  if (
    normalizedRole.includes('voice') ||
    normalizedRole.includes('cube') ||
    normalizedRole.includes('gateway') ||
    normalizedRole.includes('sbc')
  ) {
    return 'voice-gateway';
  }

  // Wireless controller detection
  if (
    normalizedRole.includes('wireless-controller') ||
    normalizedRole.includes('wlc')
  ) {
    return 'wireless-controller';
  }

  // Storage detection
  if (
    normalizedRole.includes('storage') ||
    normalizedRole.includes('san') ||
    normalizedRole.includes('nas') ||
    normalizedRole.includes('netapp') ||
    normalizedRole.includes('pure')
  ) {
    return 'storage';
  }

  // Virtual device detection
  if (
    normalizedRole.includes('virtual') ||
    normalizedRole.includes('vm') ||
    normalizedRole.includes('container') ||
    normalizedRole.includes('docker') ||
    normalizedRole.includes('k8s')
  ) {
    return 'virtual';
  }

  // SD-WAN detection
  if (
    normalizedRole.includes('sd-wan') ||
    normalizedRole.includes('viptela') ||
    normalizedRole.includes('velocloud') ||
    normalizedRole.includes('velo')
  ) {
    return 'sd-wan';
  }

  // IoT detection
  if (
    normalizedRole.includes('iot') ||
    normalizedRole.includes('sensor') ||
    normalizedRole.includes('industrial') ||
    normalizedRole.includes('plc')
  ) {
    return 'iot';
  }

  // Original device type detection (kept after new types to ensure new types take priority)
  if (
    normalizedRole.includes('router') ||
    normalizedRole === 'core-router' ||
    normalizedRole === 'edge-router'
  ) {
    return 'router';
  }

  if (
    normalizedRole.includes('switch') ||
    normalizedRole === 'access-switch' ||
    normalizedRole === 'distribution-switch'
  ) {
    return 'switch';
  }

  if (normalizedRole.includes('firewall')) {
    return 'firewall';
  }

  if (normalizedRole.includes('server') || normalizedRole === 'compute') {
    return 'server';
  }

  if (normalizedRole.includes('access-point') || normalizedRole === 'ap') {
    return 'access-point';
  }

  if (normalizedRole.includes('cloud')) {
    return 'cloud';
  }

  return 'unknown';
}
