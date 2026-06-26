import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { LocalFileOps, PendingFileOps } from '../lib/fileOps'
import { AgentGitOps } from '../lib/gitOps'
import { createAgentHttpClient } from '../api/localClient'
import { deployRemoteAgent, ensureRemoteCertTrusted } from '../api/remoteAgent'
import { updateSavedWorkspace } from '../components/workspace/WorkspacesPanel'
import type {
  WorkspaceState,
  WorkspaceConfig,
  InnerTab,
  InnerTabType,
  FileOps,
  GitOps,
  Zone1Tab,
  GitPanelTab,
  TerminalTab,
} from '../types/workspace'

import { getErrorMessage } from '../api/errors'
import { logger } from '../lib/logger'
interface UseWorkspaceOptions {
  config: WorkspaceConfig
}

interface UseWorkspaceReturn {
  state: WorkspaceState
  fileOps: FileOps
  gitOps: GitOps

  setFileExplorerWidth: (width: number) => void
  toggleDir: (path: string) => void
  setSelectedPath: (path: string | null) => void
  setZone1Tab: (tab: Zone1Tab) => void
  setGitPanelTab: (tab: GitPanelTab) => void

  openInnerTab: (type: InnerTabType, opts: { filePath?: string; url?: string; title: string }) => void
  closeInnerTab: (id: string) => void
  setActiveInnerTab: (id: string) => void
  markInnerTabModified: (id: string, modified: boolean) => void

  setTerminalPanelHeight: (height: number) => void
  toggleTerminalPanel: () => void
  addTerminalTab: (title: string, command?: string, opts?: Partial<Pick<TerminalTab, 'sessionId' | 'protocol' | 'cliFlavor' | 'profileId' | 'color'>>) => string
  closeTerminalTab: (id: string) => void
  setActiveTerminalTab: (id: string) => void
  retryDeploy: () => void
}

function createInitialState(config: WorkspaceConfig): WorkspaceState {
  // Restore inner tabs from saved config
  const innerTabs: InnerTab[] = (config.openFiles || []).map((f) => ({
    id: crypto.randomUUID(),
    type: f.type,
    title: f.title,
    filePath: f.filePath,
    url: f.url,
    isModified: false,
  }))

  // Restore terminal tabs from saved config, or create default AI CLI tab
  const terminalSessions = config.terminalSessions || []

  const buildAiCommand = (tool: string, args?: string, custom?: string): string => {
    if (tool === 'custom') return custom || tool
    return args ? `${tool} ${args}` : tool
  }

  const currentAiCommand = buildAiCommand(config.aiTool.tool, config.aiTool.launchArgs, config.aiTool.customCommand)

  const terminalTabs = terminalSessions.length > 0
    ? terminalSessions.map(t => ({
        id: crypto.randomUUID(),
        title: t.title,
        command: t.isAiCli ? currentAiCommand : t.command,
        isAiCli: t.isAiCli,
      }))
    : config.autoLaunchAi && config.aiTool.tool !== 'none'
      ? [{
          id: crypto.randomUUID(),
          title: config.aiTool.tool === 'custom' ? 'AI CLI' : config.aiTool.tool,
          command: currentAiCommand,
          isAiCli: true,
        }]
      : []

  const activeInnerTabId = config.activeFileIndex != null && innerTabs[config.activeFileIndex]
    ? innerTabs[config.activeFileIndex].id
    : innerTabs.length > 0 ? innerTabs[0].id : null

  const activeTerminalTabId = config.activeTerminalIndex != null && terminalTabs[config.activeTerminalIndex]
    ? terminalTabs[config.activeTerminalIndex].id
    : terminalTabs.length > 0 ? terminalTabs[0].id : null

  return {
    id: config.id,
    name: config.name,
    mode: config.mode,
    rootPath: config.rootPath,
    sessionId: config.sessionId,
    tunnels: [],
    aiTool: config.aiTool,
    autoLaunchAi: config.autoLaunchAi,
    fileExplorerWidth: config.fileExplorerWidth || 220,
    expandedDirs: new Set(config.expandedDirs || []),
    selectedPath: config.selectedPath || null,
    zone1Tab: config.zone1Tab || 'files',
    gitPanelTab: config.gitPanelTab || 'changes',
    innerTabs,
    activeInnerTabId,
    terminalPanelHeight: config.terminalPanelHeight || 250,
    terminalPanelCollapsed: config.terminalPanelCollapsed || false,
    terminalTabs,
    activeTerminalTabId,
    gitBranch: null,
    gitStatus: [],
  }
}

function stateToConfig(state: WorkspaceState): WorkspaceConfig {
  return {
    id: state.id,
    name: state.name,
    mode: state.mode,
    rootPath: state.rootPath,
    sessionId: state.sessionId,
    aiTool: state.aiTool,
    autoLaunchAi: state.autoLaunchAi,
    fileExplorerWidth: state.fileExplorerWidth,
    terminalPanelHeight: state.terminalPanelHeight,
    terminalPanelCollapsed: state.terminalPanelCollapsed,
    expandedDirs: Array.from(state.expandedDirs),
    selectedPath: state.selectedPath,
    zone1Tab: state.zone1Tab,
    gitPanelTab: state.gitPanelTab,
    openFiles: state.innerTabs.map(t => ({
      type: t.type,
      title: t.title,
      filePath: t.filePath,
      url: t.url,
    })),
    activeFileIndex: state.activeInnerTabId
      ? state.innerTabs.findIndex(t => t.id === state.activeInnerTabId)
      : null,
    terminalSessions: state.terminalTabs.map(t => ({
      title: t.title,
      command: t.command,
      isAiCli: t.isAiCli,
    })),
    activeTerminalIndex: state.activeTerminalTabId
      ? state.terminalTabs.findIndex(t => t.id === state.activeTerminalTabId)
      : null,
    remoteAgentHost: state.remoteAgentHost,
    remoteAgentPort: state.remoteAgentPort,
    remoteAgentToken: state.remoteAgentToken,
    remoteAgentId: state.remoteAgentId,
  }
}

function pathSep(rootPath: string): string {
  return rootPath.includes('/') ? '/' : '\\'
}

async function ensureNetstacksDir(fileOps: FileOps, rootPath: string): Promise<void> {
  const sep = pathSep(rootPath)
  const nsDir = `${rootPath}${sep}.netstacks`
  try {
    await fileOps.mkdir(nsDir)
  } catch {
    // Directory may already exist
  }
}

async function addToGitignore(fileOps: FileOps, rootPath: string): Promise<void> {
  const sep = pathSep(rootPath)
  const gitignorePath = `${rootPath}${sep}.gitignore`
  try {
    const content = await fileOps.readFile(gitignorePath)
    if (content.includes('.netstacks/') || content.includes('.netstacks')) return
    const newContent = content.endsWith('\n') ? `${content}.netstacks/\n` : `${content}\n.netstacks/\n`
    await fileOps.writeFile(gitignorePath, newContent)
  } catch {
    // No .gitignore or can't read — create one
    try {
      await fileOps.writeFile(gitignorePath, '.netstacks/\n')
    } catch {
      // Non-writable directory, skip
    }
  }
}

async function cleanScreenshotsDir(fileOps: FileOps, rootPath: string): Promise<void> {
  const sep = pathSep(rootPath)
  const screenshotsDir = `${rootPath}${sep}.netstacks${sep}screenshots`
  try {
    await fileOps.delete(screenshotsDir, true)
  } catch {
    // Directory may not exist — that's fine
  }
  try {
    await fileOps.mkdir(screenshotsDir)
  } catch {
    // mkdir may fail if .netstacks doesn't exist yet — ensureNetstacksDir runs first
  }
}

async function saveNetstacksState(fileOps: FileOps, rootPath: string, config: WorkspaceConfig): Promise<void> {
  const sep = pathSep(rootPath)
  const filePath = `${rootPath}${sep}.netstacks${sep}workspace.json`
  try {
    const json = JSON.stringify(config, null, 2)
    await fileOps.writeFile(filePath, json)
  } catch {
    // Silent fail — .netstacks may not be writable
  }
}

async function loadNetstacksState(fileOps: FileOps, rootPath: string): Promise<Partial<WorkspaceConfig> | null> {
  const sep = pathSep(rootPath)
  const filePath = `${rootPath}${sep}.netstacks${sep}workspace.json`
  try {
    const content = await fileOps.readFile(filePath)
    return JSON.parse(content) as Partial<WorkspaceConfig>
  } catch {
    return null
  }
}

export function useWorkspace({ config }: UseWorkspaceOptions): UseWorkspaceReturn {
  const [state, setState] = useState<WorkspaceState>(() => createInitialState(config))
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const remoteHttp = useMemo(() => {
    if (config.mode === 'remote' && state.remoteAgentHost && state.remoteAgentPort && state.remoteAgentToken) {
      return createAgentHttpClient(
        `https://${state.remoteAgentHost}:${state.remoteAgentPort}`,
        state.remoteAgentToken,
      )
    }
    return null
  }, [config.mode, state.remoteAgentHost, state.remoteAgentPort, state.remoteAgentToken])

  const fileOps = useMemo<FileOps>(() => {
    if (config.mode === 'remote') {
      return remoteHttp ? new LocalFileOps(remoteHttp) : new PendingFileOps()
    }
    return new LocalFileOps()
  }, [config.mode, remoteHttp])

  const gitOps = useMemo<GitOps>(() => {
    if (config.mode === 'remote' && remoteHttp) {
      return new AgentGitOps(config.rootPath, remoteHttp)
    }
    return new AgentGitOps(config.rootPath)
  }, [config.mode, remoteHttp, config.rootPath])

  // Initialize .netstacks directory and load persisted state. One-shot
  // on mount — the workspace identity (mode, rootPath, fileOps) is
  // immutable for the lifetime of this hook instance, so depending on
  // them would just force an unnecessary re-init if React happened to
  // re-create the prop reference.
  useEffect(() => {
    const init = async () => {
      if (config.mode !== 'local') return

      await ensureNetstacksDir(fileOps, config.rootPath)
      await addToGitignore(fileOps, config.rootPath)
      await cleanScreenshotsDir(fileOps, config.rootPath)

      const saved = await loadNetstacksState(fileOps, config.rootPath)
      if (saved) {
        setState(prev => ({
          ...prev,
          zone1Tab: saved.zone1Tab || prev.zone1Tab,
          gitPanelTab: saved.gitPanelTab || prev.gitPanelTab,
          fileExplorerWidth: saved.fileExplorerWidth || prev.fileExplorerWidth,
          terminalPanelHeight: saved.terminalPanelHeight || prev.terminalPanelHeight,
          terminalPanelCollapsed: saved.terminalPanelCollapsed ?? prev.terminalPanelCollapsed,
          expandedDirs: saved.expandedDirs ? new Set(saved.expandedDirs) : prev.expandedDirs,
          selectedPath: saved.selectedPath ?? prev.selectedPath,
        }))
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deploy counter — incremented by retry button to re-trigger the deploy effect
  const [deployAttempt, setDeployAttempt] = useState(0)

  // Deploy remote agent for remote workspaces. Health-checks saved connection
  // first; falls through to deploy if stale or missing.
  useEffect(() => {
    if (config.mode !== 'remote' || !config.sessionId) return

    let mounted = true

    const tryConnect = async () => {
      // If we have saved connection info, health-check before trusting it
      if (config.remoteAgentHost && config.remoteAgentPort && config.remoteAgentToken) {
        try {
          const remoteHttp = createAgentHttpClient(
            `https://${config.remoteAgentHost}:${config.remoteAgentPort}`,
            config.remoteAgentToken,
          )
          await remoteHttp.get('/health', { timeout: 5000 })
          if (!mounted) return
          setState(prev => ({
            ...prev,
            remoteAgentStatus: 'connected',
            remoteAgentHost: config.remoteAgentHost,
            remoteAgentPort: config.remoteAgentPort,
            remoteAgentToken: config.remoteAgentToken,
            remoteAgentId: config.remoteAgentId,
          }))
          return
        } catch {
          if (!mounted) return
          logger.log('[workspace] Saved remote agent connection stale — redeploying')
        }
      }

      // Deploy fresh
      try {
        setState(prev => ({ ...prev, remoteAgentStatus: 'deploying' }))
        const result = await deployRemoteAgent(config.sessionId!)
        if (!mounted) return
        await ensureRemoteCertTrusted(result)
        setState(prev => ({
          ...prev,
          remoteAgentStatus: 'connected',
          remoteAgentHost: result.host,
          remoteAgentPort: result.port,
          remoteAgentToken: result.auth_token,
          remoteAgentId: result.agent_id,
        }))
      } catch (err) {
        if (!mounted) return
        const serverMsg = (err as any)?.response?.data?.error
        const detail = serverMsg || (getErrorMessage(err, 'Failed to deploy remote agent'))
        console.error('[workspace] Remote agent deploy failed:', detail, err)
        setState(prev => ({
          ...prev,
          remoteAgentStatus: 'failed',
          remoteAgentError: detail,
        }))
      }
    }

    tryConnect()
    return () => { mounted = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployAttempt])

  // Watch for .netstacks/open-request.json — AI tools write this to open files in editor
  useEffect(() => {
    if (config.mode !== 'local') return

    const sep = pathSep(config.rootPath)
    const signalPath = `${config.rootPath}${sep}.netstacks${sep}open-request.json`

    let cancelled = false
    const poll = setInterval(async () => {
      if (cancelled) return
      try {
        // Existence check first — the file is absent 99% of the time and
        // hitting readFile on a missing path returns 500 from the agent,
        // which the global axios interceptor logs once per second.
        const present = await fileOps.exists(signalPath)
        if (cancelled || !present) return
        const content = await fileOps.readFile(signalPath)
        if (cancelled) return
        const request = JSON.parse(content)
        if (request.path) {
          const fullPath = request.path.startsWith('/') || request.path.startsWith('\\') || request.path.includes(':')
            ? request.path
            : `${config.rootPath}${sep}${request.path}`
          const fileName = fullPath.split(sep).pop() || 'file'

          setState(s => {
            const existing = s.innerTabs.find(t => t.filePath === fullPath)
            if (existing) {
              return { ...s, activeInnerTabId: existing.id }
            }
            const tab: InnerTab = {
              id: crypto.randomUUID(),
              type: 'code-editor',
              title: fileName,
              filePath: fullPath,
              isModified: false,
            }
            return {
              ...s,
              innerTabs: [...s.innerTabs, tab],
              activeInnerTabId: tab.id,
            }
          })

          // Delete the signal file
          try {
            await fileOps.delete(signalPath, false)
          } catch {
            /* ignore */
          }
        }
      } catch {
        // File doesn't exist — normal, no open request pending
      }
    }, 1000)

    return () => {
      cancelled = true
      clearInterval(poll)
    }
  }, [config.mode, config.rootPath, fileOps])


  // Auto-save: debounced 1s after any state change
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const cfg = stateToConfig(stateRef.current)
      updateSavedWorkspace(cfg).catch(console.error)
      if (stateRef.current.mode === 'local') {
        saveNetstacksState(fileOps, stateRef.current.rootPath, cfg).catch(console.error)
      }
    }, 1000)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [
    state.innerTabs,
    state.activeInnerTabId,
    state.terminalTabs,
    state.activeTerminalTabId,
    state.expandedDirs,
    state.selectedPath,
    state.fileExplorerWidth,
    state.terminalPanelHeight,
    state.terminalPanelCollapsed,
    state.zone1Tab,
    state.gitPanelTab,
    fileOps,
  ])

  // Save immediately on unmount. Reads stateRef.current so the snapshot
  // is whatever the user had at unmount time — fileOps captured in
  // closure is fine because the workspace can't change mode mid-life.
  // Intentionally empty deps: re-running the effect would tear down and
  // re-register the cleanup, which would lose the unmount-time snapshot.
  useEffect(() => {
    return () => {
      const cfg = stateToConfig(stateRef.current)
      updateSavedWorkspace(cfg).catch(console.error)
      if (stateRef.current.mode === 'local') {
        saveNetstacksState(fileOps, stateRef.current.rootPath, cfg).catch(console.error)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setFileExplorerWidth = useCallback((width: number) => {
    setState(s => ({ ...s, fileExplorerWidth: Math.max(150, Math.min(500, width)) }))
  }, [])

  const toggleDir = useCallback((path: string) => {
    setState(s => {
      const next = new Set(s.expandedDirs)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { ...s, expandedDirs: next }
    })
  }, [])

  const setSelectedPath = useCallback((path: string | null) => {
    setState(s => ({ ...s, selectedPath: path }))
  }, [])

  const setZone1Tab = useCallback((tab: Zone1Tab) => {
    setState(s => ({ ...s, zone1Tab: tab }))
  }, [])

  const setGitPanelTab = useCallback((tab: GitPanelTab) => {
    setState(s => ({ ...s, gitPanelTab: tab }))
  }, [])

  const openInnerTab = useCallback((
    type: InnerTabType,
    opts: { filePath?: string; url?: string; title: string }
  ) => {
    setState(s => {
      const existing = s.innerTabs.find(t =>
        t.type === type && t.filePath === opts.filePath && t.url === opts.url
      )
      if (existing) {
        return { ...s, activeInnerTabId: existing.id }
      }
      const tab: InnerTab = {
        id: crypto.randomUUID(),
        type,
        title: opts.title,
        filePath: opts.filePath,
        url: opts.url,
        isModified: false,
      }
      return {
        ...s,
        innerTabs: [...s.innerTabs, tab],
        activeInnerTabId: tab.id,
      }
    })
  }, [])

  const closeInnerTab = useCallback((id: string) => {
    setState(s => {
      const idx = s.innerTabs.findIndex(t => t.id === id)
      const next = s.innerTabs.filter(t => t.id !== id)
      let nextActive = s.activeInnerTabId
      if (s.activeInnerTabId === id) {
        nextActive = next.length > 0
          ? next[Math.min(idx, next.length - 1)].id
          : null
      }
      return { ...s, innerTabs: next, activeInnerTabId: nextActive }
    })
  }, [])

  const setActiveInnerTab = useCallback((id: string) => {
    setState(s => ({ ...s, activeInnerTabId: id }))
  }, [])

  const markInnerTabModified = useCallback((id: string, modified: boolean) => {
    setState(s => ({
      ...s,
      innerTabs: s.innerTabs.map(t => t.id === id ? { ...t, isModified: modified } : t),
    }))
  }, [])

  const setTerminalPanelHeight = useCallback((height: number) => {
    setState(s => ({ ...s, terminalPanelHeight: Math.max(100, height) }))
  }, [])

  const toggleTerminalPanel = useCallback(() => {
    setState(s => ({ ...s, terminalPanelCollapsed: !s.terminalPanelCollapsed }))
  }, [])

  const addTerminalTab = useCallback((
    title: string,
    command?: string,
    opts?: Partial<Pick<TerminalTab, 'sessionId' | 'protocol' | 'cliFlavor' | 'profileId' | 'color'>>,
  ): string => {
    const id = crypto.randomUUID()
    setState(s => ({
      ...s,
      terminalTabs: [...s.terminalTabs, { id, title, command, ...opts }],
      activeTerminalTabId: id,
    }))
    return id
  }, [])

  const closeTerminalTab = useCallback((id: string) => {
    setState(s => {
      const idx = s.terminalTabs.findIndex(t => t.id === id)
      const next = s.terminalTabs.filter(t => t.id !== id)
      let nextActive = s.activeTerminalTabId
      if (s.activeTerminalTabId === id) {
        nextActive = next.length > 0
          ? next[Math.min(idx, next.length - 1)].id
          : null
      }
      return { ...s, terminalTabs: next, activeTerminalTabId: nextActive }
    })
  }, [])

  const setActiveTerminalTab = useCallback((id: string) => {
    setState(s => ({ ...s, activeTerminalTabId: id }))
  }, [])

  return {
    state,
    fileOps,
    gitOps,
    setFileExplorerWidth,
    toggleDir,
    setSelectedPath,
    setZone1Tab,
    setGitPanelTab,
    openInnerTab,
    closeInnerTab,
    setActiveInnerTab,
    markInnerTabModified,
    setTerminalPanelHeight,
    toggleTerminalPanel,
    addTerminalTab,
    closeTerminalTab,
    setActiveTerminalTab,
    retryDeploy: useCallback(() => {
      setState(prev => ({ ...prev, remoteAgentStatus: undefined, remoteAgentError: undefined }))
      setDeployAttempt(n => n + 1)
    }, []),
  }
}
