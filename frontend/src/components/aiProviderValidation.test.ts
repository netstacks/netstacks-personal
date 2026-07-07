import { describe, it, expect } from 'vitest';
import { providerRequirements } from './aiProviderValidation';

describe('providerRequirements', () => {
  it('blocks set-default without a model', () => {
    const r = providerRequirements({ requiresKey: true, hasKey: true, modelCount: 0, needsBaseUrl: false, hasBaseUrl: false });
    expect(r.canSetDefault).toBe(false);
    expect(r.missing).toContain('at least one model');
  });

  it('blocks save without a required key', () => {
    const r = providerRequirements({ requiresKey: true, hasKey: false, modelCount: 1, needsBaseUrl: false, hasBaseUrl: false });
    expect(r.canSave).toBe(false);
    expect(r.missing).toContain('an API key');
  });

  it('allows a fully-configured keyed provider', () => {
    const r = providerRequirements({ requiresKey: true, hasKey: true, modelCount: 1, needsBaseUrl: false, hasBaseUrl: false });
    expect(r.canSave).toBe(true);
    expect(r.canSetDefault).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('requires base url when needed (ollama/litellm/custom)', () => {
    const r = providerRequirements({ requiresKey: false, hasKey: false, modelCount: 1, needsBaseUrl: true, hasBaseUrl: false });
    expect(r.canSetDefault).toBe(false);
    expect(r.missing).toContain('a base URL');
  });
});
