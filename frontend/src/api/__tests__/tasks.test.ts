// Audit 1.7 / 4.10 / section 5: cancel routes, honest enterprise delete, and
// an explicit "unsupported" transcript result for the Controller.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mode: 'standalone' as 'standalone' | 'enterprise',
  post: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../client', () => ({
  getCurrentMode: () => mocks.mode,
  getClient: () => ({ http: { post: mocks.post, delete: mocks.del, get: mocks.get } }),
}));

import { cancelTask, deleteTask, fetchTaskTranscript, getTaskMessages, taskTranscriptsSupported } from '../tasks';

beforeEach(() => {
  mocks.post.mockReset();
  mocks.del.mockReset();
  mocks.get.mockReset();
});

describe('standalone', () => {
  beforeEach(() => { mocks.mode = 'standalone'; });

  it('cancels via POST /tasks/:id/cancel (not delete)', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    await cancelTask('t1');
    expect(mocks.post).toHaveBeenCalledWith('/tasks/t1/cancel');
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('propagates cancel failures', async () => {
    mocks.post.mockRejectedValue(new Error('boom'));
    await expect(cancelTask('t1')).rejects.toThrow('boom');
  });

  it('deletes via DELETE /tasks/:id', async () => {
    mocks.del.mockResolvedValue({});
    await deleteTask('t1');
    expect(mocks.del).toHaveBeenCalledWith('/tasks/t1');
  });

  it('returns transcript steps', async () => {
    const steps = [{ task_id: 't1', seq: 0, kind: 'thought', content: 'x' }];
    mocks.get.mockResolvedValue({ data: steps });
    expect(taskTranscriptsSupported()).toBe(true);
    await expect(fetchTaskTranscript('t1')).resolves.toEqual({ supported: true, steps });
    expect(mocks.get).toHaveBeenCalledWith('/tasks/t1/messages', { params: { since_seq: -1 } });
  });
});

describe('enterprise', () => {
  beforeEach(() => { mocks.mode = 'enterprise'; });

  it('cancels via the Controller route and surfaces 404/405', async () => {
    mocks.post.mockResolvedValueOnce({ data: {} });
    await cancelTask('e1');
    expect(mocks.post).toHaveBeenCalledWith('/tasks/executions/e1/cancel');

    for (const status of [404, 405, 500]) {
      mocks.post.mockRejectedValueOnce(Object.assign(new Error(`HTTP ${status}`), { response: { status } }));
      await expect(cancelTask('e1')).rejects.toThrow(`HTTP ${status}`);
    }
  });

  it('never claims to delete an execution', async () => {
    await expect(deleteTask('e1')).rejects.toThrow(/keeps execution history/);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('reports transcripts as unsupported without a request', async () => {
    expect(taskTranscriptsSupported()).toBe(false);
    await expect(fetchTaskTranscript('e1')).resolves.toEqual({ supported: false });
    await expect(getTaskMessages('e1')).resolves.toEqual([]);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
