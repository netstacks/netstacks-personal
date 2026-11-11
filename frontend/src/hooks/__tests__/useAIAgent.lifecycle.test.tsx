import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Standalone agent: /ai/agent-chat answers come from a script (a reply can be
// a deferred promise so a turn can be held "busy"), and the streaming variant
// reads SSE lines from a stubbed fetch.
type Reply = unknown | Promise<unknown>;
const chatReplies: Reply[] = [];
const chatRequests: Array<{ messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }>; provider?: string; model?: string }> = [];
let terminalModeSetting: unknown = { value: 'false' };
const http = {
  get: vi.fn(async (url: string) => {
    if (url === '/settings/ai.terminal_mode') return { data: terminalModeSetting };
    if (url.startsWith('/ai/memory')) return { data: { memories: [] } };
    return { data: [] };
  }),
  post: vi.fn(async (url: string, body: unknown) => {
    if (url === '/ai/agent-chat') {
      chatRequests.push(JSON.parse(JSON.stringify(body)));
      return { data: await chatReplies.shift() };
    }
    return { data: {} };
  }),
  put: vi.fn(async () => ({ data: null })),
  delete: vi.fn(async () => ({ data: null })),
  defaults: { baseURL: 'http://agent.test/api' },
};

vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http, baseUrl: 'http://agent.test' }),
  getCurrentMode: () => 'standalone',
  isClientInitialized: () => true,
}));
vi.mock('../../api/localClient', () => ({ getSidecarAuthToken: () => null }));
vi.mock('../../api/mcp', async () => ({
  ...(await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')),
  listMcpServers: vi.fn(async () => []),
}));
vi.mock('../../api/ai', async () => ({
  ...(await vi.importActual<typeof import('../../api/ai')>('../../api/ai')),
  getAllModePrompts: vi.fn(async () => ({})),
}));

import { useAIAgent, STREAM_INCOMPLETE_ERROR, EMPTY_RESPONSE_ERROR } from '../useAIAgent';
import { defaultSettings, setGlobalSettings } from '../useSettings';
import { TokenUsageProvider } from '../../contexts/TokenUsageContext';
import { useTokenUsage } from '../../contexts/tokenUsageStore';
import { saveAiTerminalMode } from '../../lib/aiTerminalMode';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';

const DONE = (text: string) => ({ text, stop_reason: 'end_turn', tool_use: [], usage: { input_tokens: 10, output_tokens: 5 } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function sseFetch(events: object[]) {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
  const bytes = new TextEncoder().encode(lines);
  let sent = false;
  return vi.fn(async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        releaseLock: () => {},
      }),
    },
  }));
}

const userTexts = (msgs: Array<{ role: string; content: unknown }>) =>
  msgs.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string);

beforeEach(() => {
  chatReplies.length = 0;
  chatRequests.length = 0;
  terminalModeSetting = { value: 'false' };
  setGlobalSettings({ ...defaultSettings, 'ai.defaultProvider': 'openai' });
  useCapabilitiesStore.setState({
    capabilities: { version: '1.0', license_tier: 'standalone', features: [{ name: 'local_ai_tools', enabled: true }] },
    permissions: ['*'],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setGlobalSettings(defaultSettings);
});

describe('useAIAgent: prompts sent while busy are queued, never dropped', () => {
  it('holds the latest queued prompt and sends it when the turn finishes', async () => {
    const first = deferred<unknown>();
    chatReplies.push(first.promise, DONE('second answer'));
    const { result } = renderHook(() => useAIAgent({}));

    let firstTurn!: Promise<void>;
    act(() => { firstTurn = result.current.sendMessage('first'); });
    await waitFor(() => expect(result.current.agentState).toBe('thinking'));

    act(() => result.current.queueMessage('older queued'));
    act(() => result.current.queueMessage('discover neighbors'));
    expect(result.current.queuedMessage).toBe('discover neighbors');
    expect(chatRequests).toHaveLength(1);

    await act(async () => { first.resolve(DONE('first answer')); await firstTurn; });
    await waitFor(() => expect(chatRequests).toHaveLength(2));
    expect(userTexts(chatRequests[1].messages).at(-1)).toContain('discover neighbors');
    await waitFor(() => expect(result.current.queuedMessage).toBeNull());
    expect(result.current.messages.filter((m) => m.type === 'user').map((m) => m.content)).toEqual(['first', 'discover neighbors']);
  });

  it('sends immediately when idle, and Stop discards a queued prompt', async () => {
    chatReplies.push(DONE('ok'));
    const { result } = renderHook(() => useAIAgent({}));
    await act(async () => { result.current.queueMessage('now'); });
    await waitFor(() => expect(chatRequests).toHaveLength(1));

    const held = deferred<unknown>();
    chatReplies.push(held.promise);
    act(() => { void result.current.sendMessage('busy'); });
    await waitFor(() => expect(result.current.agentState).toBe('thinking'));
    act(() => result.current.queueMessage('later'));
    act(() => result.current.stopAgent());
    expect(result.current.queuedMessage).toBeNull();
    await act(async () => { held.resolve(DONE('late')); });
    expect(chatRequests).toHaveLength(2);
  });
});

describe('useAIAgent: empty / truncated replies are surfaced', () => {
  it('non-streaming: an empty reply to a fresh prompt shows an error', async () => {
    chatReplies.push({ text: '', stop_reason: 'end_turn', tool_use: [] });
    const { result } = renderHook(() => useAIAgent({}));
    await act(async () => { await result.current.sendMessage('hello'); });
    expect(result.current.agentState).toBe('error');
    expect(result.current.messages.at(-1)).toMatchObject({ type: 'error', content: EMPTY_RESPONSE_ERROR });
  });

  it('streaming: a stream that ends without `done` keeps the partial text and says it was cut off', async () => {
    vi.stubGlobal('fetch', sseFetch([{ type: 'content_delta', text: 'Partial ans' }]));
    const { result } = renderHook(() => useAIAgent({ streaming: true }));
    await act(async () => { await result.current.sendMessage('hello'); });
    const last2 = result.current.messages.slice(-2);
    expect(last2[0]).toMatchObject({ type: 'agent-thinking', content: 'Partial ans' });
    expect(last2[1]).toMatchObject({ type: 'error', content: STREAM_INCOMPLETE_ERROR });
    expect(result.current.agentState).toBe('error');
  });

  it('streaming: an empty completed stream replaces the placeholder with an error', async () => {
    vi.stubGlobal('fetch', sseFetch([{ type: 'done', stop_reason: 'end_turn', usage: null }]));
    const { result } = renderHook(() => useAIAgent({ streaming: true }));
    await act(async () => { await result.current.sendMessage('hello'); });
    expect(result.current.messages.map((m) => m.type)).toEqual(['user', 'error']);
    expect(result.current.messages[1].content).toBe(EMPTY_RESPONSE_ERROR);
  });
});

describe('useAIAgent: token usage on the default-provider path', () => {
  it('attributes usage to the default provider when no provider is passed', async () => {
    chatReplies.push(DONE('hi'));
    const wrapper = ({ children }: { children: ReactNode }) => <TokenUsageProvider>{children}</TokenUsageProvider>;
    const { result } = renderHook(() => ({ agent: useAIAgent({}), usage: useTokenUsage() }), { wrapper });
    await act(async () => { await result.current.agent.sendMessage('hello'); });
    expect(chatRequests[0].provider).toBeUndefined();
    expect(result.current.agent.tokenUsage).toMatchObject({ totalTokens: 15, requestCount: 1 });
    expect(result.current.usage.usage.providers.openai).toMatchObject({ inputTokens: 10, outputTokens: 5, requestCount: 1 });
  });
});

describe('useAIAgent: AI Terminal Mode follows the setting without a remount', () => {
  it('offers the remote file tools once the setting is turned on', async () => {
    chatReplies.push(DONE('a'), DONE('b'));
    const { result } = renderHook(() => useAIAgent({}));
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/settings/ai.terminal_mode'));
    await act(async () => { await result.current.sendMessage('one'); });
    expect(chatRequests[0].tools.map((t) => t.name)).not.toContain('write_file');

    await act(async () => { await saveAiTerminalMode(true); });
    expect(http.put).toHaveBeenCalledWith('/settings/ai.terminal_mode', { value: 'true' });
    await act(async () => { await result.current.sendMessage('two'); });
    expect(chatRequests[1].tools.map((t) => t.name)).toContain('write_file');
  });
});

describe('useAIAgent: reasoning ("Show AI Reasoning") and cut-off replies', () => {
  it('streaming: thinking deltas become a reasoning message above the reply, never sent back', async () => {
    setGlobalSettings({ ...defaultSettings, 'ai.defaultProvider': 'openai', 'ai.showThinking': true });
    const fetchMock = sseFetch([
      { type: 'thinking_delta', text: 'Check the ' },
      { type: 'thinking_delta', text: 'platform first.' },
      { type: 'content_delta', text: 'It is Ubuntu.' },
      { type: 'done', stop_reason: 'end_turn', usage: null },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAIAgent({ streaming: true }));
    await act(async () => { await result.current.sendMessage('what is it?'); });
    expect(result.current.messages.map((m) => [m.type, m.content])).toEqual([
      ['user', 'what is it?'],
      ['reasoning', 'Check the platform first.'],
      ['agent-thinking', 'It is Ubuntu.'],
    ]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.show_thinking).toBe(true);
    expect(JSON.stringify(body.messages)).not.toContain('platform first');
  });

  it('non-streaming: a returned summary is shown; the flag is off by default', async () => {
    chatReplies.push({ ...DONE('done'), thinking: 'Weighed two options.' });
    const { result } = renderHook(() => useAIAgent({}));
    await act(async () => { await result.current.sendMessage('go'); });
    expect(result.current.messages.map((m) => m.type)).toEqual(['user', 'reasoning', 'agent-thinking']);
    expect(chatRequests[0]).not.toHaveProperty('show_thinking');
  });

  it('streaming: max_tokens with a half-built tool call shows why and runs nothing', async () => {
    vi.stubGlobal('fetch', sseFetch([
      { type: 'content_delta', text: "I'll write it now." },
      { type: 'tool_use_start', id: 't1', name: 'create_mop' },
      { type: 'tool_input_delta', delta: '{"name":"Up' },
      { type: 'done', stop_reason: 'max_tokens', usage: null },
    ]));
    const { result } = renderHook(() => useAIAgent({ streaming: true }));
    await act(async () => { await result.current.sendMessage('make a MOP'); });
    expect(result.current.agentState).toBe('error');
    expect(result.current.messages.at(-1)?.content).toMatch(/output-token limit.*tool call was cut off/);
    expect(result.current.messages.some((m) => m.type === 'command-result')).toBe(false);
  });
});
