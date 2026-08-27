import { describe, it, expect, vi, beforeEach } from 'vitest';

const http = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock('./client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => 'standalone',
}));

const notFound = () => Object.assign(new Error('404'), { response: { status: 404 } });

describe('aiConversations circuit breaker (NS-API-4)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('a 404 on /:id does not disable persistence', async () => {
    const mod = await import('./aiConversations');
    http.get.mockRejectedValueOnce(notFound());
    await expect(mod.getAiConversation('stale')).rejects.toThrow('404');
    expect(mod.aiConversationsAvailable()).toBe(true);

    http.put.mockRejectedValueOnce(notFound());
    await expect(mod.updateAiConversation('stale', { title: 't' })).rejects.toThrow('404');
    expect(mod.aiConversationsAvailable()).toBe(true);

    http.delete.mockRejectedValueOnce(notFound());
    await expect(mod.deleteAiConversation('stale')).resolves.toBeUndefined();
    expect(mod.aiConversationsAvailable()).toBe(true);

    // Subsequent create still hits the network.
    http.post.mockResolvedValueOnce({ data: { id: 'new' } });
    await expect(mod.createAiConversation({ title: 'x' })).resolves.toEqual({ id: 'new' });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a 404 on the collection route trips the breaker', async () => {
    const mod = await import('./aiConversations');
    http.get.mockRejectedValueOnce(notFound());
    expect(await mod.listAiConversations()).toEqual([]);
    expect(mod.aiConversationsAvailable()).toBe(false);
    await expect(mod.createAiConversation({ title: 'x' })).rejects.toThrow('unavailable');
    expect(http.post).not.toHaveBeenCalled();
  });
});
