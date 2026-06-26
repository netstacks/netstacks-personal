// React hook for session context (tribal knowledge) management

import { useState, useEffect, useCallback } from 'react';
import type {
  SessionContext,
  NewSessionContext,
  UpdateSessionContext,
} from '../types/sessionContext';
import * as api from '../api/sessionContext';

import { getErrorMessage } from '../api/errors'
interface UseSessionContextOptions {
  /** Standalone / session-keyed target. Provide exactly one of sessionId/deviceId. */
  sessionId?: string;
  /** Enterprise / device-keyed target (Controller device id). Takes precedence. */
  deviceId?: string;
  autoLoad?: boolean;
}

interface UseSessionContextReturn {
  /** List of context entries for the session */
  contexts: SessionContext[];
  /** Whether context is currently loading */
  loading: boolean;
  /** Error message if load failed */
  error: string | null;
  /** Refresh context from server, returns the fetched contexts */
  refresh: () => Promise<SessionContext[]>;
  /** Add a new context entry */
  addContext: (
    context: Omit<NewSessionContext, 'session_id'>
  ) => Promise<SessionContext>;
  /** Update an existing context entry */
  updateContext: (
    id: string,
    update: UpdateSessionContext
  ) => Promise<SessionContext>;
  /** Delete a context entry */
  deleteContext: (id: string) => Promise<void>;
}

/**
 * Hook for managing session context (tribal knowledge).
 *
 * @param options.sessionId - The session ID to load context for
 * @param options.autoLoad - Whether to load context on mount (default: true)
 *
 * @example
 * ```tsx
 * const { contexts, loading, addContext } = useSessionContext({
 *   sessionId: session.id,
 * });
 *
 * // Add context when user shares knowledge
 * await addContext({
 *   issue: 'Intermittent packet loss on e1/0',
 *   root_cause: 'Bad SFP module',
 *   resolution: 'Replaced SFP',
 *   ticket_ref: 'INC12345',
 *   author: 'Mike',
 * });
 * ```
 */
export function useSessionContext({
  sessionId,
  deviceId,
  autoLoad = true,
}: UseSessionContextOptions): UseSessionContextReturn {
  const [contexts, setContexts] = useState<SessionContext[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<SessionContext[]> => {
    if (!sessionId && !deviceId) return [];
    setLoading(true);
    setError(null);
    try {
      const data = deviceId
        ? await api.listSessionContextForDevice(deviceId)
        : await api.listSessionContext(sessionId!);
      setContexts(data);
      return data;
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load context'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [sessionId, deviceId]);

  useEffect(() => {
    if (autoLoad && (sessionId || deviceId)) {
      refresh();
    }
  }, [autoLoad, refresh, sessionId, deviceId]);

  const addContext = useCallback(
    async (context: Omit<NewSessionContext, 'session_id'>) => {
      const created = deviceId
        ? await api.createSessionContextForDevice(deviceId, context)
        : await api.createSessionContext(sessionId!, context);
      // Add to front of list (newest first)
      setContexts((prev) => [created, ...prev]);
      return created;
    },
    [sessionId, deviceId]
  );

  const updateContext = useCallback(
    async (id: string, update: UpdateSessionContext) => {
      const updated = await api.updateContext(id, update);
      setContexts((prev) => prev.map((c) => (c.id === id ? updated : c)));
      return updated;
    },
    []
  );

  const deleteContext = useCallback(async (id: string) => {
    await api.deleteContext(id);
    setContexts((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return {
    contexts,
    loading,
    error,
    refresh,
    addContext,
    updateContext,
    deleteContext,
  };
}
