import { getClient } from './client';

const BASE = '/config';

// === Types ===
export interface DeviceConfig {
  id: string; device_id: string; config_format: string; config_hash: string;
  version: number; source: string; pulled_via: string; created_at: string;
  notes?: string | null; notes_by?: string | null; notes_updated_at?: string | null;
}

export interface VersionDiffResponse {
  old_version: number
  new_version: number
  old_format: string
  new_format: string
  identical: boolean
  diff: string
  additions: number
  deletions: number
}

export interface DeviceConfigFull {
  id: string
  device_id: string
  org_id: string
  config_text: string
  config_format: string
  config_hash: string
  version: number
  source: string
  pulled_via: string
  created_by: string | null
  created_at: string
  notes?: string | null
  notes_by?: string | null
  notes_updated_at?: string | null
}

/** Response of POST /config/devices/:id/pull — which transport ran. */
export interface PullDeviceConfigResponse {
  message: string;
  cli: boolean;
  snmp: boolean;
}

// === API Functions ===
export async function listDeviceConfigs(deviceId: string): Promise<DeviceConfig[]> {
  const { data } = await getClient().http.get(`${BASE}/devices/${deviceId}/configs`);
  return Array.isArray(data) ? data : data.configs || data.data || [];
}

export async function pullDeviceConfig(deviceId: string): Promise<PullDeviceConfigResponse> {
  const { data } = await getClient().http.post(`${BASE}/devices/${deviceId}/pull`);
  return data;
}

// === Device Config (full text) ===
export async function getDeviceConfigVersion(deviceId: string, version: number): Promise<DeviceConfigFull> {
  const { data } = await getClient().http.get(`${BASE}/devices/${deviceId}/configs/${version}`);
  return data;
}

/**
 * Update operator notes (tribal knowledge) on a specific config version.
 * Notes are metadata only — they never modify the stored config text.
 * Pass `null`/empty to clear the note. Enterprise (Controller) only.
 */
export async function updateDeviceConfigNotes(
  deviceId: string,
  version: number,
  notes: string | null
): Promise<DeviceConfigFull> {
  const { data } = await getClient().http.put(
    `${BASE}/devices/${deviceId}/configs/${version}/notes`,
    { notes }
  );
  return data;
}

export async function diffConfigVersions(
  deviceId: string,
  oldVersion: number,
  newVersion: number
): Promise<VersionDiffResponse> {
  const { data } = await getClient().http.get(`${BASE}/devices/${deviceId}/diff-versions`, {
    params: { old_version: oldVersion, new_version: newVersion },
  });
  return data;
}
