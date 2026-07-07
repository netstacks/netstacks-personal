import { useState, useRef, useCallback, useMemo } from 'react'
import {
  createQuickAction,
  updateQuickAction,
  executeInlineQuickAction,
  listApiResources,
} from '../api/quickActions'
import type {
  ApiResource,
  QuickAction,
  CreateQuickActionRequest,
  UpdateQuickActionRequest,
  QuickActionResult,
} from '../types/quickAction'
import { extractActionVariables } from '../lib/quickActionVariables'
import './QuickActionDialog.css'
import AITabInput from './AITabInput'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'

import { getErrorMessage } from '../api/errors'
const Icons = {
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Lightweight JSON syntax highlighter — Postman-style colors.
 *  Tokenizes character-by-character, tracking key vs value context. */
function highlightJson(text: string): string {
  const out: string[] = []
  let i = 0
  // Stack tracks context: 'o' = object (expect keys), 'a' = array (no keys)
  const stack: ('o' | 'a')[] = []
  let expectKey = true

  while (i < text.length) {
    const ch = text[i]

    // Template variable {{var}} outside strings
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end !== -1) {
        out.push(`<span class="jh-var">${escapeHtml(text.slice(i, end + 2))}</span>`)
        i = end + 2
        continue
      }
    }

    // Quoted string
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      j++ // closing quote
      const raw = text.slice(i, j)
      const cls = expectKey ? 'jh-key' : 'jh-string'
      const inner = escapeHtml(raw).replace(
        /\{\{(\w+)\}\}/g,
        '<span class="jh-var">{{$1}}</span>',
      )
      out.push(`<span class="${cls}">${inner}</span>`)
      expectKey = false
      i = j
      continue
    }

    // Number
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const numMatch = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      if (numMatch) {
        out.push(`<span class="jh-number">${numMatch[0]}</span>`)
        expectKey = false
        i += numMatch[0].length
        continue
      }
    }

    // Keywords: true, false, null
    const rest = text.slice(i)
    const kwMatch = rest.match(/^(true|false|null)(?=[,\]}\s]|$)/)
    if (kwMatch) {
      out.push(`<span class="jh-keyword">${kwMatch[1]}</span>`)
      expectKey = false
      i += kwMatch[1].length
      continue
    }

    // Structural punctuation
    if (ch === '{') { stack.push('o'); out.push(`<span class="jh-punct">{</span>`); expectKey = true; i++; continue }
    if (ch === '[') { stack.push('a'); out.push(`<span class="jh-punct">[</span>`); expectKey = false; i++; continue }
    if (ch === '}') { stack.pop(); out.push(`<span class="jh-punct">}</span>`); expectKey = false; i++; continue }
    if (ch === ']') { stack.pop(); out.push(`<span class="jh-punct">]</span>`); expectKey = false; i++; continue }
    if (ch === ':') { out.push(`<span class="jh-punct">:</span>`); expectKey = false; i++; continue }
    if (ch === ',') { out.push(`<span class="jh-punct">,</span>`); expectKey = stack[stack.length - 1] === 'o'; i++; continue }

    // Whitespace / other
    out.push(escapeHtml(ch))
    i++
  }

  return out.join('')
}

function JsonEditor({
  value,
  onChange,
  rows,
  placeholder,
}: {
  value: string
  onChange: (val: string) => void
  rows: number
  placeholder?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop
      preRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [])

  const highlighted = highlightJson(value)

  return (
    <div className="qad-json-editor">
      <pre
        ref={preRef}
        className="qad-json-highlight"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
      />
      <textarea
        ref={textareaRef}
        className="qad-json-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
}

/** Highlights {{var}} in path strings */
function highlightPath(text: string): string {
  return escapeHtml(text).replace(
    /\{\{(\w+)\}\}/g,
    '<span class="jh-var">{{$1}}</span>',
  )
}

function PathInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (val: string) => void
  placeholder?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const spanRef = useRef<HTMLSpanElement>(null)

  const handleScroll = useCallback(() => {
    if (inputRef.current && spanRef.current) {
      spanRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }, [])

  const highlighted = highlightPath(value)

  return (
    <div className="qad-path-editor">
      <span
        ref={spanRef}
        className="qad-path-highlight"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlighted || '&nbsp;' }}
      />
      <input
        ref={inputRef}
        type="text"
        className="qad-path-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
}

export default function QuickActionDialog({
  action,
  resources: initialResources,
  prefilledResourceId,
  onClose,
  onSave,
}: {
  action: QuickAction | null
  resources: ApiResource[]
  prefilledResourceId?: string | null
  onClose: () => void
  onSave: () => void
}) {
  const isEdit = action !== null
  const [name, setName] = useState(action?.name || '')
  const [description, setDescription] = useState(action?.description || '')
  const [apiResourceId, setApiResourceId] = useState(
    action?.api_resource_id || prefilledResourceId || initialResources[0]?.id || ''
  )
  const [method, setMethod] = useState(action?.method || 'GET')
  const [path, setPath] = useState(action?.path || '/')
  const [headers, setHeaders] = useState(JSON.stringify(action?.headers || {}, null, 2))
  const [body, setBody] = useState(action?.body || '')
  const [jsonExtractPath, setJsonExtractPath] = useState(action?.json_extract_path || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<QuickActionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [headersJsonError, setHeadersJsonError] = useState<string | null>(null)
  const [bodyJsonError, setBodyJsonError] = useState<string | null>(null)
  const [resources, setResources] = useState(initialResources)
  const [testVarValues, setTestVarValues] = useState<Record<string, string>>({})

  // Detect template variables reactively
  const testVars = useMemo(() => {
    const res = resources.find((r) => r.id === apiResourceId)
    const storeAs = res?.auth_flow?.map((s) => s.store_as) ?? []
    let parsed: Record<string, string> = {}
    try { parsed = JSON.parse(headers || '{}') } catch { /* ignore */ }
    return extractActionVariables(path, parsed, body, storeAs)
  }, [path, headers, body, apiResourceId, resources])

  // Fetch resources on mount if none provided
  useState(() => {
    if (resources.length === 0) {
      listApiResources().then(setResources).catch(console.error)
    }
  })

  const formatJson = (value: string, setter: (v: string) => void, setJsonErr: (e: string | null) => void) => {
    try {
      const parsed = JSON.parse(value || '{}')
      setter(JSON.stringify(parsed, null, 2))
      setJsonErr(null)
    } catch (e) {
      setJsonErr(getErrorMessage(e, 'Invalid JSON'))
    }
  }

  const handleSave = async () => {
    if (!name.trim() || !apiResourceId) {
      setError('Name and API Resource are required')
      return
    }

    let parsedHeaders: Record<string, string> = {}
    try {
      parsedHeaders = JSON.parse(headers || '{}')
    } catch {
      setError('Headers must be valid JSON')
      return
    }

    setSaving(true)
    setError(null)

    try {
      if (isEdit) {
        const update: UpdateQuickActionRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          api_resource_id: apiResourceId,
          method,
          path,
          headers: parsedHeaders,
          body: body || undefined,
          json_extract_path: jsonExtractPath || undefined,
        }
        await updateQuickAction(action!.id, update)
      } else {
        const create: CreateQuickActionRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          api_resource_id: apiResourceId,
          method,
          path,
          headers: parsedHeaders,
          body: body || undefined,
          json_extract_path: jsonExtractPath || undefined,
        }
        await createQuickAction(create)
      }
      onSave()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  const substituteVars = (text: string, vars: Record<string, string>) => {
    return text.replace(/\{\{(\w+)\}\}/g, (match, name) => vars[name] ?? match)
  }

  const handleTest = async () => {
    // Check all variables have values
    const missingVars = testVars.filter((v) => !testVarValues[v]?.trim())
    if (missingVars.length > 0) {
      setError(`Fill in variable${missingVars.length > 1 ? 's' : ''}: ${missingVars.join(', ')}`)
      return
    }

    let parsedHeaders: Record<string, string> = {}
    try {
      parsedHeaders = JSON.parse(headers || '{}')
    } catch {
      setError('Headers must be valid JSON')
      return
    }

    // Substitute variables
    const resolvedPath = substituteVars(path, testVarValues)
    const resolvedHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsedHeaders)) {
      resolvedHeaders[k] = substituteVars(v, testVarValues)
    }
    const resolvedBody = body ? substituteVars(body, testVarValues) : undefined

    setTesting(true)
    setTestResult(null)
    try {
      const result = await executeInlineQuickAction({
        api_resource_id: apiResourceId,
        method,
        path: resolvedPath,
        headers: resolvedHeaders,
        body: resolvedBody,
        json_extract_path: jsonExtractPath || undefined,
        // Forward test variables so backend-side substitution (e.g. inside
        // resource default_headers like `Authorization: {{api_key}}`) can
        // also see anything the user typed in Test Variables.
        variables: testVarValues,
      })
      setTestResult(result)
    } catch {
      setTestResult({ success: false, status_code: 0, duration_ms: 0, error: 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const showBody = method === 'POST' || method === 'PUT' || method === 'PATCH'

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose, clickOutside: false })

  return (
    <div className="quick-action-dialog-wrapper">
      <div className="qad-overlay" {...backdropProps}>
        <div className="qad-content" {...contentProps}>
          <div className="qad-header">
            <h3>{isEdit ? 'Edit Quick Action' : 'New Quick Action'}</h3>
            <button className="qad-close" onClick={onClose}>{Icons.x}</button>
          </div>

          <div className="qad-body">
            {error && <div className="qad-error">{error}</div>}

            <div className="qad-field">
              <label>Name</label>
              <AITabInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Get Circuit TX Rate"
                aiField="action_name"
                aiPlaceholder="Name for this quick action"
                aiContext={{ description, method, path }}
                onAIValue={(v) => setName(v)}
                autoFocus
              />
            </div>

            <div className="qad-field">
              <label>Description</label>
              <AITabInput
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                aiField="action_description"
                aiPlaceholder="What this quick action does"
                aiContext={{ name, method, path }}
                onAIValue={(v) => setDescription(v)}
              />
            </div>

            <div className="qad-field">
              <label>API Resource</label>
              <select value={apiResourceId} onChange={(e) => setApiResourceId(e.target.value)}>
                {resources.length === 0 && <option value="">No resources available</option>}
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>

            <div className="qad-row">
              <div className="qad-field" style={{ width: 100 }}>
                <label>Method</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>
              <div className="qad-field" style={{ flex: 1 }}>
                <label>Path</label>
                <PathInput value={path} onChange={setPath} placeholder="/api/v1/endpoint" />
              </div>
            </div>

            <div className="qad-field">
              <div className="qad-field-label-row">
                <label>Headers (JSON)</label>
                <button className="qad-format-btn" onClick={() => formatJson(headers, setHeaders, setHeadersJsonError)}>Format</button>
              </div>
              <JsonEditor value={headers} onChange={(v) => { setHeaders(v); setHeadersJsonError(null) }} rows={2} placeholder='{}' />
              {headersJsonError && <span className="qad-json-error">{headersJsonError}</span>}
            </div>

            {showBody && (
              <div className="qad-field">
                <div className="qad-field-label-row">
                  <label>Payload (JSON)</label>
                  <button className="qad-format-btn" onClick={() => formatJson(body, setBody, setBodyJsonError)}>Format</button>
                </div>
                <JsonEditor value={body} onChange={(v) => { setBody(v); setBodyJsonError(null) }} rows={3} placeholder='{"key": "value"}' />
                {bodyJsonError && <span className="qad-json-error">{bodyJsonError}</span>}
              </div>
            )}

            <div className="qad-field">
              <label>JSON Extract Path</label>
              <input type="text" value={jsonExtractPath} onChange={(e) => setJsonExtractPath(e.target.value)} placeholder="result[0].txrate" />
              <span className="qad-hint">Dot-bracket path to extract a value from the response</span>
            </div>

            {testVars.length > 0 && (
              <div className="qad-field">
                <label>Test Variables</label>
                <div className="qad-test-vars">
                  {testVars.map((v) => (
                    <div key={v} className="qad-test-var-row">
                      <span className="qad-test-var-name">{`{{${v}}}`}</span>
                      <input
                        type="text"
                        value={testVarValues[v] ?? ''}
                        onChange={(e) => setTestVarValues((prev) => ({ ...prev, [v]: e.target.value }))}
                        placeholder={v}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {testResult && (
              <div className={`qad-test-result ${testResult.success ? 'success' : 'failure'}`}>
                <div className="qad-test-result-header">
                  {testResult.success ? Icons.check : Icons.x}
                  <span>HTTP {testResult.status_code} ({testResult.duration_ms}ms)</span>
                </div>
                {jsonExtractPath && (
                  <div className="qad-test-result-value">
                    <label>Extracted:</label>
                    {testResult.extracted_value !== undefined && testResult.extracted_value !== null ? (
                      <code>{typeof testResult.extracted_value === 'string' ? testResult.extracted_value : JSON.stringify(testResult.extracted_value)}</code>
                    ) : (
                      <code className="qad-extract-miss">(no match for <strong>{jsonExtractPath}</strong> — check the response body below)</code>
                    )}
                  </div>
                )}
                {testResult.sent_url && (
                  <div className="test-result-meta">
                    <span className="test-result-label">URL</span>
                    <code>{testResult.sent_url}</code>
                  </div>
                )}
                {testResult.sent_headers && testResult.sent_headers.length > 0 && (
                  <div className="test-result-meta">
                    <span className="test-result-label">Sent headers</span>
                    <code className="test-result-headers">
                      {testResult.sent_headers.map(([k, v]) => `${k}: ${v}`).join('\n')}
                    </code>
                  </div>
                )}
                {testResult.raw_body !== undefined && testResult.raw_body !== null && (
                  <details className="test-result-details">
                    <summary>Response body</summary>
                    <pre>{JSON.stringify(testResult.raw_body, null, 2).substring(0, 2000)}</pre>
                  </details>
                )}
                {testResult.error && <div className="qad-test-result-error">{testResult.error}</div>}
              </div>
            )}
          </div>

          <div className="qad-footer">
            <button className="qad-btn-secondary" onClick={handleTest} disabled={testing || !apiResourceId}>
              {testing ? 'Testing...' : 'Test'}
            </button>
            <div className="qad-footer-right">
              <button className="qad-btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="qad-btn-primary"
                onClick={handleSave}
                disabled={saving || !name.trim() || !apiResourceId}
                title={!name.trim() ? 'Name is required' : !apiResourceId ? 'Pick an API resource' : undefined}
              >
                {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
