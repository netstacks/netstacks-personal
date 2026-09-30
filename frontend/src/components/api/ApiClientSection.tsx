import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  listApiResources,
  deleteApiResource,
  listQuickActions,
  createQuickAction,
  deleteQuickAction,
  executeQuickAction,
  testApiResource,
  createApiResource,
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
import { copyToClipboard } from '../../lib/clipboard'
import { downloadFile } from '../../lib/formatters'
import { buildShareFile, parseShareFile, planImport, serializeShareFile, shareFileName, toCreateRequest } from '../../lib/quickActionShare'
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
  | { kind: 'selection'; actions: QuickAction[] }

export default function ApiClientSection({ onOpenRequest, onRunResult, onReveal }: ApiClientSectionProps) {
  const [resources, setResources] = useState<ApiResource[]>([])
  const [actions, setActions] = useState<QuickAction[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [expanded, setExpanded] = usePersistedState<Record<string, boolean>>('apiClient.expanded', {})

  const [resourceDialog, setResourceDialog] = useState<{ resource: ApiResource | null } | null>(null)
  // Multi-select of saved requests: Cmd/Ctrl+click toggles, Shift+click
  // extends within a resource, plain click opens (unchanged). Right-click
  // on a selected row acts on the whole selection.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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

  const selectedActions = useMemo(() => actions.filter((a) => selected.has(a.id)), [actions, selected])

  const handleRowClick = (e: React.MouseEvent, action: QuickAction, list: QuickAction[]) => {
    if (e.shiftKey && lastClickedRef.current) {
      const ids = list.map((a) => a.id)
      const from = ids.indexOf(lastClickedRef.current)
      const to = ids.indexOf(action.id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        setSelected((prev) => {
          const next = new Set(prev)
          ids.slice(lo, hi + 1).forEach((id) => next.add(id))
          return next
        })
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(action.id)) next.delete(action.id)
        else next.add(action.id)
        return next
      })
      lastClickedRef.current = action.id
      return
    }
    lastClickedRef.current = action.id
    setSelected(new Set())
    onOpenRequest({ action })
  }

  const openActionMenu = (e: React.MouseEvent, action: QuickAction) => {
    if (selected.has(action.id) && selected.size > 1) {
      openMenu(e, { kind: 'selection', actions: actions.filter((a) => selected.has(a.id)) })
    } else {
      setSelected(new Set([action.id]))
      lastClickedRef.current = action.id
      openMenu(e, { kind: 'action', action })
    }
  }

  const shareActions = useCallback(async (list: QuickAction[], mode: 'file' | 'clipboard') => {
    if (list.length === 0) return
    const text = serializeShareFile(buildShareFile(list, resources))
    if (mode === 'clipboard') {
      const ok = await copyToClipboard(text)
      showToast(ok ? `Copied ${list.length} request${list.length === 1 ? '' : 's'} as JSON` : 'Copy failed', ok ? 'success' : 'error')
      return
    }
    downloadFile(text, shareFileName(list), 'application/json')
    showToast(`Exported ${list.length} request${list.length === 1 ? '' : 's'} (credentials are never included)`, 'success')
  }, [resources])

  const importFromText = useCallback(async (text: string) => {
    let file
    try {
      file = parseShareFile(text)
    } catch (e) {
      showToast(getErrorMessage(e, 'Cannot import this file'), 'error')
      return
    }
    const plan = planImport(file, resources, actions)
    const createdResources: string[] = []
    const resourceIds = new Map<string, string>()
    try {
      for (const c of plan.createResources) {
        const r = await createApiResource(c.request)
        resourceIds.set(`create:${c.key}`, r.id)
        createdResources.push(r.name)
      }
      let created = 0
      const skipped: string[] = []
      for (const item of plan.requests) {
        if (item.skipped) { skipped.push(`${item.shared.name}: ${item.skipped}`); continue }
        const rid = item.resourceRef.startsWith('create:') ? resourceIds.get(item.resourceRef) : item.resourceRef
        if (!rid) { skipped.push(`${item.shared.name}: resource not created`); continue }
        await createQuickAction(toCreateRequest(item, rid))
        created += 1
      }
      notifyApiClientChanged()
      const parts = [`Imported ${created} request${created === 1 ? '' : 's'}`]
      if (createdResources.length) parts.push(`created ${createdResources.length} resource${createdResources.length === 1 ? '' : 's'} (${createdResources.join(', ')}) — add credentials before use`)
      if (skipped.length) parts.push(`skipped ${skipped.length}`)
      showToast(parts.join('; '), skipped.length || createdResources.length ? 'warning' : 'success')
      if (skipped.length) console.warn('[ApiClientSection] import skipped:', skipped)
    } catch (e) {
      notifyApiClientChanged()
      showToast(getErrorMessage(e, 'Import failed part-way; check the list'), 'error')
    }
  }, [resources, actions])

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await importFromText(await file.text())
  }

  const removeActions = useCallback(async (list: QuickAction[]) => {
    const ok = await confirmDialog({
      title: `Delete ${list.length} saved requests?`,
      body: <>{list.map((a) => a.name).join(', ')}</>,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      for (const a of list) await deleteQuickAction(a.id)
      setSelected(new Set())
      notifyApiClientChanged()
    } catch (e) {
      showToast(getErrorMessage(e, 'Failed to delete'), 'error')
    }
  }, [])

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menuTarget) return []
    if (menuTarget.kind === 'resource') {
      const r = menuTarget.resource
      const own = actionsByResource[r.id] ?? []
      return [
        { id: 'new', label: 'New request', action: () => onOpenRequest({ resourceId: r.id }) },
        { id: 'test', label: 'Test connection', action: () => void testResource(r) },
        { id: 'd1', label: '', divider: true, action: () => {} },
        { id: 'selectall', label: `Select all requests (${own.length})`, disabled: own.length === 0, action: () => setSelected(new Set(own.map((a) => a.id))) },
        { id: 'share', label: 'Share all requests…', disabled: own.length === 0, action: () => void shareActions(own, 'file') },
        { id: 'import', label: 'Import requests…', action: () => fileInputRef.current?.click() },
        { id: 'd2', label: '', divider: true, action: () => {} },
        { id: 'edit', label: 'Edit…', action: () => setResourceDialog({ resource: r }) },
        { id: 'delete', label: 'Delete', action: () => void removeResource(r) },
      ]
    }
    if (menuTarget.kind === 'selection') {
      const list = menuTarget.actions
      const n = list.length
      return [
        { id: 'share', label: `Share ${n} selected…`, action: () => void shareActions(list, 'file') },
        { id: 'copy', label: `Copy ${n} selected as JSON`, action: () => void shareActions(list, 'clipboard') },
        { id: 'd1', label: '', divider: true, action: () => {} },
        { id: 'clear', label: 'Clear selection', action: () => setSelected(new Set()) },
        { id: 'delete', label: `Delete ${n} selected`, action: () => void removeActions(list) },
      ]
    }
    const a = menuTarget.action
    return [
      { id: 'open', label: 'Open', action: () => onOpenRequest({ action: a }) },
      { id: 'run', label: 'Run', action: () => void runAction(a) },
      { id: 'd1', label: '', divider: true, action: () => {} },
      { id: 'share', label: 'Share…', action: () => void shareActions([a], 'file') },
      { id: 'copy', label: 'Copy as JSON', action: () => void shareActions([a], 'clipboard') },
      { id: 'dup', label: 'Duplicate', action: () => void duplicateAction(a) },
      { id: 'd2', label: '', divider: true, action: () => {} },
      { id: 'delete', label: 'Delete', action: () => void removeAction(a) },
    ]
  }, [menuTarget, onOpenRequest, testResource, removeResource, runAction, duplicateAction, removeAction, actionsByResource, shareActions, removeActions])

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
                      className={`api-client-row request${selected.has(action.id) ? ' selected' : ''}`}
                      onClick={(e) => handleRowClick(e, action, list)}
                      onContextMenu={(e) => openActionMenu(e, action)}
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
                          onClick={(e) => openActionMenu(e, action)}
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
        <div className="api-client-footer">
          <button className="api-client-add-link" onClick={() => setResourceDialog({ resource: null })}>
            {Icons.plus} Add API resource
          </button>
          <button className="api-client-add-link" onClick={() => fileInputRef.current?.click()} title="Import saved requests from a NetStacks JSON file">
            Import requests…
          </button>
          {selectedActions.length > 0 && (
            <span className="api-client-selection-hint">
              {selectedActions.length} selected — right-click to share
            </span>
          )}
        </div>
      )}
      {!loading && resources.length === 0 && (
        <button className="api-client-add-link" onClick={() => fileInputRef.current?.click()}>
          Import requests…
        </button>
      )}
      <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => void handleFileImport(e)} />

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
