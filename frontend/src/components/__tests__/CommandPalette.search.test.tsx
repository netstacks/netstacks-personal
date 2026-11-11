import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../api/search', () => ({
  searchEntities: vi.fn(),
}))

import CommandPalette from '../CommandPalette'
import { searchEntities } from '../../api/search'

// jsdom has no layout, so scrollIntoView (used to keep the keyboard
// cursor visible) is undefined on elements.
Element.prototype.scrollIntoView = vi.fn()

describe('CommandPalette search results', () => {
  it('shows entity results and navigates on select', async () => {
    searchEntities.mockResolvedValue([
      { type: 'session', id: 's1', title: 'core-rtr-1', subtitle: '10.0.0.1', score: 100 },
    ])
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    render(<CommandPalette isOpen onClose={onClose} commands={[]} onNavigate={onNavigate} />)
    fireEvent.change(screen.getByTestId('command-palette-input'),
      { target: { value: 'core' } })
    await waitFor(() => expect(screen.getByText('core-rtr-1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('core-rtr-1'))
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('Enter on a keyboard-selected entity result navigates instead of running a command', async () => {
    searchEntities.mockResolvedValue([
      { type: 'session', id: 's1', title: 'core-rtr-1', subtitle: '10.0.0.1', score: 100 },
    ])
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    const action = vi.fn()
    render(
      <CommandPalette
        isOpen
        onClose={onClose}
        commands={[{ id: 'c1', label: 'core dump', action }]}
        onNavigate={onNavigate}
      />,
    )
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'core' } })
    await waitFor(() => expect(screen.getByText('core-rtr-1')).toBeInTheDocument())

    // The entity hit is first in the unified list and selected by default.
    expect(screen.getByText('core-rtr-1').closest('.command-palette-item')).toHaveClass('selected')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    expect(action).not.toHaveBeenCalled()

    // ArrowDown moves past the hits onto the command rows.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByText('core dump').closest('.command-palette-item')).toHaveClass('selected')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(action).toHaveBeenCalled()
  })
})
