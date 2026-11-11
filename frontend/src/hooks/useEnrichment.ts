import { useContext, useCallback } from 'react';
import {
  EnrichmentContext,
  type DeviceEnrichment,
  type LinkEnrichment,
} from '../contexts/EnrichmentContext';

/**
 * Hook for consuming enrichment data from EnrichmentContext.
 *
 * Provides access to device and link enrichment data with convenient
 * helper functions for accessing individual items.
 *
 * Must be used within an EnrichmentProvider.
 */
export function useEnrichment() {
  const context = useContext(EnrichmentContext);

  if (!context) {
    throw new Error('useEnrichment must be used within an EnrichmentProvider');
  }

  const {
    deviceEnrichments,
    linkEnrichments,
    isCollecting,
    lastCollectedAt,
    setDeviceEnrichment,
    setLinkEnrichment,
    clearEnrichments,
    setCollecting,
  } = context;

  // Get device enrichment by session ID
  const getDeviceEnrichment = useCallback(
    (sessionId: string): DeviceEnrichment | undefined => {
      return deviceEnrichments.get(sessionId);
    },
    [deviceEnrichments]
  );

  // Get link enrichment by connection ID
  const getLinkEnrichment = useCallback(
    (connectionId: string): LinkEnrichment | undefined => {
      return linkEnrichments.get(connectionId);
    },
    [linkEnrichments]
  );

  // Check if a device has enrichment data
  const hasEnrichment = useCallback(
    (sessionId: string): boolean => {
      return deviceEnrichments.has(sessionId);
    },
    [deviceEnrichments]
  );

  // Check if a link has enrichment data
  const hasLinkEnrichment = useCallback(
    (connectionId: string): boolean => {
      return linkEnrichments.has(connectionId);
    },
    [linkEnrichments]
  );

  // Get all device enrichments as array
  const getAllDeviceEnrichments = useCallback((): DeviceEnrichment[] => {
    return Array.from(deviceEnrichments.values());
  }, [deviceEnrichments]);

  // Get all link enrichments as array
  const getAllLinkEnrichments = useCallback((): LinkEnrichment[] => {
    return Array.from(linkEnrichments.values());
  }, [linkEnrichments]);

  // Get count of enriched devices
  const deviceEnrichmentCount = deviceEnrichments.size;

  // Get count of enriched links
  const linkEnrichmentCount = linkEnrichments.size;

  return {
    // State
    deviceEnrichments,
    linkEnrichments,
    isCollecting,
    lastCollectedAt,
    deviceEnrichmentCount,
    linkEnrichmentCount,

    // Actions
    setDeviceEnrichment,
    setLinkEnrichment,
    clearEnrichments,
    setCollecting,

    // Helper functions
    getDeviceEnrichment,
    getLinkEnrichment,
    hasEnrichment,
    hasLinkEnrichment,
    getAllDeviceEnrichments,
    getAllLinkEnrichments,
  };
}

// Re-export types for convenience
export type { DeviceEnrichment, LinkEnrichment, InterfaceEnrichment } from '../contexts/EnrichmentContext';
