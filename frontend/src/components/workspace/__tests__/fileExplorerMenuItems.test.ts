import { describe, it, expect, vi } from 'vitest'
import { getFileExplorerMenuItems } from '../fileExplorerMenuItems'
import type { WorkspaceFileEntry, GitFileStatus } from '../../../types/workspace'

const makeEntry = (overrides: Partial<WorkspaceFileEntry> = {}): WorkspaceFileEntry => ({
  name: 'test.ts',
  path: '/project/src/test.ts',
  isDir: false,
  size: 100,
  modified: null,
  ...overrides,
})

const makeDirEntry = (overrides: Partial<WorkspaceFileEntry> = {}): WorkspaceFileEntry => ({
  name: 'src',
  path: '/project/src',
  isDir: true,
  size: 0,
  modified: null,
  ...overrides,
})

const makeCallbacks = () => ({
  onOpen: vi.fn(),
  onNewFile: vi.fn(),
  onNewFolder: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyRelativePath: vi.fn(),
  onStage: vi.fn(),
  onUnstage: vi.fn(),
  onRevert: vi.fn(),
  onViewDiff: vi.fn(),
  onViewBlame: vi.fn(),
})

describe('getFileExplorerMenuItems', () => {
  it('returns Open as first item for files', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    const nonDividers = items.filter(i => !i.divider)
    expect(nonDividers[0].id).toBe('open')
    expect(nonDividers[0].label).toBe('Open')
  })

  it('does not include Open for directories', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeDirEntry(), parentDir: '/project', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'open')).toBeUndefined()
  })

  it('includes git actions when isGitRepo is true and file has unstaged changes', () => {
    const cb = makeCallbacks()
    const status: GitFileStatus = { path: 'src/test.ts', status: 'modified', staged: false }
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: status, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage')).toBeDefined()
    expect(items.find(i => i.id === 'git-unstage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-revert')).toBeDefined()
    expect(items.find(i => i.id === 'git-diff')).toBeDefined()
    expect(items.find(i => i.id === 'git-blame')).toBeDefined()
  })

  it('shows Unstage instead of Stage when file is staged', () => {
    const cb = makeCallbacks()
    const status: GitFileStatus = { path: 'src/test.ts', status: 'modified', staged: true }
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: status, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-unstage')).toBeDefined()
    expect(items.find(i => i.id === 'git-stage')).toBeUndefined()
  })

  it('omits git actions when isGitRepo is false', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-unstage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-revert')).toBeUndefined()
    expect(items.find(i => i.id === 'git-diff')).toBeUndefined()
    expect(items.find(i => i.id === 'git-blame')).toBeUndefined()
  })

  it('includes Stage All in Folder for directories in git repos', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeDirEntry(), parentDir: '/project', isGitRepo: true, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage-folder')).toBeDefined()
  })

  it('always includes New File, New Folder, Copy Path', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'new-file')).toBeDefined()
    expect(items.find(i => i.id === 'new-folder')).toBeDefined()
    expect(items.find(i => i.id === 'copy-path')).toBeDefined()
  })

  it('includes Rename and Delete for named entries', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'rename')).toBeDefined()
    expect(items.find(i => i.id === 'delete')).toBeDefined()
  })

  it('omits Rename and Delete for root entry (empty name)', () => {
    const cb = makeCallbacks()
    const entry = makeEntry({ name: '', path: '/project' })
    const items = getFileExplorerMenuItems(
      { entry, parentDir: '/project', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'rename')).toBeUndefined()
    expect(items.find(i => i.id === 'delete')).toBeUndefined()
  })

  it('calls onStage with file path when Stage action is triggered', () => {
    const cb = makeCallbacks()
    const status: GitFileStatus = { path: 'src/test.ts', status: 'modified', staged: false }
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: status, rootPath: '/project' },
      cb,
    )
    items.find(i => i.id === 'git-stage')!.action()
    expect(cb.onStage).toHaveBeenCalledWith(['/project/src/test.ts'])
  })

  it('computes relative path for Copy Relative Path', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: false, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    items.find(i => i.id === 'copy-relative-path')!.action()
    expect(cb.onCopyRelativePath).toHaveBeenCalledWith('src/test.ts')
  })

  it('does not show git actions for clean files (no git status)', () => {
    const cb = makeCallbacks()
    const items = getFileExplorerMenuItems(
      { entry: makeEntry(), parentDir: '/project/src', isGitRepo: true, gitStatus: undefined, rootPath: '/project' },
      cb,
    )
    expect(items.find(i => i.id === 'git-stage')).toBeUndefined()
    expect(items.find(i => i.id === 'git-revert')).toBeUndefined()
    expect(items.find(i => i.id === 'git-diff')).toBeDefined()
    expect(items.find(i => i.id === 'git-blame')).toBeDefined()
  })
})
