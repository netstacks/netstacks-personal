import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import KeyboardSettings from '../KeyboardSettings'
import { useKeyboard, resetAllKeybindings, getCurrentBinding, KEYBOARD_ACTIONS } from '../../hooks/useKeyboard'

function Harness() {
  const keyboard = useKeyboard()
  return <KeyboardSettings keyboard={keyboard} />
}

beforeEach(() => {
  localStorage.clear()
  resetAllKeybindings()
})

describe('KeyboardSettings', () => {
  it('renders every action, including the Sessions and Documents categories', () => {
    render(<Harness />)
    for (const a of KEYBOARD_ACTIONS) expect(screen.getByText(a.label)).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
  })

  it('records a chord, saves it to the shared store, and shows Reset', () => {
    render(<Harness />)
    const row = screen.getByText('New Terminal').closest('.keyboard-action-item')!
    fireEvent.click(row.querySelector('.keyboard-btn-edit')!)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, shiftKey: true, bubbles: true }))
    })
    expect(row.querySelector('.keyboard-binding-input')).toHaveValue('Ctrl+Shift+Y')
    fireEvent.click(row.querySelector('.keyboard-btn-save')!)
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+Shift+Y')
    expect(row.querySelector('.keyboard-btn-reset')).toBeInTheDocument()
    fireEvent.click(row.querySelector('.keyboard-btn-reset')!)
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+T')
  })

  it('refuses a chord another action or a reserved key owns', () => {
    render(<Harness />)
    const row = screen.getByText('New Terminal').closest('.keyboard-action-item')!
    fireEvent.click(row.querySelector('.keyboard-btn-edit')!)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))
    })
    expect(row.querySelector('.keyboard-conflict')?.textContent).toContain('Close Tab')
    expect(row.querySelector('.keyboard-btn-save')).toBeDisabled()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }))
    })
    expect(row.querySelector('.keyboard-conflict')?.textContent).toContain('Go to Tab 2')
    expect(row.querySelector('.keyboard-btn-save')).toBeDisabled()
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+T')
  })
})
