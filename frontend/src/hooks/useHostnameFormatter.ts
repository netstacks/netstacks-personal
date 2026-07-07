import { useMemo, useCallback } from 'react';
import { useSettings, getSettings } from './useSettings';
import { stripHostname, compileStripPatterns } from '../lib/hostnameStrip';

/**
 * Reactive hook that returns a stable hostname formatter function.
 * Reads `hostname.stripEnabled` and `hostname.stripPatterns` from settings,
 * compiles the patterns, and returns a memoized callback that applies stripping.
 * @returns A stable formatter function: (name: string) => string
 */
export function useHostnameFormatter(): (name: string) => string {
  const { settings } = useSettings();

  // Guard against undefined settings
  const enabled = settings['hostname.stripEnabled'] ?? false;
  const patterns = settings['hostname.stripPatterns'] ?? [];

  // Memoize compiled RegExp array keyed on enabled + patterns joined
  const compiledRegexps = useMemo(() => {
    const { valid } = compileStripPatterns(patterns);
    return valid;
  }, [enabled, patterns.join('\n')]);

  // Return stable callback
  return useCallback(
    (name: string) => stripHostname(name, compiledRegexps, enabled),
    [compiledRegexps, enabled]
  );
}

/**
 * Imperative (non-React) hostname formatter for canvas/non-hook callers.
 * Reads current settings and applies stripping logic.
 * @param name - The hostname to format
 * @returns Formatted hostname
 */
export function formatHostname(name: string): string {
  const settings = getSettings();
  const enabled = settings['hostname.stripEnabled'] ?? false;
  const patterns = settings['hostname.stripPatterns'] ?? [];
  return stripHostname(name, patterns, enabled);
}
