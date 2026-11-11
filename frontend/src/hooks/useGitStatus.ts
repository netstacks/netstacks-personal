import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitOps, GitFileStatus, GitBranchInfo } from '../types/workspace'

import { getErrorMessage } from '../api/errors'
interface UseGitStatusOptions {
  gitOps: GitOps | null
  pollIntervalMs?: number
  enabled?: boolean
}

interface UseGitStatusReturn {
  branch: GitBranchInfo | null
  statuses: GitFileStatus[]
  isGitRepo: boolean
  isLoading: boolean
  error: string | null
  refresh: () => void
  getFileStatus: (path: string) => GitFileStatus | undefined
}

export function useGitStatus({
  gitOps,
  pollIntervalMs = 5000,
  enabled = true,
}: UseGitStatusOptions): UseGitStatusReturn {
  const [branch, setBranch] = useState<GitBranchInfo | null>(null)
  const [statuses, setStatuses] = useState<GitFileStatus[]>([])
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!gitOps || !enabled) return
    try {
      setIsLoading(true)
      setError(null)
      const isRepo = await gitOps.isRepo()
      setIsGitRepo(isRepo)
      if (!isRepo) {
        setBranch(null)
        setStatuses([])
        return
      }
      const [branchInfo, statusList] = await Promise.all([
        gitOps.branch(),
        gitOps.status(),
      ])
      setBranch(branchInfo)
      setStatuses(statusList)
    } catch (err) {
      setError(getErrorMessage(err, 'Git status failed'))
    } finally {
      setIsLoading(false)
    }
  }, [gitOps, enabled])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!gitOps || !enabled || !isGitRepo) return
    intervalRef.current = setInterval(refresh, pollIntervalMs)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [gitOps, enabled, isGitRepo, pollIntervalMs, refresh])

  const getFileStatus = useCallback(
    (path: string) => statuses.find(s => path.endsWith(s.path)),
    [statuses]
  )

  return { branch, statuses, isGitRepo, isLoading, error, refresh, getFileStatus }
}
