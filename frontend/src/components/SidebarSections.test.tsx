import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import SidebarSections, { type SidebarNavItem } from './SidebarSections'

const items: SidebarNavItem[] = [
  { id: 'sessions', label: 'Sessions', icon: <svg />, testId: 'nav-sessions' },
  { id: 'docs', label: 'Documents', icon: <svg /> },
  { id: 'workspaces', label: 'Workspaces', icon: <svg /> },
]

function renderSections(activeId: string, onSelect = vi.fn()) {
  render(<SidebarSections items={items} activeId={activeId} onSelect={onSelect} trailing={<button>Pin</button>} />)
  return { onSelect }
}

afterEach(() => cleanup())

describe('SidebarSections', () => {
  it('renders one option per view with the active one selected', () => {
    renderSections('docs')
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.getAttribute('aria-label'))).toEqual(['Sessions', 'Documents', 'Workspaces'])
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Documents')
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', options[1].id)
  })

  it('selects a row on click', () => {
    const { onSelect } = renderSections('sessions')
    fireEvent.click(screen.getByRole('option', { name: 'Workspaces' }))
    expect(onSelect).toHaveBeenCalledWith('workspaces')
  })

  it('arrow keys move the selection and stop at the ends', () => {
    const { onSelect } = renderSections('sessions')
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('docs')
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('sessions')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(onSelect).toHaveBeenLastCalledWith('docs')
  })

  it('renders trailing controls after the capsule', () => {
    renderSections('sessions')
    expect(screen.getByRole('button', { name: 'Pin' })).toBeInTheDocument()
  })
})
