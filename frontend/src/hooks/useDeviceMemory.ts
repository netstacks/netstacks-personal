import { useState, useCallback, useEffect } from 'react';
import type {
  DeviceMemoryWithEntries,
  UpdateDeviceMemory,
  NewDeviceMemoryEntry,
  UpdateDeviceMemoryEntry,
} from '../types/deviceMemory';
import {
  getDeviceMemory,
  updateDeviceMemory as apiUpdateDeviceMemory,
  createDeviceMemoryEntry,
  getDeviceMemoryForDevice,
  updateDeviceMemoryForDevice,
  createDeviceMemoryEntryForDevice,
  updateDeviceMemoryEntry,
  deleteDeviceMemoryEntry,
} from '../api/deviceMemory';

import { getErrorMessage } from '../api/errors'
/**
 * Target for device memory. Either a session definition (standalone /
 * session-keyed) or a Controller device (enterprise device-keyed). Provide
 * exactly one; `deviceId` takes precedence if both are set.
 */
export interface DeviceMemoryTarget {
  sessionId?: string;
  deviceId?: string;
}

export function useDeviceMemory(target: DeviceMemoryTarget) {
  const { sessionId, deviceId } = target;
  const [memory, setMemory] = useState<DeviceMemoryWithEntries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId && !deviceId) return;
    setLoading(true);
    setError(null);
    try {
      const data = deviceId
        ? await getDeviceMemoryForDevice(deviceId)
        : await getDeviceMemory(sessionId!);
      setMemory(data);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load device memory'));
    } finally {
      setLoading(false);
    }
  }, [sessionId, deviceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateMemory = useCallback(async (update: UpdateDeviceMemory) => {
    if (!sessionId && !deviceId) return;
    try {
      if (deviceId) {
        await updateDeviceMemoryForDevice(deviceId, update);
      } else {
        await apiUpdateDeviceMemory(sessionId!, update);
      }
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update device memory'));
    }
  }, [sessionId, deviceId, refresh]);

  const addEntry = useCallback(async (entry: NewDeviceMemoryEntry) => {
    if (!sessionId && !deviceId) return;
    try {
      if (deviceId) {
        await createDeviceMemoryEntryForDevice(deviceId, entry);
      } else {
        await createDeviceMemoryEntry(sessionId!, entry);
      }
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to add memory entry'));
    }
  }, [sessionId, deviceId, refresh]);

  const editEntry = useCallback(async (id: string, update: UpdateDeviceMemoryEntry) => {
    try {
      await updateDeviceMemoryEntry(id, update);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update memory entry'));
    }
  }, [refresh]);

  const removeEntry = useCallback(async (id: string) => {
    try {
      await deleteDeviceMemoryEntry(id);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete memory entry'));
    }
  }, [refresh]);

  return { memory, loading, error, updateMemory, addEntry, editEntry, removeEntry, refresh };
}
