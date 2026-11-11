// NetworkScene - Renders all devices and connections from topology in 3D
// Part of the Phase 05 3D visualization system

import { useMemo, useRef } from 'react';
import type { Topology, Device, Connection } from '../types/topology';
import type { LiveStatsMap, DeviceStatsMap } from '../hooks/useTopologyLive';
import DeviceMesh from './DeviceMesh';
import ConnectionLine3D from './ConnectionLine3D';
import type { LayerVisibility } from './TopologyToolbar';
import { applyGroupDelta } from '../lib/topologySelection';

interface NetworkSceneProps {
  /** Topology data to render */
  topology: Topology | null;
  /** Layer visibility toggles; each layer defaults to visible when omitted */
  visibleLayers?: LayerVisibility;
  /** Currently selected device ID */
  selectedDeviceId: string | null;
  /** Set of selected device IDs for multi-select */
  selectedDeviceIds?: Set<string>;
  /** Currently hovered device ID */
  hoveredDeviceId: string | null;
  /** Currently hovered connection ID */
  hoveredConnectionId?: string | null;
  /** Device click callback (with screen position for overlay) */
  onDeviceClick: (device: Device, screenPosition: { x: number; y: number }, opts?: { additive?: boolean }) => void;
  /** Device double-click callback (with screen position for overlay) */
  onDeviceDoubleClick?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Device context menu callback (right-click) */
  onDeviceContextMenu?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Device hover callback */
  onDeviceHover: (device: Device | null) => void;
  /** Connection click callback (with screen position for overlay) */
  onConnectionClick?: (connection: Connection, screenPosition: { x: number; y: number }) => void;
  /** Connection context menu callback (right-click) */
  onConnectionContextMenu?: (connection: Connection, screenPosition: { x: number; y: number }) => void;
  /** Connection hover callback */
  onConnectionHover?: (connection: Connection | null) => void;
  /** Callback when device position changes during drag */
  onDevicePositionChange?: (deviceId: string, x: number, y: number) => void;
  /** Callback when group position changes (multi-device drag) */
  onGroupPositionChange?: (moves: { deviceId: string; x: number; y: number }[]) => void;
  /** Local device positions during drag (overrides topology positions) */
  localDevicePositions?: Map<string, { x: number; y: number }>;
  /** Called during drag with intermediate positions */
  onDeviceDrag?: (deviceId: string, x: number, y: number) => void;
  /** Whether connection drawing mode is active */
  drawingConnection?: boolean;
  /** Source device for connection drawing */
  connectionSource?: Device | null;
  /** Callback when a device is clicked during connection drawing */
  onDeviceClickForConnection?: (device: Device) => boolean;
  /** Callback when a device receives pointer down (for marquee conflict detection) */
  onDevicePointerDown?: () => void;
  /** Live SNMP stats from topology-live WebSocket */
  liveStats?: LiveStatsMap;
  /** Device-level live stats (host -> device stats with health score) */
  deviceStats?: DeviceStatsMap;
  /** Camera distance for zoom-tier rendering on connections */
  cameraDistance?: number;
}

// toPosition3D helper moved inline to DeviceMesh

/**
 * NetworkScene - Container component for all 3D topology elements
 *
 * Renders:
 * 1. Connections first (so devices appear on top)
 * 2. Device meshes with type-specific geometry
 *
 * Position mapping:
 * - 2D coordinates (0-1000) map to 3D (-500 to +500 on X/Z)
 * - Y=0 is the ground plane
 */
export default function NetworkScene({
  topology,
  visibleLayers,
  selectedDeviceId,
  selectedDeviceIds,
  hoveredDeviceId,
  hoveredConnectionId,
  onDeviceClick,
  onDeviceDoubleClick,
  onDeviceContextMenu,
  onDeviceHover,
  onConnectionClick,
  onConnectionContextMenu,
  onConnectionHover,
  onDevicePositionChange,
  onGroupPositionChange,
  localDevicePositions,
  onDeviceDrag,
  drawingConnection = false,
  connectionSource,
  onDeviceClickForConnection,
  onDevicePointerDown,
  liveStats,
  deviceStats,
  cameraDistance,
}: NetworkSceneProps) {
  // Track group drag start positions (deviceId -> {x, y})
  const groupDragStartsRef = useRef<Map<string, { x: number; y: number }> | null>(null);

  /**
   * Get device 2D position (from local if dragging, otherwise from device)
   */
  const getDevicePosition2D = (device: Device): { x: number; y: number } => {
    const localPos = localDevicePositions?.get(device.id);
    if (localPos) return localPos;
    return { x: device.x, y: device.y };
  };

  /**
   * Convert 2D position to 3D coordinates
   */
  const toPosition3DFromCoords = (x: number, y: number): [number, number, number] => {
    return [x - 500, 0, y - 500];
  };

  // Pre-calculate device positions for efficient lookup
  // Hook must be called before any early returns (rules of hooks)
  const devicePositions = useMemo(() => {
    if (!topology) return new Map<string, [number, number, number]>();
    const map = new Map<string, [number, number, number]>();
    topology.devices.forEach((d) => {
      const pos2D = getDevicePosition2D(d);
      map.set(d.id, toPosition3DFromCoords(pos2D.x, pos2D.y));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, localDevicePositions]);

  // Return null if no topology data (after hooks)
  if (!topology) return null;

  return (
    <group>
      {/* Connections - render first so devices appear on top */}
      {visibleLayers?.connections !== false && topology.connections.map((conn) => {
        const sourcePos = devicePositions.get(conn.sourceDeviceId);
        const targetPos = devicePositions.get(conn.targetDeviceId);

        // Skip if either device position is not found
        if (!sourcePos || !targetPos) return null;

        const sourceDevice = topology.devices.find(d => d.id === conn.sourceDeviceId);
        const targetDevice = topology.devices.find(d => d.id === conn.targetDeviceId);

        return (
          <ConnectionLine3D
            key={conn.id}
            connection={conn}
            sourcePosition={sourcePos}
            targetPosition={targetPos}
            isHovered={hoveredConnectionId === conn.id}
            onClick={(screenPos) => onConnectionClick?.(conn, screenPos)}
            onContextMenu={(screenPos) => onConnectionContextMenu?.(conn, screenPos)}
            onPointerOver={() => onConnectionHover?.(conn)}
            onPointerOut={() => onConnectionHover?.(null)}
            liveStats={liveStats}
            sourceDeviceIp={sourceDevice?.primaryIp}
            targetDeviceIp={targetDevice?.primaryIp}
            cameraDistance={cameraDistance}
          />
        );
      })}

      {/* Devices - render after connections */}
      {visibleLayers?.devices !== false && topology.devices.map((device) => {
        const position = devicePositions.get(device.id);
        if (!position) return null;

        const isSelected = selectedDeviceIds?.has(device.id) ?? (selectedDeviceId === device.id);
        const isInMultiSelection = selectedDeviceIds && selectedDeviceIds.has(device.id) && selectedDeviceIds.size > 1;

        // Wrap onDrag to handle group drag
        const handleDrag = onDeviceDrag ? (x: number, y: number) => {
          if (isInMultiSelection) {
            // Initialize group drag on first move
            if (!groupDragStartsRef.current) {
              groupDragStartsRef.current = new Map();

              // Record start positions for all selected devices
              topology.devices.forEach((d) => {
                if (selectedDeviceIds.has(d.id)) {
                  groupDragStartsRef.current!.set(d.id, { x: d.x, y: d.y });
                }
              });
            }

            // Compute delta from dragged device's start
            const draggedStart = groupDragStartsRef.current.get(device.id);
            if (draggedStart) {
              const dx = x - draggedStart.x;
              const dy = y - draggedStart.y;

              // Apply delta to all selected devices
              const updatedPositions = applyGroupDelta(groupDragStartsRef.current, dx, dy);
              updatedPositions.forEach((pos, deviceId) => {
                onDeviceDrag(deviceId, pos.x, pos.y);
              });
            }
          } else {
            // Single device drag (not in multi-selection)
            onDeviceDrag(device.id, x, y);
          }
        } : undefined;

        // Wrap onDragEnd to handle group drag end
        const handleDragEnd = onDevicePositionChange || onGroupPositionChange ? (x: number, y: number) => {
          if (isInMultiSelection && groupDragStartsRef.current) {
            // Compute final delta
            const draggedStart = groupDragStartsRef.current.get(device.id);
            if (draggedStart) {
              const dx = x - draggedStart.x;
              const dy = y - draggedStart.y;

              // Apply delta to get final positions
              const finalPositions = applyGroupDelta(groupDragStartsRef.current, dx, dy);

              // Convert to array format for onGroupPositionChange
              const moves = Array.from(finalPositions).map(([deviceId, pos]) => ({
                deviceId,
                x: pos.x,
                y: pos.y,
              }));

              // Clear group drag state
              groupDragStartsRef.current = null;

              // Call group position change handler
              onGroupPositionChange?.(moves);
            }
          } else {
            // Single device drag end
            onDevicePositionChange?.(device.id, x, y);
          }
        } : undefined;

        return (
          <DeviceMesh
            key={device.id}
            device={device}
            position={position}
            isSelected={isSelected}
            isHovered={hoveredDeviceId === device.id}
            onClick={(screenPos, opts) => onDeviceClick(device, screenPos, opts)}
            onDoubleClick={(screenPos) => onDeviceDoubleClick?.(device, screenPos)}
            onContextMenu={(screenPos) => onDeviceContextMenu?.(device, screenPos)}
            onPointerOver={() => onDeviceHover(device)}
            onPointerOut={() => onDeviceHover(null)}
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}
            drawingConnection={drawingConnection}
            isConnectionSource={connectionSource?.id === device.id}
            onClickForConnection={onDeviceClickForConnection ? () => onDeviceClickForConnection(device) : undefined}
            onDevicePointerDown={onDevicePointerDown}
            deviceStats={deviceStats?.get(device.primaryIp || '')}
          />
        );
      })}
    </group>
  );
}
