import { describe, it, expect, vi, beforeEach } from 'vitest';

let mode: 'standalone' | 'enterprise' = 'standalone';
const http = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};
vi.mock('../client', () => ({
  getClient: () => ({ mode, http }),
  getCurrentMode: () => mode,
}));

import { listScripts, getScript, updateScript, approveScript, generateScript } from '../scripts';
import { AiNotConfiguredError, describeAiError } from '../ai';

/** A row exactly as the Controller serialises it (routes/scripts.rs ScriptResponse). */
const controllerRow = {
  id: 's1',
  name: 'collect',
  content: 'print(1)',
  is_template: false,
  last_run_at: null,
  shared: true,
  owner_name: 'alice',
  is_own: false,
  can_edit: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by_role: 'ai',
  approved: false,
  approved_at: null,
  approved_by: null,
};

const mapped = {
  id: 's1',
  name: 'collect',
  content: 'print(1)',
  last_run_at: null,
  shared: true,
  owner_name: 'alice',
  is_own: false,
  can_edit: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'ai',
  approved: false,
};

beforeEach(() => {
  mode = 'standalone';
  for (const fn of Object.values(http)) fn.mockReset();
});

describe('scripts API — Controller shape', () => {
  it('maps created_by_role to created_by and keeps can_edit on every read and write', async () => {
    mode = 'enterprise';
    http.get.mockResolvedValueOnce({ data: [controllerRow, { ...controllerRow, id: 's2', created_by_role: 'user', can_edit: true, approved: true }] });
    const list = await listScripts();
    expect(list[0]).toEqual(mapped);
    expect(list[1]).toMatchObject({ id: 's2', created_by: 'user', can_edit: true, approved: true });

    http.get.mockResolvedValueOnce({ data: controllerRow });
    expect(await getScript('s1')).toEqual(mapped);

    http.put.mockResolvedValueOnce({ data: { ...controllerRow, can_edit: true } });
    expect(await updateScript('s1', { content: 'x' })).toEqual({ ...mapped, can_edit: true });

    http.post.mockResolvedValueOnce({ data: { ...controllerRow, approved: true } });
    expect(await approveScript('s1')).toEqual({ ...mapped, approved: true });
  });

  it('passes the standalone agent shape through unchanged', async () => {
    const local = { id: 'l1', name: 'n', content: 'c', last_run_at: null, created_at: 't', updated_at: 't', created_by: 'ai', approved: false };
    http.get.mockResolvedValueOnce({ data: [local] });
    expect(await listScripts()).toEqual([local]);
  });
});

describe('AI not configured wording', () => {
  const notConfigured = { response: { status: 503, data: { code: 'NOT_CONFIGURED' } } };

  it('points standalone users at their own Settings > AI', async () => {
    http.post.mockRejectedValueOnce(notConfigured);
    await expect(generateScript('x')).rejects.toThrow('Add your API key in Settings > AI');
    expect(describeAiError(new AiNotConfiguredError('raw'), 'f')).toBe('AI not configured. Add your API key in Settings > AI.');
  });

  it('tells enterprise users the administrator configures AI on the Controller', async () => {
    mode = 'enterprise';
    http.post.mockRejectedValueOnce(notConfigured);
    const err = await generateScript('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiNotConfiguredError);
    expect((err as Error).message).toMatch(/administrator.*Controller/);
    expect((err as Error).message).not.toMatch(/Settings > AI/);
    expect(describeAiError(new AiNotConfiguredError('raw'), 'f')).toMatch(/administrator.*LLM Providers/);
  });
});
