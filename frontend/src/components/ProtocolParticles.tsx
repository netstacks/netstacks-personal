import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ProtocolDirection } from '../types/topology';

interface ProtocolParticlesProps {
  /** Start position of the path */
  startPosition: [number, number, number];
  /** End position of the path */
  endPosition: [number, number, number];
  /** Particle color */
  color: string;
  /** Flow direction */
  direction: ProtocolDirection;
  /** Animation speed in world units per second */
  speed?: number;
  /** Number of particles to render */
  particleCount?: number;
  /** Size of each particle */
  particleSize?: number;
}

/** Y offset for particles (slightly above the connection line) */
const PARTICLE_Y_OFFSET = 3;

/**
 * ProtocolParticles - Animated particles flowing along a connection path
 *
 * Renders small particles that animate from source to target (or bidirectional)
 * to visualize protocol activity on network connections.
 */
export default function ProtocolParticles({
  startPosition,
  endPosition,
  color,
  direction,
  speed = 50,
  particleCount = 3,
  particleSize = 4,
}: ProtocolParticlesProps) {
  const particlesRef = useRef<THREE.Points>(null);
  const reverseParticlesRef = useRef<THREE.Points>(null);

  // Calculate path length for speed normalization
  const pathLength = useMemo(() => {
    return new THREE.Vector3(...endPosition)
      .sub(new THREE.Vector3(...startPosition))
      .length();
  }, [startPosition, endPosition]);

  // Create BufferGeometry with positions for forward particles
  const forwardGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const arr = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const t = i / particleCount;
      arr[i * 3] = startPosition[0] + (endPosition[0] - startPosition[0]) * t;
      arr[i * 3 + 1] =
        startPosition[1] +
        (endPosition[1] - startPosition[1]) * t +
        PARTICLE_Y_OFFSET;
      arr[i * 3 + 2] = startPosition[2] + (endPosition[2] - startPosition[2]) * t;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return geometry;
  }, [startPosition, endPosition, particleCount]);

  // Create BufferGeometry for reverse particles (bidirectional only)
  const reverseGeometry = useMemo(() => {
    if (direction !== 'bidirectional') return null;
    const geometry = new THREE.BufferGeometry();
    const arr = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const t = i / particleCount;
      arr[i * 3] = endPosition[0] + (startPosition[0] - endPosition[0]) * t;
      arr[i * 3 + 1] =
        endPosition[1] +
        (startPosition[1] - endPosition[1]) * t +
        PARTICLE_Y_OFFSET;
      arr[i * 3 + 2] = endPosition[2] + (startPosition[2] - endPosition[2]) * t;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return geometry;
  }, [startPosition, endPosition, particleCount, direction]);

  // Animate particles along the path
  useFrame((state) => {
    if (!particlesRef.current) return;

    const posAttr = particlesRef.current.geometry.attributes.position;
    const normalizedSpeed = speed / pathLength;

    for (let i = 0; i < particleCount; i++) {
      // Calculate progress along the path (0-1)
      const baseProgress =
        ((state.clock.elapsedTime * normalizedSpeed + i / particleCount) % 1);

      // Apply direction
      const t = direction === 'target-to-source' ? 1 - baseProgress : baseProgress;

      posAttr.array[i * 3] =
        startPosition[0] + (endPosition[0] - startPosition[0]) * t;
      posAttr.array[i * 3 + 1] =
        startPosition[1] +
        (endPosition[1] - startPosition[1]) * t +
        PARTICLE_Y_OFFSET;
      posAttr.array[i * 3 + 2] =
        startPosition[2] + (endPosition[2] - startPosition[2]) * t;
    }
    posAttr.needsUpdate = true;

    // Animate reverse particles for bidirectional
    if (direction === 'bidirectional' && reverseParticlesRef.current) {
      const reversePosAttr =
        reverseParticlesRef.current.geometry.attributes.position;

      for (let i = 0; i < particleCount; i++) {
        // Offset phase for reverse particles
        const baseProgress =
          ((state.clock.elapsedTime * normalizedSpeed + i / particleCount + 0.5) %
            1);
        const t = 1 - baseProgress; // Reverse direction

        reversePosAttr.array[i * 3] =
          startPosition[0] + (endPosition[0] - startPosition[0]) * t;
        reversePosAttr.array[i * 3 + 1] =
          startPosition[1] +
          (endPosition[1] - startPosition[1]) * t +
          PARTICLE_Y_OFFSET;
        reversePosAttr.array[i * 3 + 2] =
          startPosition[2] + (endPosition[2] - startPosition[2]) * t;
      }
      reversePosAttr.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* Forward particles */}
      <points ref={particlesRef} geometry={forwardGeometry}>
        <pointsMaterial
          size={particleSize}
          color={color}
          transparent
          opacity={0.8}
          sizeAttenuation
          depthWrite={false}
        />
      </points>

      {/* Reverse particles for bidirectional flow */}
      {direction === 'bidirectional' && reverseGeometry && (
        <points ref={reverseParticlesRef} geometry={reverseGeometry}>
          <pointsMaterial
            size={particleSize}
            color={color}
            transparent
            opacity={0.6}
            sizeAttenuation
            depthWrite={false}
          />
        </points>
      )}
    </group>
  );
}
