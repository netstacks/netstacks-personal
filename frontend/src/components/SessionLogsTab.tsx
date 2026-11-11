// Session Logs library — list / view / delete terminal session logs.
//
// Session logs were a "data graveyard" per the CRUD audit: terminals
// expose Start Log / Stop Log actions that save the buffered output as
// a Document with parent_folder='logs', but nothing surfaced them back
// to the user. The Documents panel did show them under the Logs folder,
// but a settings-tab listing matches the pattern of RecordingsTab and
// LayoutsTab and gives a focused list+view+delete UI.

import { useCallback, useEffect, useState } from 'react'
import {
  listDocuments,
  getDocument,
  deleteDocument,
  type Document,
} from '../api/docs'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { useSubmitting } from '../hooks/useSubmitting'
import { downloadFile } from '../lib/formatters'
import './RecordingsTab.css'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
import SearchField from './SearchField'

import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip'
import ModalFrame from './ModalFrame'
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (cleaned || 'log').slice(0, 80)
}

function approxLineCount(content: string | null): number {
  if (!content) return 0
  // Cheap line count — exact value isn't needed, we just want a "small
  // / medium / huge" hint so users can pick the log they want.
  let lines = 0
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++
  return lines + (content.length > 0 ? 1 : 0)
}

export default function SessionLogsTab() {
  const [logs, setLogs] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [viewingContent, setViewingContent] = useState<string>('')
  const [viewingName, setViewingName] = useState<string>('')
  const [viewingLoading, setViewingLoading] = useState(false)
  const { submitting, run } = useSubmitting()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Session logs land under the 'logs' parent folder. List call
      // returns metadata only (no content) per backend convention.
      const data = await listDocuments(undefined, 'logs')
      data.sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
      setLogs(data)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load session logs'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openViewer = async (doc: Document) => {
    setViewingId(doc.id)
    setViewingName(doc.name)
    setViewingContent('')
    setViewingLoading(true)
    try {
      // listDocuments returns metadata; fetch the body separately.
      const full = await getDocument(doc.id)
      setViewingContent(full.content || '(empty log)')
    } catch (err) {
      setViewingContent(`Failed to load log content: ${getErrorMessage(err, 'unknown error')}`)
    } finally {
      setViewingLoading(false)
    }
  }

  const closeViewer = useCallback(() => {
    setViewingId(null)
    setViewingContent('')
    setViewingName('')
  }, [])


  const handleDelete = async (doc: Document) => {
    const ok = await confirmDialog({
      title: 'Delete session log?',
      body: (
        <>
          Permanently delete <strong>{doc.name}</strong>? The log document
          is removed — this cannot be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return

    await run(async () => {
      try {
        await deleteDocument(doc.id)
        setLogs((prev) => prev.filter((l) => l.id !== doc.id))
        if (viewingId === doc.id) closeViewer()
        showToast(`Deleted "${doc.name}"`, 'success')
      } catch (err) {
        showToast(getErrorMessage(err, 'Delete failed'), 'error')
      }
    })
  }

  const handleExport = async (doc: Document) => {
    try {
      const full = await getDocument(doc.id)
      downloadFile(full.content || '', `${safeFilename(doc.name)}.log`, 'text/plain')
      showToast('Log exported', 'success')
    } catch (err) {
      showToast(getErrorMessage(err, 'Export failed'), 'error')
    }
  }

  const filtered = filter.trim()
    ? logs.filter((l) =>
        `${l.name} ${formatDate(l.created_at)}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : logs

  return (
    <SettingsSection
      title="Session Logs"
      description="Terminal output captured with Start Log on a terminal tab. Logs are stored as documents under the Logs folder, so they're also browsable from Documents. View, export, or delete them here."
      actions={
        <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={load} disabled={loading || submitting}>
          Refresh
        </button>
      }
    >
      {error && <p className="settings-error">{error}</p>}

      {loading ? (
        <p className="form-hint">Loading…</p>
      ) : logs.length === 0 ? (
        <p className="form-hint">No session logs yet. Right-click a terminal tab and choose “Start Log” to capture one.</p>
      ) : (
        <>
          <SearchField value={filter} onChange={setFilter} placeholder="Filter by name or date" />
          {filtered.length === 0 ? (
            <p className="form-hint">No matches.</p>
          ) : (
            <div className="settings-group">
              {filtered.map((doc) => (
                <SettingsItem
                  key={doc.id}
                  title={doc.name}
                  meta={<span title={doc.created_at}>{formatDate(doc.created_at)}</span>}
                  actions={
                    <>
                      <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => openViewer(doc)} disabled={submitting}>View</button>
                      <Tooltip label="Download as .log file"><button
                        className="ns-btn ns-btn--small ns-btn--ghost"
                        onClick={() => handleExport(doc)}
                        disabled={submitting}
                      >
                        Export
                      </button></Tooltip>
                      <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDelete(doc)} disabled={submitting}>Delete</button>
                    </>
                  }
                />
              ))}
            </div>
          )}
          <p className="form-hint">
            Showing {filtered.length} of {logs.length}{' '}
            {logs.length === 1 ? 'log' : 'logs'}.
          </p>
        </>
      )}

      {viewingId && (
        <ModalFrame id="session-log-viewer" onDismiss={closeViewer} className="recordings-player-modal" label="Session log">
          <div className="recordings-player-header">
            <span className="recordings-player-title">
              {viewingName}
              {!viewingLoading && viewingContent && (
                <> · {approxLineCount(viewingContent)} lines · {viewingContent.length.toLocaleString()} chars</>
              )}
            </span>
            <Tooltip label="Close viewer"><button aria-label="Close viewer"
              className="ns-btn ns-btn--ghost ns-icon-btn"
              onClick={closeViewer}
            >
              ×
            </button></Tooltip>
          </div>
          <div className="recordings-player-body">
            {viewingLoading ? (
              <p className="form-hint recordings-log-loading">Loading log…</p>
            ) : (
              <pre className="recordings-log-view">{viewingContent}</pre>
            )}
          </div>
        </ModalFrame>
      )}
    </SettingsSection>
  )
}
