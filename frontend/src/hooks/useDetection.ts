/**
 * useDetection Hook - React integration for DetectionEngine
 *
 * Provides React-friendly API for consuming network identifier detections
 * in terminal output. Powers context menus and other interactive features.
 *
 * This hook is a pure metadata provider — it does NOT create decorations.
 * Decoration management is handled by the HighlightEngine which merges
 * detection underlines with user highlight colors into single decorations.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Terminal } from '@xterm/xterm';
import { DetectionEngine } from '../lib/detectionEngine';
import type { Detection, DetectionType } from '../types/detection';

/**
 * Options for the useDetection hook
 */
interface UseDetectionOptions {
  /** Debounce interval for rescans in milliseconds (default: 100) */
  debounceMs?: number;
  /** Enable automatic rescanning on terminal events (default: true) */
  autoRescan?: boolean;
}

/**
 * Return type for the useDetection hook
 */
interface UseDetectionResult {
  /** Current detections from the visible buffer */
  detections: Detection[];
  /** Get detection at a specific position (line, column) */
  getDetectionAt: (line: number, column: number) => Detection | null;
  /** Get all detections of a specific type */
  getDetectionsOfType: (type: DetectionType) => Detection[];
  /** Force a rescan of the visible buffer */
  rescan: () => void;
  /** Whether the engine is currently scanning */
  isScanning: boolean;
  /** Register custom regex patterns for detection (call with empty array to clear) */
  setCustomRegexPatterns: (patterns: { typeKey: string; pattern: string; name: string }[]) => void;
}

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Hook for consuming network identifier detections in terminal output.
 * Pure metadata provider — no decoration management.
 *
 * @param terminal - The xterm.js Terminal instance (or null if not ready)
 * @param options - Configuration options
 * @returns Detection state and helper functions
 *
 * @example
 * ```tsx
 * const { getDetectionAt } = useDetection(terminal);
 *
 * // Handle right-click to get detection under cursor
 * const detection = getDetectionAt(clickLine, clickColumn);
 * if (detection) {
 *   showContextMenu(detection);
 * }
 * ```
 */
export function useDetection(
  terminal: Terminal | null,
  options: UseDetectionOptions = {}
): UseDetectionResult {
  const { debounceMs = DEFAULT_DEBOUNCE_MS, autoRescan = true } = options;

  // Detection state
  const [detections, setDetections] = useState<Detection[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  // Refs for cleanup and debouncing
  const engineRef = useRef<DetectionEngine | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  // Create/destroy engine when terminal changes
  useEffect(() => {
    mountedRef.current = true;

    if (!terminal) {
      // Clean up existing engine
      if (engineRef.current) {
        engineRef.current.dispose();
        engineRef.current = null;
      }
      setDetections([]);
      return;
    }

    // Create new engine
    engineRef.current = new DetectionEngine(terminal);

    // Initial scan
    const initialDetections = engineRef.current.scanBuffer();
    if (mountedRef.current) {
      setDetections(initialDetections);
    }

    return () => {
      mountedRef.current = false;
      if (engineRef.current) {
        engineRef.current.dispose();
        engineRef.current = null;
      }
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [terminal]);

  // Debounced rescan function
  const debouncedRescan = useCallback(() => {
    if (!engineRef.current || !mountedRef.current || !terminal) return;

    // Clear any pending rescan
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    setIsScanning(true);

    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;

      if (!engineRef.current || !mountedRef.current || !terminal) {
        setIsScanning(false);
        return;
      }

      const newDetections = engineRef.current.scanBuffer();
      if (mountedRef.current) {
        setDetections(newDetections);
        setIsScanning(false);
      }
    }, debounceMs);
  }, [debounceMs, terminal]);

  // Manual rescan function (immediate, not debounced)
  const rescan = useCallback(() => {
    if (!engineRef.current || !mountedRef.current || !terminal) return;

    // Clear any pending debounced rescan
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    setIsScanning(true);
    const newDetections = engineRef.current.scanBuffer();
    if (mountedRef.current) {
      setDetections(newDetections);
      setIsScanning(false);
    }
  }, [terminal]);

  // Auto-rescan on terminal events (for metadata updates — decoration scan is handled by HighlightEngine)
  useEffect(() => {
    if (!terminal || !autoRescan) return;

    // Listen to data events (new output)
    const dataDisposable = terminal.onData(() => {
      debouncedRescan();
    });

    // Listen to scroll events
    const scrollDisposable = terminal.onScroll(() => {
      debouncedRescan();
    });

    // Listen to line feed events if available
    const lineFeedDisposable = terminal.onLineFeed?.(() => {
      debouncedRescan();
    });

    return () => {
      dataDisposable.dispose();
      scrollDisposable.dispose();
      lineFeedDisposable?.dispose();
    };
  }, [terminal, autoRescan, debouncedRescan]);

  // Get detection at a specific position
  const getDetectionAt = useCallback(
    (line: number, column: number): Detection | null => {
      for (const detection of detections) {
        if (
          detection.line === line &&
          column >= detection.startColumn &&
          column < detection.endColumn
        ) {
          return detection;
        }
      }
      return null;
    },
    [detections]
  );

  // Get all detections of a specific type
  const getDetectionsOfType = useCallback(
    (type: DetectionType): Detection[] => {
      return detections.filter((d) => d.type === type);
    },
    [detections]
  );

  // Register/clear custom regex patterns on the engine
  const setCustomRegexPatterns = useCallback(
    (patterns: { typeKey: string; pattern: string; name: string }[]) => {
      if (!engineRef.current) return;
      engineRef.current.clearCustomRegex();
      for (const p of patterns) {
        engineRef.current.addCustomRegex(p.typeKey, p.pattern, p.name);
      }
      // Rescan after registering new patterns
      const newDetections = engineRef.current.scanBuffer();
      if (mountedRef.current) {
        setDetections(newDetections);
      }
    },
    []
  );

  // Memoize the result to avoid unnecessary re-renders
  const result = useMemo(
    (): UseDetectionResult => ({
      detections,
      getDetectionAt,
      getDetectionsOfType,
      rescan,
      isScanning,
      setCustomRegexPatterns,
    }),
    [detections, getDetectionAt, getDetectionsOfType, rescan, isScanning, setCustomRegexPatterns]
  );

  return result;
}
