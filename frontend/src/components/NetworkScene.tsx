// NetworkScene - Renders all devices and connections from topology in 3D
// Part of the Phase 05 3D visualization system

import { useMemo } from 'react';
import type { Topology, Device, Connection } from '../types/topology';
import type { LiveStatsMap, DeviceStatsMap } from '../hooks/useTopologyLive';
import DeviceMesh from './DeviceMesh';
import ConnectionLine3D from './ConnectionLine3D';

interface NetworkSceneProps {
  /** Topology data to render */
  topology: Topology | null;
  /** Currently selected device ID */
  selectedDeviceId: string | null;
  /** Currently hovered device ID */
  hoveredDeviceId: string | null;
  /** Currently hovered connection ID */
  hoveredConnectionId?: string | null;
  /** Device click callback (with screen position for overlay) */
  onDeviceClick: (device: Device, screenPosition: { x: number; y: number }) => void;
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
  selectedDeviceId,
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
  localDevicePositions,
  onDeviceDrag,
  drawingConnection = false,
  connectionSource,
  onDeviceClickForConnection,
  liveStats,
  deviceStats,
  cameraDistance,
}: NetworkSceneProps) {
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
      {topology.connections.map((conn) => {
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
      {topology.devices.map((device) => {
        const position = devicePositions.get(device.id);
        if (!position) return null;

        return (
          <DeviceMesh
            key={device.id}
            device={device}
            position={position}
            isSelected={selectedDeviceId === device.id}
            isHovered={hoveredDeviceId === device.id}
            onClick={(screenPos) => onDeviceClick(device, screenPos)}
            onDoubleClick={(screenPos) => onDeviceDoubleClick?.(device, screenPos)}
            onContextMenu={(screenPos) => onDeviceContextMenu?.(device, screenPos)}
            onPointerOver={() => onDeviceHover(device)}
            onPointerOut={() => onDeviceHover(null)}
            onDrag={onDeviceDrag ? (x, y) => onDeviceDrag(device.id, x, y) : undefined}
            onDragEnd={onDevicePositionChange ? (x, y) => onDevicePositionChange(device.id, x, y) : undefined}
            drawingConnection={drawingConnection}
            isConnectionSource={connectionSource?.id === device.id}
            onClickForConnection={onDeviceClickForConnection ? () => onDeviceClickForConnection(device) : undefined}
            deviceStats={deviceStats?.get(device.primaryIp || '')}
          />
        );
      })}
    </group>
  );
}
