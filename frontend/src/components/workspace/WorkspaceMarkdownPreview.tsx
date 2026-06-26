import { useState, useEffect } from 'react'
import MarkdownViewer from '../MarkdownViewer'
import type { FileOps } from '../../types/workspace'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceMarkdownPreviewProps {
  filePath: string
  fileOps: FileOps
}

export default function WorkspaceMarkdownPreview({ filePath, fileOps }: WorkspaceMarkdownPreviewProps) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fileOps.readFile(filePath)
      .then(text => {
        setContent(text)
        setLoading(false)
      })
      .catch(err => {
        setError(getErrorMessage(err, 'Failed to load file'))
        setLoading(false)
      })
  }, [filePath, fileOps])

  if (loading) {
    return (
      <div className="workspace-empty-state">
        <div>Loading preview...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="workspace-empty-state">
        <div style={{ color: 'var(--color-error)' }}>{error}</div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'auto', padding: 16, background: 'var(--color-bg-primary)' }}>
      <MarkdownViewer content={content} />
    </div>
  )
}
