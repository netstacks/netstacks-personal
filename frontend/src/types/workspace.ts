export type WorkspaceMode = 'local' | 'remote'

export type AiToolType = 'claude' | 'aider' | 'opencode' | 'kimicode' | 'none' | 'custom' | 'netstacks-agent'

export interface AiToolConfig {
  tool: AiToolType
  customCommand?: string
  launchArgs?: string
}

export type InnerTabType = 'code-editor' | 'browser' | 'diff' | 'blame' | 'image' | 'markdown'

export type Zone1Tab = 'files' | 'git'
export type GitPanelTab = 'changes' | 'history' | 'branches'

export interface InnerTab {
  id: string
  type: InnerTabType
  title: string
  filePath?: string
  url?: string
  isModified?: boolean
}

export interface TerminalTab {
  id: string
  title: string
  command?: string
  isAiCli?: boolean
  // Optional saved-session metadata. When present, the sub-panel renders
  // a connected SSH/Telnet terminal (same shape as top-level session tabs)
  // instead of a local bash shell. Absent → local bash in workspaceRoot.
  sessionId?: string
  protocol?: 'ssh' | 'telnet'
  cliFlavor?: import('./enrichment').CliFlavor
  profileId?: string
  /** Saved session color (for visual matching with top-level tabs) */
  color?: string
}

export type GitStatusCode = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied' | 'clean'

export interface GitFileStatus {
  path: string
  status: GitStatusCode
  staged: boolean
  oldPath?: string
}

export interface GitBranchInfo {
  name: string
  ahead: number
  behind: number
}

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  branches: string[]
}

export interface BranchEntry {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream?: string
}

export interface StashEntry {
  index: number
  message: string
  branch: string
}

export interface RebasePlanItem {
  hash: string
  action: 'pick' | 'squash' | 'drop'
  message?: string
}

export interface BlameLine {
  lineNumber: number
  hash: string
  author: string
  date: string
  content: string
}

export interface TunnelMapping {
  remotePort: number
  localPort: number
  description: string
}

// Runtime state (includes non-serializable fields like Set)
export interface WorkspaceState {
  id: string
  name: string
  mode: WorkspaceMode
  rootPath: string
  sessionId?: string
  sftpConnectionId?: string
  tunnels: TunnelMapping[]
  aiTool: AiToolConfig
  autoLaunchAi: boolean

  // Zone 1
  fileExplorerWidth: number
  expandedDirs: Set<string>
  selectedPath: string | null
  zone1Tab: Zone1Tab
  gitPanelTab: GitPanelTab

  // Zone 2
  innerTabs: InnerTab[]
  activeInnerTabId: string | null

  // Zone 3
  terminalPanelHeight: number
  terminalPanelCollapsed: boolean
  terminalTabs: TerminalTab[]
  activeTerminalTabId: string | null

  // Git
  gitBranch: GitBranchInfo | null
  gitStatus: GitFileStatus[]

  // Remote agent (transparent deployment)
  remoteAgentHost?: string
  remoteAgentPort?: number
  remoteAgentToken?: string
  remoteAgentId?: string
  remoteAgentStatus?: 'deploying' | 'connected' | 'failed'
  remoteAgentError?: string
}

// Serializable config saved to settings — everything needed to fully restore a workspace
export interface WorkspaceConfig {
  id: string
  name: string
  mode: WorkspaceMode
  rootPath: string
  sessionId?: string
  aiTool: AiToolConfig
  autoLaunchAi: boolean

  // Layout
  fileExplorerWidth: number
  terminalPanelHeight: number
  terminalPanelCollapsed: boolean
  expandedDirs: string[]
  selectedPath: string | null
  zone1Tab?: Zone1Tab
  gitPanelTab?: GitPanelTab

  // Open files (restored on reopen)
  openFiles: SavedInnerTab[]
  activeFileIndex: number | null

  // Terminal sessions (re-launched on reopen)
  terminalSessions: SavedTerminalTab[]
  activeTerminalIndex: number | null

  // Python execution preference
  pythonRunMode?: 'native' | 'netstacks' | null

  // Remote agent connection (persisted for reconnect)
  remoteAgentHost?: string
  remoteAgentPort?: number
  remoteAgentToken?: string
  remoteAgentId?: string
}

export interface SavedInnerTab {
  type: InnerTabType
  title: string
  filePath?: string
  url?: string
}

export interface SavedTerminalTab {
  title: string
  command?: string
  isAiCli?: boolean
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: number | null
  gitStatus?: GitStatusCode
}

export interface FileOps {
  readDir(path: string): Promise<WorkspaceFileEntry[]>
  readFile(path: string): Promise<string>
  readFileBinary(path: string): Promise<Uint8Array>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  delete(path: string, isDir: boolean): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface GitOps {
  // Read ops
  isRepo(): Promise<boolean>
  status(): Promise<GitFileStatus[]>
  branch(): Promise<GitBranchInfo | null>
  diff(filePath?: string, opts?: { staged?: boolean }): Promise<string>
  log(limit?: number, filePath?: string): Promise<CommitInfo[]>
  blame(filePath: string): Promise<BlameLine[]>
  listBranches(): Promise<BranchEntry[]>
  listStashes(): Promise<StashEntry[]>

  // Stage / unstage / revert
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  revert(paths: string[]): Promise<void>

  // Commit
  commit(message: string, paths?: string[]): Promise<CommitInfo>

  // Remote ops (use system git credentials in Phase 1; vault added in Phase 4)
  push(force?: boolean): Promise<void>
  pull(rebase?: boolean): Promise<void>
  fetch(): Promise<void>

  // Branch management
  createBranch(name: string, from?: string): Promise<void>
  switchBranch(name: string): Promise<void>
  deleteBranch(name: string, force?: boolean): Promise<void>
  merge(branch: string): Promise<void>

  // Stash
  stash(action: 'push' | 'pop' | 'drop', index?: number): Promise<void>

  // Init
  init(): Promise<void>

  // Commit history editing
  commitAmend(message: string): Promise<CommitInfo>
  rebasePlan(count?: number): Promise<CommitInfo[]>
  rebaseApply(baseHash: string, plan: RebasePlanItem[]): Promise<void>
  rebaseAbort(): Promise<void>

  // Commit message generation
  generateCommitMessage(): Promise<string>
}
