import { useMemo, useCallback, useRef } from 'react';
import { Line, Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Connection } from '../types/topology';
import { PROTOCOL_COLORS } from '../types/topology';
import type { LiveStatsMap } from '../hooks/useTopologyLive';
import { formatRate } from '../utils/formatRate';
import { computeLinkHealth, findLiveStatsForInterface, formatSpeedPair, statusArrow } from '../utils/linkHealth';
import ProtocolParticles from './ProtocolParticles';

interface ConnectionLine3DProps {
  /** Connection data */
  connection: Connection;
  /** Source device 3D position */
  sourcePosition: [number, number, number];
  /** Target device 3D position */
  targetPosition: [number, number, number];
  /** Whether this connection is currently hovered */
  isHovered: boolean;
  /** Click handler (with screen position for overlay) */
  onClick?: (screenPosition: { x: number; y: number }) => void;
  /** Context menu handler (right-click, with screen position) */
  onContextMenu?: (screenPosition: { x: number; y: number }) => void;
  /** Callback when pointer enters connection */
  onPointerOver: () => void;
  /** Callback when pointer leaves connection */
  onPointerOut: () => void;
  /** Live SNMP stats map */
  liveStats?: LiveStatsMap;
  /** Source device primary IP for stats lookup */
  sourceDeviceIp?: string;
  /** Target device primary IP for stats lookup */
  targetDeviceIp?: string;
  /** Camera distance for zoom-tier rendering */
  cameraDistance?: number;
}

/** Connection status colors matching 2D canvas */
const CONNECTION_COLORS: Record<string, string> = {
  active: '#4caf50',
  inactive: '#666666',
  degraded: '#ff9800',
};

/** Y offset for connections (below devices at Y=0) */
const CONNECTION_Y_OFFSET = -2;

/**
 * ConnectionLine3D - Renders a single network connection as a 3D line
 *
 * Features:
 * - Health-based color and width from live SNMP stats
 * - Zoom-tier labels (compact at medium distance, full stats close up)
 * - Pulse animation for unhealthy links
 * - Error badge for links with errors
 * - Dashed line for down interfaces
 * - Invisible tube geometry for reliable hover detection
 */
export default function ConnectionLine3D({
  connection,
  sourcePosition,
  targetPosition,
  isHovered,
  onClick,
  onContextMenu,
  onPointerOver,
  onPointerOut,
  liveStats,
  sourceDeviceIp,
  targetDeviceIp,
  cameraDistance,
}: ConnectionLine3DProps) {
  // Apply Y offset to keep connections below devices
  const adjustedSource: [number, number, number] = [
    sourcePosition[0],
    CONNECTION_Y_OFFSET,
    sourcePosition[2],
  ];
  const adjustedTarget: [number, number, number] = [
    targetPosition[0],
    CONNECTION_Y_OFFSET,
    targetPosition[2],
  ];

  // Look up live SNMP stats for this connection
  const srcStats = liveStats ? findLiveStatsForInterface(liveStats, sourceDeviceIp, connection.sourceInterface) : undefined;
  const tgtStats = liveStats ? findLiveStatsForInterface(liveStats, targetDeviceIp, connection.targetInterface) : undefined;

  // Compute link health
  const health = computeLinkHealth(srcStats, tgtStats);

  // Get color: health overrides status color
  const statusColor = health?.color || CONNECTION_COLORS[connection.status] || CONNECTION_COLORS.inactive;

  // Calculate line width: health overrides default (scaled for 3D: divide by ~1.5)
  const healthWidth3D = health ? Math.max(1, health.width / 1.5) : undefined;
  const baseWidth = healthWidth3D ?? (connection.status === 'active' ? 2 : 1);
  const lineWidth = isHovered ? baseWidth + 1 : baseWidth;

  // Zoom tier from camera distance
  const zoomTier = cameraDistance === undefined ? 2
    : cameraDistance > 600 ? 1
    : cameraDistance > 300 ? 2
    : 3;

  // Bandwidth/throughput label text
  const bwLabel = useMemo(() => {
    if (!health) return null;
    const displayStats = (srcStats && tgtStats)
      ? ((srcStats.inBps + srcStats.outBps) >= (tgtStats.inBps + tgtStats.outBps) ? srcStats : tgtStats)
      : (srcStats || tgtStats);
    if (!displayStats || (displayStats.inBps === 0 && displayStats.outBps === 0)) return null;
    return `\u2193 ${formatRate(displayStats.inBps)} / \u2191 ${formatRate(displayStats.outBps)}`;
  }, [health, srcStats, tgtStats]);

  // Speed pair text
  const speedText = useMemo(() => {
    return formatSpeedPair(srcStats?.speedMbps, tgtStats?.speedMbps);
  }, [srcStats, tgtStats]);

  // Full stats for tier 3
  const fullStatsLines = useMemo(() => {
    if (!health || zoomTier < 3) return null;
    const lines: string[] = [];
    if (speedText) lines.push(speedText);
    if (bwLabel) lines.push(bwLabel);
    lines.push(`Util: ${Math.round(health.maxUtilization)}%`);
    const totalErrors = health.sourceErrors + health.targetErrors;
    if (totalErrors > 0) lines.push(`Errors: ${totalErrors}`);
    return lines;
  }, [health, zoomTier, speedText, bwLabel]);

  // Pulse animation via useFrame - oscillates line material opacity
  const lineMaterialRef = useRef<THREE.LineBasicMaterial>(null);
  useFrame((state) => {
    if (health?.needsPulse && lineMaterialRef.current) {
      const t = state.clock.elapsedTime;
      lineMaterialRef.current.opacity = 0.6 + 0.4 * Math.abs(Math.sin(t * 3));
    }
  });

  // Create curve for tube geometry (hover detection)
  const tubeCurve = useMemo(() => {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(...adjustedSource),
      new THREE.Vector3(...adjustedTarget),
    ]);
  }, [adjustedSource, adjustedTarget]);

  // Calculate midpoint for label
  const midpoint: [number, number, number] = useMemo(() => {
    return [
      (adjustedSource[0] + adjustedTarget[0]) / 2,
      (adjustedSource[1] + adjustedTarget[1]) / 2 + 5,
      (adjustedSource[2] + adjustedTarget[2]) / 2,
    ];
  }, [adjustedSource, adjustedTarget]);

  // Handle click with screen position extraction
  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onClick?.({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  }, [onClick]);

  // Handle right-click context menu with screen position extraction
  const handleContextMenu = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onContextMenu?.({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  }, [onContextMenu]);

  // Source/target status arrows for labels
  const srcArrow = statusArrow(srcStats?.operStatus);
  const tgtArrow = statusArrow(tgtStats?.operStatus);

  return (
    <group>
      {/* Visible line */}
      <Line
        points={[adjustedSource, adjustedTarget]}
        color={statusColor}
        lineWidth={lineWidth}
        dashed={health?.isDown || connection.status === 'inactive'}
        dashSize={5}
        gapSize={3}
      >
        <lineBasicMaterial
          ref={lineMaterialRef}
          color={statusColor}
          transparent={!!health?.needsPulse}
          opacity={1}
        />
      </Line>

      {/* Invisible tube for hover and click detection (lines are hard to click) */}
      <mesh
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
        renderOrder={-1}
      >
        <tubeGeometry args={[tubeCurve, 1, 3, 8, false]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Error badge - visible at all tiers when errors exist */}
      {health?.hasErrors && (
        <Html
          position={[midpoint[0] + 5, midpoint[1] + 5, midpoint[2]]}
          center
          zIndexRange={[200, 0]}
          style={{
            pointerEvents: 'none',
            zIndex: 200,
          }}
        >
          <div style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            background: '#f44336',
            color: '#fff',
            fontSize: '10px',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}>!</div>
        </Html>
      )}

      {/* Optional connection label at midpoint */}
      {connection.label && zoomTier >= 2 && (
        <Html
          position={midpoint}
          center
          zIndexRange={[100, 0]}
          style={{
            color: statusColor,
            fontSize: '10px',
            fontFamily: 'sans-serif',
            padding: '2px 6px',
            background: 'rgba(30, 30, 30, 0.8)',
            borderRadius: '3px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          {connection.label}
        </Html>
      )}

      {/* Tier 2: Compact stats (speed + throughput) */}
      {zoomTier === 2 && (speedText || bwLabel) && (
        <Html
          position={[midpoint[0], midpoint[1] + (connection.label ? 8 : 0), midpoint[2]]}
          center
          zIndexRange={[100, 0]}
          style={{
            color: health?.color || '#cccccc',
            fontSize: '9px',
            fontFamily: 'monospace',
            padding: '2px 5px',
            background: 'rgba(30, 30, 30, 0.85)',
            borderRadius: '3px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          {speedText ? `${speedText}  ` : ''}{bwLabel || ''}
        </Html>
      )}

      {/* Tier 3: Full stats box */}
      {zoomTier === 3 && fullStatsLines && (
        <Html
          position={[midpoint[0], midpoint[1] + (connection.label ? 8 : 0), midpoint[2]]}
          center
          zIndexRange={[100, 0]}
          style={{
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          <div style={{
            background: 'rgba(30, 30, 30, 0.92)',
            border: `1px solid ${health?.color || '#666'}44`,
            borderRadius: '4px',
            padding: '3px 6px',
            fontFamily: 'monospace',
            fontSize: '9px',
            color: health?.color || '#cccccc',
            whiteSpace: 'nowrap',
            lineHeight: '14px',
          }}>
            {fullStatsLines.map((line, i) => (
              <div key={i} style={{ color: line.startsWith('Errors:') ? '#f44336' : undefined }}>
                {line}
              </div>
            ))}
          </div>
        </Html>
      )}

      {/* Tier 2+: Enhanced source interface label */}
      {zoomTier >= 2 && connection.sourceInterface && (
        <Html
          position={[
            adjustedSource[0] + (adjustedTarget[0] - adjustedSource[0]) * 0.15,
            adjustedSource[1] + 6,
            adjustedSource[2] + (adjustedTarget[2] - adjustedSource[2]) * 0.15,
          ]}
          center
          zIndexRange={[100, 0]}
          style={{
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          <div style={{
            background: 'rgba(30, 30, 30, 0.9)',
            borderRadius: '4px',
            padding: '1px 5px',
            fontFamily: 'sans-serif',
            fontSize: '10px',
            color: srcStats?.operStatus === 1 ? '#4caf50' : srcStats?.operStatus === 2 ? '#f44336' : '#9e9e9e',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
          }}>
            <span>{srcArrow}</span>
            <span>{connection.sourceInterface}</span>
            {srcStats?.speedMbps ? <span style={{ opacity: 0.7 }}>{srcStats.speedMbps >= 1000 ? `${srcStats.speedMbps / 1000}G` : `${srcStats.speedMbps}M`}</span> : null}
            {health && health.sourceErrors > 0 && (
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f44336', display: 'inline-block' }} />
            )}
          </div>
        </Html>
      )}

      {/* Tier 2+: Enhanced target interface label */}
      {zoomTier >= 2 && connection.targetInterface && (
        <Html
          position={[
            adjustedTarget[0] + (adjustedSource[0] - adjustedTarget[0]) * 0.15,
            adjustedTarget[1] + 6,
            adjustedTarget[2] + (adjustedSource[2] - adjustedTarget[2]) * 0.15,
          ]}
          center
          zIndexRange={[100, 0]}
          style={{
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          <div style={{
            background: 'rgba(30, 30, 30, 0.9)',
            borderRadius: '4px',
            padding: '1px 5px',
            fontFamily: 'sans-serif',
            fontSize: '10px',
            color: tgtStats?.operStatus === 1 ? '#4caf50' : tgtStats?.operStatus === 2 ? '#f44336' : '#9e9e9e',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
          }}>
            <span>{tgtArrow}</span>
            <span>{connection.targetInterface}</span>
            {tgtStats?.speedMbps ? <span style={{ opacity: 0.7 }}>{tgtStats.speedMbps >= 1000 ? `${tgtStats.speedMbps / 1000}G` : `${tgtStats.speedMbps}M`}</span> : null}
            {health && health.targetErrors > 0 && (
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f44336', display: 'inline-block' }} />
            )}
          </div>
        </Html>
      )}

      {/* Protocol particles for established sessions */}
      {connection.protocols
        ?.filter((p) => p.state === 'established')
        .map((protocol, i) => (
          <ProtocolParticles
            key={`${connection.id}-${protocol.protocol}-${i}`}
            startPosition={adjustedSource}
            endPosition={adjustedTarget}
            color={PROTOCOL_COLORS[protocol.protocol]}
            direction={protocol.direction}
            particleCount={3}
            particleSize={4}
          />
        ))}
    </group>
  );
}
