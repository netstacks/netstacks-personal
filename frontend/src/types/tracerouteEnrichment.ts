/**
 * Topology Enrichment Types
 *
 * Types for progressive enrichment of topology device visualizations.
 * Each device gets enriched with data from DNS, NetBox, NetStacksCrawler, LibreNMS,
 * SNMP, ASN, and WHOIS sources.
 */

/** Device classification based on enrichment results */
export type HopClassification = 'managed' | 'external' | 'isp-transit' | 'timeout' | 'unknown';

/** Per-device enrichment data consolidated from all sources */
export interface DeviceEnrichmentResult {
  /** Device ID (key in the devices Map) */
  deviceId: string;
  ip: string | null;

  // DNS
  dnsHostnames: string[];

  // Classification
  classification: HopClassification;

  // Managed device info (NetBox/NetStacksCrawler/LibreNMS/SNMP)
  deviceName?: string;
  vendor?: string;
  model?: string;
  platform?: string;
  site?: string;
  role?: string;
  netboxId?: number;
  netboxUrl?: string;

  // Interface mapping
  interfaceName?: string;
  interfaceDescription?: string;

  // SNMP resources
  snmpSysName?: string;
  cpuPercent?: number;
  memoryPercent?: number;
  temperatureCelsius?: number;

  // External network info (WHOIS/ASN)
  asn?: string;
  asnName?: string;
  asnDescription?: string;
  whoisOrg?: string;
  whoisCountry?: string;
  whoisCidr?: string;
  whoisNetworkName?: string;

  // Source tracking
  sources: string[];
  enrichedAt: string;
}

/** Backward-compat alias */
export type HopEnrichment = DeviceEnrichmentResult;

/**
 * Per-link port-statistics enrichment from LibreNMS, keyed on the local
 * endpoint of the link as `<hostname>::<portName>` (case-insensitive).
 * Stored on TopologyEnrichmentState so renderers can colorize edges.
 */
export interface LinkPortStats {
  /** Bits/sec inbound on the local port */
  in_rate_bps?: number;
  /** Bits/sec outbound on the local port */
  out_rate_bps?: number;
  /** Configured speed in bits/sec */
  speed_bps?: number;
  /** Inbound packet errors (cumulative) */
  in_errors?: number;
  /** Outbound packet errors (cumulative) */
  out_errors?: number;
  /** Operational status ("up", "down", ...) */
  oper_status?: string;
  /** Always 'librenms' today; reserved for future enrichers */
  source: 'librenms';
}

/** Overall enrichment state for a topology */
export interface TopologyEnrichmentState {
  totalCount: number;
  enrichedCount: number;
  status: 'idle' | 'running' | 'complete' | 'error';
  devices: Map<string, DeviceEnrichmentResult>;
  /**
   * Per-link port statistics keyed as `${hostname}::${portName}` (lowercased).
   * Populated only when at least one LibreNMS source is configured AND the
   * caller has opted in via options.enableLinkStats. Empty otherwise.
   */
  linkStats?: Map<string, LinkPortStats>;
  asnZones: AsnZone[];
  error?: string;
}

/** Backward-compat alias */
export type TracerouteEnrichmentState = TopologyEnrichmentState;

/** ASN zone for visual grouping of consecutive same-ASN hops */
export interface AsnZone {
  asn: string;
  name: string;
  startHop: number;
  endHop: number;
  color: string;
}

/** Options for the enrichment engine */
export interface TopologyEnrichmentOptions {
  /** Callback on each device enriched */
  onProgress?: (state: TopologyEnrichmentState) => void;
  /** Enable DNS reverse lookup (default: true) */
  enableDns?: boolean;
  /** Enable WHOIS/ASN lookup (default: true) */
  enableWhois?: boolean;
  /** NetBox configurations (url + token + sourceId) */
  netboxConfigs?: Array<{ url: string; token: string; sourceId?: string }>;
  /** NetStacksCrawler source IDs to search */
  netstacksCrawlerSourceIds?: string[];
  /** LibreNMS source IDs to search */
  librenmsSourceIds?: string[];
  /** Pre-fetched MCP server objects for enrichment (includes tools) */
  mcpServers?: Array<{
    id: string;
    tools: Array<{
      id: string;
      name: string;
      enabled: boolean;
      input_schema: Record<string, unknown>;
    }>;
  }>;
  /** When true, after enrichment runs SNMP LLDP/CDP neighbor discovery on
   *  every topology device with a profile, adding any new neighbors as
   *  nodes (with alias dedup) and connections. Currently 1-hop only. */
  discoverNeighbors?: boolean;
  /** When true, after device enrichment fetches port-level link statistics
   *  (in/out rate, speed, errors, operStatus) from each configured LibreNMS
   *  source and stores them keyed by `${hostname}::${port}` on
   *  TopologyEnrichmentState.linkStats. No-op when librenmsSourceIds is
   *  empty. Adds one HTTP call per LibreNMS device with neighbors. */
  enableLinkStats?: boolean;
}

/** Backward-compat alias */
export type TracerouteEnrichmentOptions = TopologyEnrichmentOptions;
