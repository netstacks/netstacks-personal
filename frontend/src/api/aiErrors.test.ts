import { describe, it, expect } from 'vitest';
import { friendlyAiError } from './aiErrors';

describe('friendlyAiError', () => {
  it('maps invalid x-api-key', () => {
    expect(friendlyAiError('API request failed: HTTP 401 Unauthorized: invalid x-api-key'))
      .toMatch(/rejected this API key/i);
  });

  it('maps no model configured', () => {
    expect(friendlyAiError('No model configured for anthropic. Choose a model in Settings > AI.'))
      .toMatch(/pick a model/i);
  });

  it('passes through an already-clear message', () => {
    const msg = 'No API key saved for openrouter. Add one in Settings → AI → openrouter.';
    expect(friendlyAiError(msg)).toBe(msg);
  });
});
