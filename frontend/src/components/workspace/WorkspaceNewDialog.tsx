import { useState, useCallback, useEffect, useRef } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { listSessions } from '../../api/sessions'
import { AgentGitOps } from '../../lib/gitOps'
import { LocalFileOps } from '../../lib/fileOps'
import { getClient } from '../../api/client'
import { showToast } from '../Toast'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { loadWorkspaceDefaults } from '../WorkspaceSettingsTab'
import type { WorkspaceConfig, AiToolType } from '../../types/workspace'

import { getErrorMessage } from '../../api/errors'
type DialogMode = 'local' | 'remote' | 'clone'

interface WorkspaceNewDialogProps {
  sessions?: { id: string; name: string; host?: string }[]
  onSubmit: (config: WorkspaceConfig) => void
  onCancel: () => void
  /** Pre-select a dialog mode on open (e.g. 'remote' when triggered from an SSH tab) */
  initialMode?: DialogMode
  /** Pre-select an SSH session by ID (used with initialMode='remote') */
  initialSessionId?: string
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

export default function WorkspaceNewDialog({
  sessions: initialSessions,
  onSubmit,
  onCancel,
  initialMode,
  initialSessionId,
}: WorkspaceNewDialogProps) {
  const [sessions, setSessions] = useState<{ id: string; name: string; host?: string }[]>(initialSessions || [])
  const [mode, setMode] = useState<DialogMode>(initialMode ?? 'local')
  const [localPath, setLocalPath] = useState('')
  const [remoteSessionId, setRemoteSessionId] = useState(initialSessionId || sessions[0]?.id || '')
  const [cloneUrl, setCloneUrl] = useState('')
  const [clonePath, setClonePath] = useState('')
  const [cloning, setCloning] = useState(false)

  useEffect(() => {
    if (sessions.length === 0) {
      listSessions().then(all => {
        const mapped = all.map((s: any) => ({ id: s.id, name: s.name, host: s.host }))
        setSessions(mapped)
        if (!initialSessionId && mapped.length > 0) setRemoteSessionId(mapped[0].id)
      }).catch(() => {})
    }
  }, [])
  const [remotePath, setRemotePath] = useState('')
  const [aiTool, setAiTool] = useState<AiToolType>('claude')
  const [customCommand, setCustomCommand] = useState('')
  const [launchArgs, setLaunchArgs] = useState('')
  const [autoLaunch, setAutoLaunch] = useState(true)
  // Track which fields the user has manually touched so loading saved
  // defaults doesn't clobber a value they're already typing. Stored in
  // BOTH state (for rendering) and a ref (for the async backend-fetch
  // callback below) — the state form has a stale-closure problem when
  // read inside the deps-`[]` effect, but the ref always sees current
  // values because we write through to both in every setTouched.
  const touchedRef = useRef({ aiTool: false, customCommand: false, launchArgs: false, autoLaunch: false })
  // _touched intentionally unread — state exists solely to trigger
  // re-renders when touchedRef changes; render code reads the ref.
  const [, setTouchedState] = useState(touchedRef.current)
  const setTouched = useCallback(
    (updater: (prev: typeof touchedRef.current) => typeof touchedRef.current) => {
      const next = updater(touchedRef.current)
      touchedRef.current = next
      setTouchedState(next)
    },
    [],
  )
  const [gitCheck, setGitCheck] = useState<{
    checking: boolean
    isRepo: boolean
    branch: string | null
    isEmpty: boolean
  } | null>(null)
  const [initGit, setInitGit] = useState(false)

  // Apply saved workspace defaults from Settings → Workspaces. Was an
  // open bug: the settings tab persisted defaultAiTool /
  // defaultLaunchArgs / autoLaunchAi / defaultCustomCommand but this
  // dialog never read them, so every new workspace started with hard-
  // coded 'claude' / empty / true regardless of what the user saved.
  //
  // Two read sources: localStorage (synchronous, instant) AND backend
  // (/settings/workspace-defaults — authoritative for users who saved
  // before localStorage mirroring landed, or who use the app from
  // multiple machines). Backend wins when both are present, and the
  // backend value is mirrored back to localStorage so subsequent dialog
  // opens get the fast path.
  useEffect(() => {
    // Synchronous local-storage read first so the form fields don't
    // flash hardcoded defaults before the backend round-trip lands.
    // Use touchedRef everywhere because the async .then() below would
    // otherwise capture the initial `touched` state (all false) and
    // clobber user typing that happened during the 50-200ms fetch.
    const local = loadWorkspaceDefaults()
    if (!touchedRef.current.aiTool) setAiTool(local.defaultAiTool)
    if (!touchedRef.current.customCommand) setCustomCommand(local.defaultCustomCommand)
    if (!touchedRef.current.launchArgs) setLaunchArgs(local.defaultLaunchArgs)
    if (!touchedRef.current.autoLaunch) setAutoLaunch(local.autoLaunchAi)

    let cancelled = false
    getClient().http.get('/settings/workspace-defaults').then(({ data }) => {
      if (cancelled || !data || typeof data !== 'object') return
      const d = data as Partial<{
        defaultAiTool: AiToolType
        defaultCustomCommand: string
        defaultLaunchArgs: string
        autoLaunchAi: boolean
      }>
      // Re-read the ref here, not the captured `touched` state — the
      // user may have started typing between mount and this callback.
      if (d.defaultAiTool && !touchedRef.current.aiTool) setAiTool(d.defaultAiTool)
      if (typeof d.defaultCustomCommand === 'string' && !touchedRef.current.customCommand) {
        setCustomCommand(d.defaultCustomCommand)
      }
      if (typeof d.defaultLaunchArgs === 'string' && !touchedRef.current.launchArgs) {
        setLaunchArgs(d.defaultLaunchArgs)
      }
      if (typeof d.autoLaunchAi === 'boolean' && !touchedRef.current.autoLaunch) {
        setAutoLaunch(d.autoLaunchAi)
      }
      // Mirror back to localStorage so the next dialog open hits the
      // fast path and survives a backend outage.
      try {
        const merged = { ...local, ...d }
        window.localStorage.setItem(
          'netstacks.workspaceDefaults',
          JSON.stringify(merged),
        )
      } catch { /* full disk etc. — fine to skip */ }
    }).catch(() => {
      // Backend may be down or endpoint may have moved — local-storage
      // values already applied above. Silent.
    })
    return () => { cancelled = true }
    // Run once on mount; later defaults edits don't retroactively
    // rewrite an open dialog. touched is read inside but should not
    // retrigger.
     
  }, [])

  const handleBrowse = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    if (selected && typeof selected === 'string') {
      setLocalPath(selected)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'local' || !localPath.trim()) {
      setGitCheck(null)
      setInitGit(false)
      return
    }
    const timer = setTimeout(async () => {
      setGitCheck({ checking: true, isRepo: false, branch: null, isEmpty: false })
      try {
        const ops = new AgentGitOps(localPath.trim())
        const isRepo = await ops.isRepo()
        let branch: string | null = null
        if (isRepo) {
          const branchInfo = await ops.branch()
          branch = branchInfo?.name ?? null
        }
        const fileOps = new LocalFileOps()
        let isEmpty = false
        try {
          const entries = await fileOps.readDir(localPath.trim())
          isEmpty = entries.length === 0
        } catch {
          isEmpty = false
        }
        setGitCheck({ checking: false, isRepo, branch, isEmpty })
      } catch {
        setGitCheck(null)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [localPath, mode])

  const handleSubmit = useCallback(async () => {
    // Audit P2-10: double-submit guard. Previously the button was only
    // disabled with `disabled={!isValid || cloning}`, but `cloning` is
    // only true in clone mode. Two quick clicks on Open Workspace in
    // local/remote mode would create two workspace records with
    // different UUIDs but identical config. Short-circuit at the
    // handler so the second click is a no-op regardless of mode.
    if (cloning) return
    if (mode === 'clone') {
      if (!cloneUrl.trim() || !clonePath.trim()) return
      setCloning(true)
      try {
        // Derive repo name from URL for destination subdirectory
        const repoName = cloneUrl.trim().split('/').pop()?.replace(/\.git$/, '') || 'repo'
        const fullPath = `${clonePath.trim()}/${repoName}`

        await getClient().http.post('/workspace/git/clone', {
          url: cloneUrl.trim(),
          destination: fullPath,
        })

        const name = repoName
        // P1-3: pull defaultTerminalPanelHeight / defaultFileExplorerWidth
        // from saved workspace defaults so those two Settings →
        // Workspaces controls aren't dead. Other defaults (aiTool,
        // launchArgs, autoLaunchAi) are already applied via the form
        // state above — only the geometry defaults were hardcoded here.
        const defaults = loadWorkspaceDefaults()
        const config: WorkspaceConfig = {
          id: crypto.randomUUID(),
          name,
          mode: 'local',
          rootPath: fullPath,
          aiTool: { tool: aiTool, customCommand: aiTool === 'custom' ? customCommand : undefined, launchArgs: launchArgs.trim() || undefined },
          autoLaunchAi: autoLaunch,
          fileExplorerWidth: defaults.defaultFileExplorerWidth,
          terminalPanelHeight: defaults.defaultTerminalPanelHeight,
          terminalPanelCollapsed: false,
          expandedDirs: [],
          selectedPath: null,
          openFiles: [],
          activeFileIndex: null,
          terminalSessions: [],
          activeTerminalIndex: null,
        }
        onSubmit(config)
      } catch (err) {
        showToast(`Clone failed: ${getErrorMessage(err)}`, 'error')
      } finally {
        setCloning(false)
      }
      return
    }

    const rootPath = mode === 'local' ? localPath : remotePath
    if (!rootPath.trim()) return

    // Reuse `cloning` as the generic in-flight flag for the local/
    // remote branch too. The early-return guard at the top of
    // handleSubmit already prevents re-entry; this just makes the
    // button label + disabled state match the actual state.
    setCloning(true)

    const dirName = rootPath.split('/').filter(Boolean).pop() || 'workspace'
    let name = dirName
    if (mode === 'remote') {
      const sess = sessions.find(s => s.id === remoteSessionId)
      const host = sess?.host || sess?.name || 'remote'
      name = `${host}:${dirName}`
    }

    if (initGit && mode === 'local') {
      try {
        const ops = new AgentGitOps(rootPath.trim())
        await ops.init()
      } catch {
        // Init may fail if already a repo — continue anyway
      }
    }

    // P1-3: same as the clone branch above — geometry defaults come
    // from the saved workspace defaults, not literal 220/250.
    const localDefaults = loadWorkspaceDefaults()
    const config: WorkspaceConfig = {
      id: crypto.randomUUID(),
      name,
      mode,
      rootPath: rootPath.trim(),
      sessionId: mode === 'remote' ? remoteSessionId : undefined,
      aiTool: { tool: aiTool, customCommand: aiTool === 'custom' ? customCommand : undefined, launchArgs: launchArgs.trim() || undefined },
      autoLaunchAi: autoLaunch,
      fileExplorerWidth: localDefaults.defaultFileExplorerWidth,
      terminalPanelHeight: localDefaults.defaultTerminalPanelHeight,
      terminalPanelCollapsed: false,
      expandedDirs: [],
      selectedPath: null,
      openFiles: [],
      activeFileIndex: null,
      terminalSessions: [],
      activeTerminalIndex: null,
    }

    try {
      onSubmit(config)
    } finally {
      // Parent normally unmounts on success, so this is a no-op then.
      // If onSubmit throws synchronously the user can recover by
      // tweaking + re-submitting.
      setCloning(false)
    }
  }, [mode, localPath, remotePath, remoteSessionId, aiTool, customCommand, launchArgs, autoLaunch, initGit, cloneUrl, clonePath, cloning, onSubmit])

  const isValid = mode === 'local'
    ? localPath.trim().length > 0
    : mode === 'remote'
    ? (remotePath.trim().length > 0 && remoteSessionId)
    : (cloneUrl.trim().length > 0 && clonePath.trim().length > 0)

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onCancel })

  return (
    <div className="workspace-new-dialog-overlay" {...backdropProps}>
      <div className="workspace-new-dialog" {...contentProps}>
        <h3>New Workspace</h3>

        <div className="workspace-new-dialog-field">
          <span className="workspace-new-dialog-label">Mode</span>
          <div className="workspace-new-dialog-radio-group">
            <label className="workspace-new-dialog-radio">
              <input type="radio" checked={mode === 'local'} onChange={() => setMode('local')} />
              Local Directory
            </label>
            <label className="workspace-new-dialog-radio">
              <input
                type="radio"
                checked={mode === 'remote'}
                onChange={() => setMode('remote')}
              />
              Remote Server
            </label>
            <label className="workspace-new-dialog-radio">
              <input type="radio" checked={mode === 'clone'} onChange={() => setMode('clone')} />
              Clone Repository
            </label>
          </div>
        </div>

        {mode === 'local' && (
          <div className="workspace-new-dialog-field">
            <span className="workspace-new-dialog-label">Directory</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="workspace-new-dialog-input"
                value={localPath}
                onChange={e => setLocalPath(e.target.value)}
                placeholder="/path/to/project"
              />
              <button className="workspace-new-dialog-btn" onClick={handleBrowse}>Browse</button>
            </div>
          </div>
        )}

        {mode === 'local' && gitCheck && (
          <div className="workspace-new-dialog-git-status">
            {gitCheck.checking ? (
              <span style={{ color: 'var(--color-text-secondary)' }}>Checking directory...</span>
            ) : gitCheck.isRepo ? (
              <div className="workspace-new-dialog-git-ok">
                ✓ Git repository{gitCheck.branch ? ` on branch "${gitCheck.branch}"` : ''}
              </div>
            ) : gitCheck.isEmpty ? (
              <div className="workspace-new-dialog-git-empty">
                <span>Empty directory</span>
                <label className="workspace-new-dialog-checkbox">
                  <input type="checkbox" checked={initGit} onChange={e => setInitGit(e.target.checked)} />
                  Initialize as git repository
                </label>
              </div>
            ) : (
              <div className="workspace-new-dialog-git-warn">
                <span>Not a git repository</span>
                <label className="workspace-new-dialog-checkbox">
                  <input type="checkbox" checked={initGit} onChange={e => setInitGit(e.target.checked)} />
                  Initialize as git repository
                </label>
              </div>
            )}
          </div>
        )}

        {mode === 'remote' && (
          <>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">SSH Session</span>
              <select
                className="workspace-new-dialog-select"
                value={remoteSessionId}
                onChange={e => setRemoteSessionId(e.target.value)}
              >
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                {sessions.length === 0 && <option value="">No sessions available</option>}
              </select>
            </div>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">Remote Path</span>
              <input
                className="workspace-new-dialog-input"
                value={remotePath}
                onChange={e => setRemotePath(e.target.value)}
                placeholder="/home/user/project"
              />
            </div>
          </>
        )}

        {mode === 'clone' && (
          <>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">Repository URL</span>
              <input
                className="workspace-new-dialog-input"
                value={cloneUrl}
                onChange={e => setCloneUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
              />
            </div>
            <div className="workspace-new-dialog-field">
              <span className="workspace-new-dialog-label">Clone to Directory</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  className="workspace-new-dialog-input"
                  value={clonePath}
                  onChange={e => setClonePath(e.target.value)}
                  placeholder="/path/to/clone/into"
                />
                <button className="workspace-new-dialog-btn" onClick={async () => {
                  const selected = await open({ directory: true, multiple: false })
                  if (selected && typeof selected === 'string') setClonePath(selected)
                }}>Browse</button>
              </div>
            </div>
          </>
        )}

        <div className="workspace-new-dialog-field">
          <span className="workspace-new-dialog-label">AI Coding Tool</span>
          <select
            className="workspace-new-dialog-select"
            value={aiTool}
            onChange={e => {
              setAiTool(e.target.value as AiToolType)
              setTouched(t => ({ ...t, aiTool: true }))
            }}
          >
            {AI_TOOLS.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {aiTool === 'custom' && (
          <div className="workspace-new-dialog-field">
            <span className="workspace-new-dialog-label">Custom Command</span>
            <input
              className="workspace-new-dialog-input"
              value={customCommand}
              onChange={e => {
                setCustomCommand(e.target.value)
                setTouched(t => ({ ...t, customCommand: true }))
              }}
              placeholder="e.g. aider --model claude-3.5-sonnet"
            />
          </div>
        )}

        {aiTool !== 'custom' && aiTool !== 'none' && aiTool !== 'netstacks-agent' && (
          <div className="workspace-new-dialog-field">
            <span className="workspace-new-dialog-label">Launch Arguments</span>
            <input
              className="workspace-new-dialog-input"
              value={launchArgs}
              onChange={e => {
                setLaunchArgs(e.target.value)
                setTouched(t => ({ ...t, launchArgs: true }))
              }}
              placeholder="e.g. --dangerously-skip-permissions --continue"
            />
            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 2, display: 'block' }}>
              Full command: cd &lt;workspace&gt; &amp;&amp; clear &amp;&amp; {aiTool} {launchArgs || ''}
            </span>
          </div>
        )}

        <div className="workspace-new-dialog-field">
          <label className="workspace-new-dialog-checkbox">
            <input
              type="checkbox"
              checked={autoLaunch}
              onChange={e => {
                setAutoLaunch(e.target.checked)
                setTouched(t => ({ ...t, autoLaunch: true }))
              }}
            />
            Auto-launch AI tool on open
          </label>
        </div>

        <div className="workspace-new-dialog-actions">
          <button className="workspace-new-dialog-btn" onClick={onCancel}>Cancel</button>
          <button
            className="workspace-new-dialog-btn primary"
            onClick={handleSubmit}
            disabled={!isValid || cloning}
          >
            {cloning ? 'Cloning...' : mode === 'clone' ? 'Clone & Open' : 'Open Workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
