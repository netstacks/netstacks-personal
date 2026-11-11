// Discovery API types — mirrors Rust backend camelCase JSON schema
// Source: terminal/agent/src/discovery/orchestrator.rs, snmp_neighbors.rs, nmap.rs

// === Batch Discovery ===

/** A target for batch discovery — sent TO the API */
export interface DiscoveryTarget {
  ip: string;
  sessionId?: string;
  // Standalone mode fields (agent)
  snmpProfileId?: string;
  credentialProfileId?: string;
  // Enterprise mode fields (controller) — UUID strings
  snmpCredentialId?: string;
  sshCredentialId?: string;
  cliFlavor?: string;
}

/** Batch discovery request body */
export interface BatchDiscoveryRequest {
  targets: DiscoveryTarget[];
  methods?: string[]; // default: ["snmp", "cli"]
}

/** A discovered neighbor device (from SNMP LLDP/CDP or CLI parsing) */
export interface DiscoveredNeighbor {
  localInterface: string;
  neighborName: string;
  neighborIp: string | null;
  neighborInterface: string | null;
  neighborPlatform: string | null;
  protocol: string; // "lldp", "cdp", "lldp-cli", "cdp-cli"
}

/** Nmap port result */
export interface NmapPort {
  port: number;
  protocol: string;
  state: string;
  service: string | null;
  version: string | null;
}

/** Nmap fingerprint result */
export interface NmapResult {
  host: string;
  state: string;
  osFamily: string | null;
  osMatch: string | null;
  osAccuracy: number | null;
  ports: NmapPort[];
  macAddress: string | null;
  vendor: string | null;
  scanTimeMs: number;
  error: string | null;
}

/** Per-target discovery result — returned FROM the API */
export interface TargetDiscoveryResult {
  ip: string;
  sysName: string | null;
  sysDescr: string | null;
  neighbors: DiscoveredNeighbor[];
  discoveryMethod: string; // "snmp-lldp", "snmp-cdp", "cli-cdp", "cli-lldp", "nmap", "none"
  nmap: NmapResult | null;
  error: string | null;
}

// === Traceroute Resolution ===

/** A traceroute hop to resolve */
export interface TracerouteHop {
  hopNumber: number;
  ip: string;
}

/** Traceroute resolution request body */
export interface TracerouteResolveRequest {
  hops: TracerouteHop[];
  // Standalone mode fields (agent)
  snmpProfileIds: string[];
  credentialProfileIds: string[];
  // Enterprise mode fields (controller) — UUID strings
  snmpCredentialIds?: string[];
  sshCredentialIds?: string[];
}

/** Parent device info from integration resolution */
export interface ParentDeviceInfo {
  hostname: string;
  managementIp: string;
  interfaceName: string | null;
  deviceType: string | null;
  platform: string | null;
}

/** Per-hop resolution result */
export interface HopResolutionResult {
  hopNumber: number;
  ip: string;
  resolved: boolean;
  source: string | null; // "netbox", "netstacksCrawler", "librenms"
  parentDevice: ParentDeviceInfo | null;
  neighbors: DiscoveredNeighbor[];
  nmap: NmapResult | null;
  error: string | null;
}

// === Capabilities ===

/** Discovery capabilities report */
export interface DiscoveryCapabilities {
  nmapAvailable: boolean;
  nmapSudo: boolean;
  snmpAvailable: boolean;
}
