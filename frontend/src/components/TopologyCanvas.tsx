import { useRef, useEffect, useCallback, useState } from 'react';
import type { Topology, Device, Connection, CurveStyle, LineStyle } from '../types/topology';
import type { LinkEnrichment } from '../types/enrichment';
import type { LinkPortStats, TracerouteEnrichmentState } from '../types/tracerouteEnrichment';
import type { LiveStatsMap, DeviceStatsMap } from '../hooks/useTopologyLive';
import { formatRate } from '../utils/formatRate';
import { formatUptime } from '../lib/enrichmentHelpers';
import { computeLinkHealth, findLiveStatsForInterface, formatSpeedPair, statusArrow } from '../utils/linkHealth';
import { getEdgeColorFromPortStats } from '../utils/portStatsEdge';
import { linkStatsKey } from '../lib/tracerouteEnrichment';
import type { Annotation, ShapeAnnotation } from '../types/annotations';
import { drawDevice } from './DeviceIcons';
import { renderAnnotations, hitTestAnnotation, type CanvasTransform } from './AnnotationRenderer';
import AIInlinePopup from './AIInlinePopup';
import type { AiContext, DeviceContext, ConnectionContext } from '../api/ai';
import type { LayerVisibility } from './TopologyToolbar';
import { selectInBox, applyGroupDelta } from '../lib/topologySelection';
import { formatHostname } from '../hooks/useHostnameFormatter';
import { useSettings } from '../hooks/useSettings';
import './TopologyCanvas.css';

interface TopologyCanvasProps {
  /** Topology data to render */
  topology: Topology | null;
  /** Currently selected device ID (controlled) */
  selectedDeviceId?: string | null;
  /** Set of selected device IDs for multi-selection */
  selectedDeviceIds?: Set<string>;
  /** Callback when a device is clicked (with screen position for overlay) */
  onDeviceClick?: (device: Device, screenPosition: { x: number; y: number }, opts?: { additive?: boolean }) => void;
  /** Callback when a device is double-clicked (with screen position for overlay) */
  onDeviceDoubleClick?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Callback when a device is right-clicked (context menu) */
  onDeviceContextMenu?: (device: Device, screenPosition: { x: number; y: number }) => void;
  /** Callback when a connection is clicked (with screen position for overlay) */
  onConnectionClick?: (connection: Connection, screenPosition: { x: number; y: number }) => void;
  /** Callback when a connection is right-clicked (context menu) */
  onConnectionContextMenu?: (connection: Connection, screenPosition: { x: number; y: number }) => void;
  /** Callback when empty canvas (free space) is right-clicked */
  onCanvasContextMenu?: (screenPosition: { x: number; y: number }) => void;
  /** Callback when connection hover state changes (for tooltip display) */
  onConnectionHover?: (connection: Connection | null, screenPosition?: { x: number; y: number }) => void;
  /** Callback when device hover state changes (with 200ms delay for tooltip) */
  onDeviceHover?: (device: Device | null, screenPosition?: { x: number; y: number }) => void;
  /** Callback when device position changes (drag to reposition) */
  onDevicePositionChange?: (deviceId: string, x: number, y: number) => void;
  /** Callback when multiple selected devices move together */
  onGroupPositionChange?: (moves: { deviceId: string; x: number; y: number }[]) => void;
  /** Whether connection drawing mode is active */
  drawingConnection?: boolean;
  /** Source device for connection drawing */
  connectionSource?: Device | null;
  /** Callback when a device is clicked during connection drawing */
  onDeviceClickForConnection?: (device: Device) => boolean;
  /** Link enrichment data for interface labels (connectionId -> LinkEnrichment) */
  linkEnrichment?: Map<string, LinkEnrichment>;
  /** Live SNMP stats from topology-live WebSocket (host:ifDescr -> stats) */
  liveStats?: LiveStatsMap;
  /** Device-level live stats (host -> device stats with health score) */
  deviceStats?: DeviceStatsMap;
  /** Callback when canvas receives mousedown (for closing overlays) */
  onCanvasMouseDown?: () => void;
  /** Callback when empty canvas space is clicked (for placing devices, shapes, etc.) */
  onEmptySpaceClick?: (worldPosition: { x: number; y: number }, screenPosition: { x: number; y: number }) => void;
  /** Callback when empty canvas space is double-clicked (for finishing line drawing, etc.) */
  onEmptySpaceDoubleClick?: (worldPosition: { x: number; y: number }, screenPosition: { x: number; y: number }) => void;
  /** Annotations to render on the canvas */
  annotations?: Annotation[];
  /** Currently selected annotation ID */
  selectedAnnotationId?: string;
  /** Callback when an annotation is clicked/selected */
  onAnnotationSelect?: (annotationId: string | null) => void;
  /** Callback when an annotation position changes (drag to reposition) */
  onAnnotationPositionChange?: (annotationId: string, x: number, y: number) => void;
  /** Callback when an annotation size changes (resize) */
  onAnnotationSizeChange?: (annotationId: string, width: number, height: number, x?: number, y?: number) => void;
  /** Callback when an annotation is double-clicked (for editing) */
  onAnnotationDoubleClick?: (annotation: Annotation, screenPosition: { x: number; y: number }) => void;
  /** Callback when an annotation is right-clicked (context menu) */
  onAnnotationContextMenu?: (annotation: Annotation, screenPosition: { x: number; y: number }) => void;
  /** Additional CSS class */
  className?: string;
  /** Traceroute enrichment state for classification colors and ASN zones */
  tracerouteEnrichment?: TracerouteEnrichmentState;
  /** When true, colorize edges by LibreNMS port utilization (from
   *  tracerouteEnrichment.linkStats). Defaults to false; toggle via the
   *  "Show port stats" button in TopologyToolbar. */
  showPortStats?: boolean;
  /** Layer visibility toggles (Layers dropdown). Each layer defaults to
   *  visible when the prop or a given key is omitted. */
  visibleLayers?: LayerVisibility;
  /** Enable marquee selection (typically when currentTool is 'select') */
  marqueeEnabled?: boolean;
  /** Callback when marquee selection completes */
  onMarqueeSelect?: (ids: Set<string>, additive?: boolean) => void;
}

/** Resize handle positions */
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** AI popup state for topology context menu */
interface AIPopupState {
  isOpen: boolean;
  position: { x: number; y: number };
  action: 'explain' | 'fix' | 'suggest' | 'topology-device' | 'topology-link';
  context: AiContext;
  selectedText: string;
}

/** Grid line color */
const GRID_COLOR = '#2a2a2a';
/** Grid line spacing in pixels */
const GRID_SPACING = 50;
/** Topology coordinate space (0-1000) */
const WORLD_SIZE = 1000;
/** Device icon size in pixels */
const DEVICE_SIZE = 40;
/** Hit detection radius in world coordinates */
const HIT_RADIUS = 25;
/** Connection line hit distance in world coordinates */
const CONNECTION_HIT_DISTANCE = 10;
/** Zoom constraints */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/** Zoom step per scroll tick */
const ZOOM_STEP = 0.1;

/** Connection status colors */
const CONNECTION_COLORS = {
  active: '#4caf50',
  inactive: '#666666',
  degraded: '#ff9800',
};

/** Interface status colors for connection labels */
const INTERFACE_STATUS_COLORS: Record<string, string> = {
  'up': '#4caf50',       // green
  'down': '#f44336',     // red
  'admin-down': '#ff9800', // orange
  'unknown': '#9e9e9e',  // gray (no enrichment data)
};

/**
 * TopologyCanvas - Renders network topology on HTML Canvas
 *
 * Features:
 * - Dark background with grid lines
 * - Coordinate transformation (0-1000 world space to canvas pixels)
 * - Responsive resize handling
 * - Device rendering with icons and labels
 * - Hover and selection states
 * - Click and double-click callbacks
 */
export default function TopologyCanvas({
  topology,
  selectedDeviceId,
  selectedDeviceIds,
  onDeviceClick,
  onDeviceDoubleClick,
  onDeviceContextMenu,
  onCanvasContextMenu,
  onConnectionClick,
  onConnectionContextMenu,
  onConnectionHover,
  onDeviceHover,
  onDevicePositionChange,
  onGroupPositionChange,
  drawingConnection = false,
  connectionSource,
  onDeviceClickForConnection,
  linkEnrichment,
  liveStats,
  deviceStats,
  onCanvasMouseDown,
  onEmptySpaceClick,
  onEmptySpaceDoubleClick,
  annotations = [],
  selectedAnnotationId,
  onAnnotationSelect,
  onAnnotationPositionChange,
  onAnnotationSizeChange,
  onAnnotationDoubleClick,
  onAnnotationContextMenu,
  className = '',
  tracerouteEnrichment,
  showPortStats = false,
  visibleLayers,
  marqueeEnabled = false,
  onMarqueeSelect,
}: TopologyCanvasProps) {
  const { settings } = useSettings();
  // Hostname strip settings key for canvas repaint reactivity
  const hostnameStripKey = (settings['hostname.stripEnabled'] ?? false) + '|' + ((settings['hostname.stripPatterns'] as string[] | undefined) ?? []).join('\n');

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Store 2D context for drawing operations
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Interaction state
  const [hoveredDevice, setHoveredDevice] = useState<Device | null>(null);
  const [internalSelectedDevice, setInternalSelectedDevice] = useState<Device | null>(null);
  const [hoveredConnection, setHoveredConnection] = useState<Connection | null>(null);

  // Connection hover timeout for delayed tooltip display (200ms)
  const connectionHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHoverConnectionRef = useRef<{ connection: Connection; position: { x: number; y: number } } | null>(null);

  // Device hover timeout for delayed tooltip display (200ms)
  const deviceHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHoveredDeviceIdRef = useRef<string | null>(null);

  // AI popup state for topology context menu
  const [aiPopupState, setAiPopupState] = useState<AIPopupState | null>(null);

  // Pan and zoom state
  const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, viewOffsetX: 0, viewOffsetY: 0 });

  // Device dragging state
  const [draggingDevice, setDraggingDevice] = useState<{
    id: string;
    startWorldX: number;
    startWorldY: number;
    startScreenX: number;
    startScreenY: number;
  } | null>(null);

  // Group dragging state (start positions for all selected devices)
  const [draggingGroupStarts, setDraggingGroupStarts] = useState<Map<string, { x: number; y: number }> | null>(null);

  // Local device positions for smooth dragging (overrides topology positions during drag)
  const [localDevicePositions, setLocalDevicePositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  // Annotation dragging state
  const [draggingAnnotation, setDraggingAnnotation] = useState<{
    id: string;
    startWorldX: number;
    startWorldY: number;
    startScreenX: number;
    startScreenY: number;
  } | null>(null);

  // Local annotation positions for smooth dragging
  const [localAnnotationPositions, setLocalAnnotationPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  // Annotation resizing state
  const [resizingAnnotation, setResizingAnnotation] = useState<{
    id: string;
    handle: ResizeHandle;
    startScreenX: number;
    startScreenY: number;
    startWidth: number;
    startHeight: number;
    startX: number;
    startY: number;
  } | null>(null);

  // Local annotation sizes for smooth resizing
  const [localAnnotationSizes, setLocalAnnotationSizes] = useState<Map<string, { width: number; height: number; x: number; y: number }>>(new Map());

  // Cursor position for drawing temporary connection line
  const [cursorWorldPosition, setCursorWorldPosition] = useState<{ x: number; y: number } | null>(null);

  // Marquee selection state (screen coordinates)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Determine selected device - support both controlled and uncontrolled modes
  const selectedDevice = selectedDeviceId !== undefined
    ? topology?.devices.find(d => d.id === selectedDeviceId) || null
    : internalSelectedDevice;

  /**
   * Convert world X coordinate (0-1000) to canvas pixels (without transform)
   * Note: This is used for drawing after ctx transform is applied
   */
  const toCanvasX = useCallback(
    (worldX: number): number => {
      return (worldX / WORLD_SIZE) * canvasSize.width;
    },
    [canvasSize.width]
  );

  /**
   * Convert world Y coordinate (0-1000) to canvas pixels (without transform)
   */
  const toCanvasY = useCallback(
    (worldY: number): number => {
      return (worldY / WORLD_SIZE) * canvasSize.height;
    },
    [canvasSize.height]
  );

  /**
   * Convert screen/mouse X pixels to world coordinate (0-1000)
   * Accounts for pan offset and zoom
   */
  const screenToWorldX = useCallback(
    (screenX: number): number => {
      if (canvasSize.width === 0) return 0;
      // Reverse the transform: first remove offset, then un-zoom, then convert to world
      const canvasX = (screenX - viewOffset.x) / zoom;
      return (canvasX / canvasSize.width) * WORLD_SIZE;
    },
    [canvasSize.width, viewOffset.x, zoom]
  );

  /**
   * Convert screen/mouse Y pixels to world coordinate (0-1000)
   * Accounts for pan offset and zoom
   */
  const screenToWorldY = useCallback(
    (screenY: number): number => {
      if (canvasSize.height === 0) return 0;
      const canvasY = (screenY - viewOffset.y) / zoom;
      return (canvasY / canvasSize.height) * WORLD_SIZE;
    },
    [canvasSize.height, viewOffset.y, zoom]
  );


  /**
   * Get device position (uses local position during drag, otherwise topology position)
   */
  const getDevicePosition = useCallback(
    (device: Device): { x: number; y: number } => {
      const localPos = localDevicePositions.get(device.id);
      if (localPos) {
        return localPos;
      }
      return { x: device.x, y: device.y };
    },
    [localDevicePositions]
  );

  /**
   * Find device at world coordinates within hit radius
   */
  const findDeviceAtPosition = useCallback(
    (worldX: number, worldY: number): Device | null => {
      if (!topology) return null;

      for (const device of topology.devices) {
        const pos = getDevicePosition(device);
        const dx = pos.x - worldX;
        const dy = pos.y - worldY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance <= HIT_RADIUS) {
          return device;
        }
      }

      return null;
    },
    [topology, getDevicePosition]
  );

  /**
   * Find device by ID
   */
  const findDeviceById = useCallback(
    (deviceId: string): Device | undefined => {
      return topology?.devices.find((d) => d.id === deviceId);
    },
    [topology]
  );

  /**
   * Get annotation position (accounting for local position during drag)
   */
  const getAnnotationPosition = useCallback(
    (annotation: Annotation): { x: number; y: number } => {
      const localPos = localAnnotationPositions.get(annotation.id);
      if (localPos) {
        return localPos;
      }
      // Get position based on annotation type
      if ('position' in annotation) {
        return annotation.position;
      }
      // For line annotations, return first point
      if ('points' in annotation && annotation.points.length > 0) {
        return annotation.points[0];
      }
      return { x: 0, y: 0 };
    },
    [localAnnotationPositions]
  );

  /**
   * Find annotation at screen coordinates
   */
  const findAnnotationAtPosition = useCallback(
    (screenX: number, screenY: number): Annotation | null => {
      if (annotations.length === 0 || canvasSize.width === 0) return null;

      // Create transform for hit testing
      // Must match the rendering transform: ctx.translate(viewOffset) then ctx.scale(zoom)
      // then renderAnnotations uses worldToScreen with canvasScale
      // So total screen position = viewOffset + (worldPos * canvasScale * zoom)
      const canvasScale = canvasSize.width / WORLD_SIZE;
      const transform: CanvasTransform = {
        scale: canvasScale * zoom,  // Combined scale: canvasScale applied inside zoomed context
        offsetX: viewOffset.x,
        offsetY: viewOffset.y,
      };

      // Apply local positions to annotations for hit testing
      const annotationsWithLocalPos = annotations.map(a => {
        const localPos = localAnnotationPositions.get(a.id);
        if (localPos && 'position' in a) {
          return { ...a, position: localPos };
        }
        return a;
      });

      return hitTestAnnotation(annotationsWithLocalPos, screenX, screenY, transform);
    },
    [annotations, canvasSize, viewOffset, zoom, localAnnotationPositions]
  );

  /** Size/radius for resize handle hit testing in screen pixels */
  const HANDLE_HIT_RADIUS = 10;

  /**
   * Get resize handles for a shape annotation in screen coordinates
   */
  const getShapeResizeHandles = useCallback(
    (annotation: ShapeAnnotation): { handle: ResizeHandle; x: number; y: number }[] => {
      const canvasScale = canvasSize.width / WORLD_SIZE;
      const scale = canvasScale * zoom;

      // Get position - check local overrides first
      const localPos = localAnnotationPositions.get(annotation.id);
      const localSize = localAnnotationSizes.get(annotation.id);
      const pos = localPos || annotation.position;
      const size = localSize ? { width: localSize.width, height: localSize.height } : annotation.size;

      if (!pos || !size) return [];

      // Convert to screen coordinates
      const x = viewOffset.x + pos.x * scale;
      const y = viewOffset.y + pos.y * scale;
      const w = size.width * scale;
      const h = size.height * scale;

      return [
        { handle: 'nw', x: x, y: y },
        { handle: 'n', x: x + w / 2, y: y },
        { handle: 'ne', x: x + w, y: y },
        { handle: 'e', x: x + w, y: y + h / 2 },
        { handle: 'se', x: x + w, y: y + h },
        { handle: 's', x: x + w / 2, y: y + h },
        { handle: 'sw', x: x, y: y + h },
        { handle: 'w', x: x, y: y + h / 2 },
      ];
    },
    [canvasSize, viewOffset, zoom, localAnnotationPositions, localAnnotationSizes]
  );

  /**
   * Find resize handle at screen coordinates for the selected annotation
   */
  const findResizeHandleAtPosition = useCallback(
    (screenX: number, screenY: number): { annotation: ShapeAnnotation; handle: ResizeHandle } | null => {
      if (!selectedAnnotationId) return null;

      const annotation = annotations.find(a => a.id === selectedAnnotationId);
      if (!annotation || annotation.type !== 'shape') return null;

      const shapeAnnotation = annotation as ShapeAnnotation;
      const handles = getShapeResizeHandles(shapeAnnotation);

      for (const { handle, x, y } of handles) {
        const dx = screenX - x;
        const dy = screenY - y;
        if (Math.sqrt(dx * dx + dy * dy) <= HANDLE_HIT_RADIUS) {
          return { annotation: shapeAnnotation, handle };
        }
      }

      return null;
    },
    [selectedAnnotationId, annotations, getShapeResizeHandles]
  );

  /**
   * Get cursor style for resize handle
   */
  const getResizeCursor = (handle: ResizeHandle): string => {
    switch (handle) {
      case 'nw':
      case 'se':
        return 'nwse-resize';
      case 'ne':
      case 'sw':
        return 'nesw-resize';
      case 'n':
      case 's':
        return 'ns-resize';
      case 'e':
      case 'w':
        return 'ew-resize';
      default:
        return 'default';
    }
  };

  /**
   * Calculate distance from point to line segment
   */
  const distanceToLineSegment = useCallback(
    (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;

      if (lengthSquared === 0) {
        // Line is a point
        return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
      }

      // Project point onto line segment
      let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));

      const closestX = x1 + t * dx;
      const closestY = y1 + t * dy;

      return Math.sqrt((px - closestX) * (px - closestX) + (py - closestY) * (py - closestY));
    },
    []
  );

  /**
   * Find connection at world coordinates
   */
  const findConnectionAtPosition = useCallback(
    (worldX: number, worldY: number): Connection | null => {
      if (!topology) return null;

      for (const connection of topology.connections) {
        const source = findDeviceById(connection.sourceDeviceId);
        const target = findDeviceById(connection.targetDeviceId);

        if (!source || !target) continue;

        const distance = distanceToLineSegment(worldX, worldY, source.x, source.y, target.x, target.y);

        if (distance <= CONNECTION_HIT_DISTANCE) {
          return connection;
        }
      }

      return null;
    },
    [topology, findDeviceById, distanceToLineSegment]
  );

  /**
   * Draw grid lines on canvas
   */
  const drawGrid = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;

      // Calculate grid spacing in world coordinates
      const worldGridSpacing = (GRID_SPACING / Math.min(canvasSize.width, canvasSize.height)) * WORLD_SIZE;

      // Draw vertical lines
      for (let worldX = 0; worldX <= WORLD_SIZE; worldX += worldGridSpacing) {
        const x = toCanvasX(worldX);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasSize.height);
        ctx.stroke();
      }

      // Draw horizontal lines
      for (let worldY = 0; worldY <= WORLD_SIZE; worldY += worldGridSpacing) {
        const y = toCanvasY(worldY);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasSize.width, y);
        ctx.stroke();
      }
    },
    [canvasSize, toCanvasX, toCanvasY]
  );

  /**
   * Draw an interface label at a position along a connection line
   */
  const drawInterfaceLabel = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      text: string,
      statusColor: string
    ) => {
      if (!text) return;

      // Truncate long interface names
      const maxLength = 15;
      const displayText = text.length > maxLength
        ? text.substring(0, maxLength - 1) + '…'
        : text;

      ctx.save();

      // Set font and measure text
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textMetrics = ctx.measureText(displayText);
      const padding = 4;
      const bgWidth = textMetrics.width + padding * 2;
      const bgHeight = 14;

      // Draw background pill (rounded rect)
      ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
      const radius = 3;
      const bgX = x - bgWidth / 2;
      const bgY = y - bgHeight / 2;

      ctx.beginPath();
      ctx.moveTo(bgX + radius, bgY);
      ctx.lineTo(bgX + bgWidth - radius, bgY);
      ctx.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius);
      ctx.lineTo(bgX + bgWidth, bgY + bgHeight - radius);
      ctx.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight);
      ctx.lineTo(bgX + radius, bgY + bgHeight);
      ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius);
      ctx.lineTo(bgX, bgY + radius);
      ctx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
      ctx.closePath();
      ctx.fill();

      // Draw text with status color
      ctx.fillStyle = statusColor;
      ctx.fillText(displayText, x, y);

      ctx.restore();
    },
    []
  );

  /**
   * Apply line dash pattern based on lineStyle
   */
  const applyLineDash = useCallback((ctx: CanvasRenderingContext2D, lineStyle: LineStyle | undefined) => {
    switch (lineStyle) {
      case 'dashed':
        ctx.setLineDash([8, 4]);
        break;
      case 'dotted':
        ctx.setLineDash([2, 4]);
        break;
      case 'solid':
      default:
        ctx.setLineDash([]);
        break;
    }
  }, []);

  /**
   * Draw a path through waypoints using the specified curve style
   * Returns the path points in canvas coordinates for label positioning
   */
  const drawPathThroughWaypoints = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      points: { x: number; y: number }[], // Canvas coordinates
      curveStyle: CurveStyle = 'straight'
    ) => {
      if (points.length < 2) return;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      if (curveStyle === 'straight' || points.length === 2) {
        // Straight lines through all points
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
      } else if (curveStyle === 'curved') {
        // Smooth bezier curves through waypoints
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];

          if (i === 1) {
            // First segment: use quadratic curve
            const midX = (prev.x + curr.x) / 2;
            const midY = (prev.y + curr.y) / 2;
            ctx.quadraticCurveTo(prev.x + (curr.x - prev.x) * 0.25, prev.y + (curr.y - prev.y) * 0.25, midX, midY);
          }
          if (i < points.length - 1) {
            // Middle segments: use cubic curves
            const next = points[i + 1];
            const cp1x = curr.x - (next.x - prev.x) * 0.15;
            const cp1y = curr.y - (next.y - prev.y) * 0.15;
            const cp2x = curr.x + (next.x - prev.x) * 0.15;
            const cp2y = curr.y + (next.y - prev.y) * 0.15;
            const midX = (curr.x + next.x) / 2;
            const midY = (curr.y + next.y) / 2;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, midX, midY);
          } else {
            // Last segment: connect to end
            ctx.lineTo(curr.x, curr.y);
          }
        }
      } else if (curveStyle === 'orthogonal') {
        // Right-angle only paths (horizontal/vertical segments)
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];

          // Decide whether to go horizontal first or vertical first
          // based on which axis has the larger distance
          const dx = Math.abs(curr.x - prev.x);
          const dy = Math.abs(curr.y - prev.y);

          if (dx > dy) {
            // Horizontal first, then vertical
            ctx.lineTo(curr.x, prev.y);
            ctx.lineTo(curr.x, curr.y);
          } else {
            // Vertical first, then horizontal
            ctx.lineTo(prev.x, curr.y);
            ctx.lineTo(curr.x, curr.y);
          }
        }
      }

      ctx.stroke();
    },
    []
  );

  /**
   * Calculate bundle offset for parallel connections
   * Returns perpendicular offset in canvas coordinates
   */
  const calculateBundleOffset = useCallback(
    (x1: number, y1: number, x2: number, y2: number, bundleIndex: number): { dx: number; dy: number } => {
      const BUNDLE_SPACING = 5; // pixels between parallel lines

      // Calculate perpendicular direction
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.sqrt(dx * dx + dy * dy);

      if (length === 0) return { dx: 0, dy: 0 };

      // Perpendicular unit vector (rotate 90 degrees)
      const perpX = -dy / length;
      const perpY = dx / length;

      // Center the bundle around the line (index 0 = on line, 1 = +offset, 2 = -offset, etc.)
      const offset = (bundleIndex - Math.floor(bundleIndex / 2)) * BUNDLE_SPACING * (bundleIndex % 2 === 0 ? 1 : -1);

      return {
        dx: perpX * offset,
        dy: perpY * offset,
      };
    },
    []
  );

  /**
   * Draw a single connection line between two devices
   * Supports waypoints, custom styling, and bundling
   */
  /**
   * Draw an error badge (red circle with "!") at the given position.
   * Visible at all zoom tiers when errors exist.
   */
  const drawErrorBadge = useCallback(
    (ctx: CanvasRenderingContext2D, x: number, y: number) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#f44336';
      ctx.fill();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', x, y);
      ctx.restore();
    },
    []
  );

  /**
   * Draw enhanced interface label pill with status arrow and optional speed suffix.
   * Used at zoom tier 2+ when live data is available.
   */
  const drawEnhancedInterfaceLabel = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      text: string,
      statusColor: string,
      operStatus: number | undefined,
      speedMbps: number | undefined,
      hasErrors: boolean
    ) => {
      if (!text) return;

      ctx.save();

      const arrow = statusArrow(operStatus);
      const speedSuffix = speedMbps && speedMbps > 0
        ? ` ${speedMbps >= 1000 ? `${speedMbps / 1000}G` : `${speedMbps}M`}`
        : '';
      const displayText = `${arrow} ${text}${speedSuffix}`;

      // Truncate if needed
      const maxLength = 22;
      const truncated = displayText.length > maxLength
        ? displayText.substring(0, maxLength - 1) + '\u2026'
        : displayText;

      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textMetrics = ctx.measureText(truncated);
      const padding = 5;
      const bgWidth = textMetrics.width + padding * 2 + (hasErrors ? 10 : 0);
      const bgHeight = 16;

      // Background pill
      ctx.fillStyle = 'rgba(30, 30, 30, 0.9)';
      const radius = 4;
      const bgX = x - bgWidth / 2;
      const bgY = y - bgHeight / 2;
      ctx.beginPath();
      ctx.moveTo(bgX + radius, bgY);
      ctx.lineTo(bgX + bgWidth - radius, bgY);
      ctx.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius);
      ctx.lineTo(bgX + bgWidth, bgY + bgHeight - radius);
      ctx.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight);
      ctx.lineTo(bgX + radius, bgY + bgHeight);
      ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius);
      ctx.lineTo(bgX, bgY + radius);
      ctx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
      ctx.closePath();
      ctx.fill();

      // Text
      ctx.fillStyle = statusColor;
      ctx.fillText(truncated, x + (hasErrors ? -5 : 0), y);

      // Error dot at right edge
      if (hasErrors) {
        ctx.beginPath();
        ctx.arc(bgX + bgWidth - 6, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#f44336';
        ctx.fill();
      }

      ctx.restore();
    },
    []
  );

  /**
   * Draw compact midpoint stats (speed + throughput) for zoom tier 2.
   */
  const drawCompactMidpoint = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      speedText: string,
      throughputText: string,
      color: string
    ) => {
      const text = speedText ? `${speedText}  ${throughputText}` : throughputText;
      if (!text) return;

      ctx.save();
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const metrics = ctx.measureText(text);
      const padding = 4;
      const bgWidth = metrics.width + padding * 2;
      const bgHeight = 14;

      ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
      ctx.fillRect(x - bgWidth / 2, y - bgHeight / 2, bgWidth, bgHeight);

      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
    },
    []
  );

  /**
   * Draw full midpoint stats box for zoom tier 3 (speed, throughput, utilization, errors).
   */
  const drawMidpointStats = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      speedText: string,
      throughputText: string,
      utilization: number,
      sourceErrors: number,
      targetErrors: number,
      color: string
    ) => {
      ctx.save();
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const lines: string[] = [];
      if (speedText) lines.push(speedText);
      if (throughputText) lines.push(throughputText);
      lines.push(`Util: ${Math.round(utilization)}%`);
      const totalErrors = sourceErrors + targetErrors;
      if (totalErrors > 0) lines.push(`Errors: ${totalErrors}`);

      // Measure widest line
      let maxWidth = 0;
      for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxWidth) maxWidth = w;
      }

      const padding = 5;
      const lineHeight = 13;
      const bgWidth = maxWidth + padding * 2;
      const bgHeight = lines.length * lineHeight + padding * 2;
      const bgX = x - bgWidth / 2;
      const bgY = y - bgHeight / 2;

      // Background box with rounded corners
      const radius = 4;
      ctx.fillStyle = 'rgba(30, 30, 30, 0.92)';
      ctx.beginPath();
      ctx.moveTo(bgX + radius, bgY);
      ctx.lineTo(bgX + bgWidth - radius, bgY);
      ctx.quadraticCurveTo(bgX + bgWidth, bgY, bgX + bgWidth, bgY + radius);
      ctx.lineTo(bgX + bgWidth, bgY + bgHeight - radius);
      ctx.quadraticCurveTo(bgX + bgWidth, bgY + bgHeight, bgX + bgWidth - radius, bgY + bgHeight);
      ctx.lineTo(bgX + radius, bgY + bgHeight);
      ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - radius);
      ctx.lineTo(bgX, bgY + radius);
      ctx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
      ctx.closePath();
      ctx.fill();

      // Border
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Draw each line
      for (let i = 0; i < lines.length; i++) {
        const lineY = bgY + padding + lineHeight / 2 + i * lineHeight;
        // Error line in red
        if (lines[i].startsWith('Errors:')) {
          ctx.fillStyle = '#f44336';
        } else {
          ctx.fillStyle = color;
        }
        ctx.fillText(lines[i], x, lineY);
      }

      ctx.restore();
    },
    []
  );

  // Animation timestamp ref for pulse effect
  const animationTimestampRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const needsAnimationRef = useRef(false);

  const drawConnection = useCallback(
    (ctx: CanvasRenderingContext2D, connection: Connection) => {
      const source = findDeviceById(connection.sourceDeviceId);
      const target = findDeviceById(connection.targetDeviceId);

      if (!source || !target) return;

      const sourcePos = getDevicePosition(source);
      const targetPos = getDevicePosition(target);
      let x1 = toCanvasX(sourcePos.x);
      let y1 = toCanvasY(sourcePos.y);
      let x2 = toCanvasX(targetPos.x);
      let y2 = toCanvasY(targetPos.y);

      const isHovered = hoveredConnection?.id === connection.id;

      // Look up live SNMP stats for this connection's interfaces
      const sourceStats = liveStats ? findLiveStatsForInterface(liveStats, source.primaryIp, connection.sourceInterface) : undefined;
      const targetStats = liveStats ? findLiveStatsForInterface(liveStats, target.primaryIp, connection.targetInterface) : undefined;

      // Compute link health from live stats
      const health = computeLinkHealth(sourceStats, targetStats);

      // Look up LibreNMS port stats (showPortStats toggle). Live SNMP wins
      // when present (it's more current than the snapshot LibreNMS stores).
      let portStats: LinkPortStats | undefined;
      if (showPortStats && tracerouteEnrichment?.linkStats) {
        // Try source-side first, then target-side — the link record sits
        // on whichever device the user enriched first.
        const srcKey = source.name && connection.sourceInterface
          ? linkStatsKey(source.name, connection.sourceInterface)
          : undefined;
        const tgtKey = target.name && connection.targetInterface
          ? linkStatsKey(target.name, connection.targetInterface)
          : undefined;
        portStats = (srcKey && tracerouteEnrichment.linkStats.get(srcKey))
          || (tgtKey && tracerouteEnrichment.linkStats.get(tgtKey))
          || undefined;
      }
      const portStatsColor = showPortStats && !health ? getEdgeColorFromPortStats(portStats) : undefined;

      // Use health color if available, then port-stats color, then custom color, then status color
      const color = health?.color
        || portStatsColor
        || connection.color
        || CONNECTION_COLORS[connection.status]
        || CONNECTION_COLORS.inactive;

      // Determine line width (health overrides base)
      const baseLineWidth = health?.width ?? connection.lineWidth ?? 2;
      const lineWidth = isHovered ? baseLineWidth + 1 : connection.status === 'active' ? baseLineWidth : Math.max(1, baseLineWidth - 1);

      // Track if any link needs animation
      if (health?.needsPulse) {
        needsAnimationRef.current = true;
      }

      ctx.save();

      // Apply bundle offset if this connection is part of a bundle
      if (connection.bundleIndex !== undefined && connection.bundleIndex > 0) {
        const offset = calculateBundleOffset(x1, y1, x2, y2, connection.bundleIndex);
        x1 += offset.dx;
        y1 += offset.dy;
        x2 += offset.dx;
        y2 += offset.dy;
      }

      // Build path points array (source + waypoints + target)
      const pathPoints: { x: number; y: number }[] = [{ x: x1, y: y1 }];

      if (connection.waypoints && connection.waypoints.length > 0) {
        for (const wp of connection.waypoints) {
          pathPoints.push({
            x: toCanvasX(wp.x),
            y: toCanvasY(wp.y),
          });
        }
      }

      pathPoints.push({ x: x2, y: y2 });

      // Pulse animation for unhealthy links (globalAlpha oscillation 0.6-1.0)
      if (health?.needsPulse) {
        const pulseAlpha = 0.6 + 0.4 * Math.abs(Math.sin(animationTimestampRef.current * 0.003));
        ctx.globalAlpha = pulseAlpha;
      }

      // Draw hover glow effect
      if (isHovered) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth + 3;
        const savedAlpha = ctx.globalAlpha;
        ctx.globalAlpha = savedAlpha * 0.3;
        ctx.setLineDash([]);
        drawPathThroughWaypoints(ctx, pathPoints, connection.curveStyle);
        ctx.globalAlpha = savedAlpha;
      }

      // Draw main line - force dashed for down interfaces
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      if (health?.isDown) {
        ctx.setLineDash([8, 4]);
      } else {
        applyLineDash(ctx, connection.lineStyle);
      }
      drawPathThroughWaypoints(ctx, pathPoints, connection.curveStyle);

      // Reset alpha and line dash for labels
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // Get enrichment data
      const enrichment = linkEnrichment?.get(connection.id);

      // Get interface names and status (enrichment takes priority, then connection fields)
      const sourceIntfName = enrichment?.sourceInterface?.name ?? connection.sourceInterface;
      const targetIntfName = enrichment?.destInterface?.name ?? connection.targetInterface;
      const sourceStatus = enrichment?.sourceInterface?.status ?? 'unknown';
      const targetStatus = enrichment?.destInterface?.status ?? 'unknown';

      // Calculate positions along the path for labels
      const firstSegEnd = pathPoints.length > 2 ? pathPoints[1] : pathPoints[pathPoints.length - 1];
      const lastSegStart = pathPoints.length > 2 ? pathPoints[pathPoints.length - 2] : pathPoints[0];

      const firstSegLength = Math.sqrt((firstSegEnd.x - x1) ** 2 + (firstSegEnd.y - y1) ** 2);
      const lastSegLength = Math.sqrt((x2 - lastSegStart.x) ** 2 + (y2 - lastSegStart.y) ** 2);

      const sourceRatio = firstSegLength < 100 ? 0.25 : 0.15;
      const targetRatio = lastSegLength < 100 ? 0.75 : 0.85;

      // Determine zoom tier
      // Tier 1 (zoom < 0.3): Line color/width only. Error badge always visible.
      // Tier 2 (0.3 - 0.7): Enhanced endpoint labels + compact midpoint (speed + throughput)
      // Tier 3 (> 0.7): Full midpoint stats box (speed, throughput, utilization, errors)
      const zoomTier = zoom < 0.3 ? 1 : zoom <= 0.7 ? 2 : 3;

      // Calculate midpoint for labels
      const midIndex = Math.floor(pathPoints.length / 2);
      let midX: number, midY: number;
      if (pathPoints.length % 2 === 0) {
        midX = (pathPoints[midIndex - 1].x + pathPoints[midIndex].x) / 2;
        midY = (pathPoints[midIndex - 1].y + pathPoints[midIndex].y) / 2;
      } else {
        midX = pathPoints[midIndex].x;
        midY = pathPoints[midIndex].y;
      }

      // Error badge - visible at ALL zoom tiers when errors exist
      if (health?.hasErrors) {
        drawErrorBadge(ctx, midX + 15, midY - 10);
      }

      if (zoomTier >= 2) {
        // Draw endpoint interface labels
        if (sourceIntfName) {
          const srcLabelX = x1 + (firstSegEnd.x - x1) * sourceRatio;
          const srcLabelY = y1 + (firstSegEnd.y - y1) * sourceRatio;
          const srcColor = INTERFACE_STATUS_COLORS[sourceStatus] || INTERFACE_STATUS_COLORS.unknown;

          if (health) {
            // Enhanced label with status arrow and speed
            drawEnhancedInterfaceLabel(
              ctx, srcLabelX, srcLabelY, sourceIntfName, srcColor,
              sourceStats?.operStatus, sourceStats?.speedMbps,
              (health.sourceErrors > 0)
            );
          } else {
            drawInterfaceLabel(ctx, srcLabelX, srcLabelY, sourceIntfName, srcColor);
          }
        }

        if (targetIntfName) {
          const tgtLabelX = lastSegStart.x + (x2 - lastSegStart.x) * targetRatio;
          const tgtLabelY = lastSegStart.y + (y2 - lastSegStart.y) * targetRatio;
          const tgtColor = INTERFACE_STATUS_COLORS[targetStatus] || INTERFACE_STATUS_COLORS.unknown;

          if (health) {
            drawEnhancedInterfaceLabel(
              ctx, tgtLabelX, tgtLabelY, targetIntfName, tgtColor,
              targetStats?.operStatus, targetStats?.speedMbps,
              (health.targetErrors > 0)
            );
          } else {
            drawInterfaceLabel(ctx, tgtLabelX, tgtLabelY, targetIntfName, tgtColor);
          }
        }

        // Connection label at midpoint
        let labelOffset = 0;
        if (connection.label) {
          ctx.font = isHovered ? '11px sans-serif' : '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          const textMetrics = ctx.measureText(connection.label);
          const padding = 4;
          ctx.fillStyle = '#1e1e1e';
          ctx.fillRect(
            midX - textMetrics.width / 2 - padding,
            midY - 6 - padding / 2,
            textMetrics.width + padding * 2,
            12 + padding
          );

          ctx.fillStyle = color;
          ctx.fillText(connection.label, midX, midY);
          labelOffset = 16;
        }

        // Midpoint stats based on zoom tier
        if (health) {
          const displayStats = (sourceStats && targetStats)
            ? ((sourceStats.inBps + sourceStats.outBps) >= (targetStats.inBps + targetStats.outBps) ? sourceStats : targetStats)
            : (sourceStats || targetStats);

          const speedText = formatSpeedPair(sourceStats?.speedMbps, targetStats?.speedMbps);
          const throughputText = displayStats && (displayStats.inBps > 0 || displayStats.outBps > 0)
            ? `\u2193 ${formatRate(displayStats.inBps)} / \u2191 ${formatRate(displayStats.outBps)}`
            : '';

          if (zoomTier === 2) {
            // Compact: speed + throughput on one line
            if (speedText || throughputText) {
              drawCompactMidpoint(ctx, midX, midY + labelOffset, speedText, throughputText, health.color);
            }
          } else {
            // Tier 3: Full stats box
            drawMidpointStats(
              ctx, midX, midY + labelOffset + 10,
              speedText, throughputText,
              health.maxUtilization,
              health.sourceErrors, health.targetErrors,
              health.color
            );
          }
        } else if (zoomTier === 2 || zoomTier === 3) {
          // No live data but still show basic interface labels (already drawn above)
        }
      } else {
        // Tier 1: No labels, just line color/width + error badge (already drawn above)
      }

      ctx.restore();
    },
    [toCanvasX, toCanvasY, findDeviceById, getDevicePosition, hoveredConnection, linkEnrichment, liveStats, zoom, drawInterfaceLabel, drawEnhancedInterfaceLabel, drawCompactMidpoint, drawMidpointStats, drawErrorBadge, applyLineDash, drawPathThroughWaypoints, calculateBundleOffset]
  );

  /**
   * Draw all connections (before devices so devices appear on top)
   */
  const drawConnections = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!topology) return;

      for (const connection of topology.connections) {
        drawConnection(ctx, connection);
      }
    },
    [topology, drawConnection]
  );

  /**
   * Draw a device with icon and label
   */
  const drawDeviceWithLabel = useCallback(
    (ctx: CanvasRenderingContext2D, device: Device) => {
      const pos = getDevicePosition(device);
      const x = toCanvasX(pos.x);
      const y = toCanvasY(pos.y);
      const isHovered = hoveredDevice?.id === device.id;
      const isSelected = selectedDeviceIds?.has(device.id) ?? (selectedDevice?.id === device.id);
      const isDragging = draggingDevice?.id === device.id;
      const isConnectionSource = drawingConnection && connectionSource?.id === device.id;

      // Draw connection source highlight
      if (isConnectionSource) {
        ctx.save();
        ctx.strokeStyle = '#2196f3';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, DEVICE_SIZE / 2 + 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Draw classification border ring for traceroute hops
      const classification = device.metadata?.classification;
      if (classification) {
        ctx.save();
        const radius = DEVICE_SIZE / 2 + 5;
        ctx.lineWidth = 2.5;
        switch (classification) {
          case 'managed':
            ctx.strokeStyle = '#4caf50'; // green
            ctx.setLineDash([]);
            break;
          case 'external':
            ctx.strokeStyle = '#2196f3'; // blue
            ctx.setLineDash([]);
            break;
          case 'isp-transit':
            ctx.strokeStyle = '#ff9800'; // orange
            ctx.setLineDash([]);
            break;
          case 'timeout':
            ctx.strokeStyle = '#666666'; // gray
            ctx.setLineDash([4, 4]);
            break;
          default:
            ctx.strokeStyle = '#888888'; // gray solid
            ctx.setLineDash([]);
            break;
        }
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Draw device health ring from live SNMP device stats
      const devStats = deviceStats?.get(device.primaryIp || '');
      if (devStats) {
        ctx.save();
        const ringRadius = DEVICE_SIZE / 2 + 8;
        const lineWidth = 3;
        ctx.lineWidth = lineWidth;

        const { up, down, adminDown, total } = devStats.interfaceSummary;
        if (total > 0) {
          // Draw segmented arcs: green for UP, red for DOWN, orange for ADMIN-DOWN
          const startAngle = -Math.PI / 2; // start at top
          const totalAngle = Math.PI * 2;
          let currentAngle = startAngle;

          const segments: Array<{ count: number; color: string }> = [
            { count: up, color: '#4caf50' },       // green for UP
            { count: down, color: '#f44336' },      // red for DOWN
            { count: adminDown, color: '#ff9800' },  // orange for ADMIN-DOWN
          ];

          for (const seg of segments) {
            if (seg.count === 0) continue;
            const arcAngle = (seg.count / total) * totalAngle;
            ctx.strokeStyle = seg.color;
            ctx.beginPath();
            ctx.arc(x, y, ringRadius, currentAngle, currentAngle + arcAngle);
            ctx.stroke();
            currentAngle += arcAngle;
          }
        }

        // Draw health score badge at top-right when zoomed in
        if (zoom > 0.6) {
          const badgeX = x + DEVICE_SIZE / 2 + 4;
          const badgeY = y - DEVICE_SIZE / 2 - 4;
          const badgeRadius = 9;

          ctx.beginPath();
          ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
          ctx.fillStyle = devStats.healthColor;
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(devStats.healthScore), badgeX, badgeY);
        }

        ctx.restore();
      }

      // Draw device icon
      drawDevice(ctx, device, x, y, DEVICE_SIZE, isHovered, isSelected || isConnectionSource);

      // Draw device label below icon
      ctx.save();
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // Reduce label opacity for neighbor devices
      if (device.isNeighbor) {
        ctx.globalAlpha = 0.6;
      }

      // Text shadow for readability
      const formattedName = formatHostname(device.name);
      ctx.fillStyle = '#000000';
      ctx.fillText(formattedName, x + 1, y + DEVICE_SIZE / 2 + 6);

      // White text (slightly transparent when dragging)
      ctx.fillStyle = isDragging ? 'rgba(255, 255, 255, 0.8)' : '#ffffff';
      ctx.fillText(formattedName, x, y + DEVICE_SIZE / 2 + 5);

      // Restore alpha after neighbor label
      if (device.isNeighbor) {
        ctx.globalAlpha = 1.0;
      }

      // Draw compact stats line below device name at zoom > 0.5
      let statsLineOffset = 0; // tracks vertical offset for elements below the label
      if (devStats && zoom > 0.5) {
        const { up, total } = devStats.interfaceSummary;
        const parts: string[] = [];

        // Interface counts
        if (total > 0) {
          parts.push(`${up}/${total} Up`);
        }

        // CPU (if available)
        if (devStats.cpuPercent !== null) {
          parts.push(`CPU ${Math.round(devStats.cpuPercent)}%`);
        }

        // Memory (if available)
        if (devStats.memoryPercent !== null) {
          parts.push(`Mem ${Math.round(devStats.memoryPercent)}%`);
        }

        if (parts.length > 0) {
          const statsText = parts.join(' | ');
          ctx.font = '9px monospace';
          const textWidth = ctx.measureText(statsText).width;
          const statsY = y + DEVICE_SIZE / 2 + 18;

          // Semi-transparent background pill
          ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
          const pillPadX = 4;
          const pillPadY = 2;
          const pillHeight = 12;
          ctx.beginPath();
          const pillRadius = 3;
          const px = x - textWidth / 2 - pillPadX;
          const py = statsY - pillPadY - 1;
          const pw = textWidth + pillPadX * 2;
          const ph = pillHeight;
          // Rounded rect
          ctx.moveTo(px + pillRadius, py);
          ctx.lineTo(px + pw - pillRadius, py);
          ctx.quadraticCurveTo(px + pw, py, px + pw, py + pillRadius);
          ctx.lineTo(px + pw, py + ph - pillRadius);
          ctx.quadraticCurveTo(px + pw, py + ph, px + pw - pillRadius, py + ph);
          ctx.lineTo(px + pillRadius, py + ph);
          ctx.quadraticCurveTo(px, py + ph, px, py + ph - pillRadius);
          ctx.lineTo(px, py + pillRadius);
          ctx.quadraticCurveTo(px, py, px + pillRadius, py);
          ctx.fill();

          // Stats text - color code interface ratio
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const upRatio = total > 0 ? up / total : 0;
          ctx.fillStyle = upRatio >= 0.8 ? '#a5d6a7' : upRatio >= 0.5 ? '#ffcc80' : '#ef9a9a';
          ctx.fillText(statsText, x, statsY);
          statsLineOffset = 16;
        }

        // Uptime badge at zoom > 0.8
        if (zoom > 0.8 && devStats.sysUptimeSeconds !== null) {
          const uptimeText = '↑ ' + formatUptime(devStats.sysUptimeSeconds);
          ctx.font = '8px monospace';
          ctx.fillStyle = 'rgba(200, 200, 200, 0.7)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(uptimeText, x, y + DEVICE_SIZE / 2 + 18 + statsLineOffset);
          statsLineOffset += 12;
        }

        // Error indicator: small red dot if errors exist
        const totalErrors = devStats.interfaceSummary.totalInErrors + devStats.interfaceSummary.totalOutErrors;
        if (totalErrors > 0) {
          ctx.beginPath();
          ctx.arc(x + DEVICE_SIZE / 2 + 2, y - DEVICE_SIZE / 2 + 2, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#f44336';
          ctx.fill();
        }
      }

      // Draw small classification badge below the label
      if (classification && classification !== 'unknown') {
        const badgeLabels: Record<string, string> = {
          managed: 'MANAGED',
          external: 'EXTERNAL',
          'isp-transit': 'TRANSIT',
          timeout: 'TIMEOUT',
        };
        const badgeColors: Record<string, string> = {
          managed: '#4caf50',
          external: '#2196f3',
          'isp-transit': '#ff9800',
          timeout: '#666666',
        };
        const label = badgeLabels[classification] || '';
        const color = badgeColors[classification] || '#888';
        if (label) {
          ctx.font = '8px sans-serif';
          ctx.fillStyle = color;
          ctx.fillText(label, x, y + DEVICE_SIZE / 2 + 18 + statsLineOffset);
        }
      }

      ctx.restore();
    },
    [toCanvasX, toCanvasY, getDevicePosition, hoveredDevice, selectedDevice, selectedDeviceIds, draggingDevice, drawingConnection, connectionSource, deviceStats, zoom, hostnameStripKey]
  );

  /**
   * Draw all devices
   */
  const drawDevices = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!topology) return;

      for (const device of topology.devices) {
        drawDeviceWithLabel(ctx, device);
      }
    },
    [topology, drawDeviceWithLabel]
  );

  /**
   * Main draw function - clears canvas and redraws everything
   */
  const draw = useCallback((timestamp?: number) => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!ctx || !canvas || canvasSize.width === 0 || canvasSize.height === 0) return;

    // Update animation timestamp for pulse effects
    if (timestamp !== undefined) {
      animationTimestampRef.current = timestamp;
    }

    // Reset animation flag - drawConnection will set it if any link needs pulsing
    needsAnimationRef.current = false;

    // Clear entire canvas with dark background
    // Reset transform completely and clear using actual canvas pixel dimensions
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Re-apply DPI scaling
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Apply pan/zoom transformation
    ctx.save();
    ctx.translate(viewOffset.x, viewOffset.y);
    ctx.scale(zoom, zoom);

    // Draw grid
    if (visibleLayers?.grid !== false) drawGrid(ctx);

    // Draw ASN zone backgrounds for traceroute enrichment
    if (tracerouteEnrichment?.asnZones && tracerouteEnrichment.asnZones.length > 0 && topology) {
      for (const zone of tracerouteEnrichment.asnZones) {
        // Find devices in this zone by hop number
        const zoneDevices = topology.devices.filter(d => {
          const hopNum = parseInt(d.metadata?.hopNumber || '0', 10);
          return hopNum >= zone.startHop && hopNum <= zone.endHop;
        });

        if (zoneDevices.length === 0) continue;

        // Compute bounding box around zone devices
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const d of zoneDevices) {
          const pos = getDevicePosition(d);
          const cx = toCanvasX(pos.x);
          const cy = toCanvasY(pos.y);
          minX = Math.min(minX, cx);
          minY = Math.min(minY, cy);
          maxX = Math.max(maxX, cx);
          maxY = Math.max(maxY, cy);
        }

        const padding = 40;
        ctx.save();
        ctx.fillStyle = zone.color;
        ctx.strokeStyle = zone.color.replace('0.08', '0.25');
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const rx = minX - padding;
        const ry = minY - padding;
        const rw = maxX - minX + padding * 2;
        const rh = maxY - minY + padding * 2;
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, 8);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        // Zone label at top
        ctx.font = '10px sans-serif';
        ctx.fillStyle = zone.color.replace('0.08', '0.7');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const label = `AS${zone.asn}${zone.name ? ` - ${zone.name}` : ''}`;
        ctx.fillText(label, rx + 6, ry + 4);
        ctx.restore();
      }
    }

    // Draw connections first (so devices appear on top)
    if (visibleLayers?.connections !== false) drawConnections(ctx);

    // Draw temporary connection line from source to cursor when drawing
    if (drawingConnection && connectionSource && cursorWorldPosition) {
      const sourcePos = getDevicePosition(connectionSource);
      ctx.beginPath();
      ctx.strokeStyle = '#2196f3';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.moveTo(toCanvasX(sourcePos.x), toCanvasY(sourcePos.y));
      ctx.lineTo(toCanvasX(cursorWorldPosition.x), toCanvasY(cursorWorldPosition.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw devices
    if (visibleLayers?.devices !== false) drawDevices(ctx);

    // Draw annotations on top of everything (in world coordinates)
    if (annotations.length > 0) {
      // Create transform for annotation rendering
      // Note: annotations use world coordinates (0-1000), same as devices
      const canvasScale = canvasSize.width / WORLD_SIZE;
      const transform: CanvasTransform = {
        scale: canvasScale,
        offsetX: 0,
        offsetY: 0,
      };
      // Apply local positions to annotations during drag for smooth rendering
      const annotationsWithLocalOverrides = annotations.map(a => {
        const localPos = localAnnotationPositions.get(a.id);
        const localSize = localAnnotationSizes.get(a.id);
        let updated: Annotation = a;

        if (localPos && 'position' in a) {
          updated = { ...updated, position: localPos } as Annotation;
        }
        if (localSize && 'size' in a) {
          updated = { ...updated, size: { width: localSize.width, height: localSize.height } } as Annotation;
          // Also update position if local size includes it
          if (localSize.x !== undefined && localSize.y !== undefined) {
            updated = { ...updated, position: { x: localSize.x, y: localSize.y } } as Annotation;
          }
        }
        return updated;
      });
      renderAnnotations(ctx, annotationsWithLocalOverrides, transform, selectedAnnotationId);
    }

    ctx.restore();

    // Draw marquee selection box (screen space, after restoring transform)
    if (marquee) {
      ctx.save();
      const x1 = Math.min(marquee.x1, marquee.x2);
      const y1 = Math.min(marquee.y1, marquee.y2);
      const w = Math.abs(marquee.x2 - marquee.x1);
      const h = Math.abs(marquee.y2 - marquee.y1);

      // Fill
      ctx.fillStyle = 'rgba(33, 150, 243, 0.1)';
      ctx.fillRect(x1, y1, w, h);

      // Border
      ctx.strokeStyle = 'rgba(33, 150, 243, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x1, y1, w, h);
      ctx.setLineDash([]);

      ctx.restore();
    }
  }, [canvasSize, viewOffset, zoom, drawGrid, drawConnections, drawDevices, drawingConnection, connectionSource, cursorWorldPosition, toCanvasX, toCanvasY, getDevicePosition, annotations, selectedAnnotationId, localAnnotationPositions, localAnnotationSizes, tracerouteEnrichment, topology, visibleLayers, marquee]);

  /**
   * Handle mouse move for hover detection, panning, and device dragging
   */
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      // Handle marquee drag
      if (marquee) {
        setMarquee({ ...marquee, x2: screenX, y2: screenY });
        return;
      }

      // Handle device dragging
      if (draggingDevice) {
        const screenDeltaX = screenX - draggingDevice.startScreenX;
        const screenDeltaY = screenY - draggingDevice.startScreenY;

        // Convert screen delta to world delta (accounting for zoom)
        const worldDeltaX = screenDeltaX / zoom;
        const worldDeltaY = screenDeltaY / zoom;

        // Apply world delta in the correct scale (canvas to world)
        const scaleFactor = WORLD_SIZE / canvasSize.width;
        const dx = worldDeltaX * scaleFactor;
        const dy = worldDeltaY * scaleFactor;

        if (draggingGroupStarts) {
          // Group drag: apply delta to all selected devices
          const updated = applyGroupDelta(draggingGroupStarts, dx, dy);
          setLocalDevicePositions(updated);
        } else {
          // Single device drag
          const newX = Math.max(0, Math.min(WORLD_SIZE, draggingDevice.startWorldX + dx));
          const newY = Math.max(0, Math.min(WORLD_SIZE, draggingDevice.startWorldY + dy));

          setLocalDevicePositions(prev => {
            const next = new Map(prev);
            next.set(draggingDevice.id, { x: newX, y: newY });
            return next;
          });
        }

        canvas.style.cursor = 'grabbing';
        return;
      }

      // Handle annotation dragging
      if (draggingAnnotation) {
        const screenDeltaX = screenX - draggingAnnotation.startScreenX;
        const screenDeltaY = screenY - draggingAnnotation.startScreenY;

        // Convert screen delta to world delta (accounting for zoom)
        const worldDeltaX = screenDeltaX / zoom;
        const worldDeltaY = screenDeltaY / zoom;

        // Apply world delta in the correct scale (canvas to world)
        const scaleFactor = WORLD_SIZE / canvasSize.width;
        const newX = Math.max(0, Math.min(WORLD_SIZE, draggingAnnotation.startWorldX + worldDeltaX * scaleFactor));
        const newY = Math.max(0, Math.min(WORLD_SIZE, draggingAnnotation.startWorldY + worldDeltaY * scaleFactor));

        // Update local position for smooth dragging
        setLocalAnnotationPositions(prev => {
          const next = new Map(prev);
          next.set(draggingAnnotation.id, { x: newX, y: newY });
          return next;
        });

        canvas.style.cursor = 'grabbing';
        return;
      }

      // Handle annotation resizing
      if (resizingAnnotation) {
        const screenDeltaX = screenX - resizingAnnotation.startScreenX;
        const screenDeltaY = screenY - resizingAnnotation.startScreenY;

        // Convert screen delta to world delta
        const scaleFactor = WORLD_SIZE / canvasSize.width;
        const worldDeltaX = (screenDeltaX / zoom) * scaleFactor;
        const worldDeltaY = (screenDeltaY / zoom) * scaleFactor;

        // Calculate new dimensions based on which handle is being dragged
        let newWidth = resizingAnnotation.startWidth;
        let newHeight = resizingAnnotation.startHeight;
        let newX = resizingAnnotation.startX;
        let newY = resizingAnnotation.startY;

        const minSize = 20; // Minimum size in world units

        switch (resizingAnnotation.handle) {
          case 'se':
            newWidth = Math.max(minSize, resizingAnnotation.startWidth + worldDeltaX);
            newHeight = Math.max(minSize, resizingAnnotation.startHeight + worldDeltaY);
            break;
          case 'sw':
            newWidth = Math.max(minSize, resizingAnnotation.startWidth - worldDeltaX);
            newHeight = Math.max(minSize, resizingAnnotation.startHeight + worldDeltaY);
            newX = resizingAnnotation.startX + resizingAnnotation.startWidth - newWidth;
            break;
          case 'ne':
            newWidth = Math.max(minSize, resizingAnnotation.startWidth + worldDeltaX);
            newHeight = Math.max(minSize, resizingAnnotation.startHeight - worldDeltaY);
            newY = resizingAnnotation.startY + resizingAnnotation.startHeight - newHeight;
            break;
          case 'nw':
            newWidth = Math.max(minSize, resizingAnnotation.startWidth - worldDeltaX);
            newHeight = Math.max(minSize, resizingAnnotation.startHeight - worldDeltaY);
            newX = resizingAnnotation.startX + resizingAnnotation.startWidth - newWidth;
            newY = resizingAnnotation.startY + resizingAnnotation.startHeight - newHeight;
            break;
          case 'e':
            newWidth = Math.max(minSize, resizingAnnotation.startWidth + worldDeltaX);
            break;
          case 'w':
            newWidth = Math.max(minSize, resizingAnnotation.startWidth - worldDeltaX);
            newX = resizingAnnotation.startX + resizingAnnotation.startWidth - newWidth;
            break;
          case 's':
            newHeight = Math.max(minSize, resizingAnnotation.startHeight + worldDeltaY);
            break;
          case 'n':
            newHeight = Math.max(minSize, resizingAnnotation.startHeight - worldDeltaY);
            newY = resizingAnnotation.startY + resizingAnnotation.startHeight - newHeight;
            break;
        }

        // Clamp to canvas bounds
        newX = Math.max(0, Math.min(WORLD_SIZE - newWidth, newX));
        newY = Math.max(0, Math.min(WORLD_SIZE - newHeight, newY));

        // Update local size for smooth resizing
        setLocalAnnotationSizes(prev => {
          const next = new Map(prev);
          next.set(resizingAnnotation.id, { width: newWidth, height: newHeight, x: newX, y: newY });
          return next;
        });

        // Also update position if it changed
        if (newX !== resizingAnnotation.startX || newY !== resizingAnnotation.startY) {
          setLocalAnnotationPositions(prev => {
            const next = new Map(prev);
            next.set(resizingAnnotation.id, { x: newX, y: newY });
            return next;
          });
        }

        canvas.style.cursor = getResizeCursor(resizingAnnotation.handle);
        return;
      }

      // Handle panning
      if (isPanning) {
        const deltaX = screenX - panStartRef.current.x;
        const deltaY = screenY - panStartRef.current.y;
        setViewOffset({
          x: panStartRef.current.viewOffsetX + deltaX,
          y: panStartRef.current.viewOffsetY + deltaY,
        });
        return;
      }

      if (!topology) return;

      const worldX = screenToWorldX(screenX);
      const worldY = screenToWorldY(screenY);
      const screenPosition = { x: event.clientX, y: event.clientY };

      // Check for device first (devices take priority over connections)
      const device = findDeviceAtPosition(worldX, worldY);

      if (device?.id !== hoveredDevice?.id) {
        setHoveredDevice(device);
      }

      // Handle device hover callback with 200ms delay for tooltip
      if (device?.id !== lastHoveredDeviceIdRef.current) {
        // Clear any existing hover timeout
        if (deviceHoverTimeoutRef.current) {
          clearTimeout(deviceHoverTimeoutRef.current);
          deviceHoverTimeoutRef.current = null;
        }

        lastHoveredDeviceIdRef.current = device?.id || null;

        if (device) {
          // Start new timeout to show tooltip after 200ms
          deviceHoverTimeoutRef.current = setTimeout(() => {
            if (onDeviceHover) {
              onDeviceHover(device, screenPosition);
            }
            deviceHoverTimeoutRef.current = null;
          }, 200);
        } else {
          // Immediately notify that hover ended
          if (onDeviceHover) {
            onDeviceHover(null);
          }
        }
      }

      // Check for connection if not hovering a device
      const connection = device ? null : findConnectionAtPosition(worldX, worldY);

      if (connection?.id !== hoveredConnection?.id) {
        setHoveredConnection(connection);

        // Handle connection hover callback with 200ms delay for tooltip
        if (connectionHoverTimeoutRef.current) {
          clearTimeout(connectionHoverTimeoutRef.current);
          connectionHoverTimeoutRef.current = null;
        }

        if (connection) {
          // Store pending hover data and start timeout
          const screenPos = { x: event.clientX, y: event.clientY };
          pendingHoverConnectionRef.current = { connection, position: screenPos };
          connectionHoverTimeoutRef.current = setTimeout(() => {
            if (pendingHoverConnectionRef.current && onConnectionHover) {
              onConnectionHover(
                pendingHoverConnectionRef.current.connection,
                pendingHoverConnectionRef.current.position
              );
            }
            connectionHoverTimeoutRef.current = null;
          }, 200);
        } else {
          // Clear hover immediately when moving away
          pendingHoverConnectionRef.current = null;
          if (onConnectionHover) {
            onConnectionHover(null);
          }
        }
      }

      // Update cursor position for connection drawing
      if (drawingConnection && connectionSource) {
        setCursorWorldPosition({ x: worldX, y: worldY });
      }

      // Update cursor style - show crosshair in drawing mode, grab for devices
      if (drawingConnection) {
        canvas.style.cursor = device ? 'crosshair' : 'crosshair';
      } else if (device) {
        canvas.style.cursor = 'grab';
      } else if (connection) {
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'default';
      }
    },
    [topology, screenToWorldX, screenToWorldY, findDeviceAtPosition, findConnectionAtPosition, hoveredDevice, hoveredConnection, isPanning, draggingDevice, draggingGroupStarts, draggingAnnotation, resizingAnnotation, zoom, canvasSize.width, drawingConnection, connectionSource, onConnectionHover, onDeviceHover, marquee]
  );

  /**
   * Handle mouse leave
   */
  const handleMouseLeave = useCallback(() => {
    setHoveredDevice(null);
    setHoveredConnection(null);
    setIsPanning(false);
    setCursorWorldPosition(null);

    // Clear device hover timeout and callback
    if (deviceHoverTimeoutRef.current) {
      clearTimeout(deviceHoverTimeoutRef.current);
      deviceHoverTimeoutRef.current = null;
    }
    lastHoveredDeviceIdRef.current = null;
    if (onDeviceHover) {
      onDeviceHover(null);
    }

    // Clear connection hover timeout and callback
    if (connectionHoverTimeoutRef.current) {
      clearTimeout(connectionHoverTimeoutRef.current);
      connectionHoverTimeoutRef.current = null;
    }
    pendingHoverConnectionRef.current = null;
    if (onConnectionHover) {
      onConnectionHover(null);
    }
    // If dragging, save position on leave (same as mouse up)
    if (draggingDevice) {
      const finalPos = localDevicePositions.get(draggingDevice.id);
      if (draggingGroupStarts && onGroupPositionChange) {
        // Group drag
        const moves: { deviceId: string; x: number; y: number }[] = [];
        for (const [id, pos] of localDevicePositions) {
          moves.push({ deviceId: id, x: pos.x, y: pos.y });
        }
        onGroupPositionChange(moves);
      } else if (finalPos && onDevicePositionChange) {
        // Single device drag
        onDevicePositionChange(draggingDevice.id, finalPos.x, finalPos.y);
      }
      setDraggingDevice(null);
      setDraggingGroupStarts(null);
      setLocalDevicePositions(new Map());
    }
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = 'default';
    }
  }, [draggingDevice, draggingGroupStarts, localDevicePositions, onDevicePositionChange, onGroupPositionChange, onConnectionHover, onDeviceHover]);

  /**
   * Handle mouse down for device selection, dragging, and pan start
   */
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Notify parent to close any overlays (detail cards, etc.)
      onCanvasMouseDown?.();

      // Only the left button drives canvas interaction here. Right/middle
      // clicks are handled entirely by onContextMenu — without this guard a
      // right-click near a link falls through to the connection-click branch
      // below and pops the link-detail card *in addition to* the device
      // context menu.
      if (event.button !== 0) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      const worldX = screenToWorldX(screenX);
      const worldY = screenToWorldY(screenY);

      // Check if clicking on a device
      const device = findDeviceAtPosition(worldX, worldY);

      // Only handle left-click (button 0) for device interaction
      // Right-click (button 2) is handled by onContextMenu
      if (device && event.button === 0) {
        // Check if we're drawing a connection first
        if (drawingConnection && onDeviceClickForConnection) {
          const handled = onDeviceClickForConnection(device);
          if (handled) return;
        }

        // Determine if this is a group drag
        const isInSelection = selectedDeviceIds && selectedDeviceIds.has(device.id);
        const isGroupDrag = isInSelection && selectedDeviceIds.size > 1;

        // Start dragging the device (left click starts drag)
        const devicePos = getDevicePosition(device);
        setDraggingDevice({
          id: device.id,
          startWorldX: devicePos.x,
          startWorldY: devicePos.y,
          startScreenX: screenX,
          startScreenY: screenY,
        });

        if (isGroupDrag && topology) {
          // Capture start positions for ALL selected devices
          const groupStarts = new Map<string, { x: number; y: number }>();
          for (const id of selectedDeviceIds) {
            const d = topology.devices.find(dev => dev.id === id);
            if (d) {
              const pos = getDevicePosition(d);
              groupStarts.set(id, { x: pos.x, y: pos.y });
            }
          }
          setDraggingGroupStarts(groupStarts);
          // Initialize local positions for all
          setLocalDevicePositions(groupStarts);
        } else {
          // Single device drag
          setDraggingGroupStarts(null);
          setLocalDevicePositions(prev => {
            const next = new Map(prev);
            next.set(device.id, { x: devicePos.x, y: devicePos.y });
            return next;
          });
        }

        canvas.style.cursor = 'grabbing';

        // Select the device
        if (selectedDeviceId === undefined) {
          setInternalSelectedDevice(device);
        }
        // Don't call onDeviceClick here - we'll call it on mouseUp if it was a click (not a drag)
        return;
      }

      // Check if clicking on a resize handle of the selected annotation
      const resizeHandle = findResizeHandleAtPosition(screenX, screenY);
      if (resizeHandle) {
        const { annotation: shapeAnnotation, handle } = resizeHandle;
        setResizingAnnotation({
          id: shapeAnnotation.id,
          handle,
          startScreenX: screenX,
          startScreenY: screenY,
          startWidth: shapeAnnotation.size.width,
          startHeight: shapeAnnotation.size.height,
          startX: shapeAnnotation.position.x,
          startY: shapeAnnotation.position.y,
        });
        // Initialize local size
        setLocalAnnotationSizes(prev => {
          const next = new Map(prev);
          next.set(shapeAnnotation.id, {
            width: shapeAnnotation.size.width,
            height: shapeAnnotation.size.height,
            x: shapeAnnotation.position.x,
            y: shapeAnnotation.position.y,
          });
          return next;
        });
        canvas.style.cursor = getResizeCursor(handle);
        return;
      }

      // Check if clicking on an annotation
      const annotation = findAnnotationAtPosition(screenX, screenY);

      if (annotation) {
        // Start dragging the annotation
        const annotationPos = getAnnotationPosition(annotation);
        setDraggingAnnotation({
          id: annotation.id,
          startWorldX: annotationPos.x,
          startWorldY: annotationPos.y,
          startScreenX: screenX,
          startScreenY: screenY,
        });
        // Initialize local position
        setLocalAnnotationPositions(prev => {
          const next = new Map(prev);
          next.set(annotation.id, { x: annotationPos.x, y: annotationPos.y });
          return next;
        });
        canvas.style.cursor = 'grabbing';

        // Select the annotation
        onAnnotationSelect?.(annotation.id);
        return;
      }

      // Check if clicking on a connection
      const connection = findConnectionAtPosition(worldX, worldY);

      if (connection) {
        // Clicking on connection - trigger callback
        if (onConnectionClick) {
          onConnectionClick(connection, { x: event.clientX, y: event.clientY });
        }
        // Deselect annotation
        onAnnotationSelect?.(null);
      } else {
        // Clicking on empty space
        if (marqueeEnabled && !drawingConnection) {
          // Start marquee selection
          setMarquee({ x1: screenX, y1: screenY, x2: screenX, y2: screenY });
          canvas.style.cursor = 'crosshair';
        } else if (onEmptySpaceClick) {
          // Call the empty space click handler (for placing devices, shapes, etc.)
          onEmptySpaceClick(
            { x: worldX, y: worldY },
            { x: event.clientX, y: event.clientY }
          );
        } else {
          // Default: start panning
          setIsPanning(true);
          panStartRef.current = {
            x: screenX,
            y: screenY,
            viewOffsetX: viewOffset.x,
            viewOffsetY: viewOffset.y,
          };
          canvas.style.cursor = 'grabbing';
        }
        // Deselect when clicking empty space
        if (selectedDeviceId === undefined) {
          setInternalSelectedDevice(null);
        }
        // Deselect annotation
        onAnnotationSelect?.(null);
      }
    },
    [screenToWorldX, screenToWorldY, findDeviceAtPosition, findResizeHandleAtPosition, findAnnotationAtPosition, findConnectionAtPosition, getDevicePosition, getAnnotationPosition, onConnectionClick, viewOffset, selectedDeviceId, selectedDeviceIds, topology, drawingConnection, onDeviceClickForConnection, onCanvasMouseDown, onEmptySpaceClick, onAnnotationSelect, marqueeEnabled]
  );

  /**
   * Handle mouse up to stop panning or device dragging
   */
  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;

      // Handle marquee selection end
      if (marquee) {
        // Check if the marquee moved (more than a few pixels)
        const dx = Math.abs(marquee.x2 - marquee.x1);
        const dy = Math.abs(marquee.y2 - marquee.y1);
        const THRESHOLD = 3;

        if (dx > THRESHOLD || dy > THRESHOLD) {
          // Convert marquee corners to world coordinates
          const worldX1 = screenToWorldX(marquee.x1);
          const worldY1 = screenToWorldY(marquee.y1);
          const worldX2 = screenToWorldX(marquee.x2);
          const worldY2 = screenToWorldY(marquee.y2);

          // Build box in world space
          const box = { x1: worldX1, y1: worldY1, x2: worldX2, y2: worldY2 };

          // Determine if additive (modifier held)
          const additive = event.ctrlKey || event.metaKey || event.shiftKey;

          // Select devices in box (pure matches, editor handles union)
          if (topology && onMarqueeSelect) {
            const matches = selectInBox(topology.devices, box, new Set(), false);
            onMarqueeSelect(matches, additive);
          }
        } else {
          // Tiny marquee = empty-space click → clear selection if not additive
          if (onMarqueeSelect && !(event.ctrlKey || event.metaKey || event.shiftKey)) {
            onMarqueeSelect(new Set());
          }
        }

        setMarquee(null);
        if (canvas) {
          canvas.style.cursor = 'default';
        }
        return;
      }

      // Handle device drag end
      if (draggingDevice) {
        const finalPos = localDevicePositions.get(draggingDevice.id);
        const hasMoved = finalPos && (
          Math.abs(finalPos.x - draggingDevice.startWorldX) > 1 ||
          Math.abs(finalPos.y - draggingDevice.startWorldY) > 1
        );

        if (hasMoved) {
          if (draggingGroupStarts && onGroupPositionChange) {
            // Group drag: build moves array from final positions
            const moves: { deviceId: string; x: number; y: number }[] = [];
            for (const [id, pos] of localDevicePositions) {
              moves.push({ deviceId: id, x: pos.x, y: pos.y });
            }
            onGroupPositionChange(moves);
          } else if (finalPos && onDevicePositionChange) {
            // Single device drag
            onDevicePositionChange(draggingDevice.id, finalPos.x, finalPos.y);
          }
        } else if (!hasMoved) {
          // It was a click, not a drag - trigger click callback
          const device = topology?.devices.find(d => d.id === draggingDevice.id);
          if (device && onDeviceClick) {
            const additive = event.ctrlKey || event.metaKey || event.shiftKey;
            onDeviceClick(device, { x: event.clientX, y: event.clientY }, { additive });
          }
        }

        setDraggingDevice(null);
        setDraggingGroupStarts(null);
        setLocalDevicePositions(new Map());

        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const screenX = event.clientX - rect.left;
          const screenY = event.clientY - rect.top;
          const worldX = screenToWorldX(screenX);
          const worldY = screenToWorldY(screenY);
          const device = findDeviceAtPosition(worldX, worldY);
          canvas.style.cursor = device ? 'grab' : 'default';
        }
        return;
      }

      // Handle annotation drag end
      if (draggingAnnotation) {
        const finalPos = localAnnotationPositions.get(draggingAnnotation.id);
        const hasMoved = finalPos && (
          Math.abs(finalPos.x - draggingAnnotation.startWorldX) > 1 ||
          Math.abs(finalPos.y - draggingAnnotation.startWorldY) > 1
        );

        if (hasMoved && finalPos && onAnnotationPositionChange) {
          // Save position to backend
          onAnnotationPositionChange(draggingAnnotation.id, finalPos.x, finalPos.y);
        }

        setDraggingAnnotation(null);
        setLocalAnnotationPositions(new Map());

        if (canvas) {
          canvas.style.cursor = 'default';
        }
        return;
      }

      // Handle annotation resize end
      if (resizingAnnotation) {
        const finalSize = localAnnotationSizes.get(resizingAnnotation.id);
        const hasResized = finalSize && (
          Math.abs(finalSize.width - resizingAnnotation.startWidth) > 1 ||
          Math.abs(finalSize.height - resizingAnnotation.startHeight) > 1 ||
          Math.abs(finalSize.x - resizingAnnotation.startX) > 1 ||
          Math.abs(finalSize.y - resizingAnnotation.startY) > 1
        );

        if (hasResized && finalSize && onAnnotationSizeChange) {
          // Save size to backend (pass position too if it changed)
          onAnnotationSizeChange(
            resizingAnnotation.id,
            finalSize.width,
            finalSize.height,
            finalSize.x !== resizingAnnotation.startX ? finalSize.x : undefined,
            finalSize.y !== resizingAnnotation.startY ? finalSize.y : undefined
          );
        }

        setResizingAnnotation(null);
        setLocalAnnotationSizes(new Map());
        setLocalAnnotationPositions(new Map());

        if (canvas) {
          canvas.style.cursor = 'default';
        }
        return;
      }

      // Handle pan end
      if (isPanning) {
        setIsPanning(false);
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const screenX = event.clientX - rect.left;
          const screenY = event.clientY - rect.top;
          const worldX = screenToWorldX(screenX);
          const worldY = screenToWorldY(screenY);
          const device = findDeviceAtPosition(worldX, worldY);
          canvas.style.cursor = device ? 'grab' : 'default';
        }
      }
    },
    [isPanning, draggingDevice, draggingGroupStarts, localDevicePositions, draggingAnnotation, localAnnotationPositions, resizingAnnotation, localAnnotationSizes, topology, screenToWorldX, screenToWorldY, findDeviceAtPosition, onDevicePositionChange, onGroupPositionChange, onDeviceClick, onAnnotationPositionChange, onAnnotationSizeChange, marquee, selectedDeviceIds, onMarqueeSelect]
  );

  /**
   * Handle double-click for device action, annotation editing, or empty space (finishing line drawing)
   */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !topology) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      const worldX = screenToWorldX(screenX);
      const worldY = screenToWorldY(screenY);

      // Check devices first
      const device = findDeviceAtPosition(worldX, worldY);

      if (device && onDeviceDoubleClick) {
        // Pass screen position for overlay positioning
        onDeviceDoubleClick(device, { x: event.clientX, y: event.clientY });
        return;
      }

      // Check annotations second
      const annotation = findAnnotationAtPosition(screenX, screenY);

      if (annotation && onAnnotationDoubleClick) {
        onAnnotationDoubleClick(annotation, { x: event.clientX, y: event.clientY });
        return;
      }

      // Empty space - useful for finishing line drawing
      if (onEmptySpaceDoubleClick) {
        onEmptySpaceDoubleClick(
          { x: worldX, y: worldY },
          { x: event.clientX, y: event.clientY }
        );
      }
    },
    [topology, screenToWorldX, screenToWorldY, findDeviceAtPosition, findAnnotationAtPosition, onDeviceDoubleClick, onAnnotationDoubleClick, onEmptySpaceDoubleClick]
  );

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
   * Handle right-click for device/connection context menu with AI popup
   */
  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !topology) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      const worldX = screenToWorldX(screenX);
      const worldY = screenToWorldY(screenY);

      // Check for device first (devices take priority)
      const device = findDeviceAtPosition(worldX, worldY);

      if (device) {
        event.preventDefault();
        // Call external handler if provided (shows context menu with Edit/Delete/AI options)
        if (onDeviceContextMenu) {
          onDeviceContextMenu(device, { x: event.clientX, y: event.clientY });
        }
        return;
      }

      // Check for annotation
      const annotation = findAnnotationAtPosition(screenX, screenY);
      if (annotation) {
        event.preventDefault();
        if (onAnnotationContextMenu) {
          onAnnotationContextMenu(annotation, { x: event.clientX, y: event.clientY });
        }
        return;
      }

      // Check for connection
      const connection = findConnectionAtPosition(worldX, worldY);

      if (connection) {
        event.preventDefault();
        // Defer to the external handler (the editor shows a context menu with
        // "Ask AI" + Delete). No inline AI popup here to avoid a double popup.
        if (onConnectionContextMenu) {
          onConnectionContextMenu(connection, { x: event.clientX, y: event.clientY });
        }
        return;
      }

      // Empty canvas (free space): offer a whole-topology context menu.
      if (onCanvasContextMenu) {
        event.preventDefault();
        onCanvasContextMenu({ x: event.clientX, y: event.clientY });
      }
    },
    [topology, screenToWorldX, screenToWorldY, findDeviceAtPosition, findAnnotationAtPosition, findConnectionAtPosition, onDeviceContextMenu, onAnnotationContextMenu, onConnectionContextMenu, onCanvasContextMenu, buildDeviceContext, buildConnectionContext]
  );

  /**
   * Close AI popup
   */
  const handleAiPopupClose = useCallback(() => {
    setAiPopupState(null);
  }, []);

  /**
   * Handle wheel for zoom centered on mouse position
   */
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Calculate zoom change
      const zoomDelta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + zoomDelta));

      if (newZoom === zoom) return;

      // Zoom centered on mouse position
      // The mouse position in world coords should remain the same after zoom
      const zoomRatio = newZoom / zoom;
      const newOffsetX = mouseX - (mouseX - viewOffset.x) * zoomRatio;
      const newOffsetY = mouseY - (mouseY - viewOffset.y) * zoomRatio;

      setZoom(newZoom);
      setViewOffset({ x: newOffsetX, y: newOffsetY });
    },
    [zoom, viewOffset]
  );

  /**
   * Reset view to default (no pan, 100% zoom)
   */
  const resetView = useCallback(() => {
    setViewOffset({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  /**
   * Zoom in by one step
   */
  const zoomIn = useCallback(() => {
    const newZoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
    // Zoom centered on canvas center
    if (newZoom !== zoom) {
      const centerX = canvasSize.width / 2;
      const centerY = canvasSize.height / 2;
      const zoomRatio = newZoom / zoom;
      setZoom(newZoom);
      setViewOffset({
        x: centerX - (centerX - viewOffset.x) * zoomRatio,
        y: centerY - (centerY - viewOffset.y) * zoomRatio,
      });
    }
  }, [zoom, viewOffset, canvasSize]);

  /**
   * Zoom out by one step
   */
  const zoomOut = useCallback(() => {
    const newZoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
    if (newZoom !== zoom) {
      const centerX = canvasSize.width / 2;
      const centerY = canvasSize.height / 2;
      const zoomRatio = newZoom / zoom;
      setZoom(newZoom);
      setViewOffset({
        x: centerX - (centerX - viewOffset.x) * zoomRatio,
        y: centerY - (centerY - viewOffset.y) * zoomRatio,
      });
    }
  }, [zoom, viewOffset, canvasSize]);

  /**
   * Handle canvas resize
   */
  const handleResize = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    // Get container dimensions
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    // Update canvas size (handles DPI scaling)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Get and scale context
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctxRef.current = ctx;
    }

    // Update size state (in CSS pixels)
    setCanvasSize({ width, height });
  }, []);

  // Clean up connection hover timeout on unmount
  useEffect(() => {
    return () => {
      if (connectionHoverTimeoutRef.current) {
        clearTimeout(connectionHoverTimeoutRef.current);
      }
    };
  }, []);

  // Set up resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial size
    handleResize();

    // Watch for resize
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    resizeObserver.observe(container);

    // Also handle window resize
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [handleResize]);

  // Redraw when size, topology, view, interaction state, or annotations change
  // Starts RAF loop when pulse animation is needed, otherwise draws once.
  useEffect(() => {
    draw();

    // If any link needs pulsing, start an animation loop
    if (needsAnimationRef.current) {
      const animate = (timestamp: number) => {
        draw(timestamp);
        // Continue loop only while links still need animation
        if (needsAnimationRef.current) {
          animFrameRef.current = requestAnimationFrame(animate);
        }
      };
      animFrameRef.current = requestAnimationFrame(animate);

      return () => {
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
        }
      };
    }
  }, [draw, topology, hoveredDevice, selectedDevice, selectedDeviceIds, hoveredConnection, viewOffset, zoom, localDevicePositions, draggingDevice, cursorWorldPosition, drawingConnection, connectionSource, annotations, selectedAnnotationId, localAnnotationPositions, draggingAnnotation, marquee]);

  // Render empty state if no topology
  if (!topology) {
    return (
      <div ref={containerRef} className={`topology-canvas-container ${className}`}>
        <canvas ref={canvasRef} className="topology-canvas" />
        <div className="topology-canvas-empty">
          <div className="topology-canvas-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5">
              <circle cx="12" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="18" r="3" />
              <path d="M12 9v3M9.5 16.5L12 12M14.5 16.5L12 12" />
            </svg>
          </div>
          <h3>No Topology Loaded</h3>
          <p>Import from NetBox or load mock data to visualize your network topology.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`topology-canvas-container ${className}`}>
      <canvas
        ref={canvasRef}
        className="topology-canvas"
        style={{ cursor: isPanning ? 'grabbing' : onEmptySpaceClick ? 'crosshair' : 'default' }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
      />

      {/* Zoom controls overlay */}
      <div className="topology-zoom-controls">
        <button
          className="topology-zoom-btn"
          onClick={zoomIn}
          title="Zoom in"
          disabled={zoom >= MAX_ZOOM}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <span className="topology-zoom-level" title="Current zoom level">
          {Math.round(zoom * 100)}%
        </span>
        <button
          className="topology-zoom-btn"
          onClick={zoomOut}
          title="Zoom out"
          disabled={zoom <= MIN_ZOOM}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          className="topology-zoom-btn"
          onClick={resetView}
          title="Reset view"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
          </svg>
        </button>
      </div>

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
