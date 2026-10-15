import { describe, it, expect } from 'vitest'
import { aiNavigableSettingsTabs, availableSettingsTabs, isSettingsTabAvailable, settingsTabsMatching, SETTINGS_TABS, whenSettingsTab } from '../settingsTabs'
import type { FeatureName } from '../../types/capabilities'
import { useCapabilitiesStore } from '../../stores/capabilitiesStore'
import type { ActiveContext } from '../../commands/types'

const standalone = { isEnterprise: false, hasFeature: () => true }
// The Controller does not emit the local-only feature flags these tabs need.
const ENTERPRISE_FEATURES = new Set<FeatureName>(['local_custom_prompts'])
const enterprise = { isEnterprise: true, hasFeature: (name: FeatureName) => ENTERPRISE_FEATURES.has(name) }

const tabs = (a: typeof standalone) => availableSettingsTabs(a).map(e => e.tab)

describe('settingsTabs', () => {
  it('standalone has every tab except Account', () => {
    expect(tabs(standalone)).toEqual(SETTINGS_TABS.map(e => e.tab).filter(t => t !== 'account'))
  })

  it('enterprise drops the tabs whose backend only the local agent has', () => {
    const available = tabs(enterprise)
    for (const tab of ['snippets', 'profiles', 'jumpHosts', 'tunnels', 'security', 'hostKeys', 'recordings', 'layouts', 'sessionLogs', 'workspaces', 'integrations', 'troubleshooting', 'customCommands'] as const) {
      expect(available).not.toContain(tab)
      expect(isSettingsTabAvailable(tab, enterprise)).toBe(false)
    }
    expect(available).toEqual(['general', 'ai', 'aiEngineer', 'prompts', 'keyboard', 'mappedKeys', 'highlighting', 'enrichment', 'documents', 'clipboard', 'enterprise', 'account'])
  })

  it('search only finds tabs the mode has', () => {
    expect(settingsTabsMatching('tunnel', standalone)).toEqual(new Set(['tunnels']))
    expect(settingsTabsMatching('tunnel', enterprise)).toEqual(new Set())
    expect(settingsTabsMatching('vault', enterprise)).toEqual(new Set())
    expect(settingsTabsMatching('clipboard', enterprise)).toEqual(new Set(['clipboard']))
    expect(settingsTabsMatching('   ', enterprise)).toBeNull()
  })

  it('the AI may open the available tabs except connection and sign-in', () => {
    expect(aiNavigableSettingsTabs(standalone)).not.toContain('enterprise')
    expect(aiNavigableSettingsTabs(standalone)).toContain('tunnels')
    expect(aiNavigableSettingsTabs(enterprise)).toEqual(['general', 'ai', 'aiEngineer', 'prompts', 'keyboard', 'mappedKeys', 'highlighting', 'enrichment', 'documents', 'clipboard'])
  })
})

describe('whenSettingsTab (commands that open a Settings tab)', () => {
  const ctx = (isEnterprise: boolean) => ({ isEnterprise }) as ActiveContext

  it('hides Trusted Host Keys, Saved Layouts and the vault in enterprise; keeps tabs both modes have', () => {
    useCapabilitiesStore.setState({ capabilities: { version: '1.0', license_tier: 'enterprise', features: [] } })
    for (const tab of ['hostKeys', 'layouts', 'security', 'recordings', 'sessionLogs', 'snippets'] as const) {
      expect(whenSettingsTab(tab)(ctx(true))).toBe(false)
      expect(whenSettingsTab(tab)(ctx(false))).toBe(true)
    }
    expect(whenSettingsTab('mappedKeys')(ctx(true))).toBe(true)
  })
})
