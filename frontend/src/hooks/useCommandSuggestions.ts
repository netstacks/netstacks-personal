import { useState, useCallback, useRef } from 'react';
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

export function useCommandSuggestions(options: UseCommandSuggestionsOptions = {}) {
  const { debounceMs = 300, minChars = 2 } = options;
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (
    partial: string,
    context: AiContext
  ) => {
    // Clear previous timeout
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    // Don't fetch for short inputs
    if (partial.length < minChars) {
      setSuggestions([]);
      return;
    }

    // Debounce
    timeoutRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const recentOutput = context.terminal?.recentOutput || '';
        const lines = recentOutput.split('\n').slice(-30);
        const cliFlavor = context.cliFlavor || 'auto';

        // Build CLI type instruction based on configured flavor
        let cliInstruction: string;
        if (cliFlavor === 'auto') {
          cliInstruction = 'Based on the terminal output, determine if this is Linux/Unix shell or network device CLI.';
        } else if (cliFlavor === 'linux') {
          cliInstruction = 'This is a Linux/Unix bash shell. Suggest Linux commands only.';
        } else {
          const flavorNames: Record<string, string> = {
            'cisco-ios': 'Cisco IOS/IOS-XE',
            'cisco-ios-xr': 'Cisco IOS-XR',
            'cisco-nxos': 'Cisco NX-OS',
            'juniper': 'Juniper Junos',
            'arista': 'Arista EOS',
            'paloalto': 'Palo Alto PAN-OS',
            'fortinet': 'Fortinet FortiOS',
          };
          cliInstruction = `This is a ${flavorNames[cliFlavor] || cliFlavor} network device. Suggest appropriate CLI commands for this platform.`;
        }

        const prompt = `Complete this command: "${partial}"

Recent terminal session:
${lines.join('\n')}

${cliInstruction}
Return JSON: [{"command": "...", "description": "..."}]
Command MUST start exactly with "${partial}".`;


        const { provider, model } = resolveProvider('suggestions');
        const response = await sendChatMessage(
          [{ role: 'user', content: prompt }],
          { context, provider, model }
        );

        // Parse JSON from response
        const match = response.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          setSuggestions(parsed);
        }
      } catch (err) {
        if (!(err instanceof AiNotConfiguredError)) {
          console.warn('Autocomplete failed:', err);
        }
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    }, debounceMs);
  }, [debounceMs, minChars]);

  const clear = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setSuggestions([]);
  }, []);

  return { suggestions, isLoading, fetchSuggestions, clear };
}
