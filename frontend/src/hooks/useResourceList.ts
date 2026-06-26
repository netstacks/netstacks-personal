import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { getErrorMessage } from '../api/errors';

export interface UseResourceListReturn<T> {
  templates: T[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useResourceList<T>(
  fetchFn: (orgId: string) => Promise<T[]>,
  options?: { pluginName?: string; label?: string },
): UseResourceListReturn<T> {
  const [templates, setTemplates] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = useAuthStore((state) => state.user);
  const orgId = user?.org_id;

  const pluginName = options?.pluginName;
  const label = options?.label || 'resources';
  const hasPlugin = useCapabilitiesStore((s) => s.hasPlugin)(pluginName || '');
  const shouldCheck = !!pluginName;

  const fetchData = useCallback(async () => {
    if (!orgId) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    if (shouldCheck && !hasPlugin) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFn(orgId);
      setTemplates(data);
    } catch (err) {
      const message = getErrorMessage(err, `Failed to load ${label}`);
      setError(message);
      console.error(`[useResourceList] Error fetching ${label}:`, err);
    } finally {
      setLoading(false);
    }
  }, [orgId, hasPlugin, shouldCheck, fetchFn, label]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { templates, loading, error, refresh: fetchData };
}
