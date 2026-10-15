import { useState, useMemo, useEffect } from 'react'
import './SettingsPanel.css'
import SearchField from './SearchField'
import KeyboardSettings from './KeyboardSettings'
import ProfilesTab from './ProfilesTab'
import VaultSettings from './VaultSettings'
import EnterpriseProfilesTab from './EnterpriseProfilesTab'
import IntegrationsTab from './IntegrationsTab'
import AISettingsTab from './AISettingsTab'
import AIEngineerSettingsTab from './AIEngineerSettingsTab'
import EnterpriseProfileSelector from './EnterpriseProfileSelector'
import PromptsSettingsTab from './PromptsSettingsTab'
import SnippetsSettingsTab from './SnippetsSettingsTab'
import CustomCommandsSettingsTab from './CustomCommandsSettingsTab'
import SettingsHighlighting from './SettingsHighlighting'
import SettingsEnrichment from './SettingsEnrichment'
import SettingsDocuments from './SettingsDocuments'
import SettingsHostnames from './SettingsHostnames'
import StatusBarSettingsPanel from './StatusBarSettings'
import SettingsMappedKeys from './SettingsMappedKeys'
import PanelSettingsPanel from './PanelSettings'
import SettingsTroubleshooting from './SettingsTroubleshooting'
import ClipboardSettingsTab from './ClipboardSettingsTab'
import JumpHostsTab from './JumpHostsTab'
import HostKeysTab from './HostKeysTab'
import RecordingsTab from './RecordingsTab'
import LayoutsTab from './LayoutsTab'
import SessionLogsTab from './SessionLogsTab'
import WorkspaceSettingsTab from './WorkspaceSettingsTab'
import { useKeyboard } from '../hooks/useKeyboard'
import { useSettings, type AppSettings } from '../hooks/useSettings'
import { confirmDialog } from './ConfirmDialog'
import { TERMINAL_THEMES } from '../lib/terminalThemes'
import { getAppTheme, setAppTheme, type AppTheme } from '../lib/appTheme'
import { getPlatform, type Platform } from '../utils/platform'
import { desktopChrome } from '../lib/nativeWindow'
import { useMode } from '../hooks/useMode'
import { useAuthStore } from '../stores/authStore'
import { featureEnabled, useCapabilitiesStore } from '../stores/capabilitiesStore'
import type { FeatureName } from '../types/capabilities'
import { getCertStatus, type CertStatus } from '../api/cert'
import SettingsConnection from './SettingsConnection'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import SettingsTunnels from './SettingsTunnels'
import Switch from './Switch'
import { availableSettingsTabs, settingsTabsMatching } from '../lib/settingsTabs'
import { DEFAULT_STATUS_BAR_SETTINGS, saveStatusBarSettings } from '../api/statusBarSettings'
import { resetPanelSettings } from '../api/panelSettings'

interface Setting {
  id: string
  category: string
  label: string
  description: string
  type: 'boolean' | 'string' | 'number' | 'select' | 'segmented'
  value: unknown
  options?: { label: string; value: string }[]
  /** For type: 'number' — min/max/step passed to <input>. Optional;
   *  callers should provide sensible bounds so users can't spinner the
   *  Font Size to 9999 (audit P1-17). */
  min?: number
  max?: number
  step?: number
  /** Only shown on these platforms (default: all). */
  platforms?: Platform[]
  /** Only shown in the desktop app (lib/nativeWindow desktopChrome), not the browser build. */
  desktopOnly?: boolean
}

export type { SettingsTab } from '../types/settingsTab'
import type { SettingsTab } from '../types/settingsTab'

interface SettingsPanelProps {
  onSettingChange?: (id: string, value: unknown) => void
  initialTab?: SettingsTab
}

// Default settings configuration - only includes settings that are actually functional
const defaultSettings: Setting[] = [
  // Appearance
  {
    // Not part of useSettings/AppSettings: persisted separately under the
    // `netstacks.appTheme` localStorage key (lib/appTheme.ts) because it
    // must be readable before React mounts (main.tsx applies it pre-paint
    // to avoid a theme flash, including in popout windows).
    id: 'ui.appTheme',
    category: 'Appearance',
    label: 'Theme',
    description: 'System follows your OS light/dark appearance. Light (Deep) uses soft slate greys and keeps the activity bar dark.',
    type: 'segmented',
    value: 'system',
    options: [
      { label: 'System', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Light (Deep)', value: 'light-deep' },
      { label: 'Dark', value: 'dark' },
    ],
  },
  {
    id: 'fontSize',
    category: 'Appearance',
    label: 'Font Size',
    description: 'Controls the base font size in pixels for the entire application',
    type: 'number',
    value: 13,
    // Hard bounds prevent absurd settings (font-size: -5 hides UI,
    // font-size: 99999 explodes layout). Range covers comfortable
    // reading on every supported display size.
    min: 8,
    max: 32,
    step: 1,
  },
  {
    id: 'fontFamily',
    category: 'Appearance',
    label: 'Font Family',
    description: 'Controls the font family for the entire application UI',
    type: 'select',
    value: '',
    options: [
      { label: 'System Default', value: '' },
      { label: 'VS Code (Segoe UI)', value: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif" },
      { label: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
      { label: 'Inter', value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" },
      { label: 'SF Mono', value: "'SF Mono', Menlo, Monaco, monospace" },
      { label: 'Menlo', value: 'Menlo, Monaco, Consolas, monospace' },
      { label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, Monaco, monospace" },
      { label: 'Fira Code', value: "'Fira Code', Menlo, Monaco, monospace" },
    ],
  },
  {
    id: 'editor.fontSize',
    category: 'Appearance',
    label: 'Editor Font Size',
    description: 'Text size in pixels for the document, script and config editors',
    type: 'number',
    value: 13,
    min: 8,
    max: 32,
    step: 1,
  },
  // Terminal
  {
    id: 'terminal.fontSize',
    category: 'Terminal',
    label: 'Terminal Font Size',
    description: 'Text size in pixels for terminal sessions (Ctrl/Cmd+scroll zooms a single tab). Sessions with their own font setting override this.',
    type: 'number',
    value: 14,
    min: 8,
    max: 32,
    step: 1,
  },
  {
    id: 'terminal.fontFamily',
    category: 'Terminal',
    label: 'Terminal Font Family',
    description: 'Monospace face for terminal sessions. Sessions with their own font setting override this.',
    type: 'select',
    value: '',
    options: [
      { label: 'System Default', value: '' },
      { label: 'Menlo', value: 'Menlo, Monaco, Consolas, monospace' },
      { label: 'SF Mono', value: "'SF Mono', Menlo, Monaco, monospace" },
      { label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, Monaco, monospace" },
      { label: 'Fira Code', value: "'Fira Code', Menlo, Monaco, monospace" },
      { label: 'Cascadia Code', value: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
      { label: 'Source Code Pro', value: "'Source Code Pro', Menlo, Monaco, monospace" },
      { label: 'Consolas', value: 'Consolas, Menlo, Monaco, monospace' },
    ],
  },
  {
    id: 'terminal.defaultTheme',
    category: 'Terminal',
    label: 'Default Theme',
    description: 'Default color theme for new terminal sessions',
    type: 'select',
    value: 'default',
    options: TERMINAL_THEMES.map(t => ({ label: t.name, value: t.id })),
  },
  {
    id: 'terminal.copyOnSelect',
    category: 'Terminal',
    label: 'Copy on Select',
    description: 'Automatically copy selected text to clipboard (SecureCRT-style)',
    type: 'boolean',
    value: false,
  },
  {
    id: 'terminal.middleClickPaste',
    category: 'Terminal',
    label: 'Middle-Click Paste',
    description: 'Paste the clipboard on middle mouse click (SecureCRT-style). Ignored while the remote app is using the mouse (vim, htop, ...)',
    type: 'boolean',
    value: true,
  },
  {
    id: 'guard.enabled',
    category: 'Terminal',
    label: 'Session Guard (applies to new sessions)',
    description: 'Recognise commands that would sever your own SSH session (e.g. shutting the uplink it rides on). Cisco IOS flavor, standalone sessions only in this preview. Sessions already open keep the setting they connected with.',
    type: 'boolean',
    value: false,
  },
  {
    id: 'guard.mode',
    category: 'Terminal',
    label: 'Session Guard Mode (applies to new sessions)',
    description: 'Dry run evaluates every command and writes a local trace record without ever holding anything. Enforce holds a severing command and asks before sending it. Takes effect on the next connect.',
    type: 'select',
    value: 'dry-run',
    options: [
      { label: 'Dry run (trace only)', value: 'dry-run' },
      { label: 'Enforce (hold and ask)', value: 'enforce' },
    ],
  },
  {
    id: 'terminal.fontWeight',
    category: 'Terminal',
    label: 'Font Weight',
    description: 'Make terminal text bolder/thicker',
    type: 'select',
    value: 'normal',
    options: [
      { label: 'Normal', value: 'normal' },
      { label: 'Bold', value: 'bold' },
    ],
  },
  {
    id: 'ui.glassEffects',
    category: 'Appearance',
    label: 'Translucent Panels',
    description: 'Translucent, blurred chrome, modals, popovers and AI panels. Turn off for solid, opaque surfaces.',
    type: 'boolean',
    value: true,
    platforms: ['windows', 'linux'],
  },
  {
    id: 'ui.macSourceList',
    category: 'Appearance',
    label: 'Sidebar Navigation List',
    description: 'Show the sidebar views as a list at the top of the sidebar instead of the icon activity bar.',
    type: 'boolean',
    value: true,
    platforms: ['macos'],
    // The browser build always uses the activity bar (it has no app menu for Settings).
    desktopOnly: true,
  },
  {
    id: 'terminal.lineNumbers',
    category: 'Terminal',
    label: 'Line Numbers',
    description: 'Show line numbers in a gutter alongside terminal sessions',
    type: 'boolean',
    value: false,
  },
  {
    id: 'terminal.hoverLookups',
    category: 'Terminal',
    label: 'Hover Lookups',
    description: 'Show a small popup with vendor info when you hover a MAC address, and reverse-DNS when you hover an IP. Same lookups as the right-click menu.',
    type: 'boolean',
    value: true,
  },
  // AUDIT FIX (REMOTE-002): the global "Host Key Checking" toggle was
  // removed. Strict host-key checking is now always on; per-session opt-in
  // is the only remaining escape hatch. The backend rejects any attempt
  // to PUT /settings/ssh.hostKeyChecking with a 400.
]

// Sub-component for the settings sidebar nav rows. 26 near-identical
// button blocks used to live inline in the JSX, each repeating the same
// `settings-nav-item ${active}${dimmed}` className template. Extracted
// here to remove the duplication. Pure refactor — behaviour unchanged.
interface SettingsNavItemProps {
  tab: SettingsTab
  activeTab: SettingsTab
  setActiveTab: (t: SettingsTab) => void
  matchingTabs: Set<SettingsTab> | null
  children: React.ReactNode
}
function SettingsNavItem({ tab, activeTab, setActiveTab, matchingTabs, children }: SettingsNavItemProps) {
  const cls =
    `settings-nav-item ` +
    `${activeTab === tab ? 'active' : ''}` +
    `${matchingTabs && !matchingTabs.has(tab) ? ' dimmed' : ''}`
  return (
    <button className={cls} onClick={() => setActiveTab(tab)}>
      {children}
    </button>
  )
}

export default function SettingsPanel({ onSettingChange, initialTab }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general')

  // Respond to initialTab changes (e.g. when opened from a popover).
  // State adjusted during render (with a prev-value guard) instead of in
  // an effect — the React-recommended pattern; avoids a cascading render.
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab)
  if (initialTab !== prevInitialTab) {
    setPrevInitialTab(initialTab)
    if (initialTab) setActiveTab(initialTab)
  }
  const [search, setSearch] = useState('')
  const keyboard = useKeyboard()
  const { isEnterprise } = useMode()
  const user = useAuthStore(state => state.user)
  const logout = useAuthStore(state => state.logout)
  const capabilities = useCapabilitiesStore((s) => s.capabilities)
  // Tabs this mode has. A tab asked for that isn't one of them (a command,
  // the AI, a stale initialTab) shows General instead of a body whose
  // backend the mode lacks.
  const tabAvailability = { isEnterprise, hasFeature: (name: FeatureName) => featureEnabled(capabilities, name) }
  const availableTabs = availableSettingsTabs(tabAvailability)
  const shownTab: SettingsTab = availableTabs.some(e => e.tab === activeTab) ? activeTab : 'general'

  // Use the persisted settings hook
  const { settings: appSettings, updateSetting, resetSettings } = useSettings()

  // The app theme lives outside useSettings (own localStorage key, read
  // pre-paint in main.tsx) so it is mirrored in local state here.
  const [appTheme, setAppThemeState] = useState<AppTheme>(getAppTheme)

  // Rendered values are derived from the persisted settings rather than a
  // second copy in local state — a copy went stale the moment anything else
  // (Reset, a popout window) wrote to useSettings (NS-SET-2).
  const settings = useMemo<Setting[]>(() =>
    defaultSettings.filter(s => (!s.platforms || s.platforms.includes(getPlatform())) && (!s.desktopOnly || desktopChrome())).map(s => ({
      ...s,
      value: s.id === 'ui.appTheme'
        ? appTheme
        : (appSettings as unknown as Record<string, unknown>)[s.id] ?? s.value
    })),
  [appSettings, appTheme])

  // In-progress text of number inputs, keyed by setting id. Lets the user
  // clear the field while typing without persisting NaN (NS-SET-4); the
  // value is committed once it parses, and clamped to min/max on blur.
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({})

  // Filter and group settings by category
  const filteredSettings = useMemo(() => {
    const searchLower = search.toLowerCase()
    return settings.filter(
      (s) =>
        s.label.toLowerCase().includes(searchLower) ||
        s.description.toLowerCase().includes(searchLower) ||
        s.category.toLowerCase().includes(searchLower) ||
        s.id.toLowerCase().includes(searchLower)
    )
  }, [settings, search])

  // Group by category
  const groupedSettings = useMemo(() => {
    const groups: Record<string, Setting[]> = {}
    for (const setting of filteredSettings) {
      if (!groups[setting.category]) {
        groups[setting.category] = []
      }
      groups[setting.category].push(setting)
    }
    return groups
  }, [filteredSettings])

  // Cross-tab search over the tabs this mode has (lib/settingsTabs).
  const matchingTabs = settingsTabsMatching(search, tabAvailability)

  // Auto-navigate to first matching tab when search changes. Adjusted
  // during render rather than in an effect (guarded — only fires while
  // the active tab is outside the match set, then immediately stabilizes).
  if (matchingTabs && matchingTabs.size > 0 && !matchingTabs.has(activeTab)) {
    const first = availableTabs.find(e => matchingTabs.has(e.tab))
    if (first) setActiveTab(first.tab)
  }

  const handleChange = (id: string, value: unknown) => {
    // Persist to localStorage via useSettings hook
    if (id in appSettings) {
      updateSetting(id as keyof AppSettings, value as AppSettings[keyof AppSettings])
    }
    // App theme: persisted under its own key + applied live (no reload).
    if (id === 'ui.appTheme') {
      setAppTheme(value as AppTheme)
      setAppThemeState(value as AppTheme)
    }
    // AUDIT FIX (REMOTE-002): backend sync of `ssh.hostKeyChecking` removed
    // (the setting itself is gone — strict host-key checking is always on).
    onSettingChange?.(id, value)
  }

  const clampNumber = (setting: Setting, n: number) => {
    const lo = setting.min ?? -Infinity
    const hi = setting.max ?? Infinity
    return Math.min(hi, Math.max(lo, n))
  }

  const handleNumberInput = (setting: Setting, raw: string) => {
    setNumberDrafts(prev => ({ ...prev, [setting.id]: raw }))
    const n = parseInt(raw, 10)
    // Commit only values that are already in range; out-of-range text is
    // usually mid-edit ("1" on the way to "14") and gets clamped on blur.
    if (Number.isFinite(n) && n === clampNumber(setting, n)) handleChange(setting.id, n)
  }

  const handleNumberBlur = (setting: Setting) => {
    const raw = numberDrafts[setting.id]
    setNumberDrafts(prev => {
      const next = { ...prev }
      delete next[setting.id]
      return next
    })
    if (raw === undefined) return
    const n = parseInt(raw, 10)
    if (Number.isFinite(n)) handleChange(setting.id, clampNumber(setting, n))
  }

  const handleSegmentKey = (setting: Setting, e: React.KeyboardEvent) => {
    const options = setting.options ?? []
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0 || options.length === 0) return
    e.preventDefault()
    const index = options.findIndex(o => o.value === setting.value)
    const next = options[(index + step + options.length) % options.length]
    handleChange(setting.id, next.value)
    const group = e.currentTarget as HTMLElement
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }

  const renderSettingItem = (setting: Setting) => {
    if (setting.type === 'segmented') {
      return (
        <SettingRow key={setting.id} label={setting.label} description={setting.description}>
          <div
            className="ns-segmented"
            role="radiogroup"
            aria-label={setting.label}
            onKeyDown={(e) => handleSegmentKey(setting, e)}
          >
            {setting.options?.map((opt) => {
              const checked = opt.value === setting.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  className="ns-segment"
                  onClick={() => handleChange(setting.id, opt.value)}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </SettingRow>
      )
    }

    if (setting.type === 'boolean') {
      return (
        <SettingRow key={setting.id} label={setting.label} description={setting.description}>
          <Switch
            checked={setting.value as boolean}
            onChange={(checked) => handleChange(setting.id, checked)}
            label={setting.label}
          />
        </SettingRow>
      )
    }

    if (setting.type === 'select') {
      return (
        <SettingRow key={setting.id} label={setting.label} description={setting.description}>
          <select aria-label={setting.label}
            className="ns-select setting-select-field"
            value={setting.value as string}
            onChange={(e) => handleChange(setting.id, e.target.value)}
          >
            {setting.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </SettingRow>
      )
    }

    if (setting.type === 'number') {
      return (
        <SettingRow key={setting.id} label={setting.label} description={setting.description}>
          <input aria-label={setting.label}
            type="number"
            className="ns-input setting-input-number"
            value={numberDrafts[setting.id] ?? (setting.value as number)}
            min={setting.min}
            max={setting.max}
            step={setting.step}
            onChange={(e) => handleNumberInput(setting, e.target.value)}
            onBlur={() => handleNumberBlur(setting)}
          />
        </SettingRow>
      )
    }

    return (
      <SettingRow key={setting.id} label={setting.label} description={setting.description} stacked>
        <input data-ai-fill="off" aria-label={setting.label}
          type="text"
          className="ns-input"
          value={setting.value as string}
          onChange={(e) => handleChange(setting.id, e.target.value)}
        />
      </SettingRow>
    )
  }

  return (
    <div className="settings-panel">
      {/* Sidebar navigation */}
      <div className="settings-sidebar">
        {availableTabs.map(entry => (
          <SettingsNavItem key={entry.tab} tab={entry.tab} activeTab={shownTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>{entry.label}</SettingsNavItem>
        ))}
      </div>

      {/* Main content area */}
      <div className="settings-main">
        <div className="settings-search">
          <SearchField value={search} onChange={setSearch} placeholder="Search all settings..." />
        </div>

        {/* One page container for every tab: padding, width and section gap. */}
        <div className="settings-content">

        {/* General settings tab */}
        {shownTab === 'general' && (
          <>
            {Object.keys(groupedSettings).length === 0 ? (
              <p className="form-hint">No settings match your search.</p>
            ) : (
              Object.entries(groupedSettings).map(([category, categorySettings]) => (
                <SettingsSection key={category} title={category}>
                  <div className="settings-group">
                    {categorySettings.map((setting) => renderSettingItem(setting))}
                  </div>
                </SettingsSection>
              ))
            )}

            <StatusBarSettingsPanel />
            <PanelSettingsPanel />
            <SettingsHostnames />

            {/* The setup wizard configures the local agent's AI and
                integrations; the Controller manages those in enterprise. */}
            {!isEnterprise && (
              <SettingsSection
                title="Onboarding"
                description="Walk through AI provider setup, NetBox, and the core concepts again. Also available from the command palette → “Setup Wizard”."
                actions={
                  <button
                    className="ns-btn ns-btn--small"
                    onClick={() => window.dispatchEvent(new CustomEvent('netstacks:open-setup-wizard'))}
                  >
                    Re-run Setup Wizard
                  </button>
                }
              />
            )}

            {/* Reset — last in the tab so it doesn't get clicked by
                mistake before users see what's available to tweak. */}
            <SettingsSection
              title="Reset"
              description="Restore every General-tab setting to its default."
              actions={
                <button
                  className="ns-btn ns-btn--small ns-btn--danger"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Reset all general settings?',
                      body: 'This restores every General-tab setting (theme, font, terminal copy/select, status bar, panel auto-hide) to defaults. AI keys, sessions, profiles, and other tabs are untouched.',
                      confirmLabel: 'Reset',
                      destructive: true,
                    })
                    if (!ok) return
                    // Everything the confirm text promises: useSettings
                    // (font, terminal), the app theme, status bar, panels.
                    resetSettings()
                    setAppTheme('system')
                    setAppThemeState('system')
                    saveStatusBarSettings(DEFAULT_STATUS_BAR_SETTINGS)
                    resetPanelSettings()
                  }}
                >
                  Reset to defaults…
                </button>
              }
            />
          </>
        )}

        {/* AI settings tab */}
        {shownTab === 'ai' && (
          <AISettingsTab />
        )}

        {/* AI Engineer Profile tab */}
        {shownTab === 'aiEngineer' && (
          isEnterprise ? <EnterpriseProfileSelector /> : <AIEngineerSettingsTab />
        )}

        {/* Prompts settings tab */}
        {shownTab === 'prompts' && (
          <PromptsSettingsTab />
        )}

        {/* Snippets settings tab */}
        {shownTab === 'snippets' && (
          <SnippetsSettingsTab />
        )}

        {shownTab === 'customCommands' && (
          <CustomCommandsSettingsTab />
        )}

        {/* Keyboard settings tab */}
        {shownTab === 'keyboard' && (
          <KeyboardSettings keyboard={keyboard} />
        )}

        {/* Mapped Keys settings tab */}
        {shownTab === 'mappedKeys' && (
          <SettingsMappedKeys />
        )}

        {/* Profiles settings tab */}
        {shownTab === 'profiles' && (
          <ProfilesTab />
        )}

        {/* Jump Hosts settings tab */}
        {shownTab === 'jumpHosts' && (
          <JumpHostsTab />
        )}

        {/* Tunnels settings tab */}
        {shownTab === 'tunnels' && (
          <SettingsTunnels />
        )}

        {/* Highlighting settings tab */}
        {shownTab === 'highlighting' && (
          <SettingsHighlighting />
        )}

        {shownTab === 'enrichment' && (
          <SettingsEnrichment />
        )}

        {shownTab === 'documents' && (
          <SettingsDocuments />
        )}

        {/* Security settings tab */}
        {shownTab === 'security' && (
          <VaultSettings />
        )}

        {/* Trusted Hosts (SSH known_hosts) tab */}
        {shownTab === 'hostKeys' && (
          <HostKeysTab />
        )}

        {/* Recordings library */}
        {shownTab === 'layouts' && (
          <LayoutsTab />
        )}
        {shownTab === 'sessionLogs' && (
          <SessionLogsTab />
        )}
        {shownTab === 'recordings' && (
          <RecordingsTab />
        )}

        {/* Workspaces settings tab */}
        {shownTab === 'workspaces' && (
          <WorkspaceSettingsTab />
        )}

        {/* Integrations settings tab */}
        {shownTab === 'integrations' && (
          <IntegrationsTab />
        )}

        {/* Troubleshooting settings tab */}
        {shownTab === 'troubleshooting' && (
          <SettingsTroubleshooting />
        )}

        {/* Clipboard history + paste hygiene */}
        {shownTab === 'clipboard' && (
          <ClipboardSettingsTab />
        )}

        {/* Enterprise tab — visible in both modes */}
        {shownTab === 'enterprise' && (
          isEnterprise ? (
            <SettingsConnection />
          ) : (
            <>
              <SettingsSection
                title="NetStacks Enterprise"
                description="NetStacks Terminal is free and open source. When your team is ready to scale, the NetStacks Enterprise Controller adds:"
                actions={
                  <a
                    href="https://netstacks.net"
                    className="settings-enterprise-link"
                    onClick={async (e) => {
                      e.preventDefault()
                      try {
                        const { open } = await import('@tauri-apps/plugin-shell')
                        await open('https://netstacks.net')
                      } catch {
                        window.open('https://netstacks.net', '_blank', 'noopener,noreferrer')
                      }
                    }}
                  >
                    Learn more at netstacks.net
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden>
                      <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/>
                      <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/>
                    </svg>
                  </a>
                }
              >
                <ul className="settings-enterprise-features">
                  <li>Centralized device inventory and credential management</li>
                  <li>Role-based access control (RBAC) and audit logging</li>
                  <li>Shared network topologies and documentation</li>
                  <li>Method of Procedure (MOP) workflows and change management</li>
                  <li>Service stacks and scheduled automation</li>
                  <li>Shared AI prompts and team knowledge base</li>
                </ul>
              </SettingsSection>
              <SettingsConnection
                help={{
                  topic: 'connecting to a Controller',
                  prompt: 'Explain what connecting NetStacks to an Enterprise Controller changes: shared sessions and profiles, controller-side AI and config backups, SSO login, which local features are disabled, what happens to my local data, and how to switch back to standalone. Then walk me through connecting (URL, TLS/certificate trust) and what to check if it fails.',
                }}
              />
            </>
          )
        )}

        {/* Account settings tab (Enterprise mode only) — TERM-01 Account home:
            consolidates personal auth as stacked sections (account info +
            My Credentials + SSH Certificates). Pure IA: each section renders the
            same component it did when it was a standalone tab. */}
        {shownTab === 'account' && (
          <>
            {/* Section 1 — Account info */}
            <SettingsSection
              title="Your Account"
              actions={<button className="ns-btn ns-btn--small ns-btn--danger" onClick={() => logout()}>Sign Out</button>}
            >
              {user && (
                <div className="settings-group">
                  <SettingRow label="Username"><span>{user.username}</span></SettingRow>
                  <SettingRow label="Auth Provider"><span>{user.auth_provider}</span></SettingRow>
                </div>
              )}
            </SettingsSection>

            {/* Section 2 — My Profiles (profile-centric auth from the controller).
                Profiles are the central auth object in enterprise mode; the
                default profile is what connections use. */}
            <EnterpriseProfilesTab />

            {/* Section 3 — SSH Certificates */}
            <SettingsSection title="SSH Certificate Authentication">
              <SshCertSettings />
            </SettingsSection>
          </>
        )}
        </div>
      </div>
    </div>
  )
}

function SshCertSettings() {
  const [certStatus, setCertStatus] = useState<CertStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCertStatus()
      .then(setCertStatus)
      .catch(() => setCertStatus(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="form-hint">Loading…</p>

  return (
    <div className="settings-group">
      <SettingRow label="Status">
        <span>{certStatus?.valid ? 'Valid' : 'Not available'}</span>
      </SettingRow>
      {certStatus?.expires_at && (
        <SettingRow label="Expires">
          <span>{new Date(certStatus.expires_at).toLocaleString()}</span>
        </SettingRow>
      )}
      {certStatus?.public_key_fingerprint && (
        <SettingRow label="Public Key">
          <span className="settings-item-mono">{certStatus.public_key_fingerprint}</span>
        </SettingRow>
      )}
    </div>
  )
}
