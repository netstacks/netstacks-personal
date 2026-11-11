import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const row = (id: string, can_edit: boolean) => ({
  id, name: id, content: 'print(1)', is_template: false, last_run_at: null, shared: true,
  owner_name: can_edit ? null : 'alice', is_own: can_edit, can_edit,
  created_at: 't', updated_at: 't', created_by_role: 'user', approved: true, approved_at: null, approved_by: null,
});
const http = {
  get: vi.fn(async () => ({ data: [row('mine', true), row('theirs', false)] })),
  post: vi.fn(), put: vi.fn(), delete: vi.fn(),
};
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'enterprise', http }),
  getCurrentMode: () => 'enterprise',
  isClientInitialized: () => true,
}));

import ScriptsPanel from '../ScriptsPanel';

describe('ScriptsPanel — Controller can_edit', () => {
  it('offers View and a disabled Delete for a script the user cannot edit', async () => {
    render(<ScriptsPanel onOpenScript={() => {}} onNewScript={() => {}} onAIGenerate={() => {}} />);

    fireEvent.contextMenu(await screen.findByText('theirs'));
    expect(screen.getByRole('menuitem', { name: /View Script/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Delete Script \(owner or administrator only\)/ })).toBeDisabled();
  });

  it('keeps Edit and Delete for the user\'s own script', async () => {
    render(<ScriptsPanel onOpenScript={() => {}} onNewScript={() => {}} onAIGenerate={() => {}} />);

    fireEvent.contextMenu(await screen.findByText('mine'));
    expect(screen.getByRole('menuitem', { name: /Edit Script/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Delete Script$/ })).toBeEnabled();
  });
});
