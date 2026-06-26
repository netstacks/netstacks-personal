import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import './QuickActionsPanel.css'
import {
  listQuickActions,
  executeQuickAction,
  listApiResources,
  deleteQuickAction,
} from '../api/quickActions'
import type { QuickAction, QuickActionResult, ApiResource } from '../types/quickAction'
import {
  extractActionVariables,
  getRememberedValues,
  rememberValues,
} from '../lib/quickActionVariables'
import QuickActionDialog from './QuickActionDialog'
import ContextMenu from './ContextMenu'
import type { MenuItem } from './ContextMenu'

// Icons
import { getErrorMessage } from '../api/errors'
const Icons = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  zap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
}

interface QuickActionsPanelProps {
  onOpenResultTab?: (title: string, result: QuickActionResult) => void
}

function QuickActionsPanel({ onOpenResultTab }: QuickActionsPanelProps) {
  const [actions, setActions] = useState<QuickAction[]>([])
  const [resources, setResources] = useState<ApiResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [executingId, setExecutingId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, QuickActionResult>>({})
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const firstInputRef = useRef<HTMLInputElement>(null)

  // CRUD state
  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAction, setEditingAction] = useState<QuickAction | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<QuickAction | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [contextMenuAction, setContextMenuAction] = useState<QuickAction | null>(null)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  const fetchActions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // allSettled: an API-resources fetch failure shouldn't blank the
      // actions list. Actions is the primary content; resources are used
      // for enrichment (name lookups) and can be empty.
      const [actionsRes, resourcesRes] = await Promise.allSettled([
        listQuickActions(),
        listApiResources(),
      ])
      if (actionsRes.status === 'fulfilled') {
        setActions(actionsRes.value)
      } else {
        throw actionsRes.reason
      }
      setResources(resourcesRes.status === 'fulfilled' ? resourcesRes.value : [])
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load quick actions'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchActions()
  }, [fetchActions])

  const closeContextMenu = useCallback(() => {
    setContextMenuPos(null)
    setContextMenuAction(null)
  }, [])

  // Compute variables per action
  const actionVarsMap = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const action of actions) {
      const resource = resources.find((r) => r.id === action.api_resource_id)
      const storeAsNames = resource?.auth_flow?.map((s) => s.store_as) ?? []
      map[action.id] = extractActionVariables(
        action.path,
        action.headers,
        action.body,
        storeAsNames,
      )
    }
    return map
  }, [actions, resources])

  // Filter actions by search
  const filteredActions = useMemo(() => {
    if (!searchQuery.trim()) return actions
    const q = searchQuery.toLowerCase()
    return actions.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        a.path.toLowerCase().includes(q),
    )
  }, [actions, searchQuery])

  // Group filtered actions by category
  const grouped = useMemo(() => {
    const map: Record<string, QuickAction[]> = {}
    for (const action of filteredActions) {
      const cat = action.category || 'Uncategorized'
      if (!map[cat]) map[cat] = []
      map[cat].push(action)
    }
    return map
  }, [filteredActions])

  const categories = Object.keys(grouped).sort()

  const handleExecute = async (action: QuickAction, vars?: Record<string, string>) => {
    setExecutingId(action.id)
    setExpandedActionId(null)
    try {
      if (vars && Object.keys(vars).length > 0) {
        rememberValues(action.id, vars)
      }
      const result = await executeQuickAction(action.id, vars)
      setResults((prev) => ({ ...prev, [action.id]: result }))
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [action.id]: {
          success: false,
          status_code: 0,
          duration_ms: 0,
          error: getErrorMessage(err, 'Execution failed'),
        },
      }))
    } finally {
      setExecutingId(null)
    }
  }

  const handleActionClick = (action: QuickAction) => {
    const vars = actionVarsMap[action.id] ?? []
    if (vars.length === 0) {
      handleExecute(action)
      return
    }
    if (expandedActionId === action.id) {
      setExpandedActionId(null)
      return
    }
    const remembered = getRememberedValues(action.id)
    const initial: Record<string, string> = {}
    for (const v of vars) initial[v] = remembered[v] ?? ''
    setVariableValues(initial)
    setExpandedActionId(action.id)
    requestAnimationFrame(() => firstInputRef.current?.focus())
  }

  const handleVarSubmit = (action: QuickAction) => {
    handleExecute(action, variableValues)
  }

  const handleCopy = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    navigator.clipboard.writeText(text)
  }

  const dismissResult = (actionId: string) => {
    setResults((prev) => {
      const next = { ...prev }
      delete next[actionId]
      return next
    })
  }

  const handleContextMenu = (e: React.MouseEvent, action: QuickAction) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setContextMenuAction(action)
  }

  const handleDeleteAction = async () => {
    if (!deleteConfirm) return
    setDeleting(true)
    try {
      await deleteQuickAction(deleteConfirm.id)
      setDeleteConfirm(null)
      fetchActions()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete'))
    } finally {
      setDeleting(false)
    }
  }

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const renderVarForm = (action: QuickAction) => {
    const vars = actionVarsMap[action.id] ?? []
    if (expandedActionId !== action.id || vars.length === 0) return null

    const isExecuting = executingId === action.id
    const isInline = vars.length <= 2

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleVarSubmit(action)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setExpandedActionId(null)
      }
    }

    if (isInline) {
      return (
        <div className="qa-vars-inline" onKeyDown={handleKeyDown}>
          {vars.map((v, i) => (
            <div key={v} className="qa-var-field">
              <label className="qa-var-label">{v}</label>
              <input
                ref={i === 0 ? firstInputRef : undefined}
                className="qa-var-input"
                value={variableValues[v] ?? ''}
                onChange={(e) => setVariableValues((prev) => ({ ...prev, [v]: e.target.value }))}
                placeholder={v}
                autoFocus={i === 0}
              />
            </div>
          ))}
          <button
            className="qa-vars-run-btn"
            onClick={() => handleVarSubmit(action)}
            disabled={isExecuting}
          >
            {isExecuting ? <span className="quick-action-spinner" /> : 'Run'}
          </button>
        </div>
      )
    }

    return (
      <div className="qa-vars-popover" onKeyDown={handleKeyDown}>
        <div className="qa-vars-popover-header">Variables</div>
        <div className="qa-vars-popover-body">
          {vars.map((v, i) => (
            <div key={v} className="qa-var-field qa-var-field-stacked">
              <label className="qa-var-label">{v}</label>
              <input
                ref={i === 0 ? firstInputRef : undefined}
                className="qa-var-input"
                value={variableValues[v] ?? ''}
                onChange={(e) => setVariableValues((prev) => ({ ...prev, [v]: e.target.value }))}
                placeholder={v}
                autoFocus={i === 0}
              />
            </div>
          ))}
        </div>
        <div className="qa-vars-popover-footer">
          <button
            className="qa-vars-run-btn"
            onClick={() => handleVarSubmit(action)}
            disabled={isExecuting}
          >
            {isExecuting ? <span className="quick-action-spinner" /> : 'Run'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="quick-actions-panel" data-testid="quick-actions-panel">
      <div className="quick-actions-toolbar">
        <button className="quick-actions-btn" onClick={() => { setEditingAction(null); setDialogOpen(true) }} title="New Quick Action">
          {Icons.plus}
        </button>
        <button className="quick-actions-btn" onClick={fetchActions} title="Refresh">
          {Icons.refresh}
        </button>
      </div>

      {/* Search bar */}
      <div className="qa-search">
        <span className="qa-search-icon">{Icons.search}</span>
        <input
          className="qa-search-input"
          type="text"
          placeholder="Search actions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="qa-search-clear" onClick={() => setSearchQuery('')}>&times;</button>
        )}
      </div>

      <div className="quick-actions-list">
        {loading && <div className="quick-actions-empty">Loading...</div>}

        {error && <div className="quick-actions-error">{error}</div>}

        {!loading && !error && actions.length === 0 && (
          <div className="quick-actions-empty">
            <span className="quick-actions-empty-icon">{Icons.zap}</span>
            <p>No quick actions yet</p>
            <p className="quick-actions-empty-hint">
              Add an API resource in Settings, then create quick actions here.
            </p>
            <button
              className="quick-actions-btn primary"
              onClick={() => { setEditingAction(null); setDialogOpen(true) }}
            >
              New Action
            </button>
          </div>
        )}

        {!loading && actions.length > 0 && filteredActions.length === 0 && (
          <div className="quick-actions-empty">
            <p>No actions match "{searchQuery}"</p>
          </div>
        )}

        {!loading && categories.map((category) => {
          const isCollapsed = !searchQuery && collapsedCategories.has(category)
          const showHeader = categories.length > 1

          return (
            <div key={category} className="qa-group">
              {showHeader && (
                <div className="qa-group-header" onClick={() => toggleCategory(category)}>
                  <span className={`qa-group-chevron ${isCollapsed ? 'collapsed' : ''}`}>{Icons.chevron}</span>
                  <span className="qa-group-name">{category}</span>
                  <span className="qa-group-count">{grouped[category].length}</span>
                </div>
              )}
              {!isCollapsed && grouped[category].map((action) => {
                const isExecuting = executingId === action.id
                const result = results[action.id]
                const vars = actionVarsMap[action.id] ?? []
                const varCount = vars.length

                return (
                  <div key={action.id} className="qa-item-wrapper">
                    <div
                      className={`qa-item ${isExecuting ? 'executing' : ''}`}
                      onClick={() => !isExecuting && handleActionClick(action)}
                      onContextMenu={(e) => handleContextMenu(e, action)}
                    >
                      <span className="qa-item-method" data-method={action.method}>{action.method}</span>
                      <span className="qa-item-name">{action.name}</span>
                      {varCount > 0 && (
                        <span className="qa-var-badge">{varCount} var{varCount !== 1 ? 's' : ''}</span>
                      )}
                      <div className="qa-item-actions">
                        {isExecuting ? (
                          <span className="quick-action-spinner" />
                        ) : (
                          <button
                            className="qa-run-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleActionClick(action)
                            }}
                            title="Run"
                          >
                            {Icons.play}
                          </button>
                        )}
                      </div>
                    </div>

                    {renderVarForm(action)}

                    {result && (
                      <div className={`quick-action-result ${result.success ? 'success' : 'failure'}`}>
                        <div className="quick-action-result-header">
                          <span className="quick-action-result-status">
                            HTTP {result.status_code} ({result.duration_ms}ms)
                          </span>
                          <div className="quick-action-result-actions">
                            {result.raw_body != null && onOpenResultTab && (
                              <button
                                className="quick-action-result-btn"
                                onClick={() => onOpenResultTab(action.name, result)}
                                title="Open in tab"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                  <polyline points="15 3 21 3 21 9" />
                                  <line x1="10" y1="14" x2="21" y2="3" />
                                </svg>
                              </button>
                            )}
                            {result.extracted_value !== undefined && result.extracted_value !== null && (
                              <button
                                className="quick-action-result-btn"
                                onClick={() => handleCopy(result.extracted_value)}
                                title="Copy value"
                              >
                                {Icons.copy}
                              </button>
                            )}
                            <button
                              className="quick-action-result-btn"
                              onClick={() => dismissResult(action.id)}
                              title="Dismiss"
                            >
                              &times;
                            </button>
                          </div>
                        </div>
                        {result.extracted_value !== undefined && result.extracted_value !== null && (
                          <div className="quick-action-result-value">
                            <code>
                              {typeof result.extracted_value === 'string'
                                ? result.extracted_value
                                : JSON.stringify(result.extracted_value, null, 2)}
                            </code>
                          </div>
                        )}
                        {result.error && !result.success && (
                          <div className="quick-action-result-error">{result.error}</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Context menu */}
      <ContextMenu
        position={contextMenuPos}
        onClose={closeContextMenu}
        items={contextMenuAction ? [
          { id: 'run', label: 'Run', action: () => { if (contextMenuAction) handleActionClick(contextMenuAction) } },
          { id: 'divider', label: '', divider: true, action: () => {} },
          { id: 'edit', label: 'Edit...', action: () => { if (contextMenuAction) { setEditingAction(contextMenuAction); setDialogOpen(true) } } },
          { id: 'delete', label: 'Delete', action: () => { if (contextMenuAction) setDeleteConfirm(contextMenuAction) } },
        ] as MenuItem[] : []}
      />

      {/* Create/Edit dialog */}
      {dialogOpen && (
        <QuickActionDialog
          action={editingAction}
          resources={resources}
          onClose={() => { setDialogOpen(false); setEditingAction(null) }}
          onSave={() => { setDialogOpen(false); setEditingAction(null); fetchActions() }}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="qa-delete-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="qa-delete-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="qa-delete-header">Delete Quick Action</div>
            <div className="qa-delete-body">
              <p>Delete "{deleteConfirm.name}"?</p>
            </div>
            <div className="qa-delete-footer">
              <button className="qa-delete-cancel" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="qa-delete-confirm" onClick={handleDeleteAction} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default QuickActionsPanel
