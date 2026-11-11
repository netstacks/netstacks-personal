import { useEffect, useState } from 'react'
import type { FileOps } from '../../types/workspace'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceImageViewerProps {
  filePath: string
  fileOps: FileOps
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

function bytesToBase64(bytes: Uint8Array): string {
  // chunked to avoid call-stack overflow on large files
  const CHUNK = 0x8000
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(s)
}

export default function WorkspaceImageViewer({ filePath, fileOps }: WorkspaceImageViewerProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ size: number; mime: string } | null>(null)

  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
  const kind: 'image' | 'pdf' | 'audio' | 'video' | 'other' =
    mime.startsWith('image/') ? 'image'
      : mime === 'application/pdf' ? 'pdf'
      : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('video/') ? 'video'
      : 'other'

  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    setError(null)
    setMeta(null)
    fileOps.readFileBinary(filePath).then(bytes => {
      if (cancelled) return
      try {
        const url = `data:${mime};base64,${bytesToBase64(bytes)}`
        setDataUrl(url)
        setMeta({ size: bytes.length, mime })
      } catch (e) {
        setError(`Failed to render: ${getErrorMessage(e, String(e))}`)
      }
    }).catch(err => {
      if (cancelled) return
      setError(getErrorMessage(err, 'Failed to load file'))
    })
    return () => { cancelled = true }
  }, [filePath, fileOps, mime])

  if (error) {
    return <div className="workspace-empty-state"><div style={{ color: 'var(--color-error)' }}>{error}</div></div>
  }
  if (!dataUrl) {
    return <div className="workspace-empty-state"><div>Loading...</div></div>
  }

  const sizeKb = meta ? (meta.size / 1024).toFixed(meta.size < 1024 * 100 ? 1 : 0) : '?'
  const fileName = filePath.split('/').pop() || filePath

  return (
    <div className="workspace-image-viewer">
      <div className="workspace-image-viewer-toolbar">
        <span>{fileName}</span>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 11, marginLeft: 8 }}>
          {meta?.mime} · {sizeKb} KB
        </span>
      </div>
      <div className="workspace-image-viewer-content">
        {kind === 'image' && (
          <img src={dataUrl} alt={fileName} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        )}
        {kind === 'pdf' && (
          <object data={dataUrl} type="application/pdf" style={{ width: '100%', height: '100%' }}>
            <p>PDF preview not supported. <a href={dataUrl} download={fileName}>Download</a></p>
          </object>
        )}
        {kind === 'audio' && (
          <audio controls src={dataUrl} style={{ width: '100%' }} />
        )}
        {kind === 'video' && (
          <video controls src={dataUrl} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        )}
        {kind === 'other' && (
          <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
            No preview available for this file type. <a href={dataUrl} download={fileName}>Download</a>
          </div>
        )}
      </div>
    </div>
  )
}
