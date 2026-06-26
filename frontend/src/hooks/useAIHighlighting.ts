import { getErrorMessage } from '../api/errors'
/**
 * Hook for AI-powered semantic highlighting in terminals
 *
 * Analyzes terminal output using AI to detect errors, security issues,
 * and anomalies. Activated only when Overlord mode is enabled.
 *
 * Flow: buffer output -> debounce -> call API for all 3 modes -> merge results
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  analyzeHighlights,
  type AIHighlight,
  type AIHighlightMode,
} from '../api/ai';
import { stripAnsi } from '../lib/ansi';

/** Options for the useAIHighlighting hook */
export interface UseAIHighlightingOptions {
  /** Enable/disable AI highlighting (tied to Overlord toggle) */
  enabled?: boolean;
  /** CLI flavor for context (e.g., "cisco-ios", "linux") */
  cliFlavor?: string;
  /** Debounce interval in ms (default: 2000) */
  debounceMs?: number;
  /** Optional provider override for Overlord analysis */
  provider?: string | null;
  /** Optional model override for Overlord analysis */
  model?: string | null;
}

/** Return value from the hook */
export interface UseAIHighlightingResult {
  /** Current AI-detected highlights */
  highlights: AIHighlight[];
  /** Whether analysis is currently running */
  isAnalyzing: boolean;
  /** Any error that occurred */
  error: string | null;
  /** Add output for analysis */
  addOutput: (output: string) => void;
  /** Force immediate analysis */
  analyzeNow: () => Promise<void>;
  /** Clear all highlights */
  clear: () => void;
}

/** Simple hash function for dedup */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/** All three analysis modes, always run together */
const ALL_MODES: AIHighlightMode[] = ['errors', 'security', 'anomalies'];

/**
 * Hook for AI-powered semantic highlighting.
 * Only active when Overlord is enabled — uses the default configured AI provider.
 */
export function useAIHighlighting(
  options: UseAIHighlightingOptions = {}
): UseAIHighlightingResult {
  const {
    enabled = false,
    cliFlavor,
    debounceMs = 2000,
    provider,
    model,
  } = options;

  const [highlights, setHighlights] = useState<AIHighlight[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs for values that callbacks need to read at call-time
  // to avoid stale closure issues with useCallback
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const modelRef = useRef(model);
  modelRef.current = model;
  const cliFlavorRef = useRef(cliFlavor);
  cliFlavorRef.current = cliFlavor;

  const outputBufferRef = useRef<string>('');
  const debounceTimerRef = useRef<number | null>(null);
  const lastAnalyzedHashRef = useRef<string>('');
  const isMountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Track mounted state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  // Analyze a single mode — uses refs to avoid stale closures
  const analyzeMode = useCallback(
    async (output: string, mode: AIHighlightMode, signal: AbortSignal): Promise<AIHighlight[]> => {
      try {
        const result = await analyzeHighlights(output, mode, cliFlavorRef.current, providerRef.current, modelRef.current, signal);
        return result;
      } catch (err) {
        if (err instanceof Error && err.message === 'canceled') return [];
        console.warn(`[Overlord] AI highlight analysis failed for mode ${mode}:`, err);
        return [];
      }
    },
    []
  );

  // Perform full analysis across all 3 modes
  const performAnalysis = useCallback(async () => {
    if (!enabledRef.current || inFlightRef.current) return;

    const output = outputBufferRef.current;
    if (!output.trim()) {
      return;
    }

    const outputHash = hashString(output);
    if (outputHash === lastAnalyzedHashRef.current) {
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    inFlightRef.current = true;
    setIsAnalyzing(true);
    setError(null);

    try {
      const results = await Promise.all(
        ALL_MODES.map((mode) => analyzeMode(output, mode, controller.signal))
      );

      if (!isMountedRef.current || controller.signal.aborted) return;

      const allHighlights = results.flat();

      // Deduplicate by line and text
      const seen = new Set<string>();
      const deduplicated = allHighlights.filter((h) => {
        const key = `${h.line}:${h.start}:${h.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      deduplicated.sort((a, b) => {
        if (a.line !== b.line) return a.line - b.line;
        return b.confidence - a.confidence;
      });

      setHighlights(deduplicated);
      lastAnalyzedHashRef.current = outputHash;
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(getErrorMessage(err, 'Analysis failed'));
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) {
        setIsAnalyzing(false);
      }
    }
  }, [analyzeMode]);

  // Use ref to always call the latest performAnalysis
  const performAnalysisRef = useRef(performAnalysis);
  performAnalysisRef.current = performAnalysis;

  const addOutput = useCallback(
    (output: string) => {
      if (!enabledRef.current) return;

      // Strip ANSI escape codes before buffering
      const cleanOutput = stripAnsi(output);
      outputBufferRef.current += cleanOutput;
      if (outputBufferRef.current.length > 10000) {
        outputBufferRef.current = outputBufferRef.current.slice(-10000);
      }

      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        performAnalysisRef.current();
      }, debounceMs);
    },
    [debounceMs]
  );

  const analyzeNow = useCallback(async () => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    await performAnalysis();
  }, [performAnalysis]);

  const clear = useCallback(() => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    abortControllerRef.current?.abort();
    outputBufferRef.current = '';
    lastAnalyzedHashRef.current = '';
    setHighlights([]);
    setError(null);
    setIsAnalyzing(false);
  }, []);

  return useMemo(
    () => ({
      highlights,
      isAnalyzing,
      error,
      addOutput,
      analyzeNow,
      clear,
    }),
    [highlights, isAnalyzing, error, addOutput, analyzeNow, clear]
  );
}
