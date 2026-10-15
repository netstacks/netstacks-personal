import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const chatReplies: unknown[] = [];
const http = {
  get: vi.fn(async (url: string) => (url.startsWith('/settings/') ? { data: null } : { data: [] })),
  post: vi.fn(async (url: string) => (url === '/ai/agent-chat' ? { data: chatReplies.shift() } : { data: {} })),
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
import { defaultSettings, setGlobalSettings, type AppSettings } from '../../hooks/useSettings';
import { useCapabilitiesStore } from '../../stores/capabilitiesStore';

const SAVE_MEMORY_TURN = {
  text: null,
  stop_reason: 'tool_use',
  tool_use: [{ id: 'w', name: 'save_memory', input: { content: 'core is r1', category: 'network' } }],
};
const DONE = { text: 'Saved.', stop_reason: 'end_turn', tool_use: [] };
const memoryWrites = () => http.post.mock.calls.filter(([url]) => url === '/ai/memory').length;

async function ask(settings: Partial<AppSettings>) {
  setGlobalSettings({ ...defaultSettings, ...settings });
  chatReplies.push(SAVE_MEMORY_TURN, DONE);
  render(<AIFloatingChat isOpen position={{ x: 10, y: 10 }} onClose={() => {}} />);
  const input = await screen.findByPlaceholderText('Ask AI...');
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: 'remember the core router' } });
  fireEvent.submit(input.closest('form')!);
}

beforeEach(async () => {
  // jsdom has no layout; the chat scrolls its transcript on every message.
  Element.prototype.scrollIntoView = vi.fn();
  chatReplies.length = 0;
  http.post.mockClear();
  await useCapabilitiesStore.getState().fetchCapabilities();
});

afterEach(() => setGlobalSettings(defaultSettings));

describe('AIFloatingChat follows the Auto Pilot permission setting', () => {
  it('Auto: shows the approval card for a write and runs it once approved', async () => {
    await ask({ 'ai.permissionMode.autopilot': 'auto' });
    await screen.findByText('Approval Required');
    expect(memoryWrites()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await screen.findByText('Saved.');
    expect(memoryWrites()).toBe(1);
  });

  it('Go Nuts: runs the write without an approval card', async () => {
    await ask({ 'ai.permissionMode.autopilot': 'yolo' });
    await screen.findByText('Saved.');
    expect(screen.queryByText('Approval Required')).toBeNull();
    expect(memoryWrites()).toBe(1);
  });
});
