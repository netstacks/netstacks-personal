// Which Settings tabs exist in the current mode. The one source of truth for
// the Settings sidebar, the tab bodies it renders, cross-tab search and the
// tabs the AI may open (navigate_to_settings). A tab that is not available is
// never rendered: its body calls backends the mode does not have (standalone
// tabs hit sidecar-only routes such as /vault/* and /tunnels on the Controller).

import type { SettingsTab } from '../types/settingsTab'
import type { FeatureName } from '../types/capabilities'
import type { WhenPredicate } from '../commands/types'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'

export interface SettingsTabAvailability {
  isEnterprise: boolean
  hasFeature: (name: FeatureName) => boolean
}

export interface SettingsTabEntry {
  tab: SettingsTab
  label: string
  /** Cross-tab search terms */
  keywords: string[]
  /** Whether the tab exists in this mode; absent = every mode */
  available?: (a: SettingsTabAvailability) => boolean
}

const standaloneOnly = (a: SettingsTabAvailability) => !a.isEnterprise

/** Sidebar order. */
export const SETTINGS_TABS: readonly SettingsTabEntry[] = [
  { tab: 'general', label: 'General', keywords: ['font', 'size', 'family', 'theme', 'terminal', 'editor', 'copy', 'select', 'appearance', 'status bar', 'panels', 'weight', 'ssh', 'host key', 'known hosts'] },
  { tab: 'ai', label: 'AI', keywords: ['ai', 'provider', 'anthropic', 'openai', 'ollama', 'openrouter', 'litellm', 'model', 'mcp', 'server', 'tools', 'agent', 'highlighting', 'token', 'sanitization', 'sanitize', 'suggestions', 'autocomplete', 'next step', 'enabled providers', 'config changes', 'configuration changes'] },
  { tab: 'aiEngineer', label: 'AI Engineer', keywords: ['ai engineer', 'profile', 'personality', 'behavior', 'vendor', 'autonomy', 'onboarding', 'safety rules', 'troubleshooting', 'verbosity'] },
  { tab: 'prompts', label: 'Prompts', keywords: ['prompt', 'custom prompt', 'system prompt'], available: a => a.hasFeature('local_custom_prompts') },
  { tab: 'snippets', label: 'Snippets', keywords: ['snippet', 'text expansion', 'shortcut'], available: standaloneOnly },
  { tab: 'customCommands', label: 'Custom Actions', keywords: ['custom command', 'custom action', 'alias', 'macro', 'script'], available: a => a.hasFeature('local_integrations') },
  { tab: 'keyboard', label: 'Keyboard', keywords: ['keyboard', 'shortcut', 'keybinding', 'hotkey', 'key'] },
  { tab: 'mappedKeys', label: 'Mapped Keys', keywords: ['mapped key', 'key mapping', 'remap'] },
  { tab: 'profiles', label: 'Profiles', keywords: ['profile', 'connection', 'ssh', 'telnet'], available: standaloneOnly },
  { tab: 'jumpHosts', label: 'Jump Hosts', keywords: ['jump host', 'bastion', 'proxy', 'hop'], available: standaloneOnly },
  { tab: 'tunnels', label: 'Tunnels', keywords: ['tunnel', 'ssh tunnel', 'port forward', 'socks', 'proxy'], available: standaloneOnly },
  { tab: 'highlighting', label: 'Highlighting', keywords: ['highlight', 'color', 'pattern', 'regex', 'rule'] },
  // Enrichment works in both modes — the Controller implements the enrichment
  // subsystem (matchers/sources/runtime) at parity with the agent.
  { tab: 'enrichment', label: 'Enrichment', keywords: ['enrichment', 'hover', 'popover', 'matcher', 'source', 'netbox', 'crawler', 'oui', 'dns', 'interface', 'mac', 'ip', 'vendor'] },
  // Documents auto-save targets work in both modes (client-side category resolution).
  { tab: 'documents', label: 'Documents', keywords: ['document', 'docs', 'save', 'category', 'folder', 'enrichment', 'markdown', 'snapshot', 'backup', 'mop', 'troubleshooting', 'auto-save', 'where', 'location'] },
  { tab: 'security', label: 'Security', keywords: ['security', 'vault', 'credential', 'password', 'encryption'], available: standaloneOnly },
  { tab: 'hostKeys', label: 'Trusted Hosts', keywords: ['host key', 'known hosts', 'ssh', 'tofu', 'trust', 'fingerprint', 'revoke', 'mitm'], available: standaloneOnly },
  { tab: 'recordings', label: 'Recordings', keywords: ['recording', 'asciicast', 'session', 'capture', 'playback', 'replay'], available: standaloneOnly },
  // Saved layouts live in the local agent; the Controller has no /layouts.
  { tab: 'layouts', label: 'Layouts', keywords: ['layout', 'tab', 'split', 'arrangement', 'saved'], available: standaloneOnly },
  { tab: 'sessionLogs', label: 'Session Logs', keywords: ['log', 'session', 'capture', 'output', 'transcript'], available: standaloneOnly },
  // Workspace defaults use the admin-only global /settings route on the Controller.
  { tab: 'workspaces', label: 'Workspaces', keywords: ['workspace', 'git', 'accounts', 'github', 'gitlab', 'ai', 'tool', 'auto-launch', 'terminal', 'explorer', 'default'], available: standaloneOnly },
  { tab: 'integrations', label: 'Integrations', keywords: ['integration', 'netbox', 'netstacksCrawler', 'librenms'], available: a => !a.isEnterprise && a.hasFeature('local_integrations') },
  // Troubleshooting recorder settings are localStorage-only (no Controller
  // backing), like its sibling local-recording tabs.
  { tab: 'troubleshooting', label: 'Troubleshooting', keywords: ['troubleshoot', 'recording', 'session', 'capture'], available: a => !a.isEnterprise && a.hasFeature('local_session_recording') },
  // Clipboard history + paste hygiene — both modes (memory-only history in enterprise).
  { tab: 'clipboard', label: 'Clipboard', keywords: ['clipboard', 'clip', 'history', 'paste', 'copy', 'preset', 'transform', 'crlf', 'line ending'] },
  { tab: 'enterprise', label: 'Enterprise', keywords: ['enterprise', 'controller', 'team', 'url', 'connect', 'tls', 'certificate', 'netstacks'] },
  // Account consolidates personal auth: account info + My Credentials + SSH
  // Certificates live as sections under this single tab (TERM-01).
  { tab: 'account', label: 'Account', keywords: ['account', 'controller', 'username', 'sign out', 'logout', 'credential', 'password', 'secret', 'ssh', 'certificate', 'cert', 'ca', 'public key'], available: a => a.isEnterprise },
]

/** Tabs the AI never opens itself: connection and sign-in settings. */
const NOT_AI_NAVIGABLE: ReadonlySet<SettingsTab> = new Set(['enterprise', 'account'])

/** The Settings tabs that exist in this mode, in sidebar order. */
export function availableSettingsTabs(a: SettingsTabAvailability): SettingsTabEntry[] {
  return SETTINGS_TABS.filter(entry => entry.available?.(a) ?? true)
}

export function isSettingsTabAvailable(tab: SettingsTab, a: SettingsTabAvailability): boolean {
  return availableSettingsTabs(a).some(entry => entry.tab === tab)
}

/** `when` for a command that opens a Settings tab: only where the tab exists. */
export function whenSettingsTab(tab: SettingsTab): WhenPredicate {
  return (ctx) => isSettingsTabAvailable(tab, { isEnterprise: ctx.isEnterprise, hasFeature: useCapabilitiesStore.getState().hasFeature })
}

/** Settings tabs navigate_to_settings may open in this mode. */
export function aiNavigableSettingsTabs(a: SettingsTabAvailability): SettingsTab[] {
  return availableSettingsTabs(a).map(entry => entry.tab).filter(tab => !NOT_AI_NAVIGABLE.has(tab))
}

/** Available tabs whose label or keywords match a search query; null for an empty query. */
export function settingsTabsMatching(query: string, a: SettingsTabAvailability): Set<SettingsTab> | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  return new Set(availableSettingsTabs(a)
    .filter(entry => entry.label.toLowerCase().includes(q) || entry.keywords.some(kw => kw.includes(q)))
    .map(entry => entry.tab))
}
