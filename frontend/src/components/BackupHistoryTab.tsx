import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import {
  listDeviceConfigs,
  getDeviceConfigVersion,
  pullDeviceConfig,
  diffConfigVersions,
  updateDeviceConfigNotes,
  type DeviceConfig,
  type DeviceConfigFull,
  type VersionDiffResponse,
} from '../api/configManagement'
import { copyToClipboard } from '../lib/clipboard'
import './BackupHistoryTab.css'
import { useMonacoOverlord } from '../hooks/useMonacoOverlord'
import { useEditorFontSettings } from '../hooks/useEditorFontSettings'
import MonacoOverlordWidget from './MonacoOverlordWidget'
import { useHostnameFormatter } from '../hooks/useHostnameFormatter'

import { getErrorMessage } from '../api/errors'
interface BackupHistoryTabProps {
  deviceId: string
  deviceName: string
  onAskAI?: (question: string, context: string) => void
}

interface BackupEntry {
  id: string
  version: number
  config_text: string | null
  config_format: string
  pulled_via: string
  config_hash: string
  created_at: string
  line_count: number
  size_bytes: number
  notes: string | null
}

interface SearchTimelineEntry {
  version: number
  date: string
  matchingLines: string[]
  present: boolean
}

/** CLI backups have config_format === 'cli'; everything else (json, xml,
 *  yaml, gnmi, …) is "structured". The Controller stores the concrete
 *  format string, so the Structured tab must match by exclusion, not by a
 *  literal 'structured' value. */
function isStructured(format: string): boolean {
  return format !== 'cli'
}

/** Map a backup's config_format to a Monaco language id for syntax
 *  highlighting. CLI configs use the custom 'netcli' grammar (Cisco/Junos). */
function backupLanguage(format: string): string {
  switch (format.toLowerCase()) {
    case 'json':
      return 'json'
    case 'xml':
    case 'netconf-xml':
      return 'xml'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'cli':
      return 'netcli'
    default:
      return 'plaintext'
  }
}

function toBackupEntry(dc: DeviceConfig): BackupEntry {
  return {
    id: dc.id,
    version: dc.version,
    config_text: null,
    config_format: dc.config_format,
    pulled_via: dc.pulled_via,
    config_hash: dc.config_hash,
    created_at: dc.created_at,
    line_count: 0,
    size_bytes: 0,
    notes: dc.notes ?? null,
  }
}

function toBackupEntryFull(dc: DeviceConfigFull): BackupEntry {
  return {
    id: dc.id,
    version: dc.version,
    config_text: dc.config_text,
    config_format: dc.config_format,
    pulled_via: dc.pulled_via,
    config_hash: dc.config_hash,
    created_at: dc.created_at,
    line_count: dc.config_text ? dc.config_text.split('\n').length : 0,
    size_bytes: dc.config_text ? new Blob([dc.config_text]).size : 0,
    notes: dc.notes ?? null,
  }
}

export default function BackupHistoryTab({ deviceId, deviceName, onAskAI }: BackupHistoryTabProps) {
  const formatName = useHostnameFormatter()
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filter
  const [filterTab, setFilterTab] = useState<'all' | 'cli' | 'structured'>('all')

  // Selection
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [selectedConfig, setSelectedConfig] = useState<BackupEntry | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)

  // Local (unsaved) edits to the config buffer — exploration only; persisting
  // config-text changes is future work (change control + push-to-device).
  const [configDraft, setConfigDraft] = useState('')
  const [draftDirty, setDraftDirty] = useState(false)
  // The "clean" buffer text — what we compare against to detect real user
  // edits. Updated on select and after auto-formatting (so pretty-printing a
  // structured backup doesn't read as an unsaved edit).
  const baselineRef = useRef('')

  // Notes (tribal knowledge) — metadata on the selected version.
  const [notesOpen, setNotesOpen] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesStatus, setNotesStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // Compare
  const [compareVersions, setCompareVersions] = useState<Set<number>>(new Set())
  const [diffResult, setDiffResult] = useState<VersionDiffResponse | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [viewMode, setViewMode] = useState<'config' | 'diff' | 'timeline'>('config')

  // Pull new
  const [collecting, setCollecting] = useState(false)
  const [collectMessage, setCollectMessage] = useState<string | null>(null)

  // Timeline search (cross-backup)
  const [timelineQuery, setTimelineQuery] = useState('')
  const [timelineResults, setTimelineResults] = useState<SearchTimelineEntry[]>([])
  const [loadingTimeline, setLoadingTimeline] = useState(false)

  // Copy
  const [copied, setCopied] = useState(false)

  // Monaco
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const overlord = useMonacoOverlord()
  const editorFont = useEditorFontSettings()
  // Latest values for use inside Monaco action callbacks (registered once).
  const selectedConfigRef = useRef<BackupEntry | null>(null)
  const onAskAIRef = useRef(onAskAI)
  useEffect(() => { selectedConfigRef.current = selectedConfig }, [selectedConfig])
  useEffect(() => { onAskAIRef.current = onAskAI }, [onAskAI])

  // All backup configs cache (for timeline search) — keyed by version
  const backupConfigsRef = useRef<Map<number, string>>(new Map())

  const fetchBackups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listDeviceConfigs(deviceId)
      const sorted = data
        .map(toBackupEntry)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      setBackups(sorted)
      if (sorted.length > 0 && selectedVersion === null) {
        handleSelectBackup(sorted[0])
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load backups'))
    } finally {
      setLoading(false)
    }
  }, [deviceId])

  useEffect(() => { fetchBackups() }, [fetchBackups])

  // Filtered backups based on filter tab
  const filteredBackups = useMemo(() => {
    if (filterTab === 'all') return backups
    if (filterTab === 'cli') return backups.filter(b => b.config_format === 'cli')
    return backups.filter(b => isStructured(b.config_format))
  }, [backups, filterTab])

  // Filter counts
  const filterCounts = useMemo(() => ({
    all: backups.length,
    cli: backups.filter(b => b.config_format === 'cli').length,
    structured: backups.filter(b => isStructured(b.config_format)).length,
  }), [backups])

  const handleSelectBackup = async (backup: BackupEntry) => {
    setSelectedVersion(backup.version)
    setViewMode('config')
    setDiffResult(null)
    setNotesStatus('idle')

    // If we have cached config text, use it
    const cached = backupConfigsRef.current.get(backup.version)
    if (cached) {
      const entry = {
        ...backup,
        config_text: cached,
        line_count: cached.split('\n').length,
        size_bytes: new Blob([cached]).size,
      }
      setSelectedConfig(entry)
      setConfigDraft(cached)
      baselineRef.current = cached
      setDraftDirty(false)
      setNotesDraft(backup.notes ?? '')
      return
    }

    setLoadingConfig(true)
    try {
      const full = await getDeviceConfigVersion(deviceId, backup.version)
      const entry = toBackupEntryFull(full)
      setSelectedConfig(entry)
      setConfigDraft(entry.config_text ?? '')
      baselineRef.current = entry.config_text ?? ''
      setDraftDirty(false)
      setNotesDraft(entry.notes ?? '')
      if (full.config_text) backupConfigsRef.current.set(backup.version, full.config_text)
    } catch {
      setSelectedConfig(null)
    } finally {
      setLoadingConfig(false)
    }
  }

  const handleToggleCompare = (version: number) => {
    setCompareVersions(prev => {
      const next = new Set(prev)
      if (next.has(version)) {
        next.delete(version)
      } else {
        if (next.size >= 2) {
          const first = next.values().next().value
          if (first !== undefined) next.delete(first)
        }
        next.add(version)
      }
      return next
    })
  }

  const handleCompare = async () => {
    const versions = Array.from(compareVersions)
    if (versions.length !== 2) return

    const b1 = backups.find(b => b.version === versions[0])
    const b2 = backups.find(b => b.version === versions[1])
    if (!b1 || !b2) return

    const [oldVersion, newVersion] = new Date(b1.created_at) < new Date(b2.created_at)
      ? [b1.version, b2.version] : [b2.version, b1.version]

    setLoadingDiff(true)
    setViewMode('diff')
    try {
      const result = await diffConfigVersions(deviceId, oldVersion, newVersion)
      setDiffResult(result)
    } catch (err) {
      setError(getErrorMessage(err, 'Diff failed'))
      setViewMode('config')
    } finally {
      setLoadingDiff(false)
    }
  }

  const handleCollect = async () => {
    setCollecting(true)
    setCollectMessage(null)
    setError(null)
    try {
      await pullDeviceConfig(deviceId)
      setCollectMessage('Config pulled successfully (CLI + Structured)')
      setTimeout(() => setCollectMessage(null), 3000)
      await fetchBackups()
    } catch (err) {
      const axiosMsg = (err as { response?: { data?: string } })?.response?.data
      setError(typeof axiosMsg === 'string' ? axiosMsg : (getErrorMessage(err, 'Collection failed')))
    } finally {
      setCollecting(false)
    }
  }

  // Timeline search: find a config element across all backups
  const handleTimelineSearch = async () => {
    if (!timelineQuery.trim()) return
    setLoadingTimeline(true)
    setViewMode('timeline')

    const q = timelineQuery.toLowerCase()
    const results: SearchTimelineEntry[] = []

    // Load all backup configs we don't have cached
    for (const backup of filteredBackups) {
      if (!backupConfigsRef.current.has(backup.version)) {
        try {
          const full = await getDeviceConfigVersion(deviceId, backup.version)
          if (full.config_text) backupConfigsRef.current.set(backup.version, full.config_text)
        } catch {
          // skip
        }
      }

      const config = backupConfigsRef.current.get(backup.version) || ''
      const matchingLines = config.split('\n').filter(line =>
        line.toLowerCase().includes(q)
      )

      results.push({
        version: backup.version,
        date: backup.created_at,
        matchingLines,
        present: matchingLines.length > 0,
      })
    }

    setTimelineResults(results)
    setLoadingTimeline(false)
  }

  const handleCopy = async () => {
    if (!configDraft) return
    if (await copyToClipboard(configDraft)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Notes save (enterprise / Controller only)
  const handleSaveNotes = async () => {
    if (selectedVersion === null) return
    setNotesStatus('saving')
    try {
      const trimmed = notesDraft.trim()
      const updated = await updateDeviceConfigNotes(deviceId, selectedVersion, trimmed || null)
      const newNotes = updated.notes ?? null
      setNotesStatus('saved')
      setSelectedConfig(prev => prev ? { ...prev, notes: newNotes } : prev)
      setBackups(prev => prev.map(b => b.version === selectedVersion ? { ...b, notes: newNotes } : b))
      setTimeout(() => setNotesStatus('idle'), 2000)
    } catch (err) {
      setNotesStatus('error')
      setError(getErrorMessage(err, 'Failed to save notes (notes require the Controller / enterprise mode)'))
    }
  }

  const askAIAboutSelection = useCallback((action: string, text: string) => {
    if (!onAskAIRef.current || !text.trim()) return
    const sel = selectedConfigRef.current
    const backupDate = sel ? new Date(sel.created_at).toLocaleString() : 'unknown'
    const notesLine = sel?.notes ? `\nOperator notes: ${sel.notes}` : ''

    let question = ''
    switch (action) {
      case 'when_changed':
        question = `When did this config change on device "${deviceName}" (${deviceId})? Search config backups for: ${text}`
        break
      case 'explain':
        question = `Explain this configuration from device "${deviceName}": ${text}`
        break
      case 'investigate':
        question = `Investigate this config element on device "${deviceName}" (${deviceId}). Was there a MOP? Check audit logs. Config element: ${text}`
        break
      case 'impact':
        question = `What is the impact of this configuration on device "${deviceName}"? What does it do and what depends on it? Config: ${text}`
        break
      default:
        question = `About device "${deviceName}" config (backup from ${backupDate}): ${text}`
    }

    onAskAIRef.current(
      question,
      `Device: ${deviceName}\nDevice ID: ${deviceId}\nBackup: ${backupDate}${notesLine}\nSelected config:\n${text}`
    )
  }, [deviceName, deviceId])

  // Register Monaco editor: overlord (Cmd+I) + right-click AI actions.
  const handleEditorMount = useCallback((ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    overlord.register(ed)

    const selectionText = () => {
      const sel = ed.getSelection()
      const model = ed.getModel()
      if (!sel || !model) return ''
      const text = model.getValueInRange(sel)
      return text.trim() ? text : model.getLineContent(sel.startLineNumber)
    }

    const aiActions: Array<{ id: string; label: string; action: string }> = [
      { id: 'netstacks-ai-when', label: 'AI: When did this change?', action: 'when_changed' },
      { id: 'netstacks-ai-investigate', label: 'AI: Investigate change (MOP, audit)', action: 'investigate' },
      { id: 'netstacks-ai-explain', label: 'AI: Explain this config', action: 'explain' },
      { id: 'netstacks-ai-impact', label: 'AI: Impact analysis', action: 'impact' },
    ]
    for (const a of aiActions) {
      ed.addAction({
        id: a.id,
        label: a.label,
        contextMenuGroupId: 'netstacks-ai',
        contextMenuOrder: 1,
        run: () => askAIAboutSelection(a.action, selectionText()),
      })
    }
  }, [overlord, askAIAboutSelection])

  // Pretty-print structured (JSON/XML) backups once loaded so single-line
  // blobs become readable. CLI/plaintext are left as-is.
  useEffect(() => {
    if (!editorRef.current || loadingConfig) return
    const lang = selectedConfig ? backupLanguage(selectedConfig.config_format) : 'plaintext'
    if (lang !== 'json' && lang !== 'xml') return
    const ed = editorRef.current
    const t = setTimeout(async () => {
      await ed.getAction('editor.action.formatDocument')?.run()
      // Treat the pretty-printed result as the clean baseline, not a user edit.
      const v = ed.getValue()
      baselineRef.current = v
      setConfigDraft(v)
      setDraftDirty(false)
    }, 120)
    return () => clearTimeout(t)
  }, [selectedConfig, loadingConfig])

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
  }

  const formatDateShort = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const highlightText = (text: string, query: string) => {
    if (!query) return text
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.substring(0, idx)}
        <mark className="config-search-match">{text.substring(idx, idx + query.length)}</mark>
        {text.substring(idx + query.length)}
      </>
    )
  }

  if (loading && backups.length === 0) {
    return <div className="backup-history-tab"><div className="backup-loading">Loading config backups...</div></div>
  }

  const editorLanguage = selectedConfig ? backupLanguage(selectedConfig.config_format) : 'plaintext'

  return (
    <div className="backup-history-tab">
      {/* Left sidebar */}
      <div className="backup-sidebar">
        <div className="backup-sidebar-header">
          <div className="backup-sidebar-title">
            <span>Config Backups</span>
            <span className="backup-count">{filteredBackups.length}</span>
          </div>
          <div className="backup-sidebar-actions">
            <button
              className="backup-btn backup-btn-collect"
              onClick={handleCollect}
              disabled={collecting}
              title="Pull running config from device (CLI + Structured)"
            >
              {collecting ? 'Pulling...' : 'Pull New'}
            </button>
            {compareVersions.size === 2 && (
              <button className="backup-btn backup-btn-compare" onClick={handleCompare} disabled={loadingDiff}>
                Compare
              </button>
            )}
            <button className="backup-btn backup-btn-refresh" onClick={fetchBackups} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="backup-filter-tabs">
          <button
            className={`backup-filter-tab ${filterTab === 'all' ? 'active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            All <span className="backup-filter-count">({filterCounts.all})</span>
          </button>
          <button
            className={`backup-filter-tab ${filterTab === 'cli' ? 'active' : ''}`}
            onClick={() => setFilterTab('cli')}
          >
            CLI <span className="backup-filter-count">({filterCounts.cli})</span>
          </button>
          <button
            className={`backup-filter-tab ${filterTab === 'structured' ? 'active' : ''}`}
            onClick={() => setFilterTab('structured')}
          >
            Structured <span className="backup-filter-count">({filterCounts.structured})</span>
          </button>
        </div>

        {/* Timeline search — search across ALL backups */}
        <div className="backup-timeline-search">
          <input
            type="text"
            className="backup-timeline-input"
            placeholder="Track config element across backups..."
            value={timelineQuery}
            onChange={(e) => setTimelineQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTimelineSearch() }}
          />
          <button
            className="backup-btn"
            onClick={handleTimelineSearch}
            disabled={loadingTimeline || !timelineQuery.trim()}
            title="Find when this config was added, changed, or removed"
          >
            Track
          </button>
        </div>

        {collectMessage && <div className="backup-collect-success">{collectMessage}</div>}
        {error && <div className="backup-collect-error">{error}</div>}

        <div className="backup-list">
          {filteredBackups.length === 0 ? (
            <div className="backup-empty">
              <div>No config backups yet</div>
              <div className="backup-empty-hint">Click "Pull New" to collect a live config from {deviceName}</div>
            </div>
          ) : (
            filteredBackups.map((backup, idx) => {
              // Timeline indicator
              const timelineEntry = timelineResults.find(t => t.version === backup.version)
              return (
                <div
                  key={backup.id}
                  className={`backup-list-item ${selectedVersion === backup.version ? 'selected' : ''} ${timelineEntry && !timelineEntry.present ? 'backup-item-absent' : ''}`}
                  onClick={() => handleSelectBackup(backup)}
                >
                  <div className="backup-item-check">
                    <input
                      type="checkbox"
                      checked={compareVersions.has(backup.version)}
                      onChange={(e) => { e.stopPropagation(); handleToggleCompare(backup.version) }}
                    />
                  </div>
                  <div className="backup-item-info">
                    <div className="backup-item-date">
                      {formatDate(backup.created_at)}
                      {idx === 0 && <span className="backup-badge-latest">Latest</span>}
                      <span className="backup-badge-format">{backup.config_format}</span>
                      {backup.notes && (
                        <span className="backup-badge-note" title={backup.notes}>📝 note</span>
                      )}
                      {timelineEntry && (
                        <span className={`backup-badge-timeline ${timelineEntry.present ? 'present' : 'absent'}`}>
                          {timelineEntry.present ? `${timelineEntry.matchingLines.length} hits` : 'not found'}
                        </span>
                      )}
                    </div>
                    <div className="backup-item-meta">
                      {backup.line_count > 0 && <span>{backup.line_count} lines</span>}
                      {backup.size_bytes > 0 && <span>{formatSize(backup.size_bytes)}</span>}
                      <span>{backup.pulled_via || 'manual'}</span>
                      <span>v{backup.version}</span>
                    </div>
                    <div className="backup-item-hash" title={backup.config_hash}>
                      {backup.config_hash?.substring(0, 12)}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {compareVersions.size > 0 && (
          <div className="backup-sidebar-footer">
            {compareVersions.size}/2 selected for compare
          </div>
        )}
      </div>

      {/* Right content */}
      <div className="backup-content">
        {/* Timeline view */}
        {viewMode === 'timeline' && timelineResults.length > 0 ? (
          <>
            <div className="backup-content-header">
              <div className="backup-content-title">
                Config Timeline: "{timelineQuery}"
              </div>
              <div className="backup-content-meta">
                <span>{timelineResults.filter(t => t.present).length}/{timelineResults.length} backups contain this</span>
              </div>
              <button className="backup-btn" onClick={() => setViewMode('config')}>
                Close Timeline
              </button>
            </div>
            <div className="backup-timeline-view">
              {timelineResults.map((entry, idx) => {
                const prevEntry = idx < timelineResults.length - 1 ? timelineResults[idx + 1] : null
                const changed = prevEntry && prevEntry.present !== entry.present
                const added = changed && entry.present
                const removed = changed && !entry.present

                return (
                  <div key={entry.version} className={`timeline-entry ${entry.present ? 'timeline-present' : 'timeline-absent'} ${changed ? 'timeline-changed' : ''}`}>
                    <div className="timeline-dot-col">
                      <div className={`timeline-dot ${entry.present ? 'dot-present' : 'dot-absent'} ${changed ? 'dot-changed' : ''}`} />
                      {idx < timelineResults.length - 1 && <div className="timeline-line" />}
                    </div>
                    <div className="timeline-content">
                      <div className="timeline-header">
                        <span className="timeline-date">{formatDateShort(entry.date)}</span>
                        {added && <span className="timeline-badge timeline-badge-added">ADDED</span>}
                        {removed && <span className="timeline-badge timeline-badge-removed">REMOVED</span>}
                        {idx === 0 && <span className="backup-badge-latest">Latest</span>}
                      </div>
                      {entry.present && entry.matchingLines.length > 0 && (
                        <div className="timeline-lines">
                          {entry.matchingLines.slice(0, 5).map((line, li) => (
                            <div key={li} className="timeline-line-text">
                              {highlightText(line.trim(), timelineQuery)}
                            </div>
                          ))}
                          {entry.matchingLines.length > 5 && (
                            <div className="timeline-line-more">
                              +{entry.matchingLines.length - 5} more lines
                            </div>
                          )}
                        </div>
                      )}
                      {!entry.present && (
                        <div className="timeline-not-found">Not present in this backup</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : viewMode === 'diff' && diffResult ? (
          <>
            <div className="backup-content-header">
              <div className="backup-content-title">Config Diff</div>
              <div className="backup-diff-stats">
                <span className="diff-stat-add">+{diffResult.additions ?? 0}</span>
                <span className="diff-stat-del">-{diffResult.deletions ?? 0}</span>
              </div>
              <button className="backup-btn" onClick={() => setViewMode('config')}>
                Close Diff
              </button>
            </div>
            <div className="backup-diff-view">
              {loadingDiff ? (
                <div className="backup-loading">Generating diff...</div>
              ) : diffResult.diff ? (
                <pre className="backup-diff-text">
                  {diffResult.diff.split('\n').map((line, i) => {
                    let cls = 'diff-line'
                    if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-add'
                    else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-del'
                    else if (line.startsWith('@@')) cls += ' diff-hunk'
                    return <div key={i} className={cls}>{line}</div>
                  })}
                </pre>
              ) : (
                <div className="backup-loading">No differences — configs are identical</div>
              )}
            </div>
          </>
        ) : selectedConfig ? (
          <>
            <div className="backup-content-header">
              <div className="backup-content-title">
                {formatName(deviceName)} — {formatDate(selectedConfig.created_at)}
                {draftDirty && <span className="backup-draft-badge" title="Local edits are not saved — config-text changes are a future change-control feature">Local draft — not saved</span>}
              </div>
              <div className="backup-content-meta">
                <span>{selectedConfig.line_count} lines</span>
                <span>{formatSize(selectedConfig.size_bytes)}</span>
                <span className="backup-lang-badge">{editorLanguage}</span>
              </div>
              <div className="backup-content-actions">
                <button
                  className={`backup-btn ${notesOpen ? 'backup-btn-active' : ''}`}
                  onClick={() => setNotesOpen(v => !v)}
                  title="Operator notes for this backup (tribal knowledge, AI-readable)"
                >
                  {selectedConfig.notes ? 'Notes •' : 'Notes'}
                </button>
                <button
                  className="backup-btn"
                  onClick={() => editorRef.current?.getAction('actions.find')?.run()}
                  title="Search config (Ctrl+F)"
                >
                  Search
                </button>
                <button className="backup-btn" onClick={handleCopy}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>

            {notesOpen && (
              <div className="backup-notes-panel">
                <div className="backup-notes-header">
                  <span>Operator notes — v{selectedConfig.version} (metadata, not part of the config)</span>
                  <div className="backup-notes-actions">
                    {notesStatus === 'saving' && <span className="status-saving">Saving...</span>}
                    {notesStatus === 'saved' && <span className="status-saved">Saved</span>}
                    {notesStatus === 'error' && <span className="status-unsaved">Save failed</span>}
                    <button className="backup-btn" onClick={handleSaveNotes} disabled={notesStatus === 'saving'}>
                      Save Notes
                    </button>
                  </div>
                </div>
                <textarea
                  className="backup-notes-textarea"
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  placeholder="e.g. Pre-maintenance baseline before BGP change (CHG-1234). Known-good config."
                  rows={4}
                />
              </div>
            )}

            <div className="backup-config-view">
              {loadingConfig ? (
                <div className="backup-loading">Loading config...</div>
              ) : (
                <Editor
                  height="100%"
                  language={editorLanguage}
                  path={`backup://${deviceId}/v${selectedConfig.version}`}
                  value={configDraft}
                  onChange={(v) => { setConfigDraft(v ?? ''); setDraftDirty((v ?? '') !== baselineRef.current) }}
                  onMount={handleEditorMount}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: true },
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    folding: true,
                    readOnly: false,
                    // fontSize / fontFamily honor Settings → Appearance.
                    ...editorFont,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    padding: { top: 12, bottom: 12 },
                  }}
                />
              )}
            </div>

            {/* Cmd+I Overlord Widget */}
            {overlord.isOpen && overlord.widgetPosition && (
              <MonacoOverlordWidget
                position={overlord.widgetPosition}
                onSubmit={overlord.handleSubmit}
                onCancel={overlord.close}
                loading={overlord.loading}
                error={overlord.error}
              />
            )}
            {overlord.hasPendingEdit && (
              <div className="overlord-accept-bar">
                <span>AI edit applied — review the highlighted changes</span>
                <button className="overlord-accept-btn" onClick={overlord.accept}>Accept</button>
                <button className="overlord-reject-btn" onClick={overlord.reject}>Reject</button>
              </div>
            )}
          </>
        ) : (
          <div className="backup-content-empty">
            {backups.length === 0
              ? `Click "Pull New" to collect a live config from ${deviceName}`
              : 'Select a backup to view its configuration'}
          </div>
        )}
      </div>
    </div>
  )
}
