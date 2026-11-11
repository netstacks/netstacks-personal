import type { AxiosInstance } from 'axios'
import { getClient } from '../api/client'
import type {
  GitOps,
  GitFileStatus,
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
