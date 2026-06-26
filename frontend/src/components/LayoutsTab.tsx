// Saved Layouts library — list / rename / delete saved tab layouts.
//
// Layouts were a "data graveyard" per the CRUD-completeness audit: users
// could Save as Layout… from the tab group menu, but nothing surfaced the
// saved layouts back to them — they piled up in the DB forever with no
// way to manage or even see them. This tab mirrors RecordingsTab.

import { useCallback, useEffect, useState } from 'react'
import {
  listLayouts,
  updateLayout,
  deleteLayout,
  type Layout,
} from '../api/layouts'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { useSubmitting } from '../hooks/useSubmitting'
import './RecordingsTab.css'

import { getErrorMessage } from '../api/errors'
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function describeLayout(l: Layout): string {
  const count = l.tabs?.length ?? l.sessionIds.length
  const noun = count === 1 ? 'tab' : 'tabs'
  return `${count} ${noun} · ${l.orientation}`
}

export default function LayoutsTab() {
  const [layouts, setLayouts] = useState<Layout[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const { submitting, run } = useSubmitting()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listLayouts()
      data.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
      setLayouts(data)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load layouts'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const startEdit = (l: Layout) => {
    setEditingId(l.id)
    setEditingName(l.name)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingName('')
  }

  const saveEdit = async (l: Layout) => {
    const trimmed = editingName.trim()
    if (!trimmed || trimmed === l.name) {
      cancelEdit()
      return
    }
    await run(async () => {
      try {
        const updated = await updateLayout(l.id, { name: trimmed })
        setLayouts((prev) => prev.map((r) => (r.id === l.id ? updated : r)))
        showToast('Layout renamed', 'success')
        cancelEdit()
      } catch (err) {
        showToast(getErrorMessage(err, 'Rename failed'), 'error')
      }
    })
  }

  const handleDelete = async (l: Layout) => {
    const ok = await confirmDialog({
      title: 'Delete layout?',
      body: (
        <>
          Permanently delete <strong>{l.name}</strong>? The saved tab
          arrangement is removed — this cannot be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return

    await run(async () => {
      try {
        await deleteLayout(l.id)
        setLayouts((prev) => prev.filter((r) => r.id !== l.id))
        showToast(`Deleted "${l.name}"`, 'success')
      } catch (err) {
        showToast(getErrorMessage(err, 'Delete failed'), 'error')
      }
    })
  }

  const filtered = filter.trim()
    ? layouts.filter((l) =>
        `${l.name} ${describeLayout(l)}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : layouts

  return (
    <div className="recordings-tab settings-content">
      <div className="settings-section">
        <div className="recordings-header">
          <div>
            <h3>Saved Layouts</h3>
            <p className="settings-section-description">
              Tab arrangements you've saved from the tab-group menu's
              "Save as Layout…" action. Rename for context or delete to
              clean house. Loading a saved layout is still done from the
              tab-group menu next to your current tabs.
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
        ) : layouts.length === 0 ? (
          <p className="settings-note">
            No saved layouts yet. Right-click a tab group and choose "Save
            as Layout…" to add one.
          </p>
        ) : (
          <>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or shape"
              className="settings-input"
              style={{ marginBottom: 12 }}
            />

            <div className="recordings-list">
              {filtered.length === 0 ? (
                <p className="settings-note">No matches.</p>
              ) : (
                filtered.map((l) => (
                  <div key={l.id} className="recordings-item">
                    <div className="recordings-item-info">
                      {editingId === l.id ? (
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          className="recordings-item-rename"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(l)
                            else if (e.key === 'Escape') cancelEdit()
                          }}
                        />
                      ) : (
                        <div className="recordings-item-name">{l.name}</div>
                      )}
                      <div className="recordings-item-meta">
                        <span>{describeLayout(l)}</span>
                        <span>·</span>
                        <span title={l.updatedAt}>{formatDate(l.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="recordings-item-actions">
                      {editingId === l.id ? (
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
                            onClick={() => saveEdit(l)}
                            disabled={submitting}
                          >
                            {submitting ? 'Saving…' : 'Save'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-secondary"
                            onClick={() => startEdit(l)}
                            disabled={submitting}
                          >
                            Rename
                          </button>
                          <button
                            className="btn-danger"
                            onClick={() => handleDelete(l)}
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
              Showing {filtered.length} of {layouts.length}{' '}
              {layouts.length === 1 ? 'layout' : 'layouts'}.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
