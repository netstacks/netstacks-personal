/**
 * Troubleshooting Session Hook
 *
 * Core hook for managing troubleshooting session lifecycle and data capture.
 * Handles session start/end, entry capture, timeout detection, and state management.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  TroubleshootingSession,
  SessionEntry,
  SessionEntryType,
  TroubleshootingSessionState,
} from '../types/troubleshooting';
import {
  getTroubleshootingSettings,
  TROUBLESHOOTING_SETTINGS_CHANGED,
} from '../api/troubleshootingSettings';

/** Interval for checking session timeout (10 seconds) */
const TIMEOUT_CHECK_INTERVAL = 10000;

/** Callback type for session timeout handler */
export type OnTimeoutCallback = (session: TroubleshootingSession) => void;

/**
 * Return type for useTroubleshootingSession hook
 */
export interface UseTroubleshootingSessionReturn {
  /** Current session or null if inactive */
  session: TroubleshootingSession | null;
  /** Current session state for UI */
  sessionState: TroubleshootingSessionState;
  /** Whether a session is currently active */
  isActive: boolean;
  /** Start a new troubleshooting session */
  startSession: (name: string, terminalIds: string[]) => string;
  /** Add an entry to the current session */
  addEntry: (
    terminalId: string,
    terminalName: string,
    type: SessionEntryType,
    content: string
  ) => void;
  /** Attach a topology snapshot to the session */
  attachTopology: (topologyId: string) => void;
  /** End the session and return the session data */
  endSession: () => TroubleshootingSession | null;
  /** Check if a specific terminal is being captured */
  isCapturing: (terminalId: string) => boolean;
  /** Add terminal IDs to capture */
  addTerminals: (terminalIds: string[]) => void;
  /** Remove terminal IDs from capture */
  removeTerminals: (terminalIds: string[]) => void;
  /** Set the timeout callback handler */
  setOnTimeout: (callback: OnTimeoutCallback) => void;
}

/**
 * Hook for managing troubleshooting session lifecycle
 *
 * @example
 * ```tsx
 * const {
 *   session,
 *   isActive,
 *   startSession,
 *   addEntry,
 *   endSession,
 *   isCapturing,
 * } = useTroubleshootingSession();
 *
 * // Start capturing
 * startSession('Router migration issue', ['term-1', 'term-2']);
 *
 * // Add entries as commands/output occur
 * addEntry('term-1', 'router-01', 'command', 'show ip route');
 *
 * // End and get session data
 * const sessionData = endSession();
 * ```
 */
export function useTroubleshootingSession(): UseTroubleshootingSessionReturn {
  const [session, setSession] = useState<TroubleshootingSession | null>(null);
  const [sessionState, setSessionState] =
    useState<TroubleshootingSessionState>('inactive');

  // Refs for timeout management
  const timeoutRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTimeoutRef = useRef<OnTimeoutCallback | null>(null);
  // Keep a ref to latest session for the interval callback
  const sessionRef = useRef<TroubleshootingSession | null>(null);

  // Sync session ref with state
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  /**
   * Start a new troubleshooting session
   */
  const startSession = useCallback(
    (name: string, terminalIds: string[]): string => {
      const sessionId = `tshoot-${crypto.randomUUID()}`;
      const now = new Date();

      const newSession: TroubleshootingSession = {
        id: sessionId,
        name,
        startTime: now,
        terminalIds: [...terminalIds],
        entries: [],
        lastActivityTime: now,
      };

      setSession(newSession);
      setSessionState('recording');
      return sessionId;
    },
    []
  );

  /**
   * Add an entry to the current session
   */
  const addEntry = useCallback(
    (
      terminalId: string,
      terminalName: string,
      type: SessionEntryType,
      content: string
    ) => {
      setSession((prev) => {
        if (!prev) return prev;

        const entry: SessionEntry = {
          timestamp: new Date(),
          terminalId,
          terminalName,
          type,
          content,
        };

        return {
          ...prev,
          entries: [...prev.entries, entry],
          lastActivityTime: new Date(),
        };
      });
    },
    []
  );

  /**
   * Attach a topology snapshot to the session
   */
  const attachTopology = useCallback((topologyId: string) => {
    setSession((prev) => (prev ? { ...prev, topologyId } : prev));
  }, []);

  /**
   * End the session and return session data
   */
  const endSession = useCallback((): TroubleshootingSession | null => {
    const currentSession = sessionRef.current;
    setSessionState('ending');

    // Clear timeout checker
    if (timeoutRef.current) {
      clearInterval(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Reset state
    setSession(null);
    setSessionState('inactive');

    return currentSession;
  }, []);

  /**
   * Check if a terminal is being captured
   */
  const isCapturing = useCallback(
    (terminalId: string): boolean => {
      return session?.terminalIds.includes(terminalId) ?? false;
    },
    [session?.terminalIds]
  );

  /**
   * Add terminal IDs to capture
   */
  const addTerminals = useCallback((terminalIds: string[]) => {
    setSession((prev) => {
      if (!prev) return prev;

      const existingIds = new Set(prev.terminalIds);
      const newIds = terminalIds.filter((id) => !existingIds.has(id));

      if (newIds.length === 0) return prev;

      return {
        ...prev,
        terminalIds: [...prev.terminalIds, ...newIds],
        lastActivityTime: new Date(),
      };
    });
  }, []);

  /**
   * Remove terminal IDs from capture
   */
  const removeTerminals = useCallback((terminalIds: string[]) => {
    setSession((prev) => {
      if (!prev) return prev;

      const removeSet = new Set(terminalIds);
      const filteredIds = prev.terminalIds.filter((id) => !removeSet.has(id));

      return {
        ...prev,
        terminalIds: filteredIds,
        lastActivityTime: new Date(),
      };
    });
  }, []);

  /**
   * Set the timeout callback handler
   */
  const setOnTimeout = useCallback((callback: OnTimeoutCallback) => {
    onTimeoutRef.current = callback;
  }, []);

  /**
   * Timeout checker effect
   * Monitors session activity and auto-ends on inactivity
   */
  useEffect(() => {
    // Clear existing interval
    if (timeoutRef.current) {
      clearInterval(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Only run when session is active
    if (!session) {
      return;
    }

    // Start timeout checker
    timeoutRef.current = setInterval(() => {
      const currentSession = sessionRef.current;
      if (!currentSession) return;

      const settings = getTroubleshootingSettings();
      const timeoutMs = settings.inactivityTimeout * 60 * 1000;
      const now = Date.now();
      const lastActivity = currentSession.lastActivityTime.getTime();

      if (now - lastActivity > timeoutMs) {
        // Session timed out
        if (settings.autoSaveOnTimeout && onTimeoutRef.current) {
          onTimeoutRef.current(currentSession);
        }

        // End session
        if (timeoutRef.current) {
          clearInterval(timeoutRef.current);
          timeoutRef.current = null;
        }
        setSession(null);
        setSessionState('inactive');
      }
    }, TIMEOUT_CHECK_INTERVAL);

    return () => {
      if (timeoutRef.current) {
        clearInterval(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [session?.id]); // Re-run when session ID changes (new session started)

  /**
   * Listen for settings changes to update timeout behavior
   */
  useEffect(() => {
    const handleSettingsChange = () => {
      // Settings changed - timeout check interval will pick up new values
      // No need to restart the interval, it reads fresh settings each check
    };

    window.addEventListener(
      TROUBLESHOOTING_SETTINGS_CHANGED,
      handleSettingsChange
    );

    return () => {
      window.removeEventListener(
        TROUBLESHOOTING_SETTINGS_CHANGED,
        handleSettingsChange
      );
    };
  }, []);

  return {
    session,
    sessionState,
    isActive: session !== null,
    startSession,
    addEntry,
    attachTopology,
    endSession,
    isCapturing,
    addTerminals,
    removeTerminals,
    setOnTimeout,
  };
}
