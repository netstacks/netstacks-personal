import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import './DeploymentDetailTab.css'
import {
  getConfigDeploymentDetail,
  getDeploymentLogs,
  rollbackDeployment,
  type ConfigDeployment,
  type DeploymentLog,
} from '../../api/configManagement'

import { getErrorMessage } from '../../api/errors'
interface DeploymentDetailTabProps {
  deploymentId: string
  onTitleChange?: (title: string) => void
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString()
  } catch {
    return dateStr
  }
}

function formatTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString()
  } catch {
    return dateStr
  }
}

const STAGES = ['render', 'backup', 'push', 'validate', 'confirm', 'sync'] as const

function getStatusTimeline(logs: DeploymentLog[], deploymentStatus?: string) {
  const stageStatus: Record<string, 'completed' | 'current' | 'failed' | 'pending' | 'skipped'> = {}
  for (const stage of STAGES) stageStatus[stage] = 'pending'

  for (const log of logs) {
    const msg = log.message.toLowerCase()
    for (const stage of STAGES) {
      if (msg.includes(stage)) {
        if (log.level === 'error') stageStatus[stage] = 'failed'
        else if (msg.includes('completed') || msg.includes('success')) stageStatus[stage] = 'completed'
        else stageStatus[stage] = 'current'
      }
    }
  }

  // When a later stage starts, earlier 'current' stages are done
  for (let i = 1; i < STAGES.length; i++) {
    if (stageStatus[STAGES[i]] !== 'pending') {
      for (let j = 0; j < i; j++) {
        if (stageStatus[STAGES[j]] === 'current') stageStatus[STAGES[j]] = 'completed'
      }
    }
  }

  if (deploymentStatus === 'completed') {
    for (const stage of STAGES) {
      if (stageStatus[stage] === 'current') stageStatus[stage] = 'completed'
    }
  } else if (deploymentStatus === 'failed') {
    let lastCurrent = -1
    for (let i = STAGES.length - 1; i >= 0; i--) {
      if (stageStatus[STAGES[i]] === 'current') { lastCurrent = i; break }
    }
    if (lastCurrent >= 0) stageStatus[STAGES[lastCurrent]] = 'failed'
  }

  let sawFailure = false
  for (const stage of STAGES) {
    if (sawFailure && stageStatus[stage] === 'pending') stageStatus[stage] = 'skipped'
    if (stageStatus[stage] === 'failed') sawFailure = true
  }

  return STAGES.map(stage => ({ stage, status: stageStatus[stage] }))
}

export default function DeploymentDetailTab({
  deploymentId,
  onTitleChange,
}: DeploymentDetailTabProps) {
  const [deployment, setDeployment] = useState<ConfigDeployment | null>(null)
  const [logs, setLogs] = useState<DeploymentLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'debug' | 'warning' | 'error'>('all')
  const [rollingBack, setRollingBack] = useState(false)
  // (Previously a `deviceDetail` useState<any> lived here that mirrored
  // the `deployment` state — both were assigned the same `dep` value.
  // Removed; the JSX below now reads device_results from `deployment`
  // directly. Functional change: none.)

  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  const fetchData = useCallback(async () => {
    if (!deploymentId) return
    setLoading(true)
    setError(null)
    try {
      const [dep, depLogs] = await Promise.all([
        getConfigDeploymentDetail(deploymentId),
        getDeploymentLogs(deploymentId),
      ])
      setDeployment(dep)
      setLogs(Array.isArray(depLogs) ? depLogs : [])
      onTitleChangeRef.current?.(`Deployment: ${dep.name}`)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load deployment'))
    } finally {
      setLoading(false)
    }
  }, [deploymentId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Auto-refresh for active deployments
  useEffect(() => {
    if (!deployment) return
    if (!['pending', 'in_progress', 'rolling_back'].includes(deployment.status)) return
    const interval = setInterval(fetchData, 3000)
    return () => clearInterval(interval)
  }, [deployment, fetchData])

  const handleRollback = useCallback(async () => {
    if (!deployment) return
    setRollingBack(true)
    try {
      await rollbackDeployment(deployment.id)
      await fetchData()
    } catch (err) {
      setError(getErrorMessage(err, 'Rollback failed'))
    } finally {
      setRollingBack(false)
    }
  }, [deployment, fetchData])

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return logs
    return logs.filter(log => log.level === logFilter)
  }, [logs, logFilter])

  const timeline = useMemo(() => {
    if (logs.length === 0) return []
    return getStatusTimeline(logs, deployment?.status)
  }, [logs, deployment?.status])

  if (loading) {
    return (
      <div className="deploy-tab-container">
        <div className="deploy-tab-loading">
          <div className="deploy-tab-spinner" />
          <span>Loading deployment...</span>
        </div>
      </div>
    )
  }

  if (error && !deployment) {
    return (
      <div className="deploy-tab-container">
        <div className="deploy-tab-error">
          <span>{error}</span>
          <button className="deploy-tab-btn" onClick={fetchData}>Retry</button>
        </div>
      </div>
    )
  }

  if (!deployment) {
    return (
      <div className="deploy-tab-container">
        <div className="deploy-tab-loading">
          <span>Deployment not found</span>
        </div>
      </div>
    )
  }

  return (
    <div className="deploy-tab-container">
      {/* Header */}
      <div className="deploy-tab-header">
        <div className="deploy-tab-header-info">
          <h2 className="deploy-tab-title">{deployment.name}</h2>
          <span className={`deploy-tab-status-badge status-${deployment.status}`}>
            {deployment.status.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="deploy-tab-header-actions">
          {(deployment.status === 'completed' || deployment.status === 'failed') && (
            <button
              className="deploy-tab-btn"
              onClick={handleRollback}
              disabled={rollingBack}
            >
              {rollingBack ? 'Rolling back...' : '\u21A9 Rollback'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="deploy-tab-error-bar">{error}</div>
      )}

      {/* Info Grid */}
      <div className="deploy-tab-meta-row">
        <div className="deploy-tab-meta-field">
          <span className="deploy-tab-meta-label">Devices</span>
          <span className="deploy-tab-meta-value">{deployment.total_devices}</span>
        </div>
        <div className="deploy-tab-meta-field">
          <span className="deploy-tab-meta-label">Succeeded</span>
          <span className="deploy-tab-meta-value" style={{ color: deployment.succeeded_count > 0 ? '#4bb44b' : undefined }}>
            {deployment.succeeded_count}
          </span>
        </div>
        <div className="deploy-tab-meta-field">
          <span className="deploy-tab-meta-label">Failed</span>
          <span className="deploy-tab-meta-value" style={{ color: deployment.failed_count > 0 ? '#f44747' : undefined }}>
            {deployment.failed_count}
          </span>
        </div>
        <div className="deploy-tab-meta-field">
          <span className="deploy-tab-meta-label">Created By</span>
          <span className="deploy-tab-meta-value">{deployment.created_by}</span>
        </div>
        {deployment.started_at && (
          <div className="deploy-tab-meta-field">
            <span className="deploy-tab-meta-label">Started</span>
            <span className="deploy-tab-meta-value">{formatDate(deployment.started_at)}</span>
          </div>
        )}
        {deployment.completed_at && (
          <div className="deploy-tab-meta-field">
            <span className="deploy-tab-meta-label">Completed</span>
            <span className="deploy-tab-meta-value">{formatDate(deployment.completed_at)}</span>
          </div>
        )}
      </div>

      <div className="deploy-tab-content">
        {/* Progress Pipeline */}
        {timeline.length > 0 && (
          <div className="deploy-tab-section">
            <div className="deploy-tab-section-header">Deployment Progress</div>
            <div className="deploy-tab-section-body">
              <div className="deploy-tab-pipeline">
                {timeline.map(({ stage, status }, idx) => (
                  <div key={stage} className="deploy-tab-pipeline-stage-wrapper">
                    <div className="deploy-tab-pipeline-stage">
                      <div className={`deploy-tab-pipeline-circle stage-${status}`}>
                        {status === 'completed' ? '\u2713'
                          : status === 'failed' ? '\u2717'
                          : status === 'current' ? '\u25CB'
                          : status === 'skipped' ? '\u2014'
                          : '\u25CB'}
                      </div>
                      <span className="deploy-tab-pipeline-label">{stage.charAt(0).toUpperCase() + stage.slice(1)}</span>
                    </div>
                    {idx < STAGES.length - 1 && (
                      <div className={`deploy-tab-pipeline-line ${status === 'completed' ? 'completed' : ''}`} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Device Results */}
        {deployment?.device_results && deployment.device_results.length > 0 && (
          <div className="deploy-tab-section">
            <div className="deploy-tab-section-header">Device Results</div>
            <div className="deploy-tab-section-body">
              <div className="deploy-tab-device-results">
                {deployment.device_results.map((result) => (
                  <div key={`${result.device_id}-${result.service_name || ''}`} className="deploy-tab-device-row">
                    <span className={`deploy-tab-device-status-icon status-${result.status}`}>
                      {result.status === 'completed' ? '\u2713' : result.status === 'failed' ? '\u2717' : '\u25CB'}
                    </span>
                    <span className="deploy-tab-device-id">{result.device_id}</span>
                    {result.service_name && (
                      <span className="deploy-tab-device-service">{result.service_name}</span>
                    )}
                    <span className={`deploy-tab-status-badge status-${result.status}`}>
                      {result.status}
                    </span>
                    {result.error_message && (
                      <span className="deploy-tab-device-error">{result.error_message}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Deployment Logs */}
        <div className="deploy-tab-section">
          <div className="deploy-tab-section-header" style={{ justifyContent: 'space-between' }}>
            <span>Deployment Logs</span>
            <div className="deploy-tab-log-filters">
              {(['all', 'info', 'debug', 'warning', 'error'] as const).map(level => (
                <button
                  key={level}
                  className={`deploy-tab-log-filter-btn ${logFilter === level ? 'active' : ''}`}
                  onClick={() => setLogFilter(level)}
                >
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="deploy-tab-logs-container">
            {filteredLogs.length === 0 ? (
              <div className="deploy-tab-empty-text">
                {logs.length === 0 ? 'No logs yet' : `No ${logFilter} logs`}
              </div>
            ) : (
              filteredLogs.map((log, idx) => (
                <div key={`${log.id}-${idx}`} className="deploy-tab-log-entry">
                  <span className="deploy-tab-log-time">{formatTime(log.created_at)}</span>
                  <span className={`deploy-tab-log-level level-${log.level}`}>{log.level.toUpperCase()}</span>
                  <span className="deploy-tab-log-message">{log.message}</span>
                  {log.device_id && (
                    <span className="deploy-tab-log-device">{log.device_id}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
