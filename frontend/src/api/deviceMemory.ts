import { getClient } from './client';
import type {
  DeviceMemoryWithEntries,
  DeviceMemory,
  DeviceMemoryEntry,
  NewDeviceMemoryEntry,
  UpdateDeviceMemory,
  UpdateDeviceMemoryEntry,
} from '../types/deviceMemory';

export async function getDeviceMemory(sessionId: string): Promise<DeviceMemoryWithEntries> {
  const response = await getClient().http.get(`/sessions/${sessionId}/device-memory`);
  return response.data;
}

export async function updateDeviceMemory(
  sessionId: string,
  update: UpdateDeviceMemory,
): Promise<DeviceMemory> {
  const response = await getClient().http.put(`/sessions/${sessionId}/device-memory`, update);
  return response.data;
}

export async function createDeviceMemoryEntry(
  sessionId: string,
  entry: NewDeviceMemoryEntry,
): Promise<DeviceMemoryEntry> {
  const response = await getClient().http.post(
    `/sessions/${sessionId}/device-memory/entries`,
    entry,
  );
  return response.data;
}

export async function updateDeviceMemoryEntry(
  id: string,
  update: UpdateDeviceMemoryEntry,
): Promise<DeviceMemoryEntry> {
  const response = await getClient().http.put(`/device-memory/entries/${id}`, update);
  return response.data;
}

export async function deleteDeviceMemoryEntry(id: string): Promise<void> {
  await getClient().http.delete(`/device-memory/entries/${id}`);
}

// Device-keyed variants — used by the enterprise device UI, which keys device
// memory directly on a Controller device id (/devices/{id}/device-memory)
// rather than on a session. Entry update/delete are entry-id-keyed and shared.

export async function getDeviceMemoryForDevice(
  deviceId: string,
): Promise<DeviceMemoryWithEntries> {
  const response = await getClient().http.get(`/devices/${deviceId}/device-memory`);
  return response.data;
}

export async function updateDeviceMemoryForDevice(
  deviceId: string,
  update: UpdateDeviceMemory,
): Promise<DeviceMemory> {
  const response = await getClient().http.put(`/devices/${deviceId}/device-memory`, update);
  return response.data;
}

export async function createDeviceMemoryEntryForDevice(
  deviceId: string,
  entry: NewDeviceMemoryEntry,
): Promise<DeviceMemoryEntry> {
  const response = await getClient().http.post(
    `/devices/${deviceId}/device-memory/entries`,
    entry,
  );
  return response.data;
}
