// Audit 1.7 + section 5: task cancel surfaces failures (enterprise REST,
// standalone WS -> REST fallback); enterprise "delete" only hides the task,
// persisted per user so it stays hidden after a reload.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../types/tasks';

const mocks = vi.hoisted(() => ({
  mode: 'standalone' as 'standalone' | 'enterprise',
  post: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  showToast: vi.fn(),
  listAgentExecutions: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  getCurrentMode: () => mocks.mode,
  getClient: () => ({
    http: { post: mocks.post, delete: mocks.del, get: mocks.get },
    wsUrlWithAuth: (p: string) => `ws://agent${p}`,
  }),
}));
vi.mock('../../components/Toast', () => ({ showToast: mocks.showToast }));
vi.mock('../../api/agentDefinitions', () => ({ listAgentExecutions: mocks.listAgentExecutions }));
vi.mock('../../lib/taskExport', () => ({ saveTaskResultToDoc: vi.fn() }));

/** WebSocket stand-in; tests flip readyState to simulate an open socket. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  send = vi.fn();
  close = vi.fn();
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

function makeTask(id: string, status: AgentTask['status'] = 'running'): AgentTask {
  return {
    id,
    prompt: 'p',
    status,
    progress_pct: 10,
    result_json: null,
    error_message: null,
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:00:00Z',
    started_at: null,
    completed_at: null,
  };
}

async function loadModule() {
  vi.resetModules();
  const hookMod = await import('../useAgentTasks');
  const scopeMod = await import('../../lib/userScope');
  return { ...hookMod, ...scopeMod };
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.instances = [];
  mocks.post.mockReset();
  mocks.del.mockReset();
  mocks.get.mockReset();
  mocks.showToast.mockReset();
  mocks.listAgentExecutions.mockReset();
  mocks.listAgentExecutions.mockResolvedValue({ tasks: [], running_count: 0, max_concurrent: 3 });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('standalone cancel', () => {
  beforeEach(() => { mocks.mode = 'standalone'; });

  it('uses the WebSocket when it is open', async () => {
    const { useAgentTasks } = await loadModule();
    const { result } = renderHook(() => useAgentTasks());
    FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;

    await act(() => result.current.cancelTask('t1'));

    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'cancel', task_id: 't1' }));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('falls back to the REST cancel route when the WebSocket is not open', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    const { useAgentTasks } = await loadModule();
    const { result } = renderHook(() => useAgentTasks());

    await act(() => result.current.cancelTask('t1'));

    expect(mocks.post).toHaveBeenCalledWith('/tasks/t1/cancel');
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('falls back to the REST cancel route when the WebSocket send throws', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    const { useAgentTasks } = await loadModule();
    const { result } = renderHook(() => useAgentTasks());
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    ws.send.mockImplementation(() => { throw new Error('socket closing'); });

    await act(() => result.current.cancelTask('t1'));

    expect(ws.send).toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith('/tasks/t1/cancel');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('shows an error and keeps the task running when the fallback fails too', async () => {
    mocks.post.mockRejectedValue(new Error('agent unreachable'));
    const { useAgentTasks, useAgentTasksStore } = await loadModule();
    const { result } = renderHook(() => useAgentTasks());
    act(() => { useAgentTasksStore.getState().addTask(makeTask('t1')); });

    await act(() => result.current.cancelTask('t1'));

    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('agent unreachable'), 'error');
    expect(useAgentTasksStore.getState().tasks.find((t) => t.id === 't1')?.status).toBe('running');
  });

  it('delete is a real delete', async () => {
    mocks.del.mockResolvedValue({});
    const { useAgentTasks } = await loadModule();
    const { result } = renderHook(() => useAgentTasks());
    await act(() => result.current.deleteTask('t1'));
    expect(mocks.del).toHaveBeenCalledWith('/tasks/t1');
  });
});

describe('enterprise', () => {
  beforeEach(() => { mocks.mode = 'enterprise'; });

  it('cancels through the Controller route and surfaces failures', async () => {
    mocks.post.mockResolvedValueOnce({ data: {} });
    const { useAgentTasks, setUserScope } = await loadModule();
    setUserScope('https://ctl', 'alice');
    const { result } = renderHook(() => useAgentTasks());

    await act(() => result.current.cancelTask('e1'));
    expect(mocks.post).toHaveBeenCalledWith('/tasks/executions/e1/cancel');
    expect(mocks.showToast).not.toHaveBeenCalled();

    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
    await act(() => result.current.cancelTask('e2'));
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't cancel task"), 'error');
  });

  it('"delete" only hides the task, and it stays hidden after a reload for that user only', async () => {
    mocks.listAgentExecutions.mockResolvedValue({
      tasks: [makeTask('e1', 'completed'), makeTask('e2', 'completed')],
      running_count: 0,
      max_concurrent: 3,
    });
    let mod = await loadModule();
    mod.setUserScope('https://ctl', 'alice');
    const first = renderHook(() => mod.useAgentTasks());
    await act(async () => { await Promise.resolve(); });
    expect(mod.useAgentTasksStore.getState().tasks.map((t) => t.id)).toEqual(['e1', 'e2']);

    await act(() => first.result.current.deleteTask('e1'));

    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mod.useAgentTasksStore.getState().tasks.map((t) => t.id)).toEqual(['e2']);
    first.unmount();

    // Reload: fresh module state, same user. The poller's results omit e1.
    mod = await loadModule();
    mod.setUserScope('https://ctl', 'alice');
    const second = renderHook(() => mod.useAgentTasks());
    await act(async () => { await Promise.resolve(); });
    expect(mod.useAgentTasksStore.getState().tasks.map((t) => t.id)).toEqual(['e2']);
    second.unmount();

    // Another user on the same browser still sees e1.
    mod = await loadModule();
    mod.setUserScope('https://ctl', 'bob');
    const third = renderHook(() => mod.useAgentTasks());
    await act(async () => { await Promise.resolve(); });
    expect(mod.useAgentTasksStore.getState().tasks.map((t) => t.id)).toEqual(['e1', 'e2']);
    third.unmount();
  });
});
