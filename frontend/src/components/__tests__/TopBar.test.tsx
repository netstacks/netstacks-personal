import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TopBar from '../TopBar'

const base = {
  platform: 'windows' as const,
  sidebarOpen: true,
  onToggleSidebar: vi.fn(),
  aiPanelOpen: false,
  onToggleAiPanel: vi.fn(),
  onOpenCommandCenter: vi.fn(),
}

describe('TopBar', () => {
  it('renders the command center button with placeholder text', () => {
    render(<TopBar {...base} />)
    expect(screen.getByTestId('command-center')).toHaveTextContent('Search everything…')
  })

  it('opens the command center on click', () => {
    const onOpen = vi.fn()
    render(<TopBar {...base} onOpenCommandCenter={onOpen} />)
    fireEvent.click(screen.getByTestId('command-center'))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('toggles sidebar and AI panel', () => {
    const onSidebar = vi.fn()
    const onAi = vi.fn()
    render(<TopBar {...base} onToggleSidebar={onSidebar} onToggleAiPanel={onAi} />)
    fireEvent.click(screen.getByTestId('toggle-sidebar-btn'))
    fireEvent.click(screen.getByTestId('toggle-ai-panel-btn'))
    expect(onSidebar).toHaveBeenCalledOnce()
    expect(onAi).toHaveBeenCalledOnce()
  })

  it('reflects active state on toggle buttons via aria-pressed', () => {
    render(<TopBar {...base} sidebarOpen aiPanelOpen={false} />)
    expect(screen.getByTestId('toggle-sidebar-btn')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('toggle-ai-panel-btn')).toHaveAttribute('aria-pressed', 'false')
  })

  it('adds macos padding class only on macOS', () => {
    const { rerender, container } = render(<TopBar {...base} platform="macos" />)
    expect(container.querySelector('.topbar.is-macos')).not.toBeNull()
    rerender(<TopBar {...base} platform="windows" />)
    expect(container.querySelector('.topbar.is-macos')).toBeNull()
  })
})
