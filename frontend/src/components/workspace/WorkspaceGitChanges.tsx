import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import type { GitOps, GitFileStatus, GitBranchInfo, GitStatusCode } from '../../types/workspace'
import { showToast } from '../Toast'
import { sendChatMessage } from '../../api/ai'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceGitChangesProps {
  gitOps: GitOps
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  onRefresh: () => void
  onViewDiff: (filePath: string) => void
}

const STATUS_LABELS: Record<GitStatusCode, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
  copied: 'C',
  clean: '',
}

export default function WorkspaceGitChanges({
  gitOps,
  branch,
  statuses,
  onRefresh,
  onViewDiff,
}: WorkspaceGitChangesProps) {
  const [commitMsg, setCommitMsg] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null)
  const commitInputRef = useRef<HTMLTextAreaElement | null>(null)

  const staged = statuses.filter(s => s.staged)
  const unstaged = statuses.filter(s => !s.staged && s.status !== 'clean')

  // Auto-grow the commit message textarea to fit its content. Caps at 50% of
  // the parent panel's height so the Commit buttons stay reachable.
  useLayoutEffect(() => {
    const el = commitInputRef.current
    if (!el) return
    el.style.height = 'auto'
    const parentHeight = el.parentElement?.parentElement?.clientHeight ?? 600
    const max = Math.max(120, Math.floor(parentHeight * 0.5))
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [commitMsg])

  const handleStageAll = useCallback(async () => {
    try {
      const paths = unstaged.map(s => s.path)
      if (paths.length === 0) return
      await gitOps.stage(paths)
      onRefresh()
    } catch (err) {
      showToast(`Stage failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, unstaged, onRefresh])

  const handleUnstageAll = useCallback(async () => {
    try {
      const paths = staged.map(s => s.path)
      if (paths.length === 0) return
      await gitOps.unstage(paths)
      onRefresh()
    } catch (err) {
      showToast(`Unstage failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, staged, onRefresh])

  const handleStageFile = useCallback(async (path: string) => {
    try {
      await gitOps.stage([path])
      onRefresh()
    } catch (err) {
      showToast(`Stage failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefresh])

  const handleUnstageFile = useCallback(async (path: string) => {
    try {
      await gitOps.unstage([path])
      onRefresh()
    } catch (err) {
      showToast(`Unstage failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefresh])

  const handleRevertFile = useCallback(async (path: string) => {
    try {
      await gitOps.revert([path])
      onRefresh()
      showToast('Reverted', 'success', 1500)
    } catch (err) {
      showToast(`Revert failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefresh])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus, isStaged: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      {
        id: 'view-diff',
        label: 'View Diff',
        action: () => onViewDiff(file.path),
      },
      { id: 'divider-1', label: '', divider: true, action: () => {} },
    ]
    if (isStaged) {
      items.push({
        id: 'unstage',
        label: 'Unstage',
        action: () => handleUnstageFile(file.path),
      })
    } else {
      items.push({
        id: 'stage',
        label: 'Stage',
        action: () => handleStageFile(file.path),
      })
      items.push({
        id: 'revert',
        label: 'Revert Changes',
        action: () => handleRevertFile(file.path),
      })
    }
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [onViewDiff, handleStageFile, handleUnstageFile, handleRevertFile])

  const handleCommit = useCallback(async (andPush: boolean) => {
    if (!commitMsg.trim()) return
    setIsCommitting(true)
    try {
      // Smart-commit: if the user has changes but hasn't staged anything,
      // stage them all first (matches VSCode's git.smartCommit default).
      if (staged.length === 0 && unstaged.length > 0) {
        const paths = unstaged.map(s => s.path)
        await gitOps.stage(paths)
      }
      await gitOps.commit(commitMsg.trim())
      if (andPush) {
        await gitOps.push()
      }
      setCommitMsg('')
      onRefresh()
      showToast(andPush ? 'Committed & pushed' : 'Committed', 'success')
    } catch (err) {
      showToast(`Commit failed: ${getErrorMessage(err)}`, 'error')
    } finally {
      setIsCommitting(false)
    }
  }, [gitOps, commitMsg, staged, unstaged, onRefresh])

  const fileName = (path: string) => path.split('/').pop() || path

  const renderFile = (file: GitFileStatus, isStaged: boolean) => (
    <div
      key={`${isStaged ? 's' : 'u'}-${file.path}`}
      className="workspace-git-changes-file"
      onClick={() => onViewDiff(file.path)}
      onContextMenu={(e) => handleFileContextMenu(e, file, isStaged)}
    >
      <span className={`workspace-git-changes-file-status ${file.status}`}>
        {STATUS_LABELS[file.status]}
      </span>
      <span className="workspace-git-changes-file-name" title={file.path}>
        {fileName(file.path)}
      </span>
      <div className="workspace-git-changes-file-actions">
        {isStaged ? (
          <button
            className="workspace-git-changes-file-action-btn"
            onClick={(e) => { e.stopPropagation(); handleUnstageFile(file.path) }}
            title="Unstage"
          >
            −
          </button>
        ) : (
          <button
            className="workspace-git-changes-file-action-btn"
            onClick={(e) => { e.stopPropagation(); handleStageFile(file.path) }}
            title="Stage"
          >
            +
          </button>
        )}
      </div>
    </div>
  )

  const hasChanges = staged.length > 0 || unstaged.length > 0
  // Smart-commit: enabled when there's a message AND any kind of change
  // (handleCommit auto-stages unstaged changes if nothing is staged yet).
  const canCommit = commitMsg.trim().length > 0 && hasChanges

  return (
    <div className="workspace-git-changes">
      {!hasChanges ? (
        <div className="workspace-git-changes-empty">
          {branch ? `On branch ${branch.name} — no changes` : 'No changes'}
        </div>
      ) : (
        <>
          {staged.length > 0 && (
            <div className="workspace-git-changes-section">
              <div className="workspace-git-changes-section-header">
                <span>Staged ({staged.length})</span>
                <button className="workspace-git-changes-section-btn" onClick={handleUnstageAll}>
                  Unstage All
                </button>
              </div>
              <div className="workspace-git-changes-file-list">
                {staged.map(f => renderFile(f, true))}
              </div>
            </div>
          )}

          {unstaged.length > 0 && (
            <div className="workspace-git-changes-section">
              <div className="workspace-git-changes-section-header">
                <span>Changes ({unstaged.length})</span>
                <button className="workspace-git-changes-section-btn" onClick={handleStageAll}>
                  Stage All
                </button>
              </div>
              <div className="workspace-git-changes-file-list">
                {unstaged.map(f => renderFile(f, false))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="workspace-git-commit-form">
        <div style={{ position: 'relative' }}>
          <textarea
            ref={commitInputRef}
            className="workspace-git-commit-input"
            placeholder={
              generating
                ? 'Generating...'
                : !hasChanges
                  ? 'No changes to commit'
                  : 'Commit message... (Tab to generate)'
            }
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            rows={3}
            style={{ resize: 'none', minHeight: '3.5em' }}
            disabled={generating || !hasChanges}
            onKeyDown={async e => {
              if (e.key === 'Tab' && !e.shiftKey && !commitMsg.trim() && hasChanges) {
                e.preventDefault()
                setGenerating(true)
                try {
                  // Prefer the staged diff so the AI describes exactly what
                  // will be committed. Fall back to the working-tree diff if
                  // nothing is staged yet (user can preview a message before
                  // staging).
                  const useStaged = staged.length > 0
                  const diff = await gitOps.diff(undefined, { staged: useStaged })
                  const truncatedDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (truncated)' : diff
                  const fileList = (useStaged ? staged : unstaged).map(s => `${s.status}: ${s.path}`).join('\n')
                  const prompt = `Write a concise git commit message for these changes. Use conventional commit format (feat/fix/chore/refactor/docs). First line max 72 chars. Add a blank line then a brief body if needed. Respond with ONLY the commit message, no quotes or explanation.

Staged files:
${fileList}

Diff:
${truncatedDiff}`
                  const msg = await sendChatMessage([{ role: 'user', content: prompt }])
                  setCommitMsg(msg.trim())
                } catch (err) {
                  showToast(`Generate failed: ${getErrorMessage(err)}`, 'error')
                } finally {
                  setGenerating(false)
                }
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
                e.preventDefault()
                handleCommit(false)
              }
            }}
          />
          {!commitMsg.trim() && !generating && hasChanges && (
            <span style={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              fontSize: 10,
              color: 'var(--color-text-secondary)',
              pointerEvents: 'none',
              opacity: 0.6,
            }}>
              TAB to generate
            </span>
          )}
        </div>
        <div className="workspace-git-commit-actions">
          <button
            className="workspace-git-commit-btn primary"
            disabled={!canCommit || isCommitting}
            onClick={() => handleCommit(false)}
          >
            Commit
          </button>
          <button
            className="workspace-git-commit-btn"
            disabled={!canCommit || isCommitting}
            onClick={() => handleCommit(true)}
          >
            Commit & Push
          </button>
        </div>
      </div>

      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}
