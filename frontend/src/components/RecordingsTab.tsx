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
import { downloadFile } from '../lib/formatters'
import RecordingPlayer from './RecordingPlayer'
import SearchField from './SearchField'
import './RecordingsTab.css'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'

// Sanitize a recording name for use as a filename — keep word chars and
// dashes, collapse everything else to a single hyphen, trim to 80 chars.
import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip'
import ModalFrame from './ModalFrame'
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

  const filtered = filter.trim()
    ? recordings.filter((r) =>
        `${r.name} ${formatDate(r.created_at)}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : recordings

  return (
    <SettingsSection
      title="Recordings"
      description="Every terminal recording stored on this machine. Play one back, rename it for context, or delete it to reclaim disk. Recordings are also reachable from any document that references them."
      actions={
        <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={load} disabled={loading || submitting}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      }
    >
      {error && <p className="settings-error">{error}</p>}

      {!loading && recordings.length === 0 && !error && (
        <p className="form-hint">No recordings yet. Start one from a terminal tab's context menu — Record session. The capture appears here when you stop.</p>
      )}

      {recordings.length > 0 && (
        <>
          <SearchField value={filter} onChange={setFilter} placeholder="Filter by name or date…" />
          {filtered.length === 0 ? (
            <p className="form-hint">No matches for "{filter}".</p>
          ) : (
            <div className="settings-group">
              {filtered.map((rec) => (
                <SettingsItem
                  key={rec.id}
                  title={editingId === rec.id ? (
                    <input data-ai-fill="off"
                        className="ns-input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(rec)
                          else if (e.key === 'Escape') cancelEdit()
                        }}
                        autoFocus
                        disabled={submitting}
                        aria-label="Recording name"
                      />
                  ) : rec.name}
                  meta={
                    <>
                      <span>{formatDate(rec.created_at)}</span>
                      <span>{formatDuration(rec.duration_ms)}</span>
                      <span>{rec.terminal_cols}×{rec.terminal_rows}</span>
                    </>
                  }
                  actions={editingId === rec.id ? (
                    <>
                        <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={cancelEdit} disabled={submitting}>Cancel</button>
                        <button className="ns-btn ns-btn--small ns-btn--primary" onClick={() => saveEdit(rec)} disabled={submitting}>
                          {submitting ? 'Saving…' : 'Save'}
                        </button>
                      </>
                  ) : (
                    <>
                      <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => setPlayingId(rec.id)}>Play</button>
                      <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => startEdit(rec)} disabled={submitting}>Rename</button>
                      <Tooltip label="Download as .cast file (asciinema-compatible)"><button
                        className="ns-btn ns-btn--small ns-btn--ghost"
                        onClick={() => handleExport(rec)}
                        disabled={submitting}
                      >
                        Share
                      </button></Tooltip>
                      <button className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger" onClick={() => handleDelete(rec)} disabled={submitting}>Delete</button>
                    </>
                  )}
                />
              ))}
            </div>
          )}
          <p className="form-hint">
            Showing {filtered.length} of {recordings.length}{' '}
            {recordings.length === 1 ? 'recording' : 'recordings'}.
          </p>
        </>
      )}

      {playingId && (
        <ModalFrame id="recording-player" onDismiss={closePlayer} className="recordings-player-modal" label="Recording player">
          <div className="recordings-player-header">
            <Tooltip label="Close player"><button aria-label="Close player"
              className="ns-btn ns-btn--ghost ns-icon-btn"
              onClick={closePlayer}
            >
              ×
            </button></Tooltip>
          </div>
          <div className="recordings-player-body">
            <RecordingPlayer recordingId={playingId} />
          </div>
        </ModalFrame>
      )}
    </SettingsSection>
  )
}
