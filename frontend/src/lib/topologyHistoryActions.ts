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

    default:
      console.warn(`[TopologyHistory] Unhandled ${direction} action type:`, action.type);
  }
}
