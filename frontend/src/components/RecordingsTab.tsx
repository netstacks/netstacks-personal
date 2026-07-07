// Recordings library — list every terminal recording, play / rename / delete.
//
// Recordings were a "data graveyard" per the CRUD-completeness audit:
// the backend supported full CRUD but the UI had no list view, no
// delete, no rename. Every recording started lived on disk forever,
// reachable only via a UUID embedded in a docs link.

import { useCallback, useEffect, useState } from 'react'
import {
  listRecordings,
  deleteRecording,
  renameRecording,
  getRecordingData,
  type Recording,
} from '../api/recordings'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { useSubmitting } from '../hooks/useSubmitting'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import { downloadFile } from '../lib/formatters'
import RecordingPlayer from './RecordingPlayer'
import './RecordingsTab.css'

// Sanitize a recording name for use as a filename — keep word chars and
// dashes, collapse everything else to a single hyphen, trim to 80 chars.
import { getErrorMessage } from '../api/errors'
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (cleaned || 'recording').slice(0, 80)
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`
    : `${m}m ${s.toString().padStart(2, '0')}s`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export default function RecordingsTab() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const { submitting, run } = useSubmitting()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listRecordings()
      // newest first
      data.sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
      setRecordings(data)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load recordings'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const startEdit = (rec: Recording) => {
    setEditingId(rec.id)
    setEditingName(rec.name)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingName('')
  }

  const saveEdit = async (rec: Recording) => {
    const trimmed = editingName.trim()
    if (!trimmed || trimmed === rec.name) {
      cancelEdit()
      return
    }
    await run(async () => {
      try {
        const updated = await renameRecording(rec.id, trimmed)
        setRecordings((prev) => prev.map((r) => (r.id === rec.id ? updated : r)))
        showToast('Recording renamed', 'success')
        cancelEdit()
      } catch (err) {
        const message = getErrorMessage(err, 'Rename failed')
        showToast(message, 'error')
      }
    })
  }

  const handleDelete = async (rec: Recording) => {
    const ok = await confirmDialog({
      title: 'Delete recording?',
      body: (
        <>
          Permanently delete <strong>{rec.name}</strong>? The asciicast file
          on disk is removed too — this cannot be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return

    await run(async () => {
      try {
        await deleteRecording(rec.id)
        setRecordings((prev) => prev.filter((r) => r.id !== rec.id))
        showToast(`Deleted "${rec.name}"`, 'success')
      } catch (err) {
        const message = getErrorMessage(err, 'Delete failed')
        showToast(message, 'error')
      }
    })
  }

  const handleExport = async (rec: Recording) => {
    // "Share" = download the asciicast file. Generates a portable .cast
    // the user can drop into any asciinema-compatible player or attach to
    // a chat/email. Backend has no native share-link endpoint yet.
    try {
      const data = await getRecordingData(rec.id)
      // The backend returns the asciicast file body as text. downloadFile
      // handles the blob + click dance.
      downloadFile(data, `${safeFilename(rec.name)}.cast`, 'application/x-asciicast')
      showToast('Recording exported', 'success')
    } catch (err) {
      const message = getErrorMessage(err, 'Export failed')
      showToast(message, 'error')
    }
  }

  const closePlayer = useCallback(() => setPlayingId(null), [])
  const playerDismiss = useOverlayDismiss({ onDismiss: closePlayer, enabled: !!playingId })

  const filtered = filter.trim()
    ? recordings.filter((r) =>
        `${r.name} ${formatDate(r.created_at)}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : recordings

  return (
    <div className="recordings-tab settings-content">
      <div className="settings-section">
        <div className="recordings-header">
          <div>
            <h3>Recordings</h3>
            <p className="settings-section-description">
              Every terminal recording stored on this machine. Play one
              back, rename it for context, or delete it to reclaim disk.
              Recordings are also reachable from any document that
              references them.
            </p>
          </div>
          <button
            className="btn-secondary"
            onClick={load}
            disabled={loading || submitting}
            title="Reload"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && <div className="settings-error">{error}</div>}

        {!loading && recordings.length === 0 && !error && (
          <div className="recordings-empty">
            <p>No recordings yet.</p>
            <p className="settings-note">
              Start one from a terminal tab's context menu — Record
              session. The capture appears here when you stop.
            </p>
          </div>
        )}

        {recordings.length > 0 && (
          <>
            <div className="recordings-filter">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name or date…"
              />
              {filter && (
                <button
                  className="recordings-filter-clear"
                  onClick={() => setFilter('')}
                  title="Clear filter"
                >
                  ×
                </button>
              )}
            </div>

            <div className="recordings-list">
              {filtered.length === 0 ? (
                <div className="recordings-empty">
                  <p>No matches for "{filter}".</p>
                </div>
              ) : (
                filtered.map((rec) => (
                  <div key={rec.id} className="recordings-item">
                    <div className="recordings-item-info">
                      {editingId === rec.id ? (
                        <input
                          className="recordings-item-rename"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(rec)
                            if (e.key === 'Escape') cancelEdit()
                          }}
                          autoFocus
                          disabled={submitting}
                          aria-label="Recording name"
                        />
                      ) : (
                        <div className="recordings-item-name">{rec.name}</div>
                      )}
                      <div className="recordings-item-meta">
                        <span>{formatDate(rec.created_at)}</span>
                        <span>·</span>
                        <span>{formatDuration(rec.duration_ms)}</span>
                        <span>·</span>
                        <span>
                          {rec.terminal_cols}×{rec.terminal_rows}
                        </span>
                      </div>
                    </div>
                    <div className="recordings-item-actions">
                      {editingId === rec.id ? (
                        <>
                          <button
                            className="btn-secondary"
                            onClick={cancelEdit}
                            disabled={submitting}
                          >
                            Cancel
                          </button>
                          <button
                            className="btn-primary"
                            onClick={() => saveEdit(rec)}
                            disabled={submitting}
                          >
                            {submitting ? 'Saving…' : 'Save'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-secondary"
                            onClick={() => setPlayingId(rec.id)}
                          >
                            Play
                          </button>
                          <button
                            className="btn-secondary"
                            onClick={() => startEdit(rec)}
                            disabled={submitting}
                          >
                            Rename
                          </button>
                          <button
                            className="btn-secondary"
                            onClick={() => handleExport(rec)}
                            disabled={submitting}
                            title="Download as .cast file (asciinema-compatible)"
                          >
                            Share
                          </button>
                          <button
                            className="btn-danger"
                            onClick={() => handleDelete(rec)}
                            disabled={submitting}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <p className="settings-note">
              Showing {filtered.length} of {recordings.length}{' '}
              {recordings.length === 1 ? 'recording' : 'recordings'}.
            </p>
          </>
        )}
      </div>

      {playingId && (
        <div className="recordings-player-overlay" {...playerDismiss.backdropProps}>
          <div className="recordings-player-modal" {...playerDismiss.contentProps}>
            <div className="recordings-player-header">
              <button
                className="recordings-player-close"
                onClick={closePlayer}
                title="Close player"
              >
                ×
              </button>
            </div>
            <div className="recordings-player-body">
              <RecordingPlayer recordingId={playingId} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
