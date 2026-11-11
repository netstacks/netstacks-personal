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
import AITabInput from './AITabInput'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
import './SettingsTunnels.css'

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter'
type ForwardType = 'local' | 'remote' | 'dynamic'

// The agent refuses to start a Remote (-R) forward ("not yet implemented",
// tunnels/mod.rs), so the form no longer offers it (NS-FEAT-8). Existing
// rows that were saved with it are flagged instead of silently failing.
const REMOTE_UNSUPPORTED = 'Remote (-R) forwarding is not supported by the agent yet. Choose Local or Dynamic.'

/** Parse a numeric form field; `null` when empty/non-numeric/out of range. */
function parseIntInRange(raw: string, min: number, max: number): number | null {
  if (!/^\s*-?\d+\s*$/.test(raw)) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

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

/** Status-dot modifier per tunnel state (idle/disconnected keeps the plain dot). */
const TUNNEL_DOT: Partial<Record<TunnelWithState['status'], string>> = {
  connected: ' settings-status-dot--ok',
  connecting: ' settings-status-dot--busy',
  reconnecting: ' settings-status-dot--busy',
  failed: ' settings-status-dot--error',
}

export default function SettingsTunnels() {
  const tunnels = useTunnelStore(state => state.tunnels)
  const loadError = useTunnelStore(state => state.error)
  const fetchTunnels = useTunnelStore(state => state.fetchTunnels)
  const [profiles, setProfiles] = useState<CredentialProfile[]>([])
  const [jumpHosts, setJumpHosts] = useState<JumpHost[]>([])
  const [jumpSessions, setJumpSessions] = useState<Session[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  // Numeric fields are kept as raw text so the user can clear them while
  // typing (NS-SET-8); they're parsed + range-checked in handleSave.
  const [port, setPort] = useState('22')
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
  const [localPort, setLocalPort] = useState('8080')
  const [bindAddress, setBindAddress] = useState('127.0.0.1')
  const [remoteHost, setRemoteHost] = useState('localhost')
  const [remotePort, setRemotePort] = useState('80')
  const [autoStart, setAutoStart] = useState(false)
  const [autoReconnect, setAutoReconnect] = useState(true)
  const [maxRetries, setMaxRetries] = useState('5')

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

  const isActive = (t: TunnelWithState) =>
    t.status === 'connected' || t.status === 'connecting' || t.status === 'reconnecting'

  function resetForm() {
    setName('')
    setHost('')
    setPort('22')
    setProfileId('')
    setJumpSelection('')
    setForwardType('local')
    setLocalPort('8080')
    setBindAddress('127.0.0.1')
    setRemoteHost('localhost')
    setRemotePort('80')
    setAutoStart(false)
    setAutoReconnect(true)
    setMaxRetries('5')
    setEditingId(null)
    setShowForm(false)
  }

  function handleEdit(tunnel: TunnelWithState) {
    refreshDropdownSources()
    setEditingId(tunnel.id)
    setName(tunnel.name)
    setHost(tunnel.host)
    setPort(String(tunnel.port))
    setProfileId(tunnel.profile_id)
    if (tunnel.jump_host_id) {
      setJumpSelection(`host:${tunnel.jump_host_id}`)
    } else if (tunnel.jump_session_id) {
      setJumpSelection(`session:${tunnel.jump_session_id}`)
    } else {
      setJumpSelection('')
    }
    setForwardType(tunnel.forward_type)
    setLocalPort(String(tunnel.local_port))
    setBindAddress(tunnel.bind_address)
    setRemoteHost(tunnel.remote_host || 'localhost')
    setRemotePort(String(tunnel.remote_port || 80))
    setAutoStart(tunnel.auto_start)
    setAutoReconnect(tunnel.auto_reconnect)
    setMaxRetries(String(tunnel.max_retries))
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
    if (forwardType === 'remote') {
      showToast(REMOTE_UNSUPPORTED, 'error')
      return
    }
    if (forwardType !== 'dynamic' && !remoteHost.trim()) {
      showToast('Remote host is required for local forwards', 'error')
      return
    }
    const portNum = parseIntInRange(port, 1, 65535)
    if (portNum === null) {
      showToast('SSH port must be a number between 1 and 65535', 'error')
      return
    }
    const localPortNum = parseIntInRange(localPort, 1, 65535)
    if (localPortNum === null) {
      showToast('Local port must be a number between 1 and 65535', 'error')
      return
    }
    const remotePortNum = forwardType === 'dynamic' ? null : parseIntInRange(remotePort, 1, 65535)
    if (forwardType !== 'dynamic' && remotePortNum === null) {
      showToast('Remote port must be a number between 1 and 65535', 'error')
      return
    }
    const maxRetriesNum = parseIntInRange(maxRetries, 0, 100)
    if (maxRetriesNum === null) {
      showToast('Max retries must be a number between 0 and 100', 'error')
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
      port: portNum,
      profile_id: profileId,
      jump_host_id: jumpSelection.startsWith('host:') ? jumpSelection.slice(5) : null,
      jump_session_id: jumpSelection.startsWith('session:') ? jumpSelection.slice(8) : null,
      forward_type: forwardType,
      local_port: localPortNum,
      bind_address: bindAddress,
      remote_host: forwardType === 'dynamic' ? null : remoteHost.trim(),
      remote_port: remotePortNum,
      auto_start: autoStart,
      auto_reconnect: autoReconnect,
      max_retries: maxRetriesNum,
    }

    try {
      if (editingId) {
        // The agent stops a tunnel before applying an update; bring it back
        // up so an edit doesn't silently leave it down (NS-FEAT-12).
        const wasRunning = tunnels.some(t => t.id === editingId && isActive(t))
        await updateTunnel(editingId, payload)
        if (wasRunning) {
          try {
            await startTunnel(editingId)
            showToast('Tunnel restarted', 'success')
          } catch (err) {
            showToast(getErrorMessage(err, 'Tunnel updated but failed to restart'), 'error')
          }
        } else {
          showToast('Tunnel updated', 'success')
        }
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

  return (
    <SettingsSection
        title="SSH Tunnels"
        help={{
          topic: 'SSH tunnels',
          prompt: `Help me set up SSH tunnels in NetStacks. I have ${tunnels.length} tunnel(s)`
            + (tunnels.length ? ` (${tunnels.map(t => `${t.name}: ${t.forward_type}`).join(', ')})` : '')
            + '. Explain local (-L) vs dynamic SOCKS5 (-D) forwards, which profile and jump host a tunnel uses, bind address and ports (and why binding beyond loopback is risky), auto-start, and give an example for reaching a device web UI behind a bastion.',
        }}
        actions={
          <button
            className="ns-btn ns-btn--small"
            onClick={() => { resetForm(); refreshDropdownSources(); setShowForm(true) }}
          >
            + New tunnel
          </button>
        }
      >

        {showForm && (
          <div className="settings-form">
            <h4 className="settings-form-title">{editingId ? 'Edit Tunnel' : 'Create Tunnel'}</h4>

            <div className="settings-form-row">
              <div className="form-group">
                <label>Name</label>
                <AITabInput
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My Tunnel"
                  aiField="tunnel_name"
                  aiPlaceholder="Name for this SSH tunnel"
                  aiContext={{
                    host,
                    forward_type: forwardType,
                    local_port: localPort,
                    remote_host: remoteHost,
                    remote_port: remotePort,
                  }}
                  onAIValue={v => setName(v)}
                />
              </div>
            </div>

            <div className="settings-form-row">
              <div className="form-group">
                <label>SSH Host</label>
                <input data-ai-fill="off"
                  type="text"
                  className="ns-input"
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="192.168.1.1"
                />
              </div>
              <div className="form-group form-group--narrow">
                <label>Port</label>
                <input aria-label="Port"
                  type="number"
                  className="ns-input"
                  value={port}
                  min={1}
                  max={65535}
                  onChange={e => setPort(e.target.value)}
                />
              </div>
            </div>

            <div className="settings-form-row">
              <div className="form-group">
                <label>Credential Profile</label>
                <select aria-label="Credential Profile" className="ns-select" value={profileId} onChange={e => setProfileId(e.target.value)}>
                  <option value="">Select profile...</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {!isEnterprise && (
              <div className="form-group">
                <label>Jump (optional)</label>
                <select aria-label="Jump (optional)" className="ns-select" value={jumpSelection} onChange={e => setJumpSelection(e.target.value)}>
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

            <div className="settings-form-row">
              <div className="form-group">
                <label>Forward Type</label>
                <select aria-label="Forward Type"
                  className="ns-select"
                  value={forwardType}
                  onChange={e => setForwardType(e.target.value as ForwardType)}
                >
                  <option value="local">Local (-L)</option>
                  {forwardType === 'remote' && (
                    <option value="remote" disabled>Remote (-R) — unsupported</option>
                  )}
                  <option value="dynamic">Dynamic (-D) SOCKS5</option>
                </select>
                {forwardType === 'remote' && (
                  <p className="form-hint settings-error">{REMOTE_UNSUPPORTED}</p>
                )}
              </div>
              <div className="form-group form-group--narrow">
                <label>Local Port</label>
                <input aria-label="Local Port"
                  type="number"
                  className="ns-input"
                  value={localPort}
                  min={1}
                  max={65535}
                  onChange={e => setLocalPort(e.target.value)}
                />
              </div>
              {forwardType !== 'dynamic' && (
                <>
                  <div className="form-group">
                    <label>Remote Host</label>
                    <input data-ai-fill="off"
                      type="text"
                      className="ns-input"
                      value={remoteHost}
                      onChange={e => setRemoteHost(e.target.value)}
                      placeholder="localhost"
                    />
                  </div>
                  <div className="form-group form-group--narrow">
                    <label>Remote Port</label>
                    <input aria-label="Remote Port"
                      type="number"
                      className="ns-input"
                      value={remotePort}
                      min={1}
                      max={65535}
                      onChange={e => setRemotePort(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="settings-form-checks">
              <label>
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={e => setAutoStart(e.target.checked)}
                />
                Auto-start
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={autoReconnect}
                  onChange={e => setAutoReconnect(e.target.checked)}
                />
                Auto-reconnect
              </label>
              <label>
                Max retries
                <input
                  type="number"
                  className="ns-input tunnels-retries-input"
                  value={maxRetries}
                  onChange={e => setMaxRetries(e.target.value)}
                  min={0}
                  max={100}
                />
              </label>
            </div>

            <DialogFooter
              primary={{ label: editingId ? 'Save Changes' : 'Create Tunnel', onClick: handleSave }}
              onCancel={resetForm}
              inline
            />
          </div>
        )}

        {loadError && !showForm ? (
          <p className="settings-error">
            Failed to load tunnels: {loadError}{' '}
            <button className="ns-btn ns-btn--small" onClick={() => fetchTunnels()}>Retry</button>
          </p>
        ) : tunnels.length === 0 && !showForm ? (
          <p className="form-hint">No SSH tunnels yet. Create a tunnel to forward ports through SSH connections.</p>
        ) : tunnels.length > 0 && (
          <div className="settings-group">
            {tunnels.map(tunnel => (
              <SettingsItem
                key={tunnel.id}
                leading={<span className={`settings-status-dot${TUNNEL_DOT[tunnel.status] ?? ''}`} role="img" aria-label={tunnel.status} />}
                title={tunnel.name}
                badges={tunnel.auto_start && <span className="settings-badge">auto-start</span>}
                meta={
                  <>
                    <code>{formatTunnelSpec(tunnel)}</code>
                    {tunnel.uptime_secs !== null && tunnel.uptime_secs > 0 && <span>{formatUptime(tunnel.uptime_secs)}</span>}
                    {tunnel.forward_type === 'remote' && <span className="settings-error">{REMOTE_UNSUPPORTED}</span>}
                    {tunnel.last_error && tunnel.status === 'failed' && <span className="settings-error">{tunnel.last_error}</span>}
                  </>
                }
                actions={
                  <>
                    {isActive(tunnel) ? (
                      <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleToggle(tunnel)}>Stop</button>
                    ) : (
                      <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleToggle(tunnel)}>Start</button>
                    )}
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleEdit(tunnel)}>Edit</button>
                    <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDelete(tunnel)}>Delete</button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>
  )
}
