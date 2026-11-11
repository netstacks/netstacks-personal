/**
 * Enrichment provider — Serial and Hostname from enrichment data
 */

import type { DeviceDetailProvider } from '../types';
import { formatHostname } from '../../../hooks/useHostnameFormatter';

/**
 * Enrichment provider
 *
 * Shows serial number and hostname when present.
 * Serial prefers enrichment.serialNumber, falls back to device.serial.
 */
export const enrichmentProvider: DeviceDetailProvider = (device, ctx) => {
  const fields = [];

  // Serial number
  const serial = ctx.enrichment?.serialNumber || device.serial;
  if (serial) {
    fields.push({
      key: 'serial',
      label: 'Serial',
      value: serial,
    });
  }

  // Hostname
  if (ctx.enrichment?.hostname) {
    fields.push({
      key: 'hostname',
      label: 'Hostname',
      value: formatHostname(ctx.enrichment.hostname),
    });
  }

  if (fields.length === 0) {
    return [];
  }

  return [{
    id: 'enrichment',
    title: 'Details',
    priority: 40,
    compact: true,
    fields,
  }];
};
