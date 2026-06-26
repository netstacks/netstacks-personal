import type { MenuItem } from '../ContextMenu'
import type { WorkspaceFileEntry, GitFileStatus } from '../../types/workspace'

export interface FileExplorerMenuContext {
  entry: WorkspaceFileEntry
  parentDir: string
  isGitRepo: boolean
  gitStatus: GitFileStatus | undefined
  rootPath: string
}

export interface FileExplorerMenuCallbacks {
  onOpen: (filePath: string, fileName: string) => void
  onNewFile: (parentDir: string) => void
  onNewFolder: (parentDir: string) => void
  onRename: (entry: WorkspaceFileEntry) => void
  onDelete: (entry: WorkspaceFileEntry) => void
  onCopyPath: (path: string) => void
  onCopyRelativePath: (relativePath: string) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onRevert: (paths: string[]) => void
  onViewDiff: (filePath: string) => void
  onViewBlame: (filePath: string) => void
}

const divider = (id: string): MenuItem => ({ id, label: '', divider: true, action: () => {} })

export function getFileExplorerMenuItems(
  ctx: FileExplorerMenuContext,
  cb: FileExplorerMenuCallbacks,
): MenuItem[] {
  const { entry, parentDir, isGitRepo, gitStatus, rootPath } = ctx
  const items: MenuItem[] = []
  const isFile = !entry.isDir
  const hasName = entry.name.length > 0

  // ── Group 1: Primary actions ──
  if (isFile) {
    items.push({
      id: 'open',
      label: 'Open',
      action: () => cb.onOpen(entry.path, entry.name),
    })
  }

  // ── Group 2: Git actions (only in git repos) ──
  if (isGitRepo) {
    if (isFile) {
      const hasChanges = gitStatus != null
      if (hasChanges) {
        items.push(divider('git-divider'))
        if (gitStatus.staged) {
          items.push({
            id: 'git-unstage',
            label: 'Unstage Changes',
            action: () => cb.onUnstage([entry.path]),
          })
        } else {
          items.push({
            id: 'git-stage',
            label: 'Stage Changes',
            action: () => cb.onStage([entry.path]),
          })
        }
        items.push({
          id: 'git-revert',
          label: 'Revert Changes',
          action: () => cb.onRevert([entry.path]),
        })
      } else {
        items.push(divider('git-divider'))
      }
      items.push({
        id: 'git-diff',
        label: 'View Diff',
        action: () => cb.onViewDiff(entry.path),
      })
      items.push({
        id: 'git-blame',
        label: 'Blame',
        action: () => cb.onViewBlame(entry.path),
      })
    } else {
      items.push(divider('git-divider'))
      items.push({
        id: 'git-stage-folder',
        label: 'Stage All in Folder',
        action: () => cb.onStage([entry.path]),
      })
    }
  }

  // ── Group 3: File CRUD ──
  items.push(divider('file-divider'))
  items.push({
    id: 'new-file',
    label: 'New File',
    action: () => cb.onNewFile(parentDir),
  })
  items.push({
    id: 'new-folder',
    label: 'New Folder',
    action: () => cb.onNewFolder(parentDir),
  })

  if (hasName) {
    items.push({
      id: 'rename',
      label: 'Rename',
      action: () => cb.onRename(entry),
    })
    items.push({
      id: 'delete',
      label: 'Delete',
      action: () => cb.onDelete(entry),
    })
  }

  // ── Group 4: Copy ──
  items.push(divider('copy-divider'))
  items.push({
    id: 'copy-path',
    label: 'Copy Path',
    action: () => cb.onCopyPath(entry.path),
  })
  if (hasName) {
    const sep = rootPath.includes('/') ? '/' : '\\'
    const relative = entry.path.startsWith(rootPath + sep)
      ? entry.path.slice(rootPath.length + 1)
      : entry.path
    items.push({
      id: 'copy-relative-path',
      label: 'Copy Relative Path',
      action: () => cb.onCopyRelativePath(relative),
    })
  }

  return items
}
