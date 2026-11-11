import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockPost = vi.fn()
vi.mock('../../api/client', () => ({
  getClient: () => ({ http: { post: mockPost } }),
}))

import { AgentGitOps } from '../gitOps'

const ROOT = '/home/user/myproject'

describe('AgentGitOps', () => {
  let ops: AgentGitOps

  beforeEach(() => {
    ops = new AgentGitOps(ROOT)
    mockPost.mockReset()
  })

  it('isRepo returns true when agent says is_repo', async () => {
    mockPost.mockResolvedValue({ data: { is_repo: true, branch: null, files: [] } })
    expect(await ops.isRepo()).toBe(true)
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/status', {
      workspace_root: ROOT,
    })
  })

  it('isRepo returns false when agent says not a repo', async () => {
    mockPost.mockResolvedValue({ data: { is_repo: false, branch: null, files: [] } })
    expect(await ops.isRepo()).toBe(false)
  })

  it('status returns parsed files', async () => {
    mockPost.mockResolvedValue({
      data: {
        is_repo: true,
        branch: null,
        files: [{ path: 'src/main.ts', status: 'modified', staged: false }],
      },
    })
    const result = await ops.status()
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/main.ts')
    expect(result[0].status).toBe('modified')
  })

  it('branch returns branch info', async () => {
    mockPost.mockResolvedValue({
      data: {
        is_repo: true,
        branch: { name: 'main', ahead: 1, behind: 0 },
        files: [],
      },
    })
    const result = await ops.branch()
    expect(result?.name).toBe('main')
    expect(result?.ahead).toBe(1)
  })

  it('commit calls the commit endpoint', async () => {
    mockPost.mockResolvedValue({
      data: { commit: { hash: 'abc123', shortHash: 'abc', message: 'test', author: 'Me', date: '', branches: [] } },
    })
    const commit = await ops.commit('test commit', ['src/main.ts'])
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/commit', {
      workspace_root: ROOT,
      message: 'test commit',
      paths: ['src/main.ts'],
    })
    expect(commit.message).toBe('test')
  })

  it('stage calls stage endpoint', async () => {
    mockPost.mockResolvedValue({ data: { success: true } })
    await ops.stage(['a.ts', 'b.ts'])
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/stage', {
      workspace_root: ROOT,
      paths: ['a.ts', 'b.ts'],
    })
  })

  it('push calls push endpoint', async () => {
    mockPost.mockResolvedValue({ data: { success: true } })
    await ops.push(false)
    expect(mockPost).toHaveBeenCalledWith('/workspace/git/push', {
      workspace_root: ROOT,
      force: false,
    })
  })
})
