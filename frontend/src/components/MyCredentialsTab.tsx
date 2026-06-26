import { useState, useEffect, useCallback } from 'react'
import {
  listPersonalCredentials,
  createPersonalCredential,
  updatePersonalCredential,
  deletePersonalCredential,
  revealPersonalCredential,
} from '../api/enterpriseCredentials'
import type { PersonalCredentialSummary, PersonalCredentialInput } from '../api/enterpriseCredentials'
import { PasswordInput } from './PasswordInput'
import './MyCredentialsTab.css'

type CredentialType = PersonalCredentialInput['credential_type']

const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  ssh_password: 'SSH Password',
  ssh_key: 'SSH Key',
  api_token: 'API Token',
  snmp_community: 'SNMP',
  generic_secret: 'Secret',
}

interface FormState {
  name: string
  credential_type: CredentialType
  username: string
  secret: string
  description: string
}

const emptyForm: FormState = {
  name: '',
  credential_type: 'ssh_password',
  username: '',
  secret: '',
  description: '',
}

export default function MyCredentialsTab() {
  const [credentials, setCredentials] = useState<PersonalCredentialSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingCredential, setEditingCredential] = useState<PersonalCredentialSummary | null>(null)
  const [deletingCredential, setDeletingCredential] = useState<PersonalCredentialSummary | null>(null)
  const [revealingCredential, setRevealingCredential] = useState<PersonalCredentialSummary | null>(null)
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [revealReason, setRevealReason] = useState('')
  const [copied, setCopied] = useState(false)

  // Form state
  const [form, setForm] = useState<FormState>(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  const fetchCredentials = useCallback(async () => {
    try {
      const items = await listPersonalCredentials()
      setCredentials(items)
      setError(null)
    } catch {
      setError('Failed to load credentials')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCredentials()
  }, [fetchCredentials])

  // Auto-hide revealed secret after 30 seconds
  useEffect(() => {
    if (revealedSecret) {
      const timer = setTimeout(() => {
        setRevealedSecret(null)
        setRevealingCredential(null)
        setRevealReason('')
      }, 30000)
      return () => clearTimeout(timer)
    }
  }, [revealedSecret])

  // Auto-clear success message
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name || !form.secret) return

    setSubmitting(true)
    setError(null)
    try {
      await createPersonalCredential({
        name: form.name,
        credential_type: form.credential_type,
        username: form.username || undefined,
        secret: form.secret,
        description: form.description || undefined,
      })
      setShowCreateModal(false)
      setForm(emptyForm)
      setSuccess('Credential created')
      await fetchCredentials()
    } catch {
      setError('Failed to create credential')
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingCredential || !form.name) return

    setSubmitting(true)
    setError(null)
    try {
      await updatePersonalCredential(editingCredential.id, {
        name: form.name,
        username: form.username || undefined,
        secret: form.secret || undefined,
        description: form.description || undefined,
      })
      setEditingCredential(null)
      setForm(emptyForm)
      setSuccess('Credential updated')
      await fetchCredentials()
    } catch {
      setError('Failed to update credential')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deletingCredential) return

    setSubmitting(true)
    setError(null)
    try {
      await deletePersonalCredential(deletingCredential.id)
      setDeletingCredential(null)
      setSuccess('Credential deleted')
      await fetchCredentials()
    } catch {
      setError('Failed to delete credential')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReveal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!revealingCredential || !revealReason.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      const result = await revealPersonalCredential(revealingCredential.id, revealReason)
      setRevealedSecret(result.secret)
    } catch {
      setError('Failed to reveal credential')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopy = async () => {
    if (!revealedSecret) return
    try {
      await navigator.clipboard.writeText(revealedSecret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available
    }
  }

  const openEdit = (cred: PersonalCredentialSummary) => {
    setForm({
      name: cred.name,
      credential_type: cred.credential_type,
      username: cred.username || '',
      secret: '',
      description: cred.description || '',
    })
    setEditingCredential(cred)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  if (loading) {
    return <div className="my-credentials">Loading credentials...</div>
  }

  return (
    <div className="my-credentials">
      <div className="my-credentials-header">
        <h3>My Credentials</h3>
        <p className="my-credentials-description">
          Manage your personal credentials. These are private to your account and not shared with other users.
        </p>
      </div>

      {error && <div className="my-credentials-error">{error}</div>}
      {success && <div className="my-credentials-success">{success}</div>}

      <div className="my-credentials-toolbar">
        <button
          className="btn-primary"
          style={{ padding: '8px 16px', background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}
          onClick={() => {
            setForm(emptyForm)
            setShowCreateModal(true)
          }}
        >
          + Add Credential
        </button>
      </div>

      {credentials.length === 0 ? (
        <div className="my-credentials-empty">
          No personal credentials yet. Click "Add Credential" to store your first one.
        </div>
      ) : (
        <table className="my-credentials-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Username</th>
              <th>Created</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((cred) => (
              <tr key={cred.id}>
                <td>{cred.name}</td>
                <td>
                  <span className="credential-type-badge">
                    {CREDENTIAL_TYPE_LABELS[cred.credential_type]}
                  </span>
                </td>
                <td>{cred.username || '-'}</td>
                <td>{formatDate(cred.created_at)}</td>
                <td className="actions-cell">
                  <button
                    className="cred-action-btn"
                    onClick={() => {
                      setRevealReason('')
                      setRevealedSecret(null)
                      setRevealingCredential(cred)
                    }}
                  >
                    Reveal
                  </button>
                  <button className="cred-action-btn" onClick={() => openEdit(cred)}>
                    Edit
                  </button>
                  <button className="cred-action-btn danger" onClick={() => setDeletingCredential(cred)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="cred-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Add Credential</h4>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Production SSH"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Type</label>
                <select
                  value={form.credential_type}
                  onChange={(e) => setForm({ ...form, credential_type: e.target.value as CredentialType })}
                >
                  {Object.entries(CREDENTIAL_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="e.g. admin"
                />
              </div>
              <div className="form-group">
                <label>Secret *</label>
                <PasswordInput
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  placeholder="Password or key"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Optional description"
                  rows={2}
                />
              </div>
              <div className="cred-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={submitting || !form.name || !form.secret}>
                  {submitting ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingCredential && (
        <div className="cred-modal-overlay" onClick={() => setEditingCredential(null)}>
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Edit Credential</h4>
            <form onSubmit={handleUpdate}>
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>New Secret (leave blank to keep current)</label>
                <PasswordInput
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  placeholder="Leave blank to keep existing"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="cred-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setEditingCredential(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={submitting || !form.name}>
                  {submitting ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deletingCredential && (
        <div className="cred-modal-overlay" onClick={() => setDeletingCredential(null)}>
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Delete Credential</h4>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>
              Are you sure you want to delete "{deletingCredential.name}"? This cannot be undone.
            </p>
            <div className="cred-modal-actions">
              <button className="btn-secondary" onClick={() => setDeletingCredential(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleDelete} disabled={submitting}>
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reveal Modal */}
      {revealingCredential && (
        <div className="cred-modal-overlay" onClick={() => {
          setRevealingCredential(null)
          setRevealedSecret(null)
          setRevealReason('')
        }}>
          <div className="cred-modal" onClick={(e) => e.stopPropagation()}>
            <h4>{revealedSecret ? 'Secret Revealed' : 'Reveal Secret'}</h4>
            {revealedSecret ? (
              <>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>
                  Secret for "{revealingCredential.name}". Auto-hides in 30 seconds.
                </p>
                <div className="revealed-secret">
                  <div className="revealed-secret-value">{revealedSecret}</div>
                  <button className="copy-btn" onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="cred-modal-actions">
                  <button className="btn-secondary" onClick={() => {
                    setRevealingCredential(null)
                    setRevealedSecret(null)
                    setRevealReason('')
                  }}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={handleReveal}>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>
                  Provide a reason for accessing "{revealingCredential.name}". This will be logged for audit.
                </p>
                <div className="form-group">
                  <label>Audit Reason *</label>
                  <input
                    type="text"
                    value={revealReason}
                    onChange={(e) => setRevealReason(e.target.value)}
                    placeholder="Reason for accessing this credential"
                    autoFocus
                  />
                </div>
                <div className="cred-modal-actions">
                  <button type="button" className="btn-secondary" onClick={() => {
                    setRevealingCredential(null)
                    setRevealReason('')
                  }}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary" disabled={submitting || !revealReason.trim()}>
                    {submitting ? 'Revealing...' : 'Reveal Secret'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
