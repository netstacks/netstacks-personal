import axios from 'axios';

export interface ParsedApiError {
  status?: number;
  code?: string;
  error?: string;
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function parseApiError(err: unknown): ParsedApiError {
  if (!axios.isAxiosError(err)) {
    return {};
  }
  const data = err.response?.data as Record<string, unknown> | undefined;
  return {
    status: err.response?.status,
    code: extractString(data?.code),
    error: extractString(data?.error),
  };
}

export function isApiErrorCode(err: unknown, code: string): boolean {
  return parseApiError(err).code === code;
}

export function getApiErrorMessage(err: unknown, fallback: string): string {
  return parseApiError(err).error || fallback;
}

/**
 * Drop-in replacement for the inline pattern that used to appear in ~300
 * catch blocks across the frontend:
 *
 *   err instanceof Error ? err.message : 'Unknown error'
 *
 * Exact semantic match by default; pass a second argument to preserve a
 * context-specific fallback string (e.g. 'Delete failed'). Use this in
 * new code instead of repeating the ternary. ESLint rule (B-2) is the
 * companion that prevents the inline form from reappearing.
 */
export function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  // eslint-disable-next-line no-restricted-syntax -- this is the helper the rule directs callers TO; it's the one site that legitimately writes the pattern.
  return err instanceof Error ? err.message : fallback;
}
