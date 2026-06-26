/**
 * useTopologyLive - WebSocket hook for real-time SNMP topology enrichment
 *
 * Connects to /ws/topology-live, subscribes with device/interface targets,
 * and computes per-interface throughput rates from counter deltas.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { getClient } from '../api/client';
import { computeRateStats, type PreviousSample } from '../lib/topologyRateCalc';

// === Public Types ===

/** A device target with interfaces to poll via SNMP */
export interface TopologyLiveTarget {
  host: string;
  profileId: string;
  interfaces: string[]; // interface names from connection sourceInterface/targetInterface
}

/** Computed live stats for a single interface */
export interface InterfaceLiveStats {
  ifDescr: string;
  operStatus: number;
  operStatusText: string;
  speedMbps: number;
  inBps: number;       // computed rate (bits per second)
  outBps: number;      // computed rate
  inErrors: number;    // raw counter from latest sample
  outErrors: number;
  inDiscards: number;
  outDiscards: number;
  utilizationIn: number;   // percentage 0-100
  utilizationOut: number;
  hcCounters: boolean;
}

/** Map keyed by "host:ifDescr" for O(1) lookup */
export type LiveStatsMap = Map<string, InterfaceLiveStats>;

/** Interface summary from device_stats message */
export interface DeviceInterfaceSummary {
  total: number;
  up: number;
  down: number;
  adminDown: number;
  totalInErrors: number;
  totalOutErrors: number;
  totalInDiscards: number;
  totalOutDiscards: number;
}

/** Per-interface info from device_stats message */
export interface DeviceInterfaceInfo {
  ifDescr: string;
  ifAlias: string;
  operStatus: number;
  adminStatus: number;
  speedMbps: number;
  inOctets: number;
  outOctets: number;
  inErrors: number;
  outErrors: number;
}

/** Device-level live stats aggregated from SNMP */
export interface DeviceLiveStats {
  host: string;
  timestamp: string;
  sysUptimeSeconds: number | null;
  sysDescr: string | null;
  interfaceSummary: DeviceInterfaceSummary;
  /** CPU utilization percentage (null if device doesn't support it) */
  cpuPercent: number | null;
  /** Memory utilization percentage (null if device doesn't support it) */
  memoryPercent: number | null;
  /** Memory used in MB */
  memoryUsedMB: number | null;
  /** Memory total in MB */
  memoryTotalMB: number | null;
  /** Per-interface info from device_stats message */
  interfaces: DeviceInterfaceInfo[];
  /** Health score 0-100 computed client-side */
  healthScore: number;
  /** Health color: green (>=70), orange (>=40), red (<40) */
  healthColor: string;
  /** Max interface utilization % across all interfaces on this device */
  maxUtilizationPercent: number;
}

/** Map keyed by host IP for O(1) lookup */
export type DeviceStatsMap = Map<string, DeviceLiveStats>;

/** Hook return type */
export interface UseTopologyLiveReturn {
  isLive: boolean;
  start: (targets: TopologyLiveTarget[], intervalSecs?: number) => void;
  stop: () => void;
  liveStats: LiveStatsMap;
  deviceStats: DeviceStatsMap;
  errors: Map<string, string>; // host -> error message
  lastUpdate: number | null;   // timestamp ms
}

// === Internal Types ===

/** Raw interface stats from server "stats" message */
interface ServerInterfaceStats {
  ifDescr: string;
  ifAlias: string;
  operStatus: number;
  operStatusText: string;
  speedMbps: number;
  inOctets: number;
  outOctets: number;
  inErrors: number;
  outErrors: number;
  inDiscards: number;
  outDiscards: number;
  hcCounters: boolean;
}

/** Server stats message */
interface ServerStatsMessage {
  type: 'stats';
  host: string;
  timestamp: string;
  interfaces: ServerInterfaceStats[];
}

/** Server device stats message */
interface ServerDeviceStatsMessage {
  type: 'device_stats';
  host: string;
  timestamp: string;
  sysUptimeSeconds: number | null;
  sysDescr: string | null;
  interfaceSummary: DeviceInterfaceSummary;
  cpuPercent: number | null;
  memoryPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  interfaces: Array<{
    ifDescr: string;
    ifAlias: string;
    operStatus: number;
    adminStatus: number;
    speedMbps: number;
    inOctets: number;
    outOctets: number;
    inErrors: number;
    outErrors: number;
  }>;
}

/** Server error message */
interface ServerErrorMessage {
  type: 'error';
  host: string;
  error: string;
}

type ServerMessage = ServerStatsMessage | ServerDeviceStatsMessage | ServerErrorMessage;

// === Constants ===

/** Max reconnect attempts */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Reconnect delay in ms */
const RECONNECT_DELAY = 5000;

// === Helpers ===

/**
 * Compute health score (0-100) from interface summary and max utilization.
 * Factors: interface up ratio, error presence, discard presence, utilization.
 */
export function computeHealthScore(
  summary: DeviceInterfaceSummary,
  maxUtilization: number,
): number {
  if (summary.total === 0) return 0;

  // Interface up ratio: 50% weight
  const upRatio = summary.up / summary.total;
  const upScore = upRatio * 50;

  // Error penalty: up to 20 points off
  const totalErrors = summary.totalInErrors + summary.totalOutErrors;
  const errorPenalty = Math.min(20, totalErrors > 0 ? Math.log10(totalErrors + 1) * 10 : 0);

  // Discard penalty: up to 10 points off
  const totalDiscards = summary.totalInDiscards + summary.totalOutDiscards;
  const discardPenalty = Math.min(10, totalDiscards > 0 ? Math.log10(totalDiscards + 1) * 5 : 0);

  // Utilization penalty: above 80% starts penalizing (up to 20 points)
  const utilPenalty = maxUtilization > 80 ? ((maxUtilization - 80) / 20) * 20 : 0;

  // Base score of 50 for having any interfaces, then adjustments
  const score = upScore + 50 - errorPenalty - discardPenalty - utilPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Get health color from score */
export function healthScoreColor(score: number): string {
  if (score >= 70) return '#4caf50'; // green
  if (score >= 40) return '#ff9800'; // orange
  return '#f44336'; // red
}

/**
 * Compute max utilization % for a host from the liveStats map.
 */
function computeMaxUtilization(host: string, liveStats: LiveStatsMap): number {
  let maxUtil = 0;
  for (const [key, stats] of liveStats) {
    if (key.startsWith(`${host}:`)) {
      maxUtil = Math.max(maxUtil, stats.utilizationIn, stats.utilizationOut);
    }
  }
  return maxUtil;
}

// === Hook ===

export function useTopologyLive(): UseTopologyLiveReturn {
  const [isLive, setIsLive] = useState(false);
  const [liveStats, setLiveStats] = useState<LiveStatsMap>(new Map());
  const [deviceStats, setDeviceStats] = useState<DeviceStatsMap>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const previousSamplesRef = useRef<Map<string, PreviousSample>>(new Map());
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetsRef = useRef<TopologyLiveTarget[]>([]);
  const intervalRef = useRef<number>(30);
  const isLiveRef = useRef(false); // avoid stale closure in WS callbacks
  // Keep a ref to current liveStats for use in device_stats handler
  const liveStatsRef = useRef<LiveStatsMap>(new Map());

  /**
   * Process a stats message from the server.
   * Computes rate from counter deltas using previous samples.
   */
  const handleStatsMessage = useCallback((msg: ServerStatsMessage) => {
    const now = Date.now();
    const prevSamples = previousSamplesRef.current;

    setLiveStats(prev => {
      const next = new Map(prev);

      for (const iface of msg.interfaces) {
        const key = `${msg.host}:${iface.ifDescr}`;
        const prevSample = prevSamples.get(key);

        const rate = computeRateStats(
          iface.inOctets,
          iface.outOctets,
          iface.speedMbps,
          iface.hcCounters,
          now,
          prevSample,
        );

        next.set(key, {
          ifDescr: iface.ifDescr,
          operStatus: iface.operStatus,
          operStatusText: iface.operStatusText,
          speedMbps: iface.speedMbps,
          inBps: rate.inBps,
          outBps: rate.outBps,
          inErrors: iface.inErrors,
          outErrors: iface.outErrors,
          inDiscards: iface.inDiscards,
          outDiscards: iface.outDiscards,
          utilizationIn: rate.utilizationIn,
          utilizationOut: rate.utilizationOut,
          hcCounters: iface.hcCounters,
        });

        // Store current sample for next delta
        prevSamples.set(key, {
          inOctets: iface.inOctets,
          outOctets: iface.outOctets,
          timestamp: now,
        });
      }

      // Keep ref in sync for device_stats handler
      liveStatsRef.current = next;
      return next;
    });

    // Clear error for this host on successful stats
    setErrors(prev => {
      if (!prev.has(msg.host)) return prev;
      const next = new Map(prev);
      next.delete(msg.host);
      return next;
    });

    setLastUpdate(now);
  }, []);

  /**
   * Process a device_stats message from the server.
   * Computes health score from interface summary + max utilization.
   */
  const handleDeviceStatsMessage = useCallback((msg: ServerDeviceStatsMessage) => {
    const maxUtil = computeMaxUtilization(msg.host, liveStatsRef.current);
    const score = computeHealthScore(msg.interfaceSummary, maxUtil);

    // Map server interfaces to DeviceInterfaceInfo
    const interfaces: DeviceInterfaceInfo[] = (msg.interfaces || []).map(i => ({
      ifDescr: i.ifDescr,
      ifAlias: i.ifAlias,
      operStatus: i.operStatus,
      adminStatus: i.adminStatus,
      speedMbps: i.speedMbps,
      inOctets: i.inOctets,
      outOctets: i.outOctets,
      inErrors: i.inErrors,
      outErrors: i.outErrors,
    }));

    setDeviceStats(prev => {
      const next = new Map(prev);
      next.set(msg.host, {
        host: msg.host,
        timestamp: msg.timestamp,
        sysUptimeSeconds: msg.sysUptimeSeconds,
        sysDescr: msg.sysDescr,
        interfaceSummary: msg.interfaceSummary,
        cpuPercent: msg.cpuPercent ?? null,
        memoryPercent: msg.memoryPercent ?? null,
        memoryUsedMB: msg.memoryUsedMb ?? null,
        memoryTotalMB: msg.memoryTotalMb ?? null,
        interfaces,
        healthScore: score,
        healthColor: healthScoreColor(score),
        maxUtilizationPercent: maxUtil,
      });
      return next;
    });
  }, []);

  /**
   * Process an error message from the server.
   */
  const handleErrorMessage = useCallback((msg: ServerErrorMessage) => {
    setErrors(prev => {
      const next = new Map(prev);
      next.set(msg.host, msg.error);
      return next;
    });
  }, []);

  /**
   * Connect to the WebSocket and subscribe with current targets.
   */
  const connect = useCallback(() => {
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent reconnect on intentional close
      wsRef.current.close();
      wsRef.current = null;
    }

    const wsUrl = getClient().wsUrlWithAuth('/ws/topology-live');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;

      // Send subscribe message with current targets
      if (targetsRef.current.length > 0) {
        const subscribeMsg = {
          type: 'subscribe',
          targets: targetsRef.current.map(t => ({
            host: t.host,
            profileId: t.profileId,
            interfaces: t.interfaces,
          })),
          intervalSecs: intervalRef.current,
        };
        ws.send(JSON.stringify(subscribeMsg));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);

        if (msg.type === 'stats') {
          handleStatsMessage(msg as ServerStatsMessage);
        } else if (msg.type === 'device_stats') {
          handleDeviceStatsMessage(msg as ServerDeviceStatsMessage);
        } else if (msg.type === 'error') {
          handleErrorMessage(msg as ServerErrorMessage);
        }
      } catch (err) {
        console.error('[useTopologyLive] Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = (event) => {
      console.error('[useTopologyLive] WebSocket error:', event);
    };

    ws.onclose = () => {
      wsRef.current = null;

      // Only attempt reconnect if we're supposed to be live
      if (isLiveRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current++;
        console.warn(
          `[useTopologyLive] WebSocket closed, reconnecting (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`
        );
        reconnectTimerRef.current = setTimeout(() => {
          if (isLiveRef.current) {
            connect();
          }
        }, RECONNECT_DELAY);
      } else if (isLiveRef.current) {
        console.error('[useTopologyLive] Max reconnect attempts reached, giving up');
        setIsLive(false);
        isLiveRef.current = false;
      }
    };
  }, [handleStatsMessage, handleDeviceStatsMessage, handleErrorMessage]);

  /**
   * Start live SNMP polling.
   */
  const start = useCallback((targets: TopologyLiveTarget[], intervalSecs = 30) => {
    // Store targets and interval for reconnects
    targetsRef.current = targets;
    intervalRef.current = intervalSecs;

    // Clear previous samples when targets change
    previousSamplesRef.current.clear();
    liveStatsRef.current = new Map();
    setLiveStats(new Map());
    setDeviceStats(new Map());
    setErrors(new Map());
    setLastUpdate(null);

    reconnectAttemptsRef.current = 0;
    setIsLive(true);
    isLiveRef.current = true;

    connect();
  }, [connect]);

  /**
   * Stop live SNMP polling.
   */
  const stop = useCallback(() => {
    setIsLive(false);
    isLiveRef.current = false;

    // Clear reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Send unsubscribe and close WebSocket
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'unsubscribe' }));
      }
      wsRef.current.onclose = null; // prevent reconnect
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear state
    previousSamplesRef.current.clear();
    liveStatsRef.current = new Map();
    setLiveStats(new Map());
    setDeviceStats(new Map());
    setErrors(new Map());
    setLastUpdate(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isLiveRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return {
    isLive,
    start,
    stop,
    liveStats,
    deviceStats,
    errors,
    lastUpdate,
  };
}
