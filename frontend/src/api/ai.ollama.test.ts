import { describe, it, expect, vi, beforeEach } from 'vitest';

const http = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock('./client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => 'standalone',
}));

import { stripLatestTag, getOllamaBaseUrl, setDiscoveryPrompt } from './ai';

describe('stripLatestTag (NS-AI-9)', () => {
  it('strips only a literal :latest tag', () => {
    expect(stripLatestTag('llama3:latest')).toBe('llama3');
    expect(stripLatestTag('llama3.1:8b')).toBe('llama3.1:8b');
    expect(stripLatestTag('qwen2.5-coder:7b-instruct')).toBe('qwen2.5-coder:7b-instruct');
    expect(stripLatestTag('mistral')).toBe('mistral');
  });
});

describe('getOllamaBaseUrl (NS-AI-3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the per-provider override', async () => {
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('ai.provider_overrides')) {
        return { data: { value: JSON.stringify({ base_urls: { ollama: 'http://gpu-box:11434' } }) } };
      }
      return { data: { value: JSON.stringify({ provider: 'ollama', model: 'x', base_url: 'http://other:11434' }) } };
    });
    expect(await getOllamaBaseUrl()).toBe('http://gpu-box:11434');
  });

  it('falls back to provider_config when it is the active Ollama config', async () => {
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('ai.provider_overrides')) return { data: null };
      return { data: { value: JSON.stringify({ provider: 'ollama', model: 'x', base_url: 'http://remote:11434' }) } };
    });
    expect(await getOllamaBaseUrl()).toBe('http://remote:11434');
  });

  it('returns undefined (use default) when nothing is configured', async () => {
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('ai.provider_overrides')) return { data: null };
      return { data: { value: JSON.stringify({ provider: 'anthropic', model: 'x' }) } };
    });
    expect(await getOllamaBaseUrl()).toBeUndefined();
  });
});

describe('prompt reset (NS-API-5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('propagates a DELETE failure instead of swallowing it', async () => {
    http.delete.mockRejectedValueOnce(new Error('405'));
    await expect(setDiscoveryPrompt(null)).rejects.toThrow('405');
    expect(http.delete).toHaveBeenCalledWith('/settings/ai.discovery_prompt');
  });
});
