// Helpers for parsing AI-generated JSON responses without trusting shape.
//
// AI models hallucinate. A "return a JSON array of {command, description}"
// prompt has zero guarantees — the model can return [{"foo": "bar"}], a
// bare object, an array of strings, or apologize and return prose. The
// caller still does `parsed.command.toLowerCase()` and crashes.
//
// These helpers validate the parsed shape and return null on mismatch so
// the caller can surface a clean "AI returned an unexpected response, try
// again" instead of an opaque TypeError. The audit (P4-4) flagged ~8
// sites that JSON.parse'd AI output blindly.

/**
 * Parse `json` and validate it's a non-empty array of objects each having
 * the listed string-valued required keys. Returns null on any failure.
 */
export function parseAiCommandArray(
  json: string,
  requiredKeys: string[] = ['command'],
): Array<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return null;
      for (const key of requiredKeys) {
        const v = (item as Record<string, unknown>)[key];
        if (typeof v !== 'string' || v.length === 0) return null;
      }
    }
    return parsed as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

/**
 * Parse `json` and validate it's an array of strings. Returns null on
 * any failure, including a mix of strings and non-strings.
 */
export function parseAiStringArray(json: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every(s => typeof s === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/**
 * Parse `json` and validate it's an object with the listed required
 * string-valued keys. Returns null on any failure.
 */
export function parseAiObject<T extends Record<string, unknown>>(
  json: string,
  requiredStringKeys: string[],
): T | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const key of requiredStringKeys) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v !== 'string' || v.length === 0) return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}
