/** Previous sample for delta calculation */
export interface PreviousSample {
  inOctets: number;
  outOctets: number;
  timestamp: number; // Date.now() ms
}

/** Computed rate stats for a single interface sample */
export interface RateResult {
  inBps: number;
  outBps: number;
  utilizationIn: number;  // 0-100
  utilizationOut: number; // 0-100
}

/** 32-bit counter max for wrap detection. Internal — module-private
 * because the three callers (InterfaceSnmpQuickLook, DeviceDetailTab,
 * LinkDetailTab) keep their own copies inline; the shared lib only
 * uses it through computeRateStats. */
const COUNTER_32_MAX = 2 ** 32;

/**
 * Calculate counter delta, handling 32-bit counter wrap.
 * HC (64-bit) counters should not wrap in practice; negative treated as 0.
 * Internal — see COUNTER_32_MAX note above.
 */
function counterDelta(current: number, previous: number, hcCounters: boolean): number {
  const delta = current - previous;
  if (delta >= 0) return delta;
  if (!hcCounters) return delta + COUNTER_32_MAX;
  return 0;
}

/**
 * Compute rate stats (bps and utilization) from current and previous SNMP counter samples.
 * Returns zero rates if no previous sample exists or time delta is zero.
 */
export function computeRateStats(
  inOctets: number,
  outOctets: number,
  speedMbps: number,
  hcCounters: boolean,
  now: number,
  prevSample: PreviousSample | undefined,
): RateResult {
  let inBps = 0;
  let outBps = 0;

  if (prevSample) {
    const deltaSecs = (now - prevSample.timestamp) / 1000;
    if (deltaSecs > 0) {
      const inOctetsDelta = counterDelta(inOctets, prevSample.inOctets, hcCounters);
      const outOctetsDelta = counterDelta(outOctets, prevSample.outOctets, hcCounters);
      inBps = (inOctetsDelta * 8) / deltaSecs;
      outBps = (outOctetsDelta * 8) / deltaSecs;
    }
  }

  const speedBps = speedMbps * 1_000_000;
  const utilizationIn = speedBps > 0 ? Math.min(100, (inBps / speedBps) * 100) : 0;
  const utilizationOut = speedBps > 0 ? Math.min(100, (outBps / speedBps) * 100) : 0;

  return { inBps, outBps, utilizationIn, utilizationOut };
}
