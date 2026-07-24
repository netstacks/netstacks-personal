import { useState, useEffect, useCallback } from 'react'
import AITabInput from './AITabInput'
import './AlertDetailTab.css'
import {
  getAlert,
  acknowledgeAlert,
  resolveAlert,
  suppressAlert,
  getTriageEvents,
} from '../api/alerts'
import type {
  Alert,
  TriageEvent,
  AlertSeverity,
  AlertState,
  TriageState,
} from '../types/incidents'

import { getErrorMessage } from '../api/errors'
interface AlertDetailTabProps {
  alertId: string
  onOpenIncidentTab: (id: string) => void
  onTitleChange: (title: string) => void
}

// --- Helpers ---

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

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return '—'
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) return `${diffSecs}s ago`
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return formatDate(dateStr)
}

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  critical: '\u26D4',
  high: '\u26A0',
  medium: '\u25C9',
  low: '\u2139',
  info: '\u2139',
}

const TRIAGE_STATE_LABELS: Record<TriageState, string> = {
  pending: 'Pending',
  routing: 'Routing',
  triaging: 'Triaging',
  triaged: 'Triaged',
  resolved: 'Resolved',
  escalated: 'Escalated',
  pending_mop: 'Pending MOP',
  pending_review: 'Needs Review',
  failed: 'Failed',
  skipped: 'Skipped',
}

const EVENT_TYPE_ICON: Record<string, string> = {
  ingested: '\u{1F4E5}',
  deduplicated: '\u25CB',
  routing_matched: '\u2192',
  routing_skipped: '\u23ED',
  agent_started: '\u{1F916}',
  tool_call: '\u{1F4BB}',
  tool_result: '\u{1F4BB}',
  observation: '\u{1F441}',
  knowledge_hit: '\u{1F441}',
  correlation: '\u25CB',
  action_taken: '\u2713',
  decision: '\u25CB',
  resolved: '\u2714',
  agent_completed: '\u2714',
  agent_failed: '\u2718',
  escalated: '\u26A0',
  mop_created: '\u{1F4C4}',
  incident_created: '\u26A0',
  human_review: '\u{1F464}',
  handoff: '\u{1F464}',
  ephemeral_created: '\u{1F4C4}',
}

// --- Sub-components ---

function TimelineEvent({ event }: { event: TriageEvent }) {
  const [expanded, setExpanded] = useState(false)
  const icon = EVENT_TYPE_ICON[event.event_type] || '\u25CB'
  const timeAgo = formatRelativeTime(event.created_at)
  const iconClass = `alert-detail-timeline-icon alert-detail-timeline-icon-${event.event_type}`

  return (
    <div className="alert-detail-timeline-event">
      <span className={iconClass}>{icon}</span>
      <div className="alert-detail-timeline-body">
        <div className="alert-detail-timeline-row">
          <span className="alert-detail-timeline-summary">{event.summary}</span>
          <span className="alert-detail-timeline-time">
            {timeAgo}
            {event.duration_ms != null && (
              <span className="alert-detail-timeline-duration">({event.duration_ms}ms)</span>
            )}
          </span>
        </div>
        {event.detail && (
          <button
            className="alert-detail-timeline-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        )}
        {expanded && event.detail && (
          <pre className="alert-detail-timeline-detail">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}

// --- Main Component ---

export default function AlertDetailTab({
  alertId,
  onOpenIncidentTab,
  onTitleChange,
}: AlertDetailTabProps) {
  const [alert, setAlert] = useState<Alert | null>(null)
  const [triageEvents, setTriageEvents] = useState<TriageEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Action panel state
  const [showAcknowledge, setShowAcknowledge] = useState(false)
  const [acknowledgeComment, setAcknowledgeComment] = useState('')
  const [showResolve, setShowResolve] = useState(false)
  const [resolveResolution, setResolveResolution] = useState('')
  const [showSuppress, setShowSuppress] = useState(false)
  const [suppressDuration, setSuppressDuration] = useState('60')
  const [suppressReason, setSuppressReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Payload
  const [payloadExpanded, setPayloadExpanded] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [alertData, events] = await Promise.all([
        getAlert(alertId),
        getTriageEvents(alertId),
      ])
      setAlert(alertData)
      setTriageEvents(events)
      onTitleChange(alertData.title)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load alert'))
    } finally {
      setLoading(false)
    }
  }, [alertId, onTitleChange])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // --- Action handlers ---

  const handleAcknowledge = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      const updated = await acknowledgeAlert(alertId, acknowledgeComment || undefined)
      setAlert(updated)
      setShowAcknowledge(false)
      setAcknowledgeComment('')
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to acknowledge'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleResolve = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      const updated = await resolveAlert(alertId, resolveResolution || undefined)
      setAlert(updated)
      setShowResolve(false)
      setResolveResolution('')
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to resolve'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleSuppress = async () => {
    if (!suppressReason.trim()) return
    setActionLoading(true)
    setActionError(null)
    try {
      const updated = await suppressAlert(alertId, parseInt(suppressDuration, 10), suppressReason)
      setAlert(updated)
      setShowSuppress(false)
      setSuppressDuration('60')
      setSuppressReason('')
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to suppress'))
    } finally {
      setActionLoading(false)
    }
  }

  const copyPayload = () => {
    if (alert?.raw_payload) {
      navigator.clipboard.writeText(JSON.stringify(alert.raw_payload, null, 2))
    }
  }

  // --- Render helpers ---

  const severityBadgeClass = (severity: AlertSeverity) =>
    `alert-detail-badge alert-detail-badge-${severity}`

  const stateBadgeClass = (state: AlertState) =>
    `alert-detail-badge alert-detail-badge-state-${state}`

  const triageBadgeClass = (state: TriageState) =>
    `alert-detail-badge alert-detail-badge-triage-${state}`

  // --- Loading / Error / Not Found ---

  if (loading) {
    return (
      <div className="alert-detail-container">
        <div className="alert-detail-loading">
          <div className="alert-detail-spinner" />
          Loading alert...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="alert-detail-container">
        <div className="alert-detail-error">
          <p>Failed to load alert: {error}</p>
          <button className="alert-detail-btn primary" onClick={fetchData}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!alert) {
    return (
      <div className="alert-detail-container">
        <div className="alert-detail-not-found">Alert not found</div>
      </div>
    )
  }

  return (
    <div className="alert-detail-container">
      {/* Header Bar */}
      <div className="alert-detail-header">
        <div className="alert-detail-header-info">
          <h2 className="alert-detail-title">{alert.title}</h2>
          <span className={severityBadgeClass(alert.severity)}>
            {SEVERITY_ICON[alert.severity]} {alert.severity}
          </span>
          <span className={stateBadgeClass(alert.state)}>
            {alert.state}
          </span>
          {alert.triage_state && (
            <span className={triageBadgeClass(alert.triage_state)}>
              {TRIAGE_STATE_LABELS[alert.triage_state]}
            </span>
          )}
        </div>
        <div className="alert-detail-header-actions">
          {alert.state === 'active' && (
            <button
              className="alert-detail-btn primary"
              onClick={() => { setShowAcknowledge(true); setShowResolve(false); setShowSuppress(false) }}
            >
              Acknowledge
            </button>
          )}
          {alert.state === 'acknowledged' && (
            <button
              className="alert-detail-btn primary"
              onClick={() => { setShowResolve(true); setShowAcknowledge(false); setShowSuppress(false) }}
            >
              Resolve
            </button>
          )}
          {(alert.state === 'active' || alert.state === 'acknowledged') && (
            <button
              className="alert-detail-btn secondary"
              onClick={() => { setShowSuppress(true); setShowAcknowledge(false); setShowResolve(false) }}
            >
              Suppress
            </button>
          )}
        </div>
      </div>

      {/* Metadata Row */}
      <div className="alert-detail-meta-row">
        <div className="alert-detail-meta-field">
          <span className="alert-detail-meta-label">Source</span>
          <span className="alert-detail-meta-value">{alert.source}</span>
        </div>
        <div className="alert-detail-meta-field">
          <span className="alert-detail-meta-label">First Seen</span>
          <span className="alert-detail-meta-value">{formatDate(alert.first_seen_at)}</span>
        </div>
        <div className="alert-detail-meta-field">
          <span className="alert-detail-meta-label">Last Seen</span>
          <span className="alert-detail-meta-value">{formatDate(alert.last_seen_at)}</span>
        </div>
        <div className="alert-detail-meta-field">
          <span className="alert-detail-meta-label">Occurrences</span>
          <span className="alert-detail-meta-value-large">{alert.occurrence_count}</span>
        </div>
      </div>

      {/* Content Area */}
      <div className="alert-detail-content">
        {/* Acknowledge inline panel */}
        {showAcknowledge && (
          <div className="alert-detail-inline-panel">
            <div className="alert-detail-inline-panel-header">Acknowledge Alert</div>
            <div className="alert-detail-inline-panel-body">
              <p className="alert-detail-inline-panel-desc">
                Acknowledge this alert to indicate you are working on it.
              </p>
              <div className="alert-detail-form-group">
                <label className="alert-detail-form-label">Comment (optional)</label>
                <AITabInput
                  className="alert-detail-input"
                  value={acknowledgeComment}
                  onChange={(e) => setAcknowledgeComment(e.target.value)}
                  placeholder="Add a comment..."
                  aiField="ack_comment"
                  aiPlaceholder="Acknowledgement note for this alert"
                  aiContext={{ title: alert.title, severity: alert.severity }}
                  onAIValue={(v) => setAcknowledgeComment(v)}
                />
              </div>
              {actionError && <div className="alert-detail-error-text">{actionError}</div>}
              <div className="alert-detail-inline-panel-actions">
                <button
                  className="alert-detail-btn"
                  onClick={() => { setShowAcknowledge(false); setActionError(null) }}
                  disabled={actionLoading}
                >
                  Cancel
                </button>
                <button
                  className="alert-detail-btn primary"
                  onClick={handleAcknowledge}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Acknowledging...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Resolve inline panel */}
        {showResolve && (
          <div className="alert-detail-inline-panel">
            <div className="alert-detail-inline-panel-header">Resolve Alert</div>
            <div className="alert-detail-inline-panel-body">
              <p className="alert-detail-inline-panel-desc">
                Mark this alert as resolved.
              </p>
              <div className="alert-detail-form-group">
                <label className="alert-detail-form-label">Resolution (optional)</label>
                <AITabInput
                  className="alert-detail-input"
                  value={resolveResolution}
                  onChange={(e) => setResolveResolution(e.target.value)}
                  placeholder="Describe how the issue was resolved..."
                  aiField="resolution"
                  aiPlaceholder="How this alert was resolved"
                  aiContext={{
                    title: alert.title,
                    severity: alert.severity,
                    root_cause: alert.root_cause,
                    impact: alert.impact_summary,
                  }}
                  onAIValue={(v) => setResolveResolution(v)}
                />
              </div>
              {actionError && <div className="alert-detail-error-text">{actionError}</div>}
              <div className="alert-detail-inline-panel-actions">
                <button
                  className="alert-detail-btn"
                  onClick={() => { setShowResolve(false); setActionError(null) }}
                  disabled={actionLoading}
                >
                  Cancel
                </button>
                <button
                  className="alert-detail-btn primary"
                  onClick={handleResolve}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Resolving...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Suppress inline panel */}
        {showSuppress && (
          <div className="alert-detail-inline-panel">
            <div className="alert-detail-inline-panel-header">Suppress Alert</div>
            <div className="alert-detail-inline-panel-body">
              <p className="alert-detail-inline-panel-desc">
                Suppress this alert for a specified duration.
              </p>
              <div className="alert-detail-form-group">
                <label className="alert-detail-form-label">Duration *</label>
                <select
                  className="alert-detail-select"
                  value={suppressDuration}
                  onChange={(e) => setSuppressDuration(e.target.value)}
                >
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="240">4 hours</option>
                  <option value="480">8 hours</option>
                  <option value="1440">24 hours</option>
                </select>
              </div>
              <div className="alert-detail-form-group">
                <label className="alert-detail-form-label">Reason *</label>
                <AITabInput
                  className="alert-detail-input"
                  value={suppressReason}
                  onChange={(e) => setSuppressReason(e.target.value)}
                  placeholder="Why is this alert being suppressed?"
                  aiField="suppress_reason"
                  aiPlaceholder="Reason for suppressing this alert"
                  aiContext={{ title: alert.title, severity: alert.severity }}
                  onAIValue={(v) => setSuppressReason(v)}
                />
              </div>
              {actionError && <div className="alert-detail-error-text">{actionError}</div>}
              <div className="alert-detail-inline-panel-actions">
                <button
                  className="alert-detail-btn"
                  onClick={() => { setShowSuppress(false); setActionError(null) }}
                  disabled={actionLoading}
                >
                  Cancel
                </button>
                <button
                  className="alert-detail-btn primary"
                  onClick={handleSuppress}
                  disabled={actionLoading || !suppressReason.trim()}
                >
                  {actionLoading ? 'Suppressing...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Description */}
        {alert.description && (
          <div className="alert-detail-section">
            <div className="alert-detail-section-header">Description</div>
            <div className="alert-detail-section-body" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {alert.description}
            </div>
          </div>
        )}

        {/* AI Triage Verdict */}
        {alert.triage_state && alert.triage_state !== 'pending' && (
          <div className="alert-detail-section">
            <div className="alert-detail-section-header">
              <span>AI Triage Verdict</span>
              <span className={triageBadgeClass(alert.triage_state)} style={{ marginLeft: 'auto' }}>
                {TRIAGE_STATE_LABELS[alert.triage_state]}
              </span>
            </div>

            {alert.root_cause && (
              <div className="alert-detail-verdict-field">
                <div className="alert-detail-verdict-label">Root Cause</div>
                <div className="alert-detail-verdict-value">{alert.root_cause}</div>
              </div>
            )}

            {alert.impact_summary && (
              <div className="alert-detail-verdict-field">
                <div className="alert-detail-verdict-label">Impact</div>
                <div className="alert-detail-verdict-value">{alert.impact_summary}</div>
              </div>
            )}

            {alert.resolution && (
              <div className="alert-detail-verdict-field">
                <div className="alert-detail-verdict-label">Resolution</div>
                <div className="alert-detail-verdict-value">{alert.resolution}</div>
              </div>
            )}

            {alert.mop_id && (
              <div className="alert-detail-mop-card">
                <div className="alert-detail-mop-header">
                  <span className="alert-detail-mop-label">
                    {'\u{1F4C4}'} MOP Generated
                  </span>
                </div>
                <div className="alert-detail-mop-desc">
                  A Method of Procedure was generated by the AI agent for this alert.
                </div>
              </div>
            )}

            {(alert.resolved_by_agent || alert.incident_id) && (
              <div className="alert-detail-verdict-footer">
                {alert.resolved_by_agent && (
                  <span className="alert-detail-auto-resolved">Auto-resolved by AI</span>
                )}
                {alert.incident_id && (
                  <span className="alert-detail-incident-link">Incident linked</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Investigation Timeline */}
        <div className="alert-detail-section">
          <div className="alert-detail-section-header">Investigation Timeline</div>
          {triageEvents.length > 0 ? (
            <div className="alert-detail-timeline">
              {triageEvents.map((event) => (
                <TimelineEvent key={event.id} event={event} />
              ))}
            </div>
          ) : (
            <div className="alert-detail-timeline-empty">No triage events yet</div>
          )}
        </div>

        {/* Details & Metadata */}
        <div className="alert-detail-section">
          <div className="alert-detail-section-header">Details &amp; Metadata</div>
          <div className="alert-detail-grid">
            {alert.source_ref && (
              <div className="alert-detail-field">
                <span className="alert-detail-field-label">Source Reference</span>
                <span className="alert-detail-field-value">{alert.source_ref}</span>
              </div>
            )}
            {alert.device_id && (
              <div className="alert-detail-field">
                <span className="alert-detail-field-label">Device ID</span>
                <span className="alert-detail-field-value alert-detail-field-value-mono">{alert.device_id}</span>
              </div>
            )}
            <div className="alert-detail-field">
              <span className="alert-detail-field-label">Fingerprint</span>
              <span className="alert-detail-field-value alert-detail-field-value-mono">{alert.fingerprint}</span>
            </div>
            {alert.triage_agent_id && (
              <div className="alert-detail-field">
                <span className="alert-detail-field-label">Triage Agent</span>
                <span className="alert-detail-field-value alert-detail-field-value-mono">{alert.triage_agent_id}</span>
              </div>
            )}
            {alert.correlated_with && (
              <div className="alert-detail-field">
                <span className="alert-detail-field-label">Correlated With</span>
                <span className="alert-detail-field-value alert-detail-field-value-mono">{alert.correlated_with}</span>
              </div>
            )}
            {alert.incident_id && (
              <div className="alert-detail-field">
                <span className="alert-detail-field-label">Incident</span>
                <button
                  className="alert-detail-field-link"
                  onClick={() => onOpenIncidentTab(alert.incident_id!)}
                >
                  {alert.incident_id}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Raw Payload */}
        <div className="alert-detail-payload-section">
          <button
            className="alert-detail-payload-toggle"
            onClick={() => setPayloadExpanded(!payloadExpanded)}
          >
            <span>Raw Payload</span>
            <div className="alert-detail-payload-actions">
              <button
                className="alert-detail-btn alert-detail-btn-sm"
                onClick={(e) => {
                  e.stopPropagation()
                  copyPayload()
                }}
              >
                Copy
              </button>
              <span className="alert-detail-chevron">{payloadExpanded ? '\u25B2' : '\u25BC'}</span>
            </div>
          </button>
          {payloadExpanded && (
            <pre className="alert-detail-payload-pre">
              {JSON.stringify(alert.raw_payload, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
