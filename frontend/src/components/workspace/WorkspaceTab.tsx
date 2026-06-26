import { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspace } from '../../hooks/useWorkspace'
import { useAssistantName } from '../../stores/assistantName'
import { useGitStatus } from '../../hooks/useGitStatus'
import WorkspaceFileExplorer from './WorkspaceFileExplorer'
import WorkspaceEditorArea from './WorkspaceEditorArea'
import WorkspaceTerminalPanel, { type WorkspaceTerminalPanelHandle } from './WorkspaceTerminalPanel'
import WorkspaceOutputPanel from './WorkspaceOutputPanel'
import WorkspaceGitPanel from './WorkspaceGitPanel'
import type { WorkspaceConfig } from '../../types/workspace'
import type { Session } from '../../api/sessions'
import './WorkspaceTab.css'

interface WorkspaceTabProps {
  config: WorkspaceConfig
  isActive: boolean
}

type PythonRunMode = 'native' | 'netstacks' | null

const RUNNABLE_EXTS: Record<string, (path: string) => string> = {
  py: (p) => `python3 "${p}"`,
  sh: (p) => `bash "${p}"`,
  bash: (p) => `bash "${p}"`,
  zsh: (p) => `zsh "${p}"`,
  js: (p) => `node "${p}"`,
  ts: (p) => `npx tsx "${p}"`,
}

export default function WorkspaceTab({ config, isActive }: WorkspaceTabProps) {
  const assistantName = useAssistantName()
  const workspace = useWorkspace({ config })
  const { state, fileOps, gitOps } = workspace
  const git = useGitStatus({
    gitOps,
    pollIntervalMs: state.mode === 'remote' ? 10000 : 5000,
  })
  const terminalPanelRef = useRef<WorkspaceTerminalPanelHandle>(null)

  const [isResizingTerminal, setIsResizingTerminal] = useState(false)
  const terminalStartY = useRef(0)
  const terminalStartHeight = useRef(0)

  const [pythonRunMode, setPythonRunMode] = useState<PythonRunMode>(config.pythonRunMode || null)
  const [showRunModeDialog, setShowRunModeDialog] = useState(false)
  const [pendingRunPath, setPendingRunPath] = useState<string | null>(null)


  const [editorCollapsed, setEditorCollapsed] = useState(false)

  // Output panel state for Netstacks engine runs
  const [outputFilePath, setOutputFilePath] = useState<string | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  // Zone 3 mode: 'terminal' or 'output'
  const [zone3Mode, setZone3Mode] = useState<'terminal' | 'output'>('terminal')

  const handleTerminalResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizingTerminal(true)
    terminalStartY.current = e.clientY
    terminalStartHeight.current = state.terminalPanelHeight
  }, [state.terminalPanelHeight])

  const isResizing = isResizingTerminal

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isResizingTerminal) {
      workspace.setTerminalPanelHeight(terminalStartHeight.current + (terminalStartY.current - e.clientY))
    }
  }, [isResizingTerminal, workspace])

  const handleMouseUp = useCallback(() => {
    setIsResizingTerminal(false)
  }, [])

  const handleFileOpen = useCallback((filePath: string, fileName: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    // Binary / media files get the image viewer (which also handles PDF /
    // audio / video). Everything else goes to Monaco — language detection
    // there will treat unknown text as plaintext.
    const IMAGE_LIKE = new Set([
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
      'pdf', 'mp3', 'wav', 'ogg', 'mp4', 'webm',
    ])
    const tabType = IMAGE_LIKE.has(ext) ? 'image' : 'code-editor'
    workspace.openInnerTab(tabType, { filePath, title: fileName })
  }, [workspace])

  const handleViewDiff = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || 'diff'
    workspace.openInnerTab('diff', { filePath, title: `${fileName} (diff)` })
  }, [workspace])

  const handleViewBlame = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || 'blame'
    workspace.openInnerTab('blame', { filePath, title: `${fileName} (blame)` })
  }, [workspace])

  const executeRun = useCallback((filePath: string, mode: PythonRunMode) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const fileName = filePath.split('/').pop() || 'run'

    if (state.terminalPanelCollapsed) {
      workspace.toggleTerminalPanel()
    }

    if (ext === 'py' && mode === 'netstacks') {
      // Run through Netstacks engine — show output panel
      setOutputFilePath(filePath)
      setShowOutput(true)
      setZone3Mode('output')
    } else {
      // Run natively in terminal
      const buildCmd = RUNNABLE_EXTS[ext]
      if (buildCmd) {
        setZone3Mode('terminal')
        workspace.addTerminalTab(fileName, buildCmd(filePath))
      }
    }
  }, [state.terminalPanelCollapsed, workspace])

  const handleRunFile = useCallback((filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''

    if (ext === 'py' && pythonRunMode === null) {
      setPendingRunPath(filePath)
      setShowRunModeDialog(true)
      return
    }

    executeRun(filePath, pythonRunMode)
  }, [pythonRunMode, executeRun])

  const handleRunModeSelect = useCallback((mode: PythonRunMode) => {
    setPythonRunMode(mode)
    setShowRunModeDialog(false)
    if (pendingRunPath) {
      executeRun(pendingRunPath, mode)
      setPendingRunPath(null)
    }
  }, [pendingRunPath, executeRun])

  const sidebarContent = (
    <>
      <div className="workspace-zone1-tabs">
        <button
          className={`workspace-zone1-tab ${state.zone1Tab === 'files' ? 'active' : ''}`}
          onClick={() => workspace.setZone1Tab('files')}
        >
          Files
        </button>
        <button
          className={`workspace-zone1-tab ${state.zone1Tab === 'git' ? 'active' : ''}`}
          onClick={() => workspace.setZone1Tab('git')}
        >
          Git
        </button>
      </div>
      {state.zone1Tab === 'files' ? (
        <WorkspaceFileExplorer
          rootPath={state.rootPath}
          mode={state.mode}
          fileOps={fileOps}
          expandedDirs={state.expandedDirs}
          selectedPath={state.selectedPath}
          gitBranch={git.branch}
          gitStatuses={git.statuses}
          isGitRepo={git.isGitRepo}
          onToggleDir={workspace.toggleDir}
          onSelectPath={workspace.setSelectedPath}
          onOpenFile={handleFileOpen}
          onRefreshGit={git.refresh}
          getFileStatus={git.getFileStatus}
          gitOps={gitOps}
          onViewDiff={handleViewDiff}
          onViewBlame={handleViewBlame}
        />
      ) : (
        <WorkspaceGitPanel
          gitOps={gitOps}
          isGitRepo={git.isGitRepo}
          branch={git.branch}
          statuses={git.statuses}
          activeTab={state.gitPanelTab}
          onSetTab={workspace.setGitPanelTab}
          onRefresh={git.refresh}
          onViewDiff={handleViewDiff}
        />
      )}
    </>
  )

  const portalTarget = isActive ? document.getElementById('workspace-sidebar-explorer') : null

  if (state.mode === 'remote' && state.remoteAgentStatus !== 'connected') {
    return (
      <div className="workspace-deploy-loading">
        {state.remoteAgentStatus === 'deploying' && (
          <>
            <div className="workspace-deploy-spinner" />
            <div className="workspace-deploy-text">Deploying agent...</div>
            <div className="workspace-deploy-subtext">
              Uploading binary and starting remote agent on {state.rootPath}
            </div>
          </>
        )}
        {state.remoteAgentStatus === 'failed' && (
          <>
            <div className="workspace-deploy-error-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            </div>
            <div className="workspace-deploy-text">Failed to deploy remote agent</div>
            <div className="workspace-deploy-subtext">{state.remoteAgentError}</div>
            <button
              className="workspace-terminal-action-btn"
              style={{ marginTop: 8, padding: '6px 16px' }}
              onClick={() => workspace.retryDeploy()}
            >
              Retry
            </button>
          </>
        )}
        {!state.remoteAgentStatus && (
          <>
            <div className="workspace-deploy-spinner" />
            <div className="workspace-deploy-text">Connecting...</div>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {portalTarget && createPortal(sidebarContent, portalTarget)}
      <div
        className={`workspace-tab ${isResizing ? 'resizing' : ''}`}
        onMouseMove={isResizing ? handleMouseMove : undefined}
        onMouseUp={isResizing ? handleMouseUp : undefined}
        onMouseLeave={isResizing ? handleMouseUp : undefined}
      >
        <div className="workspace-main" style={{ flex: 1 }}>
          {/* Zone 2: Editor */}
          {!editorCollapsed ? (
            <div className="workspace-editor-area" style={{
              flex: state.terminalPanelCollapsed && !showOutput ? 1 : undefined,
              height: state.terminalPanelCollapsed && !showOutput ? '100%' : undefined,
            }}>
              <WorkspaceEditorArea
                innerTabs={state.innerTabs}
                activeInnerTabId={state.activeInnerTabId}
                workspaceRoot={state.rootPath}
                fileOps={fileOps}
                gitOps={gitOps}
                onSetActiveTab={workspace.setActiveInnerTab}
                onCloseTab={workspace.closeInnerTab}
                onMarkModified={workspace.markInnerTabModified}
                onRunFile={handleRunFile}
                onCollapse={() => setEditorCollapsed(true)}
              />
            </div>
          ) : (
            <div className="workspace-zone-collapsed-bar" onClick={() => setEditorCollapsed(false)}>
              <span>Editor</span>
              <span className="workspace-zone-collapsed-expand">▼</span>
            </div>
          )}

          {/* Resize handle between Zone 2 and Zone 3 */}
          {!editorCollapsed && (!state.terminalPanelCollapsed || showOutput) && (
            <div className="workspace-resize-handle horizontal" onMouseDown={handleTerminalResizeStart} />
          )}

          {/* Zone 3: Terminal or AI Panel */}
          {state.aiTool.tool === 'netstacks-agent' ? (
            <>
              {!state.terminalPanelCollapsed ? (
                <div
                  className="workspace-terminal-panel"
                  style={{ height: editorCollapsed ? '100%' : state.terminalPanelHeight, flex: editorCollapsed ? 1 : undefined }}
                >
                  <div className="workspace-zone3-tabs" onDoubleClick={() => { workspace.toggleTerminalPanel(); if (editorCollapsed) setEditorCollapsed(false) }}>
                    <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--color-text-secondary)' }}>{assistantName}</span>
                    <div style={{ flex: 1 }} />
                    <button
                      className="workspace-terminal-action-btn"
                      onClick={() => { workspace.toggleTerminalPanel(); if (editorCollapsed) setEditorCollapsed(false) }}
                      title="Collapse AI panel"
                    >
                      ▼
                    </button>
                  </div>
                  <div id="workspace-ai-panel-target" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }} />
                </div>
              ) : (
                <>
                  <div className="workspace-zone-collapsed-bar" onClick={() => workspace.toggleTerminalPanel()}>
                    <span>{assistantName}</span>
                    <span className="workspace-zone-collapsed-expand">▲</span>
                  </div>
                  <div id="workspace-ai-panel-target" style={{ display: 'none' }} />
                </>
              )}
            </>
          ) : (
            <>
              {/* Terminal panel is ALWAYS mounted — collapse just hides it via CSS.
                  Unmounting would tear down xterm + kill the underlying PTY child
                  (Claude Code / Aider / etc.), losing the AI session. */}
              <div
                className="workspace-terminal-panel"
                style={
                  state.terminalPanelCollapsed && !showOutput
                    ? { display: 'none' }
                    : { height: editorCollapsed ? '100%' : state.terminalPanelHeight, flex: editorCollapsed ? 1 : undefined }
                }
              >
                {showOutput && (
                  <div className="workspace-zone3-tabs">
                    <button
                      className={`workspace-zone3-tab ${zone3Mode === 'terminal' ? 'active' : ''}`}
                      onClick={() => setZone3Mode('terminal')}
                    >
                      Terminal
                    </button>
                    <button
                      className={`workspace-zone3-tab ${zone3Mode === 'output' ? 'active' : ''}`}
                      onClick={() => setZone3Mode('output')}
                    >
                      Output
                    </button>
                    <div style={{ flex: 1 }} />
                    <button
                      className="workspace-terminal-action-btn"
                      onClick={() => { workspace.toggleTerminalPanel(); if (editorCollapsed) setEditorCollapsed(false) }}
                      title="Collapse terminal"
                    >
                      ▼
                    </button>
                  </div>
                )}

                <div style={{ display: zone3Mode === 'terminal' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                  <WorkspaceTerminalPanel
                    ref={terminalPanelRef}
                    terminalTabs={state.terminalTabs}
                    activeTerminalTabId={state.activeTerminalTabId}
                    collapsed={false}
                    workspaceRoot={state.rootPath}
                    remoteAgentUrl={state.remoteAgentHost && state.remoteAgentPort ? `https://${state.remoteAgentHost}:${state.remoteAgentPort}` : undefined}
                    remoteAgentToken={state.remoteAgentToken}
                    onSetActiveTab={workspace.setActiveTerminalTab}
                    onCloseTab={workspace.closeTerminalTab}
                    onAddTab={workspace.addTerminalTab}
                    onOpenSession={(s: Session) => {
                      // Spawn a connected SSH/Telnet sub-tab in this panel
                      // (vs. the top-level tab bar). Carries the full set
                      // of SSH metadata Terminal needs to dial the agent —
                      // sessionId is the key, the rest is for display +
                      // AI / CLI flavor wiring.
                      workspace.addTerminalTab(s.name, undefined, {
                        sessionId: s.id,
                        protocol: s.protocol || 'ssh',
                        cliFlavor: s.cli_flavor,
                        profileId: s.profile_id,
                        color: s.color || undefined,
                      })
                    }}
                    onToggleCollapse={() => { workspace.toggleTerminalPanel(); if (editorCollapsed) setEditorCollapsed(false) }}
                  />
                </div>

                {showOutput && zone3Mode === 'output' && (
                  <WorkspaceOutputPanel
                    filePath={outputFilePath}
                    onClose={() => { setShowOutput(false); setZone3Mode('terminal') }}
                  />
                )}
              </div>

              {state.terminalPanelCollapsed && !showOutput && (
                <div className="workspace-zone-collapsed-bar" onClick={() => workspace.toggleTerminalPanel()}>
                  <span>Terminal</span>
                  <span className="workspace-zone-collapsed-expand">▲</span>
                </div>
              )}
            </>
          )}
        </div>

        {showRunModeDialog && (
          <div className="workspace-new-dialog-overlay" onClick={() => { setShowRunModeDialog(false); setPendingRunPath(null) }}>
            <div className="workspace-new-dialog" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
              <h3>How should Python files run?</h3>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-small)', margin: '0 0 16px' }}>
                This choice will be remembered for this workspace.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button className="workspace-run-mode-option" onClick={() => handleRunModeSelect('native')}>
                  <span className="workspace-run-mode-icon">🐍</span>
                  <div>
                    <div className="workspace-run-mode-title">Native (python3)</div>
                    <div className="workspace-run-mode-desc">Run with system Python. You manage dependencies yourself.</div>
                  </div>
                </button>
                <button className="workspace-run-mode-option" onClick={() => handleRunModeSelect('netstacks')}>
                  <span className="workspace-run-mode-icon">⚡</span>
                  <div>
                    <div className="workspace-run-mode-title">Netstacks Engine (UV)</div>
                    <div className="workspace-run-mode-desc">Auto-installs dependencies from imports. Uses UV + PEP 723.</div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
