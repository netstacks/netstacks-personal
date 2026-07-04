/**
 * Connectivity provider — Management IP and connection status for managed devices
 */

import type { Device } from '../../../types/topology';
import type { DeviceDetailContext, DeviceDetailProvider } from '../types';

/**
 * Determines if device is managed (has profile or session)
 */
function isManaged(device: Device, ctx: DeviceDetailContext): boolean {
  return !!(ctx.profile || device.sessionId || device.profileId);
}

/**
 * Connectivity provider
 *
 * Shows management IP for all devices with primaryIp.
 * Shows connection status only for managed devices when ctx.connected is defined.
 */
export const connectivityProvider: DeviceDetailProvider = (device, ctx) => {
  const fields = [];

  // Management IP (unconditional — for ALL devices with primaryIp)
  if (device.primaryIp) {
    fields.push({
      key: 'management-ip',
      label: 'Management IP',
      value: device.primaryIp,
    });
  }

  // Connection status (only for managed devices when ctx.connected is defined)
  const managed = isManaged(device, ctx);
  if (managed && ctx.connected !== undefined) {
    fields.push({
      key: 'status',
      label: 'Connection',
      value: ctx.connected ? 'Connected' : 'Not connected',
      tone: ctx.connected ? 'good' as const : 'muted' as const,
    });
  }

  // Emit section only if we have at least one field
  if (fields.length === 0) {
    return [];
  }

  return [{
    id: 'connectivity',
    title: 'Connectivity',
    priority: 20,
    compact: true,
    fields,
  }];
};
