import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
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
    const row = screen.getByText('New Terminal').closest<HTMLElement>('.settings-item')!
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, shiftKey: true, bubbles: true }))
    })
    expect(row.querySelector('.keyboard-binding-input')).toHaveValue('Ctrl+Shift+Y')
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+Shift+Y')
    expect(within(row).getByRole('button', { name: 'Reset' })).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Reset' }))
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+T')
  })

  it('refuses a chord another action or a reserved key owns', () => {
    render(<Harness />)
    const row = screen.getByText('New Terminal').closest<HTMLElement>('.settings-item')!
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))
    })
    expect(row.querySelector('.settings-error')?.textContent).toContain('Close Tab')
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }))
    })
    expect(row.querySelector('.settings-error')?.textContent).toContain('Go to Tab 2')
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+T')
  })
})
