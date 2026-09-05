import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listApiResources,
  deleteApiResource,
  listQuickActions,
  createQuickAction,
  deleteQuickAction,
  executeQuickAction,
  testApiResource,
} from '../../api/quickActions'
import { listNetBoxSources } from '../../api/netboxSources'
import { listLibreNmsSources } from '../../api/librenms'
import { listNetStacksCrawlerSources } from '../../api/netstacksCrawler'
import type { ApiResource, QuickAction, QuickActionResult } from '../../types/quickAction'
import type { ApiRequestTabInit } from '../../types/apiRequest'
import { extractActionVariables } from '../../lib/quickActionVariables'
import { getErrorMessage } from '../../api/errors'
import { usePersistedState } from '../../hooks/usePersistedState'
import ApiResourceDialog, { AUTH_TYPE_LABELS } from '../ApiResourceDialog'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { confirmDialog } from '../ConfirmDialog'
import { showToast } from '../Toast'
import { notifyApiClientChanged, useApiClientChanged, API_CLIENT_REVEAL_EVENT } from './apiClientEvents'
import './ApiClientSection.css'

export interface ApiClientSectionProps {
  /** Open a saved request (or a blank one against a resource) as a tab. */
  onOpenRequest: (init: ApiRequestTabInit) => void
  /** A saved request with no variables was run from the tree; show the result. */
  onRunResult: (title: string, result: QuickActionResult) => void
  /** Sidebar section collapse toggle lives in WorkspacesPanel; the tree
   *  asks to be expanded when a deep link targets it. */
  onReveal?: () => void
}

const Icons = {
  play: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="13" height="13">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  ),
}

type MenuTarget =
  | { kind: 'resource'; resource: ApiResource }
  | { kind: 'action'; action: QuickAction }

export default function ApiClientSection({ onOpenRequest, onRunResult, onReveal }: ApiClientSectionProps) {
  const [resources, setResources] = useState<ApiResource[]>([])
  const [actions, setActions] = useState<QuickAction[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [expanded, setExpanded] = usePersistedState<Record<string, boolean>>('apiClient.expanded', {})

  const [resourceDialog, setResourceDialog] = useState<{ resource: ApiResource | null } | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null)

  const load = useCallback(() => {
    Promise.all([listApiResources(), listQuickActions()])
      .then(([res, acts]) => {
        setResources(res)
        setActions(acts)
        setError(null)
      })
      .catch((e) => setError(getErrorMessage(e, 'Failed to load API resources')))
      .finally(() => setLoading(false))
    // Usage counts are a delete guard + badge; a failure here must not
    // blank the tree.
    void Promise.allSettled([listNetBoxSources(), listLibreNmsSources(), listNetStacksCrawlerSources()])
      .then((results) => {
        const u: Record<string, number> = {}
        for (const r of results) {
          if (r.status !== 'fulfilled') continue
          for (const s of r.value) u[s.api_resource_id] = (u[s.api_resource_id] ?? 0) + 1
        }
        setUsage(u)
      })
  }, [])

  useEffect(() => { load() }, [load])
  useApiClientChanged(load)

  useEffect(() => {
    if (!onReveal) return
    window.addEventListener(API_CLIENT_REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(API_CLIENT_REVEAL_EVENT, onReveal)
  }, [onReveal])

  const actionsByResource = useMemo(() => {
    const map: Record<string, QuickAction[]> = {}
    for (const a of actions) {
      (map[a.api_resource_id] ??= []).push(a)
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    }
    return map
  }, [actions])

  const varCount = useCallback((action: QuickAction): number => {
    const resource = resources.find((r) => r.id === action.api_resource_id)
    const storeAs = resource?.auth_flow?.map((s) => s.store_as) ?? []
    return extractActionVariables(action.path, action.headers, action.body, storeAs).length
  }, [resources])

  const toggle = (id: string) => setExpanded({ ...expanded, [id]: !(expanded[id] ?? true) })
  const isExpanded = (id: string) => expanded[id] ?? true

  const closeMenu = useCallback(() => { setMenuPos(null); setMenuTarget(null) }, [])

  const openMenu = (e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuTarget(target)
  }

  // ▶ on a request: no variables → run and show; otherwise open the tab so
  // the user can fill them in (the tab is the variable form).
  const runAction = useCallback(async (action: QuickAction) => {
    if (varCount(action) > 0) {
      onOpenRequest({ action })
      return
    }
    setRunningId(action.id)
    try {
      const result = await executeQuickAction(action.id)
      onRunResult(action.name, result)
    } catch (e) {
      showToast(`"${action.name}" failed: ${getErrorMessage(e, 'Request failed')}`, 'error')
    } finally {
      setRunningId(null)
    }
  }, [varCount, onOpenRequest, onRunResult])

  const testResource = useCallback(async (resource: ApiResource) => {
    setRunningId(resource.id)
    try {
      const result = await testApiResource(resource.id)
      if (result.success && !result.warning) {
        showToast(`${resource.name}: HTTP ${result.status_code} in ${result.duration_ms}ms`, 'success')
      } else if (result.success) {
        showToast(`${resource.name}: ${result.warning}`, 'warning')
      } else {
        showToast(`${resource.name}: ${result.error ?? `HTTP ${result.status_code}`}`, 'error')
      }
    } catch (e) {
      showToast(`${resource.name}: ${getErrorMessage(e, 'Test failed')}`, 'error')
    } finally {
      setRunningId(null)
    }
  }, [])

  const removeResource = useCallback(async (resource: ApiResource) => {
    const sources = usage[resource.id] ?? 0
    const requests = actionsByResource[resource.id]?.length ?? 0
    const ok = await confirmDialog({
      title: 'Delete API resource?',
      body: (
        <>
          Delete <strong>{resource.name}</strong>?
          {requests > 0 && <> Its {requests} saved request{requests === 1 ? '' : 's'} will be deleted too.</>}
          {sources > 0 && (
            <>
              <br /><br />
              <em>{sources} integration source{sources === 1 ? '' : 's'} (NetBox / LibreNMS / Crawler) still reference this resource and will stop working.</em>
            </>
          )}
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteApiResource(resource.id)
      notifyApiClientChanged()
      showToast(`Deleted "${resource.name}"`, 'success')
    } catch (e) {
      showToast(getErrorMessage(e, 'Failed to delete'), 'error')
    }
  }, [usage, actionsByResource])

  const removeAction = useCallback(async (action: QuickAction) => {
    const ok = await confirmDialog({
      title: 'Delete saved request?',
      body: <>Delete <strong>{action.name}</strong>?</>,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteQuickAction(action.id)
      notifyApiClientChanged()
    } catch (e) {
      showToast(getErrorMessage(e, 'Failed to delete'), 'error')
    }
  }, [])

  const duplicateAction = useCallback(async (action: QuickAction) => {
    try {
      const copy = await createQuickAction({
        name: `${action.name} (copy)`,
        description: action.description ?? undefined,
        api_resource_id: action.api_resource_id,
        method: action.method,
        path: action.path,
        headers: action.headers,
        body: action.body ?? undefined,
        json_extract_path: action.json_extract_path ?? undefined,
        icon: action.icon ?? undefined,
        color: action.color ?? undefined,
        category: action.category ?? undefined,
      })
      notifyApiClientChanged()
      onOpenRequest({ action: copy })
    } catch (e) {
      showToast(getErrorMessage(e, 'Failed to duplicate'), 'error')
    }
  }, [onOpenRequest])

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menuTarget) return []
    if (menuTarget.kind === 'resource') {
      const r = menuTarget.resource
      return [
        { id: 'new', label: 'New request', action: () => onOpenRequest({ resourceId: r.id }) },
        { id: 'test', label: 'Test connection', action: () => void testResource(r) },
        { id: 'd1', label: '', divider: true, action: () => {} },
        { id: 'edit', label: 'Edit…', action: () => setResourceDialog({ resource: r }) },
        { id: 'delete', label: 'Delete', action: () => void removeResource(r) },
      ]
    }
    const a = menuTarget.action
    return [
      { id: 'open', label: 'Open', action: () => onOpenRequest({ action: a }) },
      { id: 'run', label: 'Run', action: () => void runAction(a) },
      { id: 'd1', label: '', divider: true, action: () => {} },
      { id: 'dup', label: 'Duplicate', action: () => void duplicateAction(a) },
      { id: 'delete', label: 'Delete', action: () => void removeAction(a) },
    ]
  }, [menuTarget, onOpenRequest, testResource, removeResource, runAction, duplicateAction, removeAction])

  return (
    <div className="api-client-section">
      {loading && <div className="api-client-status">Loading…</div>}
      {error && <div className="api-client-status error">{error}</div>}

      {!loading && !error && resources.length === 0 && (
        <div className="api-client-empty">
          <p>No API resources yet.</p>
          <p className="hint">A resource is a base URL plus auth. Saved requests, Quick Calls, integrations and the AI all send through it.</p>
          <button className="api-client-add-btn" onClick={() => setResourceDialog({ resource: null })}>
            + Add API resource
          </button>
        </div>
      )}

      {resources.map((resource) => {
        const list = actionsByResource[resource.id] ?? []
        const open = isExpanded(resource.id)
        const busy = runningId === resource.id
        return (
          <div key={resource.id} className="api-client-resource">
            <div
              className="api-client-row resource"
              onClick={() => toggle(resource.id)}
              onContextMenu={(e) => openMenu(e, { kind: 'resource', resource })}
              title={`${resource.base_url}\n${AUTH_TYPE_LABELS[resource.auth_type]}${usage[resource.id] ? `\nUsed by ${usage[resource.id]} integration source(s)` : ''}`}
            >
              <span className="api-client-chevron">{open ? '▾' : '▸'}</span>
              <span className="api-client-icon">{Icons.globe}</span>
              <span className="api-client-name">{resource.name}</span>
              {!resource.has_credentials && resource.auth_type !== 'none' && (
                <span className="api-client-dot" title="No credentials stored" />
              )}
              {busy && <span className="api-client-spinner" />}
              <span className="api-client-row-actions">
                <button
                  className="api-client-row-btn"
                  title="New request"
                  onClick={(e) => { e.stopPropagation(); onOpenRequest({ resourceId: resource.id }) }}
                >
                  {Icons.plus}
                </button>
                <button
                  className="api-client-row-btn"
                  title="More"
                  onClick={(e) => openMenu(e, { kind: 'resource', resource })}
                >
                  {Icons.more}
                </button>
              </span>
            </div>

            {open && (
              <div className="api-client-requests">
                {list.length === 0 && (
                  <div className="api-client-requests-empty">No saved requests</div>
                )}
                {list.map((action) => {
                  const vars = varCount(action)
                  const running = runningId === action.id
                  return (
                    <div
                      key={action.id}
                      className="api-client-row request"
                      onClick={() => onOpenRequest({ action })}
                      onContextMenu={(e) => openMenu(e, { kind: 'action', action })}
                      title={`${action.method} ${action.path}${action.description ? `\n${action.description}` : ''}`}
                    >
                      <span className="api-client-method" data-method={action.method}>{action.method}</span>
                      <span className="api-client-name">{action.name}</span>
                      {vars > 0 && <span className="api-client-vars">{vars} var{vars === 1 ? '' : 's'}</span>}
                      <span className="api-client-row-actions">
                        {running ? (
                          <span className="api-client-spinner" />
                        ) : (
                          <button
                            className="api-client-row-btn"
                            title={vars > 0 ? 'Open to fill in variables and run' : 'Run'}
                            onClick={(e) => { e.stopPropagation(); void runAction(action) }}
                          >
                            {Icons.play}
                          </button>
                        )}
                        <button
                          className="api-client-row-btn"
                          title="More"
                          onClick={(e) => openMenu(e, { kind: 'action', action })}
                        >
                          {Icons.more}
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {!loading && resources.length > 0 && (
        <button className="api-client-add-link" onClick={() => setResourceDialog({ resource: null })}>
          {Icons.plus} Add API resource
        </button>
      )}

      <ContextMenu position={menuPos} onClose={closeMenu} items={menuItems} />

      {resourceDialog && (
        <ApiResourceDialog
          resource={resourceDialog.resource}
          onClose={() => setResourceDialog(null)}
          onSave={() => { setResourceDialog(null); notifyApiClientChanged() }}
        />
      )}
    </div>
  )
}
