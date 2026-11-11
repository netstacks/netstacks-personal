import { useState, useCallback, useRef, useEffect } from 'react';
import { sendChatMessage, AiNotConfiguredError } from '../api/ai';
import type { AiContext } from '../api/ai';
import { resolveProvider } from '../lib/aiProviderResolver';

interface Suggestion {
  command: string;
  description?: string;
}

interface UseCommandSuggestionsOptions {
  debounceMs?: number;
  minChars?: number;
}

const FLAVOR_NAMES: Record<string, string> = {
  'cisco-ios': 'Cisco IOS/IOS-XE',
  'cisco-ios-xr': 'Cisco IOS-XR',
  'cisco-nxos': 'Cisco NX-OS',
  'juniper': 'Juniper Junos',
  'arista': 'Arista EOS',
  'paloalto': 'Palo Alto PAN-OS',
  'fortinet': 'Fortinet FortiOS',
};

function buildCliInstruction(cliFlavor: string): string {
  if (cliFlavor === 'auto') {
    return 'Based on the terminal output, determine if this is Linux/Unix shell or network device CLI.';
  }
  if (cliFlavor === 'linux') {
    return 'This is a Linux/Unix bash shell. Suggest Linux commands only.';
  }
  return `This is a ${FLAVOR_NAMES[cliFlavor] || cliFlavor} network device. Suggest appropriate CLI commands for this platform.`;
}

function parseSuggestions(response: string): Suggestion[] | null {
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) return null;
  const parsed: unknown = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (s): s is Suggestion => !!s && typeof s === 'object' && typeof (s as Suggestion).command === 'string',
  );
}

export function useCommandSuggestions(options: UseCommandSuggestionsOptions = {}) {
  const { debounceMs = 300, minChars = 2 } = options;
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counter: every fetch/clear bumps it so a response from an
  // older request can never overwrite newer state.
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // The most recent input the caller told us about ('' after clear()).
  const latestInputRef = useRef('');

  const cancelPending = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => () => {
    generationRef.current += 1;
    cancelPending();
  }, [cancelPending]);

  const fetchSuggestions = useCallback(async (
    partial: string,
    context: AiContext
  ) => {
    const generation = ++generationRef.current;
    latestInputRef.current = partial;
    cancelPending();

    // Don't fetch for short inputs
    if (partial.length < minChars) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    // Debounce
    timeoutRef.current = setTimeout(async () => {
      timeoutRef.current = null;
      if (generation !== generationRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      try {
        const cliInstruction = buildCliInstruction(context.cliFlavor || 'auto');

        // Recent terminal output is supplied once via the AiContext (backend
        // system prompt); don't embed it here too.
        const prompt = `Complete this command: "${partial}"

${cliInstruction}
Return JSON: [{"command": "...", "description": "..."}]
Command MUST start exactly with "${partial}".`;

        const { provider, model } = resolveProvider('suggestions');
        const response = await sendChatMessage(
          [{ role: 'user', content: prompt }],
          { context, provider, model, signal: controller.signal }
        );

        // Stale: a newer fetch or clear() happened while we were waiting.
        if (generation !== generationRef.current || controller.signal.aborted) return;
        // The user may have kept typing; only accept completions that
        // still match what is on the line now.
        const current = latestInputRef.current;
        if (!current.startsWith(partial)) return;

        const parsed = parseSuggestions(response);
        if (parsed) {
          setSuggestions(parsed.filter((s) => s.command.startsWith(current)));
        }
      } catch (err) {
        if (generation !== generationRef.current) return;
        if (!(err instanceof AiNotConfiguredError)) {
          console.warn('Autocomplete failed:', err);
        }
        setSuggestions([]);
      } finally {
        if (generation === generationRef.current) {
          setIsLoading(false);
          abortRef.current = null;
        }
      }
    }, debounceMs);
  }, [debounceMs, minChars, cancelPending]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    latestInputRef.current = '';
    cancelPending();
    setSuggestions([]);
    setIsLoading(false);
  }, [cancelPending]);

  return { suggestions, isLoading, fetchSuggestions, clear };
}
