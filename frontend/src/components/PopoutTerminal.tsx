import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { CliFlavor } from '../types/enrichment'
import Terminal, { type ConnectionStatus, type TerminalHandle } from './Terminal'
import { ToastContainer } from './Toast'
import { parsePopoutTerminalParams, type PopoutTerminalSnapshot } from '../lib/popoutTerminal'
import './PopoutTerminal.css'
import Tooltip from './Tooltip'

interface PopoutTerminalProps {
  params: URLSearchParams
}

export default function PopoutTerminal({ params }: PopoutTerminalProps) {
  const snapshot = useMemo(() => parsePopoutTerminalParams(params), [params])
  const { sessionId, protocol, sessionName, terminalTheme, fontSize, fontFamily } = snapshot
  const cliFlavor = snapshot.cliFlavor as CliFlavor
  // Reopened on relaunch: mounts disconnected until the user connects.
  const restored = Boolean(snapshot.awaitingConnect)

  const [status, setStatus] = useState<ConnectionStatus>(restored ? 'disconnected' : 'connecting')
  // Still waiting for that first connect — popping back in keeps it waiting.
  const [awaitingConnect, setAwaitingConnect] = useState(restored)
  const terminalRef = useRef<TerminalHandle>(null)

  const handleStatusChange = useCallback((newStatus: ConnectionStatus) => {
    setStatus(newStatus)
    if (newStatus === 'connecting' || newStatus === 'connected') setAwaitingConnect(false)
  }, [])

  // Update window title to match session name
  useEffect(() => {
    document.title = sessionName
  }, [sessionName])

  const statusColor = status === 'connected' ? 'var(--color-success)'
    : status === 'connecting' ? 'var(--color-warning)'
    : status === 'error' ? 'var(--color-error)'
    : 'var(--color-text-secondary)'

  const handlePopBackIn = useCallback(async () => {
    const payload: PopoutTerminalSnapshot = { ...snapshot, awaitingConnect }
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const currentWindow = getCurrentWebviewWindow()
      // Emit event to main window (App.tsx pop-back-in listener re-creates the tab)
      const { emit } = await import('@tauri-apps/api/event')
      await emit('pop-back-in', payload)
      // Close this popout window
      await currentWindow.close()
    } catch {
      // Not in Tauri environment — hand the tab back to the opener window.
      window.opener?.postMessage(
        { type: 'netstacks:pop-back-in', payload },
        window.location.origin
      )
      window.close()
    }
  }, [snapshot, awaitingConnect])

  return (
    <div className="popout-terminal">
      <div className="popout-terminal-titlebar" data-tauri-drag-region>
        <span className="popout-terminal-status" style={{ backgroundColor: statusColor }} />
        <span className="popout-terminal-title">{sessionName}</span>
        <Tooltip label="Pop back into main window"><button
          className="ns-btn ns-btn--ghost ns-icon-btn popout-terminal-popin-btn"
          onClick={handlePopBackIn}
          aria-label="Pop back into main window"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <polyline points="9 4 4 4 4 9" />
            <line x1="4" y1="4" x2="11" y2="11" />
            <rect x="10" y="10" width="10" height="10" rx="1" />
          </svg>
        </button></Tooltip>
      </div>
      <div className="popout-terminal-body">
        <Terminal
          ref={terminalRef}
          id={`popout-${sessionId || snapshot.quickConnectHost || 'local'}`}
          sessionId={sessionId}
          quickConnectHost={snapshot.quickConnectHost}
          quickConnectPort={snapshot.quickConnectPort}
          quickConnectProfileId={snapshot.quickConnectProfileId}
          protocol={protocol}
          sessionName={sessionName}
          cliFlavor={cliFlavor}
          terminalTheme={terminalTheme}
          fontSize={fontSize}
          fontFamily={fontFamily}
          scrollbackLines={snapshot.scrollbackLines}
          autoReconnect={snapshot.autoReconnect}
          reconnectDelay={snapshot.reconnectDelay}
          onStatusChange={handleStatusChange}
          awaitingConnect={restored}
          enterpriseProfileId={snapshot.enterpriseProfileId}
          enterpriseSessionDefinitionId={snapshot.enterpriseSessionDefinitionId}
          enterpriseTargetHost={snapshot.enterpriseTargetHost}
          enterpriseTargetPort={snapshot.enterpriseTargetPort}
          isJumpbox={snapshot.isJumpbox}
        />
      </div>
      <ToastContainer />
    </div>
  )
}
