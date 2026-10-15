import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The side panel's welcome when no AI provider exists: standalone points at
// Settings → AI; enterprise says an administrator sets providers up on the
// Controller (there is no local provider setup to open).
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

import AISidePanel from '../AISidePanel';
import { setUserScope, clearUserScope } from '../../lib/userScope';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  clearUserScope();
  env.enterprise = false;
});

describe('AISidePanel welcome with no AI provider', () => {
  it('enterprise: an administrator sets AI up on the Controller', async () => {
    env.enterprise = true;
    setUserScope('https://controller.test', 'u1');
    render(<AISidePanel isOpen onClose={() => {}} />);
    expect(await screen.findByText(/Ask your administrator to set up an AI provider on the Controller \(Admin UI → AI → LLM Providers\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Open Settings → AI/)).toBeNull();
  });

  it('standalone: points at Settings → AI', async () => {
    render(<AISidePanel isOpen onClose={() => {}} />);
    expect(await screen.findByText(/Open Settings → AI \(Ctrl\+,\) to add a provider/)).toBeInTheDocument();
  });
});
