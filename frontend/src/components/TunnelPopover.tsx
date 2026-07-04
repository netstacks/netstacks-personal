import { useState, useEffect, useRef, useMemo } from 'react'
import { useTunnelStore, SESSION_TUNNEL_PREFIX } from '../stores/tunnelStore'
import { formatTunnelSpec, formatUptime, startTunnel, stopTunnel, reconnectTunnel } from '../api/tunnels'
import type { TunnelWithState } from '../api/tunnels'
import './TunnelPopover.css'
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition'

interface TunnelPopoverProps {
  onClose: () => void
  onManageTunnels: () => void
}

export default function TunnelPopover({ onClose, onManageTunnels }: TunnelPopoverProps) {
  const tunnels = useTunnelStore(state => state.tunnels)
  const loadError = useTunnelStore(state => state.error)
  const [search, setSearch] = useState('')
  const [contextMenu, setContextMenu] = useState<{ tunnel: TunnelWithState; x: number; y: number } | null>(null)
  const { ref: contextMenuRef, style: contextMenuStyle } = useClampedMenuPosition(contextMenu)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { searchRef.current?.focus() }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu) setContextMenu(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, contextMenu])

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  const { persistentTunnels, sessionGroups } = useMemo(() => {
    const searchLwr = search.toLowerCase()
    const matches = (t: TunnelWithState) =>
      t.name.toLowerCase().includes(searchLwr) ||
      formatTunnelSpec(t).toLowerCase().includes(searchLwr)

    const persistent: TunnelWithState[] = []
    const sessionMap = new Map<string, TunnelWithState[]>()

    for (const t of tunnels) {
      if (!matches(t)) continue
      if (t.id.startsWith(SESSION_TUNNEL_PREFIX)) {
        const hostKey = t.host
        if (!sessionMap.has(hostKey)) sessionMap.set(hostKey, [])
        sessionMap.get(hostKey)!.push(t)
      } else {
        persistent.push(t)
      }
    }

    return {
      persistentTunnels: persistent,
      sessionGroups: Array.from(sessionMap.entries()),
    }
  }, [tunnels, search])

  const totalVisible = persistentTunnels.length + sessionGroups.reduce((n, [, t]) => n + t.length, 0)

  const handleToggle = async (e: React.MouseEvent, tunnel: TunnelWithState) => {
    e.stopPropagation()
    try {
      if (tunnel.status === 'connected' || tunnel.status === 'connecting' || tunnel.status === 'reconnecting') {
        await stopTunnel(tunnel.id)
      } else {
        await startTunnel(tunnel.id)
      }
      useTunnelStore.getState().fetchTunnels()
    } catch (err) {
      console.error('Failed to toggle tunnel:', err)
    }
  }

  const handleContextMenu = (e: React.MouseEvent, tunnel: TunnelWithState) => {
    if (tunnel.id.startsWith(SESSION_TUNNEL_PREFIX)) return
    e.preventDefault()
    setContextMenu({ tunnel, x: e.clientX, y: e.clientY })
  }

  const handleAction = async (action: string, tunnel: TunnelWithState) => {
    setContextMenu(null)
    try {
      switch (action) {
        case 'stop': await stopTunnel(tunnel.id); break
        case 'reconnect': await reconnectTunnel(tunnel.id); break
        case 'copy': await navigator.clipboard.writeText(`${tunnel.bind_address}:${tunnel.local_port}`); break
        case 'edit': onManageTunnels(); onClose(); break
      }
      useTunnelStore.getState().fetchTunnels()
    } catch (err) {
      console.error(`Tunnel action '${action}' failed:`, err)
    }
  }

  const renderTunnelRow = (tunnel: TunnelWithState, isSession: boolean) => (
    <div
      key={tunnel.id}
      className="tunnel-popover-item"
      onContextMenu={(e) => handleContextMenu(e, tunnel)}
    >
      <span className={`tunnel-popover-dot ${tunnel.status}`} />
      <div className="tunnel-popover-info">
        {!isSession && <div className="tunnel-popover-name">{tunnel.name}</div>}
        <div className="tunnel-popover-spec">
          {formatTunnelSpec(tunnel)} via {tunnel.host}
          {tunnel.uptime_secs !== null && ` · up ${formatUptime(tunnel.uptime_secs)}`}
        </div>
      </div>
      {tunnel.status === 'reconnecting' && (
        <span className="tunnel-popover-meta error">retry {tunnel.retry_count}</span>
      )}
      {!isSession && (
        <button
          className={`tunnel-popover-toggle ${tunnel.status === 'connected' || tunnel.status === 'connecting' || tunnel.status === 'reconnecting' ? 'active' : ''}`}
          onClick={(e) => handleToggle(e, tunnel)}
          title={tunnel.status === 'connected' || tunnel.status === 'connecting' || tunnel.status === 'reconnecting' ? 'Stop tunnel' : 'Start tunnel'}
        >
          <span className="tunnel-popover-toggle-track">
            <span className="tunnel-popover-toggle-thumb" />
          </span>
        </button>
      )}
    </div>
  )

  return (
    <div className="tunnel-popover" ref={menuRef}>
      <div className="tunnel-popover-search">
        <input
          ref={searchRef}
          type="search"
          placeholder="Search tunnels..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="tunnel-popover-list">
        {totalVisible === 0 ? (
          <div className="tunnel-popover-empty">
            <div className="tunnel-popover-empty-icon">&#8651;</div>
            <div className="tunnel-popover-empty-text">
              {loadError
                ? `Failed to load tunnels: ${loadError}`
                : tunnels.length === 0 ? 'No tunnels configured' : 'No matching tunnels'}
            </div>
            {tunnels.length === 0 && (
              <div className="tunnel-popover-empty-hint">
                Create persistent SSH tunnels in<br />Manage Tunnels
              </div>
            )}
          </div>
        ) : (
          <>
            {persistentTunnels.length > 0 && sessionGroups.length > 0 && (
              <div className="tunnel-popover-section-header">Tunnels</div>
            )}
            {persistentTunnels.map(t => renderTunnelRow(t, false))}

            {sessionGroups.length > 0 && (
              <>
                <div className="tunnel-popover-section-header">Session Tunnels</div>
                {sessionGroups.map(([host, sessionTunnels]) => (
                  <div key={host}>
                    <div className="tunnel-popover-session-name">{host}</div>
                    {sessionTunnels.map(t => renderTunnelRow(t, true))}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <div className="tunnel-popover-footer">
        <button onClick={() => { onManageTunnels(); onClose() }}>
          &#9881; Manage Tunnels...
        </button>
      </div>

      {contextMenu && (
        <div ref={contextMenuRef} className="tunnel-context-menu" style={contextMenuStyle}>
          {contextMenu.tunnel.status === 'connected' && (
            <div className="tunnel-context-item" onClick={() => handleAction('stop', contextMenu.tunnel)}>&#9198; Pause</div>
          )}
          {(contextMenu.tunnel.status === 'failed' || contextMenu.tunnel.status === 'disconnected') && (
            <div className="tunnel-context-item" onClick={() => handleAction('reconnect', contextMenu.tunnel)}>&#128260; Reconnect</div>
          )}
          <div className="tunnel-context-item" onClick={() => handleAction('copy', contextMenu.tunnel)}>&#128203; Copy local address</div>
          <div className="tunnel-context-separator" />
          <div className="tunnel-context-item" onClick={() => handleAction('edit', contextMenu.tunnel)}>&#9999;&#65039; Edit</div>
        </div>
      )}
    </div>
  )
}
