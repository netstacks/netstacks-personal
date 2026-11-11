/**
 * useTopologyHistory - Hook for topology undo/redo with AI action tracking
 *
 * Provides complete undo/redo functionality for topology modifications,
 * with distinction between user and AI actions. Supports localStorage
 * persistence for session continuity.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  TopologyAction,
  TopologyActionType,
  TopologyHistoryState,
  SerializedHistoryState,
} from '../types/topologyHistory';
import {
  generateActionId,
  serializeAction,
  deserializeAction,
} from '../types/topologyHistory';

/**
 * Options for the history hook
 */
export interface UseTopologyHistoryOptions {
  /** Topology ID for scoping history */
  topologyId: string;
  /** Maximum number of actions to keep in history (default: 100) */
  maxHistory?: number;
  /** Whether to persist history to localStorage (default: true) */
  persistToStorage?: boolean;
}

/**
 * Return type for the history hook
 */
export interface UseTopologyHistoryReturn {
  /** Whether undo is available */
  canUndo: boolean;
  /** Whether redo is available */
  canRedo: boolean;
  /** Stack of undoable actions */
  undoStack: TopologyAction[];
  /** Stack of redoable actions */
  redoStack: TopologyAction[];
  /** Undo the last action, returns the action that was undone */
  undo: () => TopologyAction | null;
  /** Redo the last undone action, returns the action that was redone */
  redo: () => TopologyAction | null;
  /** Add a new action to history */
  pushAction: (action: Omit<TopologyAction, 'id' | 'timestamp'>) => TopologyAction;
  /** Clear all history */
  clearHistory: () => void;
  /** Undo all recent consecutive AI actions */
  getRecentAIActions: () => TopologyAction[];
  /** Get the last action (for toast notifications) */
  getLastAction: () => TopologyAction | null;
  /** Check if there are any AI actions that can be undone */
  hasUndoableAIActions: boolean;
}

const STORAGE_KEY_PREFIX = 'topology-history-';

/**
 * Hook for managing topology history with undo/redo support
 */
export function useTopologyHistory({
  topologyId,
  maxHistory = 100,
  persistToStorage = true,
}: UseTopologyHistoryOptions): UseTopologyHistoryReturn {
  const [historyState, setHistoryState] = useState<TopologyHistoryState>({
    undoStack: [],
    redoStack: [],
  });

  // Track if we've loaded from storage to avoid overwriting
  const loadedFromStorage = useRef(false);

  // Generate storage key for this topology
  const storageKey = `${STORAGE_KEY_PREFIX}${topologyId}`;

  // Load history from localStorage on mount
  useEffect(() => {
    if (!persistToStorage || !topologyId || loadedFromStorage.current) return;

    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed: SerializedHistoryState = JSON.parse(stored);
        const state: TopologyHistoryState = {
          undoStack: parsed.undoStack.map(deserializeAction),
          redoStack: parsed.redoStack.map(deserializeAction),
        };
        setHistoryState(state);
        loadedFromStorage.current = true;
      }
    } catch (err) {
      console.warn('[useTopologyHistory] Failed to load history from storage:', err);
    }
  }, [topologyId, persistToStorage, storageKey]);

  // Save history to localStorage when it changes
  useEffect(() => {
    if (!persistToStorage || !topologyId) return;

    // Only save if we have history to save
    if (historyState.undoStack.length === 0 && historyState.redoStack.length === 0) {
      // Clear storage if history is empty
      try {
        localStorage.removeItem(storageKey);
      } catch (err) {
        console.warn('[useTopologyHistory] Failed to clear storage:', err);
      }
      return;
    }

    try {
      const serialized: SerializedHistoryState = {
        undoStack: historyState.undoStack.map(serializeAction),
        redoStack: historyState.redoStack.map(serializeAction),
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(storageKey, JSON.stringify(serialized));
    } catch (err) {
      console.warn('[useTopologyHistory] Failed to save history to storage:', err);
    }
  }, [historyState, topologyId, persistToStorage, storageKey]);

  /**
   * Push a new action onto the history stack
   */
  const pushAction = useCallback((
    actionData: Omit<TopologyAction, 'id' | 'timestamp'>
  ): TopologyAction => {
    const action: TopologyAction = {
      ...actionData,
      id: generateActionId(),
      timestamp: new Date(),
    };

    setHistoryState(prev => {
      // Add to undo stack, clear redo stack
      let newUndoStack = [...prev.undoStack, action];

      // Trim to max history size
      if (newUndoStack.length > maxHistory) {
        newUndoStack = newUndoStack.slice(-maxHistory);
      }

      return {
        undoStack: newUndoStack,
        redoStack: [], // Clear redo stack when new action is pushed
      };
    });

    return action;
  }, [maxHistory]);

  /**
   * Undo the last action
   */
  const undo = useCallback((): TopologyAction | null => {
    let undoneAction: TopologyAction | null = null;

    setHistoryState(prev => {
      if (prev.undoStack.length === 0) return prev;

      const newUndoStack = [...prev.undoStack];
      undoneAction = newUndoStack.pop() || null;

      if (!undoneAction) return prev;

      return {
        undoStack: newUndoStack,
        redoStack: [...prev.redoStack, undoneAction],
      };
    });

    return undoneAction;
  }, []);

  /**
   * Redo the last undone action
   */
  const redo = useCallback((): TopologyAction | null => {
    let redoneAction: TopologyAction | null = null;

    setHistoryState(prev => {
      if (prev.redoStack.length === 0) return prev;

      const newRedoStack = [...prev.redoStack];
      redoneAction = newRedoStack.pop() || null;

      if (!redoneAction) return prev;

      return {
        undoStack: [...prev.undoStack, redoneAction],
        redoStack: newRedoStack,
      };
    });

    return redoneAction;
  }, []);

  /**
   * Clear all history
   */
  const clearHistory = useCallback(() => {
    setHistoryState({
      undoStack: [],
      redoStack: [],
    });
    loadedFromStorage.current = false;
  }, []);

  /**
   * Get all recent consecutive AI actions from the top of the undo stack
   */
  const getRecentAIActions = useCallback((): TopologyAction[] => {
    const aiActions: TopologyAction[] = [];

    // Walk backward from the top of the undo stack
    for (let i = historyState.undoStack.length - 1; i >= 0; i--) {
      const action = historyState.undoStack[i];
      if (action.source === 'ai') {
        aiActions.unshift(action);
      } else {
        // Stop at the first non-AI action
        break;
      }
    }

    return aiActions;
  }, [historyState.undoStack]);

  /**
   * Get the last action in the undo stack
   */
  const getLastAction = useCallback((): TopologyAction | null => {
    if (historyState.undoStack.length === 0) return null;
    return historyState.undoStack[historyState.undoStack.length - 1];
  }, [historyState.undoStack]);

  /**
   * Check if there are any AI actions in the undo stack
   */
  const hasUndoableAIActions = historyState.undoStack.some(a => a.source === 'ai');

  return {
    canUndo: historyState.undoStack.length > 0,
    canRedo: historyState.redoStack.length > 0,
    undoStack: historyState.undoStack,
    redoStack: historyState.redoStack,
    undo,
    redo,
    pushAction,
    clearHistory,
    getRecentAIActions,
    getLastAction,
    hasUndoableAIActions,
  };
}

/**
 * Helper to create action descriptions
 */
export function createActionDescription(
  type: TopologyActionType,
  entityName?: string
): string {
  const name = entityName || 'item';

  switch (type) {
    case 'add_device':
      return `Added device ${name}`;
    case 'remove_device':
      return `Removed device ${name}`;
    case 'move_device':
      return `Moved device ${name}`;
    case 'update_device':
      return `Updated device ${name}`;
    case 'add_connection':
      return `Added connection ${name}`;
    case 'remove_connection':
      return `Removed connection ${name}`;
    case 'update_connection':
      return `Updated connection ${name}`;
    case 'add_annotation':
      return `Added annotation ${name}`;
    case 'remove_annotation':
      return `Removed annotation ${name}`;
    case 'update_annotation':
      return `Updated annotation ${name}`;
    case 'bulk':
      return `Bulk operation: ${name}`;
    default:
      return `Modified ${name}`;
  }
}
