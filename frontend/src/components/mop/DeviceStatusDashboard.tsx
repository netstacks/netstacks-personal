/**
 * DeviceStatusDashboard - Grid view of device execution status
 *
 * Features:
 * - Grid/list view toggle
 * - Per-device progress bars
 * - Status indicators (pending, running, complete, failed)
 * - Quick actions (skip, retry, rollback)
 */

import { useState, useMemo } from 'react';
import type { MopExecutionDevice, MopExecutionStep, DeviceStatus } from '../../types/mop';

// Icons
const Icons = {
  grid: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1.5" fill="currentColor" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  skip: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 4 15 12 5 20 5 4" />
      <rect x="17" y="5" width="2" height="14" />
    </svg>
  ),
  retry: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  ),
  rollback: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  ),
  spinner: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spinning">
      <circle cx="12" cy="12" r="10" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
};

// Session info for display
interface SessionInfo {
  id: string;
  name: string;
  host?: string;
  icon?: string;
}

interface DeviceStatusDashboardProps {
  devices: MopExecutionDevice[];
  sessionInfo: Record<string, SessionInfo>;
  stepsByDevice: Record<string, MopExecutionStep[]>;
  phaseStepType: 'pre_check' | 'change' | 'post_check';
  onSkipDevice?: (deviceId: string) => void;
  onRetryDevice?: (deviceId: string) => void;
  onRollbackDevice?: (deviceId: string) => void;
  onSelectDevice?: (deviceId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  selectedDeviceId?: string | null;
}

// Get status color (VS Code theme)
function getStatusColor(status: DeviceStatus): string {
  switch (status) {
    case 'pending': return '#969696';
    case 'running': return '#569cd6';
    case 'waiting': return '#dcdcaa';
    case 'complete': return '#4ec9b0';
    case 'failed': return '#f14c4c';
    case 'skipped': return '#9b59b6';
    default: return '#969696';
  }
}

// Get status label
function getStatusLabel(status: DeviceStatus): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'waiting': return 'Waiting';
    case 'complete': return 'Complete';
    case 'failed': return 'Failed';
    case 'skipped': return 'Skipped';
    default: return status;
  }
}

// Get status icon
function getStatusIcon(status: DeviceStatus) {
  switch (status) {
    case 'pending': return <span style={{ opacity: 0.5 }}>{'[-]'}</span>;
    case 'running': return Icons.spinner;
    case 'waiting': return <span style={{ color: '#dcdcaa' }}>{'[?]'}</span>;
    case 'complete': return <span style={{ color: '#4ec9b0' }}>{Icons.check}</span>;
    case 'failed': return <span style={{ color: '#f14c4c' }}>{Icons.x}</span>;
    case 'skipped': return <span style={{ color: '#9b59b6' }}>{Icons.skip}</span>;
    default: return null;
  }
}

export default function DeviceStatusDashboard({
  devices,
  sessionInfo,
  stepsByDevice,
  phaseStepType,
  onSkipDevice,
  onRetryDevice,
  onRollbackDevice,
  onSelectDevice,
  onOpenSession,
  selectedDeviceId,
}: DeviceStatusDashboardProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Derive per-device status from current phase's steps (not backend device.status)
  const devicePhaseStatus = useMemo(() => {
    const statusMap: Record<string, { status: DeviceStatus; progress: number; completed: number; total: number }> = {};
    for (const device of devices) {
      const allSteps = stepsByDevice[device.id] || [];
      const phaseSteps = allSteps.filter(s => s.step_type === phaseStepType);
      if (phaseSteps.length === 0) {
        statusMap[device.id] = { status: 'pending', progress: 0, completed: 0, total: 0 };
        continue;
      }
      const completed = phaseSteps.filter(s => s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked').length;
      const failed = phaseSteps.filter(s => s.status === 'failed').length;
      const running = phaseSteps.filter(s => s.status === 'running').length;
      const total = phaseSteps.length;
      const done = completed + failed;
      const progress = total > 0 ? Math.round((done / total) * 100) : 0;

      let status: DeviceStatus;
      if (failed > 0 && done === total) {
        status = 'failed';
      } else if (done === total) {
        status = 'complete';
      } else if (running > 0) {
        status = 'running';
      } else {
        status = 'pending';
      }
      statusMap[device.id] = { status, progress, completed, total };
    }
    return statusMap;
  }, [devices, stepsByDevice, phaseStepType]);

  const getDeviceProgress = (device: MopExecutionDevice): number => {
    return devicePhaseStatus[device.id]?.progress ?? 0;
  };

  const getDevicePhaseStatus = (device: MopExecutionDevice): DeviceStatus => {
    return devicePhaseStatus[device.id]?.status ?? 'pending';
  };

  // Render device card (grid view)
  const renderDeviceCard = (device: MopExecutionDevice) => {
    const session = device.session_id ? sessionInfo[device.session_id] : undefined;
    const progress = getDeviceProgress(device);
    const status = getDevicePhaseStatus(device);
    const phaseInfo = devicePhaseStatus[device.id];
    const isSelected = selectedDeviceId === device.id;

    return (
      <div
        key={device.id}
        className={`device-status-card ${status} ${isSelected ? 'selected' : ''}`}
        onClick={() => onSelectDevice?.(device.id)}
        style={{
          background: 'var(--bg-secondary, #252526)',
          border: `1px solid ${isSelected ? '#4ec9b0' : 'var(--border-color, #3c3c3c)'}`,
          borderRadius: 6,
          padding: 12,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            background: 'rgba(78, 201, 176, 0.15)',
            borderRadius: 6,
            color: '#4ec9b0',
            flexShrink: 0,
          }}>
            <span style={{ width: 18, height: 18, display: 'flex' }}>{Icons.server}</span>
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, color: 'var(--text-primary, #fff)', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {session?.name || device.session_id}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {session?.host || 'localhost'}
            </div>
          </div>
          <div style={{ color: getStatusColor(status), flexShrink: 0, width: 16, height: 16 }}>
            {getStatusIcon(status)}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{
          height: 4,
          background: 'var(--border-color, #333)',
          borderRadius: 2,
          overflow: 'hidden',
          marginBottom: 12,
        }}>
          <div style={{
            height: '100%',
            width: `${progress}%`,
            background: getStatusColor(status),
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }} />
        </div>

        {/* Status label */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{
            fontSize: 12,
            color: getStatusColor(status),
            fontWeight: 500,
          }}>
            {getStatusLabel(status)}
            {phaseInfo && phaseInfo.total > 0 && (
              <span style={{ color: 'var(--text-secondary, #888)', fontWeight: 400, marginLeft: 6 }}>
                {phaseInfo.completed}/{phaseInfo.total}
              </span>
            )}
          </span>

          {/* Quick actions */}
          <div style={{ display: 'flex', gap: 4 }}>
            {status === 'failed' && (
              <>
                <button
                  className="device-action-btn"
                  onClick={e => { e.stopPropagation(); onRetryDevice?.(device.id); }}
                  title="Retry"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 4,
                    cursor: 'pointer',
                    color: 'var(--text-secondary, #888)',
                  }}
                >
                  {Icons.retry}
                </button>
                <button
                  className="device-action-btn"
                  onClick={e => { e.stopPropagation(); onSkipDevice?.(device.id); }}
                  title="Skip"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 4,
                    cursor: 'pointer',
                    color: 'var(--text-secondary, #888)',
                  }}
                >
                  {Icons.skip}
                </button>
              </>
            )}
            {(status === 'complete' || status === 'failed') && (
              <button
                className="device-action-btn"
                onClick={e => { e.stopPropagation(); onRollbackDevice?.(device.id); }}
                title="Rollback"
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 4,
                  cursor: 'pointer',
                  color: 'var(--text-secondary, #888)',
                }}
              >
                {Icons.rollback}
              </button>
            )}
            {onOpenSession && (
              <button
                className="device-action-btn"
                onClick={e => { e.stopPropagation(); if (device.session_id) onOpenSession(device.session_id); }}
                title="Open Terminal"
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 4,
                  cursor: 'pointer',
                  color: 'var(--text-secondary, #888)',
                }}
              >
                {Icons.terminal}
              </button>
            )}
          </div>
        </div>

        {/* Error message */}
        {device.error_message && (
          <div style={{
            marginTop: 8,
            padding: 8,
            background: 'rgba(231, 76, 60, 0.1)',
            border: '1px solid rgba(231, 76, 60, 0.3)',
            borderRadius: 4,
            fontSize: 12,
            color: '#e74c3c',
          }}>
            {device.error_message}
          </div>
        )}
      </div>
    );
  };

  // Render device row (list view) — compact, no fixed widths
  const renderDeviceRow = (device: MopExecutionDevice) => {
    const session = device.session_id ? sessionInfo[device.session_id] : undefined;
    const status = getDevicePhaseStatus(device);
    const phaseInfo = devicePhaseStatus[device.id];
    const isSelected = selectedDeviceId === device.id;

    return (
      <div
        key={device.id}
        className={`device-status-row ${status} ${isSelected ? 'selected' : ''}`}
        onClick={() => onSelectDevice?.(device.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: isSelected ? 'rgba(0, 212, 170, 0.1)' : 'var(--bg-primary, #1a1a1a)',
          borderBottom: '1px solid var(--border-color, #333)',
          cursor: 'pointer',
          transition: 'background 0.2s ease',
        }}
      >
        {/* Status dot */}
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          background: getStatusColor(status),
          ...(status === 'running' ? { animation: 'spin 1s linear infinite' } : {}),
        }} />
        {/* Name */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, color: 'var(--text-primary, #fff)', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {session?.name || device.session_id}
          </div>
        </div>
        {/* Status label */}
        <span style={{
          fontSize: 11,
          color: getStatusColor(status),
          fontWeight: 500,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}>
          {getStatusLabel(status)}
          {phaseInfo && phaseInfo.total > 0 && ` ${phaseInfo.completed}/${phaseInfo.total}`}
        </span>
        {/* Retry/skip actions for failed */}
        {status === 'failed' && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <button
              className="device-action-btn"
              onClick={e => { e.stopPropagation(); onRetryDevice?.(device.id); }}
              title="Retry"
              style={{ background: 'transparent', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--text-secondary, #888)' }}
            >
              {Icons.retry}
            </button>
          </div>
        )}
        {onOpenSession && (
          <button
            className="device-action-btn"
            onClick={e => { e.stopPropagation(); if (device.session_id) onOpenSession(device.session_id); }}
            title="Open Terminal"
            style={{ background: 'transparent', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--text-secondary, #888)', flexShrink: 0 }}
          >
            {Icons.terminal}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="device-status-dashboard">
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
          Device Status ({devices.length} devices)
        </h3>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setViewMode('grid')}
            style={{
              background: viewMode === 'grid' ? 'var(--accent-color, #00d4aa)' : 'transparent',
              color: viewMode === 'grid' ? '#000' : 'var(--text-secondary, #888)',
              border: 'none',
              padding: 6,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {Icons.grid}
          </button>
          <button
            onClick={() => setViewMode('list')}
            style={{
              background: viewMode === 'list' ? 'var(--accent-color, #00d4aa)' : 'transparent',
              color: viewMode === 'list' ? '#000' : 'var(--text-secondary, #888)',
              border: 'none',
              padding: 6,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {Icons.list}
          </button>
        </div>
      </div>

      {/* Device view */}
      {viewMode === 'grid' ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
        }}>
          {devices.map(renderDeviceCard)}
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-secondary, #252526)',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--border-color, #333)',
        }}>
          {devices.map(renderDeviceRow)}
        </div>
      )}

      {devices.length === 0 && (
        <div className="mop-empty-state">
          <div className="mop-empty-state-icon">{'[~]'}</div>
          <div className="mop-empty-state-title">No Devices</div>
          <div className="mop-empty-state-desc">
            Select devices in the previous step to see their execution status.
          </div>
        </div>
      )}

      <style>{`
        .device-action-btn svg {
          width: 16px;
          height: 16px;
        }
        .device-action-btn:hover {
          color: var(--text-primary, #fff) !important;
        }
        .spinning {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
