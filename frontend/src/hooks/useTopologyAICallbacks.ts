/**
 * useTopologyAICallbacks - Hook for creating topology AI tool callbacks
 *
 * Creates the callbacks needed by the AI agent to query and modify topologies.
 * Should be used in a component that has access to topology state and can
 * track history with AI source.
 *
 * Phase 27-07: AI Topology Tools
 */

import { useCallback, useMemo } from 'react';
import type { TopologyAICallbacks } from '../lib/topologyAITools';
import type { Topology, Device, Connection, DeviceType, DeviceStatus, ConnectionStatus } from '../types/topology';
import type { TopologyAction } from '../types/topologyHistory';
import type { DeviceStatsMap, LiveStatsMap } from './useTopologyLive';
import type { LinkEnrichment } from '../types/enrichment';
import { createDevice, updateDevice as apiUpdateDevice, deleteDevice, createConnection, updateConnection as apiUpdateConnection, deleteConnection, updateDevicePosition } from '../api/topology';

/** Snake_case body accepted by the agent's device details PUT. */
export type DeviceUpdateRequest = Parameters<typeof apiUpdateDevice>[2];

/**
 * Frontend `Device` key -> agent details field. Anything not listed here
 * (id, x/y, sessionId, netboxId, metadata, isNeighbor, ...) is not part of
 * the details struct and must be dropped rather than sent — serde ignores
 * unknown keys silently, so the AI would think it persisted and the value
 * would revert on reload.
 */
const DEVICE_UPDATE_FIELD_MAP: Record<string, keyof DeviceUpdateRequest> = {
  name: 'name',
  type: 'device_type',
  status: 'status',
  site: 'site',
  role: 'role',
  platform: 'platform',
  vendor: 'vendor',
  version: 'version',
  model: 'model',
  serial: 'serial',
  uptime: 'uptime',
  primaryIp: 'primary_ip',
  notes: 'notes',
  profileId: 'profile_id',
  snmpProfileId: 'snmp_profile_id',
};

/**
 * Map a camelCase `Partial<Device>` (what the AI tool hands us) to the
 * agent's snake_case details request. Returns the keys it dropped so the
 * caller can log them.
 */
export function toDeviceUpdateRequest(updates: Partial<Device>): { request: DeviceUpdateRequest; dropped: string[] } {
  const request: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const target = DEVICE_UPDATE_FIELD_MAP[key];
    if (!target || typeof value !== 'string') {
      dropped.push(key);
      continue;
    }
    request[target] = value;
  }
  return { request: request as DeviceUpdateRequest, dropped };
}

// Forward-declared type for annotations (not yet implemented)
interface Annotation {
  id: string;
  type: 'text' | 'shape' | 'line';
  content?: string;
  position: { x: number; y: number };
  style?: Record<string, unknown>;
}

/**
 * Options for creating topology AI callbacks
 */
export interface UseTopologyAICallbacksOptions {
  /** Current topology state */
  topology: Topology | null;
  /** Topology ID (may differ from topology.id for temporary topologies) */
  topologyId?: string;
  /** Whether this is a temporary/unsaved topology */
  isTemporary?: boolean;
  /** Callback to update local topology state */
  setTopology: React.Dispatch<React.SetStateAction<Topology | null>>;
  /** Callback to push action to history with source tracking (matches
   *  useTopologyHistory's pushAction signature). */
  pushAction: (action: Omit<TopologyAction, 'id' | 'timestamp'>) => TopologyAction;
  /** Callback to show AI action toast */
  showAIActionToast?: (action: TopologyAction) => void;
  /** Live SNMP device stats keyed by host IP (optional) */
  deviceStats?: DeviceStatsMap | null;
  /** Live SNMP per-interface stats keyed by "host:ifDescr" (optional) */
  liveStats?: LiveStatsMap | null;
  /** Per-connection link enrichment keyed by connection ID (optional) */
  linkEnrichment?: Map<string, LinkEnrichment> | null;
}

/**
 * Hook for creating topology AI callbacks
 *
 * Returns callbacks that can be passed to useAIAgent's topologyCallbacks option.
 * All modification callbacks automatically track actions with source='ai' and
 * show toast notifications.
 */
export function useTopologyAICallbacks({
  topology,
  topologyId,
  isTemporary = false,
  setTopology,
  pushAction,
  showAIActionToast,
  deviceStats,
  linkEnrichment,
}: UseTopologyAICallbacksOptions): TopologyAICallbacks | null {
  // Don't return callbacks if no topology
  const effectiveTopologyId = topologyId || topology?.id;

  // === Query callbacks (read-only) ===

  const getTopology = useCallback(() => topology, [topology]);

  const getDeviceById = useCallback((deviceId: string) => {
    return topology?.devices.find(d => d.id === deviceId);
  }, [topology]);

  const getConnectionById = useCallback((connectionId: string) => {
    return topology?.connections.find(c => c.id === connectionId);
  }, [topology]);

  // === Live telemetry accessors (read-only) ===
  // deviceStats is keyed by host IP; resolve deviceId -> device -> primaryIp
  // (falling back to name) to look up SNMP stats.
  const getDeviceStats = useCallback((deviceId: string) => {
    if (!deviceStats) return undefined;
    const device = topology?.devices.find(d => d.id === deviceId);
    if (!device) return undefined;
    const key = device.primaryIp || device.name;
    return (key ? deviceStats.get(key) : undefined) || (device.name ? deviceStats.get(device.name) : undefined);
  }, [deviceStats, topology]);

  const getLinkStats = useCallback((connectionId: string) => {
    return linkEnrichment?.get(connectionId);
  }, [linkEnrichment]);

  // === Modification callbacks (tracked with source='ai') ===

  const addDevice = useCallback(async (deviceData: Partial<Device>): Promise<Device> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    const newDevice: Device = {
      id: `device-${crypto.randomUUID()}`,
      name: deviceData.name || 'New Device',
      type: (deviceData.type as DeviceType) || 'unknown',
      status: (deviceData.status as DeviceStatus) || 'unknown',
      x: deviceData.x ?? 500,
      y: deviceData.y ?? 500,
      sessionId: deviceData.sessionId,
      site: deviceData.site,
      role: deviceData.role,
      platform: deviceData.platform,
      primaryIp: deviceData.primaryIp,
      vendor: deviceData.vendor,
      version: deviceData.version,
      model: deviceData.model,
    };

    // For non-temporary topologies, save to backend first
    if (!isTemporary && effectiveTopologyId) {
      try {
        const created = await createDevice(effectiveTopologyId, {
          name: newDevice.name,
          type: newDevice.type,
          x: newDevice.x,
          y: newDevice.y,
          session_id: newDevice.sessionId,
          site: newDevice.site,
          role: newDevice.role,
          status: newDevice.status,
        });
        newDevice.id = created.id;
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to create device in backend:', err);
        throw err;
      }
    }

    // Update local state
    setTopology(prev => {
      if (!prev) return prev;
      return { ...prev, devices: [...prev.devices, newDevice] };
    });

    // Track in history with AI source
    const action = pushAction({
      type: 'add_device',
      source: 'ai',
      description: `Added device ${newDevice.name}`,
      data: {
        before: null,
        after: newDevice,
        context: { topologyId: effectiveTopologyId, deviceId: newDevice.id },
      },
    });

    // Show toast
    showAIActionToast?.(action);

    return newDevice;
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  const removeDevice = useCallback(async (deviceId: string): Promise<void> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    const device = topology.devices.find(d => d.id === deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Delete from backend first (if not temporary)
    if (!isTemporary && effectiveTopologyId) {
      try {
        await deleteDevice(effectiveTopologyId, deviceId);
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to delete device from backend:', err);
        throw err;
      }
    }

    // Update local state (also remove connected connections)
    setTopology(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        devices: prev.devices.filter(d => d.id !== deviceId),
        connections: prev.connections.filter(
          c => c.sourceDeviceId !== deviceId && c.targetDeviceId !== deviceId
        ),
      };
    });

    // Track in history
    const action = pushAction({
      type: 'remove_device',
      source: 'ai',
      description: `Removed device ${device.name}`,
      data: {
        before: device,
        after: null,
        context: { topologyId: effectiveTopologyId, deviceId },
      },
    });

    showAIActionToast?.(action);
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  const updateDevice = useCallback(async (deviceId: string, updates: Partial<Device>): Promise<Device> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    const device = topology.devices.find(d => d.id === deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    const updatedDevice: Device = { ...device, ...updates };

    // Update in backend (if not temporary)
    if (!isTemporary && effectiveTopologyId) {
      const { request, dropped } = toDeviceUpdateRequest(updates);
      if (dropped.length > 0) {
        console.warn('[useTopologyAICallbacks] Dropping device update fields the agent does not persist:', dropped);
      }
      try {
        if (Object.keys(request).length > 0) {
          await apiUpdateDevice(effectiveTopologyId, deviceId, request);
        }
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to update device in backend:', err);
        throw err;
      }
    }

    // Update local state
    setTopology(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        devices: prev.devices.map(d => d.id === deviceId ? updatedDevice : d),
      };
    });

    // Track in history
    const action = pushAction({
      type: 'update_device',
      source: 'ai',
      description: `Updated device ${device.name}`,
      data: {
        before: device,
        after: updatedDevice,
        context: { topologyId: effectiveTopologyId, deviceId },
      },
    });

    showAIActionToast?.(action);

    return updatedDevice;
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  const moveDevice = useCallback(async (deviceId: string, x: number, y: number): Promise<void> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    const device = topology.devices.find(d => d.id === deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    const beforePosition = { x: device.x, y: device.y };

    // Update in backend (if not temporary)
    if (!isTemporary && effectiveTopologyId) {
      try {
        await updateDevicePosition(effectiveTopologyId, deviceId, x, y);
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to move device in backend:', err);
        throw err;
      }
    }

    // Update local state
    setTopology(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        devices: prev.devices.map(d => d.id === deviceId ? { ...d, x, y } : d),
      };
    });

    // Track in history
    const action = pushAction({
      type: 'move_device',
      source: 'ai',
      description: `Moved device ${device.name}`,
      data: {
        before: beforePosition,
        after: { x, y },
        context: { topologyId: effectiveTopologyId, deviceId },
      },
    });

    showAIActionToast?.(action);
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  const addConnection = useCallback(async (connData: Partial<Connection>): Promise<Connection> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    if (!connData.sourceDeviceId || !connData.targetDeviceId) {
      throw new Error('Source and target device IDs are required');
    }

    const newConnection: Connection = {
      id: `conn-${crypto.randomUUID()}`,
      sourceDeviceId: connData.sourceDeviceId,
      targetDeviceId: connData.targetDeviceId,
      sourceInterface: connData.sourceInterface,
      targetInterface: connData.targetInterface,
      status: (connData.status as ConnectionStatus) || 'active',
      label: connData.label,
    };

    // Create in backend (if not temporary)
    if (!isTemporary && effectiveTopologyId) {
      try {
        const created = await createConnection(effectiveTopologyId, {
          source_device_id: newConnection.sourceDeviceId,
          target_device_id: newConnection.targetDeviceId,
          source_interface: newConnection.sourceInterface,
          target_interface: newConnection.targetInterface,
          label: newConnection.label,
        });
        newConnection.id = created.id;
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to create connection in backend:', err);
        throw err;
      }
    }

    // Update local state
    setTopology(prev => {
      if (!prev) return prev;
      return { ...prev, connections: [...prev.connections, newConnection] };
    });

    // Track in history
    const sourceDevice = topology.devices.find(d => d.id === connData.sourceDeviceId);
    const targetDevice = topology.devices.find(d => d.id === connData.targetDeviceId);
    const connLabel = `${sourceDevice?.name || 'Unknown'} - ${targetDevice?.name || 'Unknown'}`;

    const action = pushAction({
      type: 'add_connection',
      source: 'ai',
      description: `Added connection ${connLabel}`,
      data: {
        before: null,
        after: newConnection,
        context: { topologyId: effectiveTopologyId, connectionId: newConnection.id },
      },
    });

    showAIActionToast?.(action);

    return newConnection;
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  const removeConnection = useCallback(async (connectionId: string): Promise<void> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    const connection = topology.connections.find(c => c.id === connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    // Delete from backend (if not temporary)
    if (!isTemporary && effectiveTopologyId) {
      try {
        await deleteConnection(effectiveTopologyId, connectionId);
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to delete connection from backend:', err);
        throw err;
      }
    }

    // Update local state
    setTopology(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        connections: prev.connections.filter(c => c.id !== connectionId),
      };
    });

    // Track in history
    const sourceDevice = topology.devices.find(d => d.id === connection.sourceDeviceId);
    const targetDevice = topology.devices.find(d => d.id === connection.targetDeviceId);
    const connLabel = `${sourceDevice?.name || 'Unknown'} - ${targetDevice?.name || 'Unknown'}`;

    const action = pushAction({
      type: 'remove_connection',
      source: 'ai',
      description: `Removed connection ${connLabel}`,
      data: {
        before: connection,
        after: null,
        context: { topologyId: effectiveTopologyId, connectionId },
      },
    });

    showAIActionToast?.(action);
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  const updateConnection = useCallback(async (connectionId: string, updates: Partial<Connection>): Promise<Connection> => {
    if (!topology || !effectiveTopologyId) {
      throw new Error('No topology loaded');
    }

    const connection = topology.connections.find(c => c.id === connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const updatedConnection: Connection = { ...connection, ...updates };

    // Update in backend (if not temporary)
    if (!isTemporary && effectiveTopologyId) {
      try {
        // Convert Connection type to API type (waypoints is string in API)
        const apiUpdates: Record<string, unknown> = { ...updates };
        if (updates.waypoints) {
          apiUpdates.waypoints = JSON.stringify(updates.waypoints);
        }
        await apiUpdateConnection(effectiveTopologyId, connectionId, apiUpdates as Parameters<typeof apiUpdateConnection>[2]);
      } catch (err) {
        console.error('[useTopologyAICallbacks] Failed to update connection in backend:', err);
        throw err;
      }
    }

    // Update local state
    setTopology(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        connections: prev.connections.map(c => c.id === connectionId ? updatedConnection : c),
      };
    });

    // Track in history
    const sourceDevice = topology.devices.find(d => d.id === connection.sourceDeviceId);
    const targetDevice = topology.devices.find(d => d.id === connection.targetDeviceId);
    const connLabel = `${sourceDevice?.name || 'Unknown'} - ${targetDevice?.name || 'Unknown'}`;

    const action = pushAction({
      type: 'update_connection',
      source: 'ai',
      description: `Updated connection ${connLabel}`,
      data: {
        before: connection,
        after: updatedConnection,
        context: { topologyId: effectiveTopologyId, connectionId },
      },
    });

    showAIActionToast?.(action);

    return updatedConnection;
  }, [topology, effectiveTopologyId, isTemporary, setTopology, pushAction, showAIActionToast]);

  // === Annotation callbacks (in-memory only, not persisted to backend) ===

  const addAnnotation = useCallback(async (annotationData: Partial<Annotation>): Promise<Annotation> => {
    const annotation: Annotation = {
      id: `annotation-${crypto.randomUUID()}`,
      type: annotationData.type || 'text',
      content: annotationData.content,
      position: annotationData.position || { x: 500, y: 500 },
      style: annotationData.style,
    };
    return annotation;
  }, []);

  const removeAnnotation = useCallback(async (_annotationId: string): Promise<void> => {
    // Annotation removal is handled in TopologyTabEditor state
  }, []);

  const updateAnnotation = useCallback(async (annotationId: string, updates: Partial<Annotation>): Promise<Annotation> => {
    const annotation: Annotation = {
      id: annotationId,
      type: updates.type || 'text',
      content: updates.content,
      position: updates.position || { x: 500, y: 500 },
      style: updates.style,
    };
    return annotation;
  }, []);

  // Build the callbacks object
  const callbacks = useMemo((): TopologyAICallbacks | null => {
    if (!topology) return null;

    return {
      // Queries
      getTopology,
      getDeviceById,
      getConnectionById,

      // Live telemetry
      getDeviceStats,
      getLinkStats,

      // Device operations
      addDevice,
      removeDevice,
      updateDevice,
      moveDevice,

      // Connection operations
      addConnection,
      removeConnection,
      updateConnection,

      // Annotation operations (in-memory only)
      addAnnotation,
      removeAnnotation,
      updateAnnotation,
    };
  }, [
    topology,
    getTopology,
    getDeviceById,
    getConnectionById,
    getDeviceStats,
    getLinkStats,
    addDevice,
    removeDevice,
    updateDevice,
    moveDevice,
    addConnection,
    removeConnection,
    updateConnection,
    addAnnotation,
    removeAnnotation,
    updateAnnotation,
  ]);

  return callbacks;
}
