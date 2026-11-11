/**
 * useNextStepSuggestions - AI-powered contextual next-step suggestions
 *
 * This hook generates suggestions for logical next commands based on
 * the last executed command and its output. It debounces requests
 * and provides category-based organization of suggestions.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { sendChatMessage, AiNotConfiguredError } from '../api/ai';
import type { AiContext } from '../api/ai';
import { resolveProvider } from '../lib/aiProviderResolver';

export interface NextStepSuggestion {
  command: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  category: 'verification' | 'related' | 'troubleshoot' | 'documentation';
}

interface UseNextStepSuggestionsOptions {
  enabled?: boolean;
  maxSuggestions?: number;
  debounceMs?: number;
}

interface UseNextStepSuggestionsReturn {
  suggestions: NextStepSuggestion[];
  loading: boolean;
  generateSuggestions: (lastCommand: string, context?: AiContext) => void;
  clearSuggestions: () => void;
  useSuggestion: (command: string) => void;
  setSuggestionCallback: (callback: (command: string) => void) => void;
}

export function useNextStepSuggestions({
  enabled = true,
  maxSuggestions = 3,
  debounceMs = 500,
}: UseNextStepSuggestionsOptions = {}): UseNextStepSuggestionsReturn {
  const [suggestions, setSuggestions] = useState<NextStepSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef<((command: string) => void) | null>(null);
  const mountedRef = useRef(true);
  // Generation counter: bumped by every generate/clear so a late response
  // from an older command can't overwrite newer suggestions.
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancelPending = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Track mount status and clean up timeout/in-flight request on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      cancelPending();
    };
  }, [cancelPending]);

  const generateSuggestions = useCallback((
    lastCommand: string,
    context?: AiContext
  ) => {
    if (!enabled) return;

    // Don't generate suggestions for empty commands
    if (!lastCommand.trim()) return;

    const generation = ++generationRef.current;
    cancelPending();
    const isCurrent = () => mountedRef.current && generation === generationRef.current;

    // Debounce the AI call
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      if (!isCurrent()) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      try {
        // Device identity (hostname/vendor/platform/CLI flavor) and the recent
        // terminal output are supplied via the AiContext (backend system
        // prompt), so the prompt only needs to name the command that just ran.
        const prompt = `Based on the last network command and the current terminal output, suggest ${maxSuggestions} logical next commands.

Command: ${lastCommand}

Return ONLY a JSON array with this structure (no markdown, no explanation):
[
  {
    "command": "the exact command to run",
    "description": "brief explanation of why",
    "confidence": "high|medium|low",
    "category": "verification|related|troubleshoot|documentation"
  }
]

Categories:
- verification: Verify the result of what was just done
- related: Explore related information
- troubleshoot: Diagnose potential issues seen in output
- documentation: View config or save output`;

        const { provider, model } = resolveProvider('nextStep');
        const response = await sendChatMessage([
          { role: 'user', content: prompt }
        ], { context, provider, model, signal: controller.signal });

        if (!isCurrent() || controller.signal.aborted) return;

        // Parse JSON from response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) {
              setSuggestions([]);
            } else {
              // Validate and sanitize suggestions
              const validSuggestions = (parsed as NextStepSuggestion[])
                .filter(s => s.command && s.description && s.confidence && s.category)
                .slice(0, maxSuggestions);
              setSuggestions(validSuggestions);
            }
          } catch {
            setSuggestions([]);
          }
        }
      } catch (error) {
        if (!isCurrent()) return;
        // Silently fail for AI not configured - user hasn't set up AI
        if (!(error instanceof AiNotConfiguredError)) {
          console.error('[NextStepSuggestions] Failed to generate:', error);
        }
        setSuggestions([]);
      } finally {
        if (isCurrent()) {
          setLoading(false);
          abortRef.current = null;
        }
      }
    }, debounceMs);
  }, [enabled, maxSuggestions, debounceMs, cancelPending]);

  const clearSuggestions = useCallback(() => {
    generationRef.current += 1;
    cancelPending();
    setSuggestions([]);
    setLoading(false);
  }, [cancelPending]);

  const useSuggestion = useCallback((command: string) => {
    if (callbackRef.current) {
      callbackRef.current(command);
    }
    clearSuggestions();
  }, [clearSuggestions]);

  const setSuggestionCallback = useCallback((callback: (command: string) => void) => {
    callbackRef.current = callback;
  }, []);

  return {
    suggestions,
    loading,
    generateSuggestions,
    clearSuggestions,
    useSuggestion,
    setSuggestionCallback,
  };
}
