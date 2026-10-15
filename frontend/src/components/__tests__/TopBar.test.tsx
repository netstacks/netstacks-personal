import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TopBar from '../TopBar'

const base = {
  platform: 'windows' as const,
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

  it('adds macos padding class only on macOS', () => {
    const { rerender, container } = render(<TopBar {...base} platform="macos" />)
    expect(container.querySelector('.topbar.is-macos')).not.toBeNull()
    rerender(<TopBar {...base} platform="windows" />)
    expect(container.querySelector('.topbar.is-macos')).toBeNull()
  })

  it('shows the clipboard-history button only when a handler is given', () => {
    const onClip = vi.fn()
    const { rerender } = render(<TopBar {...base} />)
    expect(screen.queryByTestId('clipboard-history-btn')).toBeNull()
    rerender(<TopBar {...base} onOpenClipboardHistory={onClip} />)
    fireEvent.click(screen.getByTestId('clipboard-history-btn'))
    expect(onClip).toHaveBeenCalledOnce()
  })
})
