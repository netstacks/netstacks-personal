import type { AxiosInstance } from 'axios'
import { getClient } from '../api/client'
import type {
  GitOps,
  GitFileStatus,
  GitStatusCode,
  GitBranchInfo,
  CommitInfo,
  BranchEntry,
  StashEntry,
  BlameLine,
  RebasePlanItem,
} from '../types/workspace'

// AgentGitOps — calls the local (or remote) agent for all git operations.
// Pass an optional httpClient to target a remote agent instead of the local sidecar.
export class AgentGitOps implements GitOps {
  private workspaceRoot: string
  private http: AxiosInstance

  constructor(workspaceRoot: string, httpClient?: AxiosInstance) {
    this.workspaceRoot = workspaceRoot
    this.http = httpClient || getClient().http
  }

  private async post<T = unknown>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    const { data } = await this.http.post(endpoint, {
      workspace_root: this.workspaceRoot,
      ...body,
    })
    return data as T
  }

  async isRepo(): Promise<boolean> {
    const data = await this.post<{ is_repo: boolean }>('/workspace/git/status')
    return data.is_repo ?? false
  }

  async status(): Promise<GitFileStatus[]> {
    const data = await this.post<{ files: GitFileStatus[] }>('/workspace/git/status')
    return data.files ?? []
  }

  async branch(): Promise<GitBranchInfo | null> {
    const data = await this.post<{ branch: GitBranchInfo | null }>('/workspace/git/status')
    return data.branch ?? null
  }

  async diff(filePath?: string, opts?: { staged?: boolean }): Promise<string> {
    const data = await this.post<{ diff: string }>('/workspace/git/diff', {
      path: filePath ?? null,
      staged: opts?.staged ?? false,
    })
    return data.diff ?? ''
  }

  async log(limit = 50, filePath?: string): Promise<CommitInfo[]> {
    const data = await this.post<{ commits: CommitInfo[] }>('/workspace/git/log', {
      limit,
      path: filePath ?? null,
    })
    return data.commits ?? []
  }

  async blame(filePath: string): Promise<BlameLine[]> {
    const data = await this.post<{ lines: BlameLine[] }>('/workspace/git/blame', {
      path: filePath,
    })
    return data.lines ?? []
  }

  async listBranches(): Promise<BranchEntry[]> {
    const data = await this.post<{ branches: BranchEntry[] }>('/workspace/git/branches')
    return data.branches ?? []
  }

  async listStashes(): Promise<StashEntry[]> {
    const data = await this.post<{ stashes: StashEntry[] }>('/workspace/git/stashes')
    return data.stashes ?? []
  }

  async stage(paths: string[]): Promise<void> {
    await this.post('/workspace/git/stage', { paths })
  }

  async unstage(paths: string[]): Promise<void> {
    await this.post('/workspace/git/unstage', { paths })
  }

  async revert(paths: string[]): Promise<void> {
    await this.post('/workspace/git/revert', { paths })
  }

  async commit(message: string, paths?: string[]): Promise<CommitInfo> {
    const data = await this.post<{ commit: CommitInfo }>('/workspace/git/commit', {
      message,
      paths: paths ?? [],
    })
    return data.commit
  }

  async push(force = false): Promise<void> {
    await this.post('/workspace/git/push', { force })
  }

  async pull(rebase = false): Promise<void> {
    await this.post('/workspace/git/pull', { rebase })
  }

  async fetch(): Promise<void> {
    await this.post('/workspace/git/fetch')
  }

  async createBranch(name: string, from?: string): Promise<void> {
    await this.post('/workspace/git/branch/create', { name, from: from ?? null })
  }

  async switchBranch(name: string): Promise<void> {
    await this.post('/workspace/git/branch/switch', { name })
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.post('/workspace/git/branch/delete', { name, force })
  }

  async merge(branch: string): Promise<void> {
    await this.post('/workspace/git/merge', { branch })
  }

  async stash(action: 'push' | 'pop' | 'drop', index?: number): Promise<void> {
    await this.post('/workspace/git/stash', { action, index: index ?? null })
  }

  async init(): Promise<void> {
    await this.post('/workspace/git/init')
  }

  async commitAmend(message: string): Promise<CommitInfo> {
    const data = await this.post<{ commit: CommitInfo }>('/workspace/git/commit/amend', {
      message,
    })
    return data.commit
  }

  async rebasePlan(count = 20): Promise<CommitInfo[]> {
    const data = await this.post<{ commits: CommitInfo[] }>('/workspace/git/rebase/plan', {
      count,
    })
    return data.commits ?? []
  }

  async rebaseApply(baseHash: string, plan: RebasePlanItem[]): Promise<void> {
    await this.post('/workspace/git/rebase/apply', {
      base_hash: baseHash,
      plan,
    })
  }

  async rebaseAbort(): Promise<void> {
    await this.post('/workspace/git/rebase/abort')
  }

  async generateCommitMessage(): Promise<string> {
    const data = await this.post<{ message: string }>('/workspace/git/generate-commit-message')
    return data.message ?? ''
  }
}

// RemoteGitOps — runs git over SSH session.
// New methods are stubbed here; full remote implementation in Phase 5.
export class RemoteGitOps implements GitOps {
  private sessionId: string
  private cwd: string

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId
    this.cwd = cwd
  }

  private async run(args: string[]): Promise<string> {
    const command = `cd ${this.shellEscape(this.cwd)} && git ${args.join(' ')}`
    const { data } = await getClient().http.post('/ai/ssh-execute', {
      session_id: this.sessionId,
      commands: [command],
    })
    if (data.error) throw new Error(data.error)
    return data.results?.[0]?.output || data.output || ''
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<GitFileStatus[]> {
    const output = await this.run(['status', '--porcelain'])
    return parseStatusOutput(output)
  }

  async branch(): Promise<GitBranchInfo | null> {
    const output = await this.run(['status', '--branch', '--porcelain'])
    return parseBranchOutput(output)
  }

  async diff(filePath?: string, opts?: { staged?: boolean }): Promise<string> {
    const args: string[] = ['diff']
    if (opts?.staged) args.push('--cached')
    if (filePath) args.push('--', filePath)
    return this.run(args)
  }

  private notImplemented(method: string): never {
    throw new Error(`RemoteGitOps.${method} not implemented until Phase 5`)
  }

  async log(): Promise<CommitInfo[]> { return this.notImplemented('log') }
  async blame(): Promise<BlameLine[]> { return this.notImplemented('blame') }
  async listBranches(): Promise<BranchEntry[]> { return this.notImplemented('listBranches') }
  async listStashes(): Promise<StashEntry[]> { return this.notImplemented('listStashes') }
  async stage(): Promise<void> { return this.notImplemented('stage') }
  async unstage(): Promise<void> { return this.notImplemented('unstage') }
  async revert(): Promise<void> { return this.notImplemented('revert') }
  async commit(): Promise<CommitInfo> { return this.notImplemented('commit') }
  async push(): Promise<void> { return this.notImplemented('push') }
  async pull(): Promise<void> { return this.notImplemented('pull') }
  async fetch(): Promise<void> { return this.notImplemented('fetch') }
  async createBranch(): Promise<void> { return this.notImplemented('createBranch') }
  async switchBranch(): Promise<void> { return this.notImplemented('switchBranch') }
  async deleteBranch(): Promise<void> { return this.notImplemented('deleteBranch') }
  async merge(): Promise<void> { return this.notImplemented('merge') }
  async stash(): Promise<void> { return this.notImplemented('stash') }
  async init(): Promise<void> { return this.notImplemented('init') }
  async commitAmend(): Promise<CommitInfo> { return this.notImplemented('commitAmend') }
  async rebasePlan(): Promise<CommitInfo[]> { return this.notImplemented('rebasePlan') }
  async rebaseApply(): Promise<void> { return this.notImplemented('rebaseApply') }
  async rebaseAbort(): Promise<void> { return this.notImplemented('rebaseAbort') }
  async generateCommitMessage(): Promise<string> { return this.notImplemented('generateCommitMessage') }
}

// ── Shared parsers (used by RemoteGitOps) ──────────────────────────────────

function parseStatusOutput(output: string): GitFileStatus[] {
  return output
    .trim()
    .split('\n')
    .filter((l) => l.length >= 4)
    .map((line) => {
      const x = line[0]
      const y = line[1]
      const rest = line.slice(3)
      const parts = rest.split(' -> ')
      const { status, staged } = parseStatusCode(x, y)
      return {
        path: parts[parts.length - 1],
        status,
        staged,
        oldPath: parts.length > 1 ? parts[0] : undefined,
      }
    })
}

function parseStatusCode(x: string, y: string): { status: GitStatusCode; staged: boolean } {
  if (x === '?' && y === '?') return { status: 'untracked', staged: false }
  if (x === 'A') return { status: 'added', staged: true }
  if (x === 'D') return { status: 'deleted', staged: true }
  if (x === 'R') return { status: 'renamed', staged: true }
  if (x === 'C') return { status: 'copied', staged: true }
  if (x === 'M') return { status: 'modified', staged: true }
  if (y === 'M') return { status: 'modified', staged: false }
  if (y === 'D') return { status: 'deleted', staged: false }
  return { status: 'modified', staged: x !== ' ' }
}

function parseBranchOutput(output: string): GitBranchInfo | null {
  for (const line of output.trim().split('\n')) {
    if (line.startsWith('## ')) {
      const match = line.match(
        /^## ([^.\s]+)(?:\.\.\.(\S+))?\s*(?:\[ahead (\d+)(?:, behind (\d+))?\])?/,
      )
      if (!match) {
        const simpleName = line.slice(3).trim().split('...')[0]
        return { name: simpleName || 'HEAD', ahead: 0, behind: 0 }
      }
      return {
        name: match[1],
        ahead: match[3] ? parseInt(match[3], 10) : 0,
        behind: match[4] ? parseInt(match[4], 10) : 0,
      }
    }
  }
  return null
}
