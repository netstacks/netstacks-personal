import { useState, useEffect, useCallback } from 'react'
import { getClient } from '../api/client'
import type { AiToolType } from '../types/workspace'
import GitAccountsSettingsTab from './GitAccountsSettingsTab'
import { LanguageFeaturesTab } from './settings/LanguageFeaturesTab'

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
  const [wsSection, setWsSection] = useState(true)
  const [gitSection, setGitSection] = useState(true)
  const [langSection, setLangSection] = useState(true)

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

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 0',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid var(--color-border)',
    marginBottom: 12,
  }

  const fieldStyle: React.CSSProperties = {
    marginBottom: 16,
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    marginBottom: 4,
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    color: 'var(--color-text-primary)',
    fontSize: 13,
    fontFamily: 'var(--font-family)',
  }

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
  }

  return (
    <div className="settings-tab-content" style={{ padding: 16 }}>
      {/* Workspace Defaults Section */}
      <div style={sectionHeaderStyle} onClick={() => setWsSection(!wsSection)}>
        <span style={{ fontSize: 10 }}>{wsSection ? '▾' : '▸'}</span>
        Workspace Defaults
      </div>

      {wsSection && (
        <div style={{ marginBottom: 24 }}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Default AI Coding Tool</label>
            <select
              style={selectStyle}
              value={defaults.defaultAiTool}
              onChange={e => saveDefaults({ ...defaults, defaultAiTool: e.target.value as AiToolType })}
            >
              {AI_TOOLS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
              Used as the default when creating new workspaces
            </div>
          </div>

          {defaults.defaultAiTool === 'custom' && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Custom AI Command</label>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--font-family-mono)' }}
                value={defaults.defaultCustomCommand}
                onChange={e => saveDefaults({ ...defaults, defaultCustomCommand: e.target.value })}
                placeholder="e.g. aider --model claude-3.5-sonnet"
              />
            </div>
          )}

          {defaults.defaultAiTool !== 'custom' && defaults.defaultAiTool !== 'none' && defaults.defaultAiTool !== 'netstacks-agent' && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Default Launch Arguments</label>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--font-family-mono)' }}
                value={defaults.defaultLaunchArgs}
                onChange={e => saveDefaults({ ...defaults, defaultLaunchArgs: e.target.value })}
                placeholder="e.g. --dangerously-skip-permissions --continue"
              />
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                Full command: cd &lt;workspace&gt; &amp;&amp; clear &amp;&amp; {defaults.defaultAiTool} {defaults.defaultLaunchArgs || ''}
              </div>
            </div>
          )}

          <div style={fieldStyle}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={defaults.autoLaunchAi}
                onChange={e => saveDefaults({ ...defaults, autoLaunchAi: e.target.checked })}
              />
              Auto-launch AI tool when workspace opens
            </label>
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Default Terminal Panel Height (px)</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={defaults.defaultTerminalPanelHeight}
              onChange={e => saveDefaults({ ...defaults, defaultTerminalPanelHeight: parseInt(e.target.value) || 250 })}
              min={100}
              max={800}
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Default File Explorer Width (px)</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={defaults.defaultFileExplorerWidth}
              onChange={e => saveDefaults({ ...defaults, defaultFileExplorerWidth: parseInt(e.target.value) || 220 })}
              min={150}
              max={500}
            />
          </div>
        </div>
      )}

      {/* Git Accounts Section */}
      <div style={sectionHeaderStyle} onClick={() => setGitSection(!gitSection)}>
        <span style={{ fontSize: 10 }}>{gitSection ? '▾' : '▸'}</span>
        Git Accounts
      </div>

      {gitSection && (
        <GitAccountsSettingsTab />
      )}

      {/* Language Features Section */}
      <div style={sectionHeaderStyle} onClick={() => setLangSection(!langSection)}>
        <span style={{ fontSize: 10 }}>{langSection ? '▾' : '▸'}</span>
        Language Features
      </div>

      {langSection && (
        <LanguageFeaturesTab />
      )}
    </div>
  )
}
