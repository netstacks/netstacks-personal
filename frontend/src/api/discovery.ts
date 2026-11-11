// Discovery API client — mode-aware calls via getClient()
// Routes to agent (localhost:8080) in standalone, controller in enterprise

import { getClient } from './client';
import type {
  BatchDiscoveryRequest,
  TargetDiscoveryResult,
  TracerouteResolveRequest,
  HopResolutionResult,
  DiscoveryCapabilities,
} from '../types/discovery';

/**
 * Run batch neighbor discovery on multiple targets.
 * POST /api/discovery/batch
 * Returns per-target results with neighbors, method used, and errors.
 *
 * Discovery is inherently long-running for large groups: per-target it walks
 * LLDP/CDP tables (small) but may fall through to CLI (SSH login + neighbor
 * parsing) when SNMP fails. Targets run with bounded concurrency on the
 * agent (MAX_CONCURRENT_TARGETS=10), so a 40-device group can take minutes.
 * 5-minute timeout gives all reasonable runs room without inviting infinite
 * hangs.
 */
const DISCOVERY_BATCH_TIMEOUT_MS = 300_000;

export async function runBatchDiscovery(
  request: BatchDiscoveryRequest
): Promise<TargetDiscoveryResult[]> {
  const { data } = await getClient().http.post('/discovery/batch', request, {
    timeout: DISCOVERY_BATCH_TIMEOUT_MS,
  });
  return data;
}

/**
 * Resolve traceroute hops to parent devices and run neighbor discovery.
 * POST /api/discovery/traceroute-resolve
 * Returns per-hop results with resolution info and discovered neighbors.
 */
export async function resolveTracerouteHops(
  request: TracerouteResolveRequest
): Promise<HopResolutionResult[]> {
  const { data } = await getClient().http.post('/discovery/traceroute-resolve', request);
  return data;
}

/**
 * Check what discovery capabilities are available.
 * GET /api/discovery/capabilities
 * Reports nmap availability, sudo access, and SNMP support.
 */
export async function getDiscoveryCapabilities(): Promise<DiscoveryCapabilities> {
  const { data } = await getClient().http.get('/discovery/capabilities');
  return data;
}
