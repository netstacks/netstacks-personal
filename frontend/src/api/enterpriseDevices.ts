// API client for enterprise devices (Controller API)

import { getClient } from './client';
import type { ListDevicesResponse, ListDevicesParams, DeviceSummary } from '../types/enterpriseDevice';

/**
 * List devices from Controller for browsing.
 * Org-wide visibility — all engineers see all devices.
 * Credential access gates actual connections, not browsing.
 */
export async function listEnterpriseDevices(
  params: ListDevicesParams = {}
): Promise<ListDevicesResponse> {
  const client = getClient();
  const res = await client.http.get('/devices/browse', { params });
  return res.data;
}

export interface UpdateDeviceParams {
  name?: string;
  host?: string;
  port?: number;
  device_type?: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  platform?: string;
  site?: string;
}

export async function updateEnterpriseDevice(
  deviceId: string,
  params: UpdateDeviceParams
): Promise<DeviceSummary> {
  const client = getClient();
  const res = await client.http.put(`/devices/${deviceId}`, params);
  return res.data;
}

// Re-export types for convenience
export type { DeviceSummary, ListDevicesResponse, ListDevicesParams } from '../types/enterpriseDevice';
