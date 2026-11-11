import { getErrorMessage } from '../api/errors'
/**
 * Topology Enrichment Engine
 *
 * Progressive enrichment of topology devices with data from:
 * DNS, NetBox, NetStacksCrawler, LibreNMS, ASN, and WHOIS.
 *
 * Each device with a primaryIp is enriched independently, with results
 * applied to the topology as they arrive for live visual updates.
 */

import type { Topology, Device } from '../types/topology';
import { mapNetBoxRoleToDeviceType } from '../types/topology';
import type {
  DeviceEnrichmentResult,
  HopClassification,
  LinkPortStats,
  TopologyEnrichmentState,
  TopologyEnrichmentOptions,
  AsnZone,
} from '../types/tracerouteEnrichment';
import { lookupDns, lookupWhois, lookupAsn } from '../api/lookup';
import { fetchIpAddress } from '../api/netbox';
import { searchNetStacksCrawlerDevices } from '../api/netstacksCrawler';
import { getLibreNmsDevices, getLibreNmsDeviceLinks } from '../api/librenms';
import { executeMcpTool } from '../api/mcp';

/**
 * Build the canonical key used in `TopologyEnrichmentState.linkStats`.
 * Lowercased to dodge case-mismatch surprises (LibreNMS sometimes returns
 * "Gi0/1" while neighbor records say "gi0/1").
 */
export function linkStatsKey(hostname: string, portName: string): string {
  return `${hostname.toLowerCase()}::${portName.toLowerCase()}`;
}

// ASN zone color palette
const ASN_ZONE_COLORS = [
  'rgba(33, 150, 243, 0.08)',   // blue
  'rgba(76, 175, 80, 0.08)',    // green
  'rgba(255, 152, 0, 0.08)',    // orange
  'rgba(156, 39, 176, 0.08)',   // purple
  'rgba(0, 188, 212, 0.08)',    // cyan
  'rgba(255, 87, 34, 0.08)',    // deep orange
  'rgba(63, 81, 181, 0.08)',    // indigo
  'rgba(233, 30, 99, 0.08)',    // pink
];

/**
 * Run enrichment pipeline for all devices in a topology that have a primaryIp.
 * Processes devices in parallel batches, calling onProgress after each batch.
 */
export async function enrichTopology(
  topology: Topology,
  options: TopologyEnrichmentOptions = {}
): Promise<TopologyEnrichmentState> {
  const enrichableDevices = topology.devices.filter(d => d.primaryIp);
  const totalCount = enrichableDevices.length;

  const state: TopologyEnrichmentState = {
    totalCount,
    enrichedCount: 0,
    status: 'running',
    devices: new Map(),
    linkStats: new Map(),
    asnZones: [],
  };

  options.onProgress?.(state);

  const BATCH_SIZE = 5;

  try {
    for (let i = 0; i < enrichableDevices.length; i += BATCH_SIZE) {
      const batch = enrichableDevices.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(device => enrichDevice(
          device.id,
          device.primaryIp || null,
          options
        ))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const enrichment = result.value;
          state.devices.set(enrichment.deviceId, enrichment);
          state.enrichedCount++;
        }
      }

      // Recompute ASN zones after each batch (only meaningful for traceroute topologies)
      state.asnZones = computeAsnZones(state, topology);
      options.onProgress?.({ ...state, devices: new Map(state.devices), linkStats: new Map(state.linkStats) });
    }

    // Optional pass: fetch port-level link stats for any enriched device
    // we matched to a LibreNMS source. Skipped entirely when LibreNMS is
    // not configured or the caller didn't opt in — see constraint #1 in
    // the phase plan: ?stats=true must not slow normal topology loads.
    if (options.enableLinkStats && options.librenmsSourceIds && options.librenmsSourceIds.length > 0) {
      await enrichLinkStats(topology, state, options.librenmsSourceIds);
      options.onProgress?.({ ...state, devices: new Map(state.devices), linkStats: new Map(state.linkStats) });
    }

    state.status = 'complete';
  } catch (err) {
    state.status = 'error';
    state.error = getErrorMessage(err, 'Enrichment failed');
  }

  options.onProgress?.({ ...state, devices: new Map(state.devices), linkStats: new Map(state.linkStats) });
  return state;
}

/**
 * For every topology device whose enrichment included a LibreNMS source,
 * fetch ?stats=true links and stash the per-port metrics on state.linkStats.
 * Failures on individual devices are swallowed (logged at info level) so
 * one dead device doesn't poison the whole topology view.
 */
async function enrichLinkStats(
  topology: Topology,
  state: TopologyEnrichmentState,
  librenmsSourceIds: string[]
): Promise<void> {
  if (!state.linkStats) state.linkStats = new Map();

  // Only fetch for devices we already matched to LibreNMS — otherwise we'd
  // spam the API with hostnames it doesn't know.
  const targets: Array<{ hostname: string }> = [];
  for (const device of topology.devices) {
    const enrichment = state.devices.get(device.id);
    if (!enrichment) continue;
    if (!enrichment.sources.includes('librenms')) continue;
    const hostname = enrichment.deviceName || device.name;
    if (!hostname) continue;
    targets.push({ hostname });
  }
  if (targets.length === 0) return;

  // Cap parallelism with a simple sliding window — keep it light to avoid
  // hammering small LibreNMS deployments while N=50 topologies enrich.
  const CONCURRENCY = 4;
  const queue = [...targets];
  const inflight: Array<Promise<void>> = [];

  const runOne = async (target: { hostname: string }) => {
    for (const sourceId of librenmsSourceIds) {
      try {
        const links = await getLibreNmsDeviceLinks(sourceId, target.hostname, { stats: true });
        for (const link of links) {
          const stats: LinkPortStats = { source: 'librenms' };
          if (link.local_port_in_rate_bps !== undefined) stats.in_rate_bps = link.local_port_in_rate_bps;
          if (link.local_port_out_rate_bps !== undefined) stats.out_rate_bps = link.local_port_out_rate_bps;
          if (link.local_port_speed_bps !== undefined) stats.speed_bps = link.local_port_speed_bps;
          if (link.local_port_in_errors !== undefined) stats.in_errors = link.local_port_in_errors;
          if (link.local_port_out_errors !== undefined) stats.out_errors = link.local_port_out_errors;
          if (link.local_port_oper_status !== undefined) stats.oper_status = link.local_port_oper_status;
          // Only store if at least one stat field is present
          if (
            stats.in_rate_bps !== undefined ||
            stats.out_rate_bps !== undefined ||
            stats.speed_bps !== undefined ||
            stats.in_errors !== undefined ||
            stats.out_errors !== undefined ||
            stats.oper_status !== undefined
          ) {
            state.linkStats!.set(linkStatsKey(target.hostname, link.local_port), stats);
          }
        }
        // First source that returns wins — don't double-fetch from others.
        break;
      } catch {
        // Try next source; swallow so one bad LibreNMS doesn't break the rest.
      }
    }
  };

  while (queue.length > 0 || inflight.length > 0) {
    while (queue.length > 0 && inflight.length < CONCURRENCY) {
      const target = queue.shift()!;
      const p = runOne(target).finally(() => {
        const idx = inflight.indexOf(p);
        if (idx >= 0) inflight.splice(idx, 1);
      });
      inflight.push(p);
    }
    if (inflight.length > 0) await Promise.race(inflight);
  }
}

/** Backward-compat alias */
export const enrichTracerouteTopology = enrichTopology;

/**
 * Enrich a single device with data from all enabled sources.
 * All enabled sources are always tried (no short-circuiting).
 * Fields use first-write-wins (||=) so the first source to provide a value keeps it.
 */
export async function enrichDevice(
  deviceId: string,
  ip: string | null,
  options: TopologyEnrichmentOptions = {}
): Promise<DeviceEnrichmentResult> {
  const enableDns = options.enableDns !== false;
  const enableWhois = options.enableWhois !== false;

  const enrichment: DeviceEnrichmentResult = {
    deviceId,
    ip,
    dnsHostnames: [],
    classification: ip ? 'unknown' : 'timeout',
    sources: [],
    enrichedAt: new Date().toISOString(),
  };

  if (!ip) return enrichment;

  let foundInManaged = false;

  // --- 1. Reverse DNS ---
  if (enableDns) {
    try {
      const dns = await lookupDns(ip);
      if (!dns.error && dns.results.length > 0) {
        // Filter out non-hostname results like "No PTR record found"
        const validHostnames = dns.results.filter(h => !h.toLowerCase().includes('no ptr'));
        if (validHostnames.length > 0) {
          enrichment.dnsHostnames = validHostnames;
          enrichment.sources.push('dns');
        }
      }
    } catch { /* DNS failures are non-critical */ }
  }

  // --- 2. NetBox IP Address Search ---
  if (options.netboxConfigs && options.netboxConfigs.length > 0) {
    for (const config of options.netboxConfigs) {
      try {
        const ipResult = await fetchIpAddress(config, ip);
        if (ipResult?.assigned_object?.device) {
          const dev = ipResult.assigned_object.device;
          enrichment.deviceName ||= dev.name;
          enrichment.netboxId ??= dev.id;
          enrichment.netboxUrl ??= `${config.url}/dcim/devices/${dev.id}/`;
          enrichment.interfaceName ||= ipResult.assigned_object.name;
          enrichment.sources.push('netbox');
          foundInManaged = true;
          break; // Found in first NetBox, stop searching NetBox sources
        }
      } catch { /* NetBox failures are non-critical */ }
    }
  }

  // --- 3. NetStacksCrawler Device Search (always tried) ---
  if (options.netstacksCrawlerSourceIds && options.netstacksCrawlerSourceIds.length > 0) {
    for (const sourceId of options.netstacksCrawlerSourceIds) {
      try {
        const devices = await searchNetStacksCrawlerDevices(sourceId, ip);
        if (devices.length > 0) {
          const dev = devices[0];
          enrichment.deviceName ||= dev.name || dev.dns || dev.ip;
          enrichment.vendor ||= dev.vendor || undefined;
          enrichment.model ||= dev.model || undefined;
          enrichment.platform ||= dev.os || undefined;
          enrichment.sources.push('netstacksCrawler');
          foundInManaged = true;
          break;
        }
      } catch { /* NetStacksCrawler failures are non-critical */ }
    }
  }

  // --- 4. LibreNMS Device Search (always tried) ---
  if (options.librenmsSourceIds && options.librenmsSourceIds.length > 0) {
    for (const sourceId of options.librenmsSourceIds) {
      try {
        const allDevices = await getLibreNmsDevices(sourceId);
        const match = allDevices.find(d => d.ip === ip || d.hostname === ip);
        if (match) {
          enrichment.deviceName ||= match.sysName || match.hostname;
          enrichment.model ||= match.hardware || undefined;
          enrichment.platform ||= match.os || undefined;
          enrichment.sources.push('librenms');
          foundInManaged = true;
          break;
        }
      } catch { /* LibreNMS failures are non-critical */ }
    }
  }

  // --- 5. MCP Tool Enrichment ---
  if (options.mcpServers && options.mcpServers.length > 0) {
    for (const server of options.mcpServers) {
      for (const tool of server.tools) {
        if (!tool.enabled) continue;

        // Check if tool has an IP/address/host parameter
        const schema = tool.input_schema as { properties?: Record<string, unknown> };
        const props = schema?.properties;
        if (!props) continue;

        const ipParam = Object.keys(props).find(key =>
          /ip|address|host/i.test(key)
        );
        if (!ipParam) continue;

        try {
          const result = await executeMcpTool(tool.id, { [ipParam]: ip });
          if (!result.is_error) {
            try {
              const data = JSON.parse(result.content) as Record<string, unknown>;
              const str = (v: unknown) => typeof v === 'string' ? v : undefined;
              enrichment.deviceName ||= str(data.deviceName) || str(data.name);
              enrichment.vendor ||= str(data.vendor);
              enrichment.model ||= str(data.model);
              enrichment.platform ||= str(data.platform);
              enrichment.site ||= str(data.site);
              enrichment.role ||= str(data.role);
              if (!enrichment.sources.includes('mcp')) {
                enrichment.sources.push('mcp');
              }
              if (enrichment.deviceName) foundInManaged = true;
            } catch { /* Non-JSON MCP response, skip */ }
          }
        } catch { /* MCP tool execution non-critical */ }
      }
    }
  }

  // --- 6. WHOIS Lookup (always tried when enabled) ---
  if (enableWhois) {
    try {
      const whois = await lookupWhois(ip);
      if (!whois.error && whois.summary) {
        enrichment.whoisOrg ||= whois.summary.organization || undefined;
        enrichment.whoisCountry ||= whois.summary.country || undefined;
        enrichment.whoisCidr ||= whois.summary.cidr || undefined;
        enrichment.whoisNetworkName ||= whois.summary.network_name || undefined;
        enrichment.sources.push('whois');
      }
    } catch { /* WHOIS failures are non-critical */ }

    // --- 7. ASN extraction ---
    if (enrichment.whoisCidr || enrichment.whoisOrg) {
      try {
        const asnResult = await lookupAsn(ip);
        if (!asnResult.error && asnResult.asn) {
          enrichment.asn ||= asnResult.asn;
          enrichment.asnName ||= asnResult.name || undefined;
          enrichment.asnDescription ||= asnResult.description || undefined;
          enrichment.sources.push('asn');
        }
      } catch { /* ASN lookup non-critical */ }
    }
  }

  // --- Classify the device ---
  enrichment.classification = classifyDevice(enrichment, foundInManaged);

  return enrichment;
}

/**
 * Classify a device based on enrichment data.
 */
function classifyDevice(enrichment: DeviceEnrichmentResult, foundInManaged: boolean): HopClassification {
  if (!enrichment.ip) return 'timeout';
  if (foundInManaged) return 'managed';

  // Check for ISP transit indicators
  const orgLower = (enrichment.whoisOrg || '').toLowerCase();
  const nameLower = (enrichment.asnName || '').toLowerCase();
  const dnsLower = enrichment.dnsHostnames.join(' ').toLowerCase();

  const ispKeywords = ['isp', 'telecom', 'transit', 'backbone', 'carrier', 'tier', 'network'];
  const isIsp = ispKeywords.some(kw =>
    orgLower.includes(kw) || nameLower.includes(kw) || dnsLower.includes(kw)
  );

  // Also classify as ISP if the DNS hostname looks like ISP infrastructure
  const ispDnsPatterns = [
    /ae\d+/i,      // aggregate ethernet (backbone)
    /cr\d+/i,      // core router
    /pr\d+/i,      // provider router
    /br\d+/i,      // border router
    /ix\d*/i,      // internet exchange
    /\.net\./i,    // .net TLD often ISP
  ];
  const hasDnsIspPattern = enrichment.dnsHostnames.some(h =>
    ispDnsPatterns.some(p => p.test(h))
  );

  if (isIsp || hasDnsIspPattern) return 'isp-transit';

  // If we have WHOIS/ASN data but it's not managed or ISP, it's external
  if (enrichment.whoisOrg || enrichment.asn) return 'external';

  return 'unknown';
}

/**
 * Compute ASN zones from enrichment state.
 * Groups consecutive hops with the same ASN (only for traceroute topologies with hopNumber).
 */
export function computeAsnZones(state: TopologyEnrichmentState, topology?: Topology): AsnZone[] {
  if (!topology) return [];

  // Only compute zones for devices with hopNumber metadata
  const hopsWithAsn: Array<{ hopNumber: number; enrichment: DeviceEnrichmentResult }> = [];

  for (const device of topology.devices) {
    const hopNum = device.metadata?.hopNumber ? parseInt(device.metadata.hopNumber, 10) : null;
    if (hopNum === null) continue;
    const enrichment = state.devices.get(device.id);
    if (!enrichment) continue;
    hopsWithAsn.push({ hopNumber: hopNum, enrichment });
  }

  if (hopsWithAsn.length === 0) return [];

  // Sort by hop number
  hopsWithAsn.sort((a, b) => a.hopNumber - b.hopNumber);

  const zones: AsnZone[] = [];
  let currentAsn: string | null = null;
  let currentName = '';
  let startHop = 0;
  let colorIndex = 0;

  for (const { hopNumber, enrichment } of hopsWithAsn) {
    const hopAsn = enrichment.asn || null;

    if (hopAsn !== currentAsn) {
      // Close previous zone
      if (currentAsn && startHop > 0) {
        zones.push({
          asn: currentAsn,
          name: currentName,
          startHop,
          endHop: hopNumber - 1,
          color: ASN_ZONE_COLORS[colorIndex % ASN_ZONE_COLORS.length],
        });
        colorIndex++;
      }

      currentAsn = hopAsn;
      currentName = enrichment.asnName || enrichment.whoisOrg || '';
      startHop = hopNumber;
    }
  }

  // Close final zone
  if (currentAsn && startHop > 0 && hopsWithAsn.length > 0) {
    const lastHop = hopsWithAsn[hopsWithAsn.length - 1].hopNumber;
    zones.push({
      asn: currentAsn,
      name: currentName,
      startHop,
      endHop: lastHop,
      color: ASN_ZONE_COLORS[colorIndex % ASN_ZONE_COLORS.length],
    });
  }

  return zones;
}

/**
 * Apply enrichment data to a topology, updating devices and connections.
 * Returns a new topology object with enriched devices.
 * Looks up enrichment by device ID.
 */
export function applyEnrichmentToTopology(
  topology: Topology,
  enrichmentState: TopologyEnrichmentState
): Topology {
  const updatedDevices = topology.devices.map(device => {
    const enrichment = enrichmentState.devices.get(device.id);
    if (!enrichment) return device;

    const updated: Device = { ...device, metadata: { ...device.metadata } };

    // Update name: prefer deviceName > dnsHostname > original
    if (enrichment.deviceName) {
      updated.name = enrichment.deviceName;
    } else if (enrichment.dnsHostnames.length > 0) {
      // Use shortest DNS hostname as display name
      const shortest = enrichment.dnsHostnames.reduce((a, b) => a.length <= b.length ? a : b);
      updated.name = shortest;
    }

    // Update device properties from enrichment
    if (enrichment.vendor) updated.vendor = enrichment.vendor;
    if (enrichment.model) updated.model = enrichment.model;
    if (enrichment.platform) updated.platform = enrichment.platform;
    if (enrichment.site) updated.site = enrichment.site;
    if (enrichment.role) updated.role = enrichment.role;
    if (enrichment.netboxId) updated.netboxId = enrichment.netboxId;

    // Update type based on role if we got one from NetBox
    if (enrichment.role) {
      updated.type = mapNetBoxRoleToDeviceType(enrichment.role);
    }

    // Update status based on classification
    if (enrichment.classification === 'managed') {
      updated.status = 'online';
    } else if (enrichment.classification === 'timeout') {
      updated.status = 'unknown';
    }

    // Store enrichment metadata
    if (updated.metadata) {
      updated.metadata.classification = enrichment.classification;
      if (enrichment.asn) updated.metadata.asn = enrichment.asn;
      if (enrichment.asnName) updated.metadata.asnName = enrichment.asnName;
      if (enrichment.whoisOrg) updated.metadata.whoisOrg = enrichment.whoisOrg;
      if (enrichment.whoisCountry) updated.metadata.whoisCountry = enrichment.whoisCountry;
      if (enrichment.whoisCidr) updated.metadata.whoisCidr = enrichment.whoisCidr;
      if (enrichment.whoisNetworkName) updated.metadata.whoisNetworkName = enrichment.whoisNetworkName;
      if (enrichment.interfaceName) updated.metadata.interfaceName = enrichment.interfaceName;
      if (enrichment.interfaceDescription) updated.metadata.interfaceDescription = enrichment.interfaceDescription;
      if (enrichment.snmpSysName) updated.metadata.snmpSysName = enrichment.snmpSysName;
      if (enrichment.netboxUrl) updated.metadata.netboxUrl = enrichment.netboxUrl;
      if (enrichment.dnsHostnames.length > 0) updated.metadata.dnsHostnames = enrichment.dnsHostnames.join(', ');
      if (enrichment.sources.length > 0) updated.metadata.enrichmentSources = enrichment.sources.join(', ');
      if (enrichment.cpuPercent !== undefined) updated.metadata.cpuPercent = String(enrichment.cpuPercent.toFixed(1));
      if (enrichment.memoryPercent !== undefined) updated.metadata.memoryPercent = String(enrichment.memoryPercent.toFixed(1));
      if (enrichment.temperatureCelsius !== undefined) updated.metadata.temperatureCelsius = String(enrichment.temperatureCelsius);
    }

    return updated;
  });

  return {
    ...topology,
    devices: updatedDevices,
    updatedAt: new Date().toISOString(),
  };
}
