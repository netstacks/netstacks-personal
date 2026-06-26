import { useState } from 'react'
import JsonViewer from './JsonViewer'
import './ApiResponseTab.css'

interface ApiResponseTabProps {
  title?: string
  data: string
  statusCode?: number
  durationMs?: number
}

function ApiResponseTab({ title, data, statusCode, durationMs }: ApiResponseTabProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(data)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const statusClass = statusCode
    ? statusCode >= 500
      ? 'server-error'
      : statusCode >= 400
        ? 'client-error'
        : 'success'
    : ''

  return (
    <div className="api-response-tab">
      <div className="api-response-header">
        {title && <span className="api-response-title">{title}</span>}
        {statusCode !== undefined && (
          <span className={`api-response-status ${statusClass}`}>
            HTTP {statusCode}
          </span>
        )}
        {durationMs !== undefined && (
          <span className="api-response-duration">{durationMs}ms</span>
        )}
        <span className="api-response-spacer" />
        <button className="api-response-copy-btn" onClick={handleCopy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {copied ? 'Copied!' : 'Copy JSON'}
        </button>
      </div>
      <div className="api-response-body">
        <JsonViewer content={data} />
      </div>
    </div>
  )
}

export default ApiResponseTab
