import { describe, it, expect, beforeEach } from 'vitest';
import { resolveProvider } from '../aiProviderResolver';
import { getSettings, setGlobalSettings, type AppSettings } from '../../hooks/useSettings';

const baseline: AppSettings = getSettings();

function withSettings(overrides: Partial<AppSettings>): void {
  setGlobalSettings({ ...baseline, ...overrides });
}

describe('resolveProvider — custom provider model resolution', () => {
  beforeEach(() => {
    setGlobalSettings({ ...baseline });
  });

  it('returns empty model for custom provider when ai.models.custom is empty', () => {
    // Repro: defaultProvider=custom + empty model list previously returned the
    // literal string "custom", which gets baked into Vertex URLs as
    // ".../custom:generateContent" → Google 404 "Requested entity was not found".
    withSettings({
      'ai.defaultProvider': 'custom',
      'ai.enabledProviders': ['custom'],
      'ai.models.custom': [],
    });

    const { provider, model } = resolveProvider();
    expect(provider).toBe('custom');
    expect(model).not.toBe('custom');
    expect(model).toBe('');
  });

  it('returns the first configured model when ai.models.custom has entries', () => {
    withSettings({
      'ai.defaultProvider': 'custom',
      'ai.enabledProviders': ['custom'],
      'ai.models.custom': ['gemini-2.0-flash-exp'],
    });

    const { model } = resolveProvider();
    expect(model).toBe('gemini-2.0-flash-exp');
  });

  it('returns empty model (no hardcoded default) when provider has no model list', () => {
    // Model must come from settings only — never a hardcoded literal. An empty
    // model means callers omit it and the backend uses the user's saved config.
    withSettings({
      'ai.defaultProvider': 'anthropic',
      'ai.enabledProviders': ['anthropic'],
      'ai.models.anthropic': [],
    });

    const { provider, model } = resolveProvider();
    expect(provider).toBe('anthropic');
    expect(model).toBe('');
  });

  it('returns the user-configured model when ai.models.<provider> has entries', () => {
    withSettings({
      'ai.defaultProvider': 'anthropic',
      'ai.enabledProviders': ['anthropic'],
      'ai.models.anthropic': ['claude-sonnet-4-20250514'],
    });

    const { model } = resolveProvider();
    expect(model).toBe('claude-sonnet-4-20250514');
  });

  it('agent feature with provider mismatch falls back to enabled provider with empty model for custom', () => {
    // User had ai.agent.provider='anthropic' but enabledProviders=['custom'].
    // Should fall back to 'custom' and not return literal 'custom' as model.
    withSettings({
      'ai.defaultProvider': 'custom',
      'ai.enabledProviders': ['custom'],
      'ai.models.custom': [],
      'ai.agent.provider': 'anthropic',
      'ai.agent.model': null,
    });

    const { provider, model } = resolveProvider('agent');
    expect(provider).toBe('custom');
    expect(model).not.toBe('custom');
    expect(model).toBe('');
  });
});
