/**
 * Identity provider — Vendor, Model, CLI Flavor (managed), OS Version (unmanaged)
 */

import type { Device } from '../../../types/topology';
import type { DeviceDetailContext, DeviceDetailProvider, DetailSection } from '../types';
import { parseSysDescr } from '../../sysDescrParser';

/**
 * Check if a string looks like a sysDescr (long or contains commas)
 */
function looksLikeSysDescr(s: string | undefined | null): boolean {
  return !!s && (s.length > 40 || s.includes(','));
}

/**
 * Map CLI flavor to friendly label
 */
function getCliFlavor(flavor: string | undefined): string | undefined {
  if (!flavor || flavor === 'auto') return undefined;

  const flavorMap: Record<string, string> = {
    'cisco-ios': 'Cisco IOS',
    'cisco-ios-xr': 'Cisco IOS-XR',
    'cisco-nxos': 'Cisco NX-OS',
    'juniper': 'Juniper',
    'arista': 'Arista',
    'paloalto': 'Palo Alto',
    'fortinet': 'Fortinet',
    'linux': 'Linux',
  };

  return flavorMap[flavor] || flavor;
}

/**
 * Check if device is managed
 */
function isManaged(device: Device, ctx: DeviceDetailContext): boolean {
  return !!ctx.profile || !!device.sessionId || !!device.profileId;
}

/**
 * Identity provider
 */
export const identityProvider: DeviceDetailProvider = (device, ctx) => {
  const managed = isManaged(device, ctx);

  // Resolve sysDescr source
  const descr = ctx.liveStats?.sysDescr ||
    (looksLikeSysDescr(device.model) ? device.model : undefined) ||
    device.metadata?.sysDescr;

  // Parse sysDescr if available
  const parsed = parseSysDescr(descr);

  // Build fields
  const fields = [];

  // Vendor
  const vendor = ctx.enrichment?.vendor || device.vendor || parsed.vendor;
  if (vendor) {
    fields.push({
      key: 'vendor',
      label: 'Vendor',
      value: vendor,
    });
  }

  // Model (prefer enrichment → parsed → raw device.model → platform)
  const model = ctx.enrichment?.model || parsed.model || device.model || device.platform;
  if (model) {
    fields.push({
      key: 'model',
      label: 'Model',
      value: model,
    });
  }

  // CLI Flavor (managed only, when set and not 'auto')
  if (managed && ctx.profile?.cli_flavor) {
    const cliFlavor = getCliFlavor(ctx.profile.cli_flavor);
    if (cliFlavor) {
      fields.push({
        key: 'cli-flavor',
        label: 'CLI Flavor',
        value: cliFlavor,
      });
    }
  }

  // OS Version (unmanaged or managed without CLI flavor)
  const hasCliFlavor = managed && ctx.profile?.cli_flavor && ctx.profile.cli_flavor !== 'auto';
  if (!hasCliFlavor) {
    const osVersion = ctx.enrichment?.osVersion ||
      device.version ||
      parsed.osVersion ||
      (descr ? (descr.length > 80 ? descr.substring(0, 80) + '…' : descr) : undefined);

    if (osVersion) {
      fields.push({
        key: 'os-version',
        label: 'OS Version',
        value: osVersion,
      });
    }
  }

  const section: DetailSection = {
    id: 'identity',
    title: 'System Information',
    priority: 10,
    compact: true,
    fields,
  };

  return [section];
};
