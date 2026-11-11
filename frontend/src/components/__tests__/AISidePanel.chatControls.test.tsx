import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

// Side panel chat controls in standalone with two configured providers: the
// Close button only exists when there is something to close, the per-chat
// model picker drives the request, external prompts queue while busy, and
// troubleshooting capture only records messages from the recording itself.
const { http } = vi.hoisted(() => ({
  http: {
    get: vi.fn(async (url: string) => (url.startsWith('/settings/') ? { data: null } : { data: [] })),
    post: vi.fn(async () => ({ data: { id: 'conv-1' } })),
    put: vi.fn(async () => ({ data: null })),
    delete: vi.fn(async () => ({ data: null })),
    defaults: { baseURL: 'http://agent.test/api' },
  },
}));
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http, baseUrl: 'http://agent.test', wsUrlWithAuth: (p: string) => `ws://agent.test${p}` }),
  getCurrentMode: () => 'standalone',
  isClientInitialized: () => true,
}));
vi.mock('../../api/localClient', () => ({ getSidecarAuthToken: () => null }));
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({ mode: 'standalone', isEnterprise: false, isStandalone: true, hasEnterpriseFeatures: false, isInitialized: true, controllerUrl: null }),
}));
vi.mock('../../api/mcp', async () => ({
  ...(await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')),
  listMcpServers: vi.fn(async () => []),
}));
vi.mock('../../api/ai', async () => ({
  ...(await vi.importActual<typeof import('../../api/ai')>('../../api/ai')),
  getAllModePrompts: vi.fn(async () => ({})),
  hasAiApiKey: vi.fn(async () => true),
}));
vi.mock('../../api/aiConversations', async () => ({
  ...(await vi.importActual<typeof import('../../api/aiConversations')>('../../api/aiConversations')),
  createAiConversation: vi.fn(async () => ({ id: 'conv-1' })),
  updateAiConversation: vi.fn(async () => ({})),
  listAiConversations: vi.fn(async () => []),
}));

import AISidePanel from '../AISidePanel';
import { defaultSettings, setGlobalSettings } from '../../hooks/useSettings';

type Body = { model?: string; provider?: string; messages: Array<{ role: string; content: unknown }> };
const requests: Body[] = [];
let holds: Array<() => void> = [];

/** SSE reply; when `hold` is set the stream waits until released. */
function stubStreamingFetch(hold = false) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    const gate = hold ? new Promise<void>((r) => holds.push(r)) : Promise.resolve();
    const events = [{ type: 'content_delta', text: `reply ${requests.length}` }, { type: 'done', stop_reason: 'end_turn', usage: null }];
    const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n`).join(''));
    let sent = false;
    return {
      ok: true,
      body: { getReader: () => ({
        read: async () => { await gate; if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: bytes }; },
        releaseLock: () => {},
      }) },
    };
  }));
}

const lastUserText = (b: Body) => String(b.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');

async function send(text: string) {
  const input = screen.getByTestId('ai-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  requests.length = 0;
  holds = [];
  localStorage.clear();
  setGlobalSettings({
    ...defaultSettings,
    'ai.enabledProviders': ['anthropic', 'openai'],
    'ai.defaultProvider': 'anthropic',
    'ai.models.anthropic': ['claude-a', 'claude-b'],
    'ai.models.openai': ['gpt-x'],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setGlobalSettings(defaultSettings);
});

describe('AISidePanel chat controls', () => {
  it('hides Close when no onClose is given', async () => {
    const { unmount } = render(<AISidePanel isOpen isTab />);
    await screen.findByLabelText('AI model');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    unmount();
    const onClose = vi.fn();
    render(<AISidePanel isOpen isTab onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('defaults to the provider\'s first model, sends the chosen one, and stays valid on provider change', async () => {
    stubStreamingFetch();
    render(<AISidePanel isOpen isTab />);
    const modelSelect = await screen.findByLabelText<HTMLSelectElement>('AI model');
    await waitFor(() => expect(modelSelect.value).toBe('claude-a'));

    fireEvent.change(modelSelect, { target: { value: 'claude-b' } });
    await send('hello');
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ provider: 'anthropic', model: 'claude-b' });

    await screen.findByText('reply 1');
    fireEvent.change(screen.getByLabelText('AI provider'), { target: { value: 'openai' } });
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('AI model').value).toBe('gpt-x'));
  });

  it('queues an external prompt that arrives mid-turn and sends it afterwards', async () => {
    stubStreamingFetch(true);
    const { rerender } = render(<AISidePanel isOpen isTab />);
    await screen.findByLabelText('AI model');
    await send('first question');
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender(<AISidePanel isOpen isTab externalPrompt={{ prompt: 'Discover neighbors of rtr1', counter: 1 }} />);
    expect(await screen.findByText(/Queued — sends when the current reply finishes/)).toBeInTheDocument();
    expect(requests).toHaveLength(1);

    await act(async () => { holds.shift()?.(); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(lastUserText(requests[1])).toContain('Discover neighbors of rtr1');
    await waitFor(() => expect(screen.queryByText(/Queued — sends/)).toBeNull());
    await act(async () => { holds.shift()?.(); });
  });

  it('troubleshooting capture starts at the recording, not with older messages', async () => {
    stubStreamingFetch();
    const capture = vi.fn();
    const { rerender } = render(<AISidePanel isOpen isTab onTroubleshootingCapture={capture} captureAIConversations />);
    await screen.findByLabelText('AI model');
    await send('before recording');
    await screen.findByText('reply 1');

    rerender(<AISidePanel isOpen isTab onTroubleshootingCapture={capture} captureAIConversations isTroubleshootingActive />);
    await send('during recording');
    await screen.findByText('reply 2');
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture.mock.calls.map((c) => c[1])).toEqual(['[User] during recording', '[AI] reply 2']);
  });
});
