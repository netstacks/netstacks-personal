import { useCallback, useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react'
import Terminal, { type TerminalHandle } from '../Terminal'
import WorkspaceSessionPicker from './WorkspaceSessionPicker'
import type { TerminalTab } from '../../types/workspace'
import type { Session } from '../../api/sessions'

export interface WorkspaceTerminalPanelHandle {
  sendToActiveTerminal: (command: string) => void
}

interface WorkspaceTerminalPanelProps {
  terminalTabs: TerminalTab[]
  activeTerminalTabId: string | null
  collapsed: boolean
  workspaceRoot: string
  remoteAgentUrl?: string
  remoteAgentToken?: string
  onSetActiveTab: (id: string) => void
  onCloseTab: (id: string) => void
  onAddTab: (title: string, command?: string) => string
  /**
   * Open a saved SSH/Telnet session as a new sub-panel tab (instead of
   * a top-level tab). Hosted by the parent because it needs access to
   * the Session API + workspace.addTerminalTab with the SSH metadata
   * payload — the sub-panel itself stays presentational.
   */
  onOpenSession: (session: Session) => void
  onToggleCollapse: () => void
}

export default forwardRef<WorkspaceTerminalPanelHandle, WorkspaceTerminalPanelProps>(
  function WorkspaceTerminalPanel({
    terminalTabs,
    activeTerminalTabId,
    collapsed,
    workspaceRoot,
    remoteAgentUrl,
    remoteAgentToken,
    onSetActiveTab,
    onCloseTab,
    onAddTab,
    onOpenSession,
    onToggleCollapse,
  }, ref) {
    const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())
    const launchedCommands = useRef<Set<string>>(new Set())
    const [pickerOpen, setPickerOpen] = useState(false)
    // Lightweight floating context menu state. Rendering inline (rather
    // than via a portal) keeps the menu z-stacked under the picker modal
    // — important because the menu's "Open session here…" item opens
    // the picker, and a portal-rendered menu would persist behind it.
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

    const handleNewTerminal = useCallback(() => {
      onAddTab('bash')
    }, [onAddTab])

    const handleStripContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault()
      // Clamp to viewport so the menu doesn't render off-screen when
      // right-click happens near the right or bottom edge of the panel.
      const MENU_W = 220
      const MENU_H = 80
      const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8)
      const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8)
      setMenu({ x, y })
    }, [])

    // Close the menu when the user clicks anywhere outside it. Must be
    // BUBBLE phase, not capture, otherwise the document handler fires
    // before the menu item's own onClick (capture walks down from the
    // document to the target before the bubble walks back up), which
    // would unmount the menu before any selection registers — making
    // the menu items appear to "do nothing." The menu wrapper calls
    // e.stopPropagation() in its bubble onClick, so legitimate clicks
    // inside the menu never reach this handler.
    useEffect(() => {
      if (!menu) return
      const close = () => setMenu(null)
      // Defer one tick so the right-click that opened the menu doesn't
      // immediately satisfy this handler via the trailing mouseup/click.
      const timer = setTimeout(() => {
        document.addEventListener('click', close)
      }, 0)
      return () => {
        clearTimeout(timer)
        document.removeEventListener('click', close)
      }
    }, [menu])

    const handleOpenSessionPick = useCallback((session: Session) => {
      setPickerOpen(false)
      onOpenSession(session)
    }, [onOpenSession])

    const setTerminalRef = useCallback((tabId: string, handle: TerminalHandle | null) => {
      if (handle) {
        terminalRefs.current.set(tabId, handle)
      } else {
        terminalRefs.current.delete(tabId)
      }
    }, [])

    useImperativeHandle(ref, () => ({
      sendToActiveTerminal: (command: string) => {
        if (!activeTerminalTabId) return
        const handle = terminalRefs.current.get(activeTerminalTabId)
        if (handle) {
          handle.sendCommand(command)
        }
      },
    }), [activeTerminalTabId])

    // Auto-launch commands after terminal connects
    useEffect(() => {
      for (const tab of terminalTabs) {
        if (tab.command && !launchedCommands.current.has(tab.id)) {
          const handle = terminalRefs.current.get(tab.id)
          if (handle) {
            launchedCommands.current.add(tab.id)
            setTimeout(() => {
              const cdCmd = workspaceRoot ? `cd ${workspaceRoot.replace(/ /g, '\\ ')} && clear && ` : ''
              handle.sendCommand(`${cdCmd}${tab.command}`)
            }, 500)
          }
        }
      }
    })

    // Tab label prefix:
    //   AI CLI tab  → 🤖
    //   SSH session → 🔗
    //   Telnet      → 📡
    //   local bash  → $
    // Keeps the existing 1-char prefix shape so tab widths don't shift;
    // distinguishes saved sessions from local shells at a glance.
    const labelPrefix = (tab: TerminalTab): string => {
      if (tab.isAiCli) return '🤖 '
      if (tab.sessionId) return tab.protocol === 'telnet' ? '📡 ' : '🔗 '
      return '$ '
    }

    return (
      <>
        <div
          className="workspace-terminal-header"
          onDoubleClick={onToggleCollapse}
          onContextMenu={handleStripContextMenu}
        >
          <div className="workspace-terminal-tabs">
            {terminalTabs.map(tab => (
              <div
                key={tab.id}
                className={`workspace-terminal-tab ${tab.id === activeTerminalTabId ? 'active' : ''}`}
                onClick={() => onSetActiveTab(tab.id)}
                title={tab.sessionId ? `Saved session: ${tab.title}` : tab.title}
              >
                {/* 3px color stripe matches top-level SSH tab styling so the
                    same device looks the same wherever it's opened. */}
                {tab.color && (
                  <span
                    className="workspace-terminal-tab-color"
                    style={{ background: tab.color }}
                    aria-hidden="true"
                  />
                )}
                <span>{labelPrefix(tab)}{tab.title}</span>
                <button
                  className="workspace-terminal-tab-close"
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="workspace-terminal-action-btn"
              onClick={handleNewTerminal}
              title="New terminal (right-click strip for more options)"
              style={{ marginLeft: 2 }}
            >
              +
            </button>
          </div>
          <div className="workspace-terminal-actions">
            <button
              className="workspace-terminal-action-btn"
              onClick={onToggleCollapse}
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▲' : '▼'}
            </button>
          </div>
        </div>
        {!collapsed && (
          <div className="workspace-terminal-content">
            {terminalTabs.map(tab => (
              <div
                key={tab.id}
                style={{
                  display: tab.id === activeTerminalTabId ? 'block' : 'none',
                  width: '100%',
                  height: '100%',
                }}
              >
                <Terminal
                  id={`workspace-term-${tab.id}`}
                  // sessionId presence flips Terminal from local-bash mode
                  // to connected-SSH mode. Same code path top-level tabs use.
                  sessionId={tab.sessionId}
                  protocol={tab.protocol}
                  cliFlavor={tab.cliFlavor}
                  sessionName={tab.title}
                  // workspaceRoot is only honoured for local bash; the
                  // agent's SSH backend ignores it for connected sessions.
                  workspaceRoot={tab.sessionId ? undefined : workspaceRoot}
                  remoteAgentUrl={remoteAgentUrl}
                  remoteAgentToken={remoteAgentToken}
                  ref={(handle) => setTerminalRef(tab.id, handle)}
                />
              </div>
            ))}
            {terminalTabs.length === 0 && (
              <div className="workspace-empty-state">
                <div>No terminals open</div>
                <button className="workspace-terminal-action-btn" onClick={handleNewTerminal}>
                  + New Terminal
                </button>
              </div>
            )}
          </div>
        )}

        {menu && (
          <div
            className="workspace-terminal-strip-menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="workspace-terminal-strip-menu-item"
              onClick={() => { setMenu(null); handleNewTerminal() }}
            >
              <span className="wsm-icon">$</span> New terminal
            </button>
            <button
              type="button"
              className="workspace-terminal-strip-menu-item"
              onClick={() => { setMenu(null); setPickerOpen(true) }}
            >
              <span className="wsm-icon">🔗</span> Open session here…
            </button>
          </div>
        )}

        {/* Conditional mount: picker has no `open` prop — it expects the
            parent to gate render so each open starts with a fresh state
            slot (avoids set-state-in-effect for reset). */}
        {pickerOpen && (
          <WorkspaceSessionPicker
            onClose={() => setPickerOpen(false)}
            onPick={handleOpenSessionPick}
          />
        )}
      </>
    )
  }
)
