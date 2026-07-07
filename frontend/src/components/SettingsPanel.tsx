import { useState, useMemo, useEffect } from 'react'
import './SettingsPanel.css'
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
import QuickActionsPanel from './QuickActionsPanel'
import SettingsHighlighting from './SettingsHighlighting'
import SettingsEnrichment from './SettingsEnrichment'
import SettingsDocuments from './SettingsDocuments'
import SettingsHostnames from './SettingsHostnames'
import StatusBarSettingsPanel from './StatusBarSettings'
import SettingsMappedKeys from './SettingsMappedKeys'
import PanelSettingsPanel from './PanelSettings'
import SettingsTroubleshooting from './SettingsTroubleshooting'
import JumpHostsTab from './JumpHostsTab'
import HostKeysTab from './HostKeysTab'
import RecordingsTab from './RecordingsTab'
import LayoutsTab from './LayoutsTab'
import SessionLogsTab from './SessionLogsTab'
import ApiResourcesTab from './ApiResourcesTab'
import WorkspaceSettingsTab from './WorkspaceSettingsTab'
import { useKeyboard } from '../hooks/useKeyboard'
import { useSettings, type AppSettings } from '../hooks/useSettings'
import { confirmDialog } from './ConfirmDialog'
import { TERMINAL_THEMES } from '../lib/terminalThemes'
import { getAppTheme, setAppTheme, type AppTheme } from '../lib/appTheme'
import { useMode } from '../hooks/useMode'
import { useAuthStore } from '../stores/authStore'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import { getCertStatus, type CertStatus } from '../api/cert'
import SettingsConnection from './SettingsConnection'
import SettingsTunnels from './SettingsTunnels'

interface Setting {
  id: string
  category: string
  label: string
  description: string
  type: 'boolean' | 'string' | 'number' | 'select'
  value: unknown
  options?: { label: string; value: string }[]
  /** For type: 'number' — min/max/step passed to <input>. Optional;
   *  callers should provide sensible bounds so users can't spinner the
   *  Font Size to 9999 (audit P1-17). */
  min?: number
  max?: number
  step?: number
}

export type SettingsTab = 'general' | 'ai' | 'aiEngineer' | 'prompts' | 'snippets' | 'customCommands' | 'quickCalls' | 'keyboard' | 'mappedKeys' | 'profiles' | 'jumpHosts' | 'tunnels' | 'highlighting' | 'enrichment' | 'documents' | 'security' | 'hostKeys' | 'recordings' | 'layouts' | 'sessionLogs' | 'integrations' | 'apiResources' | 'troubleshooting' | 'enterprise' | 'account' | 'workspaces'

interface SettingsPanelProps {
  onSettingChange?: (id: string, value: unknown) => void
  initialTab?: SettingsTab
  /** Open a Quick Call result as a new "API: <name>" tab. Wired from App.tsx. */
  onOpenApiResponseTab?: (title: string, result: import('../types/quickAction').QuickActionResult) => void
}

// Tab keyword registry for cross-tab search
const TAB_SEARCH_INDEX: { tab: SettingsTab; label: string; keywords: string[] }[] = [
  { tab: 'general', label: 'General', keywords: ['font', 'size', 'family', 'theme', 'terminal', 'copy', 'select', 'appearance', 'status bar', 'panels', 'weight', 'ssh', 'host key', 'known hosts'] },
  { tab: 'ai', label: 'AI', keywords: ['ai', 'provider', 'anthropic', 'openai', 'ollama', 'openrouter', 'litellm', 'model', 'mcp', 'server', 'tools', 'agent', 'highlighting', 'token', 'sanitization', 'sanitize', 'suggestions', 'autocomplete', 'next step', 'enabled providers', 'config changes', 'configuration changes'] },
  { tab: 'aiEngineer', label: 'AI Engineer', keywords: ['ai engineer', 'profile', 'personality', 'behavior', 'vendor', 'autonomy', 'onboarding', 'safety rules', 'troubleshooting', 'verbosity'] },
  { tab: 'prompts', label: 'Prompts', keywords: ['prompt', 'custom prompt', 'system prompt'] },
  { tab: 'snippets', label: 'Snippets', keywords: ['snippet', 'text expansion', 'shortcut'] },
  { tab: 'customCommands', label: 'Custom Actions', keywords: ['custom command', 'custom action', 'alias', 'macro', 'script'] },
  { tab: 'quickCalls', label: 'Quick Calls', keywords: ['quick', 'call', 'api', 'request', 'action', 'endpoint'] },
  { tab: 'keyboard', label: 'Keyboard', keywords: ['keyboard', 'shortcut', 'keybinding', 'hotkey', 'key'] },
  { tab: 'mappedKeys', label: 'Mapped Keys', keywords: ['mapped key', 'key mapping', 'remap'] },
  { tab: 'profiles', label: 'Profiles', keywords: ['profile', 'connection', 'ssh', 'telnet'] },
  { tab: 'jumpHosts', label: 'Jump Hosts', keywords: ['jump host', 'bastion', 'proxy', 'hop'] },
  { tab: 'tunnels', label: 'Tunnels', keywords: ['tunnel', 'ssh tunnel', 'port forward', 'socks', 'proxy'] },
  { tab: 'highlighting', label: 'Highlighting', keywords: ['highlight', 'color', 'pattern', 'regex', 'rule'] },
  { tab: 'enrichment', label: 'Enrichment', keywords: ['enrichment', 'hover', 'popover', 'matcher', 'source', 'netbox', 'crawler', 'oui', 'dns', 'interface', 'mac', 'ip', 'vendor'] },
  { tab: 'documents', label: 'Documents', keywords: ['document', 'docs', 'save', 'category', 'folder', 'enrichment', 'markdown', 'snapshot', 'backup', 'mop', 'troubleshooting', 'auto-save', 'where', 'location'] },
  { tab: 'security', label: 'Security', keywords: ['security', 'vault', 'credential', 'password', 'encryption'] },
  { tab: 'hostKeys', label: 'Trusted Hosts', keywords: ['host key', 'known hosts', 'ssh', 'tofu', 'trust', 'fingerprint', 'revoke', 'mitm'] },
  { tab: 'recordings', label: 'Recordings', keywords: ['recording', 'asciicast', 'session', 'capture', 'playback', 'replay'] },
  { tab: 'layouts', label: 'Layouts', keywords: ['layout', 'tab', 'split', 'arrangement', 'saved'] },
  { tab: 'sessionLogs', label: 'Session Logs', keywords: ['log', 'session', 'capture', 'output', 'transcript'] },
  { tab: 'integrations', label: 'Integrations', keywords: ['integration', 'netbox', 'netstacksCrawler', 'librenms'] },
  { tab: 'apiResources', label: 'API Resources', keywords: ['api', 'resource', 'quick', 'action', 'endpoint', 'solarwinds', 'prtg', 'http', 'rest'] },
  { tab: 'troubleshooting', label: 'Troubleshooting', keywords: ['troubleshoot', 'recording', 'session', 'capture'] },
  { tab: 'enterprise', label: 'Enterprise', keywords: ['enterprise', 'controller', 'team', 'url', 'connect', 'tls', 'certificate', 'netstacks'] },
  // Account consolidates personal auth: account info + My Credentials + SSH
  // Certificates now live as sections under this single tab (TERM-01), so the
  // credential/cert keywords route here instead of to standalone tabs.
  { tab: 'account', label: 'Account', keywords: ['account', 'controller', 'username', 'sign out', 'logout', 'credential', 'password', 'secret', 'ssh', 'certificate', 'cert', 'ca', 'public key'] },
  { tab: 'workspaces', label: 'Workspaces', keywords: ['workspace', 'git', 'accounts', 'github', 'gitlab', 'ai', 'tool', 'auto-launch', 'terminal', 'explorer', 'default'] },
]

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
    description: 'Color theme for the application UI. Dark is the default; Light keeps the activity bar and status bar dark to anchor the layout.',
    type: 'select',
    value: 'dark',
    options: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
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
    value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    options: [
      { label: 'System Default', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif" },
      { label: 'VS Code (Segoe UI)', value: "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif" },
      { label: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
      { label: 'Inter', value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" },
      { label: 'SF Mono', value: "'SF Mono', Menlo, Monaco, monospace" },
      { label: 'Menlo', value: 'Menlo, Monaco, Consolas, monospace' },
      { label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, Monaco, monospace" },
      { label: 'Fira Code', value: "'Fira Code', Menlo, Monaco, monospace" },
    ],
  },
  // Terminal
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
    label: 'Glass Effects',
    description: 'Translucent, blurred "liquid glass" look for chrome, modals, popovers and the AI panels. Turn off for solid, opaque surfaces.',
    type: 'boolean',
    value: true,
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

export default function SettingsPanel({ onSettingChange, initialTab, onOpenApiResponseTab }: SettingsPanelProps) {
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
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature)

  // Use the persisted settings hook
  const { settings: appSettings, updateSetting, resetSettings } = useSettings()

  // Initialize local settings state with persisted values. The app theme
  // lives outside useSettings (own localStorage key, read pre-paint in
  // main.tsx) so it is hydrated from lib/appTheme instead.
  const [settings, setSettings] = useState<Setting[]>(() =>
    defaultSettings.map(s => ({
      ...s,
      value: s.id === 'ui.appTheme'
        ? getAppTheme()
        : (appSettings as unknown as Record<string, unknown>)[s.id] ?? s.value
    }))
  )

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

  // Cross-tab search: find which tabs match the current search query
  const matchingTabs = useMemo(() => {
    if (!search.trim()) return null
    const q = search.toLowerCase()
    const matched = new Set<SettingsTab>()
    for (const entry of TAB_SEARCH_INDEX) {
      if (
        entry.label.toLowerCase().includes(q) ||
        entry.keywords.some(kw => kw.includes(q))
      ) {
        matched.add(entry.tab)
      }
    }
    return matched
  }, [search])

  // Auto-navigate to first matching tab when search changes. Adjusted
  // during render rather than in an effect (guarded — only fires while
  // the active tab is outside the match set, then immediately stabilizes).
  if (matchingTabs && matchingTabs.size > 0 && !matchingTabs.has(activeTab)) {
    const first = TAB_SEARCH_INDEX.find(e => matchingTabs.has(e.tab))
    if (first) setActiveTab(first.tab)
  }

  const handleChange = (id: string, value: unknown) => {
    // Update local state for UI
    setSettings((prev) =>
      prev.map((s) => (s.id === id ? { ...s, value } : s))
    )
    // Persist to localStorage via useSettings hook
    if (id in appSettings) {
      updateSetting(id as keyof AppSettings, value as AppSettings[keyof AppSettings])
    }
    // App theme: persisted under its own key + applied live (no reload).
    if (id === 'ui.appTheme') {
      setAppTheme(value as AppTheme)
    }
    // AUDIT FIX (REMOTE-002): backend sync of `ssh.hostKeyChecking` removed
    // (the setting itself is gone — strict host-key checking is always on).
    onSettingChange?.(id, value)
  }

  const renderSettingItem = (setting: Setting) => {
    // For boolean and select, put control on same line as label
    if (setting.type === 'boolean' || setting.type === 'select' || setting.type === 'number') {
      return (
        <div key={setting.id} className="setting-item">
          <div className="setting-header">
            <span className="setting-label">{setting.label}</span>
            <div className="setting-control">
              {setting.type === 'boolean' && (
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={setting.value as boolean}
                    onChange={(e) => handleChange(setting.id, e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              )}
              {setting.type === 'select' && (
                <select
                  className="setting-select"
                  value={setting.value as string}
                  onChange={(e) => handleChange(setting.id, e.target.value)}
                >
                  {setting.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
              {setting.type === 'number' && (
                <input
                  type="number"
                  className="setting-input setting-input-number"
                  value={setting.value as number}
                  min={setting.min}
                  max={setting.max}
                  step={setting.step}
                  onChange={(e) => handleChange(setting.id, parseInt(e.target.value, 10))}
                />
              )}
            </div>
          </div>
          <div className="setting-description">{setting.description}</div>
        </div>
      )
    }

    // For string inputs, put input below
    return (
      <div key={setting.id} className="setting-item">
        <div className="setting-label">{setting.label}</div>
        <div className="setting-description">{setting.description}</div>
        <div className="setting-control-block">
          <input
            type="text"
            className="setting-input"
            value={setting.value as string}
            onChange={(e) => handleChange(setting.id, e.target.value)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      {/* Sidebar navigation */}
      <div className="settings-sidebar">
        <SettingsNavItem tab="general" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>General</SettingsNavItem>
        <SettingsNavItem tab="ai" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>AI</SettingsNavItem>
        <SettingsNavItem tab="aiEngineer" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>AI Engineer</SettingsNavItem>
        {hasFeature('local_custom_prompts') && (
        <SettingsNavItem tab="prompts" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Prompts</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="snippets" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Snippets</SettingsNavItem>
        )}
        {hasFeature('local_integrations') && (
        <SettingsNavItem tab="customCommands" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Custom Actions</SettingsNavItem>
        )}
        {hasFeature('local_integrations') && (
        <SettingsNavItem tab="quickCalls" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Quick Calls</SettingsNavItem>
        )}
        <SettingsNavItem tab="keyboard" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Keyboard</SettingsNavItem>
        <SettingsNavItem tab="mappedKeys" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Mapped Keys</SettingsNavItem>
        {!isEnterprise && (
          <SettingsNavItem tab="profiles" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Profiles</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="jumpHosts" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Jump Hosts</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="tunnels" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Tunnels</SettingsNavItem>
        )}
        <SettingsNavItem tab="highlighting" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Highlighting</SettingsNavItem>
        {/* Enrichment works in both modes — the controller implements the
            enrichment subsystem (matchers/sources/runtime) at parity with the agent. */}
        <SettingsNavItem tab="enrichment" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Enrichment</SettingsNavItem>
        {/* Documents auto-save targets work in both modes (client-side category resolution). */}
        <SettingsNavItem tab="documents" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Documents</SettingsNavItem>
        {!isEnterprise && (
          <SettingsNavItem tab="security" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Security</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="hostKeys" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Trusted Hosts</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="recordings" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Recordings</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="layouts" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Layouts</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="sessionLogs" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Session Logs</SettingsNavItem>
        )}
        {!isEnterprise && (
          <SettingsNavItem tab="workspaces" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Workspaces</SettingsNavItem>
        )}
        {!isEnterprise && hasFeature('local_integrations') && (
          <SettingsNavItem tab="integrations" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Integrations</SettingsNavItem>
        )}
        {hasFeature('local_integrations') && (
          <SettingsNavItem tab="apiResources" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>API Resources</SettingsNavItem>
        )}
        {/* Troubleshooting recorder settings are localStorage-only (no controller
            backing), and its sibling local-recording tabs (Recordings, Session
            Logs) are already standalone-only — hide it in enterprise too. */}
        {!isEnterprise && hasFeature('local_session_recording') && (
        <SettingsNavItem tab="troubleshooting" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Troubleshooting</SettingsNavItem>
        )}
        <SettingsNavItem tab="enterprise" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Enterprise</SettingsNavItem>
        {isEnterprise && (
          <SettingsNavItem tab="account" activeTab={activeTab} setActiveTab={setActiveTab} matchingTabs={matchingTabs}>Account</SettingsNavItem>
        )}
      </div>

      {/* Main content area */}
      <div className="settings-main">
        <div className="settings-search">
          <input
            type="search"
            placeholder="Search all settings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="settings-search-input"
          />
        </div>

        {/* General settings tab */}
        {activeTab === 'general' && (
          <>
            <div className="settings-content">
              {Object.keys(groupedSettings).length === 0 ? (
                <div className="settings-empty">No settings found</div>
              ) : (
                Object.entries(groupedSettings).map(([category, categorySettings]) => (
                  <div key={category} className="settings-category">
                    <h3 className="settings-category-title">{category}</h3>
                    {categorySettings.map((setting) => renderSettingItem(setting))}
                  </div>
                ))
              )}

              {/* Status Bar Customization */}
              <div className="settings-category">
                <h3 className="settings-category-title">Status Bar</h3>
                <StatusBarSettingsPanel />
              </div>

              {/* Panel Auto-Hide Behavior */}
              <div className="settings-category">
                <h3 className="settings-category-title">Panels</h3>
                <PanelSettingsPanel />
              </div>

              {/* Hostname Display */}
              <div className="settings-category">
                <SettingsHostnames />
              </div>

              {/* Onboarding — re-open the first-run setup wizard on demand */}
              <div className="settings-category">
                <h3 className="settings-category-title">Onboarding</h3>
                <button
                  className="btn-secondary"
                  onClick={() => window.dispatchEvent(new CustomEvent('netstacks:open-setup-wizard'))}
                >
                  Re-run Setup Wizard
                </button>
                <p className="settings-note">
                  Walk through AI provider setup, NetBox, and the core concepts again.
                  (Also available from the command palette → “Setup Wizard”.)
                </p>
              </div>

              {/* Reset — last in the tab so it doesn't get clicked by
                  mistake before users see what's available to tweak. */}
              <div className="settings-category">
                <h3 className="settings-category-title">Reset</h3>
                <button
                  className="btn-danger"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Reset all general settings?',
                      body: 'This restores every General-tab setting (theme, font, terminal copy/select, status bar, panel auto-hide) to defaults. AI keys, sessions, profiles, and other tabs are untouched.',
                      confirmLabel: 'Reset',
                      destructive: true,
                    })
                    if (ok) resetSettings()
                  }}
                >
                  Reset to defaults…
                </button>
              </div>
            </div>
          </>
        )}

        {/* AI settings tab */}
        {activeTab === 'ai' && (
          <AISettingsTab />
        )}

        {/* AI Engineer Profile tab */}
        {activeTab === 'aiEngineer' && (
          isEnterprise ? <EnterpriseProfileSelector /> : <AIEngineerSettingsTab />
        )}

        {/* Prompts settings tab */}
        {activeTab === 'prompts' && (
          <PromptsSettingsTab />
        )}

        {/* Snippets settings tab */}
        {activeTab === 'snippets' && (
          <SnippetsSettingsTab />
        )}

        {activeTab === 'customCommands' && (
          <CustomCommandsSettingsTab />
        )}

        {/* Quick Calls tab — onOpenApiResponseTab is wired from App.tsx so
            clicking "Open in tab" on a result actually opens the tab. */}
        {activeTab === 'quickCalls' && (
          <QuickActionsPanel onOpenResultTab={onOpenApiResponseTab ?? (() => { /* no-op when host doesn't supply a handler */ })} />
        )}

        {/* Keyboard settings tab */}
        {activeTab === 'keyboard' && (
          <KeyboardSettings keyboard={keyboard} />
        )}

        {/* Mapped Keys settings tab */}
        {activeTab === 'mappedKeys' && (
          <SettingsMappedKeys />
        )}

        {/* Profiles settings tab */}
        {activeTab === 'profiles' && (
          <ProfilesTab />
        )}

        {/* Jump Hosts settings tab */}
        {activeTab === 'jumpHosts' && (
          <JumpHostsTab />
        )}

        {/* Tunnels settings tab */}
        {activeTab === 'tunnels' && (
          <SettingsTunnels />
        )}

        {/* Highlighting settings tab */}
        {activeTab === 'highlighting' && (
          <SettingsHighlighting />
        )}

        {activeTab === 'enrichment' && (
          <SettingsEnrichment />
        )}

        {activeTab === 'documents' && (
          <SettingsDocuments />
        )}

        {/* Security settings tab */}
        {activeTab === 'security' && (
          <VaultSettings />
        )}

        {/* Trusted Hosts (SSH known_hosts) tab */}
        {activeTab === 'hostKeys' && (
          <HostKeysTab />
        )}

        {/* Recordings library */}
        {activeTab === 'layouts' && (
          <LayoutsTab />
        )}
        {activeTab === 'sessionLogs' && (
          <SessionLogsTab />
        )}
        {activeTab === 'recordings' && (
          <RecordingsTab />
        )}

        {/* Workspaces settings tab */}
        {activeTab === 'workspaces' && (
          <WorkspaceSettingsTab />
        )}

        {/* Integrations settings tab */}
        {activeTab === 'integrations' && (
          <IntegrationsTab />
        )}

        {/* API Resources settings tab */}
        {activeTab === 'apiResources' && (
          <ApiResourcesTab />
        )}

        {/* Troubleshooting settings tab */}
        {activeTab === 'troubleshooting' && (
          <SettingsTroubleshooting />
        )}

        {/* Enterprise tab — visible in both modes */}
        {activeTab === 'enterprise' && (
          <div className="settings-content">
            {isEnterprise ? (
              <div className="settings-category">
                <h3 className="settings-category-title">Enterprise Controller</h3>
                <div className="settings-account-info" style={{ marginBottom: '16px' }}>
                  <div className="settings-account-row">
                    <span className="settings-account-label">Status</span>
                    <span className="settings-account-value" style={{ color: '#4caf50' }}>Connected</span>
                  </div>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: '1.6' }}>
                  You are connected to a NetStacks Controller. Your team's devices, credentials, and configurations are managed centrally.
                  To switch controllers or return to standalone mode, update the URL below and restart the app.
                </p>
                <SettingsConnection />
              </div>
            ) : (
              <>
                <div className="settings-category">
                  <h3 className="settings-category-title">NetStacks Enterprise</h3>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.7', marginBottom: '20px' }}>
                    <p style={{ marginBottom: '12px' }}>
                      NetStacks Terminal is free and open source. When your team is ready to scale, the <strong style={{ color: 'var(--text-primary)' }}>NetStacks Enterprise Controller</strong> adds:
                    </p>
                    <ul style={{ paddingLeft: '20px', margin: '0 0 16px 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <li>Centralized device inventory and credential management</li>
                      <li>Role-based access control (RBAC) and audit logging</li>
                      <li>Shared network topologies and documentation</li>
                      <li>Method of Procedure (MOP) workflows and change management</li>
                      <li>Service stacks and scheduled automation</li>
                      <li>Shared AI prompts and team knowledge base</li>
                    </ul>
                    <a
                      href="https://netstacks.net"
                      onClick={async (e) => {
                        e.preventDefault()
                        try {
                          const { open } = await import('@tauri-apps/plugin-shell')
                          await open('https://netstacks.net')
                        } catch {
                          window.open('https://netstacks.net', '_blank', 'noopener,noreferrer')
                        }
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        color: 'var(--accent)',
                        textDecoration: 'none',
                        fontWeight: 500,
                        fontSize: '13px',
                      }}
                    >
                      Learn more at netstacks.net
                      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                        <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/>
                        <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/>
                      </svg>
                    </a>
                  </div>
                </div>
                <div className="settings-category">
                  <h3 className="settings-category-title">Connect to a Controller</h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: '1.6' }}>
                    If your team has a NetStacks Controller deployed, enter its URL below. The app will restart in enterprise mode.
                  </p>
                  <SettingsConnection />
                </div>
              </>
            )}
          </div>
        )}

        {/* Account settings tab (Enterprise mode only) — TERM-01 Account home:
            consolidates personal auth as stacked sections (account info +
            My Credentials + SSH Certificates). Pure IA: each section renders the
            same component it did when it was a standalone tab. */}
        {activeTab === 'account' && isEnterprise && (
          <div className="settings-content">
            {/* Section 1 — Account info */}
            <div className="settings-category">
              <h3 className="settings-category-title">Your Account</h3>
              <div className="settings-account-info">
                {user && (
                  <>
                    <div className="settings-account-row">
                      <span className="settings-account-label">Username</span>
                      <span className="settings-account-value">{user.username}</span>
                    </div>
                    <div className="settings-account-row">
                      <span className="settings-account-label">Auth Provider</span>
                      <span className="settings-account-value">{user.auth_provider}</span>
                    </div>
                  </>
                )}
              </div>
              <div className="settings-account-actions">
                <button
                  className="settings-logout-btn"
                  onClick={() => logout()}
                >
                  Sign Out
                </button>
              </div>
            </div>

            {/* Section 2 — My Profiles (profile-centric auth from the controller).
                Profiles are the central auth object in enterprise mode; the
                default profile is what connections use. */}
            <div className="settings-category">
              <h3 className="settings-category-title">My Profiles</h3>
              <EnterpriseProfilesTab />
            </div>

            {/* Section 3 — SSH Certificates */}
            <div className="settings-category">
              <h3 className="settings-category-title">SSH Certificate Authentication</h3>
              <SshCertSettings />
            </div>
          </div>
        )}
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

  if (loading) return <div className="settings-account-info">Loading...</div>

  return (
    <div className="settings-account-info">
      <div className="settings-account-row">
        <span className="settings-account-label">Status</span>
        <span className="settings-account-value">
          {certStatus?.valid ? 'Valid' : 'Not available'}
        </span>
      </div>
      {certStatus?.expires_at && (
        <div className="settings-account-row">
          <span className="settings-account-label">Expires</span>
          <span className="settings-account-value">
            {new Date(certStatus.expires_at).toLocaleString()}
          </span>
        </div>
      )}
      {certStatus?.public_key_fingerprint && (
        <div className="settings-account-row">
          <span className="settings-account-label">Public Key</span>
          <span className="settings-account-value" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
            {certStatus.public_key_fingerprint}
          </span>
        </div>
      )}
    </div>
  )
}
