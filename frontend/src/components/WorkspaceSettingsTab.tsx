import AITabInput from './AITabInput'
import { useState, useEffect, useCallback } from 'react'
import { getClient } from '../api/client'
import type { AiToolType } from '../types/workspace'
import GitAccountsSettingsTab from './GitAccountsSettingsTab'
import { LanguageFeaturesTab } from './settings/LanguageFeaturesTab'
import Switch from './Switch'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'

export interface WorkspaceDefaults {
  defaultAiTool: AiToolType
  defaultCustomCommand: string
  defaultLaunchArgs: string
  autoLaunchAi: boolean
  defaultTerminalPanelHeight: number
  defaultFileExplorerWidth: number
}

// localStorage key shared with WorkspaceNewDialog so the dialog picks
// up the same values the Settings tab writes. Backend /settings/
// workspace-defaults doesn't exist yet — when it lands, the same payload
// is also written there for cross-device sync.
export const WORKSPACE_DEFAULTS_LS_KEY = 'netstacks.workspaceDefaults'

export const DEFAULT_WORKSPACE_DEFAULTS: WorkspaceDefaults = {
  defaultAiTool: 'claude',
  defaultCustomCommand: '',
  defaultLaunchArgs: '',
  autoLaunchAi: true,
  defaultTerminalPanelHeight: 250,
  defaultFileExplorerWidth: 220,
}

/** Read the saved workspace defaults from localStorage. Returns the
 *  hardcoded defaults if nothing's saved or the stored value is corrupt. */
export function loadWorkspaceDefaults(): WorkspaceDefaults {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_DEFAULTS
  try {
    const raw = window.localStorage.getItem(WORKSPACE_DEFAULTS_LS_KEY)
    if (!raw) return DEFAULT_WORKSPACE_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<WorkspaceDefaults>
    return { ...DEFAULT_WORKSPACE_DEFAULTS, ...parsed }
  } catch {
    return DEFAULT_WORKSPACE_DEFAULTS
  }
}

const AI_TOOLS: { value: AiToolType; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'aider', label: 'Aider' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kimicode', label: 'KimiCode' },
  { value: 'netstacks-agent', label: 'NetStacks Agent' },
  { value: 'none', label: 'None' },
  { value: 'custom', label: 'Custom...' },
]

export default function WorkspaceSettingsTab() {
  // Source of truth: localStorage. Backend /settings/workspace-defaults
  // doesn't exist yet, so reading from there before was a no-op and the
  // catch silently swallowed the 404 — settings appeared to save but
  // never actually persisted. Reading from localStorage on mount means
  // saved tweaks survive reloads even without backend support.
  const [defaults, setDefaults] = useState<WorkspaceDefaults>(() => loadWorkspaceDefaults())

  useEffect(() => {
    // Best-effort: if the backend ever gains the endpoint, prefer the
    // server-stored value (for cross-device sync). Until then this
    // 404s and we keep the localStorage value already loaded above.
    // Mount guard via `cancelled` so a slow GET that resolves after
    // the user closes the Settings panel doesn't setState on an
    // unmounted component (React logs warnings, and the localStorage
    // write becomes a phantom side effect).
    let cancelled = false
    getClient().http.get('/settings/workspace-defaults').then(({ data }) => {
      if (cancelled) return
      if (data && typeof data === 'object') {
        const merged = { ...loadWorkspaceDefaults(), ...data }
        setDefaults(merged)
        try {
          window.localStorage.setItem(WORKSPACE_DEFAULTS_LS_KEY, JSON.stringify(merged))
        } catch { /* full disk etc. — fine to skip */ }
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const saveDefaults = useCallback(async (updated: WorkspaceDefaults) => {
    setDefaults(updated)
    // Write to localStorage first so the value survives even if the
    // backend round-trip fails (which it currently always does — see
    // class comment above).
    try {
      window.localStorage.setItem(WORKSPACE_DEFAULTS_LS_KEY, JSON.stringify(updated))
    } catch { /* fail silently — in-memory state still works */ }
    try {
      await getClient().http.put('/settings/workspace-defaults', updated)
    } catch {
      // Backend endpoint may not exist yet — localStorage is the
      // source of truth for now. No toast/error: this is expected.
    }
  }, [])

  return (
    <>
      <SettingsSection title="Workspace Defaults" description="Applied when you create a new workspace.">
        <div className="settings-group">
          <SettingRow label="Default AI Coding Tool">
            <select
              aria-label="Default AI Coding Tool"
              className="ns-select"
              value={defaults.defaultAiTool}
              onChange={e => saveDefaults({ ...defaults, defaultAiTool: e.target.value as AiToolType })}
            >
              {AI_TOOLS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </SettingRow>

          {defaults.defaultAiTool === 'custom' && (
            <SettingRow label="Custom AI Command" stacked>
              <AITabInput
                aria-label="Custom AI Command"
                className="settings-code"
                value={defaults.defaultCustomCommand}
                onChange={e => saveDefaults({ ...defaults, defaultCustomCommand: e.target.value })}
                placeholder="e.g. aider --model sonnet"
                aiField="AI coding tool command"
                aiPlaceholder="Shell command that starts the user's AI coding CLI in a workspace"
                onAIValue={(v) => saveDefaults({ ...defaults, defaultCustomCommand: v })}
              />
            </SettingRow>
          )}

          {defaults.defaultAiTool !== 'custom' && defaults.defaultAiTool !== 'none' && defaults.defaultAiTool !== 'netstacks-agent' && (
            <SettingRow
              label="Default Launch Arguments"
              description={<>Full command: cd &lt;workspace&gt; &amp;&amp; clear &amp;&amp; {defaults.defaultAiTool} {defaults.defaultLaunchArgs || ''}</>}
              stacked
            >
              <AITabInput
                aria-label="Default Launch Arguments"
                className="settings-code"
                value={defaults.defaultLaunchArgs}
                onChange={e => saveDefaults({ ...defaults, defaultLaunchArgs: e.target.value })}
                placeholder="e.g. --dangerously-skip-permissions --continue"
                aiField="AI tool launch arguments"
                aiPlaceholder="Command-line flags passed to the AI coding tool when a workspace opens"
                aiContext={{ tool: defaults.defaultAiTool }}
                onAIValue={(v) => saveDefaults({ ...defaults, defaultLaunchArgs: v })}
              />
            </SettingRow>
          )}

          <SettingRow label="Auto-launch AI tool when workspace opens">
            <Switch
              checked={defaults.autoLaunchAi}
              onChange={v => saveDefaults({ ...defaults, autoLaunchAi: v })}
              label="Auto-launch AI tool when workspace opens"
            />
          </SettingRow>

          <SettingRow label="Default Terminal Panel Height" description="Pixels">
            <input
              aria-label="Default Terminal Panel Height"
              className="ns-input setting-input-number"
              type="number"
              value={defaults.defaultTerminalPanelHeight}
              onChange={e => saveDefaults({ ...defaults, defaultTerminalPanelHeight: parseInt(e.target.value) || 250 })}
              min={100}
              max={800}
            />
          </SettingRow>

          <SettingRow label="Default File Explorer Width" description="Pixels">
            <input
              aria-label="Default File Explorer Width"
              className="ns-input setting-input-number"
              type="number"
              value={defaults.defaultFileExplorerWidth}
              onChange={e => saveDefaults({ ...defaults, defaultFileExplorerWidth: parseInt(e.target.value) || 220 })}
              min={150}
              max={500}
            />
          </SettingRow>
        </div>
      </SettingsSection>

      <GitAccountsSettingsTab />
      <LanguageFeaturesTab />
    </>
  )
}
