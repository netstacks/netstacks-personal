/**
 * linkHealth.ts - Shared link health scoring, speed formatting, and stats lookup
 *
 * Used by both 2D (TopologyCanvas.tsx) and 3D (ConnectionLine3D.tsx) canvases
 * to provide consistent link health visualization.
 */

import type { LiveStatsMap, InterfaceLiveStats } from '../hooks/useTopologyLive';

/** Result of computing link health from live SNMP stats */
export interface LinkHealth {
  /** Health score 0-100 (100 = perfect) */
  score: number;
  /** Color based on score: green (>=80), orange (>=50), red (<50), gray (down) */
  color: string;
  /** Line width in pixels: thicker = worse health */
  width: number;
  /** Whether the link should pulse (score < 50) */
  needsPulse: boolean;
  /** Whether any side has errors */
  hasErrors: boolean;
  /** Whether any interface is down */
  isDown: boolean;
  /** Total errors on source side */
  sourceErrors: number;
  /** Total errors on target side */
  targetErrors: number;
  /** Source discards */
  sourceDiscards: number;
  /** Target discards */
  targetDiscards: number;
  /** Max utilization % across all directions */
  maxUtilization: number;
}

/**
 * Compute link health from live SNMP stats on both sides of the connection.
 * Returns undefined if no live data is available.
 *
 * Scoring:
 * - Start at 100
 * - Down interface: score = 0
 * - Errors: -30 per side with errors
 * - Discards: -15 per side with discards
 * - Utilization > 90%: -40
 * - Utilization > 75%: -20
 */
export function computeLinkHealth(
  sourceStats: InterfaceLiveStats | undefined,
  targetStats: InterfaceLiveStats | undefined
): LinkHealth | undefined {
  if (!sourceStats && !targetStats) return undefined;

  const srcDown = sourceStats ? sourceStats.operStatus !== 1 : false;
  const tgtDown = targetStats ? targetStats.operStatus !== 1 : false;
  const isDown = srcDown || tgtDown;

  const sourceErrors = (sourceStats?.inErrors ?? 0) + (sourceStats?.outErrors ?? 0);
  const targetErrors = (targetStats?.inErrors ?? 0) + (targetStats?.outErrors ?? 0);
  const sourceDiscards = (sourceStats?.inDiscards ?? 0) + (sourceStats?.outDiscards ?? 0);
  const targetDiscards = (targetStats?.inDiscards ?? 0) + (targetStats?.outDiscards ?? 0);
  const hasErrors = sourceErrors > 0 || targetErrors > 0;

  const maxUtilization = Math.max(
    sourceStats?.utilizationIn ?? 0,
    sourceStats?.utilizationOut ?? 0,
    targetStats?.utilizationIn ?? 0,
    targetStats?.utilizationOut ?? 0
  );

  // Score calculation
  let score: number;
  if (isDown) {
    score = 0;
  } else {
    score = 100;
    if (sourceErrors > 0) score -= 30;
    if (targetErrors > 0) score -= 30;
    if (sourceDiscards > 0) score -= 15;
    if (targetDiscards > 0) score -= 15;
    if (maxUtilization > 90) score -= 40;
    else if (maxUtilization > 75) score -= 20;
    score = Math.max(0, score);
  }

  // Color from score
  let color: string;
  if (isDown) color = '#666666';       // gray
  else if (score >= 80) color = '#4caf50'; // green
  else if (score >= 50) color = '#ff9800'; // orange
  else color = '#f44336';                  // red

  // Width: worse health = thicker line (more attention)
  let width: number;
  if (score >= 80) width = 2;
  else if (score >= 50) width = 3;
  else if (score >= 25) width = 4;
  else width = 5;

  return {
    score,
    color,
    width,
    needsPulse: score < 50,
    hasErrors,
    isDown,
    sourceErrors,
    targetErrors,
    sourceDiscards,
    targetDiscards,
    maxUtilization,
  };
}

/**
 * Format an interface speed in Mbps to a compact string.
 * e.g. 100 -> "100M", 1000 -> "1G", 10000 -> "10G"
 */
export function formatLinkSpeed(speedMbps: number): string {
  if (speedMbps <= 0) return '';
  if (speedMbps < 1000) return `${speedMbps}M`;
  if (speedMbps < 1000000) return `${speedMbps / 1000}G`;
  return `${speedMbps / 1000000}T`;
}

/**
 * Format speed pair showing both sides.
 * Returns "1G" if both match, or "1G / 10G" if mismatched.
 */
export function formatSpeedPair(srcSpeedMbps: number | undefined, tgtSpeedMbps: number | undefined): string {
  const src = srcSpeedMbps ?? 0;
  const tgt = tgtSpeedMbps ?? 0;
  if (src <= 0 && tgt <= 0) return '';
  if (src <= 0) return formatLinkSpeed(tgt);
  if (tgt <= 0) return formatLinkSpeed(src);
  if (src === tgt) return formatLinkSpeed(src);
  return `${formatLinkSpeed(src)} / ${formatLinkSpeed(tgt)}`;
}

/**
 * Get a status arrow character for an interface operational status.
 * operStatus: 1 = up, 2 = down, anything else = unknown
 */
export function statusArrow(operStatus: number | undefined): string {
  if (operStatus === 1) return '\u25B2'; // ▲ up
  if (operStatus === 2) return '\u25BC'; // ▼ down
  return '\u25CF'; // ● unknown
}

/**
 * Find live stats for a connection interface.
 * Tries exact match on "host:ifName", then checks if the abbreviated
 * connection interface name is a prefix of any ifDescr key for that host.
 */
export function findLiveStatsForInterface(
  liveStats: LiveStatsMap,
  hostIp: string | undefined,
  interfaceName: string | undefined
): InterfaceLiveStats | undefined {
  if (!hostIp || !interfaceName) return undefined;

  // Try exact match first
  const exactKey = `${hostIp}:${interfaceName}`;
  const exact = liveStats.get(exactKey);
  if (exact) return exact;

  // Try matching abbreviated name against full ifDescr keys
  const abbrevLower = interfaceName.toLowerCase();
  const expansions: [string, string][] = [
    ['gigabitethernet', 'gi'],
    ['tengigabitethernet', 'te'],
    ['fastethernet', 'fa'],
    ['ethernet', 'eth'],
    ['hundredgige', 'hu'],
    ['fortygigabitethernet', 'fo'],
  ];

  for (const [key, stats] of liveStats) {
    if (!key.startsWith(hostIp + ':')) continue;
    const ifDescr = stats.ifDescr.toLowerCase();
    if (ifDescr === abbrevLower) return stats;

    for (const [full, abbr] of expansions) {
      if (ifDescr.startsWith(full) && abbrevLower.startsWith(abbr)) {
        const suffix = abbrevLower.slice(abbr.length);
        if (ifDescr.endsWith(suffix)) return stats;
      }
    }
  }

  return undefined;
}
