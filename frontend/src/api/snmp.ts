// API client for SNMP operations — mode-aware (standalone → agent, enterprise → Controller)

import { getClient, getCurrentMode } from './client';

// === Request Types ===

/**
 * Optional jump-host fields. Set at most one — backend rejects both.
 * When set, the agent runs net-snmp CLI tools on the jump (over SSH)
 * instead of going direct over UDP. Required for devices reachable only
 * via a bastion (since SSH only forwards TCP and SNMP is UDP).
 */
export interface SnmpJumpRef {
  jump_host_id?: string | null;
  jump_session_id?: string | null;
}

/** SNMP GET request */
export interface SnmpGetRequest extends SnmpJumpRef {
  // Personal mode
  host?: string;
  community?: string;
  // When the request omits jump fields, the named profile's jump
  // configuration is the fallback (mirrors snmpTryCommunities).
  profileId?: string;
  // Enterprise mode
  deviceId?: string;
  // Shared
  oids: string[];
  port?: number;
}

/** SNMP WALK request */
export interface SnmpWalkRequest extends SnmpJumpRef {
  // Personal mode
  host?: string;
  community?: string;
  profileId?: string;
  // Enterprise mode
  deviceId?: string;
  // Shared
  rootOid: string;
  port?: number;
}

/** SNMP try-communities request */
export interface SnmpTryCommunityRequest extends SnmpJumpRef {
  // Personal mode
  host?: string;
  profileId?: string;
  // Enterprise mode
  deviceId?: string;
  // Shared
  port?: number;
}

// === Response Types ===

/** Single SNMP value entry with its OID */
export interface SnmpValueEntry {
  oid: string;
  value: unknown;
  valueType: string;
}

/** SNMP GET response */
export interface SnmpGetResponse {
  values: SnmpValueEntry[];
}

/** SNMP WALK response */
export interface SnmpWalkResponse {
  entries: SnmpValueEntry[];
  rootOid: string;
}

/** SNMP try-communities response */
export interface SnmpTryCommunityResponse {
  community: string;
  sysName: string;
}

/** SNMP interface stats response (from IF-MIB counters) */
export interface SnmpInterfaceStatsResponse {
  ifIndex: number;
  ifDescr: string;
  ifAlias: string;
  operStatus: number;
  operStatusText: string;
  adminStatus: number;
  adminStatusText: string;
  ifType: number;
  ifTypeText: string;
  mtu: number;
  physAddress: string;
  lastChange: number;
  speedMbps: number;
  inOctets: number;
  outOctets: number;
  inErrors: number;
  outErrors: number;
  inDiscards: number;
  outDiscards: number;
  inUcastPkts: number;
  outUcastPkts: number;
  inMulticastPkts: number;
  outMulticastPkts: number;
  inBroadcastPkts: number;
  outBroadcastPkts: number;
  hcCounters: boolean;
}

/** SNMP interface stats request (explicit community) */
export interface SnmpInterfaceStatsRequest extends SnmpJumpRef {
  // Personal mode
  host?: string;
  community?: string;
  profileId?: string;
  // Enterprise mode
  deviceId?: string;
  // Shared
  interfaceName: string;
  port?: number;
}

/** SNMP try-interface-stats request (vault community resolution) */
export interface SnmpTryInterfaceStatsRequest extends SnmpJumpRef {
  // Personal mode
  host?: string;
  profileId?: string;
  // Enterprise mode
  deviceId?: string;
  // Shared
  interfaceName: string;
  port?: number;
}

// === API Functions ===

/**
 * Perform an SNMP GET for one or more OIDs on a device.
 */
export async function snmpGet(req: SnmpGetRequest): Promise<SnmpGetResponse> {
  if (getCurrentMode() === 'enterprise') {
    const { data } = await getClient().http.post('/snmp/get', {
      deviceId: req.deviceId,
      oids: req.oids,
      port: req.port,
    });
    return data;
  }
  // Personal mode — direct to agent
  try {
    const { data } = await getClient().http.post('/snmp/get', {
      host: req.host,
      community: req.community,
      oids: req.oids,
      port: req.port,
      profileId: req.profileId,
      jumpHostId: req.jump_host_id,
      jumpSessionId: req.jump_session_id,
    });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `SNMP GET failed (${axiosErr.response?.status})`);
  }
}

/**
 * Perform an SNMP WALK of a subtree on a device.
 */
export async function snmpWalk(req: SnmpWalkRequest): Promise<SnmpWalkResponse> {
  if (getCurrentMode() === 'enterprise') {
    const { data } = await getClient().http.post('/snmp/walk', {
      deviceId: req.deviceId,
      rootOid: req.rootOid,
      port: req.port,
    });
    return data;
  }
  try {
    const { data } = await getClient().http.post('/snmp/walk', {
      host: req.host,
      community: req.community,
      rootOid: req.rootOid,
      port: req.port,
      profileId: req.profileId,
      jumpHostId: req.jump_host_id,
      jumpSessionId: req.jump_session_id,
    });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `SNMP WALK failed (${axiosErr.response?.status})`);
  }
}

/**
 * Try SNMP community strings from vault.
 * Personal mode: uses profile vault. Enterprise mode: uses device's SNMP credential.
 */
export async function snmpTryCommunities(req: SnmpTryCommunityRequest): Promise<SnmpTryCommunityResponse> {
  if (getCurrentMode() === 'enterprise') {
    const { data } = await getClient().http.post('/snmp/try-communities', {
      deviceId: req.deviceId,
      port: req.port,
    });
    return data;
  }
  try {
    const { data } = await getClient().http.post('/snmp/try-communities', {
      host: req.host,
      profileId: req.profileId,
      port: req.port,
      jumpHostId: req.jump_host_id,
      jumpSessionId: req.jump_session_id,
    });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `SNMP try-communities failed (${axiosErr.response?.status})`);
  }
}

// Per-call timeout for interface-stats SNMP. Tighter than the client
// default (30s) because LinkDetailTab fans these out to two endpoints
// in parallel and one unreachable side blocks the whole tab. 15s
// covers a slow via-jump pooled walk; anything beyond that almost
// always means the endpoint isn't actually SNMP-reachable.
const INTERFACE_STATS_TIMEOUT_MS = 15000;

/**
 * Get SNMP interface stats using an explicit community string.
 */
export async function snmpInterfaceStats(req: SnmpInterfaceStatsRequest): Promise<SnmpInterfaceStatsResponse> {
  if (getCurrentMode() === 'enterprise') {
    const { data } = await getClient().http.post('/snmp/interface-stats', {
      deviceId: req.deviceId,
      interfaceName: req.interfaceName,
      community: req.community,
      port: req.port,
    }, { timeout: INTERFACE_STATS_TIMEOUT_MS });
    return data;
  }
  try {
    const { data } = await getClient().http.post('/snmp/interface-stats', {
      host: req.host,
      community: req.community,
      interfaceName: req.interfaceName,
      port: req.port,
      profileId: req.profileId,
      jumpHostId: req.jump_host_id,
      jumpSessionId: req.jump_session_id,
    }, { timeout: INTERFACE_STATS_TIMEOUT_MS });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `SNMP interface-stats failed (${axiosErr.response?.status})`);
  }
}

/**
 * Get SNMP interface stats using community strings from vault.
 * Personal mode: uses profile vault. Enterprise mode: uses device's SNMP credential.
 */
export async function snmpTryInterfaceStats(req: SnmpTryInterfaceStatsRequest): Promise<SnmpInterfaceStatsResponse> {
  if (getCurrentMode() === 'enterprise') {
    const { data } = await getClient().http.post('/snmp/try-interface-stats', {
      deviceId: req.deviceId,
      interfaceName: req.interfaceName,
      port: req.port,
    }, { timeout: INTERFACE_STATS_TIMEOUT_MS });
    return data;
  }
  try {
    const { data } = await getClient().http.post('/snmp/try-interface-stats', {
      host: req.host,
      profileId: req.profileId,
      interfaceName: req.interfaceName,
      port: req.port,
      jumpHostId: req.jump_host_id,
      jumpSessionId: req.jump_session_id,
    }, { timeout: INTERFACE_STATS_TIMEOUT_MS });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `SNMP try-interface-stats failed (${axiosErr.response?.status})`);
  }
}
