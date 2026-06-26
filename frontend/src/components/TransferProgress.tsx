import { useState, useEffect, useCallback } from 'react'
import './TransferProgress.css'

export interface TransferItem {
  id: string
  filename: string
  path: string
  size: number
  type: 'upload' | 'download'
  status: 'pending' | 'active' | 'completed' | 'error' | 'cancelled'
  progress: number // 0-100
  bytesTransferred: number
  startTime?: number
  error?: string
}

interface TransferProgressProps {
  transfers: TransferItem[]
  onCancel: (id: string) => void
  onClear: (id: string) => void
  onClearAll: () => void
  onMinimize?: () => void
  isMinimized?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function formatSpeed(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond) + '/s'
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `${mins}m ${secs}s`
  }
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${mins}m`
}

function TransferItemRow({
  transfer,
  onCancel,
  onClear
}: {
  transfer: TransferItem
  onCancel: (id: string) => void
  onClear: (id: string) => void
}) {
  const [speed, setSpeed] = useState(0)
  const [eta, setEta] = useState<number | null>(null)

  useEffect(() => {
    if (transfer.status !== 'active' || !transfer.startTime) {
      setSpeed(0)
      setEta(null)
      return
    }

    const elapsed = (Date.now() - transfer.startTime) / 1000
    if (elapsed > 0) {
      const currentSpeed = transfer.bytesTransferred / elapsed
      setSpeed(currentSpeed)

      const remaining = transfer.size - transfer.bytesTransferred
      if (currentSpeed > 0) {
        setEta(remaining / currentSpeed)
      }
    }
  }, [transfer.bytesTransferred, transfer.startTime, transfer.status, transfer.size])

  const isInProgress = transfer.status === 'active' || transfer.status === 'pending'
  const isFinished = transfer.status === 'completed' || transfer.status === 'error' || transfer.status === 'cancelled'

  return (
    <div className={`transfer-item transfer-item-${transfer.status}`}>
      <div className="transfer-item-icon">
        {transfer.type === 'upload' ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17,8 12,3 7,8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7,10 12,15 17,10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
      </div>

      <div className="transfer-item-info">
        <div className="transfer-item-header">
          <span className="transfer-item-filename" title={transfer.path}>
            {transfer.filename}
          </span>
          <span className="transfer-item-size">
            {formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.size)}
          </span>
        </div>

        {isInProgress && (
          <div className="transfer-item-progress-bar">
            <div
              className="transfer-item-progress-fill"
              style={{ width: `${transfer.progress}%` }}
            />
          </div>
        )}

        <div className="transfer-item-footer">
          {transfer.status === 'pending' && (
            <span className="transfer-item-status">Waiting...</span>
          )}
          {transfer.status === 'active' && (
            <>
              <span className="transfer-item-percent">{Math.round(transfer.progress)}%</span>
              <span className="transfer-item-speed">{formatSpeed(speed)}</span>
              {eta !== null && eta > 0 && (
                <span className="transfer-item-eta">{formatTime(eta)} left</span>
              )}
            </>
          )}
          {transfer.status === 'completed' && (
            <span className="transfer-item-status transfer-item-status-success">
              Complete
            </span>
          )}
          {transfer.status === 'error' && (
            <span className="transfer-item-status transfer-item-status-error">
              {transfer.error || 'Failed'}
            </span>
          )}
          {transfer.status === 'cancelled' && (
            <span className="transfer-item-status transfer-item-status-cancelled">
              Cancelled
            </span>
          )}
        </div>
      </div>

      <div className="transfer-item-actions">
        {isInProgress && (
          <button
            className="transfer-item-action transfer-item-cancel"
            onClick={() => onCancel(transfer.id)}
            title="Cancel transfer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        {isFinished && (
          <button
            className="transfer-item-action transfer-item-clear"
            onClick={() => onClear(transfer.id)}
            title="Remove from list"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

export default function TransferProgress({
  transfers,
  onCancel,
  onClear,
  onClearAll,
  onMinimize,
  isMinimized = false
}: TransferProgressProps) {
  const activeCount = transfers.filter(t => t.status === 'active' || t.status === 'pending').length
  const completedCount = transfers.filter(t => t.status === 'completed').length
  const errorCount = transfers.filter(t => t.status === 'error').length

  const totalProgress = useCallback(() => {
    const activeTransfers = transfers.filter(t => t.status === 'active' || t.status === 'pending')
    if (activeTransfers.length === 0) return 100

    const totalSize = activeTransfers.reduce((sum, t) => sum + t.size, 0)
    const totalTransferred = activeTransfers.reduce((sum, t) => sum + t.bytesTransferred, 0)

    return totalSize > 0 ? (totalTransferred / totalSize) * 100 : 0
  }, [transfers])

  if (transfers.length === 0) return null

  if (isMinimized) {
    return (
      <div className="transfer-progress-minimized" onClick={onMinimize}>
        <div className="transfer-progress-minimized-bar">
          <div
            className="transfer-progress-minimized-fill"
            style={{ width: `${totalProgress()}%` }}
          />
        </div>
        <span className="transfer-progress-minimized-text">
          {activeCount > 0 ? `${activeCount} transfer${activeCount > 1 ? 's' : ''} in progress` : 'Transfers complete'}
        </span>
      </div>
    )
  }

  return (
    <div className="transfer-progress">
      <div className="transfer-progress-header">
        <h3 className="transfer-progress-title">
          File Transfers
          {activeCount > 0 && (
            <span className="transfer-progress-count">{activeCount} active</span>
          )}
        </h3>
        <div className="transfer-progress-actions">
          {(completedCount > 0 || errorCount > 0) && (
            <button
              className="transfer-progress-clear-all"
              onClick={onClearAll}
              title="Clear completed"
            >
              Clear All
            </button>
          )}
          {onMinimize && (
            <button
              className="transfer-progress-minimize"
              onClick={onMinimize}
              title="Minimize"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="transfer-progress-list">
        {transfers.map(transfer => (
          <TransferItemRow
            key={transfer.id}
            transfer={transfer}
            onCancel={onCancel}
            onClear={onClear}
          />
        ))}
      </div>

      {activeCount > 0 && (
        <div className="transfer-progress-footer">
          <div className="transfer-progress-overall">
            <div className="transfer-progress-overall-bar">
              <div
                className="transfer-progress-overall-fill"
                style={{ width: `${totalProgress()}%` }}
              />
            </div>
            <span className="transfer-progress-overall-text">
              {Math.round(totalProgress())}% overall
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
