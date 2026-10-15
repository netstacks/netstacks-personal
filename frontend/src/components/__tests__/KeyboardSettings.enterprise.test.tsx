import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({ mode: 'enterprise', isEnterprise: true, isStandalone: false, hasEnterpriseFeatures: true, isInitialized: true, controllerUrl: 'https://controller.test' }),
}))

import KeyboardSettings from '../KeyboardSettings'
import { useKeyboard } from '../../hooks/useKeyboard'

function Harness() {
  const keyboard = useKeyboard()
  return <KeyboardSettings keyboard={keyboard} />
}

describe('KeyboardSettings in enterprise', () => {
  it('does not list Save Tabs as Group (saved groups need the local agent)', () => {
    render(<Harness />)
    expect(screen.queryByText('Save Tabs as Group')).toBeNull()
    expect(screen.getByText('Group Selected Tabs')).toBeInTheDocument()
  })
})
