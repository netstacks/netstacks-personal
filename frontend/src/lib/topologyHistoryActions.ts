/**
 * Topology History Action Executors
 *
 * Handles applying and reverting topology actions (devices, connections, positions).
 * Used by TopologyTabEditor for undo/redo functionality.
 */

import type { Topology, Device, Connection } from '../types/topology';
import type { TopologyAction } from '../types/topologyHistory';
import { updateDevicePosition, createConnection, deleteConnection, deleteDevice } from '../api/topology';

/**
 * One device's position within a bulk move (e.g. auto-layout).
 */
interface BulkMovePosition {
  deviceId: string;
  x: number;
  y: number;
}

/**
 * Direction of action execution
 * - 'undo': Reverse the action (restore before state)
 * - 'redo': Re-apply the action (restore after state)
 */
export type ExecutionDirection = 'undo' | 'redo';

/**
 * Dependencies required for executing history actions
 */
export interface ActionExecutorDeps {
  topologyId: string | undefined;
  isTemporary: boolean;
  setTopology: React.Dispatch<React.SetStateAction<Topology | null>>;
}

/**
 * Apply a device addition (for redo add or undo remove)
 */
function applyAddDevice(
  deviceData: Device,
  deps: ActionExecutorDeps
): void {
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      devices: [...prev.devices, deviceData],
    };
  });
  // Note: Backend re-creation with original ID not supported.
  // Device will only be restored in UI until page refresh.
}

/**
 * Apply a device removal (for undo add or redo remove)
 */
async function applyRemoveDevice(
  deviceData: Device,
  deps: ActionExecutorDeps
): Promise<void> {
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      devices: prev.devices.filter(d => d.id !== deviceData.id),
      connections: prev.connections.filter(
        c => c.sourceDeviceId !== deviceData.id && c.targetDeviceId !== deviceData.id
      ),
    };
  });

  if (!deps.isTemporary && deps.topologyId) {
    await deleteDevice(deps.topologyId, deviceData.id);
  }
}

/**
 * Apply a device position change
 */
async function applyMoveDevice(
  deviceId: string,
  position: { x: number; y: number },
  deps: ActionExecutorDeps
): Promise<void> {
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      devices: prev.devices.map(d =>
        d.id === deviceId ? { ...d, x: position.x, y: position.y } : d
      ),
    };
  });

  if (!deps.isTemporary && deps.topologyId) {
    await updateDevicePosition(deps.topologyId, deviceId, position.x, position.y);
  }
}

/**
 * Apply a connection addition (for redo add or undo remove)
 */
async function applyAddConnection(
  connectionData: Connection,
  deps: ActionExecutorDeps
): Promise<void> {
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      connections: [...prev.connections, connectionData],
    };
  });

  if (!deps.isTemporary && deps.topologyId) {
    await createConnection(deps.topologyId, {
      source_device_id: connectionData.sourceDeviceId,
      target_device_id: connectionData.targetDeviceId,
      source_interface: connectionData.sourceInterface,
      target_interface: connectionData.targetInterface,
      label: connectionData.label,
    });
  }
}

/**
 * Apply a connection removal (for undo add or redo remove)
 */
async function applyRemoveConnection(
  connectionData: Connection,
  deps: ActionExecutorDeps
): Promise<void> {
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      connections: prev.connections.filter(c => c.id !== connectionData.id),
    };
  });

  if (!deps.isTemporary && deps.topologyId) {
    await deleteConnection(deps.topologyId, connectionData.id);
  }
}

/**
 * Apply a set of device positions in one state update, then persist each.
 */
async function applyBulkMove(
  positions: BulkMovePosition[],
  deps: ActionExecutorDeps
): Promise<void> {
  const byId = new Map(positions.map(p => [p.deviceId, p]));
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      devices: prev.devices.map(d => {
        const np = byId.get(d.id);
        return np ? { ...d, x: np.x, y: np.y } : d;
      }),
    };
  });

  if (!deps.isTemporary && deps.topologyId) {
    for (const pos of positions) {
      await updateDevicePosition(deps.topologyId, pos.deviceId, pos.x, pos.y);
    }
  }
}

/**
 * Apply bulk device/connection addition (for undo bulk_remove).
 */
function applyBulkAdd(
  payload: { devices: Device[]; connections: Connection[] },
  deps: ActionExecutorDeps
): void {
  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      devices: [...prev.devices, ...payload.devices],
      connections: [...prev.connections, ...payload.connections],
    };
  });
  // Note: Backend re-creation with original IDs not supported.
  // Devices/connections will only be restored in UI until page refresh.
}

/**
 * Apply bulk device/connection removal (for redo bulk_remove).
 */
async function applyBulkRemove(
  payload: { devices: Device[]; connections: Connection[] },
  deps: ActionExecutorDeps
): Promise<void> {
  const deviceIds = new Set(payload.devices.map(d => d.id));
  const connectionIds = new Set(payload.connections.map(c => c.id));

  deps.setTopology(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      devices: prev.devices.filter(d => !deviceIds.has(d.id)),
      connections: prev.connections.filter(c =>
        !connectionIds.has(c.id) &&
        !deviceIds.has(c.sourceDeviceId) &&
        !deviceIds.has(c.targetDeviceId)
      ),
    };
  });

  if (!deps.isTemporary && deps.topologyId) {
    for (const device of payload.devices) {
      try {
        await deleteDevice(deps.topologyId, device.id);
      } catch (error) {
        console.error(`Failed to delete device ${device.id}:`, error);
        // Continue with remaining deletions
      }
    }
  }
}

/**
 * Execute a topology action in the specified direction (undo or redo).
 *
 * This unified function handles both undo and redo by selecting the appropriate
 * state (before vs after) based on direction.
 *
 * @param action - The action to execute
 * @param direction - Whether to undo or redo the action
 * @param deps - Dependencies for state updates and API calls
 */
export async function executeHistoryAction(
  action: TopologyAction,
  direction: ExecutionDirection,
  deps: ActionExecutorDeps
): Promise<void> {
  const isUndo = direction === 'undo';

  switch (action.type) {
    case 'add_device': {
      const deviceData = action.data.after as Device;
      if (!deviceData) break;

      if (isUndo) {
        // Undo add = remove the device
        await applyRemoveDevice(deviceData, deps);
      } else {
        // Redo add = add the device back
        applyAddDevice(deviceData, deps);
      }
      break;
    }

    case 'remove_device': {
      const deviceData = action.data.before as Device;
      if (!deviceData) break;

      if (isUndo) {
        // Undo remove = re-add the device
        applyAddDevice(deviceData, deps);
      } else {
        // Redo remove = remove the device again
        await applyRemoveDevice(deviceData, deps);
      }
      break;
    }

    case 'move_device': {
      const deviceId = action.data.context?.deviceId;
      if (!deviceId) break;

      // Select position based on direction
      const position = isUndo
        ? action.data.before as { x: number; y: number } | null
        : action.data.after as { x: number; y: number } | null;

      if (position) {
        await applyMoveDevice(deviceId, position, deps);
      }
      break;
    }

    case 'add_connection': {
      const connectionData = action.data.after as Connection;
      if (!connectionData) break;

      if (isUndo) {
        // Undo add = remove the connection
        await applyRemoveConnection(connectionData, deps);
      } else {
        // Redo add = add the connection back
        await applyAddConnection(connectionData, deps);
      }
      break;
    }

    case 'remove_connection': {
      const connectionData = action.data.before as Connection;
      if (!connectionData) break;

      if (isUndo) {
        // Undo remove = re-add the connection
        await applyAddConnection(connectionData, deps);
      } else {
        // Redo remove = remove the connection again
        await applyRemoveConnection(connectionData, deps);
      }
      break;
    }

    case 'bulk': {
      const positions = (isUndo ? action.data.before : action.data.after) as BulkMovePosition[] | null;
      if (positions && Array.isArray(positions)) {
        await applyBulkMove(positions, deps);
      }
      break;
    }

    case 'bulk_remove': {
      const payload = action.data.before as { devices: Device[]; connections: Connection[] } | null;
      if (!payload) break;

      if (isUndo) {
        // Undo bulk_remove = re-add the devices and connections
        applyBulkAdd(payload, deps);
      } else {
        // Redo bulk_remove = remove the devices and connections again
        await applyBulkRemove(payload, deps);
      }
      break;
    }

    default:
      console.warn(`[TopologyHistory] Unhandled ${direction} action type:`, action.type);
  }
}
