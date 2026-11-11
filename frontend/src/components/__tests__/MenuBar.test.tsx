import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../commands', async () => {
  const actual = await vi.importActual<any>('../../commands')
  return {
    ...actual,
    dispatchCommand: vi.fn(),
    getActiveContext: () => ({ isEnterprise: false }),
    // The store keeps commands in a Map<string, Command> (registry.ts), so the
    // mock must be a Map too — MenuBar calls commands.get(...).
    useCommandStore: (sel: any) => sel({
      commands: new Map([
        ['file.new-session', { id: 'file.new-session', label: 'New Session', category: 'file', accelerator: 'CmdOrCtrl+N', run: () => {} }],
      ]),
    }),
  }
})

import { dispatchCommand } from '../../commands'

import MenuBar from '../MenuBar'

describe('MenuBar', () => {
  beforeEach(() => dispatchCommand.mockClear())

  it('renders top-level section buttons', () => {
    render(<MenuBar />)
    expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('opens a menu and dispatches a command on click', () => {
    render(<MenuBar />)
    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click(screen.getByText('New Session'))
    expect(dispatchCommand).toHaveBeenCalledWith('file.new-session', expect.anything())
  })
})
