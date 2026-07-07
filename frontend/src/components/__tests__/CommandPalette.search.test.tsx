import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../api/search', () => ({
  searchEntities: vi.fn(),
}))

import CommandPalette from '../CommandPalette'
import { searchEntities } from '../../api/search'

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
})
