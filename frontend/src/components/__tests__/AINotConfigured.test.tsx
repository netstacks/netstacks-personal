import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// No AI provider yet. Standalone users add their own key (Settings → AI);
// in enterprise the providers live on the Controller and an administrator
// sets them up in its Admin UI, so the side panel and the floating chat never
// send an enterprise user to local provider setup.
const { env, mode, http } = vi.hoisted(() => {
  const env = { enterprise: false };
  return {
    env,
    mode: () => (env.enterprise ? 'enterprise' : 'standalone'),
    http: {
      get: vi.fn(async (url: string) => (url.startsWith('/settings/') ? { data: null } : { data: [] })),
      post: vi.fn(async () => ({ data: {} })),
      put: vi.fn(async () => ({ data: null })),
      delete: vi.fn(async () => ({ data: null })),
    },
  };
});
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: mode(), http, wsUrlWithAuth: (path: string) => `ws://localhost${path}` }),
  getCurrentMode: () => mode(),
  isClientInitialized: () => true,
}));
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({
    mode: mode(),
    isEnterprise: env.enterprise,
    isStandalone: !env.enterprise,
    hasEnterpriseFeatures: env.enterprise,
    isInitialized: true,
    controllerUrl: env.enterprise ? 'https://controller.test' : null,
  }),
}));
vi.mock('../../api/mcp', async () => ({
  ...(await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')),
  listMcpServers: vi.fn(async () => []),
}));
vi.mock('../../api/ai', async () => ({
  ...(await vi.importActual<typeof import('../../api/ai')>('../../api/ai')),
  getAllModePrompts: vi.fn(async () => ({})),
  getAiStatus: vi.fn(async () => ({ configured: false, providers: [] })),
  hasAiApiKey: vi.fn(async () => false),
}));

// The floating chat shows whatever error the agent reports; the agent's
// wording itself is covered by useAIAgent.enterprise.test.ts.
const agent = vi.hoisted(() => ({
  messages: [] as unknown[],
  agentState: 'idle',
  sendMessage: () => {},
  stopAgent: () => {},
  clearMessages: () => {},
  pendingCommands: [],
  approveCommands: () => {},
  rejectCommands: () => {},
}));
vi.mock('../../hooks/useAIAgent', () => ({ useAIAgent: () => agent }));

import AIFloatingChat from '../AIFloatingChat';
import { aiNotConfiguredMessage } from '../../api/ai';

const ENTERPRISE_WORDING = /Ask your administrator to set up an AI provider on the Controller \(Admin UI → AI → LLM Providers\)/;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  env.enterprise = true;
});
afterEach(cleanup);

describe('AI not configured: floating chat (and Ask AI, which opens it)', () => {
  function renderWithError(content: string) {
    agent.messages = [{ id: 'e1', type: 'error', content, timestamp: new Date() }];
    const onNavigateToSettings = vi.fn();
    render(<AIFloatingChat isOpen position={{ x: 10, y: 10 }} onClose={() => {}} onNavigateToSettings={onNavigateToSettings} />);
  }

  it('enterprise: shows the administrator wording and offers no local AI settings', () => {
    renderWithError(`Agent error: ${aiNotConfiguredMessage()}`);
    expect(screen.getByText(ENTERPRISE_WORDING)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open AI Settings' })).toBeNull();
  });

  it('standalone: keeps the "Open AI Settings" button', () => {
    env.enterprise = false;
    renderWithError(`Agent error: ${aiNotConfiguredMessage()}`);
    expect(screen.getByText(/Add your API key in Settings > AI/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open AI Settings' })).toBeInTheDocument();
  });
});
