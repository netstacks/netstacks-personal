import { useState, useRef, useCallback, useEffect } from 'react'
import type { CliFlavor } from '../types/enrichment'
import Terminal, { type ConnectionStatus, type TerminalHandle } from './Terminal'
import { ToastContainer } from './Toast'
import './PopoutTerminal.css'

interface PopoutTerminalProps {
  params: URLSearchParams
}

export default function PopoutTerminal({ params }: PopoutTerminalProps) {
  const sessionId = params.get('sessionId') || undefined
  const protocol = (params.get('protocol') as 'ssh' | 'telnet') || 'ssh'
  const sessionName = params.get('sessionName') || 'Terminal'
  const cliFlavor = (params.get('cliFlavor') as CliFlavor) || 'auto'
  const terminalTheme = params.get('terminalTheme') || undefined
  const fontSize = params.get('fontSize') ? Number(params.get('fontSize')) : undefined
  const fontFamily = params.get('fontFamily') || undefined
  const enterpriseCredentialId = params.get('enterpriseCredentialId') || undefined
  const enterpriseSessionDefinitionId = params.get('enterpriseSessionDefinitionId') || undefined
  const enterpriseTargetHost = params.get('enterpriseTargetHost') || undefined
  const enterpriseTargetPort = params.get('enterpriseTargetPort') ? Number(params.get('enterpriseTargetPort')) : undefined
  const isJumpbox = params.get('isJumpbox') === 'true'

  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const terminalRef = useRef<TerminalHandle>(null)

  const handleStatusChange = useCallback((newStatus: ConnectionStatus) => {
    setStatus(newStatus)
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
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const currentWindow = getCurrentWebviewWindow()
      // Emit event to main window so it can re-create the tab
      const { emit } = await import('@tauri-apps/api/event')
      await emit('pop-back-in', {
        sessionId,
        sessionName,
        protocol,
        cliFlavor,
        terminalTheme,
        fontSize,
        fontFamily,
        enterpriseCredentialId,
        enterpriseSessionDefinitionId,
        enterpriseTargetHost,
        enterpriseTargetPort,
        isJumpbox,
      })
      // Close this popout window
      await currentWindow.close()
    } catch {
      // Not in Tauri environment
      window.close()
    }
  }, [sessionId, sessionName, protocol, cliFlavor, terminalTheme, fontSize, fontFamily, enterpriseCredentialId, enterpriseSessionDefinitionId, enterpriseTargetHost, enterpriseTargetPort, isJumpbox])

  return (
    <div className="popout-terminal">
      <div className="popout-terminal-titlebar" data-tauri-drag-region>
        <span className="popout-terminal-status" style={{ backgroundColor: statusColor }} />
        <span className="popout-terminal-title">{sessionName}</span>
        <button
          className="popout-terminal-popin-btn"
          onClick={handlePopBackIn}
          title="Pop back into main window"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <polyline points="9 4 4 4 4 9" />
            <line x1="4" y1="4" x2="11" y2="11" />
            <rect x="10" y="10" width="10" height="10" rx="1" />
          </svg>
        </button>
      </div>
      <div className="popout-terminal-body">
        <Terminal
          ref={terminalRef}
          id={`popout-${sessionId || 'local'}`}
          sessionId={sessionId}
          protocol={protocol}
          sessionName={sessionName}
          cliFlavor={cliFlavor}
          terminalTheme={terminalTheme}
          fontSize={fontSize}
          fontFamily={fontFamily}
          onStatusChange={handleStatusChange}
          enterpriseCredentialId={enterpriseCredentialId}
          enterpriseSessionDefinitionId={enterpriseSessionDefinitionId}
          enterpriseTargetHost={enterpriseTargetHost}
          enterpriseTargetPort={enterpriseTargetPort}
          isJumpbox={isJumpbox}
        />
      </div>
      <ToastContainer />
    </div>
  )
}
