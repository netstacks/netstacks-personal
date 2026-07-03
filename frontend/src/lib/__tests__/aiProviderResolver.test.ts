import { describe, it, expect, beforeEach } from 'vitest';
import { resolveProvider } from '../aiProviderResolver';
import { getSettings, setGlobalSettings, type AppSettings } from '../../hooks/useSettings';

const baseline: AppSettings = getSettings();

function withSettings(overrides: Partial<AppSettings>): void {
  setGlobalSettings({ ...baseline, ...overrides });
}

describe('resolveProvider — one provider (the default); optional per-toolset model', () => {
  beforeEach(() => {
    setGlobalSettings({ ...baseline });
  });

  it('default path returns empty so the backend uses the saved config', () => {
    withSettings({ 'ai.defaultProvider': 'anthropic', 'ai.enabledProviders': ['anthropic'] });
    expect(resolveProvider()).toEqual({ provider: '', model: '' });
    expect(resolveProvider('suggestions')).toEqual({ provider: '', model: '' });
    expect(resolveProvider('highlighting')).toEqual({ provider: '', model: '' });
  });

  it('provider is never overridden client-side — always the default', () => {
    // Even if a legacy agent provider were present, the resolver ignores it.
    withSettings({ 'ai.agent.model': null });
    expect(resolveProvider('agent')).toEqual({ provider: '', model: '' });
  });

  it('agent model override is applied to the default provider (provider stays empty)', () => {
    withSettings({ 'ai.agent.model': 'gpt-4o' });
    expect(resolveProvider('agent')).toEqual({ provider: '', model: 'gpt-4o' });
  });

  it('no agent model override → pure default', () => {
    withSettings({ 'ai.agent.model': null });
    expect(resolveProvider('agent')).toEqual({ provider: '', model: '' });
  });
});
