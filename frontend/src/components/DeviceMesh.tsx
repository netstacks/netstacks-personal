// 3D mesh representation of a network device
// Renders type-specific geometry with hover/selection effects and drag support

import { useRef, useState, useCallback } from 'react';
import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Device, DeviceType } from '../types/topology';
import type { DeviceLiveStats } from '../hooks/useTopologyLive';

interface DeviceMeshProps {
  /** Device data */
  device: Device;
  /** Pre-calculated 3D position [x, y, z] */
  position: [number, number, number];
  /** Whether this device is selected */
  isSelected: boolean;
  /** Whether this device is hovered */
  isHovered: boolean;
  /** Click handler (with screen position for overlay) */
  onClick: (screenPosition: { x: number; y: number }) => void;
  /** Double-click handler (with screen position for overlay) */
  onDoubleClick?: (screenPosition: { x: number; y: number }) => void;
  /** Right-click handler for context menu */
  onContextMenu?: (screenPosition: { x: number; y: number }) => void;
  /** Pointer enter handler */
  onPointerOver: () => void;
  /** Pointer leave handler */
  onPointerOut: () => void;
  /** Called during drag with intermediate 2D world position */
  onDrag?: (x: number, y: number) => void;
  /** Called when drag ends with final 2D world position */
  onDragEnd?: (x: number, y: number) => void;
  /** Whether connection drawing mode is active */
  drawingConnection?: boolean;
  /** Whether this device is the connection source */
  isConnectionSource?: boolean;
  /** Callback when clicked during connection drawing */
  onClickForConnection?: () => boolean;
  /** Device-level live stats for health ring */
  deviceStats?: DeviceLiveStats;
}

/** Device type to 3D color mapping */
const DEVICE_COLORS: Record<DeviceType, string> = {
  router: '#2196f3',           // Blue
  switch: '#4caf50',           // Green
  firewall: '#f44336',         // Red
  server: '#9e9e9e',           // Gray
  cloud: '#ffffff',            // White
  'access-point': '#00bcd4',   // Cyan
  'load-balancer': '#00bcd4',  // Cyan
  'wan-optimizer': '#9c27b0',  // Purple
  'voice-gateway': '#607d8b',  // Blue-gray
  'wireless-controller': '#3f51b5', // Indigo
  storage: '#795548',          // Brown
  virtual: '#009688',          // Teal
  'sd-wan': '#8bc34a',         // Light green
  iot: '#ff5722',              // Deep orange
  unknown: '#607d8b',          // Blue-gray
};

/** Device type to mesh height (for label positioning) */
const DEVICE_HEIGHTS: Record<DeviceType, number> = {
  router: 20,
  switch: 6,
  firewall: 25,
  server: 35,
  cloud: 15,
  'access-point': 20,
  'load-balancer': 15,
  'wan-optimizer': 20,
  'voice-gateway': 20,
  'wireless-controller': 20,
  storage: 25,
  virtual: 15,
  'sd-wan': 15,
  iot: 15,
  unknown: 15,
};

/**
 * Get geometry JSX based on device type
 */
function DeviceGeometry({ type }: { type: DeviceType }) {
  switch (type) {
    case 'router':
      // Cylinder: radius top, radius bottom, height, radial segments
      return <cylinderGeometry args={[8, 8, 20, 16]} />;
    case 'switch':
      // Flat wide box: width, height, depth
      return <boxGeometry args={[30, 6, 20]} />;
    case 'firewall':
      // Tall thin box
      return <boxGeometry args={[20, 25, 10]} />;
    case 'server':
      // Tall box
      return <boxGeometry args={[15, 35, 15]} />;
    case 'cloud':
      // Sphere: radius, width segments, height segments
      return <sphereGeometry args={[15, 16, 16]} />;
    case 'access-point':
      // Cone: radius, height, radial segments
      return <coneGeometry args={[10, 20, 8]} />;
    case 'unknown':
    default:
      // Simple cube
      return <boxGeometry args={[15, 15, 15]} />;
  }
}

/**
 * Convert 3D world position to 2D topology coordinates (0-1000)
 */
function to2DCoords(worldX: number, worldZ: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1000, worldX + 500)),
    y: Math.max(0, Math.min(1000, worldZ + 500)),
  };
}

/**
 * DeviceMesh - Renders a single device as a 3D mesh
 *
 * Features:
 * - Type-specific geometry (cylinder, box, sphere, cone)
 * - Type-based color
 * - Hover effect with emissive glow
 * - Selection effect with scale and glow
 * - Floating label above mesh
 * - Click and double-click handlers
 * - Drag to reposition (raycast against horizontal plane)
 */
export default function DeviceMesh({
  device,
  position,
  isSelected,
  isHovered,
  onClick,
  onDoubleClick,
  onContextMenu,
  onPointerOver,
  onPointerOut,
  onDrag,
  onDragEnd,
  drawingConnection = false,
  isConnectionSource = false,
  onClickForConnection,
  deviceStats,
}: DeviceMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const [localHover, setLocalHover] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ screenX: number; screenY: number; worldX: number; worldZ: number } | null>(null);

  // Access Three.js state for raycasting during drag
  const { camera, gl, raycaster } = useThree();

  // Plane for raycasting during drag (Y=0 horizontal plane)
  const dragPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));

  const isNeighbor = device.isNeighbor ?? false;
  const baseColor = DEVICE_COLORS[device.type] || DEVICE_COLORS.unknown;
  const meshHeight = DEVICE_HEIGHTS[device.type] || 15;
  const labelYOffset = meshHeight / 2 + 15;

  // Combine external hover state with local hover for visual effect
  const showHoverEffect = isHovered || localHover;

  // Calculate scale based on selection, dragging, or connection source
  const scale = isDragging ? 1.1 : (isSelected || isConnectionSource ? 1.15 : 1);

  // Calculate emissive intensity based on hover/selection/dragging/connection source
  // Connection source gets blue glow
  const emissiveIntensity = isDragging ? 0.5 : (isConnectionSource ? 0.5 : (isSelected ? 0.4 : (showHoverEffect ? 0.3 : 0)));

  // Emissive color - blue for connection source, otherwise same as base
  const emissiveColor = isConnectionSource ? '#2196f3' : baseColor;

  /**
   * Raycast to find intersection with drag plane
   */
  const raycastToPlane = useCallback((clientX: number, clientY: number): THREE.Vector3 | null => {
    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );

    raycaster.setFromCamera(mouse, camera);
    const intersection = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(dragPlane.current, intersection);
    return hit ? intersection : null;
  }, [camera, gl, raycaster]);

  /**
   * Handle pointer down to start drag
   */
  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return; // Only left click starts drag

    // Check if we're in connection drawing mode first
    if (drawingConnection && onClickForConnection) {
      e.stopPropagation();
      const handled = onClickForConnection();
      if (handled) return;
    }

    // Check if drag is enabled
    if (!onDrag && !onDragEnd) return;

    e.stopPropagation();
    setIsDragging(true);
    dragStartRef.current = {
      screenX: e.nativeEvent.clientX,
      screenY: e.nativeEvent.clientY,
      worldX: position[0],
      worldZ: position[2],
    };

    // Capture pointer for drag events outside the mesh
    (e.target as HTMLElement).setPointerCapture?.(e.nativeEvent.pointerId);
  }, [onDrag, onDragEnd, position, drawingConnection, onClickForConnection]);

  /**
   * Handle pointer move during drag
   */
  const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!isDragging || !dragStartRef.current) return;

    e.stopPropagation();

    const intersection = raycastToPlane(e.nativeEvent.clientX, e.nativeEvent.clientY);
    if (intersection && onDrag) {
      const coords2D = to2DCoords(intersection.x, intersection.z);
      onDrag(coords2D.x, coords2D.y);
    }
  }, [isDragging, raycastToPlane, onDrag]);

  /**
   * Handle pointer up to end drag
   */
  const handlePointerUp = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!isDragging || !dragStartRef.current) return;

    e.stopPropagation();

    // Release pointer capture
    (e.target as HTMLElement).releasePointerCapture?.(e.nativeEvent.pointerId);

    // Check if it was a click (not a drag)
    const dx = Math.abs(e.nativeEvent.clientX - dragStartRef.current.screenX);
    const dy = Math.abs(e.nativeEvent.clientY - dragStartRef.current.screenY);
    const wasDrag = dx > 5 || dy > 5;

    if (wasDrag) {
      // It was a drag - save final position
      const intersection = raycastToPlane(e.nativeEvent.clientX, e.nativeEvent.clientY);
      if (intersection && onDragEnd) {
        const coords2D = to2DCoords(intersection.x, intersection.z);
        onDragEnd(coords2D.x, coords2D.y);
      }
    } else {
      // It was a click - trigger click handler
      onClick({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
    }

    setIsDragging(false);
    dragStartRef.current = null;
  }, [isDragging, raycastToPlane, onClick, onDragEnd]);

  const handleDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // Extract screen position from native event for overlay positioning
    onDoubleClick?.({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };

  const handleContextMenu = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onContextMenu?.({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!isDragging) {
      setLocalHover(true);
      onPointerOver();
    }
  };

  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!isDragging) {
      setLocalHover(false);
      onPointerOut();
    }
  };

  // Adjust Y position so mesh sits on ground plane
  const adjustedPosition: [number, number, number] = [
    position[0],
    position[1] + meshHeight / 2,
    position[2],
  ];

  return (
    <group
      ref={groupRef}
      position={adjustedPosition}
      scale={scale}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      {/* Visible device mesh */}
      <mesh ref={meshRef}>
        <DeviceGeometry type={device.type} />
        <meshStandardMaterial
          color={baseColor}
          emissive={emissiveColor}
          emissiveIntensity={emissiveIntensity}
          metalness={0.3}
          roughness={0.7}
          opacity={isNeighbor ? 0.4 : 1}
          transparent={isNeighbor}
          wireframe={isNeighbor}
        />
      </mesh>

      {/* Invisible hitbox for easier clicking - must use opacity not visible for raycasting */}
      <mesh>
        <sphereGeometry args={[Math.max(meshHeight, 20), 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Health ring from live SNMP device stats */}
      {deviceStats && deviceStats.interfaceSummary.total > 0 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -meshHeight / 2 + 0.5, 0]}>
          <ringGeometry args={[Math.max(meshHeight, 20) + 2, Math.max(meshHeight, 20) + 5, 32]} />
          <meshBasicMaterial color={deviceStats.healthColor} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Floating label above device */}
      <Html
        position={[0, labelYOffset, 0]}
        center
        occlude={false}
        zIndexRange={[100, 0]}
        style={{
          pointerEvents: 'none',
          zIndex: 100,
        }}
      >
        <div
          style={{
            color: 'white',
            fontSize: '12px',
            fontFamily: 'sans-serif',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
            padding: '2px 6px',
            borderRadius: '3px',
            background: isDragging
              ? 'rgba(33, 150, 243, 0.7)'
              : (showHoverEffect || isSelected
                ? 'rgba(0,0,0,0.7)'
                : 'rgba(0,0,0,0.4)'),
          }}
        >
          {device.name}
        </div>
      </Html>

      {/* Compact stats label below device name */}
      {deviceStats && deviceStats.interfaceSummary.total > 0 && (
        <Html
          position={[0, labelYOffset - 14, 0]}
          center
          occlude={false}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{
            color: '#ccc',
            fontSize: '9px',
            fontFamily: 'monospace',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            background: 'rgba(0,0,0,0.6)',
            padding: '1px 5px',
            borderRadius: '3px',
          }}>
            {deviceStats.interfaceSummary.up}/{deviceStats.interfaceSummary.total} Up
            {deviceStats.cpuPercent !== null && ` | CPU ${Math.round(deviceStats.cpuPercent)}%`}
            {deviceStats.memoryPercent !== null && ` | Mem ${Math.round(deviceStats.memoryPercent)}%`}
          </div>
        </Html>
      )}

      {/* Neighbor "N" badge */}
      {isNeighbor && (
        <Html
          position={[0, labelYOffset + 18, 0]}
          center
          occlude={false}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{
            background: '#666',
            color: 'white',
            borderRadius: '50%',
            width: '16px',
            height: '16px',
            fontSize: '10px',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>N</div>
        </Html>
      )}
    </group>
  );
}
