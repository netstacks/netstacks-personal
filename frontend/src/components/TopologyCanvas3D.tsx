import { useState, useEffect, useCallback, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Environment, KeyboardControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Topology, Device, Connection } from '../types/topology';
import type { LiveStatsMap, DeviceStatsMap } from '../hooks/useTopologyLive';
import NetworkScene from './NetworkScene';
import FlyControls, { FLY_CONTROLS_MAP } from './FlyControls';
import AIInlinePopup from './AIInlinePopup';
import type { AiContext, DeviceContext, ConnectionContext } from '../api/ai';
import './TopologyCanvas3D.css';

/** Initial camera position type */
type CameraPosition = 'top-down' | 'perspective';

/** AI popup state for topology context menu */
interface AIPopupState {
  isOpen: boolean;
  position: { x: number; y: number };
  action: 'explain' | 'fix' | 'suggest' | 'topology-device' | 'topology-link';
  context: AiContext;
  selectedText: string;
}

interface TopologyCanvas3DProps {
  /** Topology data to render */
  topology: Topology | null;
  /** Currently selected device ID (controlled) */
  selectedDeviceId?: string | null;
  /** Callback when a device is clicked (with screen position for overlay) */
  onDeviceClick?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Callback when a device is double-clicked (with screen position for overlay) */
  onDeviceDoubleClick?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Callback when a device is right-clicked (context menu) */
  onDeviceContextMenu?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Callback when a connection is clicked (with screen position for overlay) */
  onConnectionClick?: (connection: Connection, screenPosition: { x: number; y: number }) => void;
  /** Callback when a connection is right-clicked (context menu) */
  onConnectionContextMenu?: (connection: Connection, screenPosition: { x: number; y: number }) => void;
  /** Callback when device position changes (drag to reposition) */
  onDevicePositionChange?: (deviceId: string, x: number, y: number) => void;
  /** Whether connection drawing mode is active */
  drawingConnection?: boolean;
  /** Source device for connection drawing */
  connectionSource?: Device | null;
  /** Callback when a device is clicked during connection drawing */
  onDeviceClickForConnection?: (device: Device) => boolean;
  /** Live SNMP stats from topology-live WebSocket (host:ifDescr -> stats) */
  liveStats?: LiveStatsMap;
  /** Device-level live stats (host -> device stats with health score) */
  deviceStats?: DeviceStatsMap;
  /** Initial camera position style */
  initialCameraPosition?: CameraPosition;
  /** Animate camera to perspective position on mount */
  animateOnMount?: boolean;
  /** Additional CSS class */
  className?: string;
}

/** Coordinate space size (matches 2D: 0-1000) */
const WORLD_SIZE = 1000;

/** Camera position presets */
const CAMERA_POSITIONS = {
  'top-down': {
    position: new THREE.Vector3(0, 800, 1),
    target: new THREE.Vector3(0, 0, 0),
  },
  'perspective': {
    position: new THREE.Vector3(0, 300, 500),
    target: new THREE.Vector3(0, 0, 0),
  },
};

/** Animation duration in milliseconds */
const CAMERA_ANIMATION_DURATION = 500;

/**
 * Cubic ease-out function for smooth deceleration
 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * CameraDistanceTracker - Reports camera distance changes to parent component.
 * Only fires callback when distance changes by more than 10 units to avoid jitter.
 * Must be used inside Canvas context.
 */
function CameraDistanceTracker({ onChange }: { onChange: (distance: number) => void }) {
  const { camera } = useThree();
  const lastReported = useRef(0);

  useFrame(() => {
    const distance = camera.position.length();
    if (Math.abs(distance - lastReported.current) > 10) {
      lastReported.current = distance;
      onChange(distance);
    }
  });

  return null;
}

/**
 * CameraAnimator - Animates camera from current position to target
 * Must be used inside Canvas context
 */
interface CameraAnimatorProps {
  targetPosition: THREE.Vector3;
  targetLookAt: THREE.Vector3;
  duration?: number;
  enabled?: boolean;
  onComplete?: () => void;
}

function CameraAnimator({
  targetPosition,
  targetLookAt,
  duration = CAMERA_ANIMATION_DURATION,
  enabled = true,
  onComplete,
}: CameraAnimatorProps) {
  const { camera } = useThree();
  const startPos = useRef<THREE.Vector3 | null>(null);
  const startTime = useRef<number | null>(null);
  const hasCompleted = useRef(false);

  // Reset animation when target changes
  useEffect(() => {
    if (enabled) {
      startPos.current = null;
      startTime.current = null;
      hasCompleted.current = false;
    }
  }, [enabled, targetPosition]);

  useFrame((state) => {
    if (!enabled || hasCompleted.current) return;

    // Initialize start position on first frame
    if (startTime.current === null) {
      startTime.current = state.clock.elapsedTime * 1000;
      startPos.current = camera.position.clone();
    }

    const elapsed = state.clock.elapsedTime * 1000 - startTime.current;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(t);

    // Interpolate position
    if (startPos.current) {
      camera.position.lerpVectors(startPos.current, targetPosition, eased);
    }

    // Always look at target during animation
    camera.lookAt(targetLookAt);

    // Mark as complete when animation finishes
    if (t >= 1 && !hasCompleted.current) {
      hasCompleted.current = true;
      onComplete?.();
    }
  });

  return null;
}

/** Control mode type */
type ControlMode = 'orbit' | 'fly';

/**
 * Convert 2D coordinates (0-1000) to 3D coordinates (-500 to +500)
 * Y is always 0 (devices sit on XZ plane)
 */
export function toWorld3D(x2d: number, y2d: number): { x: number; y: number; z: number } {
  return {
    x: x2d - (WORLD_SIZE / 2),
    y: 0,
    z: y2d - (WORLD_SIZE / 2),
  };
}

/**
 * Scene content component - contains all 3D objects
 */
function SceneContent() {
  return (
    <>
      {/* Ambient light for overall scene illumination */}
      <ambientLight intensity={0.4} />

      {/* Directional light for shadows and depth */}
      <directionalLight
        position={[100, 200, 100]}
        intensity={0.8}
        castShadow
      />

      {/* Grid helper on XZ plane - 500x500 units, 20 divisions */}
      <Grid
        position={[0, -0.1, 0]}
        args={[500, 500]}
        cellSize={25}
        cellThickness={0.5}
        cellColor="#2a2a2a"
        sectionSize={125}
        sectionThickness={1}
        sectionColor="#3a3a3a"
        fadeDistance={1000}
        fadeStrength={1}
        followCamera={false}
        infiniteGrid={false}
      />

      {/* Environment for realistic lighting - minimal preset */}
      <Environment preset="night" />
    </>
  );
}

/**
 * TopologyCanvas3D - Renders network topology in 3D using React Three Fiber
 *
 * Features:
 * - PerspectiveCamera positioned above looking at origin
 * - OrbitControls for rotate/zoom/pan interaction (default)
 * - FlyControls for WASD + mouse look navigation (toggle)
 * - Grid helper on XZ plane
 * - Dark background matching 2D theme
 * - Empty state when no topology
 *
 * Coordinate system:
 * - 2D (0-1000, 0-1000) maps to 3D (-500 to 500, Y=0, -500 to 500)
 * - Devices sit on XZ plane (Y=0)
 * - Camera starts above looking down at 45-degree angle
 */
export default function TopologyCanvas3D({
  topology,
  selectedDeviceId,
  onDeviceClick,
  onDeviceDoubleClick,
  onDeviceContextMenu,
  onConnectionClick,
  onConnectionContextMenu,
  onDevicePositionChange,
  drawingConnection = false,
  connectionSource,
  onDeviceClickForConnection,
  liveStats,
  deviceStats,
  initialCameraPosition = 'perspective',
  // animateOnMount disabled for now - OrbitControls needs full control
  animateOnMount: _animateOnMount = true,
  className = '',
}: TopologyCanvas3DProps) {
  // State for hovered device and connection
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null);
  const [hoveredConnectionId, setHoveredConnectionId] = useState<string | null>(null);

  // Camera distance for zoom-tier rendering on connections
  const [cameraDistance, setCameraDistance] = useState<number>(600);

  // Local device positions for dragging (maps device ID to 2D world position)
  const [localDevicePositions, setLocalDevicePositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  // AI popup state for topology context menu
  const [aiPopupState, setAiPopupState] = useState<AIPopupState | null>(null);

  // Control mode state: orbit (default) or fly
  const [controlMode, setControlMode] = useState<ControlMode>('orbit');

  // Camera animation state - temporarily disabled for debugging
  const [isAnimating, setIsAnimating] = useState(false); // Was: useState(animateOnMount)
  const animationTarget = CAMERA_POSITIONS[initialCameraPosition];

  // Handle animation completion
  const handleAnimationComplete = useCallback(() => {
    setIsAnimating(false);
  }, []);

  // Pointer lock state (for fly mode UI feedback)
  const [isPointerLocked, setIsPointerLocked] = useState(false);

  // Instruction overlay visibility
  const [showFlyInstructions, setShowFlyInstructions] = useState(false);
  const [showEscapeHint, setShowEscapeHint] = useState(false);

  // Show instructions when entering fly mode
  const handleModeChange = useCallback((mode: ControlMode) => {
    setControlMode(mode);
    if (mode === 'fly') {
      setShowFlyInstructions(true);
      // Auto-hide after 3 seconds
      setTimeout(() => setShowFlyInstructions(false), 3000);
    } else {
      setShowFlyInstructions(false);
      setShowEscapeHint(false);
    }
  }, []);

  // Handle pointer lock state changes
  const handleLockChange = useCallback((locked: boolean) => {
    setIsPointerLocked(locked);
    if (locked) {
      setShowFlyInstructions(false);
      setShowEscapeHint(true);
      // Auto-hide escape hint after 2 seconds
      setTimeout(() => setShowEscapeHint(false), 2000);
    } else {
      setShowEscapeHint(false);
    }
  }, []);

  // Cleanup when unmounting
  useEffect(() => {
    return () => {
      setShowFlyInstructions(false);
      setShowEscapeHint(false);
    };
  }, []);

  /**
   * Build DeviceContext from Device for AI
   */
  const buildDeviceContext = useCallback((device: Device): DeviceContext => {
    return {
      name: device.name,
      type: device.type,
      platform: device.platform,
      vendor: undefined, // Will be detected by terminal watcher
      primaryIp: device.primaryIp,
      site: device.site,
      role: device.role,
      status: device.status,
    };
  }, []);

  /**
   * Build ConnectionContext from Connection for AI
   */
  const buildConnectionContext = useCallback((connection: Connection): ConnectionContext | null => {
    const sourceDevice = topology?.devices.find(d => d.id === connection.sourceDeviceId);
    const targetDevice = topology?.devices.find(d => d.id === connection.targetDeviceId);
    if (!sourceDevice || !targetDevice) return null;

    return {
      sourceDevice: buildDeviceContext(sourceDevice),
      sourceInterface: connection.sourceInterface || '',
      targetDevice: buildDeviceContext(targetDevice),
      targetInterface: connection.targetInterface || '',
      status: connection.status,
      protocols: connection.protocols,
    };
  }, [topology, buildDeviceContext]);

  /**
   * Handle device right-click with AI popup
   */
  const handleDeviceContextMenu = useCallback((device: Device, screenPosition: { x: number; y: number }) => {
    // Call external handler if provided
    onDeviceContextMenu?.(device, screenPosition);
    // Open AI popup with device context
    const deviceContext = buildDeviceContext(device);
    setAiPopupState({
      isOpen: true,
      position: screenPosition,
      action: 'topology-device',
      context: { device: deviceContext },
      selectedText: `Device: ${device.name} (${device.type})`,
    });
  }, [onDeviceContextMenu, buildDeviceContext]);

  /**
   * Handle connection right-click with AI popup
   */
  const handleConnectionContextMenu = useCallback((connection: Connection, screenPosition: { x: number; y: number }) => {
    // Call external handler if provided
    onConnectionContextMenu?.(connection, screenPosition);
    // Open AI popup with connection context
    const connectionContext = buildConnectionContext(connection);
    if (connectionContext) {
      setAiPopupState({
        isOpen: true,
        position: screenPosition,
        action: 'topology-link',
        context: { connection: connectionContext },
        selectedText: `Link: ${connectionContext.sourceDevice.name} <-> ${connectionContext.targetDevice.name}`,
      });
    }
  }, [onConnectionContextMenu, buildConnectionContext]);

  /**
   * Close AI popup
   */
  const handleAiPopupClose = useCallback(() => {
    setAiPopupState(null);
  }, []);

  // Render empty state if no topology
  if (!topology) {
    return (
      <div className={`topology-canvas3d-container ${className}`}>
        <Canvas
          camera={{
            position: [0, 300, 500],
            fov: 60,
            near: 1,
            far: 5000,
          }}
          style={{ background: '#1e1e1e' }}
        >
          <SceneContent />
          <OrbitControls
            enableDamping
            dampingFactor={0.05}
            minDistance={50}
            maxDistance={2000}
            maxPolarAngle={Math.PI / 2 - 0.1}
          />
        </Canvas>
        <div className="topology-canvas3d-empty">
          <div className="topology-canvas3d-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5">
              <circle cx="12" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="18" r="3" />
              <path d="M12 9v3M9.5 16.5L12 12M14.5 16.5L12 12" />
            </svg>
          </div>
          <h3>No Topology Loaded</h3>
          <p>Import from NetBox or load mock data to visualize your network topology in 3D.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`topology-canvas3d-container ${className}`}>
      <KeyboardControls map={FLY_CONTROLS_MAP}>
        <Canvas
          camera={{
            position: [0, 300, 500],
            fov: 60,
            near: 1,
            far: 5000,
          }}
          style={{
            background: '#1e1e1e',
            cursor: controlMode === 'fly'
              ? (isPointerLocked ? 'none' : 'crosshair')
              : ((hoveredDeviceId || hoveredConnectionId) ? 'pointer' : 'grab'),
          }}
          onPointerMissed={() => {
            setHoveredDeviceId(null);
            setHoveredConnectionId(null);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <SceneContent />

          {/* Track camera distance for zoom-tier rendering */}
          <CameraDistanceTracker onChange={setCameraDistance} />

          {/* Network topology scene with devices and connections */}
          <NetworkScene
            topology={topology}
            selectedDeviceId={selectedDeviceId ?? null}
            hoveredDeviceId={hoveredDeviceId}
            hoveredConnectionId={hoveredConnectionId}
            onDeviceClick={(device, screenPos) => onDeviceClick?.(device, screenPos)}
            onDeviceDoubleClick={(device, screenPos) => onDeviceDoubleClick?.(device, screenPos)}
            onDeviceContextMenu={handleDeviceContextMenu}
            onDeviceHover={(device) => setHoveredDeviceId(device?.id ?? null)}
            onConnectionClick={(conn, screenPos) => onConnectionClick?.(conn, screenPos)}
            onConnectionContextMenu={handleConnectionContextMenu}
            onConnectionHover={(conn) => setHoveredConnectionId(conn?.id ?? null)}
            localDevicePositions={localDevicePositions}
            onDeviceDrag={(deviceId, x, y) => {
              // Update local position during drag for smooth movement
              setLocalDevicePositions(prev => {
                const next = new Map(prev);
                next.set(deviceId, { x, y });
                return next;
              });
            }}
            onDevicePositionChange={(deviceId, x, y) => {
              // Clear local position and save to backend
              setLocalDevicePositions(new Map());
              onDevicePositionChange?.(deviceId, x, y);
            }}
            drawingConnection={drawingConnection}
            connectionSource={connectionSource}
            onDeviceClickForConnection={onDeviceClickForConnection}
            liveStats={liveStats}
            deviceStats={deviceStats}
            cameraDistance={cameraDistance}
          />

          {/* Control mode: Orbit or Fly */}
          {controlMode === 'orbit' ? (
            <OrbitControls
              makeDefault
              enableDamping
              dampingFactor={0.05}
              minDistance={10}
              maxDistance={2000}
              maxPolarAngle={Math.PI / 2 - 0.1}
            />
          ) : (
            <FlyControls
              speed={100}
              onLockChange={handleLockChange}
            />
          )}

          {/* Camera animation when entering 3D view */}
          <CameraAnimator
            targetPosition={animationTarget.position}
            targetLookAt={animationTarget.target}
            enabled={isAnimating}
            onComplete={handleAnimationComplete}
          />
        </Canvas>
      </KeyboardControls>

      {/* Control mode toggle buttons */}
      <div className="topology-canvas3d-mode-toggle">
        <button
          className={`topology-canvas3d-mode-btn ${controlMode === 'orbit' ? 'active' : ''}`}
          onClick={() => handleModeChange('orbit')}
          title="Orbit Mode - Drag to rotate, scroll to zoom"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
            {/* Circular arrows icon for orbit */}
            <circle cx="12" cy="12" r="8" strokeDasharray="4 2" />
            <path d="M12 4V2M12 22v-2M4 12H2M22 12h-2" />
            <path d="M16.95 7.05l1.41-1.41M5.64 18.36l1.41-1.41M16.95 16.95l1.41 1.41M5.64 5.64l1.41 1.41" />
          </svg>
        </button>
        <button
          className={`topology-canvas3d-mode-btn ${controlMode === 'fly' ? 'active' : ''}`}
          onClick={() => handleModeChange('fly')}
          title="Fly Mode - WASD to move, mouse to look"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16">
            {/* Eye/camera icon for fly mode */}
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>

      {/* Fly mode instruction overlay */}
      {showFlyInstructions && controlMode === 'fly' && (
        <div className="topology-canvas3d-fly-instructions">
          <p>Click to enable fly mode</p>
          <p><kbd>WASD</kbd> to move &bull; <kbd>Space</kbd>/<kbd>Shift</kbd> up/down</p>
          <p><kbd>Mouse</kbd> to look &bull; <kbd>Escape</kbd> to exit</p>
        </div>
      )}

      {/* Escape hint when pointer locked */}
      {showEscapeHint && isPointerLocked && (
        <div className="topology-canvas3d-escape-hint">
          Press <kbd>Escape</kbd> to exit
        </div>
      )}

      {/* Crosshair when pointer locked */}
      {isPointerLocked && controlMode === 'fly' && (
        <div className="topology-canvas3d-crosshair" />
      )}

      {/* Controls hint - only show in orbit mode */}
      {controlMode === 'orbit' && (
        <div className="topology-canvas3d-controls-hint">
          <kbd>Drag</kbd> to rotate &bull; <kbd>Scroll</kbd> to zoom &bull; <kbd>Right-drag</kbd> to pan
        </div>
      )}

      {/* AI Inline Popup for topology context menu */}
      {aiPopupState && (
        <AIInlinePopup
          isOpen={aiPopupState.isOpen}
          position={aiPopupState.position}
          action={aiPopupState.action}
          selectedText={aiPopupState.selectedText}
          context={aiPopupState.context}
          onClose={handleAiPopupClose}
        />
      )}
    </div>
  );
}
