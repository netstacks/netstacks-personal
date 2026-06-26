/**
 * LiveExecutionView - Live step execution with output streaming
 *
 * Features:
 * - Step list with status indicators
 * - Live output display
 * - Step-by-step execution controls
 * - Mock indicator for mocked steps
 */

import { useState, useRef, useEffect } from 'react';
import type { MopExecutionStep, StepStatus, MopStepType } from '../../types/mop';

// Icons
const Icons = {
  play: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
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
  spinner: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spinning">
      <circle cx="12" cy="12" r="10" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
};

// Get step type color (VS Code theme)
function getStepTypeColor(type: MopStepType): string {
  switch (type) {
    case 'pre_check': return '#569cd6';
    case 'change': return '#ce9178';
    case 'post_check': return '#4ec9b0';
    case 'rollback': return '#f14c4c';
    default: return '#969696';
  }
}

// Get status icon (VS Code theme)
function getStatusIcon(status: StepStatus) {
  switch (status) {
    case 'pending': return <span style={{ color: '#969696' }}>{'[-]'}</span>;
    case 'running': return Icons.spinner;
    case 'passed': return <span style={{ color: '#4ec9b0' }}>{Icons.check}</span>;
    case 'failed': return <span style={{ color: '#f14c4c' }}>{Icons.x}</span>;
    case 'skipped': return <span style={{ color: '#9b59b6' }}>{Icons.skip}</span>;
    case 'mocked': return <span style={{ color: '#9b59b6' }}>{'[M]'}</span>;
    default: return null;
  }
}

// Get status color (VS Code theme)
function getStatusColor(status: StepStatus): string {
  switch (status) {
    case 'pending': return '#969696';
    case 'running': return '#569cd6';
    case 'passed': return '#4ec9b0';
    case 'failed': return '#f14c4c';
    case 'skipped': return '#9b59b6';
    case 'mocked': return '#9b59b6';
    default: return '#969696';
  }
}

interface LiveExecutionViewProps {
  steps: MopExecutionStep[];
  currentStepId?: string | null;
  onExecuteStep?: (stepId: string) => void;
  onSkipStep?: (stepId: string) => void;
  controlMode?: 'manual' | 'auto_run' | 'ai_pilot';
}

export default function LiveExecutionView({
  steps,
  currentStepId,
  onExecuteStep,
  onSkipStep,
  controlMode = 'auto_run',
}: LiveExecutionViewProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(currentStepId || null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [steps]);

  // Get selected step
  const selectedStep = steps.find(s => s.id === selectedStepId);

  // Group steps by type
  const preChecks = steps.filter(s => s.step_type === 'pre_check');
  const changes = steps.filter(s => s.step_type === 'change');
  const postChecks = steps.filter(s => s.step_type === 'post_check');

  // Render step item
  const renderStepItem = (step: MopExecutionStep) => {
    const isSelected = selectedStepId === step.id;
    const isCurrent = currentStepId === step.id;

    return (
      <div
        key={step.id}
        onClick={() => setSelectedStepId(step.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          background: isSelected ? 'rgba(0, 212, 170, 0.1)' : isCurrent ? 'rgba(52, 152, 219, 0.1)' : 'transparent',
          borderLeft: `3px solid ${isSelected ? 'var(--accent-color, #00d4aa)' : isCurrent ? '#3498db' : 'transparent'}`,
          cursor: 'pointer',
          transition: 'background 0.2s ease',
        }}
      >
        <div style={{ width: 20 }}>
          {getStatusIcon(step.status)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'monospace',
            fontSize: 13,
            color: 'var(--text-primary, #fff)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {step.command}
          </div>
          {step.description && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)', marginTop: 2 }}>
              {step.description}
            </div>
          )}
        </div>
        {step.mock_enabled && (
          <span style={{
            background: '#9b59b6',
            color: '#fff',
            padding: '2px 6px',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 500,
          }}>
            MOCK
          </span>
        )}
        {step.duration_ms && (
          <span style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>
            {(step.duration_ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>
    );
  };

  // Render step group
  const renderStepGroup = (title: string, groupSteps: MopExecutionStep[], color: string) => {
    if (groupSteps.length === 0) return null;

    const completed = groupSteps.filter(s =>
      s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
    ).length;

    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: 'var(--bg-tertiary, #252526)',
          borderBottom: `2px solid ${color}`,
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color, textTransform: 'uppercase' }}>
            {title}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>
            {completed}/{groupSteps.length}
          </span>
        </div>
        {groupSteps.map(renderStepItem)}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      {/* Step list */}
      <div style={{
        width: 350,
        flexShrink: 0,
        background: 'var(--bg-primary, #1a1a1a)',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--border-color, #333)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-color, #333)',
          background: 'var(--bg-secondary, #252526)',
        }}>
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
            Execution Steps
          </h4>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {renderStepGroup('Pre-Checks', preChecks, '#3498db')}
          {renderStepGroup('Changes', changes, '#e67e22')}
          {renderStepGroup('Post-Checks', postChecks, '#27ae60')}
        </div>
      </div>

      {/* Output panel */}
      <div style={{
        flex: 1,
        background: 'var(--bg-primary, #1a1a1a)',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--border-color, #333)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {selectedStep ? (
          <>
            {/* Step header */}
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border-color, #333)',
              background: 'var(--bg-secondary, #252526)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: getStepTypeColor(selectedStep.step_type),
                  textTransform: 'uppercase',
                  background: `${getStepTypeColor(selectedStep.step_type)}20`,
                  padding: '2px 8px',
                  borderRadius: 4,
                }}>
                  {selectedStep.step_type.replace('_', ' ')}
                </span>
                <span style={{
                  fontSize: 12,
                  color: getStatusColor(selectedStep.status),
                  fontWeight: 500,
                }}>
                  {selectedStep.status}
                </span>
                {selectedStep.mock_enabled && (
                  <span style={{
                    background: '#9b59b6',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 500,
                  }}>
                    MOCKED
                  </span>
                )}
              </div>
              <div style={{
                marginTop: 8,
                fontFamily: 'monospace',
                fontSize: 14,
                color: 'var(--text-primary, #fff)',
              }}>
                {selectedStep.command}
              </div>
              {selectedStep.description && (
                <div style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: 'var(--text-secondary, #888)',
                }}>
                  {selectedStep.description}
                </div>
              )}
            </div>

            {/* Output */}
            <div
              ref={outputRef}
              style={{
                flex: 1,
                padding: 16,
                fontFamily: 'monospace',
                fontSize: 13,
                color: 'var(--text-primary, #fff)',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                background: '#000',
              }}
            >
              {selectedStep.output || (
                <span style={{ color: '#666' }}>
                  {selectedStep.status === 'pending'
                    ? 'Waiting to execute...'
                    : selectedStep.status === 'running'
                    ? 'Executing...'
                    : 'No output'}
                </span>
              )}
            </div>

            {/* AI feedback */}
            {selectedStep.ai_feedback && (
              <div style={{
                padding: 12,
                borderTop: '1px solid var(--border-color, #333)',
                background: 'rgba(0, 212, 170, 0.05)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-color, #00d4aa)', marginBottom: 4 }}>
                  AI Analysis
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>
                  {selectedStep.ai_feedback}
                </div>
              </div>
            )}

            {/* Step controls */}
            {controlMode === 'manual' && selectedStep.status === 'pending' && (
              <div style={{
                padding: 12,
                borderTop: '1px solid var(--border-color, #333)',
                display: 'flex',
                gap: 8,
              }}>
                <button
                  className="mop-btn mop-btn-primary"
                  onClick={() => onExecuteStep?.(selectedStep.id)}
                >
                  {Icons.play}
                  Execute
                </button>
                <button
                  className="mop-btn mop-btn-secondary"
                  onClick={() => onSkipStep?.(selectedStep.id)}
                >
                  {Icons.skip}
                  Skip
                </button>
              </div>
            )}
          </>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary, #888)',
          }}>
            Select a step to view its output
          </div>
        )}
      </div>

      <style>{`
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
