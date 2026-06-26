/**
 * useAITabComplete — Windmill-style Tab-to-autocomplete for text inputs/textareas.
 *
 * When a text input is empty and focused, shows a "TAB ✨" hint.
 * Pressing Tab triggers AI to generate a smart suggestion based on:
 *   - The field's label/placeholder
 *   - Other filled fields in the same form
 *   - The current page context
 *
 * Usage:
 *   const tabComplete = useAITabComplete();
 *
 *   <input
 *     {...tabComplete.bind('description', 'Describe the purpose...', { name: formName })}
 *     value={value}
 *     onChange={...}
 *   />
 *
 * Or for controlled integration:
 *   <div className="ai-tab-field">
 *     <input ... onKeyDown={tabComplete.handleKeyDown} onFocus={...} onBlur={...} />
 *     {tabComplete.showHint && <span className="ai-tab-hint">TAB ✨</span>}
 *   </div>
 */

import { useState, useCallback, useRef } from 'react';
import { sendChatMessage } from '../api/ai';

interface AITabCompleteState {
  activeField: string | null;
  loading: boolean;
  suggestion: string | null;
}

export interface UseAITabCompleteReturn {
  /** Bind to an input — returns onKeyDown, onFocus, onBlur props */
  bind: (
    fieldName: string,
    placeholder: string,
    context?: Record<string, unknown>,
    onAccept?: (value: string) => void,
  ) => {
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
    'data-ai-tab': string;
  };
  /** Whether to show the TAB hint for a given field */
  isHintVisible: (fieldName: string, value: string) => boolean;
  /** Whether AI is generating for a field */
  isLoading: (fieldName: string) => boolean;
  /** Currently active field name */
  activeField: string | null;
}

export function useAITabComplete(): UseAITabCompleteReturn {
  const [state, setState] = useState<AITabCompleteState>({
    activeField: null,
    loading: false,
    suggestion: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  const generateForField = useCallback(async (
    fieldName: string,
    placeholder: string,
    context: Record<string, unknown>,
    onAccept: (value: string) => void,
  ) => {
    // Abort any in-flight request
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState(prev => ({ ...prev, loading: true }));

    try {
      // Build a contextual prompt from the field name, placeholder, and form context
      const contextEntries = Object.entries(context)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `  ${k}: ${String(v)}`)
        .join('\n');

      const prompt = `You are filling out a form field in a network operations tool.

Field name: "${fieldName}"
${placeholder ? `Placeholder hint: "${placeholder}"` : ''}
${contextEntries ? `\nOther fields already filled:\n${contextEntries}` : ''}

Generate a smart, concise value for this field. Respond with ONLY the value — no quotes, no explanation, no commentary. Just the raw text that should go in the field.

For descriptions: write 1-2 sentences relevant to network operations.
For names: use professional naming conventions (e.g., "PE1-NYC Loopback Config").
For commands: use real network CLI commands.
For tags: use comma-separated relevant tags.
For tickets: use a realistic format like "CHG-2026-0409".`;

      const response = await sendChatMessage(
        [{ role: 'user', content: prompt }],
        { signal: abort.signal },
      );

      if (abort.signal.aborted) return;

      const value = response.trim();
      if (value) {
        onAccept(value);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error('AI Tab Complete failed:', err);
    } finally {
      if (!abort.signal.aborted) {
        setState(prev => ({ ...prev, loading: false }));
      }
    }
  }, []);

  const bind = useCallback((
    fieldName: string,
    placeholder: string,
    context?: Record<string, unknown>,
    onAccept?: (value: string) => void,
  ) => {
    return {
      'data-ai-tab': fieldName,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === 'Tab' && !e.shiftKey) {
          const target = e.currentTarget;
          const isEmpty = !target.value.trim();
          if (isEmpty && onAccept) {
            e.preventDefault();
            generateForField(fieldName, placeholder, context || {}, onAccept);
          }
        }
      },
      onFocus: () => {
        setState(prev => ({ ...prev, activeField: fieldName }));
      },
      onBlur: () => {
        setState(prev => prev.activeField === fieldName ? { ...prev, activeField: null } : prev);
      },
    };
  }, [generateForField]);

  const isHintVisible = useCallback((fieldName: string, value: string) => {
    return state.activeField === fieldName && !value.trim() && !state.loading;
  }, [state.activeField, state.loading]);

  const isLoading = useCallback((fieldName: string) => {
    return state.loading && state.activeField === fieldName;
  }, [state.loading, state.activeField]);

  return {
    bind,
    isHintVisible,
    isLoading,
    activeField: state.activeField,
  };
}
