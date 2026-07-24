import { getErrorMessage } from '../api/errors'
/**
 * DeviceEditDialog - Modal dialog for editing device properties
 */

import { useState, useEffect } from 'react'
import AITabInput from './AITabInput'
import type { Device, DeviceType, DeviceStatus } from '../types/topology'
import { useSubmitting } from '../hooks/useSubmitting'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import { useDirtyGuard } from '../hooks/useDirtyGuard'
import './DeviceEditDialog.css'

interface DeviceEditDialogProps {
  device: Device | null
  /** Sync or async — the dialog tracks pending state if it returns a Promise. */
  onSave: (updates: Partial<Device>) => void | Promise<void>
  onClose: () => void
}

const DEVICE_TYPES: { value: DeviceType; label: string }[] = [
  { value: 'router', label: 'Router' },
  { value: 'switch', label: 'Switch' },
  { value: 'firewall', label: 'Firewall' },
  { value: 'server', label: 'Server' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'access-point', label: 'Access Point' },
  { value: 'load-balancer', label: 'Load Balancer' },
  { value: 'wan-optimizer', label: 'WAN Optimizer' },
  { value: 'voice-gateway', label: 'Voice Gateway' },
  { value: 'wireless-controller', label: 'Wireless Controller' },
  { value: 'storage', label: 'Storage' },
  { value: 'virtual', label: 'Virtual' },
  { value: 'sd-wan', label: 'SD-WAN' },
  { value: 'iot', label: 'IoT' },
  { value: 'unknown', label: 'Unknown' },
]

const DEVICE_STATUSES: { value: DeviceStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'warning', label: 'Warning' },
  { value: 'unknown', label: 'Unknown' },
]

export default function DeviceEditDialog({ device, onSave, onClose }: DeviceEditDialogProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState<DeviceType>('unknown')
  const [status, setStatus] = useState<DeviceStatus>('unknown')
  const [site, setSite] = useState('')
  const [role, setRole] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Initialize form when device changes
  useEffect(() => {
    if (device) {
      setName(device.name)
      setType(device.type)
      setStatus(device.status)
      setSite(device.site || '')
      setRole(device.role || '')
    }
  }, [device])

  const { submitting, run } = useSubmitting()

  // Track dirty state vs the device passed in — discard prompt fires
  // on any close path (Escape, X, overlay click, Cancel) when changed.
  const { confirmDiscard, reset: resetDirty } = useDirtyGuard(
    { name, type, status, site, role },
    {
      initial: device
        ? {
            name: device.name,
            type: device.type,
            status: device.status,
            site: device.site || '',
            role: device.role || '',
          }
        : undefined,
      resetKey: device?.id ?? null,
    },
  )

  const guardedClose = async () => {
    if (await confirmDiscard()) onClose()
  }

  // Hooks must run unconditionally (before any early return). Gate dismissal so
  // it's inactive when there's no device or while submitting.
  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: guardedClose, clickOutside: false, enabled: !submitting && !!device })

  if (!device) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    run(async () => {
      try {
        await Promise.resolve(onSave({
          name,
          type,
          status,
          site: site || undefined,
          role: role || undefined,
        }))
        // Order matters: reset the dirty baseline BEFORE close so the
        // discard guard doesn't re-fire on the way out.
        resetDirty()
        onClose()
      } catch (err) {
        // Surface inline rather than letting the error escape as an
        // unhandled promise rejection (the dialog kept silent and
        // users assumed nothing happened, then clicked Save a second
        // time and double-saved).
        setError(getErrorMessage(err, 'Failed to save device'))
      }
    })
  }


  return (
    <div className="device-edit-dialog-overlay" {...backdropProps}>
      <div className="device-edit-dialog" {...contentProps}>
        <div className="device-edit-dialog-header">
          <h2>Edit Device</h2>
          <button className="device-edit-dialog-close" onClick={guardedClose} title="Close" disabled={submitting}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="device-edit-dialog-content">
          <div className="device-edit-field">
            <label htmlFor="device-name">Name</label>
            <input
              id="device-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-type">Type</label>
            <select
              id="device-type"
              value={type}
              onChange={e => setType(e.target.value as DeviceType)}
            >
              {DEVICE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-status">Status</label>
            <select
              id="device-status"
              value={status}
              onChange={e => setStatus(e.target.value as DeviceStatus)}
            >
              {DEVICE_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-site">Site</label>
            <input
              id="device-site"
              type="text"
              value={site}
              onChange={e => setSite(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="device-edit-field">
            <label htmlFor="device-role">Role</label>
            <AITabInput
              id="device-role"
              type="text"
              value={role}
              onChange={e => setRole(e.target.value)}
              placeholder="Optional"
              aiField="role"
              aiPlaceholder="Device role (e.g. core router, ToR switch)"
              aiContext={{ name, type }}
              onAIValue={v => setRole(v)}
            />
          </div>

          {error && (
            <div
              className="device-edit-dialog-error"
              role="alert"
              style={{
                padding: '8px 12px',
                marginTop: 8,
                background: 'rgba(244, 67, 54, 0.1)',
                border: '1px solid var(--color-error)',
                borderRadius: 4,
                color: 'var(--color-error)',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          <div className="device-edit-dialog-actions">
            <button type="button" className="device-edit-btn-cancel" onClick={guardedClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="device-edit-btn-save" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
