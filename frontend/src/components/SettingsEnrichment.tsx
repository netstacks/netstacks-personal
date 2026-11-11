import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import SettingsItem from './settings/SettingsItem'
import Switch from './Switch'
import AITabInput from './AITabInput'
import { confirmDialog } from './ConfirmDialog'
import './SettingsEnrichment.css'

import DialogFooter from './DialogFooter'
import Tooltip from './Tooltip'
const FORMAT_OPTIONS = ['string', 'datetime', 'uptime', 'bytes', 'status_pill']
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'DELETE']
const HOVER_DELAY_OPTIONS = [0, 250, 500, 750, 1000, 1500]

type EnrichmentConfig = [EnrichmentMatcher[], EnrichmentSource[], ApiResource[]]

function fetchEnrichmentConfig(): Promise<EnrichmentConfig> {
  return Promise.all([
    listMatchers(),
    listSources(),
    listApiResources().catch(() => [] as ApiResource[]),
  ])
}

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

  const disabledSources = useMemo(
    () => settings['terminal.enrichment.disabledSources'] ?? [],
    [settings],
  )

  const applyConfig = useCallback(([m, s, r]: EnrichmentConfig) => {
    setMatchers(m)
    setSources(s)
    setApiResources(r)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      applyConfig(await fetchEnrichmentConfig())
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [applyConfig])

  // Initial state is already loading / no error, so the mount fetch only sets
  // state from its callbacks.
  useEffect(() => {
    fetchEnrichmentConfig()
      .then(applyConfig)
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false))
  }, [applyConfig])

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

  // Ask-AI prompts start from what's on screen.
  const unconfiguredSources = sources.filter((s) => s.kind === 'api_resource' && !s.api_resource_id).map((s) => s.name)
  const matchersHelpPrompt =
    `Help me with enrichment token matchers in NetStacks. I have ${matchers.length} matcher(s)`
    + (matchers.length ? ` (${matchers.map((m) => m.name).join(', ')})` : '')
    + '. Explain what a matcher is (the token type it recognises, e.g. IP, MAC, interface), how it decides which sources run on a highlighted token, and help me add or tune one. Use the NetStacks docs if useful.'
  const sourcesHelpPrompt =
    `Help me with enrichment sources in NetStacks. I have ${sources.length} source(s)`
    + (sources.length ? ` (${sources.map((s) => `${s.name}: ${s.kind}`).join(', ')})` : '')
    + (unconfiguredSources.length ? `, and ${unconfiguredSources.join(', ')} ${unconfiguredSources.length === 1 ? 'has' : 'have'} no API Resource bound` : '')
    + '. Explain builtin vs api_resource sources, how a path_template, response unwrap and picked fields work, and walk me through binding an API Resource (list_api_resources shows what I have; propose_api_resource can open the form).'

  return (
    <>
      <SettingsSection
        title="Hover Enrichment"
        description="Hover an IP, MAC, or interface in any terminal to see live context (reverse-DNS, OUI vendor, NetBox / crawler data). Matchers decide which tokens are recognized; sources decide what data is fetched."
      >
        <div className="settings-group">
          <SettingRow label="Enable hover enrichment">
            <Switch
              checked={settings['terminal.enrichment.hoverEnabled'] !== false}
              onChange={(v) => updateSetting('terminal.enrichment.hoverEnabled', v)}
              label="Enable hover enrichment"
            />
          </SettingRow>
          <SettingRow
            label="Hover delay"
            description="How long the pointer rests on a token before the popover opens, so double-click / drag-select isn't interrupted. Tap Ctrl or ⌘ to dismiss any hover; a closed token stays quiet for 30 s."
          >
            <select
              aria-label="Hover delay"
              className="ns-select"
              value={settings['terminal.enrichment.hoverDelayMs'] ?? 500}
              onChange={(e) => updateSetting('terminal.enrichment.hoverDelayMs', Number(e.target.value))}
            >
              {HOVER_DELAY_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>{ms === 0 ? 'Instant' : `${ms} ms`}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label="Show AI Digest button (✦)" description="Summarizes enrichment data with AI.">
            <Switch
              checked={settings['terminal.enrichment.aiDigestEnabled'] === true}
              onChange={(v) => updateSetting('terminal.enrichment.aiDigestEnabled', v)}
              label="Show AI Digest button"
            />
          </SettingRow>
        </div>
        {settings['terminal.hoverLookups'] === false && (
          <p className="form-hint">“Show hover info” is off in General settings — that master switch also gates enrichment.</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Backup"
        description="Export all matchers and sources to a TOML file, or import from one. Import adds new rows by name."
        actions={
          <>
            <button className="ns-btn ns-btn--small" onClick={() => void handleExport()}>Export TOML</button>
            <button className="ns-btn ns-btn--small" onClick={() => importInputRef.current?.click()}>Import TOML…</button>
            <input
              ref={importInputRef}
              type="file"
              accept=".toml,text/plain"
              aria-label="TOML file to import"
              className="se-file-input"
              onChange={(e) => void handleImportFile(e)}
            />
          </>
        }
      >
        <div className="settings-group">
          <SettingRow label="Overwrite existing rows on import" description="Replace matchers and sources that have the same name.">
            <Switch checked={importOverwrite} onChange={setImportOverwrite} label="Overwrite existing rows on import" />
          </SettingRow>
        </div>
        {importResult && (
          <p className="settings-success">
            Imported: {importResult.matchers_added} matcher(s) added, {importResult.matchers_updated} updated;{' '}
            {importResult.sources_added} source(s) added, {importResult.sources_updated} updated;{' '}
            {importResult.assignments_updated} assignment(s) updated.
          </p>
        )}
      </SettingsSection>

      {error && <p className="settings-error">{error}</p>}
      {loading ? (
        <p className="form-hint">Loading…</p>
      ) : (
        <>
          <SettingsSection
            title="Matchers"
            description="Token types recognized in terminal output, and the sources each one queries."
            help={{ topic: 'token matchers', prompt: matchersHelpPrompt }}
            actions={
              <button className="ns-btn ns-btn--small" onClick={() => setCreatingMatcher((v) => !v)}>
                {creatingMatcher ? 'Cancel' : '+ Add matcher'}
              </button>
            }
          >
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
            {matchers.length === 0 ? (
              <p className="form-hint">No matchers yet.</p>
            ) : (
              <div className="settings-group">
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
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title="Sources"
            description="Where hover data comes from: built-in lookups or any API Resource."
            help={{ topic: 'enrichment sources', prompt: sourcesHelpPrompt }}
            actions={
              <button className="ns-btn ns-btn--small" onClick={() => setCreatingSource((v) => !v)}>
                {creatingSource ? 'Cancel' : '+ Add source'}
              </button>
            }
          >
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
            {sources.length === 0 ? (
              <p className="form-hint">No sources yet.</p>
            ) : (
              <div className="settings-group">
                {sources.map((s) => (
                  <SettingsItem
                    key={s.id}
                    leading={
                      <Tooltip label="Enable / disable this source for hover lookups"><input
                        type="checkbox"
                        checked={!disabledSources.includes(s.name)}
                        onChange={(e) => toggleSourceDisabled(s.name, !e.target.checked)}
                        aria-label={`Use ${s.name} for hover lookups`}
                      /></Tooltip>
                    }
                    title={s.name}
                    badges={
                      <>
                        <span className={s.kind === 'builtin' ? 'settings-badge settings-badge--accent' : 'settings-badge'}>{s.kind}</span>
                        {s.is_builtin && <span className="settings-badge">built-in</span>}
                      </>
                    }
                    meta={
                      s.kind === 'api_resource'
                        ? (s.api_resource_id
                          ? <><span>{apiResourceName(s.api_resource_id)}</span><code>{s.path_template}</code></>
                          : <span className="se-unconfigured">Unconfigured — no API resource bound</span>)
                        : <span>{s.picked_fields.length} field{s.picked_fields.length === 1 ? '' : 's'}</span>
                    }
                    actions={
                      <>
                        {s.kind !== 'builtin' && (
                          <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => setEditingSource(editingSource === s.id ? null : s.id)}>
                            {editingSource === s.id ? 'Close' : 'Edit'}
                          </button>
                        )}
                        {!s.is_builtin && (
                          <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => void removeSource(s.id, afterMutation, setError)}>
                            Delete
                          </button>
                        )}
                      </>
                    }
                  >
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
                  </SettingsItem>
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      )}
    </>
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
    <SettingsItem
      title={matcher.name}
      badges={matcher.is_builtin && <span className="settings-badge">built-in</span>}
      meta={
        <span>
          {matcher.source_ids.length} source{matcher.source_ids.length === 1 ? '' : 's'}
          {matcher.cli_flavors.length > 0 && ` · ${matcher.cli_flavors.join(', ')}`}
        </span>
      }
      actions={<span className="settings-badge">p{matcher.priority}</span>}
      onActivate={onToggle}
    >
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
    </SettingsItem>
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

  const fid = initial?.id ?? 'new'
  return (
    <div className="settings-form">
      <div className="settings-form-row">
        <div className="form-group">
          <label htmlFor={`matcher-name-${fid}`}>Name</label>
          <AITabInput id={`matcher-name-${fid}`} value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} placeholder="e.g. vlan_id" aiField="token matcher name" aiPlaceholder="snake_case name for the token type this matcher recognizes" aiContext={{ patterns, cli_flavors: flavors, description }} onAIValue={setName} />
        </div>
        <div className="form-group form-group--narrow">
          <label htmlFor={`matcher-priority-${fid}`}>Priority</label>
          <input id={`matcher-priority-${fid}`} className="ns-input" data-ai-fill="off" value={priority} disabled={readOnly} onChange={(e) => setPriority(e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor={`matcher-description-${fid}`}>Description</label>
        <AITabInput id={`matcher-description-${fid}`} value={description}
          disabled={readOnly}
          onChange={(e) => setDescription(e.target.value)}
          onAIValue={(v) => setDescription(v)}
          aiField="matcher_description"
          aiPlaceholder="Description of this token matcher"
          aiContext={{ name, patterns, cli_flavors: flavors }}
        />
      </div>
      <div className="form-group">
        <label htmlFor={`matcher-patterns-${fid}`}>Patterns (one regex per line)</label>
        <AITabInput as="textarea" id={`matcher-patterns-${fid}`} className="settings-code se-patterns" value={patterns} disabled={readOnly} onChange={(e) => setPatterns(e.target.value)} rows={Math.max(2, patternList.length)} aiField="token regex patterns" aiPlaceholder="One Rust-syntax regex per line matching this token type in network device output" aiContext={{ name, description, cli_flavors: flavors }} onAIValue={setPatterns} />
      </div>
      <div className="form-group">
        <label htmlFor={`matcher-flavors-${fid}`}>CLI flavors (comma-separated; empty = all flavors)</label>
        <AITabInput id={`matcher-flavors-${fid}`} value={flavors} disabled={readOnly} onChange={(e) => setFlavors(e.target.value)} placeholder="cisco-ios, juniper" aiField="CLI flavors" aiPlaceholder="Comma-separated NetStacks CLI flavors this matcher applies to (linux, cisco-ios, cisco-ios-xr, cisco-nxos, juniper, arista, paloalto, fortinet)" aiContext={{ name, patterns }} onAIValue={setFlavors} />
      </div>

      <div className="form-group">
        <span className="se-label">Assigned sources</span>
        <div className="se-source-grid">
          {sources.map((s) => (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={assigned.includes(s.id)}
                onChange={(e) => setAssigned(e.target.checked ? [...assigned, s.id] : assigned.filter((id) => id !== s.id))}
              />
              {sourceName(s.id)}
            </label>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label htmlFor={`matcher-test-${fid}`}>Test against sample text</label>
        <div className="se-inline-row">
          <AITabInput id={`matcher-test-${fid}`} className="settings-code" value={testText} placeholder="e.g. interface Gi0/1 is up, mac aabb.ccdd.eeff" onChange={(e) => setTestText(e.target.value)} aiField="sample device output" aiPlaceholder="One realistic line of network device output that these patterns should match" aiContext={{ name, patterns, cli_flavors: flavors }} onAIValue={setTestText} />
          <button className="ns-btn" onClick={() => void runTest()}>Test</button>
        </div>
        {testResult && <p className="form-hint">{totalMatches} match{totalMatches === 1 ? '' : 'es'}</p>}
        {testResult && testResult.map((r, ri) => (
          <div key={ri} className="se-match-row">
            {r.error ? (
              <span className="settings-error">{r.pattern}: {r.error}</span>
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

      <DialogFooter
        primary={{ label: saving ? 'Saving…' : 'Save', onClick: () => void save(), disabled: saving || !name.trim() || patternList.length === 0 }}
        onCancel={onCancel}
        leading={onDelete && <button className="ns-btn ns-btn--ghost ns-btn--danger" onClick={() => void onDelete()}>Delete</button>}
        inline
      />
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

  const fid = initial?.id ?? 'new'
  return (
    <div className="settings-form">
      <div className="settings-form-row">
        <div className="form-group">
          <label htmlFor={`source-name-${fid}`}>Name{initial?.is_builtin ? ' (built-in — immutable)' : ''}</label>
          <AITabInput id={`source-name-${fid}`} value={name} disabled={initial?.is_builtin} onChange={(e) => setName(e.target.value)} placeholder="e.g. my_cmdb" aiField="enrichment source name" aiPlaceholder="snake_case name for this hover-enrichment data source" aiContext={{ kind, path_template: pathTemplate }} onAIValue={setName} />
        </div>
        <div className="form-group se-narrow-select">
          <label htmlFor={`source-kind-${fid}`}>Kind</label>
          <select id={`source-kind-${fid}`} className="ns-select" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!initial}>
            <option value="api_resource">api_resource</option>
            <option value="builtin">builtin</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label htmlFor={`source-description-${fid}`}>Description</label>
        <AITabInput id={`source-description-${fid}`} value={description}
          onChange={(e) => setDescription(e.target.value)}
          onAIValue={(v) => setDescription(v)}
          aiField="source_description"
          aiPlaceholder="Description of this enrichment source"
          aiContext={{ name, api_resource: apiResourceId, path_template: pathTemplate }}
        />
      </div>

      {isApi && (
        <>
          <div className="settings-form-row">
            <div className="form-group">
              <label htmlFor={`source-resource-${fid}`}>API resource</label>
              <select id={`source-resource-${fid}`} className="ns-select" value={apiResourceId ?? ''} onChange={(e) => setApiResourceId(e.target.value || null)}>
                <option value="">— none (unconfigured) —</option>
                {apiResources.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group se-narrow-select">
              <label htmlFor={`source-method-${fid}`}>Method</label>
              <select id={`source-method-${fid}`} className="ns-select" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHOD_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor={`source-path-${fid}`}>Path template</label>
            <AITabInput id={`source-path-${fid}`} className="settings-code" value={pathTemplate} onChange={(e) => setPathTemplate(e.target.value)} placeholder="/api/search?q={token_url}" aiField="API path template" aiPlaceholder="Request path on the bound API Resource with {token_url} where the hovered token goes" aiContext={{ name, api_resource: apiResourceId }} onAIValue={setPathTemplate} />
          </div>
          <div className="form-group">
            <label htmlFor={`source-unwrap-${fid}`}>Response unwrap (dotted/JSONPath; empty = whole body)</label>
            <AITabInput id={`source-unwrap-${fid}`} className="settings-code" value={responseUnwrap} onChange={(e) => setResponseUnwrap(e.target.value)} placeholder="results.0" aiField="response unwrap path" aiPlaceholder="Dot path to the object inside the API response that holds the fields to show" aiContext={{ name, path_template: pathTemplate }} onAIValue={setResponseUnwrap} />
            <p className="form-hint">
              Template vars: <code>{'{token}'}</code> <code>{'{token_url}'}</code> <code>{'{session_host}'}</code> <code>{'{session_host_ip}'}</code> <code>{'{session_name}'}</code>
            </p>
          </div>

          <div className="se-test-box">
            <span className="se-label">Test source (draft)</span>
            <p className="form-hint">
              Runs the path template above as-is — no need to save first. Click a leaf in
              the response to pick it as a field, or a container's “↳ unwrap” chip to set
              the unwrap path. Works for built-in sources too.
            </p>
            <div className="se-inline-row">
              <AITabInput className="settings-code"
                aria-label="Sample token"
                value={sampleToken}
                placeholder="sample token (e.g. 8.8.8.8 or Gi0/1)"
                onChange={(e) => setSampleToken(e.target.value)}
                aiField="sample token"
                aiPlaceholder="A realistic token (IP, MAC, interface or hostname) to test this source with"
                aiContext={{ name, path_template: pathTemplate }}
                onAIValue={setSampleToken}
              />
              <input className="ns-input" data-ai-fill="off"
                aria-label="Sample session host"
                value={sampleHost}
                placeholder="sample session host (optional)"
                onChange={(e) => setSampleHost(e.target.value)}
              />
              <button
                className="ns-btn"
                /* Only require a sample token when the path actually uses one.
                   Session-host-based sources ({session_host}) can run without a
                   token — otherwise the tester is stuck for those sources. */
                disabled={testing || (/\{token(_url)?\}/.test(pathTemplate) && !sampleToken.trim())}
                onClick={() => void runTest()}
              >
                {testing ? 'Testing…' : 'Run Test'}
              </button>
            </div>
            {testError && <p className="settings-error">{testError}</p>}
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
        </>
      )}

      <div className="form-group">
        <span className="se-label">Picked fields (shown in the popup)</span>
        <div className="se-fields-editor">
          {fields.map((f, i) => (
            <div key={i} className="se-inline-row">
              <AITabInput className="settings-code se-fe-key" aria-label="Field key" value={f.key} placeholder="key (e.g. device.name)" onChange={(e) => setField(i, { key: e.target.value })} aiField="response field key" aiPlaceholder="Dot path of a field in the unwrapped response to show on hover" aiContext={{ name, unwrap: responseUnwrap, label: f.label }} onAIValue={(v) => setField(i, { key: v })} />
              <AITabInput className="se-fe-label" aria-label="Field label" value={f.label} placeholder="label" onChange={(e) => setField(i, { label: e.target.value })} aiField="field label" aiPlaceholder="Short human label for this hover field" aiContext={{ key: f.key }} onAIValue={(v) => setField(i, { label: v })} />
              <select aria-label="Format" className="ns-select se-fe-format" value={f.format || 'string'} onChange={(e) => setField(i, { format: e.target.value })}>
                {FORMAT_OPTIONS.map((fmt) => <option key={fmt} value={fmt}>{fmt}</option>)}
              </select>
              <button className="ns-btn ns-btn--ghost ns-btn--danger ns-icon-btn" onClick={() => setFields(fields.filter((_, idx) => idx !== i))} aria-label="Remove field">×</button>
            </div>
          ))}
          <div>
            <button className="ns-btn ns-btn--small" onClick={() => setFields([...fields, { key: '', label: '', format: 'string' }])}>+ Add field</button>
          </div>
        </div>
      </div>

      {preview && preview.length > 0 && (
        <div className="form-group">
          <span className="se-label">Live preview (resolved against the last test response)</span>
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

      <DialogFooter
        primary={{ label: saving ? 'Saving…' : 'Save', onClick: () => void save(), disabled: saving || !name.trim() }}
        onCancel={onCancel}
        inline
      />
    </div>
  )
}

// ── Action helpers ──────────────────────────────────────────────────────────

async function removeSource(id: string, after: () => Promise<void>, onError: (e: string) => void) {
  if (!(await confirmDialog({ title: 'Delete this source?', confirmLabel: 'Delete', destructive: true }))) return
  try { await deleteSource(id); await after() } catch (err) { onError(getErrorMessage(err)) }
}
