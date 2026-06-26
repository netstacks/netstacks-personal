import { useState, useCallback, createContext, type ReactNode, useMemo } from 'react';
import type {
  DeviceEnrichment,
  InterfaceEnrichment,
  LinkEnrichment,
} from '../types/enrichment';

/**
 * Enrichment Data Context
 *
 * Provides centralized state management for device and link enrichment data.
 * Data is ephemeral (in-memory only, cleared on app restart).
 *
 * Used by topology components to display device info (version, uptime, CPU/memory)
 * and link info (interface stats, traffic).
 */

// Re-export types for convenience
export type { DeviceEnrichment, InterfaceEnrichment, LinkEnrichment };

interface EnrichmentState {
  deviceEnrichments: Map<string, DeviceEnrichment>;
  linkEnrichments: Map<string, LinkEnrichment>;
  isCollecting: boolean;
  lastCollectedAt: Date | null;
}

interface EnrichmentContextValue extends EnrichmentState {
  setDeviceEnrichment: (sessionId: string, data: DeviceEnrichment) => void;
  setLinkEnrichment: (connectionId: string, data: LinkEnrichment) => void;
  clearEnrichments: () => void;
  setCollecting: (collecting: boolean) => void;
}

export const EnrichmentContext = createContext<EnrichmentContextValue | null>(null);

export function EnrichmentProvider({ children }: { children: ReactNode }) {
  const [deviceEnrichments, setDeviceEnrichments] = useState<Map<string, DeviceEnrichment>>(
    () => new Map()
  );
  const [linkEnrichments, setLinkEnrichments] = useState<Map<string, LinkEnrichment>>(
    () => new Map()
  );
  const [isCollecting, setIsCollecting] = useState(false);
  const [lastCollectedAt, setLastCollectedAt] = useState<Date | null>(null);

  // Set device enrichment data
  const setDeviceEnrichment = useCallback((sessionId: string, data: DeviceEnrichment) => {
    setDeviceEnrichments(prev => {
      const next = new Map(prev);
      next.set(sessionId, data);
      return next;
    });
    setLastCollectedAt(new Date());
  }, []);

  // Set link enrichment data
  const setLinkEnrichment = useCallback((connectionId: string, data: LinkEnrichment) => {
    setLinkEnrichments(prev => {
      const next = new Map(prev);
      next.set(connectionId, data);
      return next;
    });
    setLastCollectedAt(new Date());
  }, []);

  // Clear all enrichment data
  const clearEnrichments = useCallback(() => {
    setDeviceEnrichments(new Map());
    setLinkEnrichments(new Map());
    setLastCollectedAt(null);
  }, []);

  // Set collecting state
  const setCollecting = useCallback((collecting: boolean) => {
    setIsCollecting(collecting);
  }, []);

  const value = useMemo<EnrichmentContextValue>(() => ({
    deviceEnrichments,
    linkEnrichments,
    isCollecting,
    lastCollectedAt,
    setDeviceEnrichment,
    setLinkEnrichment,
    clearEnrichments,
    setCollecting,
  }), [
    deviceEnrichments,
    linkEnrichments,
    isCollecting,
    lastCollectedAt,
    setDeviceEnrichment,
    setLinkEnrichment,
    clearEnrichments,
    setCollecting,
  ]);

  return (
    <EnrichmentContext.Provider value={value}>
      {children}
    </EnrichmentContext.Provider>
  );
}
