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
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import { downloadFile } from '../lib/formatters'
import './RecordingsTab.css'

import { getErrorMessage } from '../api/errors'
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

  const viewerDismiss = useOverlayDismiss({ onDismiss: closeViewer, enabled: !!viewingId })

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
    <div className="recordings-tab settings-content">
      <div className="settings-section">
        <div className="recordings-header">
          <div>
            <h3>Session Logs</h3>
            <p className="settings-section-description">
              Terminal session output captured via Start Log on a terminal
              tab. Logs are stored as documents under the Logs folder, so
              they're also browsable from Documents. View, export, or
              delete from here.
            </p>
          </div>
          <button
            className="btn-secondary"
            onClick={load}
            disabled={loading || submitting}
            title="Refresh"
          >
            Refresh
          </button>
        </div>

        {error && <div className="settings-error">{error}</div>}

        {loading ? (
          <p className="settings-note">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="settings-note">
            No session logs yet. Right-click a terminal tab and choose
            "Start Log" to capture one.
          </p>
        ) : (
          <>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or date"
              className="settings-input"
              style={{ marginBottom: 12 }}
            />

            <div className="recordings-list">
              {filtered.length === 0 ? (
                <p className="settings-note">No matches.</p>
              ) : (
                filtered.map((doc) => (
                  <div key={doc.id} className="recordings-item">
                    <div className="recordings-item-info">
                      <div className="recordings-item-name">{doc.name}</div>
                      <div className="recordings-item-meta">
                        <span title={doc.created_at}>{formatDate(doc.created_at)}</span>
                      </div>
                    </div>
                    <div className="recordings-item-actions">
                      <button
                        className="btn-secondary"
                        onClick={() => openViewer(doc)}
                        disabled={submitting}
                      >
                        View
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => handleExport(doc)}
                        disabled={submitting}
                        title="Download as .log file"
                      >
                        Export
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleDelete(doc)}
                        disabled={submitting}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <p className="settings-note">
              Showing {filtered.length} of {logs.length}{' '}
              {logs.length === 1 ? 'log' : 'logs'}.
            </p>
          </>
        )}
      </div>

      {viewingId && (
        <div className="recordings-player-overlay" {...viewerDismiss.backdropProps}>
          <div className="recordings-player-modal" {...viewerDismiss.contentProps}>
            <div className="recordings-player-header">
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary, #999)', marginRight: 'auto', paddingLeft: 12 }}>
                {viewingName}
                {!viewingLoading && viewingContent && (
                  <span style={{ marginLeft: 12 }}>
                    · {approxLineCount(viewingContent)} lines · {viewingContent.length.toLocaleString()} chars
                  </span>
                )}
              </span>
              <button
                className="recordings-player-close"
                onClick={closeViewer}
                title="Close viewer"
              >
                ×
              </button>
            </div>
            <div className="recordings-player-body">
              {viewingLoading ? (
                <p className="settings-note" style={{ padding: 20 }}>Loading log…</p>
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 16,
                    background: 'var(--color-bg-primary, #1e1e1e)',
                    color: 'var(--color-text-primary, #ddd)',
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 12,
                    lineHeight: 1.5,
                    overflow: 'auto',
                    maxHeight: '70vh',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {viewingContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
