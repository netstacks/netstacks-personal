import { getErrorMessage } from '../api/errors'
/**
 * LinkDetailTab - Full-page link detail view for tab display
 *
 * Shows side-by-side comparison of connected interfaces from both endpoints.
 * Used when opening link details in a dedicated tab rather than a floating card.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Connection, Device } from '../types/topology';
import type { LinkEnrichment, InterfaceEnrichment } from '../types/enrichment';
import { formatBytes, getStatusColor } from '../lib/enrichmentHelpers';
import { snmpTryInterfaceStats, type SnmpInterfaceStatsResponse } from '../api/snmp';
import { getCurrentMode } from '../api/client';
import { formatRate } from '../utils/formatRate';
import { saveEnrichmentToDoc } from '../lib/enrichmentExport';
import { sendChatMessage, AiNotConfiguredError, type ChatMessage } from '../api/ai';
import { resolveProvider } from '../lib/aiProviderResolver';
import './LinkDetailTab.css';

interface LinkDetailTabProps {
  /** Connection ID for this link (used by parent for data lookup) */
  connectionId?: string;
  /** Source device */
  sourceDevice?: Device;
  /** Target device */
  targetDevice?: Device;
  /** Source device name (fallback if device not provided) */
  sourceDeviceName: string;
  /** Target device name (fallback if device not provided) */
  targetDeviceName: string;
  /** Link enrichment data */
  linkEnrichment?: LinkEnrichment;
  /** Connection data (for port info if no enrichment) */
  connection?: Connection;
  /** Source device management IP for SNMP polling */
  sourceHost?: string;
  /** Target device management IP for SNMP polling */
  targetHost?: string;
  /** Profile ID for SNMP community resolution */
  profileId?: string;
  /** Source interface name for SNMP polling */
  sourceInterfaceName?: string;
  /** Target interface name for SNMP polling */
  targetInterfaceName?: string;
  /** Source device ID for enterprise mode SNMP polling */
  sourceDeviceId?: string;
  /** Target device ID for enterprise mode SNMP polling */
  targetDeviceId?: string;
  /** Optional jump for the source device's SNMP queries (one of these or
   *  neither — backend rejects both set). Same for target. */
  sourceJumpHostId?: string | null;
  sourceJumpSessionId?: string | null;
  targetJumpHostId?: string | null;
  targetJumpSessionId?: string | null;
}

// SNMP polling state machine
type PollState = 'idle' | 'sample1' | 'waiting' | 'sample2' | 'complete' | 'error';
type SavingState = 'idle' | 'saving' | 'ai-generating';

// Counter wrap threshold for 32-bit counters
const COUNTER_32_MAX = 2 ** 32;

/** Calculate the delta between two counter values, handling 32-bit counter wrap. */
function counterDelta(current: number, previous: number, hcCounters: boolean): number {
  const delta = current - previous;
  if (delta >= 0) return delta;
  if (!hcCounters) return delta + COUNTER_32_MAX;
  return 0;
}

/** Per-endpoint live rate data */
interface EndpointRate {
  inBps: number;
  outBps: number;
}

/** Format speed in human-readable form */
function formatSpeed(speedMbps: number): string {
  if (speedMbps === 0) return '-';
  if (speedMbps >= 1000) return `${(speedMbps / 1000).toFixed(speedMbps % 1000 === 0 ? 0 : 1)} Gbps`;
  return `${speedMbps} Mbps`;
}

// Icons
const Icons = {
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  arrowRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  ),
  arrowLeftRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="8 3 4 7 8 11" />
      <line x1="4" y1="7" x2="20" y2="7" />
      <polyline points="16 21 20 17 16 13" />
      <line x1="20" y1="17" x2="4" y2="17" />
    </svg>
  ),
  network: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="2" width="14" height="6" rx="2" />
      <rect x="5" y="16" width="14" height="6" rx="2" />
      <path d="M12 8v8" />
      <path d="M8 22v-3" />
      <path d="M16 22v-3" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

/**
 * Render a single interface card with all details
 */
function InterfaceCard({
  title,
  deviceName,
  intf,
  liveInBps,
  liveOutBps,
}: {
  title: string;
  deviceName: string;
  intf: InterfaceEnrichment;
  liveInBps?: number;
  liveOutBps?: number;
}) {
  const hasErrors = (intf.rxErrors && intf.rxErrors > 0) || (intf.txErrors && intf.txErrors > 0);
  const hasLiveRates = liveInBps !== undefined && liveOutBps !== undefined;

  return (
    <div className="link-detail-tab-interface-card">
      <div className="link-detail-tab-interface-card-header">
        <span className="link-detail-tab-interface-title">{title}</span>
        <span className="link-detail-tab-interface-device">{deviceName}</span>
      </div>

      <div className="link-detail-tab-interface-card-body">
        {/* Interface name */}
        <div className="link-detail-tab-row">
          <span className="label">Interface</span>
          <span className="value mono">{intf.name}</span>
        </div>

        {/* Description */}
        {intf.description && (
          <div className="link-detail-tab-row">
            <span className="label">Description</span>
            <span className="value">{intf.description}</span>
          </div>
        )}

        {/* Status */}
        <div className="link-detail-tab-row">
          <span className="label">Status</span>
          <span
            className="link-detail-tab-status-badge"
            style={{ backgroundColor: getStatusColor(intf.status) }}
          >
            {intf.status}
          </span>
        </div>

        {/* Speed and Duplex */}
        {(intf.speed || intf.duplex) && (
          <div className="link-detail-tab-row">
            <span className="label">Speed / Duplex</span>
            <span className="value">{intf.speed || '-'} / {intf.duplex || '-'}</span>
          </div>
        )}

        {/* MTU */}
        {intf.mtu && (
          <div className="link-detail-tab-row">
            <span className="label">MTU</span>
            <span className="value">{intf.mtu}</span>
          </div>
        )}

        {/* IP Address */}
        {intf.ipAddress && (
          <div className="link-detail-tab-row">
            <span className="label">IP Address</span>
            <span className="value mono">{intf.ipAddress}</span>
          </div>
        )}

        {/* MAC Address */}
        {intf.macAddress && (
          <div className="link-detail-tab-row">
            <span className="label">MAC Address</span>
            <span className="value mono">{intf.macAddress}</span>
          </div>
        )}

        {/* Live throughput rates */}
        {hasLiveRates && (
          <>
            <div className="link-detail-tab-row-divider" />
            <div className="link-detail-tab-row link-detail-tab-live-rate-row">
              <span className="label">In</span>
              <span className="value link-detail-tab-live-rate-value">{formatRate(liveInBps)}</span>
            </div>
            <div className="link-detail-tab-row link-detail-tab-live-rate-row">
              <span className="label">Out</span>
              <span className="value link-detail-tab-live-rate-value">{formatRate(liveOutBps)}</span>
            </div>
          </>
        )}

        {/* Traffic stats */}
        {(intf.rxBytes !== undefined || intf.txBytes !== undefined) && (
          <>
            <div className="link-detail-tab-row-divider" />
            <div className="link-detail-tab-row">
              <span className="label">RX Bytes</span>
              <span className="value">{formatBytes(intf.rxBytes || 0)}</span>
            </div>
            <div className="link-detail-tab-row">
              <span className="label">TX Bytes</span>
              <span className="value">{formatBytes(intf.txBytes || 0)}</span>
            </div>
          </>
        )}

        {(intf.rxPackets !== undefined || intf.txPackets !== undefined) && (
          <>
            <div className="link-detail-tab-row">
              <span className="label">RX Packets</span>
              <span className="value">{(intf.rxPackets || 0).toLocaleString()}</span>
            </div>
            <div className="link-detail-tab-row">
              <span className="label">TX Packets</span>
              <span className="value">{(intf.txPackets || 0).toLocaleString()}</span>
            </div>
          </>
        )}

        {/* Errors */}
        {(intf.rxErrors !== undefined || intf.txErrors !== undefined) && (
          <>
            <div className="link-detail-tab-row-divider" />
            <div className="link-detail-tab-row">
              <span className="label">RX Errors</span>
              <span className={`value ${(intf.rxErrors || 0) > 0 ? 'error' : ''}`}>
                {intf.rxErrors || 0}
              </span>
            </div>
            <div className="link-detail-tab-row">
              <span className="label">TX Errors</span>
              <span className={`value ${(intf.txErrors || 0) > 0 ? 'error' : ''}`}>
                {intf.txErrors || 0}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Warning if errors */}
      {hasErrors && (
        <div className="link-detail-tab-interface-warning">
          {Icons.warning}
          <span>Interface has errors</span>
        </div>
      )}
    </div>
  );
}

/**
 * Render traffic comparison bar chart
 */
function TrafficComparison({
  sourceIntf,
  destIntf,
  sourceDevice,
  destDevice,
  sourceLiveRate,
  destLiveRate,
}: {
  sourceIntf: InterfaceEnrichment;
  destIntf: InterfaceEnrichment;
  sourceDevice: string;
  destDevice: string;
  sourceLiveRate?: EndpointRate;
  destLiveRate?: EndpointRate;
}) {
  const sourceRxBytes = sourceIntf.rxBytes || 0;
  const sourceTxBytes = sourceIntf.txBytes || 0;
  const destRxBytes = destIntf.rxBytes || 0;
  const destTxBytes = destIntf.txBytes || 0;

  const hasLiveRates = sourceLiveRate !== undefined || destLiveRate !== undefined;

  // No traffic data to compare (and no live rates)
  if (sourceRxBytes === 0 && sourceTxBytes === 0 && destRxBytes === 0 && destTxBytes === 0 && !hasLiveRates) {
    return null;
  }

  const maxBytes = Math.max(sourceRxBytes, sourceTxBytes, destRxBytes, destTxBytes);

  const getBarWidth = (bytes: number) => {
    if (maxBytes === 0) return 0;
    return (bytes / maxBytes) * 100;
  };

  // For live rate bars, find max rate for scaling
  const allRates = [
    sourceLiveRate?.inBps ?? 0, sourceLiveRate?.outBps ?? 0,
    destLiveRate?.inBps ?? 0, destLiveRate?.outBps ?? 0,
  ];
  const maxRate = Math.max(...allRates);

  const getRateBarWidth = (bps: number) => {
    if (maxRate === 0) return 0;
    return (bps / maxRate) * 100;
  };

  return (
    <div className="link-detail-tab-traffic">
      <div className="link-detail-tab-traffic-header">
        {Icons.arrowLeftRight}
        <span>Traffic Comparison</span>
      </div>
      <div className="link-detail-tab-traffic-body">
        {/* Live Throughput section */}
        {hasLiveRates && (
          <>
            <div className="link-detail-tab-traffic-section-label">Live Throughput</div>
            {sourceLiveRate && (
              <>
                <div className="link-detail-tab-traffic-row">
                  <span className="link-detail-tab-traffic-label">{sourceDevice} In</span>
                  <div className="link-detail-tab-traffic-bar-container">
                    <div
                      className="link-detail-tab-traffic-bar live"
                      style={{ width: `${getRateBarWidth(sourceLiveRate.inBps)}%` }}
                    />
                  </div>
                  <span className="link-detail-tab-traffic-value">{formatRate(sourceLiveRate.inBps)}</span>
                </div>
                <div className="link-detail-tab-traffic-row">
                  <span className="link-detail-tab-traffic-label">{sourceDevice} Out</span>
                  <div className="link-detail-tab-traffic-bar-container">
                    <div
                      className="link-detail-tab-traffic-bar live"
                      style={{ width: `${getRateBarWidth(sourceLiveRate.outBps)}%` }}
                    />
                  </div>
                  <span className="link-detail-tab-traffic-value">{formatRate(sourceLiveRate.outBps)}</span>
                </div>
              </>
            )}
            {destLiveRate && (
              <>
                {sourceLiveRate && <div className="link-detail-tab-traffic-separator" />}
                <div className="link-detail-tab-traffic-row">
                  <span className="link-detail-tab-traffic-label">{destDevice} In</span>
                  <div className="link-detail-tab-traffic-bar-container">
                    <div
                      className="link-detail-tab-traffic-bar live"
                      style={{ width: `${getRateBarWidth(destLiveRate.inBps)}%` }}
                    />
                  </div>
                  <span className="link-detail-tab-traffic-value">{formatRate(destLiveRate.inBps)}</span>
                </div>
                <div className="link-detail-tab-traffic-row">
                  <span className="link-detail-tab-traffic-label">{destDevice} Out</span>
                  <div className="link-detail-tab-traffic-bar-container">
                    <div
                      className="link-detail-tab-traffic-bar live"
                      style={{ width: `${getRateBarWidth(destLiveRate.outBps)}%` }}
                    />
                  </div>
                  <span className="link-detail-tab-traffic-value">{formatRate(destLiveRate.outBps)}</span>
                </div>
              </>
            )}
            {(sourceRxBytes > 0 || sourceTxBytes > 0 || destRxBytes > 0 || destTxBytes > 0) && (
              <>
                <div className="link-detail-tab-traffic-separator" />
                <div className="link-detail-tab-traffic-section-label">Cumulative Counters</div>
              </>
            )}
          </>
        )}

        {/* Static byte counters */}
        {(sourceRxBytes > 0 || sourceTxBytes > 0 || destRxBytes > 0 || destTxBytes > 0) && (
          <>
            {/* Source RX */}
            <div className="link-detail-tab-traffic-row">
              <span className="link-detail-tab-traffic-label">{sourceDevice} RX</span>
              <div className="link-detail-tab-traffic-bar-container">
                <div
                  className="link-detail-tab-traffic-bar rx"
                  style={{ width: `${getBarWidth(sourceRxBytes)}%` }}
                />
              </div>
              <span className="link-detail-tab-traffic-value">{formatBytes(sourceRxBytes)}</span>
            </div>

            {/* Source TX */}
            <div className="link-detail-tab-traffic-row">
              <span className="link-detail-tab-traffic-label">{sourceDevice} TX</span>
              <div className="link-detail-tab-traffic-bar-container">
                <div
                  className="link-detail-tab-traffic-bar tx"
                  style={{ width: `${getBarWidth(sourceTxBytes)}%` }}
                />
              </div>
              <span className="link-detail-tab-traffic-value">{formatBytes(sourceTxBytes)}</span>
            </div>

            {/* Separator */}
            <div className="link-detail-tab-traffic-separator" />

            {/* Dest RX */}
            <div className="link-detail-tab-traffic-row">
              <span className="link-detail-tab-traffic-label">{destDevice} RX</span>
              <div className="link-detail-tab-traffic-bar-container">
                <div
                  className="link-detail-tab-traffic-bar rx"
                  style={{ width: `${getBarWidth(destRxBytes)}%` }}
                />
              </div>
              <span className="link-detail-tab-traffic-value">{formatBytes(destRxBytes)}</span>
            </div>

            {/* Dest TX */}
            <div className="link-detail-tab-traffic-row">
              <span className="link-detail-tab-traffic-label">{destDevice} TX</span>
              <div className="link-detail-tab-traffic-bar-container">
                <div
                  className="link-detail-tab-traffic-bar tx"
                  style={{ width: `${getBarWidth(destTxBytes)}%` }}
                />
              </div>
              <span className="link-detail-tab-traffic-value">{formatBytes(destTxBytes)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Card for displaying full SNMP interface stats */
function SnmpStatsCard({ title, deviceName, stats, liveRate }: {
  title: string;
  deviceName: string;
  stats: SnmpInterfaceStatsResponse;
  liveRate?: EndpointRate;
}) {
  const operColor = stats.operStatus === 1 ? '#4caf50' : '#f44336';
  const adminColor = (stats.adminStatus ?? 0) === 1 ? '#4caf50' : (stats.adminStatus ?? 0) === 2 ? '#f44336' : '#6b7280';
  const hasErrors = (stats.inErrors ?? 0) > 0 || (stats.outErrors ?? 0) > 0;
  const hasDiscards = (stats.inDiscards ?? 0) > 0 || (stats.outDiscards ?? 0) > 0;

  return (
    <div className="link-detail-tab-interface-card">
      <div className="link-detail-tab-interface-card-header">
        <span className="link-detail-tab-interface-title">{title}</span>
        <span className="link-detail-tab-interface-device">{deviceName}</span>
      </div>
      <div className="link-detail-tab-interface-card-body">
        {/* Identity */}
        <div className="link-detail-tab-row">
          <span className="label">Interface</span>
          <span className="value mono">{stats.ifDescr}</span>
        </div>
        {stats.ifAlias && (
          <div className="link-detail-tab-row">
            <span className="label">Description</span>
            <span className="value">{stats.ifAlias}</span>
          </div>
        )}
        {stats.ifTypeText && (stats.ifType ?? 0) > 0 && (
          <div className="link-detail-tab-row">
            <span className="label">Type</span>
            <span className="value">{stats.ifTypeText}</span>
          </div>
        )}
        {stats.physAddress && (
          <div className="link-detail-tab-row">
            <span className="label">MAC Address</span>
            <span className="value mono">{stats.physAddress}</span>
          </div>
        )}

        <div className="link-detail-tab-row-divider" />

        {/* Status */}
        {stats.adminStatusText && (
          <div className="link-detail-tab-row">
            <span className="label">Admin Status</span>
            <span className="value" style={{ color: adminColor, fontWeight: 600 }}>{stats.adminStatusText}</span>
          </div>
        )}
        <div className="link-detail-tab-row">
          <span className="label">Oper Status</span>
          <span className="value" style={{ color: operColor, fontWeight: 600 }}>{stats.operStatusText || (stats.operStatus === 1 ? 'up' : 'down')}</span>
        </div>
        <div className="link-detail-tab-row">
          <span className="label">Speed</span>
          <span className="value">{formatSpeed(stats.speedMbps ?? 0)}</span>
        </div>
        {(stats.mtu ?? 0) > 0 && (
          <div className="link-detail-tab-row">
            <span className="label">MTU</span>
            <span className="value">{stats.mtu.toLocaleString()}</span>
          </div>
        )}

        {/* Live rates */}
        {liveRate && (
          <>
            <div className="link-detail-tab-row-divider" />
            <div className="link-detail-tab-row link-detail-tab-live-rate-row">
              <span className="label">In Rate</span>
              <span className="value link-detail-tab-live-rate-value">{formatRate(liveRate.inBps)}</span>
            </div>
            <div className="link-detail-tab-row link-detail-tab-live-rate-row">
              <span className="label">Out Rate</span>
              <span className="value link-detail-tab-live-rate-value">{formatRate(liveRate.outBps)}</span>
            </div>
          </>
        )}

        {/* Traffic counters */}
        <div className="link-detail-tab-row-divider" />
        <div className="link-detail-tab-row">
          <span className="label">In Octets</span>
          <span className="value">{formatBytes(stats.inOctets ?? 0)}{stats.hcCounters ? ' (HC)' : ''}</span>
        </div>
        <div className="link-detail-tab-row">
          <span className="label">Out Octets</span>
          <span className="value">{formatBytes(stats.outOctets ?? 0)}</span>
        </div>

        {/* Packet counters - only show if present */}
        {(stats.inUcastPkts != null || stats.outUcastPkts != null) && (
          <>
            <div className="link-detail-tab-row-divider" />
            <div className="link-detail-tab-row">
              <span className="label">In Unicast Pkts</span>
              <span className="value">{(stats.inUcastPkts ?? 0).toLocaleString()}</span>
            </div>
            <div className="link-detail-tab-row">
              <span className="label">Out Unicast Pkts</span>
              <span className="value">{(stats.outUcastPkts ?? 0).toLocaleString()}</span>
            </div>
          </>
        )}
        {((stats.inMulticastPkts ?? 0) > 0 || (stats.outMulticastPkts ?? 0) > 0) && (
          <>
            <div className="link-detail-tab-row">
              <span className="label">In Multicast Pkts</span>
              <span className="value">{(stats.inMulticastPkts ?? 0).toLocaleString()}</span>
            </div>
            <div className="link-detail-tab-row">
              <span className="label">Out Multicast Pkts</span>
              <span className="value">{(stats.outMulticastPkts ?? 0).toLocaleString()}</span>
            </div>
          </>
        )}
        {((stats.inBroadcastPkts ?? 0) > 0 || (stats.outBroadcastPkts ?? 0) > 0) && (
          <>
            <div className="link-detail-tab-row">
              <span className="label">In Broadcast Pkts</span>
              <span className="value">{(stats.inBroadcastPkts ?? 0).toLocaleString()}</span>
            </div>
            <div className="link-detail-tab-row">
              <span className="label">Out Broadcast Pkts</span>
              <span className="value">{(stats.outBroadcastPkts ?? 0).toLocaleString()}</span>
            </div>
          </>
        )}

        {/* Errors & Discards */}
        <div className="link-detail-tab-row-divider" />
        <div className="link-detail-tab-row">
          <span className="label">In Errors</span>
          <span className={`value ${(stats.inErrors ?? 0) > 0 ? 'error' : ''}`}>{(stats.inErrors ?? 0).toLocaleString()}</span>
        </div>
        <div className="link-detail-tab-row">
          <span className="label">Out Errors</span>
          <span className={`value ${(stats.outErrors ?? 0) > 0 ? 'error' : ''}`}>{(stats.outErrors ?? 0).toLocaleString()}</span>
        </div>
        <div className="link-detail-tab-row">
          <span className="label">In Discards</span>
          <span className={`value ${(stats.inDiscards ?? 0) > 0 ? 'error' : ''}`}>{(stats.inDiscards ?? 0).toLocaleString()}</span>
        </div>
        <div className="link-detail-tab-row">
          <span className="label">Out Discards</span>
          <span className={`value ${(stats.outDiscards ?? 0) > 0 ? 'error' : ''}`}>{(stats.outDiscards ?? 0).toLocaleString()}</span>
        </div>
      </div>

      {/* Warning if errors or discards */}
      {(hasErrors || hasDiscards) && (
        <div className="link-detail-tab-interface-warning">
          {Icons.warning}
          <span>{hasErrors && hasDiscards ? 'Interface has errors and discards' : hasErrors ? 'Interface has errors' : 'Interface has discards'}</span>
        </div>
      )}
    </div>
  );
}

/** Generate markdown for SNMP-only link data */
function generateSnmpLinkMarkdown(
  sourceName: string,
  targetName: string,
  sourceStats?: SnmpInterfaceStatsResponse,
  destStats?: SnmpInterfaceStatsResponse,
  sourceLiveRate?: EndpointRate,
  destLiveRate?: EndpointRate,
): string {
  const timestamp = new Date().toLocaleString();
  let md = `# Link: ${sourceName} <-> ${targetName}\n\n**Generated:** ${timestamp}\n\n`;

  md += `## Connection Overview\n\n`;
  md += `| Property | Source (${sourceName}) | Destination (${targetName}) |\n`;
  md += `|----------|--------|-------------|\n`;
  md += `| Interface | ${sourceStats?.ifDescr || '-'} | ${destStats?.ifDescr || '-'} |\n`;
  md += `| Description | ${sourceStats?.ifAlias || '-'} | ${destStats?.ifAlias || '-'} |\n`;
  md += `| Admin Status | ${sourceStats?.adminStatusText || '-'} | ${destStats?.adminStatusText || '-'} |\n`;
  md += `| Oper Status | ${sourceStats?.operStatusText || '-'} | ${destStats?.operStatusText || '-'} |\n`;
  md += `| Speed | ${sourceStats ? formatSpeed(sourceStats.speedMbps ?? 0) : '-'} | ${destStats ? formatSpeed(destStats.speedMbps ?? 0) : '-'} |\n`;
  md += `| MTU | ${sourceStats?.mtu || '-'} | ${destStats?.mtu || '-'} |\n`;
  md += `| Type | ${sourceStats?.ifTypeText || '-'} | ${destStats?.ifTypeText || '-'} |\n`;
  md += `| MAC Address | ${sourceStats?.physAddress || '-'} | ${destStats?.physAddress || '-'} |\n`;

  const writeEndpoint = (label: string, stats: SnmpInterfaceStatsResponse, rate?: EndpointRate) => {
    md += `\n## ${label}: ${stats.ifDescr}\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Interface | ${stats.ifDescr} |\n`;
    if (stats.ifAlias) md += `| Description | ${stats.ifAlias} |\n`;
    md += `| Admin Status | ${stats.adminStatusText} |\n`;
    md += `| Oper Status | ${stats.operStatusText} |\n`;
    md += `| Speed | ${formatSpeed(stats.speedMbps ?? 0)} |\n`;
    if ((stats.mtu ?? 0) > 0) md += `| MTU | ${stats.mtu} |\n`;
    if (stats.ifTypeText) md += `| Type | ${stats.ifTypeText} |\n`;
    if (stats.physAddress) md += `| MAC Address | ${stats.physAddress} |\n`;
    if (rate) {
      md += `| In Rate | ${formatRate(rate.inBps)} |\n`;
      md += `| Out Rate | ${formatRate(rate.outBps)} |\n`;
    }
    md += `| In Octets | ${formatBytes(stats.inOctets ?? 0)}${stats.hcCounters ? ' (64-bit)' : ''} |\n`;
    md += `| Out Octets | ${formatBytes(stats.outOctets ?? 0)} |\n`;
    if (stats.inUcastPkts != null) md += `| In Unicast Pkts | ${(stats.inUcastPkts ?? 0).toLocaleString()} |\n`;
    if (stats.outUcastPkts != null) md += `| Out Unicast Pkts | ${(stats.outUcastPkts ?? 0).toLocaleString()} |\n`;
    if ((stats.inMulticastPkts ?? 0) > 0 || (stats.outMulticastPkts ?? 0) > 0) {
      md += `| In Multicast Pkts | ${(stats.inMulticastPkts ?? 0).toLocaleString()} |\n`;
      md += `| Out Multicast Pkts | ${(stats.outMulticastPkts ?? 0).toLocaleString()} |\n`;
    }
    if ((stats.inBroadcastPkts ?? 0) > 0 || (stats.outBroadcastPkts ?? 0) > 0) {
      md += `| In Broadcast Pkts | ${(stats.inBroadcastPkts ?? 0).toLocaleString()} |\n`;
      md += `| Out Broadcast Pkts | ${(stats.outBroadcastPkts ?? 0).toLocaleString()} |\n`;
    }
    md += `| In Errors | ${(stats.inErrors ?? 0).toLocaleString()} |\n`;
    md += `| Out Errors | ${(stats.outErrors ?? 0).toLocaleString()} |\n`;
    md += `| In Discards | ${(stats.inDiscards ?? 0).toLocaleString()} |\n`;
    md += `| Out Discards | ${(stats.outDiscards ?? 0).toLocaleString()} |\n`;
  };

  if (sourceStats) writeEndpoint(`Source: ${sourceName}`, sourceStats, sourceLiveRate);
  if (destStats) writeEndpoint(`Destination: ${targetName}`, destStats, destLiveRate);

  // Traffic comparison summary
  if (sourceStats && destStats) {
    md += `\n## Traffic Summary\n\n`;
    md += `| Metric | ${sourceName} | ${targetName} |\n`;
    md += `|--------|--------|-------------|\n`;
    if (sourceLiveRate || destLiveRate) {
      md += `| In Rate | ${sourceLiveRate ? formatRate(sourceLiveRate.inBps) : '-'} | ${destLiveRate ? formatRate(destLiveRate.inBps) : '-'} |\n`;
      md += `| Out Rate | ${sourceLiveRate ? formatRate(sourceLiveRate.outBps) : '-'} | ${destLiveRate ? formatRate(destLiveRate.outBps) : '-'} |\n`;
    }
    md += `| In Octets | ${formatBytes(sourceStats.inOctets)} | ${formatBytes(destStats.inOctets)} |\n`;
    md += `| Out Octets | ${formatBytes(sourceStats.outOctets)} | ${formatBytes(destStats.outOctets)} |\n`;
    md += `| In Errors | ${sourceStats.inErrors} | ${destStats.inErrors} |\n`;
    md += `| Out Errors | ${sourceStats.outErrors} | ${destStats.outErrors} |\n`;
    md += `| In Discards | ${sourceStats.inDiscards} | ${destStats.inDiscards} |\n`;
    md += `| Out Discards | ${sourceStats.outDiscards} | ${destStats.outDiscards} |\n`;
  }

  return md;
}

export default function LinkDetailTab({
  sourceDevice,
  targetDevice,
  sourceDeviceName,
  targetDeviceName,
  linkEnrichment,
  connection,
  sourceHost,
  targetHost,
  profileId,
  sourceJumpHostId,
  sourceJumpSessionId,
  targetJumpHostId,
  targetJumpSessionId,
  sourceInterfaceName,
  targetInterfaceName,
  sourceDeviceId,
  targetDeviceId,
}: LinkDetailTabProps) {
  const isEnterprise = getCurrentMode() === 'enterprise';
  const sourceName = sourceDevice?.name || sourceDeviceName;
  const targetName = targetDevice?.name || targetDeviceName;

  // SNMP polling state
  const [pollState, setPollState] = useState<PollState>('idle');
  const [pollError, setPollError] = useState<string | null>(null);
  const [sourceLiveRate, setSourceLiveRate] = useState<EndpointRate | undefined>(undefined);
  const [destLiveRate, setDestLiveRate] = useState<EndpointRate | undefined>(undefined);
  const [sourceSnmpStats, setSourceSnmpStats] = useState<SnmpInterfaceStatsResponse | undefined>(undefined);
  const [destSnmpStats, setDestSnmpStats] = useState<SnmpInterfaceStatsResponse | undefined>(undefined);
  const [countdown, setCountdown] = useState(0);
  const [localCollectedAt, setLocalCollectedAt] = useState<Date | null>(null);

  // Get collection timestamp (prefer live poll time, fall back to enrichment)
  const collectedAt = localCollectedAt
    ? localCollectedAt.toLocaleString()
    : linkEnrichment?.collectedAt
      ? new Date(linkEnrichment.collectedAt).toLocaleString()
      : 'N/A';
  const cancelledRef = useRef(false);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Save to docs state
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [savingState, setSavingState] = useState<SavingState>('idle');
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const saveDialogRef = useRef<HTMLDivElement>(null);

  // Determine interface names from enrichment or props
  const srcIfName = linkEnrichment?.sourceInterface?.name || sourceInterfaceName;
  const dstIfName = linkEnrichment?.destInterface?.name || targetInterfaceName;

  // Can we poll at least one endpoint?
  const canPoll = Boolean(
    profileId &&
    ((sourceHost && srcIfName) || (targetHost && dstIfName))
  );

  // Close save dialog on click outside
  useEffect(() => {
    if (!saveDialogOpen) return;
    const handler = (e: MouseEvent) => {
      if (saveDialogRef.current && !saveDialogRef.current.contains(e.target as Node)) {
        setSaveDialogOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [saveDialogOpen]);

  // Auto-dismiss save message after 4s
  useEffect(() => {
    if (!saveMessage) return;
    const timer = setTimeout(() => setSaveMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [saveMessage]);

  // Two-sample SNMP polling for both endpoints
  const handleRefresh = useCallback(async () => {
    if (!profileId) return;
    const pollSource = sourceHost && srcIfName;
    const pollTarget = targetHost && dstIfName;
    if (!pollSource && !pollTarget) return;

    // Cancel any previous polling
    cancelledRef.current = true;
    if (staleTimerRef.current) { clearTimeout(staleTimerRef.current); staleTimerRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }

    await new Promise(r => setTimeout(r, 50));
    cancelledRef.current = false;
    setPollError(null);
    setSourceLiveRate(undefined);
    setDestLiveRate(undefined);

    try {
      // Sample 1: poll both endpoints in parallel
      setPollState('sample1');
      const sample1Promises: Promise<SnmpInterfaceStatsResponse>[] = [];
      const endpointKeys: ('source' | 'target')[] = [];

      if (pollSource) {
        sample1Promises.push(snmpTryInterfaceStats(
          isEnterprise
            ? { deviceId: sourceDeviceId, interfaceName: srcIfName! }
            : { host: sourceHost!, profileId, interfaceName: srcIfName!, jump_host_id: sourceJumpHostId, jump_session_id: sourceJumpSessionId }
        ));
        endpointKeys.push('source');
      }
      if (pollTarget) {
        sample1Promises.push(snmpTryInterfaceStats(
          isEnterprise
            ? { deviceId: targetDeviceId, interfaceName: dstIfName! }
            : { host: targetHost!, profileId, interfaceName: dstIfName!, jump_host_id: targetJumpHostId, jump_session_id: targetJumpSessionId }
        ));
        endpointKeys.push('target');
      }

      const sample1Results = await Promise.allSettled(sample1Promises);
      if (cancelledRef.current) return;

      const timestamp1 = Date.now();
      const sample1Map = new Map<string, { stats: SnmpInterfaceStatsResponse; timestamp: number }>();
      endpointKeys.forEach((key, i) => {
        const result = sample1Results[i];
        if (result.status === 'fulfilled') {
          sample1Map.set(key, { stats: result.value, timestamp: timestamp1 });
        }
      });

      if (sample1Map.size === 0) {
        setPollError('No endpoints responded to SNMP polling');
        setPollState('error');
        return;
      }

      // Wait 5 seconds
      setPollState('waiting');
      setCountdown(5);
      await new Promise<void>((resolve) => {
        let remaining = 5;
        countdownRef.current = setInterval(() => {
          remaining--;
          setCountdown(remaining);
          if (remaining <= 0) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            countdownRef.current = null;
            resolve();
          }
        }, 1000);
      });
      if (cancelledRef.current) return;

      // Sample 2: poll only endpoints that responded to sample 1
      setPollState('sample2');
      const sample2Promises: Promise<SnmpInterfaceStatsResponse>[] = [];
      const sample2Keys: ('source' | 'target')[] = [];

      if (sample1Map.has('source') && pollSource) {
        sample2Promises.push(snmpTryInterfaceStats(
          isEnterprise
            ? { deviceId: sourceDeviceId, interfaceName: srcIfName! }
            : { host: sourceHost!, profileId, interfaceName: srcIfName!, jump_host_id: sourceJumpHostId, jump_session_id: sourceJumpSessionId }
        ));
        sample2Keys.push('source');
      }
      if (sample1Map.has('target') && pollTarget) {
        sample2Promises.push(snmpTryInterfaceStats(
          isEnterprise
            ? { deviceId: targetDeviceId, interfaceName: dstIfName! }
            : { host: targetHost!, profileId, interfaceName: dstIfName!, jump_host_id: targetJumpHostId, jump_session_id: targetJumpSessionId }
        ));
        sample2Keys.push('target');
      }

      const sample2Results = await Promise.allSettled(sample2Promises);
      if (cancelledRef.current) return;

      // Calculate rates for each endpoint. If sample 2 fails for an
      // endpoint we still had a successful sample 1 for, surface the
      // sample 1 stats so the user sees partial data instead of an
      // empty "No Interface Data" view. The rate just won't render
      // (it requires two samples). Common cause: one endpoint is a
      // CDP-advertised loopback IP that isn't actually SNMP-reachable.
      const timestamp2 = Date.now();
      sample2Keys.forEach((key, i) => {
        const result = sample2Results[i];
        const s1 = sample1Map.get(key);
        if (!s1) return; // defensive: sample2Keys is derived from sample1Map

        if (result.status === 'fulfilled') {
          const s2 = result.value;
          if (key === 'source') setSourceSnmpStats(s2);
          else setDestSnmpStats(s2);
          const durationSec = (timestamp2 - s1.timestamp) / 1000;
          if (durationSec > 0) {
            const inOctetsDelta = counterDelta(s2.inOctets, s1.stats.inOctets, s2.hcCounters);
            const outOctetsDelta = counterDelta(s2.outOctets, s1.stats.outOctets, s2.hcCounters);
            const rate: EndpointRate = {
              inBps: (inOctetsDelta / durationSec) * 8,
              outBps: (outOctetsDelta / durationSec) * 8,
            };
            if (key === 'source') setSourceLiveRate(rate);
            else setDestLiveRate(rate);
          }
        } else {
          // Sample 2 failed — degrade gracefully to the sample 1 snapshot.
          if (key === 'source') setSourceSnmpStats(s1.stats);
          else setDestSnmpStats(s1.stats);
        }
      });

      setPollState('complete');
      setLocalCollectedAt(new Date());

      // After 30 seconds, mark data as stale
      staleTimerRef.current = setTimeout(() => {
        setPollState('idle');
        staleTimerRef.current = null;
      }, 30000);
    } catch (err) {
      if (cancelledRef.current) return;
      setPollError(getErrorMessage(err, 'SNMP poll failed'));
      setPollState('error');
    }
  }, [sourceHost, targetHost, profileId, srcIfName, dstIfName, isEnterprise, sourceDeviceId, targetDeviceId]);

  // Auto-poll when tab opens if we can poll and have no enrichment data
  useEffect(() => {
    if (canPoll && !linkEnrichment && pollState === 'idle') {
      handleRefresh();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPoll]);

  /** Generate comprehensive markdown from current tab state */
  const generateTabMarkdown = useCallback((): string => {
    // If we have enrichment data, generate from that
    if (linkEnrichment) {
      const timestamp = linkEnrichment.collectedAt
        ? new Date(linkEnrichment.collectedAt).toLocaleString()
        : new Date().toLocaleString();
      let md = `# Link: ${sourceName} <-> ${targetName}\n\n**Generated:** ${timestamp}\n\n`;

      md += `## Connection Overview\n\n`;
      md += `| Property | Source (${sourceName}) | Destination (${targetName}) |\n`;
      md += `|----------|--------|-------------|\n`;
      md += `| Interface | ${linkEnrichment.sourceInterface.name} | ${linkEnrichment.destInterface.name} |\n`;
      md += `| Status | ${linkEnrichment.sourceInterface.status} | ${linkEnrichment.destInterface.status} |\n`;
      md += `| Speed | ${linkEnrichment.sourceInterface.speed || '-'} | ${linkEnrichment.destInterface.speed || '-'} |\n`;
      md += `| Duplex | ${linkEnrichment.sourceInterface.duplex || '-'} | ${linkEnrichment.destInterface.duplex || '-'} |\n`;
      md += `| MTU | ${linkEnrichment.sourceInterface.mtu || '-'} | ${linkEnrichment.destInterface.mtu || '-'} |\n`;

      // Append SNMP data if available
      if (sourceSnmpStats) {
        md += `\n## Source SNMP Data: ${sourceName}\n\n`;
        md += generateSnmpSection(sourceSnmpStats, sourceLiveRate);
      }
      if (destSnmpStats) {
        md += `\n## Destination SNMP Data: ${targetName}\n\n`;
        md += generateSnmpSection(destSnmpStats, destLiveRate);
      }

      return md;
    }

    // SNMP-only data
    return generateSnmpLinkMarkdown(sourceName, targetName, sourceSnmpStats, destSnmpStats, sourceLiveRate, destLiveRate);
  }, [linkEnrichment, sourceName, targetName, sourceSnmpStats, destSnmpStats, sourceLiveRate, destLiveRate]);

  /** Save basic markdown doc */
  const handleBasicSave = useCallback(async () => {
    setSavingState('saving');
    setSaveMessage(null);
    setSaveDialogOpen(false);
    try {
      const markdown = generateTabMarkdown();
      const result = await saveEnrichmentToDoc(markdown, `link_${sourceName}_to_${targetName}`);
      if (result.success) {
        setSaveMessage({ type: 'success', text: 'Saved to Docs' });
      } else {
        setSaveMessage({ type: 'error', text: result.error || 'Failed to save' });
      }
    } catch (err) {
      setSaveMessage({ type: 'error', text: getErrorMessage(err, 'Save failed') });
    } finally {
      setSavingState('idle');
    }
  }, [generateTabMarkdown, sourceName, targetName]);

  /** Send to AI for enriched documentation, then save */
  const handleAiEnhancedSave = useCallback(async () => {
    setSavingState('ai-generating');
    setSaveMessage(null);
    setSaveDialogOpen(false);
    try {
      const currentData = generateTabMarkdown();
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are a network documentation specialist. Generate comprehensive, well-structured markdown documentation for a network link between two devices. Include:
- Executive summary / link overview
- Health assessment based on interface status, errors, discards, and utilization
- Interface analysis for both endpoints highlighting any concerns
- Traffic analysis comparing both sides of the link
- Recommendations based on current state (MTU mismatches, error trends, capacity concerns)
- Keep all factual data accurate — do not invent data not present in the input
- Output ONLY the markdown document, no preamble or explanation`,
        },
        {
          role: 'user',
          content: `Generate enhanced documentation for this network link. Here is the current link data:\n\n${currentData}`,
        },
      ];

      const { provider, model } = resolveProvider();
      const aiResponse = await sendChatMessage(messages, {
        context: {
          link: {
            sourceDevice: sourceName,
            targetDevice: targetName,
            sourceHost,
            targetHost,
          },
        },
        provider,
        model,
      });

      const result = await saveEnrichmentToDoc(aiResponse, `link_${sourceName}_to_${targetName}_ai_enhanced`);
      if (result.success) {
        setSaveMessage({ type: 'success', text: 'AI-enhanced doc saved' });
      } else {
        setSaveMessage({ type: 'error', text: result.error || 'Failed to save AI doc' });
      }
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        setSaveMessage({ type: 'error', text: 'AI not configured — add API key in Settings > AI' });
      } else {
        setSaveMessage({ type: 'error', text: getErrorMessage(err, 'AI generation failed') });
      }
    } finally {
      setSavingState('idle');
    }
  }, [generateTabMarkdown, sourceName, targetName, sourceHost, targetHost]);

  return (
    <div className="link-detail-tab">
      {/* Header */}
      <div className="link-detail-tab-header">
        <div className="link-detail-tab-header-info">
          <div className="link-detail-tab-title">
            {Icons.link}
            <span>{sourceName}</span>
            <span className="link-detail-tab-title-arrow">&harr;</span>
            <span>{targetName}</span>
          </div>
          <div className="link-detail-tab-meta">
            <span className="link-detail-tab-collected">Last collected: {collectedAt}</span>
          </div>
        </div>
        <div className="link-detail-tab-header-actions">
          <button
            className={`link-detail-tab-action-btn ${pollState !== 'idle' && pollState !== 'complete' && pollState !== 'error' ? 'polling' : ''}`}
            title={canPoll ? 'Refresh SNMP interface stats for both endpoints' : 'SNMP not available (no host or profile)'}
            disabled={!canPoll || (pollState !== 'idle' && pollState !== 'complete' && pollState !== 'error')}
            onClick={handleRefresh}
          >
            {(pollState === 'sample1' || pollState === 'sample2') ? (
              <span className="link-detail-tab-spinner" />
            ) : pollState === 'waiting' ? (
              <span className="link-detail-tab-countdown">{countdown}</span>
            ) : (
              Icons.refresh
            )}
            <span>
              {pollState === 'sample1' ? 'Polling...' :
               pollState === 'waiting' ? 'Waiting...' :
               pollState === 'sample2' ? 'Sampling...' :
               'Refresh'}
            </span>
          </button>
          <div className="link-detail-tab-save-wrapper" ref={saveDialogRef}>
            <button
              className={`link-detail-tab-action-btn ${savingState !== 'idle' ? 'polling' : ''}`}
              onClick={() => {
                if (savingState === 'idle') setSaveDialogOpen(!saveDialogOpen);
              }}
              disabled={savingState !== 'idle'}
              title="Save to Docs"
            >
              {savingState !== 'idle' ? (
                <span className="link-detail-tab-spinner" />
              ) : (
                Icons.save
              )}
              <span>
                {savingState === 'saving' ? 'Saving...' :
                 savingState === 'ai-generating' ? 'AI Generating...' :
                 'Save to Docs'}
              </span>
            </button>
            {saveDialogOpen && (
              <div className="link-detail-tab-save-dialog">
                <button className="link-detail-tab-save-option" onClick={handleBasicSave}>
                  {Icons.save}
                  <div className="link-detail-tab-save-option-text">
                    <span className="link-detail-tab-save-option-title">Save to Docs</span>
                    <span className="link-detail-tab-save-option-desc">Markdown from current tab state</span>
                  </div>
                </button>
                <button className="link-detail-tab-save-option" onClick={handleAiEnhancedSave}>
                  {Icons.ai}
                  <div className="link-detail-tab-save-option-text">
                    <span className="link-detail-tab-save-option-title">AI Enhanced Doc</span>
                    <span className="link-detail-tab-save-option-desc">AI-generated analysis and recommendations</span>
                  </div>
                </button>
              </div>
            )}
            {saveMessage && (
              <div className={`link-detail-tab-save-message ${saveMessage.type}`}>
                {saveMessage.text}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Poll error banner */}
      {pollState === 'error' && pollError && (
        <div className="link-detail-tab-poll-error">
          SNMP Error: {pollError}
        </div>
      )}

      {/* Content */}
      <div className="link-detail-tab-content">
        {linkEnrichment ? (
          <>
            {/* Side-by-side interfaces */}
            <div className="link-detail-tab-interfaces">
              <InterfaceCard
                title="Source"
                deviceName={sourceName}
                intf={linkEnrichment.sourceInterface}
                liveInBps={sourceLiveRate?.inBps}
                liveOutBps={sourceLiveRate?.outBps}
              />
              <div className="link-detail-tab-connection-line">
                <div className="link-detail-tab-connection-arrow">
                  {Icons.arrowLeftRight}
                </div>
              </div>
              <InterfaceCard
                title="Destination"
                deviceName={targetName}
                intf={linkEnrichment.destInterface}
                liveInBps={destLiveRate?.inBps}
                liveOutBps={destLiveRate?.outBps}
              />
            </div>

            {/* Traffic comparison */}
            <TrafficComparison
              sourceIntf={linkEnrichment.sourceInterface}
              destIntf={linkEnrichment.destInterface}
              sourceDevice={sourceName}
              destDevice={targetName}
              sourceLiveRate={sourceLiveRate}
              destLiveRate={destLiveRate}
            />

            {/* SNMP extended data below enrichment when available */}
            {(sourceSnmpStats || destSnmpStats) && (
              <div className="link-detail-tab-snmp-extended">
                <div className="link-detail-tab-traffic-header">
                  {Icons.network}
                  <span>SNMP Extended Data</span>
                </div>
                <div className="link-detail-tab-interfaces" style={{ padding: '16px' }}>
                  {sourceSnmpStats && (
                    <SnmpStatsCard
                      title="Source SNMP"
                      deviceName={sourceName}
                      stats={sourceSnmpStats}
                      liveRate={sourceLiveRate}
                    />
                  )}
                  {sourceSnmpStats && destSnmpStats && (
                    <div className="link-detail-tab-connection-line">
                      <div className="link-detail-tab-connection-arrow">
                        {Icons.arrowLeftRight}
                      </div>
                    </div>
                  )}
                  {destSnmpStats && (
                    <SnmpStatsCard
                      title="Dest SNMP"
                      deviceName={targetName}
                      stats={destSnmpStats}
                      liveRate={destLiveRate}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        ) : (sourceSnmpStats || destSnmpStats) ? (
          /* No enrichment but SNMP data available - show live stats */
          <>
            <div className="link-detail-tab-interfaces">
              {sourceSnmpStats ? (
                <SnmpStatsCard
                  title="Source"
                  deviceName={sourceName}
                  stats={sourceSnmpStats}
                  liveRate={sourceLiveRate}
                />
              ) : (
                <div className="link-detail-tab-interface-card">
                  <div className="link-detail-tab-interface-card-header">
                    <span className="link-detail-tab-interface-title">Source</span>
                    <span className="link-detail-tab-interface-device">{sourceName}</span>
                  </div>
                  <div className="link-detail-tab-interface-card-body" style={{ opacity: 0.5, textAlign: 'center', padding: '20px' }}>
                    SNMP unavailable
                  </div>
                </div>
              )}
              <div className="link-detail-tab-connection-line">
                <div className="link-detail-tab-connection-arrow">
                  {Icons.arrowLeftRight}
                </div>
              </div>
              {destSnmpStats ? (
                <SnmpStatsCard
                  title="Destination"
                  deviceName={targetName}
                  stats={destSnmpStats}
                  liveRate={destLiveRate}
                />
              ) : (
                <div className="link-detail-tab-interface-card">
                  <div className="link-detail-tab-interface-card-header">
                    <span className="link-detail-tab-interface-title">Destination</span>
                    <span className="link-detail-tab-interface-device">{targetName}</span>
                  </div>
                  <div className="link-detail-tab-interface-card-body" style={{ opacity: 0.5, textAlign: 'center', padding: '20px' }}>
                    SNMP unavailable
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          /* No enrichment, no SNMP data */
          <div className="link-detail-tab-no-data">
            <div className="link-detail-tab-no-data-icon">{Icons.network}</div>
            <h2>{(pollState === 'sample1' || pollState === 'waiting' || pollState === 'sample2') ? 'Collecting Interface Data...' : 'No Interface Data'}</h2>
            <p>
              {(pollState === 'sample1' || pollState === 'waiting' || pollState === 'sample2')
                ? 'Polling SNMP interface statistics from both endpoints...'
                : 'Click Refresh to poll SNMP interface statistics.'}
            </p>

            {/* Show basic connection info if available */}
            {connection && (connection.sourceInterface || connection.targetInterface) && (
              <div className="link-detail-tab-basic-info">
                <div className="link-detail-tab-basic-info-title">Connection Information</div>
                <div className="link-detail-tab-basic-info-grid">
                  <div className="link-detail-tab-basic-info-item">
                    <span className="label">Source Device</span>
                    <span className="value">{sourceName}</span>
                  </div>
                  {connection.sourceInterface && (
                    <div className="link-detail-tab-basic-info-item">
                      <span className="label">Source Interface</span>
                      <span className="value">{connection.sourceInterface}</span>
                    </div>
                  )}
                  <div className="link-detail-tab-basic-info-item">
                    <span className="label">Target Device</span>
                    <span className="value">{targetName}</span>
                  </div>
                  {connection.targetInterface && (
                    <div className="link-detail-tab-basic-info-item">
                      <span className="label">Target Interface</span>
                      <span className="value">{connection.targetInterface}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Helper to generate a markdown section for one SNMP endpoint */
function generateSnmpSection(stats: SnmpInterfaceStatsResponse, rate?: EndpointRate): string {
  let md = `| Metric | Value |\n|--------|-------|\n`;
  md += `| Interface | ${stats.ifDescr} |\n`;
  if (stats.ifAlias) md += `| Description | ${stats.ifAlias} |\n`;
  md += `| Admin Status | ${stats.adminStatusText} |\n`;
  md += `| Oper Status | ${stats.operStatusText} |\n`;
  md += `| Speed | ${formatSpeed(stats.speedMbps)} |\n`;
  if (stats.mtu > 0) md += `| MTU | ${stats.mtu} |\n`;
  md += `| Type | ${stats.ifTypeText} |\n`;
  if (stats.physAddress) md += `| MAC Address | ${stats.physAddress} |\n`;
  if (rate) {
    md += `| In Rate | ${formatRate(rate.inBps)} |\n`;
    md += `| Out Rate | ${formatRate(rate.outBps)} |\n`;
  }
  md += `| In Octets | ${formatBytes(stats.inOctets)} |\n`;
  md += `| Out Octets | ${formatBytes(stats.outOctets)} |\n`;
  md += `| In Unicast Pkts | ${stats.inUcastPkts.toLocaleString()} |\n`;
  md += `| Out Unicast Pkts | ${stats.outUcastPkts.toLocaleString()} |\n`;
  md += `| In Errors | ${stats.inErrors.toLocaleString()} |\n`;
  md += `| Out Errors | ${stats.outErrors.toLocaleString()} |\n`;
  md += `| In Discards | ${stats.inDiscards.toLocaleString()} |\n`;
  md += `| Out Discards | ${stats.outDiscards.toLocaleString()} |\n`;
  return md;
}
