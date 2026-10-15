import { useState, useCallback } from 'react'
import WorkspaceGitChanges from './WorkspaceGitChanges'
import WorkspaceGitHistory from './WorkspaceGitHistory'
import WorkspaceGitBranches from './WorkspaceGitBranches'
import WorkspaceHistoryEditor from './WorkspaceHistoryEditor'
import type { GitOps, GitFileStatus, GitBranchInfo, GitPanelTab } from '../../types/workspace'
import { showToast } from '../Toast'

import { getErrorMessage } from '../../api/errors'
import DialogFooter from '../DialogFooter'
import Tooltip from '../Tooltip'
import ModalFrame from '../ModalFrame'
interface WorkspaceGitPanelProps {
  gitOps: GitOps
  isGitRepo: boolean
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  activeTab: GitPanelTab
  onSetTab: (tab: GitPanelTab) => void
  onRefresh: () => void
  onViewDiff: (filePath: string) => void
}

export default function WorkspaceGitPanel({
  gitOps,
  isGitRepo,
  branch,
  statuses,
  activeTab,
  onSetTab,
  onRefresh,
  onViewDiff,
}: WorkspaceGitPanelProps) {

  const handleInit = useCallback(async () => {
    try {
      await gitOps.init()
      onRefresh()
      showToast('Repository initialized', 'success')
    } catch (err) {
      showToast(`Init failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefresh])

  const [isPushing, setIsPushing] = useState(false)
  const [isPulling, setIsPulling] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [showPushRejected, setShowPushRejected] = useState(false)
  const [showHistoryEditor, setShowHistoryEditor] = useState(false)

  const handlePush = useCallback(async () => {
    setIsPushing(true)
    try {
      await gitOps.push()
      onRefresh()
      showToast('Pushed', 'success')
    } catch (err) {
      const msg = getErrorMessage(err, '')
      if (msg.includes('rejected') || msg.includes('non-fast-forward') || msg.includes('fetch first')) {
        setShowPushRejected(true)
      } else {
        showToast(`Push failed: ${msg || 'Unknown error'}`, 'error')
      }
    } finally {
      setIsPushing(false)
    }
  }, [gitOps, onRefresh])

  const handleSyncAndPush = useCallback(async () => {
    setShowPushRejected(false)
    setIsPulling(true)
    try {
      await gitOps.pull()
      await gitOps.push()
      onRefresh()
      showToast('Synced & pushed', 'success')
    } catch (err) {
      showToast(`Sync failed: ${getErrorMessage(err)}`, 'error')
    } finally {
      setIsPulling(false)
    }
  }, [gitOps, onRefresh])

  const handlePull = useCallback(async () => {
    setIsPulling(true)
    try {
      await gitOps.pull()
      onRefresh()
      showToast('Pulled', 'success')
    } catch (err) {
      showToast(`Pull failed: ${getErrorMessage(err)}`, 'error')
    } finally {
      setIsPulling(false)
    }
  }, [gitOps, onRefresh])

  const handleFetch = useCallback(async () => {
    setIsFetching(true)
    try {
      await gitOps.fetch()
      onRefresh()
      showToast('Fetched', 'success')
    } catch (err) {
      showToast(`Fetch failed: ${getErrorMessage(err)}`, 'error')
    } finally {
      setIsFetching(false)
    }
  }, [gitOps, onRefresh])

  if (!isGitRepo) {
    return (
      <div className="workspace-git-panel">
        <div className="workspace-git-not-repo">
          <span>Not a git repository</span>
          <button className="ns-btn ns-btn--primary" onClick={handleInit}>
            Initialize Repository
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-git-panel">
      <div className="workspace-git-panel-tabs">
        <button
          className={`workspace-git-panel-tab ${activeTab === 'changes' ? 'active' : ''}`}
          onClick={() => onSetTab('changes')}
        >
          Changes
        </button>
        <button
          className={`workspace-git-panel-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => onSetTab('history')}
        >
          History
        </button>
        <button
          className={`workspace-git-panel-tab ${activeTab === 'branches' ? 'active' : ''}`}
          onClick={() => onSetTab('branches')}
        >
          Branches
        </button>
      </div>
      {branch && (
        <div className="workspace-git-toolbar">
          <div className="workspace-git-toolbar-branch">
            <span>⎇</span>
            <span className="workspace-git-toolbar-branch-name">{branch.name}</span>
            {(branch.ahead > 0 || branch.behind > 0) && (
              <span className="workspace-git-toolbar-ahead-behind">
                {branch.ahead > 0 && `↑${branch.ahead}`}
                {branch.behind > 0 && ` ↓${branch.behind}`}
              </span>
            )}
          </div>
          <div className="workspace-git-toolbar-actions">
            <Tooltip label="Fetch"><button
              className="ns-btn ns-btn--small"
              onClick={handleFetch}
              disabled={isFetching}
            >
              {isFetching ? '...' : 'Fetch'}
            </button></Tooltip>
            <Tooltip label="Pull"><button
              className="ns-btn ns-btn--small"
              onClick={handlePull}
              disabled={isPulling}
            >
              {isPulling ? '...' : 'Pull'}
            </button></Tooltip>
            <Tooltip label="Push"><button
              className="ns-btn ns-btn--small"
              onClick={handlePush}
              disabled={isPushing}
            >
              {isPushing ? '...' : 'Push'}
            </button></Tooltip>
            <Tooltip label="Clean Up History"><button
              className="ns-btn ns-btn--small"
              onClick={() => setShowHistoryEditor(true)}
            >
              Tidy
            </button></Tooltip>
          </div>
        </div>
      )}
      <div className="workspace-git-panel-content">
        {activeTab === 'changes' && (
          <WorkspaceGitChanges
            gitOps={gitOps}
            branch={branch}
            statuses={statuses}
            onRefresh={onRefresh}
            onViewDiff={onViewDiff}
          />
        )}
        {activeTab === 'history' && (
          <WorkspaceGitHistory
            gitOps={gitOps}
            onViewDiff={onViewDiff}
            onRefresh={onRefresh}
          />
        )}
        {activeTab === 'branches' && (
          <WorkspaceGitBranches
            gitOps={gitOps}
            currentBranch={branch}
            hasChanges={statuses.some(s => s.status !== 'clean')}
            onRefresh={onRefresh}
          />
        )}
      </div>

      {showHistoryEditor && (
        <WorkspaceHistoryEditor
          gitOps={gitOps}
          onClose={() => setShowHistoryEditor(false)}
          onRefresh={onRefresh}
        />
      )}

      {showPushRejected && (
        <ModalFrame id="git-server-changes" className="workspace-git-dialog" label="Changes on the Server">
          <h3>Changes on the Server</h3>
          <p>
            Someone else pushed changes since your last sync. You need to bring those in first.
          </p>
          <DialogFooter primary={{ label: 'Sync & Push', onClick: handleSyncAndPush }} onCancel={() => setShowPushRejected(false)} inline />
        </ModalFrame>
      )}
    </div>
  )
}
