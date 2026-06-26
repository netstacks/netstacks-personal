import { useState, useEffect, useCallback } from 'react'
import type { GitOps } from '../../types/workspace'
import './WorkspaceDiffViewer.css'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceDiffViewerProps {
  filePath: string
  gitOps: GitOps
}

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface DiffLine {
  type: 'context' | 'added' | 'removed'
  content: string
  oldLineNum: number | null
  newLineNum: number | null
}

function parseDiff(raw: string): { hunks: DiffHunk[]; additions: number; deletions: number } {
  const lines = raw.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
        current = { header: line, lines: [] }
        hunks.push(current)
      }
      continue
    }

    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue
    }

    if (!current) continue

    if (line.startsWith('+')) {
      current.lines.push({ type: 'added', content: line.slice(1), oldLineNum: null, newLineNum: newLine })
      newLine++
      additions++
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'removed', content: line.slice(1), oldLineNum: oldLine, newLineNum: null })
      oldLine++
      deletions++
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line
      current.lines.push({ type: 'context', content, oldLineNum: oldLine, newLineNum: newLine })
      oldLine++
      newLine++
    }
  }

  return { hunks, additions, deletions }
}

export default function WorkspaceDiffViewer({ filePath, gitOps }: WorkspaceDiffViewerProps) {
  const [rawDiff, setRawDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDiff = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const diff = await gitOps.diff(filePath)
      setRawDiff(diff)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load diff'))
    } finally {
      setLoading(false)
    }
  }, [filePath, gitOps])

  useEffect(() => {
    fetchDiff()
  }, [fetchDiff])

  if (loading) {
    return <div className="workspace-diff-loading">Loading diff...</div>
  }

  if (error) {
    return <div className="workspace-diff-empty">{error}</div>
  }

  if (!rawDiff || rawDiff.trim().length === 0) {
    return <div className="workspace-diff-empty">No changes</div>
  }

  const { hunks, additions, deletions } = parseDiff(rawDiff)
  const fileName = filePath.split('/').pop() || filePath

  return (
    <div className="workspace-diff-viewer">
      <div className="workspace-diff-header">
        <span>Diff:</span>
        <span className="workspace-diff-header-path">{fileName}</span>
        <div className="workspace-diff-stats">
          <span className="workspace-diff-stat-add">+{additions}</span>
          <span className="workspace-diff-stat-del">-{deletions}</span>
        </div>
        <button className="workspace-diff-refresh-btn" onClick={fetchDiff} title="Refresh diff">
          Refresh
        </button>
      </div>
      <div className="workspace-diff-content">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            <div className="workspace-diff-hunk-header">{hunk.header}</div>
            {hunk.lines.map((line, li) => (
              <div key={`${hi}-${li}`} className={`workspace-diff-line ${line.type}`}>
                <span className="workspace-diff-line-number">
                  {line.oldLineNum ?? ''}
                </span>
                <span className="workspace-diff-line-number">
                  {line.newLineNum ?? ''}
                </span>
                <span className="workspace-diff-line-marker">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                <span className="workspace-diff-line-text">{line.content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
