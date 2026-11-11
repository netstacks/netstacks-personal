import { useState, useEffect, useCallback } from 'react'
import type { GitOps, RebasePlanItem } from '../../types/workspace'
import { showToast } from '../Toast'

import { getErrorMessage } from '../../api/errors'
import DialogFooter from '../DialogFooter'
import Tooltip from '../Tooltip'
import ModalFrame from '../ModalFrame'
interface WorkspaceHistoryEditorProps {
  gitOps: GitOps
  onClose: () => void
  onRefresh: () => void
}

interface EditableCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  action: 'pick' | 'squash' | 'drop'
  selected: boolean
}

export default function WorkspaceHistoryEditor({ gitOps, onClose, onRefresh }: WorkspaceHistoryEditorProps) {
  const [commits, setCommits] = useState<EditableCommit[]>([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editMessage, setEditMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await gitOps.rebasePlan(20)
        if (cancelled) return
        setCommits(result.map(c => ({
          hash: c.hash,
          shortHash: c.shortHash,
          message: c.message,
          author: c.author,
          action: 'pick',
          selected: false,
        })))
      } catch (err) {
        if (cancelled) return
        showToast(`Failed to load commits: ${getErrorMessage(err)}`, 'error')
        onClose()
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [gitOps, onClose])

  const moveUp = useCallback((idx: number) => {
    if (idx <= 0) return
    setCommits(prev => {
      const next = [...prev]
      ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
      return next
    })
  }, [])

  const moveDown = useCallback((idx: number) => {
    setCommits(prev => {
      if (idx >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      return next
    })
  }, [])

  const toggleDrop = useCallback((idx: number) => {
    setCommits(prev => prev.map((c, i) =>
      i === idx ? { ...c, action: c.action === 'drop' ? 'pick' : 'drop' } : c
    ))
  }, [])

  const startEdit = useCallback((idx: number) => {
    setEditingIdx(idx)
    setEditMessage(commits[idx].message)
  }, [commits])

  const finishEdit = useCallback(() => {
    if (editingIdx === null) return
    setCommits(prev => prev.map((c, i) =>
      i === editingIdx ? { ...c, message: editMessage } : c
    ))
    setEditingIdx(null)
    setEditMessage('')
  }, [editingIdx, editMessage])

  const handleCombineSelected = useCallback(() => {
    const selectedIndices = commits.map((c, i) => c.selected ? i : -1).filter(i => i >= 0)
    if (selectedIndices.length < 2) {
      showToast('Select 2 or more commits to combine', 'info')
      return
    }
    setCommits(prev => prev.map((c, i) => {
      if (i === selectedIndices[0]) {
        const combinedMessage = selectedIndices.map(si => prev[si].message).join('\n\n')
        return { ...c, selected: false, message: combinedMessage }
      }
      if (selectedIndices.includes(i) && i !== selectedIndices[0]) {
        return { ...c, action: 'squash', selected: false }
      }
      return c
    }))
  }, [commits])

  const toggleSelect = useCallback((idx: number) => {
    setCommits(prev => prev.map((c, i) =>
      i === idx ? { ...c, selected: !c.selected } : c
    ))
  }, [])

  const handleApply = useCallback(async () => {
    if (commits.length === 0) return
    setApplying(true)
    try {
      const baseHash = `${commits[0].hash}~1`
      const plan: RebasePlanItem[] = commits.map(c => ({
        hash: c.hash,
        action: c.action,
        message: c.action === 'squash' ? c.message : undefined,
      }))
      await gitOps.rebaseApply(baseHash, plan)
      onRefresh()
      onClose()
      showToast('History cleaned up', 'success')
    } catch (err) {
      showToast(`Failed: ${getErrorMessage(err)}`, 'error')
    } finally {
      setApplying(false)
    }
  }, [gitOps, commits, onRefresh, onClose])

  if (loading) {
    return (
      <ModalFrame id="git-history-editor" className="workspace-git-dialog" style={{ maxWidth: 560 }} label="Clean Up Your Commits">
        <p>Loading commits...</p>
      </ModalFrame>
    )
  }

  if (commits.length === 0) {
    return (
      <ModalFrame id="git-history-editor" className="workspace-git-dialog" style={{ maxWidth: 560 }} label="Clean Up Your Commits">
        <h3>Clean Up Your Commits</h3>
        <p>No unpushed commits to clean up.</p>
        <div className="workspace-git-dialog-actions">
          <button className="ns-btn" onClick={onClose}>Close</button>
        </div>
      </ModalFrame>
    )
  }

  return (
    <ModalFrame id="git-history-editor" className="workspace-git-dialog" style={{ maxWidth: 560 }} label="Clean Up Your Commits">
      <h3>Clean Up Your Commits</h3>
      <p>These commits exist only on your machine. You can reorganize them before pushing.</p>

      <div style={{ flex: 1, overflow: 'auto', margin: '8px 0', border: '1px solid var(--color-border)', borderRadius: 4 }}>
        {commits.map((commit, idx) => (
          <div
            key={commit.hash}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderBottom: '1px solid var(--color-border)',
              opacity: commit.action === 'drop' ? 0.4 : 1,
              textDecoration: commit.action === 'drop' ? 'line-through' : 'none',
              background: commit.selected ? 'var(--color-bg-hover)' : 'transparent',
            }}
          >
            <input aria-label={`Select commit ${commit.shortHash}`}
              type="checkbox"
              checked={commit.selected}
              onChange={() => toggleSelect(idx)}
              style={{ flexShrink: 0 }}
            />
            <span style={{ fontFamily: 'var(--font-family-mono)', fontSize: 11, color: 'var(--color-accent)', flexShrink: 0 }}>
              {commit.shortHash}
            </span>
            {editingIdx === idx ? (
              <input data-ai-fill="off" aria-label="Commit message"
                className="ns-input"
                style={{ flex: 1 }}
                value={editMessage}
                onChange={e => setEditMessage(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishEdit() } if (e.key === 'Escape') setEditingIdx(null) }}
                autoFocus
                onBlur={finishEdit}
              />
            ) : (
              <Tooltip label="Click to edit message"><span
                style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onClick={() => startEdit(idx)}
              >
                {commit.message}
              </span></Tooltip>
            )}
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              <Tooltip label="Move up"><button aria-label="Move up"
                className="ns-btn ns-btn--ghost ns-icon-btn ns-btn--small"
                onClick={() => moveUp(idx)}
                disabled={idx === 0}
              >
                ▲
              </button></Tooltip>
              <Tooltip label="Move down"><button aria-label="Move down"
                className="ns-btn ns-btn--ghost ns-icon-btn ns-btn--small"
                onClick={() => moveDown(idx)}
                disabled={idx === commits.length - 1}
              >
                ▼
              </button></Tooltip>
              <Tooltip label={commit.action === 'drop' ? 'Restore' : 'Remove'}><button
                className={`ns-btn ns-btn--ghost ns-icon-btn ns-btn--small${commit.action === 'drop' ? ' ns-btn--danger' : ''}`}
                onClick={() => toggleDrop(idx)}
                aria-label={commit.action === 'drop' ? 'Restore' : 'Remove'}
              >
                {commit.action === 'drop' ? '↩' : '✕'}
              </button></Tooltip>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button className="ns-btn" onClick={handleCombineSelected}>
          Combine Selected
        </button>
      </div>

      <DialogFooter
        primary={{ label: applying ? 'Applying...' : 'Apply Changes', onClick: handleApply, disabled: applying }}
        onCancel={onClose}
        inline
      />
    </ModalFrame>
  )
}
