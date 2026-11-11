import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const http = {
  get: vi.fn(async (url: string) => (url.startsWith('/settings/') ? { data: null } : { data: [] })),
  post: vi.fn(async () => ({ data: {} })),
  put: vi.fn(async () => ({ data: null })),
  delete: vi.fn(async () => ({ data: null })),
};

vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http, wsUrlWithAuth: (path: string) => `ws://localhost${path}` }),
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

import AISidePanel from '../AISidePanel';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('AISidePanel collapsed tab', () => {
  it('renders into the dock slot it is given and expands the panel again', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(<AISidePanel isOpen onClose={() => {}} edgeTabTarget={slot} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Collapse (Esc)' }));
    const tab = within(slot).getByRole('button', { name: /chat$/ });
    fireEvent.click(tab);
    expect(within(slot).queryByRole('button', { name: /chat$/ })).toBeNull();
    slot.remove();
  });
});
