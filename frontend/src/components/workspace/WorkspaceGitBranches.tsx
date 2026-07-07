import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitOps, GitBranchInfo, BranchEntry, StashEntry } from '../../types/workspace'
import { showToast } from '../Toast'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceGitBranchesProps {
  gitOps: GitOps
  currentBranch: GitBranchInfo | null
  hasChanges: boolean
  onRefresh: () => void
}

export default function WorkspaceGitBranches({
  gitOps,
  currentBranch,
  hasChanges,
  onRefresh,
}: WorkspaceGitBranchesProps) {
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null)
  const [switchDialog, setSwitchDialog] = useState<{ branchName: string } | null>(null)

  const fetchBranches = useCallback(async () => {
    setLoading(true)
    try {
      const [branchResult, stashResult] = await Promise.all([
        gitOps.listBranches(),
        gitOps.listStashes(),
      ])
      setBranches(branchResult)
      setStashes(stashResult)
    } catch {
      setBranches([])
      setStashes([])
    } finally {
      setLoading(false)
    }
  }, [gitOps])

  useEffect(() => {
    fetchBranches()
  }, [fetchBranches])

  useEffect(() => {
    if (showNewBranch && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showNewBranch])

  const handleSwitch = useCallback(async (name: string) => {
    if (name === currentBranch?.name) return
    if (hasChanges) {
      setSwitchDialog({ branchName: name })
      return
    }
    try {
      await gitOps.switchBranch(name)
      onRefresh()
      fetchBranches()
      showToast(`Switched to ${name}`, 'success')
    } catch (err) {
      showToast(`Switch failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, currentBranch, hasChanges, onRefresh, fetchBranches])

  const handleStashAndSwitch = useCallback(async () => {
    if (!switchDialog) return
    try {
      await gitOps.stash('push')
      await gitOps.switchBranch(switchDialog.branchName)
      onRefresh()
      fetchBranches()
      setSwitchDialog(null)
      showToast(`Saved changes and switched to ${switchDialog.branchName}`, 'success')
    } catch (err) {
      showToast(`Failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, switchDialog, onRefresh, fetchBranches])

  const handleForceSwitch = useCallback(async () => {
    if (!switchDialog) return
    try {
      await gitOps.switchBranch(switchDialog.branchName)
      onRefresh()
      fetchBranches()
      setSwitchDialog(null)
      showToast(`Switched to ${switchDialog.branchName}`, 'success')
    } catch (err) {
      showToast(`Switch failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, switchDialog, onRefresh, fetchBranches])

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim()
    if (!name) return
    try {
      await gitOps.createBranch(name)
      await gitOps.switchBranch(name)
      setNewBranchName('')
      setShowNewBranch(false)
      onRefresh()
      fetchBranches()
      showToast(`Created and switched to ${name}`, 'success')
    } catch (err) {
      showToast(`Create failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, newBranchName, onRefresh, fetchBranches])

  const handleDeleteBranch = useCallback(async (name: string) => {
    try {
      await gitOps.deleteBranch(name)
      fetchBranches()
      showToast(`Deleted ${name}`, 'success')
    } catch (err) {
      showToast(`Delete failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, fetchBranches])

  const handleMerge = useCallback(async (name: string) => {
    try {
      await gitOps.merge(name)
      onRefresh()
      fetchBranches()
      showToast(`Merged ${name} into ${currentBranch?.name || 'current'}`, 'success')
    } catch (err) {
      showToast(`Merge failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefresh, fetchBranches, currentBranch])

  const handleStashPop = useCallback(async (index: number) => {
    try {
      await gitOps.stash('pop', index)
      onRefresh()
      fetchBranches()
      showToast('Changes restored', 'success')
    } catch (err) {
      showToast(`Failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefresh, fetchBranches])

  const handleStashDrop = useCallback(async (index: number) => {
    try {
      await gitOps.stash('drop', index)
      fetchBranches()
      showToast('Stash removed', 'success')
    } catch (err) {
      showToast(`Failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, fetchBranches])

  const handleBranchContextMenu = useCallback((e: React.MouseEvent, branch: BranchEntry) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = []

    if (branch.isCurrent) {
      items.push({
        id: 'current',
        label: 'Current Branch',
        disabled: true,
        action: () => {},
      })
    } else {
      items.push({
        id: 'switch',
        label: 'Switch to Branch',
        action: () => handleSwitch(branch.name),
      })
      items.push({
        id: 'merge',
        label: `Merge into ${currentBranch?.name || 'current'}`,
        action: () => handleMerge(branch.name),
      })
      items.push({ id: 'divider-1', label: '', divider: true, action: () => {} })
      items.push({
        id: 'delete',
        label: 'Delete Branch',
        action: () => handleDeleteBranch(branch.name),
      })
    }
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [handleSwitch, handleMerge, handleDeleteBranch, currentBranch])

  const localBranches = branches.filter(b => !b.isRemote)
  const remoteBranches = branches.filter(b => b.isRemote)

  if (loading) {
    return <div className="workspace-git-branches-loading">Loading branches...</div>
  }

  return (
    <div className="workspace-git-branches">
      <div className="workspace-git-branches-header">
        <span>Branches</span>
        <button
          className="workspace-git-branches-new-btn"
          onClick={() => setShowNewBranch(!showNewBranch)}
        >
          + New
        </button>
      </div>

      {showNewBranch && (
        <div className="workspace-git-new-branch-form">
          <input
            ref={inputRef}
            className="workspace-git-new-branch-input"
            placeholder="branch-name"
            value={newBranchName}
            onChange={e => setNewBranchName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreateBranch()
              if (e.key === 'Escape') { setShowNewBranch(false); setNewBranchName('') }
            }}
          />
          <button
            className="workspace-git-new-branch-submit"
            disabled={!newBranchName.trim()}
            onClick={handleCreateBranch}
          >
            Create
          </button>
        </div>
      )}

      <div className="workspace-git-branches-list">
        <div className="workspace-git-branches-section-label">Local</div>
        {localBranches.map(b => (
          <div
            key={b.name}
            className={`workspace-git-branches-item ${b.isCurrent ? 'current' : ''}`}
            onClick={() => handleSwitch(b.name)}
            onContextMenu={(e) => handleBranchContextMenu(e, b)}
          >
            <span className="workspace-git-branches-item-indicator" />
            <span className="workspace-git-branches-item-name">{b.name}</span>
            {b.upstream && (
              <span className="workspace-git-branches-item-upstream">{b.upstream}</span>
            )}
          </div>
        ))}

        {remoteBranches.length > 0 && (
          <>
            <div className="workspace-git-branches-section-label">Remote</div>
            {remoteBranches.map(b => (
              <div
                key={b.name}
                className="workspace-git-branches-item"
              >
                <span className="workspace-git-branches-item-indicator" />
                <span className="workspace-git-branches-item-name">{b.name}</span>
              </div>
            ))}
          </>
        )}

        {stashes.length > 0 && (
          <>
            <div className="workspace-git-branches-section-label">Saved for Later</div>
            {stashes.map(s => (
              <div key={s.index} className="workspace-git-branches-item" style={{ justifyContent: 'space-between' }}>
                <span className="workspace-git-branches-item-name" style={{ fontSize: 12 }} title={s.message}>
                  {s.message || `stash@{${s.index}}`}
                </span>
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <button
                    style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 11, padding: '0 4px', fontFamily: 'var(--font-family)' }}
                    onClick={() => handleStashPop(s.index)}
                    title="Restore these changes"
                  >
                    Restore
                  </button>
                  <button
                    style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 11, padding: '0 4px', fontFamily: 'var(--font-family)' }}
                    onClick={() => handleStashDrop(s.index)}
                    title="Discard these changes"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />

      {switchDialog && (
        <div className="workspace-git-dialog-overlay">
          <div className="workspace-git-dialog" onClick={e => e.stopPropagation()}>
            <h3>Unsaved Changes</h3>
            <p>
              You have changes that would be lost if you switch branches.
            </p>
            <p style={{ fontSize: '11px', opacity: 0.7 }}>
              "Save for Later" sets your changes aside and restores them when you come back to this branch.
            </p>
            <div className="workspace-git-dialog-actions">
              <button className="workspace-git-dialog-btn" onClick={() => setSwitchDialog(null)}>
                Cancel
              </button>
              <button className="workspace-git-dialog-btn danger" onClick={handleForceSwitch}>
                Discard Changes
              </button>
              <button className="workspace-git-dialog-btn primary" onClick={handleStashAndSwitch}>
                Save for Later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
