import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// A fake sidecar: agent-chat answers come from a script; memory endpoints are
// recorded so a test can tell whether a tool actually ran.
const chatReplies: unknown[] = [];
const chatRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
const http = {
  get: vi.fn(async (url: string) => {
    if (url.startsWith('/settings/')) return { data: null };
    if (url.startsWith('/ai/memory')) return { data: { memories: [] } };
    return { data: [] };
  }),
  post: vi.fn(async (url: string, body: unknown) => {
    if (url === '/ai/agent-chat') {
      chatRequests.push(JSON.parse(JSON.stringify(body)));
      return { data: chatReplies.shift() };
    }
    return { data: {} };
  }),
  put: vi.fn(async () => ({ data: null })),
  delete: vi.fn(async () => ({ data: null })),
};

vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http }),
  getCurrentMode: () => 'standalone',
  isClientInitialized: () => true,
}));
vi.mock('../../api/mcp', async () => ({
  ...(await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')),
  listMcpServers: vi.fn(async () => []),
}));
vi.mock('../../api/ai', async () => ({
  ...(await vi.importActual<typeof import('../../api/ai')>('../../api/ai')),
  getAllModePrompts: vi.fn(async () => ({})),
  getAiConfigModeStatus: vi.fn(async () => ({ enabled: false, expires_at: null, seconds_remaining: null })),
}));

import { useAIAgent } from '../useAIAgent';
import { defaultSettings, setGlobalSettings, type AppSettings } from '../useSettings';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';

function toolTurn(...calls: Array<{ id: string; name: string; input?: Record<string, unknown> }>) {
  return { text: null, stop_reason: 'tool_use', tool_use: calls.map(c => ({ input: {}, ...c })) };
}
const DONE = { text: 'done', stop_reason: 'end_turn', tool_use: [] };

const memoryWrites = () => http.post.mock.calls.filter(([url]) => url === '/ai/memory').length;
const memoryReads = () => http.get.mock.calls.filter(([url]) => String(url).startsWith('/ai/memory')).length;

/** tool_result blocks the hook sent back in the given agent-chat request. */
function toolResults(requestIndex: number): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  const last = chatRequests[requestIndex].messages.at(-1);
  return (last?.content ?? []) as Array<{ tool_use_id: string; content: string; is_error: boolean }>;
}

function renderAgent(settings: Partial<AppSettings>) {
  setGlobalSettings({ ...defaultSettings, ...settings });
  const states: string[] = [];
  const hook = renderHook(() => {
    const agent = useAIAgent({});
    states.push(agent.agentState);
    return agent;
  });
  return { ...hook, states };
}

beforeEach(async () => {
  chatReplies.length = 0;
  chatRequests.length = 0;
  http.get.mockClear();
  http.post.mockClear();
  await useCapabilitiesStore.getState().fetchCapabilities();
});

afterEach(() => setGlobalSettings(defaultSettings));

describe('processToolCalls — permission modes from settings', () => {
  it('Auto prompts for a write and runs a read without asking', async () => {
    chatReplies.push(
      toolTurn({ id: 'r', name: 'recall_memories' }, { id: 'w', name: 'save_memory', input: { content: 'x', category: 'device' } }),
      DONE,
    );
    const { result } = renderAgent({ 'ai.permissionMode.autopilot': 'auto' });

    let sent!: Promise<void>;
    act(() => { sent = result.current.sendMessage('remember x'); });
    await waitFor(() => expect(result.current.pendingCommands).toHaveLength(1));
    expect(result.current.pendingCommands[0]).toMatchObject({ id: 'w', toolName: 'save_memory' });
    expect(result.current.pendingCommands[0].reason).toMatch(/changes state/);
    // Nothing in the turn runs until the approval card is answered.
    expect(memoryReads()).toBe(0);
    expect(memoryWrites()).toBe(0);

    act(() => result.current.approveCommands());
    await act(async () => { await sent; });
    expect(memoryReads()).toBe(1);
    expect(memoryWrites()).toBe(1);
    expect(toolResults(1).map(r => r.tool_use_id).sort()).toEqual(['r', 'w']);
  });

  it('Auto runs a read-only turn with no approval card', async () => {
    chatReplies.push(toolTurn({ id: 'r', name: 'recall_memories' }), DONE);
    const { result, states } = renderAgent({ 'ai.permissionMode.autopilot': 'auto' });

    await act(async () => { await result.current.sendMessage('what do you remember'); });
    expect(states).not.toContain('waiting_approval');
    expect(memoryReads()).toBe(1);
  });

  it('Go Nuts prompts for nothing but still refuses a disabled tool', async () => {
    chatReplies.push(
      toolTurn({ id: 'w', name: 'save_memory', input: { content: 'x', category: 'device' } }, { id: 'r', name: 'recall_memories' }),
      DONE,
    );
    const { result, states } = renderAgent({
      'ai.permissionMode.autopilot': 'yolo',
      'ai.disabledTools.autopilot': ['save_memory'],
    });

    await act(async () => { await result.current.sendMessage('remember x'); });
    expect(states).not.toContain('waiting_approval');
    expect(memoryWrites()).toBe(0);
    expect(memoryReads()).toBe(1);
    const denied = toolResults(1).find(r => r.tool_use_id === 'w');
    expect(denied).toMatchObject({ is_error: true });
    expect(denied?.content).toMatch(/Not permitted: save_memory is disabled for Auto Pilot/);
  });

  it('Ask prompts even for list_sessions, and Reject runs nothing', async () => {
    chatReplies.push(toolTurn({ id: 'l', name: 'list_sessions' }), DONE);
    const { result } = renderAgent({ 'ai.permissionMode.autopilot': 'ask' });

    let sent!: Promise<void>;
    act(() => { sent = result.current.sendMessage('list my sessions'); });
    await waitFor(() => expect(result.current.pendingCommands).toHaveLength(1));
    expect(result.current.pendingCommands[0]).toMatchObject({ toolName: 'list_sessions', reason: expect.stringMatching(/Ask mode/) });

    act(() => result.current.rejectCommands());
    await act(async () => { await sent; });
    expect(http.get.mock.calls.some(([url]) => String(url).startsWith('/sessions'))).toBe(false);
    expect(toolResults(1)).toEqual([expect.objectContaining({ tool_use_id: 'l', content: 'User rejected this tool call.', is_error: true })]);
  });

  it('reads the mode of its own agent type', async () => {
    chatReplies.push(toolTurn({ id: 'r', name: 'recall_memories' }), DONE);
    setGlobalSettings({ ...defaultSettings, 'ai.permissionMode.autopilot': 'yolo', 'ai.permissionMode.overlord': 'ask' });
    const { result } = renderHook(() => useAIAgent({ agentType: 'overlord' }));

    let sent!: Promise<void>;
    act(() => { sent = result.current.sendMessage('recall'); });
    await waitFor(() => expect(result.current.pendingCommands).toHaveLength(1));
    act(() => result.current.approveCommands());
    await act(async () => { await sent; });
    expect(memoryReads()).toBe(1);
  });
});
