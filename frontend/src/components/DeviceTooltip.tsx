/**
 * DeviceTooltip - Quick hover tooltip showing device info in topology canvas
 *
 * Shows device name, vendor/platform info, uptime, and resource usage
 * when hovering over a device. Non-interactive overlay that follows the cursor.
 * For traceroute hops, also shows classification, ASN/WHOIS, and interface info.
 */

import type { Device } from '../types/topology';
import type { DeviceEnrichment } from '../types/enrichment';
import type { TracerouteEnrichmentState } from '../types/tracerouteEnrichment';
import type { DeviceLiveStats } from '../hooks/useTopologyLive';
import { formatUptime, getResourceLevel, getResourceLevelColor } from '../lib/enrichmentHelpers';
import './DeviceTooltip.css';

interface DeviceTooltipProps {
  /** Device to display info for */
  device: Device;
  /** Enrichment data if available */
  enrichment: DeviceEnrichment | undefined;
  /** Screen position to anchor tooltip */
  position: { x: number; y: number };
  /** Whether tooltip is visible */
  visible: boolean;
  /** Traceroute enrichment state for hop-specific data */
  tracerouteEnrichment?: TracerouteEnrichmentState;
  /** Live device stats from SNMP polling */
  deviceLiveStats?: DeviceLiveStats;
}

/** Classification badge colors */
const CLASSIFICATION_COLORS: Record<string, string> = {
  managed: '#4caf50',
  external: '#2196f3',
  'isp-transit': '#ff9800',
  timeout: '#666666',
  unknown: '#888888',
};

const CLASSIFICATION_LABELS: Record<string, string> = {
  managed: 'Managed',
  external: 'External',
  'isp-transit': 'ISP Transit',
  timeout: 'Timeout',
  unknown: 'Unknown',
};

/**
 * DeviceTooltip - Renders a quick info tooltip on device hover
 */
export default function DeviceTooltip({
  device,
  enrichment,
  position,
  visible,
  tracerouteEnrichment,
  deviceLiveStats,
}: DeviceTooltipProps) {
  if (!visible) return null;

  // Check if this is a traceroute hop
  const hopNumber = device.metadata?.hopNumber ? parseInt(device.metadata.hopNumber, 10) : null;
  const hopEnrichment = tracerouteEnrichment?.devices.get(device.id);
  const isTracerouteHop = !!hopNumber;

  // Build device description line
  const getDeviceDescription = (): string => {
    if (enrichment) {
      const parts: string[] = [];
      if (enrichment.vendor) parts.push(enrichment.vendor);
      if (enrichment.model) parts.push(enrichment.model);
      if (enrichment.osVersion) parts.push(`v${enrichment.osVersion}`);
      if (parts.length > 0) return parts.join(' ');
    }
    // Fall back to device properties
    if (device.vendor || device.platform || device.version) {
      const parts: string[] = [];
      if (device.vendor) parts.push(device.vendor);
      if (device.platform) parts.push(device.platform);
      if (device.version) parts.push(`v${device.version}`);
      return parts.join(' ');
    }
    if (hopEnrichment?.vendor || hopEnrichment?.model) {
      const parts: string[] = [];
      if (hopEnrichment.vendor) parts.push(hopEnrichment.vendor);
      if (hopEnrichment.model) parts.push(hopEnrichment.model);
      return parts.join(' ');
    }
    return isTracerouteHop ? (device.primaryIp || 'Unknown') : 'Unknown device';
  };

  // Get formatted uptime (enrichment takes precedence, then live stats)
  const getUptimeDisplay = (): string | null => {
    if (enrichment?.uptimeSeconds !== undefined) {
      return formatUptime(enrichment.uptimeSeconds);
    }
    if (enrichment?.uptimeFormatted) {
      return enrichment.uptimeFormatted;
    }
    if (deviceLiveStats?.sysUptimeSeconds !== null && deviceLiveStats?.sysUptimeSeconds !== undefined) {
      return formatUptime(deviceLiveStats.sysUptimeSeconds);
    }
    if (device.uptime) {
      return device.uptime;
    }
    return null;
  };

  // Check if we have resource data (enrichment or live)
  const cpuPct = enrichment?.cpuPercent ?? deviceLiveStats?.cpuPercent ?? undefined;
  const memPct = enrichment?.memoryPercent ?? deviceLiveStats?.memoryPercent ?? undefined;
  const hasResources = cpuPct !== undefined || memPct !== undefined;

  // Get CPU display
  const getCpuDisplay = (): { value: string; color: string } | null => {
    if (cpuPct === undefined || cpuPct === null) return null;
    const level = getResourceLevel(cpuPct);
    return {
      value: `${Math.round(cpuPct)}%`,
      color: getResourceLevelColor(level),
    };
  };

  // Get Memory display
  const getMemDisplay = (): { value: string; color: string } | null => {
    if (memPct === undefined || memPct === null) return null;
    const level = getResourceLevel(memPct);
    return {
      value: `${Math.round(memPct)}%`,
      color: getResourceLevelColor(level),
    };
  };

  const uptimeDisplay = getUptimeDisplay();
  const cpuDisplay = getCpuDisplay();
  const memDisplay = getMemDisplay();
  const hasEnrichment = enrichment !== undefined || device.vendor || device.platform || device.version || device.uptime;
  const hasLiveData = !!deviceLiveStats;

  // Traceroute enrichment data
  const classification = device.metadata?.classification;
  const asn = device.metadata?.asn;
  const asnName = device.metadata?.asnName;
  const whoisOrg = device.metadata?.whoisOrg;
  const interfaceName = device.metadata?.interfaceName;
  const dnsHostnames = device.metadata?.dnsHostnames;
  const site = device.metadata?.site || device.site;

  return (
    <div
      className="device-tooltip"
      style={{
        left: position.x,
        top: position.y + 10,
      }}
    >
      {/* Device name */}
      <div className="device-tooltip-name">{device.name}</div>

      {/* Classification badge for traceroute hops */}
      {classification && (
        <div className="device-tooltip-classification">
          <span
            className="device-tooltip-badge"
            style={{ backgroundColor: CLASSIFICATION_COLORS[classification] || '#888' }}
          >
            {CLASSIFICATION_LABELS[classification] || classification}
          </span>
          {device.primaryIp && <span className="device-tooltip-ip">{device.primaryIp}</span>}
        </div>
      )}

      {/* Description line */}
      <div className="device-tooltip-description">{getDeviceDescription()}</div>

      {/* Traceroute-specific data */}
      {isTracerouteHop && (
        <>
          {/* ASN info */}
          {asn && (
            <div className="device-tooltip-asn">
              AS{asn}{asnName ? ` - ${asnName}` : ''}
            </div>
          )}

          {/* WHOIS org for external hops */}
          {whoisOrg && !asn && (
            <div className="device-tooltip-whois">{whoisOrg}</div>
          )}

          {/* Interface name */}
          {interfaceName && (
            <div className="device-tooltip-interface">via {interfaceName}</div>
          )}

          {/* DNS hostnames */}
          {dnsHostnames && (
            <div className="device-tooltip-dns">{dnsHostnames}</div>
          )}

          {/* Site */}
          {site && (
            <div className="device-tooltip-site">Site: {site}</div>
          )}
        </>
      )}

      {(hasEnrichment || hasLiveData) ? (
        <>
          {/* sysDescr from live data (OS/firmware version) */}
          {!enrichment?.osVersion && deviceLiveStats?.sysDescr && (
            <div className="device-tooltip-sysdescr" style={{ color: '#999', fontSize: '10px', marginTop: 2 }}>
              {deviceLiveStats.sysDescr.length > 60
                ? deviceLiveStats.sysDescr.slice(0, 60) + '...'
                : deviceLiveStats.sysDescr}
            </div>
          )}

          {/* Uptime if available */}
          {uptimeDisplay && (
            <div className="device-tooltip-uptime">Uptime: {uptimeDisplay}</div>
          )}

          {/* Interface summary from live data */}
          {deviceLiveStats && deviceLiveStats.interfaceSummary.total > 0 && (
            <div className="device-tooltip-interfaces" style={{ marginTop: 2 }}>
              <span style={{ color: '#4caf50' }}>{deviceLiveStats.interfaceSummary.up} Up</span>
              {deviceLiveStats.interfaceSummary.down > 0 && (
                <span style={{ color: '#f44336', marginLeft: 6 }}>{deviceLiveStats.interfaceSummary.down} Down</span>
              )}
              {deviceLiveStats.interfaceSummary.adminDown > 0 && (
                <span style={{ color: '#ff9800', marginLeft: 6 }}>{deviceLiveStats.interfaceSummary.adminDown} Admin-Down</span>
              )}
              <span style={{ color: '#888', marginLeft: 6 }}>/ {deviceLiveStats.interfaceSummary.total}</span>
            </div>
          )}

          {/* Resources if available */}
          {hasResources && (
            <div className="device-tooltip-resources">
              {cpuDisplay && (
                <span className="device-tooltip-resource">
                  CPU: <span style={{ color: cpuDisplay.color }}>{cpuDisplay.value}</span>
                </span>
              )}
              {memDisplay && (
                <span className="device-tooltip-resource">
                  Mem: <span style={{ color: memDisplay.color }}>{memDisplay.value}</span>
                </span>
              )}
            </div>
          )}

          {/* Max utilization from live stats */}
          {deviceLiveStats && deviceLiveStats.maxUtilizationPercent > 1 && (
            <div style={{ color: '#aaa', fontSize: '10px', marginTop: 2 }}>
              Peak: {deviceLiveStats.maxUtilizationPercent.toFixed(1)}% utilization
            </div>
          )}

          {/* Errors from live stats */}
          {deviceLiveStats && (deviceLiveStats.interfaceSummary.totalInErrors + deviceLiveStats.interfaceSummary.totalOutErrors > 0) && (
            <div style={{ color: '#f44336', fontSize: '10px', marginTop: 2 }}>
              {deviceLiveStats.interfaceSummary.totalInErrors + deviceLiveStats.interfaceSummary.totalOutErrors} errors
              {(deviceLiveStats.interfaceSummary.totalInDiscards + deviceLiveStats.interfaceSummary.totalOutDiscards > 0) &&
                `, ${deviceLiveStats.interfaceSummary.totalInDiscards + deviceLiveStats.interfaceSummary.totalOutDiscards} discards`}
            </div>
          )}
        </>
      ) : !isTracerouteHop ? (
        <>
          {/* No data hint */}
          <div className="device-tooltip-no-data">No data collected</div>
          <div className="device-tooltip-hint">Run Discover to collect</div>
        </>
      ) : null}
    </div>
  );
}
