/**
 * Live provider — Uptime only (compact field for card display)
 */

import type { DeviceDetailProvider } from '../types';
import { formatUptime } from '../../formatters';

/**
 * Live provider
 *
 * Shows uptime (compact field) when available.
 * CPU/Memory gauges are rendered elsewhere; text fields would duplicate.
 *
 * Uptime sources in priority order:
 *   1. enrichment.uptimeSeconds → formatUptime
 *   2. enrichment.uptimeFormatted (already formatted)
 *   3. liveStats.sysUptimeSeconds → formatUptime
 *   4. device.uptime (already formatted)
 */
export const liveProvider: DeviceDetailProvider = (device, ctx) => {
  // Uptime (compact field)
  let uptime: string | undefined;
  if (ctx.enrichment?.uptimeSeconds) {
    uptime = formatUptime(ctx.enrichment.uptimeSeconds);
  } else if (ctx.enrichment?.uptimeFormatted) {
    uptime = ctx.enrichment.uptimeFormatted;
  } else if (ctx.liveStats?.sysUptimeSeconds) {
    uptime = formatUptime(ctx.liveStats.sysUptimeSeconds);
  } else if (device.uptime) {
    uptime = device.uptime;
  }

  if (!uptime) {
    return [];
  }

  return [{
    id: 'live',
    title: 'Status',
    priority: 30,
    compact: true,
    fields: [{
      key: 'uptime',
      label: 'Uptime',
      value: uptime,
    }],
  }];
};
