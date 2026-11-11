import { useState, useEffect, useMemo, useCallback } from 'react';
import { listEnterpriseDevices, type DeviceSummary } from '../api/enterpriseDevices';
import { listSessions, type Session } from '../api/sessions';
import { getCurrentMode } from '../api/client';

/** Normalized device info used by both enterprise and professional modes */
export interface DeviceOption {
  id: string;
  name: string;
  host: string;
  type: string; // device_type or cli_flavor
}

export interface UseDeviceSelectionOptions {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export interface UseDeviceSelectionReturn {
  devices: DeviceOption[];
  loading: boolean;
  search: string;
  setSearch: (s: string) => void;
  filtered: DeviceOption[];
  toggleDevice: (id: string) => void;
  toggleAll: () => void;
  clearAll: () => void;
}

/**
 * Shared device selection hook. Loads devices from enterprise API or local
 * sessions depending on current mode, and provides search, toggle, and
 * bulk-selection logic for device picker components.
 */
export function useDeviceSelection({
  selectedIds,
  onChange,
}: UseDeviceSelectionOptions): UseDeviceSelectionReturn {
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const mode = getCurrentMode();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        if (mode === 'enterprise') {
          const res = await listEnterpriseDevices({ limit: 500 });
          if (!cancelled) {
            setDevices(
              res.items.map((d: DeviceSummary) => ({
                id: d.id,
                name: d.name,
                host: d.host,
                type: d.device_type,
              }))
            );
          }
        } else {
          const sessions = await listSessions();
          if (!cancelled) {
            setDevices(
              sessions.map((s: Session) => ({
                id: s.id,
                name: s.name,
                host: s.host,
                type: s.cli_flavor || 'auto',
              }))
            );
          }
        }
      } catch (err) {
        console.error('Failed to load devices:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [mode]);

  const filtered = useMemo(() => {
    if (!search.trim()) return devices;
    const q = search.toLowerCase();
    return devices.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.host.toLowerCase().includes(q) ||
        d.type.toLowerCase().includes(q)
    );
  }, [devices, search]);

  const toggleDevice = useCallback((id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((sid) => sid !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }, [selectedIds, onChange]);

  const toggleAll = useCallback(() => {
    const filteredIds = filtered.map((d) => d.id);
    const allSelected = filteredIds.every((id) => selectedIds.includes(id));
    if (allSelected) {
      onChange(selectedIds.filter((id) => !filteredIds.includes(id)));
    } else {
      const merged = new Set([...selectedIds, ...filteredIds]);
      onChange(Array.from(merged));
    }
  }, [filtered, selectedIds, onChange]);

  const clearAll = useCallback(() => onChange([]), [onChange]);

  return { devices, loading, search, setSearch, filtered, toggleDevice, toggleAll, clearAll };
}
