import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ login: vi.fn(), isLoading: false, error: null, clearError: vi.fn() }),
}))

import { LoginScreen } from './LoginScreen'

describe('LoginScreen', () => {
  it('uses the large hero fields and button, like the vault gate', () => {
    render(<LoginScreen />)
    expect(screen.getByLabelText('Username')).toHaveClass('ns-input', 'ns-input--large')
    expect(screen.getByLabelText('Password')).toHaveClass('ns-input', 'ns-input--large')
    expect(screen.getByRole('button', { name: 'Sign In' })).toHaveClass('ns-btn', 'ns-btn--large', 'ns-btn--primary')
  })
})
