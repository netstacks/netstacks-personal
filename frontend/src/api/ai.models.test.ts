import { describe, it, expect, vi, beforeEach } from 'vitest';

const http = {
  get: vi.fn(),
};

vi.mock('./client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => 'standalone',
}));

import { listProviderModels } from './ai';

describe('listProviderModels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns live models and passes query params', async () => {
    http.get.mockResolvedValue({ data: { models: [{ id: 'gpt-4o', display_name: 'GPT-4o' }], source: 'live' } });
    const res = await listProviderModels('openai', { baseUrl: 'https://x/v1', verifySsl: false, refresh: true });
    expect(res.source).toBe('live');
    expect(res.models).toEqual([{ id: 'gpt-4o', display_name: 'GPT-4o' }]);
    const url = http.get.mock.calls[0][0] as string;
    expect(url).toContain('/ai/providers/openai/models');
    expect(url).toContain('refresh=true');
    expect(url).toContain('verify_ssl=false');
    expect(url).toContain('base_url=');
  });

  it('degrades to source=error on network failure', async () => {
    http.get.mockRejectedValueOnce(new Error('offline'));
    const res = await listProviderModels('anthropic');
    expect(res.source).toBe('error');
    expect(res.models).toEqual([]);
    expect(res.error).toBeTruthy();
  });
});
