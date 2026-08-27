import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import Switch from '../Switch'

describe('Switch', () => {
  it('renders an accessible switch reflecting `checked`', () => {
    render(<Switch checked={true} onChange={() => {}} label="Copy on Select" />)
    const input = screen.getByRole('switch', { name: 'Copy on Select' })
    expect(input).toBeChecked()
    expect(input).toHaveAttribute('aria-checked', 'true')
  })

  it('reports the new value on change', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} label="Line Numbers" />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not fire when disabled', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} disabled label="AI Button" />)
    const input = screen.getByRole('switch')
    expect(input).toBeDisabled()
    fireEvent.click(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the input in the tab order (not display:none)', () => {
    render(<Switch checked={false} onChange={() => {}} label="Glass" />)
    const input = screen.getByRole('switch')
    expect(input).not.toHaveAttribute('tabindex', '-1')
    input.focus()
    expect(document.activeElement).toBe(input)
  })

  it('applies the small size class', () => {
    const { container } = render(<Switch checked={false} onChange={() => {}} size="sm" />)
    expect(container.querySelector('.ns-switch')).toHaveClass('ns-switch-sm')
  })
})
