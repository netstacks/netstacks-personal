import { useState, useEffect, useCallback } from 'react'
import type { GitOps, BlameLine } from '../../types/workspace'
import './WorkspaceBlameViewer.css'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceBlameViewerProps {
  filePath: string
  gitOps: GitOps
}

function formatRelativeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return 'today'
    if (diffDays === 1) return '1d ago'
    if (diffDays < 30) return `${diffDays}d ago`
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`
    return `${Math.floor(diffDays / 365)}y ago`
  } catch {
    return dateStr.slice(0, 10)
  }
}

export default function WorkspaceBlameViewer({ filePath, gitOps }: WorkspaceBlameViewerProps) {
  const [lines, setLines] = useState<BlameLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchBlame = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await gitOps.blame(filePath)
      setLines(result)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load blame'))
    } finally {
      setLoading(false)
    }
  }, [filePath, gitOps])

  useEffect(() => {
    fetchBlame()
  }, [fetchBlame])

  if (loading) {
    return <div className="workspace-blame-loading">Loading blame...</div>
  }

  if (error) {
    return <div className="workspace-blame-empty">{error}</div>
  }

  if (lines.length === 0) {
    return <div className="workspace-blame-empty">No blame data</div>
  }

  const fileName = filePath.split('/').pop() || filePath

  return (
    <div className="workspace-blame-viewer">
      <div className="workspace-blame-header">
        <span>Blame:</span>
        <span className="workspace-blame-header-path">{fileName}</span>
        <span style={{ marginLeft: 'auto' }}>{lines.length} lines</span>
      </div>
      <div className="workspace-blame-content">
        {lines.map((line) => (
          <div key={line.lineNumber} className="workspace-blame-line">
            <span className="workspace-blame-line-number">{line.lineNumber}</span>
            <div className="workspace-blame-line-meta">
              <span className="workspace-blame-line-hash">{line.hash.slice(0, 7)}</span>
              <span className="workspace-blame-line-author">{line.author}</span>
              <span className="workspace-blame-line-date">{formatRelativeDate(line.date)}</span>
            </div>
            <span className="workspace-blame-line-text">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
