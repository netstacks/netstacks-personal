import { useState, useEffect, useCallback } from 'react'
import './IncidentDetailTab.css'
import {
  getIncident,
  createIncident,
  updateIncident,
  deleteIncident,
  linkAlert,
  unlinkAlert,
  getComments,
  addComment,
} from '../api/incidents'
import { useAuthStore } from '../stores/authStore'
import type {
  Incident,
  IncidentComment,
  IncidentState,
  IncidentSeverity,
  CreateIncidentInput,
} from '../types/incidents'
import AITabInput from './AITabInput'

import { getErrorMessage } from '../api/errors'
interface IncidentDetailTabProps {
  incidentId?: string
  onOpenAlertTab: (id: string) => void
  onClose: () => void
  onTitleChange: (title: string) => void
  onCreated: (id: string, title: string) => void
}

const ALL_STATES: IncidentState[] = [
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'closed',
]

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleString()
  } catch {
    return '—'
  }
}

function formatCreatedFrom(val: string): string {
  return val.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function severityBadgeClass(severity: string): string {
  return `incident-detail-badge severity-${severity}`
}

function stateBadgeClass(state: string): string {
  return `incident-detail-badge state-${state}`
}

export default function IncidentDetailTab({
  incidentId,
  onOpenAlertTab,
  onClose,
  onTitleChange,
  onCreated,
}: IncidentDetailTabProps) {
  const user = useAuthStore((s) => s.user)

  // -- Create mode state --
  const [createTitle, setCreateTitle] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createSeverity, setCreateSeverity] = useState<IncidentSeverity>('medium')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // -- View/Edit mode state --
  const [incident, setIncident] = useState<Incident | null>(null)
  const [comments, setComments] = useState<IncidentComment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Inline editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editingDescription, setEditingDescription] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [editingSeverity, setEditingSeverity] = useState(false)
  const [saving, setSaving] = useState(false)

  // Inline panels
  const [showUpdateState, setShowUpdateState] = useState(false)
  const [newState, setNewState] = useState<IncidentState>('open')
  const [updatingState, setUpdatingState] = useState(false)

  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Link alert
  const [linkAlertId, setLinkAlertId] = useState('')
  const [linking, setLinking] = useState(false)
  const [unlinking, setUnlinking] = useState<string | null>(null)

  // Comment
  const [commentText, setCommentText] = useState('')
  const [posting, setPosting] = useState(false)

  // -- Fetch incident + comments --
  const fetchData = useCallback(async () => {
    if (!incidentId) return
    setLoading(true)
    setError(null)
    try {
      const [inc, cmts] = await Promise.all([
        getIncident(incidentId),
        getComments(incidentId),
      ])
      setIncident(inc)
      setComments(cmts)
      onTitleChange(inc.title)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load incident'))
    } finally {
      setLoading(false)
    }
  }, [incidentId, onTitleChange])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // -- CREATE MODE --
  if (!incidentId) {
    const handleCreate = async () => {
      if (!createTitle.trim()) return
      setCreating(true)
      setCreateError(null)
      try {
        const input: CreateIncidentInput = {
          title: createTitle.trim(),
          severity: createSeverity,
        }
        if (createDescription.trim()) {
          input.description = createDescription.trim()
        }
        const result = await createIncident(input)
        onCreated(result.id, result.title)
      } catch (err) {
        setCreateError(getErrorMessage(err, 'Failed to create incident'))
      } finally {
        setCreating(false)
      }
    }

    return (
      <div className="incident-detail-container">
        <div className="incident-detail-header">
          <div className="incident-detail-header-info">
            <h2 className="incident-detail-title">Create Incident</h2>
          </div>
        </div>
        <div className="incident-detail-content">
          <div className="incident-detail-section">
            <div className="incident-detail-section-header">New Incident</div>
            <div className="incident-detail-section-body">
              <div className="incident-detail-create-form">
                <div className="incident-detail-form-group">
                  <label className="incident-detail-form-label">Title *</label>
                  <input
                    className="incident-detail-input"
                    value={createTitle}
                    onChange={(e) => setCreateTitle(e.target.value)}
                    placeholder="Incident title..."
                    autoFocus
                  />
                </div>
                <div className="incident-detail-form-group">
                  <label className="incident-detail-form-label">Description</label>
                  <AITabInput
                    as="textarea"
                    className="incident-detail-textarea"
                    value={createDescription}
                    onChange={(e) => setCreateDescription(e.target.value)}
                    placeholder="Optional description..."
                    aiField="incident_description"
                    aiPlaceholder="Incident description"
                    aiContext={{ title: createTitle, severity: createSeverity }}
                    onAIValue={(v) => setCreateDescription(v)}
                  />
                </div>
                <div className="incident-detail-form-group">
                  <label className="incident-detail-form-label">Severity</label>
                  <select
                    className="incident-detail-select"
                    value={createSeverity}
                    onChange={(e) => setCreateSeverity(e.target.value as IncidentSeverity)}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                {createError && (
                  <div className="incident-detail-form-error">{createError}</div>
                )}
                <div className="incident-detail-form-actions">
                  <button
                    className="incident-detail-btn primary"
                    onClick={handleCreate}
                    disabled={creating || !createTitle.trim()}
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                  <button
                    className="incident-detail-btn"
                    onClick={onClose}
                    disabled={creating}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // -- VIEW/EDIT MODE --

  // Loading
  if (loading && !incident) {
    return (
      <div className="incident-detail-container">
        <div className="incident-detail-loading">
          <div className="incident-detail-spinner" />
          <span>Loading incident...</span>
        </div>
      </div>
    )
  }

  // Error
  if (error && !incident) {
    return (
      <div className="incident-detail-container">
        <div className="incident-detail-error">
          <span>Failed to load incident. {error}</span>
          <button className="incident-detail-btn" onClick={fetchData}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Not found
  if (!incident) {
    return (
      <div className="incident-detail-container">
        <div className="incident-detail-not-found">
          Incident not found
        </div>
      </div>
    )
  }

  // -- Handlers --
  const handleUpdateState = async () => {
    setUpdatingState(true)
    try {
      const updated = await updateIncident(incident.id, { state: newState })
      setIncident(updated)
      setShowUpdateState(false)
    } catch (err) {
      console.error('Failed to update incident state:', err)
    } finally {
      setUpdatingState(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteIncident(incident.id)
      onClose()
    } catch (err) {
      console.error('Failed to delete incident:', err)
    } finally {
      setDeleting(false)
    }
  }

  const handleLinkAlert = async () => {
    if (!linkAlertId.trim()) return
    setLinking(true)
    try {
      await linkAlert(incident.id, linkAlertId.trim())
      setLinkAlertId('')
      const updated = await getIncident(incident.id)
      setIncident(updated)
    } catch (err) {
      console.error('Failed to link alert:', err)
    } finally {
      setLinking(false)
    }
  }

  const handleUnlinkAlert = async (alertId: string) => {
    setUnlinking(alertId)
    try {
      await unlinkAlert(incident.id, alertId)
      const updated = await getIncident(incident.id)
      setIncident(updated)
    } catch (err) {
      console.error('Failed to unlink alert:', err)
    } finally {
      setUnlinking(null)
    }
  }

  const handleAddComment = async () => {
    if (!commentText.trim()) return
    setPosting(true)
    try {
      const comment = await addComment(incident.id, commentText.trim(), user?.id)
      setComments((prev) => [...prev, comment])
      setCommentText('')
    } catch (err) {
      console.error('Failed to add comment:', err)
    } finally {
      setPosting(false)
    }
  }

  const handleSaveField = async (field: 'title' | 'description' | 'severity', value: string) => {
    setSaving(true)
    try {
      const updated = await updateIncident(incident.id, { [field]: value })
      setIncident(updated)
      if (field === 'title') onTitleChange(updated.title)
    } catch (err) {
      console.error(`Failed to update ${field}:`, err)
    } finally {
      setSaving(false)
      setEditingTitle(false)
      setEditingDescription(false)
      setEditingSeverity(false)
    }
  }

  return (
    <div className="incident-detail-container">
      {/* Header Bar */}
      <div className="incident-detail-header">
        <div className="incident-detail-header-info">
          {editingTitle ? (
            <input
              className="incident-detail-title-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => {
                if (editTitle.trim() && editTitle !== incident.title) {
                  handleSaveField('title', editTitle.trim())
                } else {
                  setEditingTitle(false)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editTitle.trim()) handleSaveField('title', editTitle.trim())
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              autoFocus
              disabled={saving}
            />
          ) : (
            <h2
              className="incident-detail-title"
              onClick={() => { setEditTitle(incident.title); setEditingTitle(true) }}
              title="Click to edit title"
              style={{ cursor: 'pointer' }}
            >
              {incident.title}
            </h2>
          )}
          {editingSeverity ? (
            <select
              className="incident-detail-severity-select"
              value={incident.severity}
              onChange={(e) => handleSaveField('severity', e.target.value)}
              onBlur={() => setEditingSeverity(false)}
              autoFocus
              disabled={saving}
            >
              {(['critical', 'high', 'medium', 'low'] as IncidentSeverity[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          ) : (
            <span
              className={severityBadgeClass(incident.severity)}
              onClick={() => setEditingSeverity(true)}
              title="Click to change severity"
              style={{ cursor: 'pointer' }}
            >
              {incident.severity}
            </span>
          )}
          <span className={stateBadgeClass(incident.state)}>
            {incident.state.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="incident-detail-header-actions">
          <button
            className="incident-detail-btn primary"
            onClick={() => {
              setNewState(incident.state)
              setShowUpdateState(true)
              setShowDelete(false)
            }}
          >
            Update State
          </button>
          <button
            className="incident-detail-btn danger"
            onClick={() => {
              setShowDelete(true)
              setShowUpdateState(false)
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Metadata Row */}
      <div className="incident-detail-meta-row">
        <div className="incident-detail-meta-field">
          <span className="incident-detail-meta-label">Created</span>
          <span className="incident-detail-meta-value">{formatDate(incident.created_at)}</span>
        </div>
        <div className="incident-detail-meta-field">
          <span className="incident-detail-meta-label">Updated</span>
          <span className="incident-detail-meta-value">{formatDate(incident.updated_at)}</span>
        </div>
        {incident.created_by && (
          <div className="incident-detail-meta-field">
            <span className="incident-detail-meta-label">Created By</span>
            <span className="incident-detail-meta-value">{incident.created_by}</span>
          </div>
        )}
        {incident.created_from && (
          <div className="incident-detail-meta-field">
            <span className="incident-detail-meta-label">Source</span>
            <span className="incident-detail-meta-value">{formatCreatedFrom(incident.created_from)}</span>
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className="incident-detail-content">
        {/* Update State inline panel */}
        {showUpdateState && (
          <div className="incident-detail-inline-panel">
            <div className="incident-detail-inline-panel-header">Update Incident State</div>
            <div className="incident-detail-inline-panel-body">
              <p className="incident-detail-inline-panel-desc">
                Change the state of this incident.
              </p>
              <div className="incident-detail-form-group">
                <label className="incident-detail-form-label">New State</label>
                <select
                  className="incident-detail-select"
                  value={newState}
                  onChange={(e) => setNewState(e.target.value as IncidentState)}
                >
                  {ALL_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="incident-detail-inline-panel-actions">
                <button
                  className="incident-detail-btn"
                  onClick={() => setShowUpdateState(false)}
                >
                  Cancel
                </button>
                <button
                  className="incident-detail-btn primary"
                  onClick={handleUpdateState}
                  disabled={updatingState}
                >
                  {updatingState ? 'Updating...' : 'Update State'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete confirmation inline panel */}
        {showDelete && (
          <div className="incident-detail-inline-panel">
            <div className="incident-detail-inline-panel-header">Delete Incident</div>
            <div className="incident-detail-inline-panel-body">
              <p className="incident-detail-inline-panel-desc">
                Are you sure you want to delete this incident? This action cannot be undone.
              </p>
              <div className="incident-detail-warning-box">
                <div className="incident-detail-warning-title">{incident.title}</div>
                <div className="incident-detail-warning-meta">
                  Severity: {incident.severity} | State: {incident.state}
                </div>
              </div>
              <div className="incident-detail-inline-panel-actions">
                <button
                  className="incident-detail-btn"
                  onClick={() => setShowDelete(false)}
                >
                  Cancel
                </button>
                <button
                  className="incident-detail-btn danger"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Description */}
        <div className="incident-detail-section">
          <div className="incident-detail-section-header">Description</div>
          <div className="incident-detail-section-body">
            {editingDescription ? (
              <AITabInput
                as="textarea"
                className="incident-detail-description-input"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                onBlur={() => {
                  if (editDescription !== (incident.description ?? '')) {
                    handleSaveField('description', editDescription)
                  } else {
                    setEditingDescription(false)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingDescription(false)
                }}
                autoFocus
                disabled={saving}
                rows={4}
                aiField="description"
                aiPlaceholder="Updated incident description"
                aiContext={{ title: incident.title, severity: incident.severity }}
                onAIValue={(v) => setEditDescription(v)}
              />
            ) : (
              <p
                className="incident-detail-description"
                onClick={() => { setEditDescription(incident.description ?? ''); setEditingDescription(true) }}
                title="Click to edit description"
                style={{ cursor: 'pointer', minHeight: 40 }}
              >
                {incident.description && incident.description !== 'None' ? incident.description : <span style={{ color: 'var(--text-muted, #5a5a5a)', fontStyle: 'italic' }}>Click to add description...</span>}
              </p>
            )}
          </div>
        </div>

        {/* Details — only show if there's ITSM or resolution info */}
        {(incident.itsm_provider || incident.itsm_ref || incident.resolved_at || incident.resolved_by) && (
          <div className="incident-detail-section">
            <div className="incident-detail-section-header">Details</div>
            <div className="incident-detail-grid">
              {incident.itsm_provider && (
                <div className="incident-detail-field">
                  <span className="incident-detail-field-label">ITSM Provider</span>
                  <span className="incident-detail-field-value">{incident.itsm_provider}</span>
                </div>
              )}
              {incident.itsm_ref && (
                <div className="incident-detail-field">
                  <span className="incident-detail-field-label">External ID</span>
                  <span className="incident-detail-field-value incident-detail-field-value-mono">
                    {incident.itsm_ref}
                  </span>
                </div>
              )}
              {incident.resolved_at && (
                <div className="incident-detail-field">
                  <span className="incident-detail-field-label">Resolved At</span>
                  <span className="incident-detail-field-value">{formatDate(incident.resolved_at)}</span>
                </div>
              )}
              {incident.resolved_by && (
                <div className="incident-detail-field">
                  <span className="incident-detail-field-label">Resolved By</span>
                  <span className="incident-detail-field-value">{incident.resolved_by}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Linked Alerts */}
        <div className="incident-detail-section">
          <div className="incident-detail-section-header">
            Linked Alerts ({incident.alerts?.length || 0})
          </div>

          {/* Link alert form */}
          <div className="incident-detail-link-form">
            <input
              className="incident-detail-input"
              value={linkAlertId}
              onChange={(e) => setLinkAlertId(e.target.value)}
              placeholder="Alert ID (UUID)..."
            />
            <button
              className="incident-detail-btn primary"
              onClick={handleLinkAlert}
              disabled={linking || !linkAlertId.trim()}
            >
              {linking ? 'Linking...' : 'Link Alert'}
            </button>
          </div>

          {incident.alerts && incident.alerts.length > 0 ? (
            <div className="incident-detail-table-wrap">
              <table className="incident-detail-table">
                <thead>
                  <tr>
                    <th>Alert</th>
                    <th>Severity</th>
                    <th>State</th>
                    <th>Linked At</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {incident.alerts.map((alert) => (
                    <tr
                      key={alert.alert_id}
                      className="incident-detail-table-row-clickable"
                      onClick={() => onOpenAlertTab(alert.alert_id)}
                    >
                      <td>
                        <div className="incident-detail-alert-title">
                          {alert.alert_title || alert.alert_id}
                        </div>
                        {alert.alert_title && (
                          <div className="incident-detail-alert-id">{alert.alert_id}</div>
                        )}
                      </td>
                      <td>
                        <span className={severityBadgeClass(alert.alert_severity)}>
                          {alert.alert_severity}
                        </span>
                      </td>
                      <td>
                        <span className={stateBadgeClass(alert.alert_state)}>
                          {alert.alert_state}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                        {formatDate(alert.linked_at)}
                      </td>
                      <td>
                        <button
                          className="incident-detail-btn-icon"
                          title="Unlink alert"
                          disabled={unlinking === alert.alert_id}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleUnlinkAlert(alert.alert_id)
                          }}
                        >
                          &#x2715;
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="incident-detail-empty-text">
              No alerts linked to this incident.
            </div>
          )}
        </div>

        {/* Comments */}
        <div className="incident-detail-section">
          <div className="incident-detail-section-header">Comments</div>

          {/* Add comment form */}
          <div className="incident-detail-comment-form">
            <AITabInput
              as="textarea"
              className="incident-detail-textarea"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment..."
              aiField="comment"
              aiPlaceholder="Comment on this incident"
              aiContext={{ title: incident.title, state: incident.state }}
              onAIValue={(v) => setCommentText(v)}
            />
            <button
              className="incident-detail-btn primary"
              onClick={handleAddComment}
              disabled={posting || !commentText.trim()}
            >
              {posting ? 'Posting...' : 'Post'}
            </button>
          </div>

          {comments.length > 0 ? (
            <div className="incident-detail-comments-list">
              {comments.map((comment) => (
                <div key={comment.id} className="incident-detail-comment">
                  <div className="incident-detail-comment-meta">
                    <span>{comment.user_id}</span>
                    <span>{formatDate(comment.created_at)}</span>
                  </div>
                  <div className="incident-detail-comment-body">{comment.body}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="incident-detail-empty-text">No comments yet.</div>
          )}
        </div>
      </div>
    </div>
  )
}
