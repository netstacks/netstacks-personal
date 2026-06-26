import { useState, useCallback, useEffect, useRef } from 'react'
import FileIcon from './FileIcon'
import type { FileOps, WorkspaceFileEntry, WorkspaceMode, GitBranchInfo, GitFileStatus, GitStatusCode, GitOps } from '../../types/workspace'
import { showToast } from '../Toast'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { getFileExplorerMenuItems } from './fileExplorerMenuItems'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceFileExplorerProps {
  rootPath: string
  mode: WorkspaceMode
  fileOps: FileOps
  expandedDirs: Set<string>
  selectedPath: string | null
  gitBranch: GitBranchInfo | null
  gitStatuses: GitFileStatus[]
  isGitRepo: boolean
  onToggleDir: (path: string) => void
  onSelectPath: (path: string | null) => void
  onOpenFile: (filePath: string, fileName: string) => void
  onRefreshGit: () => void
  getFileStatus: (path: string) => GitFileStatus | undefined
  gitOps: GitOps | null
  onViewDiff: (filePath: string) => void
  onViewBlame: (filePath: string) => void
}

interface DirContents {
  entries: WorkspaceFileEntry[]
  loading: boolean
  error: string | null
}

interface ContextMenuState {
  position: { x: number; y: number }
  items: MenuItem[]
}

type InlineInputMode =
  | { type: 'new-file'; parentDir: string }
  | { type: 'new-folder'; parentDir: string }
  | { type: 'rename'; entry: WorkspaceFileEntry; parentDir: string }
  | null

const GIT_STATUS_LABELS: Record<GitStatusCode, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
  copied: 'C',
  clean: '',
}

export default function WorkspaceFileExplorer({
  rootPath,
  fileOps,
  expandedDirs,
  selectedPath,
  gitBranch,
  gitStatuses,
  isGitRepo,
  onToggleDir,
  onSelectPath,
  onOpenFile,
  onRefreshGit,
  getFileStatus,
  gitOps,
  onViewDiff,
  onViewBlame,
}: WorkspaceFileExplorerProps) {
  const [dirContents, setDirContents] = useState<Map<string, DirContents>>(new Map())
  const [filter] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineInput, setInlineInput] = useState<InlineInputMode>(null)
  const [inlineValue, setInlineValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<WorkspaceFileEntry | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null)
  const [bulkDeletePaths, setBulkDeletePaths] = useState<Set<string> | null>(null)
  const inlineInputRef = useRef<HTMLInputElement>(null)

  // Keyboard shortcuts for file explorer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement
      const tag = active?.tagName
      if (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (active as HTMLElement | null)?.isContentEditable
      ) {
        return
      }

      // Spacebar → macOS Quick Look
      if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!selectedPath) return
        e.preventDefault()
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('open_quicklook', { path: selectedPath }).catch((err) => {
            if (typeof err === 'string' && !err.includes('only available on macOS')) {
              showToast(`Quick Look failed: ${err}`, 'error')
            }
          })
        }).catch(() => {})
        return
      }

      // Delete/Backspace → delete selected items
      if ((e.code === 'Delete' || e.code === 'Backspace') && !e.metaKey && !e.ctrlKey) {
        if (selectedPaths.size === 0) return
        e.preventDefault()
        if (selectedPaths.size === 1) {
          const path = Array.from(selectedPaths)[0]
          const entry = findEntryByPath(path)
          if (entry) setDeleteConfirm(entry)
        } else {
          setBulkDeletePaths(new Set(selectedPaths))
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedPath, selectedPaths])

  const findEntryByPath = useCallback((path: string): WorkspaceFileEntry | undefined => {
    for (const [, contents] of dirContents) {
      const found = contents.entries.find(e => e.path === path)
      if (found) return found
    }
    return undefined
  }, [dirContents])

  const loadDir = useCallback(async (path: string) => {
    setDirContents(prev => {
      const next = new Map(prev)
      next.set(path, { entries: prev.get(path)?.entries || [], loading: true, error: null })
      return next
    })
    try {
      const entries = await fileOps.readDir(path)
      setDirContents(prev => {
        const next = new Map(prev)
        next.set(path, { entries, loading: false, error: null })
        return next
      })
    } catch (err) {
      setDirContents(prev => {
        const next = new Map(prev)
        next.set(path, { entries: [], loading: false, error: getErrorMessage(err, 'Failed to read directory') })
        return next
      })
    }
  }, [fileOps])

  useEffect(() => {
    loadDir(rootPath)
  }, [rootPath, loadDir])

  useEffect(() => {
    for (const dir of expandedDirs) {
      if (!dirContents.has(dir)) {
        loadDir(dir)
      }
    }
  }, [expandedDirs, dirContents, loadDir])

  useEffect(() => {
    if (inlineInput && inlineInputRef.current) {
      inlineInputRef.current.focus()
      if (inlineInput.type === 'rename') {
        const name = inlineInput.entry.name
        const dotIdx = name.lastIndexOf('.')
        inlineInputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : name.length)
      } else {
        inlineInputRef.current.select()
      }
    }
  }, [inlineInput])


  const getParentDir = useCallback((filePath: string): string => {
    const sep = filePath.includes('/') ? '/' : '\\'
    const parts = filePath.split(sep)
    parts.pop()
    return parts.join(sep) || rootPath
  }, [rootPath])

  const refreshDir = useCallback((dirPath: string) => {
    loadDir(dirPath)
  }, [loadDir])

  const refreshAll = useCallback(() => {
    setDirContents(new Map())
    loadDir(rootPath)
    onRefreshGit()
  }, [rootPath, loadDir, onRefreshGit])

  // CRUD operations
  const handleNewFile = useCallback((parentDir: string) => {
    if (!expandedDirs.has(parentDir) && parentDir !== rootPath) {
      onToggleDir(parentDir)
    }
    setInlineInput({ type: 'new-file', parentDir })
    setInlineValue('')
    setContextMenu(null)
  }, [expandedDirs, rootPath, onToggleDir])

  const handleNewFolder = useCallback((parentDir: string) => {
    if (!expandedDirs.has(parentDir) && parentDir !== rootPath) {
      onToggleDir(parentDir)
    }
    setInlineInput({ type: 'new-folder', parentDir })
    setInlineValue('')
    setContextMenu(null)
  }, [expandedDirs, rootPath, onToggleDir])

  const handleRename = useCallback((entry: WorkspaceFileEntry) => {
    setInlineInput({ type: 'rename', entry, parentDir: getParentDir(entry.path) })
    setInlineValue(entry.name)
    setContextMenu(null)
  }, [getParentDir])

  const handleDelete = useCallback((entry: WorkspaceFileEntry) => {
    setDeleteConfirm(entry)
    setContextMenu(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return
    try {
      await fileOps.delete(deleteConfirm.path, deleteConfirm.isDir)
      refreshDir(getParentDir(deleteConfirm.path))
      showToast(`Deleted ${deleteConfirm.name}`, 'success')
    } catch (err) {
      showToast(`Failed to delete: ${getErrorMessage(err)}`, 'error')
    }
    setDeleteConfirm(null)
  }, [deleteConfirm, fileOps, refreshDir, getParentDir])

  const handleInlineSubmit = useCallback(async () => {
    if (!inlineInput || !inlineValue.trim()) {
      setInlineInput(null)
      return
    }

    const name = inlineValue.trim()
    const sep = rootPath.includes('/') ? '/' : '\\'

    try {
      if (inlineInput.type === 'new-file') {
        const path = `${inlineInput.parentDir}${sep}${name}`
        await fileOps.writeFile(path, '')
        refreshDir(inlineInput.parentDir)
        showToast(`Created ${name}`, 'success')
        onOpenFile(path, name)
      } else if (inlineInput.type === 'new-folder') {
        const path = `${inlineInput.parentDir}${sep}${name}`
        await fileOps.mkdir(path)
        refreshDir(inlineInput.parentDir)
        showToast(`Created folder ${name}`, 'success')
      } else if (inlineInput.type === 'rename') {
        const parentDir = inlineInput.parentDir
        const newPath = `${parentDir}${sep}${name}`
        await fileOps.rename(inlineInput.entry.path, newPath)
        refreshDir(parentDir)
        showToast(`Renamed to ${name}`, 'success')
      }
    } catch (err) {
      showToast(`Failed: ${getErrorMessage(err)}`, 'error')
    }
    setInlineInput(null)
  }, [inlineInput, inlineValue, rootPath, fileOps, refreshDir, onOpenFile])

  const handleInlineKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleInlineSubmit()
    } else if (e.key === 'Escape') {
      setInlineInput(null)
    }
  }, [handleInlineSubmit])

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path)
    showToast('Path copied', 'info', 1500)
    setContextMenu(null)
  }, [])

  const handleCopyRelativePath = useCallback((relativePath: string) => {
    navigator.clipboard.writeText(relativePath)
    showToast('Relative path copied', 'info', 1500)
  }, [])

  const handleStage = useCallback(async (paths: string[]) => {
    if (!gitOps) return
    try {
      await gitOps.stage(paths)
      onRefreshGit()
      showToast('Staged', 'success', 1500)
    } catch (err) {
      showToast(`Stage failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefreshGit])

  const handleUnstage = useCallback(async (paths: string[]) => {
    if (!gitOps) return
    try {
      await gitOps.unstage(paths)
      onRefreshGit()
      showToast('Unstaged', 'success', 1500)
    } catch (err) {
      showToast(`Unstage failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefreshGit])

  const handleRevert = useCallback(async (paths: string[]) => {
    if (!gitOps) return
    try {
      await gitOps.revert(paths)
      onRefreshGit()
      refreshDir(getParentDir(paths[0]))
      showToast('Reverted', 'success', 1500)
    } catch (err) {
      showToast(`Revert failed: ${getErrorMessage(err)}`, 'error')
    }
  }, [gitOps, onRefreshGit, refreshDir, getParentDir])

  const handleBulkDelete = useCallback(() => {
    setBulkDeletePaths(new Set(selectedPaths))
    setContextMenu(null)
  }, [selectedPaths])

  const confirmBulkDelete = useCallback(async () => {
    if (!bulkDeletePaths || bulkDeletePaths.size === 0) return
    const paths = Array.from(bulkDeletePaths)
    const dirsToRefresh = new Set<string>()
    let deleted = 0
    for (const p of paths) {
      try {
        const isDir = dirContents.get(getParentDir(p))?.entries.find(e => e.path === p)?.isDir ?? false
        await fileOps.delete(p, isDir)
        dirsToRefresh.add(getParentDir(p))
        deleted++
      } catch {
        // continue deleting the rest
      }
    }
    for (const d of dirsToRefresh) refreshDir(d)
    showToast(`Deleted ${deleted} item${deleted !== 1 ? 's' : ''}`, 'success')
    setSelectedPaths(new Set())
    setBulkDeletePaths(null)
  }, [bulkDeletePaths, dirContents, fileOps, getParentDir, refreshDir])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: WorkspaceFileEntry) => {
    e.preventDefault()
    e.stopPropagation()

    // If right-clicking an item in the multi-selection, show bulk menu
    if (selectedPaths.size > 1 && selectedPaths.has(entry.path)) {
      const count = selectedPaths.size
      const items: MenuItem[] = [
        { id: 'bulk-delete', label: `Delete ${count} Items`, action: handleBulkDelete },
      ]
      setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
      return
    }

    // Otherwise, single-select this item and show normal menu
    setSelectedPaths(new Set([entry.path]))
    setLastClickedPath(entry.path)

    const parentDir = entry.isDir ? entry.path : getParentDir(entry.path)
    const items = getFileExplorerMenuItems(
      {
        entry,
        parentDir,
        isGitRepo,
        gitStatus: getFileStatus(entry.path),
        rootPath,
      },
      {
        onOpen: onOpenFile,
        onNewFile: handleNewFile,
        onNewFolder: handleNewFolder,
        onRename: handleRename,
        onDelete: handleDelete,
        onCopyPath: handleCopyPath,
        onCopyRelativePath: handleCopyRelativePath,
        onStage: handleStage,
        onUnstage: handleUnstage,
        onRevert: handleRevert,
        onViewDiff: onViewDiff,
        onViewBlame: onViewBlame,
      },
    )
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [selectedPaths, handleBulkDelete, getParentDir, isGitRepo, getFileStatus, rootPath, onOpenFile, handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, handleCopyRelativePath, handleStage, handleUnstage, handleRevert, onViewDiff, onViewBlame])

  const handleTreeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const entry: WorkspaceFileEntry = { name: '', path: rootPath, isDir: true, size: 0, modified: null }
    const items = getFileExplorerMenuItems(
      { entry, parentDir: rootPath, isGitRepo, gitStatus: undefined, rootPath },
      {
        onOpen: onOpenFile,
        onNewFile: handleNewFile,
        onNewFolder: handleNewFolder,
        onRename: handleRename,
        onDelete: handleDelete,
        onCopyPath: handleCopyPath,
        onCopyRelativePath: handleCopyRelativePath,
        onStage: handleStage,
        onUnstage: handleUnstage,
        onRevert: handleRevert,
        onViewDiff: onViewDiff,
        onViewBlame: onViewBlame,
      },
    )
    setContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [rootPath, isGitRepo, onOpenFile, handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, handleCopyRelativePath, handleStage, handleUnstage, handleRevert, onViewDiff, onViewBlame])

  const getVisiblePaths = useCallback((): string[] => {
    const paths: string[] = []
    const walk = (dirPath: string) => {
      const contents = dirContents.get(dirPath)
      if (!contents) return
      for (const entry of contents.entries) {
        paths.push(entry.path)
        if (entry.isDir && expandedDirs.has(entry.path)) {
          walk(entry.path)
        }
      }
    }
    walk(rootPath)
    return paths
  }, [dirContents, expandedDirs, rootPath])

  const handleFileClick = useCallback((e: React.MouseEvent, entry: WorkspaceFileEntry) => {
    const isCtrlCmd = e.metaKey || e.ctrlKey
    const isShift = e.shiftKey

    if (isShift && lastClickedPath) {
      const visible = getVisiblePaths()
      const idx1 = visible.indexOf(lastClickedPath)
      const idx2 = visible.indexOf(entry.path)
      if (idx1 !== -1 && idx2 !== -1) {
        const [start, end] = idx1 <= idx2 ? [idx1, idx2] : [idx2, idx1]
        setSelectedPaths(new Set(visible.slice(start, end + 1)))
      }
    } else if (isCtrlCmd) {
      setSelectedPaths(prev => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      setLastClickedPath(entry.path)
    } else {
      setSelectedPaths(new Set([entry.path]))
      setLastClickedPath(entry.path)
      if (entry.isDir) {
        onToggleDir(entry.path)
      }
    }
    onSelectPath(entry.path)
  }, [onSelectPath, onToggleDir, lastClickedPath, getVisiblePaths])

  const handleFileDoubleClick = useCallback((entry: WorkspaceFileEntry) => {
    if (!entry.isDir) {
      onOpenFile(entry.path, entry.name)
    }
  }, [onOpenFile])

  const rootName = (() => {
    const trimmed = rootPath.replace(/[/\\]+$/, '')
    const sep = trimmed.includes('/') ? '/' : '\\'
    return trimmed.split(sep).pop() || trimmed || rootPath
  })()

  const renderInlineInput = (depth: number, isFolder: boolean) => (
    <div className="workspace-file-entry" style={{ paddingLeft: depth * 16 + 4 }}>
      <span className="workspace-dir-toggle" />
      <span className="workspace-file-entry-icon">{isFolder ? '📁' : '📄'}</span>
      <input
        ref={inlineInputRef}
        className="workspace-inline-input"
        value={inlineValue}
        onChange={e => setInlineValue(e.target.value)}
        onKeyDown={handleInlineKeyDown}
        onBlur={handleInlineSubmit}
        placeholder={isFolder ? 'folder name' : 'filename'}
      />
    </div>
  )

  const renderEntry = (entry: WorkspaceFileEntry, depth: number) => {
    const isExpanded = expandedDirs.has(entry.path)
    const isSelected = selectedPaths.has(entry.path)
    const gitStatus = getFileStatus(entry.path)
    const statusLabel = gitStatus ? GIT_STATUS_LABELS[gitStatus.status] : ''
    const isRenaming = inlineInput?.type === 'rename' && inlineInput.entry.path === entry.path

    if (filter && !entry.name.toLowerCase().includes(filter.toLowerCase())) {
      if (!entry.isDir) return null
    }

    if (isRenaming) {
      return (
        <div key={entry.path}>
          <div className="workspace-file-entry selected" style={{ paddingLeft: depth * 16 + 4 }}>
            {entry.isDir ? (
              <span className="workspace-dir-toggle">{isExpanded ? '▾' : '▸'}</span>
            ) : (
              <span className="workspace-dir-toggle" />
            )}
            <FileIcon name={entry.name} isDir={entry.isDir} isExpanded={isExpanded} />
            <input
              ref={inlineInputRef}
              className="workspace-inline-input"
              value={inlineValue}
              onChange={e => setInlineValue(e.target.value)}
              onKeyDown={handleInlineKeyDown}
              onBlur={handleInlineSubmit}
            />
          </div>
        </div>
      )
    }

    return (
      <div key={entry.path}>
        <div
          className={`workspace-file-entry ${isSelected ? 'selected' : ''} ${gitStatus?.status === 'deleted' ? 'deleted' : ''}`}
          style={{ paddingLeft: depth * 16 + 4 }}
          onClick={(e) => handleFileClick(e, entry)}
          onDoubleClick={() => handleFileDoubleClick(entry)}
          onContextMenu={(e) => handleContextMenu(e, entry)}
        >
          {entry.isDir ? (
            <span className="workspace-dir-toggle">{isExpanded ? '▾' : '▸'}</span>
          ) : (
            <span className="workspace-dir-toggle" />
          )}
          <FileIcon name={entry.name} isDir={entry.isDir} isExpanded={isExpanded} />
          <span className="workspace-file-entry-name">{entry.name}</span>
          {statusLabel && (
            <span className={`workspace-file-entry-git ${gitStatus?.status || ''}`}>
              {statusLabel}
            </span>
          )}
        </div>
        {entry.isDir && isExpanded && renderDirChildren(entry.path, depth + 1)}
      </div>
    )
  }

  const renderDirChildren = (dirPath: string, depth: number) => {
    const contents = dirContents.get(dirPath)

    const showNewFileInput = inlineInput?.type === 'new-file' && inlineInput.parentDir === dirPath
    const showNewFolderInput = inlineInput?.type === 'new-folder' && inlineInput.parentDir === dirPath

    if (!contents || contents.loading) {
      return (
        <div className="workspace-file-entry" style={{ paddingLeft: depth * 16 + 4 }}>
          <span className="workspace-file-entry-name" style={{ color: 'var(--color-text-secondary)' }}>
            Loading...
          </span>
        </div>
      )
    }
    if (contents.error) {
      return (
        <div className="workspace-file-entry" style={{ paddingLeft: depth * 16 + 4 }}>
          <span className="workspace-file-entry-name" style={{ color: 'var(--color-error)' }}>
            {contents.error}
          </span>
        </div>
      )
    }
    return (
      <>
        {showNewFolderInput && renderInlineInput(depth, true)}
        {showNewFileInput && renderInlineInput(depth, false)}
        {contents.entries.map(entry => renderEntry(entry, depth))}
      </>
    )
  }

  const modifiedCount = gitStatuses.filter(s => s.status !== 'clean').length
  const stagedCount = gitStatuses.filter(s => s.staged).length

  return (
    <>
      <div className="workspace-explorer-header">
        <span>{rootName}</span>
        <div className="workspace-explorer-header-actions">
          <button
            className="workspace-explorer-header-btn"
            onClick={() => handleNewFile(selectedPath && expandedDirs.has(selectedPath) ? selectedPath : rootPath)}
            title="New File"
          >
            +
          </button>
          <button
            className="workspace-explorer-header-btn"
            onClick={() => handleNewFolder(selectedPath && expandedDirs.has(selectedPath) ? selectedPath : rootPath)}
            title="New Folder"
          >
            📁+
          </button>
          <button className="workspace-explorer-header-btn" onClick={refreshAll} title="Refresh">
            ⟳
          </button>
        </div>
      </div>

      {isGitRepo && gitBranch && (
        <div className="workspace-git-branch">
          <span>⎇</span>
          <span className="workspace-git-branch-name">{gitBranch.name}</span>
          {(gitBranch.ahead > 0 || gitBranch.behind > 0) && (
            <span className="workspace-git-ahead-behind">
              {gitBranch.ahead > 0 && `↑${gitBranch.ahead}`}
              {gitBranch.behind > 0 && ` ↓${gitBranch.behind}`}
            </span>
          )}
          {modifiedCount > 0 && (
            <span className="workspace-git-ahead-behind">
              {modifiedCount}M{stagedCount > 0 && ` ${stagedCount}S`}
            </span>
          )}
        </div>
      )}

      <div className="workspace-file-tree" onContextMenu={handleTreeContextMenu} onClick={(e) => { if (e.target === e.currentTarget) { setSelectedPaths(new Set()); onSelectPath(null) } }}>
        {renderDirChildren(rootPath, 0)}
      </div>

      <ContextMenu
        position={contextMenu?.position ?? null}
        items={contextMenu?.items ?? []}
        onClose={() => setContextMenu(null)}
      />

      {/* Delete Confirmation — single item */}
      {deleteConfirm && (
        <div className="workspace-new-dialog-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="workspace-new-dialog" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <h3>Delete {deleteConfirm.isDir ? 'Folder' : 'File'}</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-small)', margin: '0 0 16px' }}>
              Are you sure you want to delete <strong style={{ color: 'var(--color-text-primary)' }}>{deleteConfirm.name}</strong>?
              {deleteConfirm.isDir && ' This will delete all contents.'}
            </p>
            <div className="workspace-new-dialog-actions">
              <button className="workspace-new-dialog-btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="workspace-new-dialog-btn" style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)', color: 'white' }} onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation — bulk */}
      {bulkDeletePaths && bulkDeletePaths.size > 0 && (
        <div className="workspace-new-dialog-overlay" onClick={() => setBulkDeletePaths(null)}>
          <div className="workspace-new-dialog" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <h3>Delete {bulkDeletePaths.size} Items</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-small)', margin: '0 0 16px' }}>
              Are you sure you want to delete <strong style={{ color: 'var(--color-text-primary)' }}>{bulkDeletePaths.size} items</strong>?
              This cannot be undone.
            </p>
            <div className="workspace-new-dialog-actions">
              <button className="workspace-new-dialog-btn" onClick={() => setBulkDeletePaths(null)}>Cancel</button>
              <button className="workspace-new-dialog-btn" style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)', color: 'white' }} onClick={confirmBulkDelete}>
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
