import { useState, useEffect, useCallback } from 'react'
import { useTunnelStore } from '../stores/tunnelStore'
import {
  createTunnel, updateTunnel, deleteTunnel,
  startTunnel, stopTunnel,
  formatTunnelSpec, formatUptime,
  type NewTunnel, type TunnelWithState,
} from '../api/tunnels'
import { listProfiles } from '../api/profiles'
import type { CredentialProfile } from '../api/profiles'
import { listJumpHosts, listSessions } from '../api/sessions'
import type { JumpHost, Session } from '../api/sessions'
import { showToast } from './Toast'
import { confirmDialog } from './ConfirmDialog'
import { useMode } from '../hooks/useMode'
import './SettingsTunnels.css'

import { getErrorMessage } from '../api/errors'
type ForwardType = 'local' | 'remote' | 'dynamic'

/** Mirrors the backend's `validate_tunnel_bind_address` (api.rs).
 *  AUDIT FIX (REMOTE-010). */
function isLoopbackAddress(value: string): boolean {
  const v = value.trim()
  if (v === '::1') return true
  // IPv4 literal in 127.0.0.0/8
  const ipv4 = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4) return false
  const octets = ipv4.slice(1, 5).map((o) => parseInt(o, 10))
  if (octets.some((o) => o < 0 || o > 255)) return false
  return octets[0] === 127
}

export default function SettingsTunnels() {
  const tunnels = useTunnelStore(state => state.tunnels)
  const fetchTunnels = useTunnelStore(state => state.fetchTunnels)
  const [profiles, setProfiles] = useState<CredentialProfile[]>([])
  const [jumpHosts, setJumpHosts] = useState<JumpHost[]>([])
  const [jumpSessions, setJumpSessions] = useState<Session[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(22)
  const [profileId, setProfileId] = useState('')
  // Unified jump selection (mutually exclusive at the data layer):
  //   ''             — inherit from profile
  //   'host:<id>'    — a JumpHost record
  //   'session:<id>' — a Session as the jump endpoint
  const [jumpSelection, setJumpSelection] = useState('')
  // Jump hosts are a standalone-mode concept. In enterprise mode the Controller
  // is the egress/jump, so the jump selector is hidden entirely.
  const { isEnterprise } = useMode()
  const [forwardType, setForwardType] = useState<ForwardType>('local')
  const [localPort, setLocalPort] = useState(8080)
  const [bindAddress, setBindAddress] = useState('127.0.0.1')
  const [remoteHost, setRemoteHost] = useState('localhost')
  const [remotePort, setRemotePort] = useState(80)
  const [autoStart, setAutoStart] = useState(false)
  const [autoReconnect, setAutoReconnect] = useState(true)
  const [maxRetries, setMaxRetries] = useState(5)

  // Refresh dropdown sources. Called on mount AND on form-open so a
  // newly-created credential profile / jump host / session shows up
  // without the user having to reload the app.
  const refreshDropdownSources = useCallback(() => {
    listProfiles().then(setProfiles).catch(console.error)
    listJumpHosts().then(setJumpHosts).catch(console.error)
    listSessions().then(setJumpSessions).catch(console.error)
  }, [])

  useEffect(() => {
    fetchTunnels()
    refreshDropdownSources()
  }, [fetchTunnels, refreshDropdownSources])

  function resetForm() {
    setName('')
    setHost('')
    setPort(22)
    setProfileId('')
    setJumpSelection('')
    setForwardType('local')
    setLocalPort(8080)
    setBindAddress('127.0.0.1')
    setRemoteHost('localhost')
    setRemotePort(80)
    setAutoStart(false)
    setAutoReconnect(true)
    setMaxRetries(5)
    setEditingId(null)
    setShowForm(false)
  }

  function handleEdit(tunnel: TunnelWithState) {
    refreshDropdownSources()
    setEditingId(tunnel.id)
    setName(tunnel.name)
    setHost(tunnel.host)
    setPort(tunnel.port)
    setProfileId(tunnel.profile_id)
    if (tunnel.jump_host_id) {
      setJumpSelection(`host:${tunnel.jump_host_id}`)
    } else if (tunnel.jump_session_id) {
      setJumpSelection(`session:${tunnel.jump_session_id}`)
    } else {
      setJumpSelection('')
    }
    setForwardType(tunnel.forward_type)
    setLocalPort(tunnel.local_port)
    setBindAddress(tunnel.bind_address)
    setRemoteHost(tunnel.remote_host || 'localhost')
    setRemotePort(tunnel.remote_port || 80)
    setAutoStart(tunnel.auto_start)
    setAutoReconnect(tunnel.auto_reconnect)
    setMaxRetries(tunnel.max_retries)
    setShowForm(true)
  }

  async function handleSave() {
    if (!name.trim()) {
      showToast('Name is required', 'error')
      return
    }
    if (!host.trim()) {
      showToast('SSH host is required', 'error')
      return
    }
    if (!profileId) {
      showToast('Credential profile is required', 'error')
      return
    }
    if (forwardType !== 'dynamic' && !remoteHost.trim()) {
      showToast('Remote host is required for local/remote forwards', 'error')
      return
    }

    // AUDIT FIX (REMOTE-010): backend rejects non-loopback bind addresses
    // because a `0.0.0.0` SOCKS5 forward is an unauthenticated pivot proxy.
    // Mirror the backend rule client-side so users get an immediate hint
    // rather than a 400 round-trip.
    if (!isLoopbackAddress(bindAddress)) {
      showToast(
        `Bind address must be a loopback address (127.0.0.1 or ::1). ` +
        `Binding to "${bindAddress}" would expose this tunnel to the LAN with no authentication.`,
        'error'
      )
      return
    }

    const payload: NewTunnel = {
      name: name.trim(),
      host: host.trim(),
      port,
      profile_id: profileId,
      jump_host_id: jumpSelection.startsWith('host:') ? jumpSelection.slice(5) : null,
      jump_session_id: jumpSelection.startsWith('session:') ? jumpSelection.slice(8) : null,
      forward_type: forwardType,
      local_port: localPort,
      bind_address: bindAddress,
      remote_host: forwardType === 'dynamic' ? null : remoteHost.trim(),
      remote_port: forwardType === 'dynamic' ? null : remotePort,
      auto_start: autoStart,
      auto_reconnect: autoReconnect,
      max_retries: maxRetries,
    }

    try {
      if (editingId) {
        await updateTunnel(editingId, payload)
        showToast('Tunnel updated', 'success')
      } else {
        await createTunnel(payload)
        showToast('Tunnel created', 'success')
      }
      resetForm()
      fetchTunnels()
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to save tunnel')
      showToast(msg, 'error')
    }
  }

  async function handleDelete(tunnel: TunnelWithState) {
    const ok = await confirmDialog({
      title: 'Delete tunnel?',
      body: <>Delete tunnel <strong>{tunnel.name}</strong>?</>,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteTunnel(tunnel.id)
      showToast('Tunnel deleted', 'success')
      fetchTunnels()
    } catch {
      showToast('Failed to delete tunnel', 'error')
    }
  }

  async function handleToggle(tunnel: TunnelWithState) {
    try {
      if (tunnel.status === 'connected' || tunnel.status === 'connecting' || tunnel.status === 'reconnecting') {
        await stopTunnel(tunnel.id)
        showToast(`Stopped ${tunnel.name}`, 'success')
      } else {
        await startTunnel(tunnel.id)
        showToast(`Starting ${tunnel.name}`, 'success')
      }
      fetchTunnels()
    } catch {
      showToast('Failed to toggle tunnel', 'error')
    }
  }

  const isActive = (t: TunnelWithState) =>
    t.status === 'connected' || t.status === 'connecting' || t.status === 'reconnecting'

  return (
    <div className="settings-content">
      <div className="settings-category">
        <div className="settings-category-header">
          <h3 className="settings-category-title">SSH Tunnels</h3>
          <button
            className="settings-btn settings-btn-primary"
            onClick={() => { resetForm(); refreshDropdownSources(); setShowForm(true) }}
          >
            + New Tunnel
          </button>
        </div>

        {showForm && (
          <div className="tunnel-form">
            <h4 className="tunnel-form-title">{editingId ? 'Edit Tunnel' : 'Create Tunnel'}</h4>

            <div className="tunnel-form-row">
              <div className="tunnel-form-field">
                <label className="setting-label">Name</label>
                <input
                  type="text"
                  className="setting-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My Tunnel"
                />
              </div>
            </div>

            <div className="tunnel-form-row">
              <div className="tunnel-form-field">
                <label className="setting-label">SSH Host</label>
                <input
                  type="text"
                  className="setting-input"
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="192.168.1.1"
                />
              </div>
              <div className="tunnel-form-field tunnel-form-field-small">
                <label className="setting-label">Port</label>
                <input
                  type="number"
                  className="setting-input"
                  value={port}
                  onChange={e => setPort(parseInt(e.target.value, 10) || 22)}
                />
              </div>
            </div>

            <div className="tunnel-form-row">
              <div className="tunnel-form-field">
                <label className="setting-label">Credential Profile</label>
                <select className="setting-select" value={profileId} onChange={e => setProfileId(e.target.value)}>
                  <option value="">Select profile...</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {!isEnterprise && (
              <div className="tunnel-form-field">
                <label className="setting-label">Jump (optional)</label>
                <select className="setting-select" value={jumpSelection} onChange={e => setJumpSelection(e.target.value)}>
                  {(() => {
                    const profile = profiles.find(p => p.id === profileId)
                    let inheritedName = 'direct'
                    if (profile?.jump_host_id) {
                      inheritedName = jumpHosts.find(j => j.id === profile.jump_host_id)?.name ?? '(deleted jump host)'
                    } else if (profile?.jump_session_id) {
                      const sess = jumpSessions.find(s => s.id === profile.jump_session_id)
                      inheritedName = sess ? `session: ${sess.name}` : '(deleted session)'
                    }
                    return (
                      <option value="">{`Inherit from profile (${inheritedName})`}</option>
                    )
                  })()}
                  {jumpSessions.length > 0 && (
                    <optgroup label="Sessions">
                      {jumpSessions.map(s => (
                        <option key={`session:${s.id}`} value={`session:${s.id}`}>{s.name} ({s.host})</option>
                      ))}
                    </optgroup>
                  )}
                  {jumpHosts.length > 0 && (
                    <optgroup label="Jump Hosts">
                      {jumpHosts.map(j => (
                        <option key={`host:${j.id}`} value={`host:${j.id}`}>{j.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              )}
            </div>

            <div className="tunnel-form-row">
              <div className="tunnel-form-field">
                <label className="setting-label">Forward Type</label>
                <select
                  className="setting-select"
                  value={forwardType}
                  onChange={e => setForwardType(e.target.value as ForwardType)}
                >
                  <option value="local">Local (-L)</option>
                  <option value="remote">Remote (-R)</option>
                  <option value="dynamic">Dynamic (-D) SOCKS5</option>
                </select>
              </div>
              <div className="tunnel-form-field tunnel-form-field-small">
                <label className="setting-label">Local Port</label>
                <input
                  type="number"
                  className="setting-input"
                  value={localPort}
                  onChange={e => setLocalPort(parseInt(e.target.value, 10) || 0)}
                />
              </div>
              {forwardType !== 'dynamic' && (
                <>
                  <div className="tunnel-form-field">
                    <label className="setting-label">Remote Host</label>
                    <input
                      type="text"
                      className="setting-input"
                      value={remoteHost}
                      onChange={e => setRemoteHost(e.target.value)}
                      placeholder="localhost"
                    />
                  </div>
                  <div className="tunnel-form-field tunnel-form-field-small">
                    <label className="setting-label">Remote Port</label>
                    <input
                      type="number"
                      className="setting-input"
                      value={remotePort}
                      onChange={e => setRemotePort(parseInt(e.target.value, 10) || 0)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="tunnel-form-toggles">
              <label className="tunnel-form-toggle">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={e => setAutoStart(e.target.checked)}
                />
                Auto-start
              </label>
              <label className="tunnel-form-toggle">
                <input
                  type="checkbox"
                  checked={autoReconnect}
                  onChange={e => setAutoReconnect(e.target.checked)}
                />
                Auto-reconnect
              </label>
              <label className="tunnel-form-toggle">
                Max retries
                <input
                  type="number"
                  className="setting-input tunnel-retries-input"
                  value={maxRetries}
                  onChange={e => setMaxRetries(parseInt(e.target.value, 10) || 0)}
                  min={0}
                  max={100}
                />
              </label>
            </div>

            <div className="tunnel-form-actions">
              <button className="settings-btn" onClick={resetForm}>Cancel</button>
              <button className="settings-btn settings-btn-primary" onClick={handleSave}>
                {editingId ? 'Save Changes' : 'Create Tunnel'}
              </button>
            </div>
          </div>
        )}
      </div>

      {tunnels.length === 0 && !showForm ? (
        <div className="settings-category">
          <div className="setting-item">
            <div className="setting-description" style={{ textAlign: 'center', padding: 'var(--spacing-lg) 0' }}>
              No SSH tunnels configured. Create a tunnel to forward ports through SSH connections.
            </div>
          </div>
        </div>
      ) : (
        <div className="tunnel-list">
          {tunnels.map(tunnel => (
            <div key={tunnel.id} className="tunnel-card">
              <div className={`tunnel-dot ${tunnel.status}`} />
              <div className="tunnel-info">
                <div className="tunnel-name">{tunnel.name}</div>
                <div className="tunnel-meta">
                  <span className="tunnel-spec">{formatTunnelSpec(tunnel)}</span>
                  {tunnel.uptime_secs !== null && tunnel.uptime_secs > 0 && (
                    <span className="tunnel-uptime">{formatUptime(tunnel.uptime_secs)}</span>
                  )}
                  {tunnel.auto_start && (
                    <span className="tunnel-badge">auto-start</span>
                  )}
                </div>
                {tunnel.last_error && tunnel.status === 'failed' && (
                  <div className="tunnel-error" title={tunnel.last_error}>
                    {tunnel.last_error}
                  </div>
                )}
              </div>
              <div className="tunnel-actions">
                {isActive(tunnel) ? (
                  <button
                    className="tunnel-action stop"
                    onClick={() => handleToggle(tunnel)}
                    title="Stop"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="tunnel-action start"
                    onClick={() => handleToggle(tunnel)}
                    title="Start"
                  >
                    Start
                  </button>
                )}
                <button
                  className="tunnel-action"
                  onClick={() => handleEdit(tunnel)}
                  title="Edit"
                >
                  Edit
                </button>
                <button
                  className="tunnel-action danger"
                  onClick={() => handleDelete(tunnel)}
                  title="Delete"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
