import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import SettingsSection from './SettingsSection'
import { getSettings, setGlobalSettings } from '../../hooks/useSettings'

const base = getSettings()

afterEach(() => {
  cleanup()
  setGlobalSettings(base)
})

describe('SettingsSection', () => {
  it('renders the title, description and body', () => {
    render(
      <SettingsSection title="Jump Hosts" description="Bastion servers.">
        <p>body</p>
      </SettingsSection>,
    )
    expect(screen.getByRole('heading', { name: 'Jump Hosts' })).toBeInTheDocument()
    expect(screen.getByText('Bastion servers.')).toHaveClass('form-hint')
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('puts Ask AI first in the header actions, before the section action', () => {
    setGlobalSettings({ ...base, 'ai.contextualHelp.enabled': true })
    const { container } = render(
      <SettingsSection
        title="Jump Hosts"
        help={{ topic: 'jump hosts', prompt: 'help' }}
        actions={<button className="ns-btn ns-btn--small">+ Add jump host</button>}
      />,
    )
    const actions = container.querySelector('.settings-section-actions') as HTMLElement
    expect(within(actions).getAllByRole('button').map(b => b.textContent)).toEqual(['Ask AI', '+ Add jump host'])
  })

  it('renders no action group when there is nothing to show', () => {
    const { container } = render(<SettingsSection title="Plain" />)
    expect(container.querySelector('.settings-section-actions')).toBeNull()
  })
})
