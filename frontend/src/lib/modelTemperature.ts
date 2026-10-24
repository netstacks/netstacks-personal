/**
 * Claude models that reject a custom `temperature` (the API returns 400), so
 * the agent omits it for them: Opus 4.7 and later, Opus 5+, Sonnet 5+ and
 * Fable. Matches bare ids (`claude-opus-4-7`), dated/suffixed ids and
 * provider-prefixed ids (`us.anthropic.claude-sonnet-5…`, `anthropic/claude-…`).
 */
export function claudeIgnoresTemperature(model: string | null | undefined): boolean {
  const id = (model ?? '').toLowerCase();
  if (!id) return false;
  if (/(^|[^a-z])fable([^a-z]|$)/.test(id)) return true;
  const opus = id.match(/opus[-.]?(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/);
  if (opus) {
    const major = Number(opus[1]);
    const minor = opus[2] !== undefined ? Number(opus[2]) : 0;
    return major >= 5 || (major === 4 && minor >= 7);
  }
  const sonnet = id.match(/sonnet[-.]?(\d{1,2})(?!\d)/);
  return !!sonnet && Number(sonnet[1]) >= 5;
}

/** Form hint shown under temperature inputs. */
export const TEMPERATURE_IGNORED_NOTE =
  'Ignored for Claude models that don’t support it (Opus 4.7 and later, Opus 5, Sonnet 5, Fable).';
