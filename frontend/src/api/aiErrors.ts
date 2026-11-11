/**
 * Map raw AI backend/provider error strings to short, actionable guidance.
 * Falls back to the original message when nothing matches.
 */
export function friendlyAiError(raw: string): string {
  const msg = (raw || '').trim();
  const lower = msg.toLowerCase();

  // Pass through the backend's already-actionable messages verbatim — they
  // name the exact provider and settings path.
  if (
    lower.includes('no api key') ||
    lower.includes('api key for') ||
    lower.includes('settings → ai →')
  ) {
    return msg;
  }
  if (lower.includes('invalid x-api-key') || (lower.includes('401') && lower.includes('authentication'))) {
    return 'The provider rejected this API key. Verify it in Settings → AI.';
  }
  if (lower.includes('no model configured') || lower.includes('no model selected')) {
    return 'No model selected for this provider. Pick a model in Settings → AI.';
  }
  if (lower.includes('vault is locked')) {
    return 'The vault is locked. Unlock it to use AI features.';
  }
  return msg || 'AI request failed.';
}
