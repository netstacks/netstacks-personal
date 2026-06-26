/**
 * useTopologyLiveHttp - HTTP polling hook for real-time SNMP topology enrichment (enterprise mode)
 *
 * Alternative to useTopologyLive for enterprise mode where WebSocket to local agent is unavailable.
 * Uses snmpTryInterfaceStats HTTP API with setInterval for periodic polling.
 */

import { useState, useRef, useCallback } from 'react';
import { useInterval } from './useInterval';
import { snmpTryInterfaceStats } from '../api/snmp';
import type { InterfaceLiveStats, LiveStatsMap, DeviceStatsMap, DeviceInterfaceSummary, DeviceInterfaceInfo } from './useTopologyLive';
import { computeHealthScore, healthScoreColor } from './useTopologyLive';
import { computeRateStats, type PreviousSample } from '../lib/topologyRateCalc';

// Re-export types for convenience
export type { InterfaceLiveStats, LiveStatsMap, DeviceStatsMap, DeviceInterfaceInfo } from './useTopologyLive';

/** Target for HTTP polling - uses deviceId for enterprise mode */
export interface TopologyLiveHttpTarget {
  deviceId: string;
  host: string; // Used as key in stats map for compatibility
  interfaces: string[];
}

/** Hook return type */
export interface UseTopologyLiveHttpReturn {
  isLive: boolean;
  start: (targets: TopologyLiveHttpTarget[], intervalSecs?: number) => void;
  stop: () => void;
  liveStats: LiveStatsMap;
  deviceStats: DeviceStatsMap;
  errors: Map<string, string>;
  lastUpdate: number | null;
}

export function useTopologyLiveHttp(): UseTopologyLiveHttpReturn {
  const [isLive, setIsLive] = useState(false);
  const [liveStats, setLiveStats] = useState<LiveStatsMap>(new Map());
  const [deviceStats, setDeviceStats] = useState<DeviceStatsMap>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  const [intervalMs, setIntervalMs] = useState<number | null>(null);
  const previousSamplesRef = useRef<Map<string, PreviousSample>>(new Map());
  const targetsRef = useRef<TopologyLiveHttpTarget[]>([]);

  /** Poll all targets and update stats */
  const poll = useCallback(async () => {
    const targets = targetsRef.current;
    const now = Date.now();
    const prevSamples = previousSamplesRef.current;
    const newStats = new Map<string, InterfaceLiveStats>();
    const newErrors = new Map<string, string>();

    // Build list of all interface poll requests
    const requests: Array<{
      target: TopologyLiveHttpTarget;
      interfaceName: string;
    }> = [];

    for (const target of targets) {
      for (const iface of target.interfaces) {
        requests.push({ target, interfaceName: iface });
      }
    }

    // Poll all interfaces in parallel
    const results = await Promise.allSettled(
      requests.map(({ target, interfaceName }) =>
        snmpTryInterfaceStats({
          deviceId: target.deviceId,
          interfaceName,
        })
      )
    );

    // Process results
    results.forEach((result, idx) => {
      const { target } = requests[idx];

      if (result.status === 'rejected') {
        newErrors.set(target.host, result.reason?.message || 'Poll failed');
        return;
      }

      const data = result.value;
      const statsKey = `${target.host}:${data.ifDescr}`;
      const prevSample = prevSamples.get(statsKey);

      const rate = computeRateStats(
        data.inOctets,
        data.outOctets,
        data.speedMbps,
        data.hcCounters,
        now,
        prevSample,
      );

      newStats.set(statsKey, {
        ifDescr: data.ifDescr,
        operStatus: data.operStatus,
        operStatusText: data.operStatusText,
        speedMbps: data.speedMbps,
        inBps: Math.max(0, rate.inBps),
        outBps: Math.max(0, rate.outBps),
        inErrors: data.inErrors,
        outErrors: data.outErrors,
        inDiscards: data.inDiscards,
        outDiscards: data.outDiscards,
        utilizationIn: rate.utilizationIn,
        utilizationOut: rate.utilizationOut,
        hcCounters: data.hcCounters,
      });

      // Store sample for next delta
      prevSamples.set(statsKey, {
        inOctets: data.inOctets,
        outOctets: data.outOctets,
        timestamp: now,
      });
    });

    setLiveStats(newStats);
    setErrors(newErrors);
    setLastUpdate(now);

    // Compute device-level stats from the per-interface stats
    const newDeviceStats = new Map<string, import('./useTopologyLive').DeviceLiveStats>();
    for (const target of targets) {
      const summary: DeviceInterfaceSummary = {
        total: 0,
        up: 0,
        down: 0,
        adminDown: 0,
        totalInErrors: 0,
        totalOutErrors: 0,
        totalInDiscards: 0,
        totalOutDiscards: 0,
      };
      let maxUtil = 0;

      for (const [key, stats] of newStats) {
        if (key.startsWith(`${target.host}:`)) {
          summary.total++;
          if (stats.operStatus === 1) summary.up++;
          else if (stats.operStatus === 2) summary.down++;
          summary.totalInErrors += stats.inErrors;
          summary.totalOutErrors += stats.outErrors;
          summary.totalInDiscards += stats.inDiscards;
          summary.totalOutDiscards += stats.outDiscards;
          maxUtil = Math.max(maxUtil, stats.utilizationIn, stats.utilizationOut);
        }
      }

      if (summary.total > 0) {
        const score = computeHealthScore(summary, maxUtil);
        // Build interfaces array from live stats for this host
        const hostInterfaces: DeviceInterfaceInfo[] = [];
        for (const [key, stats] of newStats) {
          if (key.startsWith(`${target.host}:`)) {
            hostInterfaces.push({
              ifDescr: stats.ifDescr,
              ifAlias: '',
              operStatus: stats.operStatus,
              adminStatus: stats.operStatus, // best guess from HTTP mode
              speedMbps: stats.speedMbps,
              inOctets: 0,
              outOctets: 0,
              inErrors: stats.inErrors,
              outErrors: stats.outErrors,
            });
          }
        }
        newDeviceStats.set(target.host, {
          host: target.host,
          timestamp: new Date().toISOString(),
          sysUptimeSeconds: null, // not available via HTTP polling
          sysDescr: null,
          interfaceSummary: summary,
          cpuPercent: null,
          memoryPercent: null,
          memoryUsedMB: null,
          memoryTotalMB: null,
          interfaces: hostInterfaces,
          healthScore: score,
          healthColor: healthScoreColor(score),
          maxUtilizationPercent: maxUtil,
        });
      }
    }
    setDeviceStats(newDeviceStats);
  }, []);

  // Declarative interval via useInterval (null = stopped)
  useInterval(poll, intervalMs);

  /** Start HTTP polling */
  const start = useCallback((targets: TopologyLiveHttpTarget[], intervalSecs = 30) => {
    // Store targets
    targetsRef.current = targets;

    // Clear previous state
    previousSamplesRef.current.clear();
    setLiveStats(new Map());
    setDeviceStats(new Map());
    setErrors(new Map());
    setLastUpdate(null);

    setIsLive(true);

    // Initial poll
    poll();

    // Start interval
    setIntervalMs(intervalSecs * 1000);
  }, [poll]);

  /** Stop HTTP polling */
  const stop = useCallback(() => {
    setIsLive(false);
    setIntervalMs(null);

    previousSamplesRef.current.clear();
    setLiveStats(new Map());
    setDeviceStats(new Map());
    setErrors(new Map());
    setLastUpdate(null);
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
