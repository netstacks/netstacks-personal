import { useState, useEffect, useCallback, useRef } from 'react'
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
import './EnterpriseProfilesTab.css'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
import SettingRow from './settings/SettingRow'

import DialogFooter from './DialogFooter'
import ModalFrame from './ModalFrame'
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
  const addSecretFormRef = useRef<HTMLFormElement>(null)
  const revealFormRef = useRef<HTMLFormElement>(null)
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

  if (loading) return <p className="form-hint">Loading profiles…</p>

  return (
    <>
      <SettingsSection
        title="My Profiles"
        description="Profiles are your auth identities, managed by the controller. The default profile is used when you connect. Add auth methods (password, SSH key, …) to a profile."
      >
        {error && <p className="settings-error">{error}</p>}
        {success && <p className="settings-success">{success}</p>}

        {/* Default connection profile — draws from ALL accessible profiles (owned +
            shared/service), so a user can default to e.g. a shared NOC service
            account. This is the per-user `default_connection_profile_id` the
            controller uses when you connect without an explicit override. */}
        {accessible.length > 0 && (
          <div className="settings-group">
            <SettingRow label="Default connection profile" description="Used when you connect to a device that has no profile of its own.">
              <select className="ns-select"
                aria-label="Default connection profile"
                value={defaultId ?? ''}
                disabled={settingDefault}
                onChange={(e) => handleSetDefault(e.target.value || null)}
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
            </SettingRow>
          </div>
        )}

        {profiles.length === 0 ? (
          <p className="form-hint">
            You have no profiles yet. Ask an administrator to create one, or set a
            default profile in the controller.
          </p>
        ) : (
          <div className="settings-group">
            {profiles.map((p) => (
              <SettingsItem
                key={p.id}
                onActivate={() => setSelectedId(p.id)}
                title={p.name}
                badges={
                  <>
                    {p.id === defaultId && <span className="settings-badge settings-badge--accent">Default</span>}
                    {p.id === selectedId && <span className="settings-badge">Selected</span>}
                  </>
                }
                meta={<>{p.profile_type}{p.username && <span>{p.username}</span>}</>}
                actions={p.id !== defaultId && (
                  <button
                    className="ns-btn ns-btn--ghost ns-btn--small"
                    onClick={() => handleSetDefault(p.id)}
                    disabled={settingDefault}
                  >
                    Set as default
                  </button>
                )}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {selected && (
        <SettingsSection
          title={`Auth methods — ${selected.name}`}
          actions={!showAddSecret && (
            <button
              className="ns-btn ns-btn--small"
              onClick={() => { setForm(emptySecretForm); setShowAddSecret(true) }}
            >
              + Add auth method
            </button>
          )}
        >
          {showAddSecret && (
            <form ref={addSecretFormRef} className="settings-form" onSubmit={handleAddSecret}>
              <h4 className="settings-form-title">Add auth method</h4>
              <div className="settings-form-row">
                <div className="form-group">
                  <label htmlFor="auth-method-type">Type</label>
                  <select id="auth-method-type" className="ns-select" value={form.secret_type} onChange={(e) => setForm({ ...form, secret_type: e.target.value })}>
                    {Object.entries(SECRET_TYPE_LABELS).filter(([v]) => v !== 'certificate').map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="auth-method-username">Username</label>
                  <input data-ai-fill="off" id="auth-method-username" className="ns-input" type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="e.g. admin" />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="auth-method-secret">Secret *</label>
                <PasswordInput id="auth-method-secret" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="Password or key material" />
              </div>
              <div className="settings-form-row">
                <div className="form-group">
                  <label htmlFor="auth-method-host">Host (optional)</label>
                  <input data-ai-fill="off" id="auth-method-host" className="ns-input" type="text" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="restrict to a host" />
                </div>
                <div className="form-group form-group--narrow">
                  <label htmlFor="auth-method-port">Port (optional)</label>
                  <input id="auth-method-port" className="ns-input" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
                </div>
              </div>
              <DialogFooter
                primary={{ label: submitting ? 'Adding…' : 'Add', onClick: () => addSecretFormRef.current?.requestSubmit(), disabled: submitting || !form.secret }}
                onCancel={() => setShowAddSecret(false)}
                inline
              />
            </form>
          )}

          {secretsLoading ? (
            <p className="form-hint">Loading auth methods…</p>
          ) : secrets.length === 0 ? (
            <p className="form-hint">This profile has no auth methods yet.</p>
          ) : (
            <div className="settings-group">
              {secrets.map((s) => (
                <SettingsItem
                  key={s.id}
                  title={SECRET_TYPE_LABELS[s.secret_type] ?? s.secret_type}
                  meta={
                    <>
                      {s.username && <span>{s.username}</span>}
                      {s.host && <span>{s.host}</span>}
                      <span>Priority {s.priority}</span>
                    </>
                  }
                  actions={
                    <>
                      <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => { setRevealReason(''); setRevealed(null); setRevealingSecret(s) }}>Reveal</button>
                      <button className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small" onClick={() => setDeletingSecret(s)}>Delete</button>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      {/* Delete confirm */}
      {deletingSecret && (
        <ModalFrame id="cred-delete" onDismiss={() => setDeletingSecret(null)} resizable={false} className="cred-modal" label="Delete credential">
          <h4>Remove auth method</h4>
          <p className="form-hint">
            Remove the {SECRET_TYPE_LABELS[deletingSecret.secret_type] ?? deletingSecret.secret_type} auth method from this profile? This cannot be undone.
          </p>
          <DialogFooter
            primary={{ label: submitting ? 'Removing…' : 'Remove', onClick: handleDelete, disabled: submitting, danger: true }}
            onCancel={() => setDeletingSecret(null)}
            inline
          />
        </ModalFrame>
      )}

      {/* Reveal */}
      {revealingSecret && (
        <ModalFrame id="cred-reveal" onDismiss={() => { setRevealingSecret(null); setRevealed(null); setRevealReason('') }} resizable={false} className="cred-modal" label="Reveal secret">
          <h4>{revealed ? 'Secret Revealed' : 'Reveal Secret'}</h4>
          {revealed ? (
            <>
              <p className="form-hint">Auto-hides in 30 seconds.</p>
              <div className="revealed-secret-value">{revealed}</div>
              <div className="cred-modal-actions">
                <button className="ns-btn" onClick={() => { setRevealingSecret(null); setRevealed(null); setRevealReason('') }}>Close</button>
              </div>
            </>
          ) : (
            <form ref={revealFormRef} className="cred-modal-form" onSubmit={handleReveal}>
              <p className="form-hint">
                Provide a reason for revealing this secret. This is logged for audit.
              </p>
              <div className="form-group">
                <label htmlFor="reveal-reason">Audit Reason *</label>
                <input data-ai-fill="off" id="reveal-reason" className="ns-input" type="text" value={revealReason} onChange={(e) => setRevealReason(e.target.value)} placeholder="Reason" autoFocus />
              </div>
              <DialogFooter
                primary={{ label: submitting ? 'Revealing…' : 'Reveal', onClick: () => revealFormRef.current?.requestSubmit(), disabled: submitting || !revealReason.trim() }}
                onCancel={() => { setRevealingSecret(null); setRevealReason('') }}
                inline
              />
            </form>
          )}
        </ModalFrame>
      )}
    </>
  )
}
