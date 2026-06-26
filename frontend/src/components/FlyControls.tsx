import { useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import { useKeyboardControls } from '@react-three/drei';
import { useRef, useEffect, useCallback, type ComponentRef } from 'react';
import * as THREE from 'three';

type PointerLockControlsImpl = ComponentRef<typeof PointerLockControls>;

/**
 * Keyboard control mapping for fly navigation
 * Use with KeyboardControls wrapper from @react-three/drei
 */
export const FLY_CONTROLS_MAP: { name: string; keys: string[] }[] = [
  { name: 'forward', keys: ['KeyW', 'ArrowUp'] },
  { name: 'backward', keys: ['KeyS', 'ArrowDown'] },
  { name: 'left', keys: ['KeyA', 'ArrowLeft'] },
  { name: 'right', keys: ['KeyD', 'ArrowRight'] },
  { name: 'up', keys: ['Space'] },
  { name: 'down', keys: ['ShiftLeft', 'ShiftRight'] },
];

interface FlyControlsProps {
  /** Movement speed (units per second) */
  speed?: number;
  /** Whether controls are enabled */
  enabled?: boolean;
  /** Callback when pointer lock state changes */
  onLockChange?: (isLocked: boolean) => void;
}

/**
 * FlyControls - First-person fly-through navigation
 *
 * Controls:
 * - WASD / Arrow keys: Move forward/backward, strafe left/right
 * - Space: Move up
 * - Shift: Move down (also speed boost when combined with WASD)
 * - Mouse: Look around (when pointer locked)
 * - Click: Lock pointer for mouse look
 * - Escape: Release pointer lock
 *
 * Requires KeyboardControls wrapper with FLY_CONTROLS_MAP in parent component.
 */
export default function FlyControls({
  speed = 100,
  enabled = true,
  onLockChange
}: FlyControlsProps) {
  const controlsRef = useRef<PointerLockControlsImpl>(null);
  const { camera } = useThree();
  const [, getKeys] = useKeyboardControls();

  // Reusable vectors to avoid garbage collection
  const direction = useRef(new THREE.Vector3());
  const cameraDirection = useRef(new THREE.Vector3());
  const cameraRight = useRef(new THREE.Vector3());

  // Handle lock/unlock events
  const handleLock = useCallback(() => {
    onLockChange?.(true);
  }, [onLockChange]);

  const handleUnlock = useCallback(() => {
    onLockChange?.(false);
  }, [onLockChange]);

  // Subscribe to lock events
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    controls.addEventListener('lock', handleLock);
    controls.addEventListener('unlock', handleUnlock);

    return () => {
      controls.removeEventListener('lock', handleLock);
      controls.removeEventListener('unlock', handleUnlock);
    };
  }, [handleLock, handleUnlock]);

  // Movement logic in animation frame
  useFrame((_, delta) => {
    if (!enabled) return;

    const { forward, backward, left, right, up, down } = getKeys() as {
      forward: boolean;
      backward: boolean;
      left: boolean;
      right: boolean;
      up: boolean;
      down: boolean;
    };

    // Reset direction
    direction.current.set(0, 0, 0);

    // Get camera's forward direction (normalized, on XZ plane for WASD)
    camera.getWorldDirection(cameraDirection.current);

    // Get camera's right direction
    cameraRight.current.crossVectors(camera.up, cameraDirection.current).normalize().negate();

    // Calculate movement based on input
    if (forward) direction.current.add(cameraDirection.current);
    if (backward) direction.current.sub(cameraDirection.current);
    if (left) direction.current.add(cameraRight.current);
    if (right) direction.current.sub(cameraRight.current);

    // Vertical movement
    if (up) direction.current.y += 1;
    if (down) direction.current.y -= 1;

    // Apply movement (framerate independent)
    if (direction.current.length() > 0) {
      direction.current.normalize();

      // Speed boost when shift is held with other keys (2x speed)
      const currentSpeed = down && (forward || backward || left || right)
        ? speed * 2
        : speed;

      camera.position.addScaledVector(direction.current, currentSpeed * delta);

      // Boundary limits - prevent camera from going underground or too far
      camera.position.y = Math.max(-50, camera.position.y);
      camera.position.x = Math.max(-1000, Math.min(1000, camera.position.x));
      camera.position.z = Math.max(-1000, Math.min(1000, camera.position.z));
    }
  });

  if (!enabled) return null;

  return <PointerLockControls ref={controlsRef} />;
}
