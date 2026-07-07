import { useState, useEffect, useCallback } from 'react'
import {
  listMyProfiles,
  listAccessibleProfiles,
  listProfileSecrets,
  createProfileSecret,
  deleteProfileSecret,
  revealProfileSecret,
  setDefaultProfile,
  getUserDefaultProfile,
  type ProfileSecret,
  type OwnedProfile,
} from '../api/enterpriseProfiles'
import type { AccessibleProfile } from '../types/enterpriseProfile'
import { useAuthStore } from '../stores/authStore'
import { PasswordInput } from './PasswordInput'
import './MyCredentialsTab.css'

// Profile-centric auth for enterprise mode: the controller owns the vault and
// profiles are the central auth object. Users manage the auth methods (secrets)
// on their own profiles here; the default profile is what connections use.

const SECRET_TYPE_LABELS: Record<string, string> = {
  password: 'Password',
  ssh_key: 'SSH Key',
  snmp_community: 'SNMP',
  api_token: 'API Token',
  generic_secret: 'Secret',
  certificate: 'Certificate',
}

interface SecretFormState {
  secret_type: string
  username: string
  secret: string
  host: string
  port: string
}

const emptySecretForm: SecretFormState = {
  secret_type: 'password',
  username: '',
  secret: '',
  host: '',
  port: '',
}

export default function EnterpriseProfilesTab() {
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const [profiles, setProfiles] = useState<OwnedProfile[]>([])
  // All profiles the user can connect with (owned + shared/service). The default
  // connection profile may be a SHARED profile the user doesn't own (e.g. a NOC
  // service account), which is why the default picker draws from this list, not
  // just `profiles` (owned).
  const [accessible, setAccessible] = useState<AccessibleProfile[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<ProfileSecret[]>([])
  const [loading, setLoading] = useState(true)
  const [secretsLoading, setSecretsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [settingDefault, setSettingDefault] = useState(false)

  // Modals
  const [showAddSecret, setShowAddSecret] = useState(false)
  const [deletingSecret, setDeletingSecret] = useState<ProfileSecret | null>(null)
  const [revealingSecret, setRevealingSecret] = useState<ProfileSecret | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [revealReason, setRevealReason] = useState('')
  const [form, setForm] = useState<SecretFormState>(emptySecretForm)
  const [submitting, setSubmitting] = useState(false)

  const selected = profiles.find((p) => p.id === selectedId) ?? null

  const fetchProfiles = useCallback(async () => {
    if (!userId) { setLoading(false); return }
    try {
      // The user's own profiles (incl. an empty default to populate) plus the
      // resolved default connection profile (the per-user pointer the controller
      // uses when connecting). Prefer that pointer over the profile-level flag.
      const [shown, allAccessible, resolvedDefault] = await Promise.all([
        listMyProfiles(userId),
        listAccessibleProfiles().catch(() => [] as AccessibleProfile[]),
        getUserDefaultProfile().catch(() => null),
      ])
      setProfiles(shown)
      setAccessible(allAccessible)
      const def = resolvedDefault?.id ?? shown.find((p) => p.is_default)?.id ?? null
      setDefaultId(def)
      setSelectedId((cur) => cur ?? def ?? shown[0]?.id ?? null)
      setError(null)
    } catch {
      setError('Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }, [userId])

  const handleSetDefault = useCallback(async (profileId: string | null) => {
    setSettingDefault(true); setError(null)
    try {
      await setDefaultProfile(profileId)
      setDefaultId(profileId)
      setSuccess('Default profile updated')
      await fetchProfiles()
    } catch {
      setError('Failed to set default profile')
    } finally {
      setSettingDefault(false)
    }
  }, [fetchProfiles])

  const fetchSecrets = useCallback(async (profileId: string) => {
    setSecretsLoading(true)
    try {
      setSecrets(await listProfileSecrets(profileId))
      setError(null)
    } catch {
      setError('Failed to load profile secrets')
    } finally {
      setSecretsLoading(false)
    }
  }, [])

  useEffect(() => { fetchProfiles() }, [fetchProfiles])
  useEffect(() => { if (selectedId) fetchSecrets(selectedId) }, [selectedId, fetchSecrets])

  useEffect(() => {
    if (revealed) {
      const t = setTimeout(() => { setRevealed(null); setRevealingSecret(null); setRevealReason('') }, 30000)
      return () => clearTimeout(t)
    }
  }, [revealed])

  useEffect(() => {
    if (success) { const t = setTimeout(() => setSuccess(null), 3000); return () => clearTimeout(t) }
  }, [success])

  const handleAddSecret = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedId || !form.secret) return
    setSubmitting(true); setError(null)
    try {
      await createProfileSecret(selectedId, {
        secret_type: form.secret_type,
        username: form.username || null,
        host: form.host || null,
        port: form.port ? Number(form.port) : null,
        secret: form.secret,
      })
      setShowAddSecret(false); setForm(emptySecretForm); setSuccess('Auth method added')
      await fetchSecrets(selectedId)
    } catch {
      setError('Failed to add auth method')
    } finally { setSubmitting(false) }
  }

  const handleDelete = async () => {
    if (!selectedId || !deletingSecret) return
    setSubmitting(true); setError(null)
    try {
      await deleteProfileSecret(selectedId, deletingSecret.id)
      setDeletingSecret(null); setSuccess('Auth method removed')
      await fetchSecrets(selectedId)
    } catch {
      setError('Failed to remove auth method')
    } finally { setSubmitting(false) }
  }

  const handleReveal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedId || !revealingSecret || !revealReason.trim()) return
    setSubmitting(true); setError(null)
    try {
      const r = await revealProfileSecret(selectedId, revealingSecret.id, revealReason)
      setRevealed(r.secret)
    } catch {
      setError('Failed to reveal secret')
    } finally { setSubmitting(false) }
  }

  if (loading) return <div className="my-credentials">Loading profiles…</div>

  return (
    <div className="my-credentials">
      <div className="my-credentials-header">
        <h3>My Profiles</h3>
        <p className="my-credentials-description">
          Profiles are your auth identities, managed by the controller. The default
          profile is used when you connect. Add auth methods (password, SSH key, …)
          to a profile.
        </p>
      </div>

      {error && <div className="my-credentials-error">{error}</div>}
      {success && <div className="my-credentials-success">{success}</div>}

      {/* Default connection profile — draws from ALL accessible profiles (owned +
          shared/service), so a user can default to e.g. a shared NOC service
          account. This is the per-user `default_connection_profile_id` the
          controller uses when you connect without an explicit override. */}
      {accessible.length > 0 && (
        <div className="my-credentials-default-picker" style={{ marginBottom: 16 }}>
          <label htmlFor="default-connection-profile" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
            Default connection profile
          </label>
          <select
            id="default-connection-profile"
            value={defaultId ?? ''}
            disabled={settingDefault}
            onChange={(e) => handleSetDefault(e.target.value || null)}
            style={{ minWidth: 320, padding: '6px 8px' }}
          >
            <option value="">Auto (controller decides)</option>
            {accessible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.profile_type && p.profile_type !== 'personal' ? ` (${p.profile_type})` : ''}
                {p.username ? ` — ${p.username}` : ''}
              </option>
            ))}
          </select>
          <p className="my-credentials-description" style={{ marginTop: 6 }}>
            Used when you connect to a device that has no profile of its own.
          </p>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="my-credentials-empty">
          You have no profiles yet. Ask an administrator to create one, or set a
          default profile in the controller.
        </div>
      ) : (
        <table className="my-credentials-table">
          <thead>
            <tr>
              <th>Profile</th>
              <th>Type</th>
              <th>Username</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                style={{
                  cursor: 'pointer',
                  background: p.id === selectedId ? 'var(--color-bg-hover)' : undefined,
                }}
              >
                <td>
                  {p.name}
                  {p.id === defaultId && (
                    <span className="credential-type-badge" style={{ marginLeft: 8 }}>Default</span>
                  )}
                </td>
                <td>{p.profile_type}</td>
                <td>{p.username || '-'}</td>
                <td style={{ textAlign: 'right' }}>
                  {p.id !== defaultId && (
                    <button
                      className="cred-action-btn"
                      onClick={(e) => { e.stopPropagation(); handleSetDefault(p.id) }}
                      disabled={settingDefault}
                      style={{ marginRight: 8 }}
                    >
                      Set as default
                    </button>
                  )}
                  {p.id === selectedId ? 'Selected' : 'Manage'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div style={{ marginTop: 20 }}>
          <div className="my-credentials-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ fontSize: 14 }}>Auth methods — {selected.name}</h3>
          </div>
          <div className="my-credentials-toolbar" style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn-primary"
              style={{ padding: '8px 16px', background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}
              onClick={() => { setForm(emptySecretForm); setShowAddSecret(true) }}
            >
              + Add auth method
            </button>
          </div>

          {secretsLoading ? (
            <div className="my-credentials-empty">Loading auth methods…</div>
          ) : secrets.length === 0 ? (
            <div className="my-credentials-empty">
              This profile has no auth methods yet.
            </div>
          ) : (
            <table className="my-credentials-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Username</th>
                  <th>Host</th>
                  <th>Priority</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((s) => (
                  <tr key={s.id}>
                    <td><span className="credential-type-badge">{SECRET_TYPE_LABELS[s.secret_type] ?? s.secret_type}</span></td>
                    <td>{s.username || '-'}</td>
                    <td>{s.host || '-'}</td>
                    <td>{s.priority}</td>
                    <td className="actions-cell">
                      <button className="cred-action-btn" onClick={() => { setRevealReason(''); setRevealed(null); setRevealingSecret(s) }}>Reveal</button>
                      <button className="cred-action-btn danger" onClick={() => setDeletingSecret(s)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Add auth method */}
      {showAddSecret && (
        <div className="cred-modal-overlay">
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Add auth method</h4>
            <form onSubmit={handleAddSecret}>
              <div className="form-group">
                <label>Type</label>
                <select value={form.secret_type} onChange={(e) => setForm({ ...form, secret_type: e.target.value })}>
                  {Object.entries(SECRET_TYPE_LABELS).filter(([v]) => v !== 'certificate').map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Username</label>
                <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="e.g. admin" />
              </div>
              <div className="form-group">
                <label>Secret *</label>
                <PasswordInput value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="Password or key material" />
              </div>
              <div className="form-group">
                <label>Host (optional)</label>
                <input type="text" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="restrict to a host" />
              </div>
              <div className="form-group">
                <label>Port (optional)</label>
                <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
              <div className="cred-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowAddSecret(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={submitting || !form.secret}>{submitting ? 'Adding…' : 'Add'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deletingSecret && (
        <div className="cred-modal-overlay" onClick={() => setDeletingSecret(null)}>
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Remove auth method</h4>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>
              Remove the {SECRET_TYPE_LABELS[deletingSecret.secret_type] ?? deletingSecret.secret_type} auth method from this profile? This cannot be undone.
            </p>
            <div className="cred-modal-actions">
              <button className="btn-secondary" onClick={() => setDeletingSecret(null)}>Cancel</button>
              <button className="btn-danger" onClick={handleDelete} disabled={submitting}>{submitting ? 'Removing…' : 'Remove'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Reveal */}
      {revealingSecret && (
        <div className="cred-modal-overlay" onClick={() => { setRevealingSecret(null); setRevealed(null); setRevealReason('') }}>
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>{revealed ? 'Secret Revealed' : 'Reveal Secret'}</h4>
            {revealed ? (
              <>
                <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>Auto-hides in 30 seconds.</p>
                <div className="revealed-secret">
                  <div className="revealed-secret-value">{revealed}</div>
                </div>
                <div className="cred-modal-actions">
                  <button className="btn-secondary" onClick={() => { setRevealingSecret(null); setRevealed(null); setRevealReason('') }}>Close</button>
                </div>
              </>
            ) : (
              <form onSubmit={handleReveal}>
                <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>
                  Provide a reason for revealing this secret. This is logged for audit.
                </p>
                <div className="form-group">
                  <label>Audit Reason *</label>
                  <input type="text" value={revealReason} onChange={(e) => setRevealReason(e.target.value)} placeholder="Reason" autoFocus />
                </div>
                <div className="cred-modal-actions">
                  <button type="button" className="btn-secondary" onClick={() => { setRevealingSecret(null); setRevealReason('') }}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={submitting || !revealReason.trim()}>{submitting ? 'Revealing…' : 'Reveal'}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
