/**
 * portStatsEdge.ts — helpers for visualizing LibreNMS-derived port stats
 * on topology edges (color by utilization, tooltip text).
 *
 * Distinct from utils/linkHealth.ts: linkHealth derives from live SNMP
 * stats (computed each tick), while these helpers consume the LibreNMS
 * snapshot stored on TopologyEnrichmentState.linkStats by
 * tracerouteEnrichment.ts. The two can coexist — live SNMP wins when
 * present because it's more current.
 */

import type { LinkPortStats } from '../types/tracerouteEnrichment';
import { formatRate } from './formatRate';

/** Threshold-keyed color palette for utilization-based edge tint. */
export const PORT_STATS_COLORS = {
  unknown: '#888888',   // gray — no stats
  ok: '#4caf50',        // green — < 40%
  warn: '#ffc107',      // yellow — 40-70%
  high: '#ff9800',      // orange — 70-90%
  critical: '#f44336',  // red — > 90%
} as const;

/**
 * Compute the utilization percentage (0-100) for a link given its stats.
 * Returns null when speed or both rates are missing.
 */
export function computePortUtilizationPct(stats: LinkPortStats | undefined): number | null {
  if (!stats) return null;
  const speed = stats.speed_bps;
  if (!speed || speed <= 0) return null;
  const inRate = stats.in_rate_bps ?? 0;
  const outRate = stats.out_rate_bps ?? 0;
  const maxRate = Math.max(inRate, outRate);
  return (maxRate / speed) * 100;
}

/**
 * Pick an edge color for a connection based on its LibreNMS port stats.
 * Returns the gray "unknown" color when no stats are available, which
 * lets callers fall back to the existing live/health color when desired.
 */
export function getEdgeColorFromPortStats(stats: LinkPortStats | undefined): string {
  if (!stats) return PORT_STATS_COLORS.unknown;
  // Down operStatus trumps utilization
  if (stats.oper_status && stats.oper_status.toLowerCase() === 'down') {
    return PORT_STATS_COLORS.unknown;
  }
  const pct = computePortUtilizationPct(stats);
  if (pct === null) return PORT_STATS_COLORS.unknown;
  if (pct >= 90) return PORT_STATS_COLORS.critical;
  if (pct >= 70) return PORT_STATS_COLORS.high;
  if (pct >= 40) return PORT_STATS_COLORS.warn;
  return PORT_STATS_COLORS.ok;
}

/**
 * Render a multi-line summary suitable for tooltips. Returns null if the
 * link has no stats so the caller can show its "no data" fallback. Lines
 * are joined with \n; consumer is responsible for whitespace handling.
 */
export function formatPortStatsTooltip(
  localPort: string | undefined,
  remotePort: string | undefined,
  stats: LinkPortStats | undefined
): string | null {
  if (!stats) return null;
  const lines: string[] = [];
  if (localPort || remotePort) {
    lines.push(`${localPort ?? '?'} → ${remotePort ?? '?'}`);
  }
  if (stats.in_rate_bps !== undefined) {
    lines.push(`In:  ${formatRate(stats.in_rate_bps)}`);
  }
  if (stats.out_rate_bps !== undefined) {
    lines.push(`Out: ${formatRate(stats.out_rate_bps)}`);
  }
  if (stats.speed_bps !== undefined) {
    lines.push(`Speed: ${formatRate(stats.speed_bps)}`);
  }
  const inErr = stats.in_errors ?? 0;
  const outErr = stats.out_errors ?? 0;
  if (stats.in_errors !== undefined || stats.out_errors !== undefined) {
    lines.push(`Errors: in ${inErr} / out ${outErr}`);
  }
  if (stats.oper_status) {
    lines.push(`Status: ${stats.oper_status}`);
  }
  if (lines.length === 0) return null;
  return lines.join('\n');
}
