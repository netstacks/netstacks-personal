import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listApiResources,
  deleteApiResource,
  listQuickActions,
  type QuickAction,
} from '../api/quickActions'
import { listNetBoxSources } from '../api/netboxSources'
import AskAiHelp from './AskAiHelp'
import { listLibreNmsSources } from '../api/librenms'
import { listNetStacksCrawlerSources } from '../api/netstacksCrawler'
import type {
  ApiResource,
} from '../types/quickAction'
import './ApiResourcesTab.css'
import ApiResourceDialog, { AUTH_TYPE_LABELS } from './ApiResourceDialog'
import QuickActionDialog from './QuickActionDialog'

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
}

// === Main Tab Component ===

export default function ApiResourcesTab() {
  const [resources, setResources] = useState<ApiResource[]>([])
  const [quickActions, setQuickActions] = useState<QuickAction[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Resource dialog
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false)
  const [editingResource, setEditingResource] = useState<ApiResource | null>(null)
  const [deleteResourceConfirm, setDeleteResourceConfirm] = useState<ApiResource | null>(null)

  // Quick Action dialog
  const [qaDialogOpen, setQaDialogOpen] = useState(false)
  const [editingQa, setEditingQa] = useState<QuickAction | null>(null)
  const [prefilledResourceId, setPrefilledResourceId] = useState<string | null>(null)

  const [deleting, setDeleting] = useState(false)

  const qaByResource = useMemo(() => {
    const map: Record<string, QuickAction[]> = {}
    for (const qa of quickActions) {
      if (!map[qa.api_resource_id]) {
        map[qa.api_resource_id] = []
      }
      map[qa.api_resource_id].push(qa)
    }
    return map
  }, [quickActions])

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const resourceData = await listApiResources()
      setResources(resourceData)
      setError(null)
    } catch (err) {
      setError('Failed to load data')
      console.error('Failed to fetch API resources:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void listQuickActions().then(setQuickActions)
  }, [])

  useEffect(() => {
    void Promise.all([
      listNetBoxSources(),
      listLibreNmsSources(),
      listNetStacksCrawlerSources(),
    ]).then(([nb, lnms, nd]) => {
      const u: Record<string, number> = {}
      const bump = (id: string) => {
        u[id] = (u[id] ?? 0) + 1
      }
      nb.forEach((s) => bump(s.api_resource_id))
      lnms.forEach((s) => bump(s.api_resource_id))
      nd.forEach((s) => bump(s.api_resource_id))
      setUsage(u)
    })
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleDeleteResource = async () => {
    if (!deleteResourceConfirm) return
    setDeleting(true)
    try {
      await deleteApiResource(deleteResourceConfirm.id)
      setDeleteResourceConfirm(null)
      fetchData()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete'))
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return <div className="api-resources-tab"><div className="api-resources-loading">Loading...</div></div>
  }

  return (
    <div className="api-resources-tab">
      {error && <div className="api-resources-error">{error}</div>}

      {/* API Resources section */}
      <div className="api-resources-section">
        <div className="section-header">
          <h3>API Resources</h3>
          <AskAiHelp prompt="What is an API Resource in NetStacks, how does it differ from an Integration, and how do I add one for an external system (URL, auth type, testing)? Walk me through it." />
          <button className="btn-small" onClick={() => { setEditingResource(null); setResourceDialogOpen(true) }}>
            {Icons.plus} Add Resource
          </button>
        </div>
        <p className="section-description">
          External API endpoints with authentication. Quick Calls are managed from the sidebar panel.
        </p>

        {resources.length === 0 ? (
          <div className="empty-state">
            <p>No API resources configured.</p>
            <p>Add one to start creating quick actions.</p>
          </div>
        ) : (
          <div className="items-list">
            {resources.map((resource) => {
              const resourceQas = qaByResource[resource.id] || []
              const isExpanded = expanded[resource.id] ?? false
              return (
                <div key={resource.id} className="resource-item-wrapper">
                  <div className="item-row">
                    <button
                      className="expand-chevron"
                      onClick={() => setExpanded({ ...expanded, [resource.id]: !isExpanded })}
                      title={isExpanded ? 'Collapse' : 'Expand'}
                    >
                      {isExpanded ? Icons.chevronDown : Icons.chevronRight}
                    </button>
                    <div className="item-info">
                      <span className="item-name">{resource.name}</span>
                      <span className="item-detail">{resource.base_url}</span>
                      <span className="item-badge">{AUTH_TYPE_LABELS[resource.auth_type]}</span>
                      <span className="usage-badge">
                        {usage[resource.id] ?? 0} sources · {resourceQas.length} Quick Calls
                      </span>
                    </div>
                    <div className="item-actions">
                      <button className="btn-icon" title="Edit" onClick={() => { setEditingResource(resource); setResourceDialogOpen(true) }}>
                        {Icons.edit}
                      </button>
                      <button className="btn-icon danger" title="Delete" onClick={() => setDeleteResourceConfirm(resource)}>
                        {Icons.trash}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="nested-quick-actions">
                      <div className="nested-qa-header">
                        <span>Quick Calls</span>
                        <button
                          className="btn-small"
                          onClick={() => {
                            setEditingQa(null)
                            setPrefilledResourceId(resource.id)
                            setQaDialogOpen(true)
                          }}
                        >
                          {Icons.plus} Quick Call
                        </button>
                      </div>
                      {resourceQas.length === 0 ? (
                        <div className="nested-qa-empty">No Quick Calls for this resource.</div>
                      ) : (
                        <div className="nested-qa-list">
                          {resourceQas.map((qa) => (
                            <div key={qa.id} className="nested-qa-row">
                              <div className="nested-qa-info">
                                <span className="nested-qa-name">{qa.name}</span>
                                <span className="nested-qa-detail">
                                  {qa.method} {qa.path}
                                </span>
                              </div>
                              <button
                                className="btn-icon-small"
                                title="Edit Quick Call"
                                onClick={() => {
                                  setEditingQa(qa)
                                  setPrefilledResourceId(null)
                                  setQaDialogOpen(true)
                                }}
                              >
                                {Icons.edit}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {resourceDialogOpen && (
        <ApiResourceDialog
          resource={editingResource}
          onClose={() => { setResourceDialogOpen(false); setEditingResource(null) }}
          onSave={() => { setResourceDialogOpen(false); setEditingResource(null); fetchData() }}
        />
      )}

      {qaDialogOpen && (
        <QuickActionDialog
          action={editingQa}
          resources={resources}
          prefilledResourceId={prefilledResourceId}
          onClose={() => {
            setQaDialogOpen(false)
            setEditingQa(null)
            setPrefilledResourceId(null)
          }}
          onSave={() => {
            setQaDialogOpen(false)
            setEditingQa(null)
            setPrefilledResourceId(null)
            void listQuickActions().then(setQuickActions)
          }}
        />
      )}

      {/* Delete confirmation */}
      {deleteResourceConfirm && (
        <div className="dialog-overlay">
          <div className="dialog-content dialog-small" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>Delete API Resource</h3>
            </div>
            <div className="dialog-body">
              <p>Delete "{deleteResourceConfirm.name}"? This will also delete all associated quick actions.</p>
            </div>
            <div className="dialog-footer">
              <button className="btn-secondary" onClick={() => setDeleteResourceConfirm(null)}>Cancel</button>
              <button className="btn-danger" onClick={handleDeleteResource} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
