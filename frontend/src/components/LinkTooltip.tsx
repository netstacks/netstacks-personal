/**
 * LinkTooltip - Hover tooltip showing quick link/connection info
 *
 * Displays interface data from both connected devices when enrichment is available.
 * Falls back to device names when no enrichment data exists.
 */

import type { Connection, Device } from '../types/topology';
import type { LinkEnrichment } from '../types/enrichment';
import type { LinkPortStats } from '../types/tracerouteEnrichment';
import { getStatusColor } from '../lib/enrichmentHelpers';
import { formatPortStatsTooltip } from '../utils/portStatsEdge';
import { useHostnameFormatter } from '../hooks/useHostnameFormatter';
import './LinkTooltip.css';

interface LinkTooltipProps {
  /** The connection being hovered */
  connection: Connection;
  /** Source device of the connection */
  sourceDevice: Device;
  /** Target device of the connection */
  targetDevice: Device;
  /** Link enrichment data (interface details from both ends) */
  linkEnrichment?: LinkEnrichment;
  /** LibreNMS port stats for this link (when "Show port stats" is on) */
  portStats?: LinkPortStats;
  /** When true, the user has enabled port stats; if no stats arrived yet
   *  the tooltip nudges them to enable LibreNMS enrichment. */
  portStatsRequested?: boolean;
  /** Screen position for tooltip placement */
  position: { x: number; y: number };
  /** Whether the tooltip should be visible */
  visible: boolean;
}

/**
 * Format speed and duplex into a single string
 */
function formatSpeedDuplex(speed?: string, duplex?: string): string {
  if (!speed && !duplex) return '';
  if (speed && duplex) return `${speed} ${duplex}`;
  return speed || duplex || '';
}

export default function LinkTooltip({
  connection,
  sourceDevice,
  targetDevice,
  linkEnrichment,
  portStats,
  portStatsRequested,
  position,
  visible,
}: LinkTooltipProps) {
  const formatName = useHostnameFormatter();

  if (!visible) return null;

  // Adjust position to keep tooltip in viewport
  const tooltipWidth = 280;
  const tooltipHeight = 100;
  const adjustedX = Math.min(position.x + 15, window.innerWidth - tooltipWidth - 20);
  const adjustedY = Math.min(position.y + 15, window.innerHeight - tooltipHeight - 20);

  // LibreNMS port-stats summary (separate from the CLI-derived linkEnrichment block above)
  const portStatsText = formatPortStatsTooltip(
    connection.sourceInterface,
    connection.targetInterface,
    portStats
  );

  // When enrichment is available, show interface details
  if (linkEnrichment) {
    const { sourceInterface, destInterface } = linkEnrichment;
    const sourceSpeedDuplex = formatSpeedDuplex(sourceInterface.speed, sourceInterface.duplex);
    const destSpeedDuplex = formatSpeedDuplex(destInterface.speed, destInterface.duplex);

    return (
      <div
        className="link-tooltip"
        style={{
          left: Math.max(20, adjustedX),
          top: Math.max(20, adjustedY),
        }}
      >
        {/* Interface names */}
        <div className="link-tooltip-interfaces">
          <span className="link-tooltip-intf">{sourceInterface.name}</span>
          <span className="link-tooltip-arrow">&#8596;</span>
          <span className="link-tooltip-intf">{destInterface.name}</span>
        </div>

        {/* Speed and duplex info */}
        {(sourceSpeedDuplex || destSpeedDuplex) && (
          <div className="link-tooltip-speed">
            {sourceSpeedDuplex || destSpeedDuplex}
          </div>
        )}

        {/* Status badges */}
        <div className="link-tooltip-status">
          <span
            className="link-tooltip-status-badge"
            style={{ backgroundColor: getStatusColor(sourceInterface.status) }}
          >
            {sourceInterface.status}
          </span>
          <span className="link-tooltip-status-separator">/</span>
          <span
            className="link-tooltip-status-badge"
            style={{ backgroundColor: getStatusColor(destInterface.status) }}
          >
            {destInterface.status}
          </span>
        </div>

        {/* LibreNMS port stats block — only shown when user toggled "Show port stats" */}
        {portStatsText && (
          <div className="link-tooltip-port-stats" style={{ marginTop: 6, whiteSpace: 'pre-line', opacity: 0.85 }}>
            {portStatsText}
          </div>
        )}
        {!portStatsText && portStatsRequested && (
          <div className="link-tooltip-port-stats" style={{ marginTop: 6, opacity: 0.7, fontStyle: 'italic' }}>
            Port stats not available — re-run Enrich with LibreNMS selected.
          </div>
        )}
      </div>
    );
  }

  // Fallback when no enrichment data
  return (
    <div
      className="link-tooltip link-tooltip-no-data"
      style={{
        left: Math.max(20, adjustedX),
        top: Math.max(20, adjustedY),
      }}
    >
      <div className="link-tooltip-devices">
        <span className="link-tooltip-device">{formatName(sourceDevice.name)}</span>
        <span className="link-tooltip-arrow">&#8596;</span>
        <span className="link-tooltip-device">{formatName(targetDevice.name)}</span>
      </div>
      {connection.sourceInterface && connection.targetInterface ? (
        <div className="link-tooltip-interfaces-simple">
          {connection.sourceInterface} - {connection.targetInterface}
        </div>
      ) : (
        <div className="link-tooltip-hint">No interface data</div>
      )}
      {portStatsText && (
        <div className="link-tooltip-port-stats" style={{ marginTop: 6, whiteSpace: 'pre-line', opacity: 0.85 }}>
          {portStatsText}
        </div>
      )}
      {!portStatsText && portStatsRequested && (
        <div className="link-tooltip-port-stats" style={{ marginTop: 6, opacity: 0.7, fontStyle: 'italic' }}>
          Port stats not available — re-run Enrich with LibreNMS selected.
        </div>
      )}
    </div>
  );
}
