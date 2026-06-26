import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listMatchers,
  listSources,
  createMatcher,
  updateMatcher,
  deleteMatcher,
  testMatcher,
  replaceMatcherSources,
  createSource,
  updateSource,
  deleteSource,
  testSource,
  reloadEnrichment,
  exportEnrichment,
  importEnrichment,
  type EnrichmentImportResult,
  type EnrichmentMatcher,
  type EnrichmentSource,
  type EnrichmentSourceTestResult,
  type PickedField,
  type MatcherTestMatch,
} from '../api/enrichment'
import { listApiResources } from '../api/quickActions'
import type { ApiResource } from '../types/quickAction'
import { useSettings } from '../hooks/useSettings'
import { getErrorMessage } from '../api/errors'
import { EnrichmentSourceExplorer } from './EnrichmentSourceExplorer'
import { walkJsonPath, substituteTemplateVars, formatPreviewValue } from '../lib/enrichmentFieldUtils'
import { downloadFile } from '../lib/formatters'
import './SettingsEnrichment.css'

const FORMAT_OPTIONS = ['string', 'datetime', 'uptime', 'bytes', 'status_pill']
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'DELETE']

/**
 * Settings → Enrichment. Full CRUD for the hover-enrichment system:
 *   - master toggles (hover + AI digest), persisted via useSettings
 *   - matchers: create / edit (name, description, patterns, CLI flavors,
 *     priority, source assignment) / test / delete
 *   - sources: create / edit (name, description, kind, API resource, method,
 *     path template, response unwrap, picked fields) / enable-disable / delete
 *
 * Matchers/sources live in the agent DB; after any mutation we call
 * reloadEnrichment() so the agent's in-memory registry refreshes.
 */
export default function SettingsEnrichment() {
  const { settings, updateSetting } = useSettings()
  const [matchers, setMatchers] = useState<EnrichmentMatcher[]>([])
  const [sources, setSources] = useState<EnrichmentSource[]>([])
  const [apiResources, setApiResources] = useState<ApiResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedMatcher, setExpandedMatcher] = useState<string | null>(null)
  const [editingSource, setEditingSource] = useState<string | null>(null)
  const [creatingMatcher, setCreatingMatcher] = useState(false)
  const [creatingSource, setCreatingSource] = useState(false)
  const [importResult, setImportResult] = useState<EnrichmentImportResult | null>(null)
  const [importOverwrite, setImportOverwrite] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const disabledSources = settings['terminal.enrichment.disabledSources'] ?? []

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, s, r] = await Promise.all([
        listMatchers(),
        listSources(),
        listApiResources().catch(() => [] as ApiResource[]),
      ])
      setMatchers(m)
      setSources(s)
      setApiResources(r)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const afterMutation = useCallback(async () => {
    try { await reloadEnrichment() } catch { /* best-effort */ }
    await load()
  }, [load])

  const handleExport = useCallback(async () => {
    setError(null)
    try {
      const toml = await exportEnrichment()
      const stamp = new Date().toISOString().split('T')[0]
      downloadFile(toml, `netstacks-enrichment-${stamp}.toml`, 'application/toml')
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }, [])

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-importing the same file
    if (!file) return
    setError(null)
    setImportResult(null)
    try {
      const toml = await file.text()
      const result = await importEnrichment(toml, importOverwrite)
      setImportResult(result)
      await afterMutation()
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }, [importOverwrite, afterMutation])

  const toggleSourceDisabled = useCallback((name: string, disabled: boolean) => {
    const next = disabled
      ? Array.from(new Set([...disabledSources, name]))
      : disabledSources.filter((s) => s !== name)
    updateSetting('terminal.enrichment.disabledSources', next)
  }, [disabledSources, updateSetting])

  const sourceName = useCallback((id: string) => sources.find((s) => s.id === id)?.name ?? id, [sources])
  const apiResourceName = useCallback(
    (id: string | null) => (id ? apiResources.find((r) => r.id === id)?.name ?? id : null),
    [apiResources],
  )

  return (
    <div className="settings-enrichment">
      <div className="se-header">
        <h2>Enrichment</h2>
        <p className="se-sub">
          Hover an IP, MAC, or interface in any terminal to see live context (reverse-DNS, OUI vendor,
          NetBox / crawler data). Matchers decide which tokens are recognized; sources decide what data is fetched.
        </p>
      </div>

      {/* Master toggles */}
      <section className="se-section">
        <label className="se-toggle">
          <input
            type="checkbox"
            checked={settings['terminal.enrichment.hoverEnabled'] !== false}
            onChange={(e) => updateSetting('terminal.enrichment.hoverEnabled', e.target.checked)}
          />
          <span>Enable hover enrichment</span>
        </label>
        <label className="se-toggle">
          <input
            type="checkbox"
            checked={settings['terminal.enrichment.aiDigestEnabled'] === true}
            onChange={(e) => updateSetting('terminal.enrichment.aiDigestEnabled', e.target.checked)}
          />
          <span>Show AI Digest button (✦) — summarizes enrichment data with AI</span>
        </label>
        {settings['terminal.hoverLookups'] === false && (
          <p className="se-warn">
            “Show hover info” is off in General settings — that master switch also gates enrichment.
          </p>
        )}
      </section>

      {/* Backup: export / import matchers + sources as TOML */}
      <section className="se-section">
        <div className="se-section-head">
          <h3>Backup</h3>
          <div className="se-backup-actions">
            <button className="se-btn" onClick={() => void handleExport()}>Export TOML</button>
            <label className="se-toggle se-backup-overwrite">
              <input type="checkbox" checked={importOverwrite} onChange={(e) => setImportOverwrite(e.target.checked)} />
              <span>overwrite existing</span>
            </label>
            <button className="se-btn" onClick={() => importInputRef.current?.click()}>Import TOML…</button>
            <input
              ref={importInputRef}
              type="file"
              accept=".toml,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => void handleImportFile(e)}
            />
          </div>
        </div>
        <p className="se-sub">
          Export all matchers and sources to a TOML file, or import from one. Import adds new rows by name;
          tick “overwrite existing” to replace matching rows.
        </p>
        {importResult && (
          <div className="se-import-result">
            Imported: {importResult.matchers_added} matcher(s) added, {importResult.matchers_updated} updated;{' '}
            {importResult.sources_added} source(s) added, {importResult.sources_updated} updated;{' '}
            {importResult.assignments_updated} assignment(s) updated.
          </div>
        )}
      </section>

      {error && <div className="se-error">{error}</div>}
      {loading ? (
        <div className="se-loading">Loading…</div>
      ) : (
        <>
          {/* Matchers */}
          <section className="se-section">
            <div className="se-section-head">
              <h3>Matchers</h3>
              <button className="se-btn" onClick={() => setCreatingMatcher((v) => !v)}>
                {creatingMatcher ? 'Cancel' : '+ Add matcher'}
              </button>
            </div>
            {creatingMatcher && (
              <MatcherForm
                sources={sources}
                sourceName={sourceName}
                onError={setError}
                onCancel={() => setCreatingMatcher(false)}
                onSave={async (draft, assigned) => {
                  try {
                    const created = await createMatcher({
                      name: draft.name,
                      description: draft.description,
                      patterns: draft.patterns,
                      cli_flavors: draft.cli_flavors,
                      priority: draft.priority,
                    })
                    if (assigned.length > 0) await replaceMatcherSources(created.id, assigned)
                    setCreatingMatcher(false)
                    await afterMutation()
                  } catch (err) { setError(getErrorMessage(err)) }
                }}
              />
            )}
            <div className="se-list">
              {matchers.map((m) => (
                <MatcherRow
                  key={m.id}
                  matcher={m}
                  sources={sources}
                  expanded={expandedMatcher === m.id}
                  onToggle={() => setExpandedMatcher(expandedMatcher === m.id ? null : m.id)}
                  onChanged={afterMutation}
                  onError={setError}
                  sourceName={sourceName}
                />
              ))}
              {matchers.length === 0 && <div className="se-empty">No matchers configured.</div>}
            </div>
          </section>

          {/* Sources */}
          <section className="se-section">
            <div className="se-section-head">
              <h3>Sources</h3>
              <button className="se-btn" onClick={() => setCreatingSource((v) => !v)}>
                {creatingSource ? 'Cancel' : '+ Add source'}
              </button>
            </div>
            {creatingSource && (
              <SourceForm
                apiResources={apiResources}
                onCancel={() => setCreatingSource(false)}
                onSave={async (draft) => {
                  try {
                    await createSource(draft)
                    setCreatingSource(false)
                    await afterMutation()
                  } catch (err) { setError(getErrorMessage(err)) }
                }}
              />
            )}
            <div className="se-list">
              {sources.map((s) => (
                <div key={s.id} className="se-source-item">
                  <div className="se-source-row">
                    <label className="se-toggle se-source-toggle">
                      <input
                        type="checkbox"
                        checked={!disabledSources.includes(s.name)}
                        onChange={(e) => toggleSourceDisabled(s.name, !e.target.checked)}
                        title="Enable / disable this source for hover lookups"
                      />
                      <span className="se-source-name">{s.name}</span>
                    </label>
                    <span className={`se-chip ${s.kind === 'builtin' ? 'se-chip-builtin' : 'se-chip-api'}`}>{s.kind}</span>
                    <span className="se-source-meta">
                      {s.kind === 'api_resource'
                        ? (s.api_resource_id ? `${apiResourceName(s.api_resource_id)} · ${s.path_template}` : '⚠ unconfigured (no API resource bound)')
                        : `${s.picked_fields.length} field${s.picked_fields.length === 1 ? '' : 's'}`}
                    </span>
                    {s.is_builtin && <span className="se-badge">built-in</span>}
                    {s.kind !== 'builtin' && (
                      <button className="se-btn" onClick={() => setEditingSource(editingSource === s.id ? null : s.id)}>
                        {editingSource === s.id ? 'Close' : 'Edit'}
                      </button>
                    )}
                    {!s.is_builtin && (
                      <button className="se-btn se-btn-danger" onClick={() => void removeSource(s.id, afterMutation, setError)}>
                        Delete
                      </button>
                    )}
                  </div>
                  {editingSource === s.id && s.kind !== 'builtin' && (
                    <SourceForm
                      apiResources={apiResources}
                      initial={s}
                      onCancel={() => setEditingSource(null)}
                      onSave={async (draft) => {
                        try {
                          await updateSource(s.id, draft)
                          setEditingSource(null)
                          await afterMutation()
                        } catch (err) { setError(getErrorMessage(err)) }
                      }}
                    />
                  )}
                </div>
              ))}
              {sources.length === 0 && <div className="se-empty">No sources configured.</div>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ── Matcher list row (expandable editor) ────────────────────────────────────

function MatcherRow({
  matcher, sources, expanded, onToggle, onChanged, onError, sourceName,
}: {
  matcher: EnrichmentMatcher
  sources: EnrichmentSource[]
  expanded: boolean
  onToggle: () => void
  onChanged: () => Promise<void>
  onError: (e: string) => void
  sourceName: (id: string) => string
}) {
  return (
    <div className="se-matcher">
      <div className="se-matcher-head" onClick={onToggle}>
        <span className="se-matcher-name">{matcher.name}</span>
        {matcher.is_builtin && <span className="se-badge">built-in</span>}
        <span className="se-matcher-summary">
          {matcher.source_ids.length} source{matcher.source_ids.length === 1 ? '' : 's'}
          {matcher.cli_flavors.length > 0 && ` · ${matcher.cli_flavors.join(', ')}`}
        </span>
        <span className="se-matcher-prio">p{matcher.priority}</span>
      </div>
      {expanded && (
        <MatcherForm
          sources={sources}
          sourceName={sourceName}
          initial={matcher}
          onError={onError}
          onCancel={onToggle}
          onSave={async (draft, assigned) => {
            try {
              if (!matcher.is_builtin) {
                await updateMatcher(matcher.id, {
                  name: draft.name,
                  description: draft.description,
                  patterns: draft.patterns,
                  cli_flavors: draft.cli_flavors,
                  priority: draft.priority,
                })
              }
              await replaceMatcherSources(matcher.id, assigned)
              await onChanged()
            } catch (err) { onError(getErrorMessage(err)) }
          }}
          onDelete={matcher.is_builtin ? undefined : async () => {
            try { await deleteMatcher(matcher.id); await onChanged() } catch (err) { onError(getErrorMessage(err)) }
          }}
        />
      )}
    </div>
  )
}

// ── Matcher create/edit form ────────────────────────────────────────────────

interface MatcherDraft {
  name: string
  description: string
  patterns: string[]
  cli_flavors: string[]
  priority: number
}

function MatcherForm({
  sources, sourceName, initial, onSave, onCancel, onDelete, onError,
}: {
  sources: EnrichmentSource[]
  sourceName: (id: string) => string
  initial?: EnrichmentMatcher
  onSave: (draft: MatcherDraft, assignedSourceIds: string[]) => Promise<void>
  onCancel: () => void
  onDelete?: () => Promise<void>
  onError?: (e: string) => void
}) {
  const readOnly = initial?.is_builtin ?? false
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [patterns, setPatterns] = useState((initial?.patterns ?? ['']).join('\n'))
  const [flavors, setFlavors] = useState((initial?.cli_flavors ?? []).join(', '))
  const [priority, setPriority] = useState(String(initial?.priority ?? 10))
  const [assigned, setAssigned] = useState<string[]>(initial?.source_ids ?? [])
  const [testText, setTestText] = useState('')
  const [testResult, setTestResult] = useState<MatcherTestMatch[] | null>(null)
  const [saving, setSaving] = useState(false)

  const patternList = patterns.split('\n').map((p) => p.trim()).filter(Boolean)

  const save = async () => {
    setSaving(true)
    await onSave(
      {
        name: name.trim(),
        description: description.trim(),
        patterns: patternList,
        cli_flavors: flavors.split(',').map((f) => f.trim()).filter(Boolean),
        priority: Number(priority) || 10,
      },
      assigned,
    )
    setSaving(false)
  }

  const runTest = async () => {
    try { setTestResult(await testMatcher(patternList, testText)) }
    catch (err) { onError?.(getErrorMessage(err)) }
  }
  const totalMatches = testResult?.reduce((n, r) => n + r.matches.length, 0) ?? 0

  return (
    <div className="se-matcher-body">
      <div className="se-field-row">
        <label className="se-field">
          <span>Name</span>
          <input value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} placeholder="e.g. vlan_id" />
        </label>
        <label className="se-field se-field-narrow">
          <span>Priority</span>
          <input value={priority} disabled={readOnly} onChange={(e) => setPriority(e.target.value)} />
        </label>
      </div>
      <label className="se-field">
        <span>Description</span>
        <input value={description} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="se-field">
        <span>Patterns (one regex per line)</span>
        <textarea value={patterns} disabled={readOnly} onChange={(e) => setPatterns(e.target.value)} rows={Math.max(2, patternList.length)} />
      </label>
      <label className="se-field">
        <span>CLI flavors (comma-separated; empty = all flavors)</span>
        <input value={flavors} disabled={readOnly} onChange={(e) => setFlavors(e.target.value)} placeholder="cisco-ios, juniper" />
      </label>

      <div className="se-field">
        <span>Assigned sources</span>
        <div className="se-source-grid">
          {sources.map((s) => (
            <label key={s.id} className="se-source-check">
              <input
                type="checkbox"
                checked={assigned.includes(s.id)}
                onChange={(e) => setAssigned(e.target.checked ? [...assigned, s.id] : assigned.filter((id) => id !== s.id))}
              />
              <span>{sourceName(s.id)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="se-field">
        <span>Test against sample text</span>
        <input value={testText} placeholder="e.g. interface Gi0/1 is up, mac aabb.ccdd.eeff" onChange={(e) => setTestText(e.target.value)} />
        <div className="se-test-row">
          <button className="se-btn" onClick={() => void runTest()}>Test</button>
          {testResult && <span className="se-test-result">{totalMatches} match{totalMatches === 1 ? '' : 'es'}</span>}
        </div>
        {testResult && testResult.map((r, ri) => (
          <div key={ri} className="se-match-row">
            {r.error ? (
              <span className="se-test-error">{r.pattern}: {r.error}</span>
            ) : r.matches.length === 0 ? (
              <span className="se-match-none"><code>{r.pattern}</code> — no matches</span>
            ) : (
              <>
                <code className="se-match-pattern">{r.pattern}</code>
                {r.matches.map((m, mi) => <span key={mi} className="se-match-chip">{m.text}</span>)}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="se-matcher-actions">
        <button className="se-btn se-btn-primary" disabled={saving || !name.trim() || patternList.length === 0} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="se-btn" onClick={onCancel}>Cancel</button>
        {onDelete && <button className="se-btn se-btn-danger" onClick={() => void onDelete()}>Delete</button>}
      </div>
    </div>
  )
}

// ── Source create/edit form ─────────────────────────────────────────────────

interface SourceDraft {
  name: string
  description: string
  kind: string
  api_resource_id: string | null
  method: string
  path_template: string
  response_unwrap: string
  picked_fields: PickedField[]
}

function SourceForm({
  apiResources, initial, onSave, onCancel,
}: {
  apiResources: ApiResource[]
  initial?: EnrichmentSource
  onSave: (draft: SourceDraft) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [kind, setKind] = useState(initial?.kind ?? 'api_resource')
  const [apiResourceId, setApiResourceId] = useState<string | null>(initial?.api_resource_id ?? null)
  const [method, setMethod] = useState(initial?.method ?? 'GET')
  const [pathTemplate, setPathTemplate] = useState(initial?.path_template ?? '/api/search?q={token_url}')
  const [responseUnwrap, setResponseUnwrap] = useState(initial?.response_unwrap ?? '')
  const [fields, setFields] = useState<PickedField[]>(initial?.picked_fields ?? [])
  const [saving, setSaving] = useState(false)
  // Test explorer state
  const [sampleToken, setSampleToken] = useState('')
  const [sampleHost, setSampleHost] = useState('')
  const [testResult, setTestResult] = useState<EnrichmentSourceTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const isApi = kind === 'api_resource'

  const runTest = async () => {
    setTesting(true)
    setTestError(null)
    try {
      const res = await testSource({
        api_resource_id: apiResourceId,
        method,
        path_template: pathTemplate,
        response_unwrap: responseUnwrap,
        sample_token: sampleToken,
        sample_session_host: sampleHost || null,
      })
      setTestResult(res)
    } catch (err) {
      setTestError(getErrorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  // Live preview of picked fields against the last test response.
  const preview = (() => {
    if (!testResult?.raw_response) return null
    const tpl: Record<string, string> = {
      token: sampleToken,
      token_url: encodeURIComponent(sampleToken),
      session_host: sampleHost || '(live-host)',
      session_host_ip: sampleHost || '(live-host-ip)',
      session_name: '(live-name)',
    }
    const unwrapExpr = responseUnwrap ? substituteTemplateVars(responseUnwrap, tpl) : ''
    const unwrapped = unwrapExpr ? walkJsonPath(testResult.raw_response, unwrapExpr) : testResult.raw_response
    const projected = Array.isArray(unwrapped) ? unwrapped[0] : unwrapped
    return fields.filter((f) => f.key.trim()).map((f) => {
      const keyExpr = substituteTemplateVars(f.key, tpl)
      const isJsonPath = keyExpr.trim().startsWith('$')
      const against = isJsonPath ? unwrapped : projected
      const raw = against !== undefined && against !== null ? walkJsonPath(against, keyExpr) : undefined
      return { label: f.label || f.key, value: raw === undefined ? '—' : formatPreviewValue(raw, f.format) }
    })
  })()

  const save = async () => {
    setSaving(true)
    await onSave({
      name: name.trim(),
      description: description.trim(),
      kind,
      api_resource_id: isApi ? apiResourceId : null,
      method,
      path_template: isApi ? pathTemplate : '',
      response_unwrap: isApi ? responseUnwrap : '',
      picked_fields: fields.filter((f) => f.key.trim()),
    })
    setSaving(false)
  }

  const setField = (i: number, patch: Partial<PickedField>) =>
    setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))

  return (
    <div className="se-matcher-body">
      <div className="se-field-row">
        <label className="se-field">
          <span>Name{initial?.is_builtin ? ' (built-in — immutable)' : ''}</span>
          <input value={name} disabled={initial?.is_builtin} onChange={(e) => setName(e.target.value)} placeholder="e.g. my_cmdb" />
        </label>
        <label className="se-field se-field-narrow">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!initial}>
            <option value="api_resource">api_resource</option>
            <option value="builtin">builtin</option>
          </select>
        </label>
      </div>
      <label className="se-field">
        <span>Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      {isApi && (
        <>
          <div className="se-field-row">
            <label className="se-field">
              <span>API resource</span>
              <select value={apiResourceId ?? ''} onChange={(e) => setApiResourceId(e.target.value || null)}>
                <option value="">— none (unconfigured) —</option>
                {apiResources.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
            <label className="se-field se-field-narrow">
              <span>Method</span>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHOD_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <label className="se-field">
            <span>Path template</span>
            <input value={pathTemplate} onChange={(e) => setPathTemplate(e.target.value)} placeholder="/api/search?q={token_url}" />
          </label>
          <label className="se-field">
            <span>Response unwrap (dotted/JSONPath; empty = whole body)</span>
            <input value={responseUnwrap} onChange={(e) => setResponseUnwrap(e.target.value)} placeholder="results.0" />
          </label>
          <p className="se-hint">
            Template vars: <code>{'{token}'}</code> <code>{'{token_url}'}</code> <code>{'{session_host}'}</code> <code>{'{session_host_ip}'}</code> <code>{'{session_name}'}</code>
          </p>
        </>
      )}

      {isApi && (
        <div className="se-field">
          <span>Test against a sample token — explore the response and click to pick fields</span>
          <div className="se-test-controls">
            <input
              value={sampleToken}
              placeholder="sample token (e.g. 8.8.8.8 or Gi0/1)"
              onChange={(e) => setSampleToken(e.target.value)}
            />
            <input
              value={sampleHost}
              placeholder="sample session host (optional)"
              onChange={(e) => setSampleHost(e.target.value)}
            />
            <button className="se-btn" disabled={testing || !sampleToken.trim()} onClick={() => void runTest()}>
              {testing ? 'Testing…' : 'Run Test'}
            </button>
          </div>
          {testError && <div className="se-test-error">{testError}</div>}
          {testResult && (
            <EnrichmentSourceExplorer
              result={testResult}
              responseUnwrap={responseUnwrap}
              setResponseUnwrap={setResponseUnwrap}
              fields={fields}
              setFields={setFields}
            />
          )}
        </div>
      )}

      <div className="se-field">
        <span>Picked fields (shown in the popup)</span>
        <div className="se-fields-editor">
          {fields.map((f, i) => (
            <div key={i} className="se-field-rowedit">
              <input className="se-fe-key" value={f.key} placeholder="key (e.g. device.name)" onChange={(e) => setField(i, { key: e.target.value })} />
              <input className="se-fe-label" value={f.label} placeholder="label" onChange={(e) => setField(i, { label: e.target.value })} />
              <select className="se-fe-format" value={f.format || 'string'} onChange={(e) => setField(i, { format: e.target.value })}>
                {FORMAT_OPTIONS.map((fmt) => <option key={fmt} value={fmt}>{fmt}</option>)}
              </select>
              <button className="se-btn se-btn-danger" onClick={() => setFields(fields.filter((_, idx) => idx !== i))}>×</button>
            </div>
          ))}
          <button className="se-btn" onClick={() => setFields([...fields, { key: '', label: '', format: 'string' }])}>+ Add field</button>
        </div>
      </div>

      {preview && preview.length > 0 && (
        <div className="se-field">
          <span>Live preview (resolved against the last test response)</span>
          <div className="se-preview">
            {preview.map((p, i) => (
              <div key={i} className="se-preview-row">
                <span className="se-preview-lbl">{p.label}</span>
                <span className="se-preview-val">{p.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="se-matcher-actions">
        <button className="se-btn se-btn-primary" disabled={saving || !name.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="se-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ── Action helpers ──────────────────────────────────────────────────────────

async function removeSource(id: string, after: () => Promise<void>, onError: (e: string) => void) {
  if (!window.confirm('Delete this source?')) return
  try { await deleteSource(id); await after() } catch (err) { onError(getErrorMessage(err)) }
}
