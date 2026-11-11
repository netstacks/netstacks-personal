import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const chatReplies: unknown[] = [];
const http = {
  get: vi.fn(async (url: string) => (url.startsWith('/settings/') ? { data: null } : { data: [] })),
  post: vi.fn(async (url: string) => {
    if (url !== '/ai/agent-chat') return { data: {} };
    const reply = chatReplies.shift();
    if (reply instanceof Error) throw reply;
    return { data: reply };
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
}));

import AIFloatingChat from '../AIFloatingChat';
import { defaultSettings, setGlobalSettings } from '../../hooks/useSettings';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';

const reply = (text: string) => ({ text, stop_reason: 'end_turn', tool_use: [] });

interface AgentChatBody { messages: { role: string; content: unknown }[]; tools: { name: string }[] }
const agentChatBodies = () =>
  http.post.mock.calls.filter(([url]) => url === '/ai/agent-chat').map(([, body]) => body as unknown as AgentChatBody);
const userText = (body: AgentChatBody) => JSON.stringify(body.messages.filter(m => m.role === 'user'));

function renderChat(props: Partial<React.ComponentProps<typeof AIFloatingChat>> = {}) {
  return render(<AIFloatingChat isOpen position={{ x: 10, y: 10 }} onClose={() => {}} {...props} />);
}

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  chatReplies.length = 0;
  http.post.mockClear();
  setGlobalSettings({ ...defaultSettings, 'ai.permissionMode.autopilot': 'auto' });
  await useCapabilitiesStore.getState().fetchCapabilities();
});

afterEach(() => setGlobalSettings(defaultSettings));

describe('AIFloatingChat as the Ask AI pop-over', () => {
  it('sends the seeded help question on open', async () => {
    chatReplies.push(reply('Matchers pick the token type.'));
    renderChat({ initialPrompt: 'Explain token matchers' });
    await screen.findByText('Matchers pick the token type.');
    expect(userText(agentChatBodies()[0])).toContain('Explain token matchers');
  });

  it('starts a fresh conversation when a new question arrives while open', async () => {
    chatReplies.push(reply('About matchers.'), reply('About tunnels.'));
    const { rerender } = renderChat({ initialPrompt: 'Explain token matchers' });
    await screen.findByText('About matchers.');
    rerender(<AIFloatingChat isOpen position={{ x: 10, y: 10 }} onClose={() => {}} initialPrompt="Explain SSH tunnels" />);
    await screen.findByText('About tunnels.');
    const second = agentChatBodies()[1];
    expect(userText(second)).toContain('Explain SSH tunnels');
    expect(userText(second)).not.toContain('Explain token matchers');
    expect(screen.queryByText('About matchers.')).toBeNull();
  });

  it('offers navigate_to_settings and opens the tab the AI asks for', async () => {
    const onNavigateToSettings = vi.fn();
    chatReplies.push(
      { text: null, stop_reason: 'tool_use', tool_use: [{ id: 'n', name: 'navigate_to_settings', input: { tab: 'enrichment' } }] },
      reply('Opened Enrichment for you.'),
    );
    renderChat({ initialPrompt: 'Take me to enrichment', onNavigateToSettings });
    await screen.findByText('Opened Enrichment for you.');
    expect(agentChatBodies()[0].tools.map(t => t.name)).toContain('navigate_to_settings');
    expect(onNavigateToSettings).toHaveBeenCalledWith('enrichment');
  });

  it('does not offer navigate_to_settings without a way to open Settings', async () => {
    chatReplies.push(reply('ok'));
    renderChat({ initialPrompt: 'hello' });
    await screen.findByText('ok');
    expect(agentChatBodies()[0].tools.map(t => t.name)).not.toContain('navigate_to_settings');
  });

  it('points to Settings → AI when the request fails', async () => {
    const onNavigateToSettings = vi.fn();
    chatReplies.push(new Error('AI is not configured. Open Settings and configure an AI provider.'));
    renderChat({ initialPrompt: 'Explain token matchers', onNavigateToSettings });
    const button = await screen.findByRole('button', { name: 'Open AI Settings' });
    fireEvent.click(button);
    await waitFor(() => expect(onNavigateToSettings).toHaveBeenCalledWith('ai'));
  });
});
