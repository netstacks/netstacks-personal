/**
 * Topology History Types
 *
 * Types for undo/redo functionality with AI vs user action tracking.
 */

/**
 * Types of actions that can be tracked in history
 */
export type TopologyActionType =
  | 'add_device'
  | 'remove_device'
  | 'move_device'
  | 'update_device'
  | 'add_connection'
  | 'remove_connection'
  | 'update_connection'
  | 'add_annotation'
  | 'remove_annotation'
  | 'update_annotation'
  | 'bulk'; // for grouped operations

/**
 * Source of the topology modification
 */
export type ActionSource = 'user' | 'ai';

/**
 * A single tracked action in the topology history
 */
export interface TopologyAction {
  /** Unique identifier for this action */
  id: string;
  /** Type of action performed */
  type: TopologyActionType;
  /** When the action occurred */
  timestamp: Date;
  /** Who initiated this action */
  source: ActionSource;
  /** Human-readable description (e.g., "Added device FW-DMZ") */
  description: string;
  /** State data for undo/redo */
  data: {
    /** State before action (for undo) - null for add operations */
    before: unknown;
    /** State after action (for redo) - null for remove operations */
    after: unknown;
    /** Additional context (e.g., topology ID, device ID) */
    context?: {
      topologyId?: string;
      deviceId?: string;
      connectionId?: string;
      annotationId?: string;
    };
  };
}

/**
 * Serializable version of TopologyAction for localStorage
 */
export interface SerializedTopologyAction {
  id: string;
  type: TopologyActionType;
  timestamp: string; // ISO string instead of Date
  source: ActionSource;
  description: string;
  data: {
    before: unknown;
    after: unknown;
    context?: {
      topologyId?: string;
      deviceId?: string;
      connectionId?: string;
      annotationId?: string;
    };
  };
}

/**
 * Complete history state
 */
export interface TopologyHistoryState {
  /** Stack of actions that can be undone */
  undoStack: TopologyAction[];
  /** Stack of actions that can be redone */
  redoStack: TopologyAction[];
}

/**
 * Serializable history state for localStorage
 */
export interface SerializedHistoryState {
  undoStack: SerializedTopologyAction[];
  redoStack: SerializedTopologyAction[];
  savedAt: string;
}

/**
 * Generate a unique action ID
 */
export function generateActionId(): string {
  return `action-${crypto.randomUUID()}`;
}

/**
 * Serialize a TopologyAction for storage
 */
export function serializeAction(action: TopologyAction): SerializedTopologyAction {
  return {
    ...action,
    timestamp: action.timestamp.toISOString(),
  };
}

/**
 * Deserialize a TopologyAction from storage
 */
export function deserializeAction(serialized: SerializedTopologyAction): TopologyAction {
  return {
    ...serialized,
    timestamp: new Date(serialized.timestamp),
  };
}
