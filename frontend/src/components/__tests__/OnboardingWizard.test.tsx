import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

// Avoid hitting the real API client at import time.
vi.mock('../../api/ai', () => ({
  storeAiApiKey: vi.fn(),
  setAiConfig: vi.fn(),
  testAiConnection: vi.fn(async () => ({ success: true, message: 'ok' })),
}))

import OnboardingWizard from '../OnboardingWizard'

afterEach(cleanup)

describe('OnboardingWizard', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<OnboardingWizard isOpen={false} onClose={() => {}} onOpenIntegrations={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('opens on the Welcome step and can advance to AI setup', () => {
    render(<OnboardingWizard isOpen onClose={() => {}} onOpenIntegrations={() => {}} />)
    expect(screen.getByText(/Welcome to NetStacks/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }))
    expect(screen.getByText(/Set up the AI assistant/i)).toBeTruthy()
  })

  it('Skip setup calls onClose (marks setup complete)', () => {
    const onClose = vi.fn()
    render(<OnboardingWizard isOpen onClose={onClose} onOpenIntegrations={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip setup/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
