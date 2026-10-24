import { getErrorMessage } from '../api/errors'
/**
 * topologyAITools.ts - AI tools for topology query, modification, and analysis
 *
 * Provides comprehensive AI tool definitions for the topology editor.
 * All modification tools are tracked in the undo/redo history with source='ai'.
 *
 * Phase 27-07: AI Topology Tools
 */

import type { Topology, Device, Connection, DeviceType, DeviceStatus, ConnectionStatus } from '../types/topology';
import type { DeviceLiveStats } from '../hooks/useTopologyLive';
import type { LinkEnrichment } from '../types/enrichment';
import type { ShapeType, TextAnnotation, ShapeAnnotation, LineAnnotation, BaseAnnotation } from '../types/annotations';
import {
  TOPOLOGY_DEVICE_TYPES,
  CONNECTION_UPDATE_FIELDS,
  CONNECTION_LOCAL_ONLY_FIELDS,
  DEVICE_UPDATE_FIELDS,
  TopologyUpdateError,
  toConnectionUpdateRequest,
  toDeviceUpdateRequest,
} from '../api/topology';

/** What the AI asked `topology_annotate` to draw (0-1000 world coordinates). */
export interface AIAnnotationSpec {
  type: 'text' | 'shape' | 'line';
  /** Text content (text) or label (shape) */
  content?: string;
  x: number;
  y: number;
  /** Shape size */
  width?: number;
  height?: number;
  shapeType?: ShapeType;
  /** Line end point */
  x2?: number;
  y2?: number;
  color?: string;
  fontSize?: number;
}

/** Type-specific annotation payload (what `createAnnotation` takes). */
export type AIAnnotationData =
  | ({ type: 'text' } & Omit<TextAnnotation, keyof BaseAnnotation>)
  | ({ type: 'shape' } & Omit<ShapeAnnotation, keyof BaseAnnotation>)
  | ({ type: 'line' } & Omit<LineAnnotation, keyof BaseAnnotation>);

/** Result of an annotation the editor actually added. */
export interface AIAnnotationResult {
  id: string;
  type: 'text' | 'shape' | 'line';
  /** False for an unsaved (temporary) topology: kept in the editor until saved */
  persisted: boolean;
}

/** Result of a device/connection update. */
export interface TopologyItemUpdate<T> {
  item: T;
  /** Fields written to the backend */
  persisted: string[];
  /** Fields changed in the open editor only (the backend doesn't store them,
   *  or the topology is unsaved) */
  notPersisted: string[];
}

/** Highlight request with targets already resolved to device/connection IDs. */
export interface TopologyHighlightRequest {
  targets: string[];
  color: string;
  label?: string;
}

/**
 * Build the annotation payload for an AI annotation spec. Pure, so the
 * editor (which owns state, history and persistence) and tests share it.
 */
export function buildAIAnnotationData(spec: AIAnnotationSpec): AIAnnotationData {
  const color = spec.color || (spec.type === 'shape' ? '#4a9eff' : '#ffffff');
  switch (spec.type) {
    case 'text':
      return {
        type: 'text',
        position: { x: spec.x, y: spec.y },
        content: spec.content || 'Note',
        fontSize: spec.fontSize ?? 14,
        fontWeight: 'normal',
        color,
      };
    case 'shape': {
      const width = spec.width ?? 100;
      const height = spec.height ?? 60;
      return {
        type: 'shape',
        shapeType: spec.shapeType ?? 'rectangle',
        position: { x: spec.x, y: spec.y },
        size: { width, height },
        strokeColor: color,
        strokeStyle: 'solid',
        strokeWidth: 2,
        fillColor: color,
        fillOpacity: 0.1,
        label: spec.content,
      };
    }
    case 'line':
      return {
        type: 'line',
        points: [{ x: spec.x, y: spec.y }, { x: spec.x2 ?? spec.x + 100, y: spec.y2 ?? spec.y }],
        curveStyle: 'straight',
        color,
        lineStyle: 'solid',
        lineWidth: 2,
      };
  }
}

/**
 * Tool definition for AI model (compatible with Claude tool-use schema)
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
      properties?: Record<string, { type: string }>;
    }>;
    required: string[];
  };
}

/**
 * Callbacks for topology operations
 * All modification callbacks should track actions with source='ai'
 */
export interface TopologyAICallbacks {
  // Queries (read-only)
  getTopology: () => Topology | null;
  getDeviceById: (deviceId: string) => Device | undefined;
  getConnectionById: (connectionId: string) => Connection | undefined;

  // Live telemetry (read-only, from SNMP live polling; undefined when live
  // stats aren't available for a device/link)
  getDeviceStats?: (deviceId: string) => DeviceLiveStats | undefined;
  getLinkStats?: (connectionId: string) => LinkEnrichment | undefined;

  // Modifications (tracked in undo history with source='ai')
  addDevice: (device: Partial<Device>) => Promise<Device>;
  removeDevice: (deviceId: string) => Promise<void>;
  updateDevice: (deviceId: string, updates: Partial<Device>) => Promise<TopologyItemUpdate<Device>>;
  moveDevice: (deviceId: string, x: number, y: number) => Promise<void>;

  addConnection: (conn: Partial<Connection>) => Promise<Connection>;
  removeConnection: (connectionId: string) => Promise<void>;
  updateConnection: (connectionId: string, updates: Partial<Connection>) => Promise<TopologyItemUpdate<Connection>>;

  // The editor-backed operations below are optional: they exist only while a
  // topology editor is open and has published them. A tool whose callback is
  // missing is not offered to the model (see getTopologyTools).

  /** Add an annotation through the editor (state + undo history + persistence) */
  addAnnotation?: (spec: AIAnnotationSpec) => Promise<AIAnnotationResult>;

  /** Highlight resolved device/connection IDs on the canvas. Returns whether
   *  the highlight is visible in the editor's current view. */
  setHighlights?: (highlights: TopologyHighlightRequest) => { visibleInCurrentView: boolean };
  clearHighlights?: () => void;

  /** Run the editor's export (native save dialog). Resolves to the saved
   *  path, or null when the user cancelled the dialog. Rejects on failure. */
  exportTopology?: (format: 'png' | 'svg' | 'json') => Promise<{ path: string } | null>;
}

/**
 * Valid device types for AI tool schema
 */
const DEVICE_TYPES: string[] = [...TOPOLOGY_DEVICE_TYPES];

/** Field names `topology_update` accepts, per item type (for schema + errors). */
const DEVICE_UPDATE_FIELD_NAMES = Object.keys(DEVICE_UPDATE_FIELDS);
const CONNECTION_UPDATE_FIELD_NAMES = [...Object.keys(CONNECTION_UPDATE_FIELDS), ...Object.keys(CONNECTION_LOCAL_ONLY_FIELDS)];

/** Tools that only work while an editor provides the matching callback. */
const EDITOR_BACKED_TOOLS: Record<string, (cb: TopologyAICallbacks) => boolean> = {
  topology_annotate: cb => typeof cb.addAnnotation === 'function',
  topology_highlight: cb => typeof cb.setHighlights === 'function',
  topology_export: cb => typeof cb.exportTopology === 'function',
};

/**
 * Get topology AI tool definitions
 *
 * Annotation, highlight and export are only listed when the callbacks wire
 * them to a real editor; otherwise the model never sees them.
 *
 * @param callbacks - Callbacks for topology operations
 * @returns Array of tool definitions for AI
 */
export function getTopologyTools(callbacks: TopologyAICallbacks): ToolDefinition[] {
  return allTopologyTools().filter(t => {
    const wired = EDITOR_BACKED_TOOLS[t.name];
    return !wired || wired(callbacks);
  });
}

function allTopologyTools(): ToolDefinition[] {
  return [
    // === QUERY TOOLS (auto-execute, read-only) ===
    {
      name: 'topology_query',
      description: 'Query topology for devices, connections, or specific information. Use for questions like "What devices are in site NYC?" or "Show all firewalls".',
      input_schema: {
        type: 'object',
        properties: {
          query_type: {
            type: 'string',
            enum: ['devices', 'connections', 'device_by_name', 'devices_by_type', 'devices_by_site', 'summary'],
            description: 'Type of query: devices=list all, connections=list all, device_by_name=find by name, devices_by_type=filter by type, devices_by_site=filter by site, summary=topology statistics'
          },
          filter: {
            type: 'string',
            description: 'Filter value (device name, type, or site name)'
          }
        },
        required: ['query_type']
      }
    },
    {
      name: 'topology_path',
      description: 'Find network path between two devices. Returns hop-by-hop route with interfaces. Use for questions like "What is the path from R1 to R5?" or "How many hops between core and edge?".',
      input_schema: {
        type: 'object',
        properties: {
          source_device: { type: 'string', description: 'Source device name or ID' },
          target_device: { type: 'string', description: 'Target device name or ID' }
        },
        required: ['source_device', 'target_device']
      }
    },
    {
      name: 'topology_analyze',
      description: 'Analyze topology for patterns, issues, or best practice comparison. Use for questions like "Are there any single points of failure?" or "Check redundancy for this path".',
      input_schema: {
        type: 'object',
        properties: {
          analysis_type: {
            type: 'string',
            enum: ['spof', 'redundancy', 'best_practices', 'summary', 'health'],
            description: 'Type of analysis: spof=single points of failure, redundancy=check redundant paths, best_practices=compare to standards, summary=overall stats, health=live SNMP health/error rollup (devices with degraded health, interfaces with in/out errors or discards). Use health to answer "why is this link showing errors" and "what is unhealthy right now".'
          },
          focus_area: {
            type: 'string',
            description: 'Optional: specific device name, site, or segment to focus on'
          }
        },
        required: ['analysis_type']
      }
    },

    // === MODIFY TOOLS (auto-execute with undo) ===
    {
      name: 'topology_add_device',
      description: 'Add a new device to the topology. Auto-places if position not specified. Use when asked to "add a router" or "create a new firewall".',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Device name (e.g., "FW-DMZ", "R1")' },
          type: {
            type: 'string',
            enum: DEVICE_TYPES,
            description: 'Device type for icon display'
          },
          x: { type: 'number', description: 'X position (0-1000), optional - auto-placed if not specified' },
          y: { type: 'number', description: 'Y position (0-1000), optional - auto-placed if not specified' },
          sessionId: { type: 'string', description: 'Optional: link to NetStacks session for click-to-connect' },
          site: { type: 'string', description: 'Optional: site/location name' },
          role: { type: 'string', description: 'Optional: device role (e.g., "core", "edge", "access")' }
        },
        required: ['name', 'type']
      }
    },
    {
      name: 'topology_add_connection',
      description: 'Add a connection between two devices. Use when asked to "connect R1 to SW1" or "add a link between firewall and router".',
      input_schema: {
        type: 'object',
        properties: {
          source_device: { type: 'string', description: 'Source device name or ID' },
          target_device: { type: 'string', description: 'Target device name or ID' },
          source_interface: { type: 'string', description: 'Source interface name (e.g., "Gi0/1")' },
          target_interface: { type: 'string', description: 'Target interface name' },
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'degraded'],
            description: 'Connection status (default: active)'
          },
          label: { type: 'string', description: 'Optional label for the connection' }
        },
        required: ['source_device', 'target_device']
      }
    },
    {
      name: 'topology_update',
      description: 'Update device or connection properties. Use when asked to "change the firewall type", "label the uplink" or "make the link dashed". The result lists which fields were saved and which changed the open view only.',
      input_schema: {
        type: 'object',
        properties: {
          item_type: {
            type: 'string',
            enum: ['device', 'connection'],
            description: 'Whether updating a device or connection'
          },
          item_id: { type: 'string', description: 'Device or connection ID (or name for devices)' },
          updates: {
            type: 'object',
            description: `Object of fields to set, e.g. {"label": "uplink", "lineStyle": "dashed"}. Device fields: ${DEVICE_UPDATE_FIELD_NAMES.join(', ')}. Connection fields: ${CONNECTION_UPDATE_FIELD_NAMES.join(', ')} (status is shown in the editor but not saved). snake_case names are accepted too.`
          }
        },
        required: ['item_type', 'item_id', 'updates']
      }
    },
    {
      name: 'topology_move',
      description: 'Move a device to a new position. Use when asked to "move R1 to the left" or "reposition the firewall".',
      input_schema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device name or ID to move' },
          x: { type: 'number', description: 'New X position (0-1000)' },
          y: { type: 'number', description: 'New Y position (0-1000)' }
        },
        required: ['device', 'x', 'y']
      }
    },
    {
      name: 'topology_remove',
      description: 'Remove a device or connection from the topology. Use when asked to "delete the firewall" or "remove the link between R1 and R2".',
      input_schema: {
        type: 'object',
        properties: {
          item_type: {
            type: 'string',
            enum: ['device', 'connection'],
            description: 'Whether removing a device or connection'
          },
          item_id: { type: 'string', description: 'Device or connection ID (or name for devices)' }
        },
        required: ['item_type', 'item_id']
      }
    },

    // === ANNOTATION TOOLS ===
    {
      name: 'topology_annotate',
      description: 'Add an annotation (text label, shape, or line) to the open topology. It is saved with the topology and can be undone. Use when asked to "add a label" or "draw a box around the core routers".',
      input_schema: {
        type: 'object',
        properties: {
          annotation_type: {
            type: 'string',
            enum: ['text', 'shape', 'line'],
            description: 'Type of annotation'
          },
          content: { type: 'string', description: 'Text content (text) or label (shape)' },
          x: { type: 'number', description: 'X position in 0-1000 space (text anchor, shape top-left, or line start). Default 500' },
          y: { type: 'number', description: 'Y position in 0-1000 space. Default 500' },
          width: { type: 'number', description: 'Shape width (default 100)' },
          height: { type: 'number', description: 'Shape height (default 60)' },
          shape_type: {
            type: 'string',
            enum: ['rectangle', 'circle', 'diamond', 'arrow', 'cloud'],
            description: 'Shape kind (default rectangle)'
          },
          x2: { type: 'number', description: 'Line end X (default x + 100)' },
          y2: { type: 'number', description: 'Line end Y (default y)' },
          color: { type: 'string', description: 'Color, e.g. "#ff0000" or "red"' },
          font_size: { type: 'number', description: 'Text font size (default 14)' }
        },
        required: ['annotation_type']
      }
    },
    {
      name: 'topology_highlight',
      description: 'Highlight devices or connections on the canvas with a color (view only, not saved). Replaces any previous AI highlight; pass an empty targets array to clear. Use when asked to "highlight the path" or "mark all firewalls in red".',
      input_schema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device names/IDs or connection IDs to highlight (empty array clears highlights)'
          },
          color: { type: 'string', description: 'Highlight color (e.g., "red", "#ff0000")' },
          label: { type: 'string', description: 'Optional label for the highlight' }
        },
        required: ['targets']
      }
    },

    // === EXPORT TOOLS ===
    {
      name: 'topology_export',
      description: 'Export the open topology to a file. The user picks the location in a save dialog; the result says whether a file was written. Use when asked to "export as PNG" or "save the topology to JSON".',
      input_schema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['png', 'svg', 'json'],
            description: 'Export format'
          }
        },
        required: ['format']
      }
    }
  ];
}

// ============================================
// TOOL EXECUTION HANDLERS
// ============================================

/** Error result for an editor-backed tool with no editor behind it. */
function unavailable(message: string): { content: string; is_error: boolean } {
  return { content: JSON.stringify({ error: message }), is_error: true };
}

/**
 * Parse `topology_update.updates`: an object, or a JSON string encoding one
 * (older prompts and some models still send a string).
 */
export function parseUpdatesArgument(raw: unknown): { updates: Record<string, unknown> } | { error: string } {
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { error: 'No updates specified' };
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      return { error: `updates is not valid JSON: ${getErrorMessage(err)}` };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'updates must be an object of field -> value, e.g. {"label": "uplink"}' };
  }
  if (Object.keys(value).length === 0) {
    return { error: 'No updates specified' };
  }
  return { updates: value as Record<string, unknown> };
}

/** Accept snake_case field names (`source_interface`, `device_type`) as aliases. */
export function normalizeUpdateKeys(updates: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    const camel = key === 'device_type' ? 'type' : key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[camel] = value;
  }
  return out;
}

/** Summarise which fields were saved vs. view-only for a tool result. */
function describeSaved(result: TopologyItemUpdate<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { savedFields: result.persisted };
  if (result.notPersisted.length > 0) {
    out.notSavedFields = result.notPersisted;
    out.note = 'notSavedFields changed in the open editor only and will be lost on reload (the backend does not store them, or the topology is unsaved).';
  }
  return out;
}

const NAMED_OR_FUNCTIONAL_COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|(rgb|rgba|hsl|hsla)\([^)]*\))$/i;

/** True for a value the canvas will accept as a stroke/fill color. */
export function isValidCssColor(color: string): boolean {
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', color);
  }
  return NAMED_OR_FUNCTIONAL_COLOR.test(color);
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined | { error: string } {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${key} must be a number` };
  return v;
}

const SHAPE_TYPES: readonly ShapeType[] = ['rectangle', 'circle', 'diamond', 'arrow', 'cloud'];

/** Validate `topology_annotate` input into an AIAnnotationSpec. */
export function parseAnnotationSpec(input: Record<string, unknown>): { spec: AIAnnotationSpec } | { error: string } {
  const type = input.annotation_type;
  if (type !== 'text' && type !== 'shape' && type !== 'line') {
    return { error: 'annotation_type must be one of: text, shape, line' };
  }
  const nums: Record<string, number | undefined> = {};
  for (const key of ['x', 'y', 'width', 'height', 'x2', 'y2', 'font_size']) {
    const n = optionalNumber(input, key);
    if (typeof n === 'object') return n;
    nums[key] = n;
  }
  for (const key of ['x', 'y', 'x2', 'y2']) {
    const n = nums[key];
    if (n !== undefined && (n < 0 || n > 1000)) return { error: `${key} must be within 0-1000` };
  }
  for (const key of ['width', 'height', 'font_size']) {
    const n = nums[key];
    if (n !== undefined && n <= 0) return { error: `${key} must be positive` };
  }
  const shapeType = input.shape_type;
  if (shapeType !== undefined && !SHAPE_TYPES.includes(shapeType as ShapeType)) {
    return { error: `shape_type must be one of: ${SHAPE_TYPES.join(', ')}` };
  }
  const color = input.color;
  if (color !== undefined && (typeof color !== 'string' || !isValidCssColor(color))) {
    return { error: `"${String(color)}" is not a valid CSS color` };
  }
  const content = input.content;
  if (content !== undefined && typeof content !== 'string') {
    return { error: 'content must be a string' };
  }
  return {
    spec: {
      type,
      content,
      x: nums.x ?? 500,
      y: nums.y ?? 500,
      width: nums.width,
      height: nums.height,
      shapeType: shapeType as ShapeType | undefined,
      x2: nums.x2,
      y2: nums.y2,
      color,
      fontSize: nums.font_size,
    },
  };
}

/**
 * Helper: Group array elements by a key
 */
function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const k = String(item[key] || 'unknown');
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

/**
 * Helper: Resolve device name or ID to device ID
 */
function resolveDeviceId(topology: Topology, nameOrId: string): string | null {
  // Try exact ID match first
  const byId = topology.devices.find(d => d.id === nameOrId);
  if (byId) return byId.id;

  // Try exact name match (case-insensitive)
  const byName = topology.devices.find(d =>
    d.name.toLowerCase() === nameOrId.toLowerCase()
  );
  if (byName) return byName.id;

  // Try partial name match
  const byPartial = topology.devices.find(d =>
    d.name.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return byPartial.id;

  return null;
}

/**
 * Helper: Find path between devices using BFS
 */
function findPath(topology: Topology, sourceNameOrId: string, targetNameOrId: string): Device[] {
  const sourceId = resolveDeviceId(topology, sourceNameOrId);
  const targetId = resolveDeviceId(topology, targetNameOrId);

  if (!sourceId || !targetId) return [];
  if (sourceId === targetId) {
    const device = topology.devices.find(d => d.id === sourceId);
    return device ? [device] : [];
  }

  // Build adjacency map
  const adjacency = new Map<string, string[]>();
  for (const device of topology.devices) {
    adjacency.set(device.id, []);
  }
  for (const conn of topology.connections) {
    adjacency.get(conn.sourceDeviceId)?.push(conn.targetDeviceId);
    adjacency.get(conn.targetDeviceId)?.push(conn.sourceDeviceId);
  }

  // BFS
  const visited = new Set<string>();
  const parent = new Map<string, string | null>();
  const queue: string[] = [sourceId];
  visited.add(sourceId);
  parent.set(sourceId, null);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current === targetId) {
      // Reconstruct path
      const path: Device[] = [];
      let node: string | null | undefined = current;
      while (node) {
        const device = topology.devices.find(d => d.id === node);
        if (device) path.unshift(device);
        node = parent.get(node);
      }
      return path;
    }

    for (const neighbor of adjacency.get(current) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }

  return []; // No path found
}

/**
 * Helper: Find single points of failure
 * A SPOF is a device or connection whose failure disconnects the network
 */
function findSinglePointsOfFailure(topology: Topology): {
  devices: Array<{ device: Device; affectedCount: number }>;
  connections: Array<{ connection: Connection; affectedCount: number }>;
  summary: string;
} {
  const spofDevices: Array<{ device: Device; affectedCount: number }> = [];
  const spofConnections: Array<{ connection: Connection; affectedCount: number }> = [];

  // Helper to count connected components
  const countConnectedComponents = (excludeDeviceId?: string, excludeConnectionId?: string): number => {
    const activeDevices = topology.devices.filter(d => d.id !== excludeDeviceId);
    const activeConnections = topology.connections.filter(c =>
      c.id !== excludeConnectionId &&
      c.sourceDeviceId !== excludeDeviceId &&
      c.targetDeviceId !== excludeDeviceId
    );

    if (activeDevices.length === 0) return 0;

    const visited = new Set<string>();
    let components = 0;

    const dfs = (deviceId: string) => {
      visited.add(deviceId);
      for (const conn of activeConnections) {
        let neighbor: string | null = null;
        if (conn.sourceDeviceId === deviceId) neighbor = conn.targetDeviceId;
        else if (conn.targetDeviceId === deviceId) neighbor = conn.sourceDeviceId;

        if (neighbor && !visited.has(neighbor) && activeDevices.some(d => d.id === neighbor)) {
          dfs(neighbor);
        }
      }
    };

    for (const device of activeDevices) {
      if (!visited.has(device.id)) {
        dfs(device.id);
        components++;
      }
    }

    return components;
  };

  const baseComponents = countConnectedComponents();

  // Check each device
  for (const device of topology.devices) {
    const withoutDevice = countConnectedComponents(device.id);
    if (withoutDevice > baseComponents) {
      const affectedCount = withoutDevice - baseComponents;
      spofDevices.push({ device, affectedCount });
    }
  }

  // Check each connection
  for (const conn of topology.connections) {
    const withoutConnection = countConnectedComponents(undefined, conn.id);
    if (withoutConnection > baseComponents) {
      const affectedCount = withoutConnection - baseComponents;
      spofConnections.push({ connection: conn, affectedCount });
    }
  }

  // Generate summary
  let summary = '';
  if (spofDevices.length === 0 && spofConnections.length === 0) {
    summary = 'No single points of failure detected. The topology appears to be well connected.';
  } else {
    const parts: string[] = [];
    if (spofDevices.length > 0) {
      parts.push(`${spofDevices.length} device(s) are single points of failure`);
    }
    if (spofConnections.length > 0) {
      parts.push(`${spofConnections.length} connection(s) are single points of failure`);
    }
    summary = parts.join(', ') + '. Removing any of these would disconnect parts of the network.';
  }

  return { devices: spofDevices, connections: spofConnections, summary };
}

/**
 * Helper: Analyze redundancy for a path or segment
 */
function analyzeRedundancy(topology: Topology, focusArea?: string): {
  hasRedundancy: boolean;
  alternativePaths: number;
  analysis: string;
} {
  // If focus area specified, try to parse as "device1 to device2"
  if (focusArea) {
    const match = focusArea.match(/(.+?)\s+to\s+(.+)/i);
    if (match) {
      const [, source, target] = match;
      const sourceId = resolveDeviceId(topology, source.trim());
      const targetId = resolveDeviceId(topology, target.trim());

      if (sourceId && targetId) {
        // Find all paths using DFS with path enumeration (limited)
        const paths: string[][] = [];
        const findAllPaths = (
          current: string,
          target: string,
          visited: Set<string>,
          path: string[]
        ) => {
          if (paths.length >= 10) return; // Limit path enumeration
          if (current === target) {
            paths.push([...path]);
            return;
          }
          for (const conn of topology.connections) {
            let neighbor: string | null = null;
            if (conn.sourceDeviceId === current) neighbor = conn.targetDeviceId;
            else if (conn.targetDeviceId === current) neighbor = conn.sourceDeviceId;

            if (neighbor && !visited.has(neighbor)) {
              visited.add(neighbor);
              path.push(neighbor);
              findAllPaths(neighbor, target, visited, path);
              path.pop();
              visited.delete(neighbor);
            }
          }
        };

        const visited = new Set<string>([sourceId]);
        findAllPaths(sourceId, targetId, visited, [sourceId]);

        const sourceDevice = topology.devices.find(d => d.id === sourceId);
        const targetDevice = topology.devices.find(d => d.id === targetId);

        return {
          hasRedundancy: paths.length > 1,
          alternativePaths: paths.length,
          analysis: paths.length > 1
            ? `Found ${paths.length} distinct path(s) between ${sourceDevice?.name} and ${targetDevice?.name}. The connection has redundancy.`
            : paths.length === 1
              ? `Only 1 path found between ${sourceDevice?.name} and ${targetDevice?.name}. No redundancy - this is a single point of failure.`
              : `No path found between ${sourceDevice?.name} and ${targetDevice?.name}.`
        };
      }
    }
  }

  // General redundancy analysis: check average connectivity
  const deviceConnections = new Map<string, number>();
  for (const device of topology.devices) {
    deviceConnections.set(device.id, 0);
  }
  for (const conn of topology.connections) {
    deviceConnections.set(conn.sourceDeviceId, (deviceConnections.get(conn.sourceDeviceId) || 0) + 1);
    deviceConnections.set(conn.targetDeviceId, (deviceConnections.get(conn.targetDeviceId) || 0) + 1);
  }

  const connections = Array.from(deviceConnections.values());
  const avgConnections = connections.reduce((a, b) => a + b, 0) / connections.length;
  const singleConnected = connections.filter(c => c === 1).length;

  const hasRedundancy = avgConnections >= 2 && singleConnected < topology.devices.length / 2;

  return {
    hasRedundancy,
    alternativePaths: 0, // Not specific to a path
    analysis: hasRedundancy
      ? `Average device connectivity: ${avgConnections.toFixed(1)} connections. ${singleConnected} device(s) have only one connection. Topology has reasonable redundancy.`
      : `Average device connectivity: ${avgConnections.toFixed(1)} connections. ${singleConnected} device(s) have only one connection. Consider adding redundant links.`
  };
}

/**
 * Helper: Compare topology to best practices
 */
function compareToBestPractices(topology: Topology): {
  issues: string[];
  recommendations: string[];
  score: number;
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  // Check 1: Single-connected devices (except servers/endpoints)
  const networkDevices = topology.devices.filter(d =>
    ['router', 'switch', 'firewall'].includes(d.type)
  );

  for (const device of networkDevices) {
    const connectionCount = topology.connections.filter(c =>
      c.sourceDeviceId === device.id || c.targetDeviceId === device.id
    ).length;

    if (connectionCount === 1) {
      issues.push(`${device.name} (${device.type}) has only one connection - potential single point of failure`);
      score -= 10;
    }
  }

  // Check 2: Unnamed or generic device names
  const genericNames = topology.devices.filter(d =>
    /^(device|unknown|new)/i.test(d.name) || d.name.length <= 2
  );
  if (genericNames.length > 0) {
    issues.push(`${genericNames.length} device(s) have generic/short names`);
    recommendations.push('Use descriptive device names indicating role and location (e.g., "NYC-CORE-R1")');
    score -= 5;
  }

  // Check 3: Unknown device types
  const unknownTypes = topology.devices.filter(d => d.type === 'unknown');
  if (unknownTypes.length > 0) {
    issues.push(`${unknownTypes.length} device(s) have unknown type`);
    recommendations.push('Classify devices by type (router, switch, firewall, etc.) for better visualization');
    score -= 5;
  }

  // Check 4: Disconnected devices
  const connectedDeviceIds = new Set<string>();
  for (const conn of topology.connections) {
    connectedDeviceIds.add(conn.sourceDeviceId);
    connectedDeviceIds.add(conn.targetDeviceId);
  }
  const disconnected = topology.devices.filter(d => !connectedDeviceIds.has(d.id));
  if (disconnected.length > 0) {
    issues.push(`${disconnected.length} device(s) are not connected to any other device`);
    recommendations.push('Connect isolated devices or remove them if not part of the topology');
    score -= 15;
  }

  // Check 5: Missing interface labels
  const missingInterfaces = topology.connections.filter(c =>
    !c.sourceInterface && !c.targetInterface
  );
  if (missingInterfaces.length > topology.connections.length / 2) {
    issues.push(`${missingInterfaces.length} connection(s) missing interface labels`);
    recommendations.push('Add interface labels for better documentation and troubleshooting');
    score -= 5;
  }

  // Positive checks
  if (issues.length === 0) {
    recommendations.push('Topology follows best practices');
  }

  // Keep score in valid range
  score = Math.max(0, Math.min(100, score));

  return { issues, recommendations, score };
}

/**
 * Helper: Auto-place a new device in an empty spot
 */
function autoPlaceDevice(topology: Topology): { x: number; y: number } {
  // Start from center, find an empty spot using grid-based approach
  const gridSize = 100; // Check every 100 units
  const minDistance = 80; // Minimum distance from other devices

  // Try positions in expanding rings from center
  for (let radius = 0; radius <= 500; radius += gridSize) {
    for (let angle = 0; angle < 360; angle += 45) {
      const x = 500 + radius * Math.cos(angle * Math.PI / 180);
      const y = 500 + radius * Math.sin(angle * Math.PI / 180);

      // Check if position is within bounds
      if (x < 50 || x > 950 || y < 50 || y > 950) continue;

      // Check distance from all existing devices
      const tooClose = topology.devices.some(d => {
        const dx = d.x - x;
        const dy = d.y - y;
        return Math.sqrt(dx * dx + dy * dy) < minDistance;
      });

      if (!tooClose) {
        return { x: Math.round(x), y: Math.round(y) };
      }
    }
  }

  // Fallback: random position
  return {
    x: 100 + Math.random() * 800,
    y: 100 + Math.random() * 800
  };
}

/**
 * Execute a topology tool
 *
 * @param toolName - Name of the tool to execute
 * @param input - Tool input parameters
 * @param callbacks - Callbacks for topology operations
 * @returns Tool result
 */
export async function executeTopologyTool(
  toolName: string,
  input: Record<string, unknown>,
  callbacks: TopologyAICallbacks
): Promise<{ content: string; is_error: boolean }> {
  const topology = callbacks.getTopology();

  // Handle no topology case
  if (!topology && !['topology_query'].includes(toolName)) {
    return {
      content: JSON.stringify({ error: 'No topology loaded. Please open or create a topology first.' }),
      is_error: true
    };
  }

  try {
    switch (toolName) {
      // === QUERY TOOLS ===
      case 'topology_query': {
        if (!topology) {
          return {
            content: JSON.stringify({ devices: [], connections: [], message: 'No topology loaded' }),
            is_error: false
          };
        }

        const queryType = input.query_type as string;
        const filter = input.filter as string | undefined;

        switch (queryType) {
          case 'devices':
            return {
              content: JSON.stringify({
                count: topology.devices.length,
                devices: topology.devices.map(d => ({
                  id: d.id,
                  name: d.name,
                  type: d.type,
                  status: d.status,
                  site: d.site,
                  role: d.role,
                  position: { x: d.x, y: d.y }
                }))
              }),
              is_error: false
            };

          case 'connections':
            return {
              content: JSON.stringify({
                count: topology.connections.length,
                connections: topology.connections.map(c => {
                  const source = topology.devices.find(d => d.id === c.sourceDeviceId);
                  const target = topology.devices.find(d => d.id === c.targetDeviceId);
                  return {
                    id: c.id,
                    source: source?.name || c.sourceDeviceId,
                    target: target?.name || c.targetDeviceId,
                    sourceInterface: c.sourceInterface,
                    targetInterface: c.targetInterface,
                    status: c.status,
                    label: c.label
                  };
                })
              }),
              is_error: false
            };

          case 'device_by_name': {
            if (!filter) {
              return { content: JSON.stringify({ error: 'Filter (device name) required' }), is_error: true };
            }
            const device = topology.devices.find(d =>
              d.name.toLowerCase().includes(filter.toLowerCase())
            );
            return {
              content: JSON.stringify(device ? { found: true, device } : { found: false }),
              is_error: false
            };
          }

          case 'devices_by_type': {
            if (!filter) {
              return { content: JSON.stringify({ error: 'Filter (device type) required' }), is_error: true };
            }
            const devices = topology.devices.filter(d => d.type === filter);
            return {
              content: JSON.stringify({ count: devices.length, devices }),
              is_error: false
            };
          }

          case 'devices_by_site': {
            if (!filter) {
              return { content: JSON.stringify({ error: 'Filter (site name) required' }), is_error: true };
            }
            const devices = topology.devices.filter(d =>
              d.site?.toLowerCase().includes(filter.toLowerCase())
            );
            return {
              content: JSON.stringify({ count: devices.length, devices }),
              is_error: false
            };
          }

          case 'summary': {
            const byType = groupBy(topology.devices, 'type');
            const byStatus = groupBy(topology.devices, 'status');
            const sites = [...new Set(topology.devices.map(d => d.site).filter(Boolean))];

            return {
              content: JSON.stringify({
                deviceCount: topology.devices.length,
                connectionCount: topology.connections.length,
                devicesByType: Object.fromEntries(
                  Object.entries(byType).map(([k, v]) => [k, v.length])
                ),
                devicesByStatus: Object.fromEntries(
                  Object.entries(byStatus).map(([k, v]) => [k, v.length])
                ),
                sites,
                topologyName: topology.name,
                source: topology.source
              }),
              is_error: false
            };
          }

          default:
            return {
              content: JSON.stringify({ error: `Unknown query type: ${queryType}` }),
              is_error: true
            };
        }
      }

      case 'topology_path': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const sourceDevice = input.source_device as string;
        const targetDevice = input.target_device as string;

        const path = findPath(topology, sourceDevice, targetDevice);

        if (path.length === 0) {
          return {
            content: JSON.stringify({
              found: false,
              message: `No path found between "${sourceDevice}" and "${targetDevice}". Devices may not exist or are not connected.`
            }),
            is_error: false
          };
        }

        // Build path description with interfaces
        const pathSteps: Array<{
          device: string;
          interface?: string;
          nextInterface?: string;
        }> = [];

        for (let i = 0; i < path.length; i++) {
          const device = path[i];
          const step: { device: string; interface?: string; nextInterface?: string } = {
            device: device.name
          };

          if (i < path.length - 1) {
            const nextDevice = path[i + 1];
            const conn = topology.connections.find(c =>
              (c.sourceDeviceId === device.id && c.targetDeviceId === nextDevice.id) ||
              (c.targetDeviceId === device.id && c.sourceDeviceId === nextDevice.id)
            );
            if (conn) {
              if (conn.sourceDeviceId === device.id) {
                step.interface = conn.sourceInterface;
                step.nextInterface = conn.targetInterface;
              } else {
                step.interface = conn.targetInterface;
                step.nextInterface = conn.sourceInterface;
              }
            }
          }

          pathSteps.push(step);
        }

        return {
          content: JSON.stringify({
            found: true,
            hops: path.length - 1,
            path: pathSteps,
            pathSummary: path.map(d => d.name).join(' -> ')
          }),
          is_error: false
        };
      }

      case 'topology_analyze': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const analysisType = input.analysis_type as string;
        const focusArea = input.focus_area as string | undefined;

        switch (analysisType) {
          case 'spof': {
            const result = findSinglePointsOfFailure(topology);
            return {
              content: JSON.stringify({
                analysis: 'Single Points of Failure',
                summary: result.summary,
                spofDevices: result.devices.map(d => ({
                  name: d.device.name,
                  type: d.device.type,
                  affectedSegments: d.affectedCount
                })),
                spofConnections: result.connections.map(c => {
                  const source = topology.devices.find(d => d.id === c.connection.sourceDeviceId);
                  const target = topology.devices.find(d => d.id === c.connection.targetDeviceId);
                  return {
                    link: `${source?.name} - ${target?.name}`,
                    affectedSegments: c.affectedCount
                  };
                })
              }),
              is_error: false
            };
          }

          case 'redundancy': {
            const result = analyzeRedundancy(topology, focusArea);
            return {
              content: JSON.stringify({
                analysis: 'Redundancy Analysis',
                focusArea: focusArea || 'entire topology',
                hasRedundancy: result.hasRedundancy,
                alternativePaths: result.alternativePaths,
                summary: result.analysis
              }),
              is_error: false
            };
          }

          case 'best_practices': {
            const result = compareToBestPractices(topology);
            return {
              content: JSON.stringify({
                analysis: 'Best Practices Comparison',
                score: result.score,
                issueCount: result.issues.length,
                issues: result.issues,
                recommendations: result.recommendations
              }),
              is_error: false
            };
          }

          case 'summary': {
            const spof = findSinglePointsOfFailure(topology);
            const redundancy = analyzeRedundancy(topology);
            const bestPractices = compareToBestPractices(topology);

            return {
              content: JSON.stringify({
                analysis: 'Topology Summary',
                deviceCount: topology.devices.length,
                connectionCount: topology.connections.length,
                spofCount: spof.devices.length + spof.connections.length,
                hasRedundancy: redundancy.hasRedundancy,
                bestPracticesScore: bestPractices.score,
                mainIssues: bestPractices.issues.slice(0, 3)
              }),
              is_error: false
            };
          }

          case 'health': {
            if (!callbacks.getDeviceStats) {
              return {
                content: JSON.stringify({
                  analysis: 'Live Health',
                  available: false,
                  note: 'Live SNMP stats are not enabled for this topology. Turn on the Live SNMP toggle in the topology toolbar to collect per-interface error/health data.'
                }),
                is_error: false
              };
            }
            const focusLower = focusArea?.toLowerCase();
            const unhealthyDevices: Array<Record<string, unknown>> = [];
            const errorInterfaces: Array<Record<string, unknown>> = [];
            for (const device of topology.devices) {
              if (focusLower && !device.name.toLowerCase().includes(focusLower)) continue;
              const stats = callbacks.getDeviceStats(device.id);
              if (!stats) continue;
              const s = stats.interfaceSummary;
              const hasErrors = s.totalInErrors > 0 || s.totalOutErrors > 0 || s.totalInDiscards > 0 || s.totalOutDiscards > 0;
              if (stats.healthScore < 70 || hasErrors || s.down > 0) {
                unhealthyDevices.push({
                  name: device.name,
                  healthScore: stats.healthScore,
                  healthColor: stats.healthColor,
                  cpuPercent: stats.cpuPercent,
                  memoryPercent: stats.memoryPercent,
                  interfacesUp: s.up,
                  interfacesDown: s.down,
                  totalInErrors: s.totalInErrors,
                  totalOutErrors: s.totalOutErrors,
                  totalInDiscards: s.totalInDiscards,
                  totalOutDiscards: s.totalOutDiscards,
                  maxUtilizationPercent: stats.maxUtilizationPercent,
                });
              }
              for (const iface of stats.interfaces) {
                if (iface.inErrors > 0 || iface.outErrors > 0) {
                  errorInterfaces.push({
                    device: device.name,
                    interface: iface.ifDescr,
                    alias: iface.ifAlias || undefined,
                    operStatus: iface.operStatus,
                    inErrors: iface.inErrors,
                    outErrors: iface.outErrors,
                    speedMbps: iface.speedMbps,
                  });
                }
              }
            }
            return {
              content: JSON.stringify({
                analysis: 'Live Health',
                available: true,
                focusArea: focusArea || 'entire topology',
                unhealthyDeviceCount: unhealthyDevices.length,
                unhealthyDevices,
                errorInterfaceCount: errorInterfaces.length,
                errorInterfaces,
              }),
              is_error: false
            };
          }

          default:
            return {
              content: JSON.stringify({ error: `Unknown analysis type: ${analysisType}` }),
              is_error: true
            };
        }
      }

      // === MODIFY TOOLS ===
      case 'topology_add_device': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const name = input.name as string;
        const type = input.type as DeviceType;

        // Check for duplicate name
        const existing = topology.devices.find(d =>
          d.name.toLowerCase() === name.toLowerCase()
        );
        if (existing) {
          return {
            content: JSON.stringify({
              error: `Device "${name}" already exists in the topology`,
              existingDevice: { id: existing.id, name: existing.name }
            }),
            is_error: true
          };
        }

        // Auto-place if position not specified
        const position = (input.x !== undefined && input.y !== undefined)
          ? { x: input.x as number, y: input.y as number }
          : autoPlaceDevice(topology);

        const newDevice = await callbacks.addDevice({
          name,
          type,
          x: position.x,
          y: position.y,
          status: 'unknown' as DeviceStatus,
          sessionId: input.sessionId as string | undefined,
          site: input.site as string | undefined,
          role: input.role as string | undefined,
        });

        return {
          content: JSON.stringify({
            success: true,
            message: `Added device "${name}" (${type}) at position (${position.x}, ${position.y})`,
            device: {
              id: newDevice.id,
              name: newDevice.name,
              type: newDevice.type,
              position: { x: newDevice.x, y: newDevice.y }
            }
          }),
          is_error: false
        };
      }

      case 'topology_add_connection': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const sourceDevice = input.source_device as string;
        const targetDevice = input.target_device as string;

        const sourceId = resolveDeviceId(topology, sourceDevice);
        const targetId = resolveDeviceId(topology, targetDevice);

        if (!sourceId) {
          return {
            content: JSON.stringify({ error: `Source device "${sourceDevice}" not found` }),
            is_error: true
          };
        }
        if (!targetId) {
          return {
            content: JSON.stringify({ error: `Target device "${targetDevice}" not found` }),
            is_error: true
          };
        }
        if (sourceId === targetId) {
          return {
            content: JSON.stringify({ error: 'Cannot connect a device to itself' }),
            is_error: true
          };
        }

        // Check for existing connection
        const existingConn = topology.connections.find(c =>
          (c.sourceDeviceId === sourceId && c.targetDeviceId === targetId) ||
          (c.sourceDeviceId === targetId && c.targetDeviceId === sourceId)
        );
        if (existingConn) {
          const src = topology.devices.find(d => d.id === sourceId);
          const tgt = topology.devices.find(d => d.id === targetId);
          return {
            content: JSON.stringify({
              error: `Connection already exists between "${src?.name}" and "${tgt?.name}"`,
              existingConnection: existingConn.id
            }),
            is_error: true
          };
        }

        const newConnection = await callbacks.addConnection({
          sourceDeviceId: sourceId,
          targetDeviceId: targetId,
          sourceInterface: input.source_interface as string | undefined,
          targetInterface: input.target_interface as string | undefined,
          status: (input.status as ConnectionStatus) || 'active',
          label: input.label as string | undefined,
        });

        const src = topology.devices.find(d => d.id === sourceId);
        const tgt = topology.devices.find(d => d.id === targetId);

        return {
          content: JSON.stringify({
            success: true,
            message: `Added connection between "${src?.name}" and "${tgt?.name}"`,
            connection: {
              id: newConnection.id,
              source: src?.name,
              target: tgt?.name,
              sourceInterface: newConnection.sourceInterface,
              targetInterface: newConnection.targetInterface
            }
          }),
          is_error: false
        };
      }

      case 'topology_update': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const itemType = input.item_type;
        const itemId = input.item_id as string;
        if (itemType !== 'device' && itemType !== 'connection') {
          return { content: JSON.stringify({ error: 'item_type must be "device" or "connection"' }), is_error: true };
        }

        const parsed = parseUpdatesArgument(input.updates);
        if ('error' in parsed) {
          return { content: JSON.stringify({ error: parsed.error }), is_error: true };
        }
        const updates = normalizeUpdateKeys(parsed.updates);

        // Reject unknown or malformed fields up front, listing the valid ones,
        // instead of "succeeding" with values the backend drops.
        const conv = itemType === 'device' ? toDeviceUpdateRequest(updates) : toConnectionUpdateRequest(updates);
        if (conv.unknown.length > 0 || conv.invalid.length > 0) {
          const err = new TopologyUpdateError(itemType, conv.unknown, conv.invalid);
          return { content: JSON.stringify({ error: err.message }), is_error: true };
        }

        if (itemType === 'device') {
          const deviceId = resolveDeviceId(topology, itemId);
          if (!deviceId) {
            return {
              content: JSON.stringify({ error: `Device "${itemId}" not found` }),
              is_error: true
            };
          }

          const result = await callbacks.updateDevice(deviceId, updates as Partial<Device>);
          return {
            content: JSON.stringify({
              success: true,
              message: `Updated device "${result.item.name}"`,
              device: { id: result.item.id, name: result.item.name },
              ...describeSaved(result),
            }),
            is_error: false
          };
        }

        const connection = topology.connections.find(c => c.id === itemId);
        if (!connection) {
          return {
            content: JSON.stringify({ error: `Connection "${itemId}" not found` }),
            is_error: true
          };
        }

        const result = await callbacks.updateConnection(itemId, updates as Partial<Connection>);
        const src = topology.devices.find(d => d.id === result.item.sourceDeviceId);
        const tgt = topology.devices.find(d => d.id === result.item.targetDeviceId);

        return {
          content: JSON.stringify({
            success: true,
            message: `Updated connection between "${src?.name}" and "${tgt?.name}"`,
            connection: { id: result.item.id },
            ...describeSaved(result),
          }),
          is_error: false
        };
      }

      case 'topology_move': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const deviceNameOrId = input.device as string;
        const x = input.x as number;
        const y = input.y as number;

        const deviceId = resolveDeviceId(topology, deviceNameOrId);
        if (!deviceId) {
          return {
            content: JSON.stringify({ error: `Device "${deviceNameOrId}" not found` }),
            is_error: true
          };
        }

        // Validate position bounds
        if (x < 0 || x > 1000 || y < 0 || y > 1000) {
          return {
            content: JSON.stringify({ error: 'Position must be within 0-1000 range' }),
            is_error: true
          };
        }

        await callbacks.moveDevice(deviceId, x, y);
        const device = topology.devices.find(d => d.id === deviceId);

        return {
          content: JSON.stringify({
            success: true,
            message: `Moved device "${device?.name}" to position (${x}, ${y})`,
            device: { id: deviceId, name: device?.name, position: { x, y } }
          }),
          is_error: false
        };
      }

      case 'topology_remove': {
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }

        const itemType = input.item_type as 'device' | 'connection';
        const itemId = input.item_id as string;

        if (itemType === 'device') {
          const deviceId = resolveDeviceId(topology, itemId);
          if (!deviceId) {
            return {
              content: JSON.stringify({ error: `Device "${itemId}" not found` }),
              is_error: true
            };
          }

          const device = topology.devices.find(d => d.id === deviceId);
          const affectedConnections = topology.connections.filter(c =>
            c.sourceDeviceId === deviceId || c.targetDeviceId === deviceId
          ).length;

          await callbacks.removeDevice(deviceId);

          return {
            content: JSON.stringify({
              success: true,
              message: `Removed device "${device?.name}"${affectedConnections > 0 ? ` and ${affectedConnections} connection(s)` : ''}`,
              removedDevice: device?.name,
              removedConnections: affectedConnections
            }),
            is_error: false
          };
        } else {
          const connection = topology.connections.find(c => c.id === itemId);
          if (!connection) {
            return {
              content: JSON.stringify({ error: `Connection "${itemId}" not found` }),
              is_error: true
            };
          }

          const src = topology.devices.find(d => d.id === connection.sourceDeviceId);
          const tgt = topology.devices.find(d => d.id === connection.targetDeviceId);

          await callbacks.removeConnection(itemId);

          return {
            content: JSON.stringify({
              success: true,
              message: `Removed connection between "${src?.name}" and "${tgt?.name}"`,
              removedConnection: { source: src?.name, target: tgt?.name }
            }),
            is_error: false
          };
        }
      }

      // === ANNOTATION TOOLS ===
      case 'topology_annotate': {
        if (!callbacks.addAnnotation) {
          return unavailable('Annotations need an open topology editor; none is available.');
        }
        const spec = parseAnnotationSpec(input);
        if ('error' in spec) {
          return { content: JSON.stringify({ error: spec.error }), is_error: true };
        }

        const annotation = await callbacks.addAnnotation(spec.spec);
        return {
          content: JSON.stringify({
            success: true,
            message: annotation.persisted
              ? `Added ${annotation.type} annotation (saved; the user can undo it)`
              : `Added ${annotation.type} annotation to the unsaved topology (kept in the editor until the topology is saved)`,
            annotation: { id: annotation.id, type: annotation.type, position: { x: spec.spec.x, y: spec.spec.y } },
            persisted: annotation.persisted,
          }),
          is_error: false
        };
      }

      case 'topology_highlight': {
        if (!callbacks.setHighlights) {
          return unavailable('Highlighting needs an open topology editor; none is available.');
        }
        if (!topology) {
          return { content: JSON.stringify({ error: 'No topology loaded' }), is_error: true };
        }
        const targets = input.targets;
        if (!Array.isArray(targets) || !targets.every(t => typeof t === 'string')) {
          return { content: JSON.stringify({ error: 'targets must be an array of device names/IDs or connection IDs' }), is_error: true };
        }

        if (targets.length === 0) {
          callbacks.clearHighlights?.();
          return {
            content: JSON.stringify({ success: true, message: 'Cleared highlights' }),
            is_error: false
          };
        }

        const color = typeof input.color === 'string' && input.color.trim() ? input.color.trim() : '#ffeb3b';
        if (!isValidCssColor(color)) {
          return { content: JSON.stringify({ error: `"${color}" is not a valid CSS color` }), is_error: true };
        }
        const label = typeof input.label === 'string' ? input.label : undefined;

        const resolved: string[] = [];
        const names: string[] = [];
        const unresolved: string[] = [];
        for (const target of targets) {
          const conn = topology.connections.find(c => c.id === target);
          if (conn) {
            resolved.push(conn.id);
            const src = topology.devices.find(d => d.id === conn.sourceDeviceId);
            const tgt = topology.devices.find(d => d.id === conn.targetDeviceId);
            names.push(`${src?.name ?? '?'} - ${tgt?.name ?? '?'}`);
            continue;
          }
          const deviceId = resolveDeviceId(topology, target);
          if (deviceId) {
            resolved.push(deviceId);
            names.push(topology.devices.find(d => d.id === deviceId)?.name ?? deviceId);
          } else {
            unresolved.push(target);
          }
        }

        if (resolved.length === 0) {
          return {
            content: JSON.stringify({ error: 'None of the targets matched a device or connection', unresolved }),
            is_error: true
          };
        }

        const { visibleInCurrentView } = callbacks.setHighlights({ targets: [...new Set(resolved)], color, label });
        return {
          content: JSON.stringify({
            success: true,
            message: `Highlighted ${names.length} item(s) in ${color}`,
            highlighted: names,
            ...(unresolved.length > 0 ? { unresolved } : {}),
            ...(visibleInCurrentView ? {} : { note: 'Highlights render in the 2D view; the editor is currently showing the 3D view.' }),
          }),
          is_error: false
        };
      }

      // === EXPORT TOOLS ===
      case 'topology_export': {
        if (!callbacks.exportTopology) {
          return unavailable('Export needs an open topology editor; none is available. The user can export from the toolbar.');
        }
        const format = input.format;
        if (format !== 'png' && format !== 'svg' && format !== 'json') {
          return { content: JSON.stringify({ error: 'format must be one of: png, svg, json' }), is_error: true };
        }

        const saved = await callbacks.exportTopology(format);
        if (!saved) {
          return {
            content: JSON.stringify({ error: 'The user cancelled the save dialog; nothing was exported.' }),
            is_error: true
          };
        }
        return {
          content: JSON.stringify({
            success: true,
            message: `Topology exported as ${format.toUpperCase()} to ${saved.path}`,
            format,
            path: saved.path,
          }),
          is_error: false
        };
      }

      default:
        return {
          content: JSON.stringify({ error: `Unknown topology tool: ${toolName}` }),
          is_error: true
        };
    }
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    console.error(`[topologyAITools] Error executing ${toolName}:`, err);
    return {
      content: JSON.stringify({ error: errorMessage }),
      is_error: true
    };
  }
}

/**
 * System prompt addition for topology tools
 */
export const TOPOLOGY_SYSTEM_PROMPT = `
You have access to topology tools for querying and modifying the network topology.
All modifications are automatically tracked and can be undone by the user.

When modifying the topology:
- Execute changes directly - no approval needed
- User can undo any change via the history panel or Cmd+Z
- Describe what you're doing as you do it

Available capabilities:
- Query devices, connections, and find paths between devices
- Add/remove/update/move devices and connections
- Analyze for single points of failure (SPOF), redundancy, and best practices
- Add annotations, highlight devices/links, and export to PNG/SVG/JSON (only while the topology editor is open; these tools are listed only then)

Device types: router, switch, firewall, server, cloud, access-point, load-balancer, wan-optimizer, voice-gateway, wireless-controller, storage, virtual, sd-wan, iot, unknown

When asked to build or create a topology:
1. Add devices using topology_add_device (positions auto-calculated if not specified)
2. Add connections using topology_add_connection
3. Use meaningful device names indicating role/location

When asked to analyze:
- Use topology_analyze with analysis_type 'spof' to find single points of failure
- Use topology_analyze with analysis_type 'redundancy' to check path redundancy
- Use topology_path to find routes between devices
`;

/**
 * Check if a tool name is a topology tool
 */
export function isTopologyTool(toolName: string): boolean {
  return toolName.startsWith('topology_');
}

/**
 * Tools that change the topology's structure (devices, connections, layout).
 * Withheld and denied unless `ai.topology.allowStructuralEdits` is on; the AI
 * can always query, analyze, highlight, annotate, and export.
 */
export const STRUCTURAL_TOPOLOGY_TOOLS: ReadonlySet<string> = new Set([
  'topology_add_device', 'topology_remove', 'topology_move',
  'topology_add_connection', 'topology_update',
]);

/**
 * Permission effect of each topology tool (see ToolEffect in agentTools).
 * Highlighting only colours the current view; annotations are saved with the
 * topology and an export writes a file, so both count as writes.
 */
export const TOPOLOGY_TOOL_EFFECTS: Readonly<Record<string, 'read' | 'write'>> = {
  topology_query: 'read',
  topology_path: 'read',
  topology_analyze: 'read',
  topology_highlight: 'read',
  topology_add_device: 'write',
  topology_add_connection: 'write',
  topology_update: 'write',
  topology_move: 'write',
  topology_remove: 'write',
  topology_annotate: 'write',
  topology_export: 'write',
};
