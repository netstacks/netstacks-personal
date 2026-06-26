/**
 * DeviceDetailCard - Draggable detail card with full device info
 *
 * Shows comprehensive device information including system info, resources,
 * and interfaces. Draggable by header, with action buttons.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Device } from '../types/topology';
import type { DeviceEnrichment, InterfaceEnrichment } from '../types/enrichment';
import type { DeviceLiveStats, InterfaceLiveStats } from '../hooks/useTopologyLive';
import { formatRate } from '../utils/formatRate';
import {
  formatUptime,
  formatBytes,
  getResourceLevel,
  getResourceLevelColor,
  getStatusColor,
} from '../lib/enrichmentHelpers';
import './DeviceDetailCard.css';

interface DeviceDetailCardProps {
  /** Device to display details for */
  device: Device;
  /** Device enrichment data */
  enrichment: DeviceEnrichment | undefined;
  /** Interface enrichment data */
  interfaces: InterfaceEnrichment[] | undefined;
  /** Initial position for the card */
  initialPosition: { x: number; y: number };
  /** Close handler */
  onClose: () => void;
  /** Open in dedicated tab handler */
  onOpenInTab?: () => void;
  /** Save to docs handler */
  onSaveToDocs?: () => void;
  /** Open terminal handler (when no enrichment) */
  onOpenTerminal?: () => void;
  /** Live device stats from SNMP polling */
  deviceLiveStats?: DeviceLiveStats;
  /** Live per-interface stats (keyed by "host:ifDescr") */
  liveInterfaceStats?: Map<string, InterfaceLiveStats>;
}

/**
 * DeviceDetailCard - Renders a detailed, draggable device information card
 */
export default function DeviceDetailCard({
  device,
  enrichment,
  interfaces,
  initialPosition,
  onClose,
  onOpenInTab,
  onSaveToDocs,
  onOpenTerminal,
  deviceLiveStats,
  liveInterfaceStats,
}: DeviceDetailCardProps) {
  // Dragging state
  const [position, setPosition] = useState(initialPosition);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; posX: number; posY: number } | null>(null);

  // Collapsible sections
  const [interfacesExpanded, setInterfacesExpanded] = useState(false);

  // Constrain initial position to viewport
  useEffect(() => {
    const cardWidth = 350;
    const cardHeight = 400;
    const padding = 20;

    const constrainedX = Math.max(padding, Math.min(window.innerWidth - cardWidth - padding, initialPosition.x));
    const constrainedY = Math.max(padding, Math.min(window.innerHeight - cardHeight - padding, initialPosition.y));

    if (constrainedX !== initialPosition.x || constrainedY !== initialPosition.y) {
      setPosition({ x: constrainedX, y: constrainedY });
    }
  }, [initialPosition]);

  // Handle drag start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from header
    if ((e.target as HTMLElement).closest('.device-detail-card-header')) {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        posX: position.x,
        posY: position.y,
      };
    }
  }, [position]);

  // Handle drag
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;

      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      // Constrain to viewport
      const cardWidth = 350;
      const cardHeight = 400;
      const padding = 20;

      const newX = Math.max(
        padding,
        Math.min(window.innerWidth - cardWidth - padding, dragStartRef.current.posX + deltaX)
      );
      const newY = Math.max(
        padding,
        Math.min(window.innerHeight - cardHeight - padding, dragStartRef.current.posY + deltaY)
      );

      setPosition({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Get display values
  const vendor = enrichment?.vendor || device.vendor || 'Unknown';
  const model = enrichment?.model || device.model || device.platform || 'Unknown';
  const serial = enrichment?.serialNumber || device.serial || 'N/A';
  const hostname = enrichment?.hostname || device.name;

  // Uptime (enrichment > live stats > device prop)
  const getUptimeDisplay = (): string => {
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
    return 'N/A';
  };

  // OS version fallback to live sysDescr
  const osVersionDisplay = enrichment?.osVersion || device.version ||
    (deviceLiveStats?.sysDescr
      ? (deviceLiveStats.sysDescr.length > 80 ? deviceLiveStats.sysDescr.slice(0, 80) + '...' : deviceLiveStats.sysDescr)
      : 'Unknown');

  // Resources (enrichment takes precedence, then live stats)
  const liveCpu = enrichment?.cpuPercent ?? deviceLiveStats?.cpuPercent ?? undefined;
  const liveMem = enrichment?.memoryPercent ?? deviceLiveStats?.memoryPercent ?? undefined;
  const hasResources = liveCpu !== undefined || liveMem !== undefined;

  // CPU progress bar (enrichment or live stats)
  const renderCpuBar = () => {
    if (liveCpu === undefined || liveCpu === null) return null;
    const level = getResourceLevel(liveCpu);
    const color = getResourceLevelColor(level);
    const percent = Math.min(100, Math.max(0, liveCpu));

    return (
      <div className="device-detail-card-resource">
        <div className="device-detail-card-resource-label">
          <span>CPU</span>
          <span style={{ color }}>{percent.toFixed(1)}%</span>
        </div>
        <div className="device-detail-card-progress">
          <div
            className="device-detail-card-progress-bar"
            style={{ width: `${percent}%`, backgroundColor: color }}
          />
        </div>
      </div>
    );
  };

  // Memory progress bar (enrichment or live stats)
  const renderMemoryBar = () => {
    if (liveMem === undefined || liveMem === null) return null;
    const level = getResourceLevel(liveMem);
    const color = getResourceLevelColor(level);
    const percent = Math.min(100, Math.max(0, liveMem));

    // Build label with used/total if available
    let memLabel = `${percent.toFixed(1)}%`;
    const memUsed = enrichment?.memoryUsedMB ?? deviceLiveStats?.memoryUsedMB;
    const memTotal = enrichment?.memoryTotalMB ?? deviceLiveStats?.memoryTotalMB;
    if (memUsed !== undefined && memUsed !== null && memTotal !== undefined && memTotal !== null) {
      const usedStr = formatBytes(memUsed * 1024 * 1024);
      const totalStr = formatBytes(memTotal * 1024 * 1024);
      memLabel = `${usedStr} / ${totalStr}`;
    }

    return (
      <div className="device-detail-card-resource">
        <div className="device-detail-card-resource-label">
          <span>Memory</span>
          <span style={{ color }}>{memLabel}</span>
        </div>
        <div className="device-detail-card-progress">
          <div
            className="device-detail-card-progress-bar"
            style={{ width: `${percent}%`, backgroundColor: color }}
          />
        </div>
      </div>
    );
  };

  // Build live interface list from deviceLiveStats.interfaces + liveInterfaceStats rates
  const buildLiveInterfaces = () => {
    if (!deviceLiveStats || deviceLiveStats.interfaces.length === 0) return null;

    // Sort: UP first, then DOWN, then ADMIN-DOWN
    const sorted = [...deviceLiveStats.interfaces].sort((a, b) => {
      const statusOrder = (s: { operStatus: number; adminStatus: number }) => {
        if (s.operStatus === 1) return 0; // UP
        if (s.operStatus === 2 && s.adminStatus === 2) return 2; // ADMIN-DOWN
        return 1; // DOWN
      };
      return statusOrder(a) - statusOrder(b);
    });

    return sorted.map((iface) => {
      const statusText = iface.operStatus === 1 ? 'up' :
        (iface.operStatus === 2 && iface.adminStatus === 2) ? 'admin-down' : 'down';
      const statusColor = getStatusColor(statusText);

      // Look up live rates from liveInterfaceStats
      const key = `${device.primaryIp}:${iface.ifDescr}`;
      const liveRate = liveInterfaceStats?.get(key);

      return (
        <div key={iface.ifDescr} className="device-detail-card-interface">
          <div className="device-detail-card-interface-header">
            <span className="device-detail-card-interface-name">{iface.ifDescr}</span>
            <span
              className="device-detail-card-interface-status"
              style={{ backgroundColor: statusColor }}
            >
              {statusText}
            </span>
          </div>
          <div className="device-detail-card-interface-speed" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{iface.speedMbps > 0 ? `${iface.speedMbps} Mbps` : ''}</span>
            {liveRate && (liveRate.inBps > 0 || liveRate.outBps > 0) && (
              <span style={{ color: '#8ab4f8', fontFamily: 'monospace', fontSize: '10px' }}>
                ↓{formatRate(liveRate.inBps)} ↑{formatRate(liveRate.outBps)}
              </span>
            )}
          </div>
          {iface.ifAlias && (
            <div className="device-detail-card-interface-desc">{iface.ifAlias}</div>
          )}
          {(iface.inErrors > 0 || iface.outErrors > 0) && (
            <div style={{ color: '#f44336', fontSize: '10px', marginTop: 1 }}>
              {iface.inErrors > 0 && `In errors: ${iface.inErrors}`}
              {iface.inErrors > 0 && iface.outErrors > 0 && ' | '}
              {iface.outErrors > 0 && `Out errors: ${iface.outErrors}`}
            </div>
          )}
        </div>
      );
    });
  };

  // Interfaces section (enrichment interfaces take precedence, then live interfaces)
  const renderInterfaces = () => {
    const hasEnrichmentInterfaces = interfaces && interfaces.length > 0;
    const hasLiveInterfaces = deviceLiveStats && deviceLiveStats.interfaces.length > 0;

    if (!hasEnrichmentInterfaces && !hasLiveInterfaces) return null;

    const ifaceCount = hasEnrichmentInterfaces ? interfaces!.length : deviceLiveStats!.interfaces.length;

    return (
      <div className="device-detail-card-section">
        <button
          className={`device-detail-card-section-header ${interfacesExpanded ? 'expanded' : ''}`}
          onClick={() => setInterfacesExpanded(!interfacesExpanded)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="chevron">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Interfaces ({ifaceCount})</span>
        </button>
        {interfacesExpanded && (
          <div className="device-detail-card-interfaces">
            {hasEnrichmentInterfaces ? (
              interfaces!.map((iface) => (
                <div key={iface.name} className="device-detail-card-interface">
                  <div className="device-detail-card-interface-header">
                    <span className="device-detail-card-interface-name">{iface.name}</span>
                    <span
                      className="device-detail-card-interface-status"
                      style={{ backgroundColor: getStatusColor(iface.status) }}
                    >
                      {iface.status}
                    </span>
                  </div>
                  {iface.speed && (
                    <div className="device-detail-card-interface-speed">{iface.speed}</div>
                  )}
                  {iface.description && (
                    <div className="device-detail-card-interface-desc">{iface.description}</div>
                  )}
                </div>
              ))
            ) : (
              buildLiveInterfaces()
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`device-detail-card ${isDragging ? 'dragging' : ''}`}
      style={{ left: position.x, top: position.y }}
      onMouseDown={handleMouseDown}
    >
      {/* Header - draggable */}
      <div className="device-detail-card-header">
        <div className="device-detail-card-title">
          <span className="device-detail-card-name">{hostname}</span>
          {device.type !== 'unknown' && (
            <span className="device-detail-card-type">{device.type}</span>
          )}
        </div>
        <div className="device-detail-card-header-actions">
          <button
            className="device-detail-card-header-btn"
            onClick={onClose}
            title="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="device-detail-card-body">
        {/* System Information */}
        <div className="device-detail-card-section">
          <div className="device-detail-card-section-title">System Information</div>
          <div className="device-detail-card-info-grid">
            <div className="device-detail-card-info-row">
              <span className="device-detail-card-info-label">Vendor</span>
              <span className="device-detail-card-info-value">{vendor}</span>
            </div>
            <div className="device-detail-card-info-row">
              <span className="device-detail-card-info-label">Model</span>
              <span className="device-detail-card-info-value">{model}</span>
            </div>
            <div className="device-detail-card-info-row">
              <span className="device-detail-card-info-label">OS Version</span>
              <span className="device-detail-card-info-value">{osVersionDisplay}</span>
            </div>
            <div className="device-detail-card-info-row">
              <span className="device-detail-card-info-label">Serial</span>
              <span className="device-detail-card-info-value">{serial}</span>
            </div>
            <div className="device-detail-card-info-row">
              <span className="device-detail-card-info-label">Uptime</span>
              <span className="device-detail-card-info-value">{getUptimeDisplay()}</span>
            </div>
          </div>
        </div>

        {/* Resources */}
        {hasResources && (
          <div className="device-detail-card-section">
            <div className="device-detail-card-section-title">Resources</div>
            <div className="device-detail-card-resources">
              {renderCpuBar()}
              {renderMemoryBar()}
            </div>
          </div>
        )}

        {/* Interfaces */}
        {renderInterfaces()}

        {/* Traceroute Enrichment (shown when device has traceroute metadata) */}
        {device.metadata?.hopNumber && (
          <div className="device-detail-card-section">
            <div className="device-detail-card-section-title">Traceroute Enrichment</div>
            <div className="device-detail-card-info-grid">
              {device.metadata.classification && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">Classification</span>
                  <span className="device-detail-card-info-value" style={{
                    color: device.metadata.classification === 'managed' ? '#4caf50' :
                           device.metadata.classification === 'external' ? '#2196f3' :
                           device.metadata.classification === 'isp-transit' ? '#ff9800' : '#888',
                  }}>
                    {device.metadata.classification}
                  </span>
                </div>
              )}
              {device.metadata.asn && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">ASN</span>
                  <span className="device-detail-card-info-value" style={{ color: '#4a9eff' }}>
                    AS{device.metadata.asn}{device.metadata.asnName ? ` - ${device.metadata.asnName}` : ''}
                  </span>
                </div>
              )}
              {device.metadata.whoisOrg && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">Organization</span>
                  <span className="device-detail-card-info-value">{device.metadata.whoisOrg}</span>
                </div>
              )}
              {device.metadata.whoisCidr && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">CIDR</span>
                  <span className="device-detail-card-info-value" style={{ fontFamily: 'monospace' }}>
                    {device.metadata.whoisCidr}
                  </span>
                </div>
              )}
              {device.metadata.whoisCountry && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">Country</span>
                  <span className="device-detail-card-info-value">{device.metadata.whoisCountry}</span>
                </div>
              )}
              {device.metadata.interfaceName && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">Interface</span>
                  <span className="device-detail-card-info-value" style={{ color: '#4ec9b0', fontFamily: 'monospace' }}>
                    {device.metadata.interfaceName}
                    {device.metadata.interfaceDescription ? ` (${device.metadata.interfaceDescription})` : ''}
                  </span>
                </div>
              )}
              {device.metadata.dnsHostnames && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">DNS</span>
                  <span className="device-detail-card-info-value">{device.metadata.dnsHostnames}</span>
                </div>
              )}
              {device.metadata.netboxUrl && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">NetBox</span>
                  <span className="device-detail-card-info-value" style={{ color: '#4a9eff' }}>
                    Device #{device.netboxId}
                  </span>
                </div>
              )}
              {device.metadata.enrichmentSources && (
                <div className="device-detail-card-info-row">
                  <span className="device-detail-card-info-label">Sources</span>
                  <span className="device-detail-card-info-value" style={{ color: '#888' }}>
                    {device.metadata.enrichmentSources}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="device-detail-card-footer">
        {onOpenInTab && (
          <button className="device-detail-card-btn" onClick={onOpenInTab}>
            Open in Tab
          </button>
        )}
        {enrichment && onSaveToDocs && (
          <button className="device-detail-card-btn" onClick={onSaveToDocs}>
            Save to Docs
          </button>
        )}
        {!enrichment && onOpenTerminal && (
          <button className="device-detail-card-btn primary" onClick={onOpenTerminal}>
            Open Terminal
          </button>
        )}
      </div>
    </div>
  );
}
