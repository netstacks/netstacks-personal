import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  listApiResources,
  getQuickAction,
  createQuickAction,
  updateQuickAction,
  executeInlineQuickAction,
} from '../../api/quickActions'
import type { ApiResource, QuickAction, QuickActionResult } from '../../types/quickAction'
import type { ApiRequestDraft, ApiRequestBodyMode, ApiRequestTabInit } from '../../types/apiRequest'
import { extractActionVariables, getRememberedValues, rememberValues } from '../../lib/quickActionVariables'
import { copyToClipboard } from '../../lib/clipboard'
import { getErrorMessage } from '../../api/errors'
import { setTabDirty } from '../../stores/dirtyTabsStore'
import JsonViewer from '../JsonViewer'
import { JsonEditor, PathInput } from './RequestEditors'
import { notifyApiClientChanged, useApiClientChanged } from './apiClientEvents'
import './ApiRequestTab.css'

interface ApiRequestTabProps {
  tabId: string
  init: ApiRequestTabInit
  /** Title bookkeeping lives in App; the dirty store is updated here. */
  onDirtyChange: (dirty: boolean) => void
  /** Called after Save / Save as… so the tab can adopt the saved request. */
  onSaved: (action: QuickAction) => void
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const HISTORY_LIMIT = 10

const CONTENT_TYPES: Record<ApiRequestBodyMode, string | null> = {
  json: null, // agent default
  text: 'text/plain',
  form: 'application/x-www-form-urlencoded',
}

interface HistoryEntry {
  id: number
  at: Date
  method: string
  path: string
  result: QuickActionResult
}

function draftFromAction(action: QuickAction | undefined): ApiRequestDraft {
  const headers = action?.headers ?? {}
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  const bodyMode: ApiRequestBodyMode = ct.startsWith('text/')
    ? 'text'
    : ct.startsWith('application/x-www-form-urlencoded')
      ? 'form'
      : 'json'
  return {
    method: action?.method ?? 'GET',
    path: action?.path ?? '/',
    headersJson: JSON.stringify(headers, null, 2),
    body: action?.body ?? '',
    bodyMode,
    jsonExtractPath: action?.json_extract_path ?? '',
  }
}

function parseHeaders(text: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(text || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return out
  } catch {
    return null
  }
}

/** Headers to send: the editor's map plus the body-mode Content-Type when
 *  the user hasn't set one themselves. */
function effectiveHeaders(headers: Record<string, string>, mode: ApiRequestBodyMode, hasBody: boolean): Record<string, string> {
  const ct = CONTENT_TYPES[mode]
  if (!ct || !hasBody) return headers
  if (Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) return headers
  return { ...headers, 'Content-Type': ct }
}

function statusClass(code: number): string {
  if (code === 0) return 'error'
  if (code >= 500) return 'server-error'
  if (code >= 400) return 'client-error'
  if (code >= 300) return 'redirect'
  return 'success'
}

function formatBody(result: QuickActionResult): { text: string; isJson: boolean } {
  if (result.raw_body !== undefined && result.raw_body !== null) {
    return { text: JSON.stringify(result.raw_body, null, 2), isJson: true }
  }
  if (result.raw_text) return { text: result.raw_text, isJson: false }
  return { text: '', isJson: false }
}

export default function ApiRequestTab({ tabId, init, onDirtyChange, onSaved }: ApiRequestTabProps) {
  const [resources, setResources] = useState<ApiResource[]>([])
  const [resourceId, setResourceId] = useState(init.resourceId ?? init.action?.api_resource_id ?? '')
  const [savedAction, setSavedAction] = useState<QuickAction | null>(init.action ?? null)
  const [draft, setDraft] = useState<ApiRequestDraft>(() => draftFromAction(init.action))
  const [variables, setVariables] = useState<Record<string, string>>(
    () => (init.action ? getRememberedValues(init.action.id) : {}),
  )
  const [reqTab, setReqTab] = useState<'headers' | 'body' | 'variables' | 'extract'>('headers')
  const [respTab, setRespTab] = useState<'body' | 'headers' | 'sent'>('body')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<QuickActionResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  // Save-as prompt (first save of a draft, or explicit Save as…)
  const [savePrompt, setSavePrompt] = useState<{ name: string; description: string; category: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const historySeq = useRef(0)

  const loadResources = useCallback(() => {
    listApiResources()
      .then((list) => {
        setResources(list)
        setResourceId((cur) => cur || list[0]?.id || '')
      })
      .catch((e) => setError(getErrorMessage(e, 'Failed to load API resources')))
  }, [])

  useEffect(() => { loadResources() }, [loadResources])
  useApiClientChanged(loadResources)

  const resource = useMemo(() => resources.find((r) => r.id === resourceId), [resources, resourceId])

  // Dirty = draft differs from the saved request (or, for a new draft, from
  // the blank defaults). Published to the dirty store so closeTab prompts.
  const savedDraft = useMemo(() => draftFromAction(savedAction ?? undefined), [savedAction])
  const dirty = useMemo(() => {
    const a = draft
    const b = savedDraft
    return (
      a.method !== b.method ||
      a.path !== b.path ||
      a.body !== b.body ||
      a.bodyMode !== b.bodyMode ||
      a.jsonExtractPath !== b.jsonExtractPath ||
      JSON.stringify(parseHeaders(a.headersJson)) !== JSON.stringify(parseHeaders(b.headersJson)) ||
      (savedAction !== null && savedAction.api_resource_id !== resourceId)
    )
  }, [draft, savedDraft, savedAction, resourceId])

  // App passes an inline callback; hold it in a ref so this only fires when
  // the dirty flag actually flips (an effect keyed on the callback would
  // re-run every App render and loop through setTabs).
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])
  useEffect(() => {
    setTabDirty(tabId, dirty)
    onDirtyChangeRef.current(dirty)
  }, [dirty, tabId])

  useEffect(() => () => setTabDirty(tabId, false), [tabId])

  // Template variables the user must supply (built-ins and auth-flow
  // outputs are resolved by the agent).
  const parsedHeaders = useMemo(() => parseHeaders(draft.headersJson), [draft.headersJson])
  const varNames = useMemo(() => {
    const storeAs = resource?.auth_flow?.map((s) => s.store_as) ?? []
    return extractActionVariables(draft.path, parsedHeaders ?? {}, draft.body, storeAs)
  }, [draft.path, draft.body, parsedHeaders, resource])

  const showBody = !['GET', 'HEAD', 'OPTIONS'].includes(draft.method)
  const resolvedUrl = resource
    ? `${resource.base_url.replace(/\/+$/, '')}/${draft.path.replace(/^\/+/, '')}`
    : draft.path

  const update = <K extends keyof ApiRequestDraft>(key: K, value: ApiRequestDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const handleSend = useCallback(async () => {
    if (!resourceId) {
      setError('Pick an API resource first')
      return
    }
    const headers = parseHeaders(draft.headersJson)
    if (headers === null) {
      setError('Headers must be a JSON object')
      setReqTab('headers')
      return
    }
    const missing = varNames.filter((v) => !variables[v]?.trim())
    if (missing.length > 0) {
      setError(`Fill in variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`)
      setReqTab('variables')
      return
    }
    setError(null)
    setSending(true)
    try {
      if (savedAction && varNames.length > 0) rememberValues(savedAction.id, variables)
      const hasBody = showBody && draft.body.length > 0
      const res = await executeInlineQuickAction({
        api_resource_id: resourceId,
        method: draft.method,
        path: draft.path,
        headers: effectiveHeaders(headers, draft.bodyMode, hasBody),
        body: hasBody ? draft.body : undefined,
        json_extract_path: draft.jsonExtractPath || undefined,
        variables,
      })
      setResult(res)
      setRespTab('body')
      const entry: HistoryEntry = {
        id: ++historySeq.current,
        at: new Date(),
        method: draft.method,
        path: draft.path,
        result: res,
      }
      setHistory((h) => [entry, ...h].slice(0, HISTORY_LIMIT))
      setActiveHistoryId(entry.id)
    } catch (e) {
      const failed: QuickActionResult = {
        success: false,
        status_code: 0,
        duration_ms: 0,
        error: getErrorMessage(e, 'Request failed'),
      }
      setResult(failed)
    } finally {
      setSending(false)
    }
  }, [resourceId, draft, varNames, variables, savedAction, showBody])

  const persist = useCallback(async (meta: { name: string; description: string; category: string } | null) => {
    const headers = parseHeaders(draft.headersJson)
    if (headers === null) {
      setError('Headers must be a JSON object')
      setReqTab('headers')
      return
    }
    if (!resourceId) {
      setError('Pick an API resource first')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const hasBody = showBody && draft.body.length > 0
      const sendHeaders = effectiveHeaders(headers, draft.bodyMode, hasBody)
      let action: QuickAction
      if (meta === null && savedAction) {
        // `null` (not `undefined`) so a cleared field actually clears the
        // column — `undefined` is dropped from JSON (NS-API-11).
        await updateQuickAction(savedAction.id, {
          api_resource_id: resourceId,
          method: draft.method,
          path: draft.path,
          headers: sendHeaders,
          body: hasBody ? draft.body : null,
          json_extract_path: draft.jsonExtractPath || null,
        })
        action = await getQuickAction(savedAction.id)
      } else {
        const name = meta?.name.trim() ?? ''
        if (!name) {
          setError('Name is required')
          return
        }
        action = await createQuickAction({
          name,
          description: meta?.description.trim() || undefined,
          category: meta?.category.trim() || undefined,
          api_resource_id: resourceId,
          method: draft.method,
          path: draft.path,
          headers: sendHeaders,
          body: hasBody ? draft.body : undefined,
          json_extract_path: draft.jsonExtractPath || undefined,
        })
      }
      setSavedAction(action)
      setDraft(draftFromAction(action))
      setSavePrompt(null)
      notifyApiClientChanged()
      onSaved(action)
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }, [draft, resourceId, savedAction, showBody, onSaved])

  const handleSave = useCallback(() => {
    if (savedAction) void persist(null)
    else setSavePrompt({ name: '', description: '', category: '' })
  }, [savedAction, persist])

  const handleSaveAs = useCallback(() => {
    setSavePrompt({
      name: savedAction ? `${savedAction.name} (copy)` : '',
      description: savedAction?.description ?? '',
      category: savedAction?.category ?? '',
    })
  }, [savedAction])

  // Cmd/Ctrl+S saves, Cmd/Ctrl+Enter sends — while focus is inside the tab.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault()
      e.stopPropagation()
      handleSave()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (!sending) void handleSend()
    }
  }

  const handleCopyBody = () => {
    if (!result) return
    void copyToClipboard(formatBody(result).text, { source: 'app-copy', tabType: 'api-response' })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const showHistory = (entry: HistoryEntry) => {
    setResult(entry.result)
    setActiveHistoryId(entry.id)
  }

  const body = result ? formatBody(result) : null

  return (
    <div className="api-request-tab" onKeyDown={handleKeyDown} tabIndex={-1}>
      {/* ── Request pane ── */}
      <div className="api-request-pane">
        <div className="api-request-line">
          <select
            className="api-request-resource"
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            title="API resource (base URL + auth)"
          >
            {resources.length === 0 && <option value="">No API resources</option>}
            {resources.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <select
            className="api-request-method"
            data-method={draft.method}
            value={draft.method}
            onChange={(e) => update('method', e.target.value)}
          >
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <PathInput
            value={draft.path}
            onChange={(v) => update('path', v)}
            placeholder="/api/v1/endpoint?limit={{limit}}"
            onEnter={() => { if (!sending) void handleSend() }}
          />
          <button
            className="api-request-send"
            onClick={() => void handleSend()}
            disabled={sending || !resourceId}
            title="Send (⌘/Ctrl+Enter)"
          >
            {sending ? <span className="api-request-spinner" /> : 'Send'}
          </button>
          <button
            className="api-request-btn"
            onClick={handleSave}
            disabled={saving || !resourceId || (savedAction !== null && !dirty)}
            title={savedAction ? 'Save changes (⌘/Ctrl+S)' : 'Save as a request (⌘/Ctrl+S)'}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAction && (
            <button className="api-request-btn" onClick={handleSaveAs} disabled={saving} title="Save a copy under a new name">
              Save as…
            </button>
          )}
        </div>
        <div className="api-request-url" title={resolvedUrl}>{resolvedUrl}</div>

        {error && <div className="api-request-error">{error}</div>}

        <div className="api-request-subtabs">
          <button className={reqTab === 'headers' ? 'active' : ''} onClick={() => setReqTab('headers')}>
            Headers{parsedHeaders && Object.keys(parsedHeaders).length > 0 ? ` (${Object.keys(parsedHeaders).length})` : ''}
          </button>
          {showBody && (
            <button className={reqTab === 'body' ? 'active' : ''} onClick={() => setReqTab('body')}>
              Body{draft.body ? ' •' : ''}
            </button>
          )}
          <button className={reqTab === 'variables' ? 'active' : ''} onClick={() => setReqTab('variables')}>
            Variables{varNames.length > 0 ? ` (${varNames.length})` : ''}
          </button>
          <button className={reqTab === 'extract' ? 'active' : ''} onClick={() => setReqTab('extract')}>
            Extract{draft.jsonExtractPath ? ' •' : ''}
          </button>
        </div>

        <div className="api-request-subtab-body">
          {reqTab === 'headers' && (
            <div className="api-request-field">
              <div className="api-request-field-row">
                <label>Headers (JSON object). Resource default headers and auth are added by the agent.</label>
                <button
                  className="api-request-mini"
                  onClick={() => {
                    const h = parseHeaders(draft.headersJson)
                    if (h) update('headersJson', JSON.stringify(h, null, 2))
                    else setError('Headers must be a JSON object')
                  }}
                >
                  Format
                </button>
              </div>
              <JsonEditor
                value={draft.headersJson}
                onChange={(v) => update('headersJson', v)}
                rows={3}
                placeholder='{ "Accept": "application/json" }'
              />
              {parsedHeaders === null && <span className="api-request-hint warn">Not valid JSON</span>}
            </div>
          )}

          {reqTab === 'body' && showBody && (
            <div className="api-request-field">
              <div className="api-request-field-row">
                <div className="api-request-body-modes">
                  {(['json', 'text', 'form'] as ApiRequestBodyMode[]).map((m) => (
                    <button
                      key={m}
                      className={draft.bodyMode === m ? 'active' : ''}
                      onClick={() => update('bodyMode', m)}
                      title={m === 'json' ? 'application/json' : CONTENT_TYPES[m] ?? ''}
                    >
                      {m === 'json' ? 'JSON' : m === 'text' ? 'Raw' : 'Form'}
                    </button>
                  ))}
                </div>
                {draft.bodyMode === 'json' && (
                  <button
                    className="api-request-mini"
                    onClick={() => {
                      try {
                        update('body', JSON.stringify(JSON.parse(draft.body || '{}'), null, 2))
                      } catch (e) {
                        setError(getErrorMessage(e, 'Body is not valid JSON'))
                      }
                    }}
                  >
                    Format
                  </button>
                )}
              </div>
              <JsonEditor
                value={draft.body}
                onChange={(v) => update('body', v)}
                rows={6}
                mode={draft.bodyMode === 'json' ? 'json' : 'text'}
                placeholder={draft.bodyMode === 'form' ? 'key=value&other={{var}}' : draft.bodyMode === 'json' ? '{ "key": "value" }' : 'raw text'}
              />
            </div>
          )}

          {reqTab === 'variables' && (
            <div className="api-request-field">
              {varNames.length === 0 ? (
                <span className="api-request-hint">
                  No template variables. Use <code>{'{{name}}'}</code> in the path, headers or body to add one.
                </span>
              ) : (
                <div className="api-request-vars">
                  {varNames.map((v) => (
                    <div key={v} className="api-request-var-row">
                      <span className="api-request-var-name">{`{{${v}}}`}</span>
                      <input
                        type="text"
                        value={variables[v] ?? ''}
                        onChange={(e) => setVariables((prev) => ({ ...prev, [v]: e.target.value }))}
                        placeholder={v}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {reqTab === 'extract' && (
            <div className="api-request-field">
              <label>JSON extract path</label>
              <input
                type="text"
                className="api-request-input"
                value={draft.jsonExtractPath}
                onChange={(e) => update('jsonExtractPath', e.target.value)}
                placeholder="results[0].name"
              />
              <span className="api-request-hint">
                Dot/bracket path into the JSON response. The extracted value is what Quick Calls show in toasts and what the AI gets back.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Response pane ── */}
      <div className="api-response-pane">
        <div className="api-response-bar">
          {result ? (
            <>
              <span className={`api-response-status ${statusClass(result.status_code)}`}>
                {result.status_code === 0 ? 'No response' : `HTTP ${result.status_code}`}
              </span>
              <span className="api-response-duration">{result.duration_ms}ms</span>
              {result.content_type && <span className="api-response-ctype" title={result.content_type}>{result.content_type.split(';')[0]}</span>}
            </>
          ) : (
            <span className="api-response-placeholder">Send a request to see the response</span>
          )}
          <span className="api-response-spacer" />
          {result && (
            <>
              <div className="api-request-subtabs compact">
                <button className={respTab === 'body' ? 'active' : ''} onClick={() => setRespTab('body')}>Body</button>
                <button className={respTab === 'headers' ? 'active' : ''} onClick={() => setRespTab('headers')}>
                  Headers{result.response_headers ? ` (${result.response_headers.length})` : ''}
                </button>
                <button className={respTab === 'sent' ? 'active' : ''} onClick={() => setRespTab('sent')}>Sent</button>
              </div>
              <button className="api-request-btn" onClick={handleCopyBody} disabled={!body?.text}>
                {copied ? 'Copied!' : 'Copy body'}
              </button>
            </>
          )}
        </div>

        {history.length > 1 && (
          <div className="api-response-history">
            {history.map((h) => (
              <button
                key={h.id}
                className={`api-response-history-item ${statusClass(h.result.status_code)} ${h.id === activeHistoryId ? 'active' : ''}`}
                onClick={() => showHistory(h)}
                title={`${h.method} ${h.path}`}
              >
                <span className="code">{h.result.status_code || 'ERR'}</span>
                <span className="time">{h.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span className="dur">{h.result.duration_ms}ms</span>
              </button>
            ))}
          </div>
        )}

        {result?.warning && <div className="api-response-banner warn">{result.warning}</div>}
        {result?.error && !result.success && <div className="api-response-banner error">{result.error}</div>}
        {result && draft.jsonExtractPath && (
          <div className="api-response-extract">
            <span className="label">Extracted</span>
            {result.extracted_value !== undefined && result.extracted_value !== null ? (
              <code>{typeof result.extracted_value === 'string' ? result.extracted_value : JSON.stringify(result.extracted_value)}</code>
            ) : (
              <code className="miss">no match for {draft.jsonExtractPath}</code>
            )}
          </div>
        )}

        <div className="api-response-body">
          {result && respTab === 'body' && body && (
            body.isJson
              ? <JsonViewer content={body.text} />
              : body.text
                ? <pre className="api-response-raw">{body.text}</pre>
                : <div className="api-response-placeholder">Empty body</div>
          )}
          {result && respTab === 'headers' && (
            result.response_headers && result.response_headers.length > 0 ? (
              <table className="api-response-headers">
                <tbody>
                  {result.response_headers.map(([k, v], i) => (
                    <tr key={`${k}-${i}`}><td>{k}</td><td>{v}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="api-response-placeholder">No response headers</div>
          )}
          {result && respTab === 'sent' && (
            <div className="api-response-sent">
              {result.sent_url && (
                <div className="api-response-sent-row">
                  <span className="label">URL</span>
                  <code>{draft.method} {result.sent_url}</code>
                </div>
              )}
              {result.sent_headers && result.sent_headers.length > 0 ? (
                <table className="api-response-headers">
                  <tbody>
                    {result.sent_headers.map(([k, v], i) => (
                      <tr key={`${k}-${i}`}><td>{k}</td><td>{v}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="api-response-placeholder">Request was not sent</div>}
              <span className="api-request-hint">Secret header values are redacted to their last 4 characters.</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Save-as prompt ── */}
      {savePrompt && (
        <div className="api-request-save-overlay" onClick={() => setSavePrompt(null)}>
          <div className="api-request-save-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="api-request-save-title">Save request</div>
            <label>Name</label>
            <input
              type="text"
              className="api-request-input"
              autoFocus
              value={savePrompt.name}
              onChange={(e) => setSavePrompt({ ...savePrompt, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void persist(savePrompt) }}
              placeholder="e.g. Get device by name"
            />
            <label>Description</label>
            <input
              type="text"
              className="api-request-input"
              value={savePrompt.description}
              onChange={(e) => setSavePrompt({ ...savePrompt, description: e.target.value })}
              placeholder="Optional"
            />
            <label>Category</label>
            <input
              type="text"
              className="api-request-input"
              value={savePrompt.category}
              onChange={(e) => setSavePrompt({ ...savePrompt, category: e.target.value })}
              placeholder="Optional — groups requests in Quick Calls"
            />
            <div className="api-request-save-actions">
              <button className="api-request-btn" onClick={() => setSavePrompt(null)}>Cancel</button>
              <button className="api-request-send" onClick={() => void persist(savePrompt)} disabled={saving || !savePrompt.name.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
