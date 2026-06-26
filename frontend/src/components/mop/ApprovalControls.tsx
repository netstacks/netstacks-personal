/**
 * ApprovalControls - Controls for step/phase approval
 *
 * Features:
 * - Action Required Banner with contextual guidance
 * - Separate Run, Approve, and Continue buttons
 * - Pause/Resume controls
 * - Abort with confirmation
 * - Progress summary
 */

import { useState } from 'react';
import type { ExecutionStatus, ControlMode } from '../../types/mop';
import type { ExecutionProgress } from '../../hooks/useMopExecution';

// Icons
const Icons = {
  play: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  arrowRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L1 21h22L12 2zm0 15.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0-8.5a1 1 0 011 1v4a1 1 0 11-2 0v-4a1 1 0 011-1z" />
    </svg>
  ),
};

interface ApprovalControlsProps {
  executionStatus: ExecutionStatus;
  controlMode: ControlMode;
  progress: ExecutionProgress | null;
  wizardPhase: 'pre_checks' | 'execute' | 'post_checks';
  phaseApproved: boolean;
  allStepsComplete: boolean;
  allStepsPending: boolean;
  isRunningPhase?: boolean;
  onRunPhase?: () => void;
  onApprove?: () => void;
  onContinue?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onAbort?: () => void;
  onComplete?: () => void;
}

export default function ApprovalControls({
  executionStatus,
  controlMode,
  progress,
  wizardPhase,
  phaseApproved,
  allStepsComplete,
  allStepsPending,
  isRunningPhase,
  onRunPhase,
  onApprove,
  onContinue,
  onPause,
  onResume,
  onAbort,
  onComplete,
}: ApprovalControlsProps) {
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  // Get phase display name
  const getPhaseName = (phase: string): string => {
    switch (phase) {
      case 'device_selection': return 'Device Selection';
      case 'configuration': return 'Configuration';
      case 'pre_checks': return 'Pre-Checks';
      case 'change_execution': return 'Change Execution';
      case 'post_checks': return 'Post-Checks';
      case 'review': return 'Review';
      default: return phase;
    }
  };

  // Get next phase
  const getNextPhase = (phase: string): string | null => {
    const phases = ['pre_checks', 'change_execution', 'post_checks', 'review'];
    const index = phases.indexOf(phase);
    if (index >= 0 && index < phases.length - 1) {
      return phases[index + 1];
    }
    return null;
  };

  const isRunning = executionStatus === 'running';
  const isPaused = executionStatus === 'paused';
  const isComplete = executionStatus === 'complete' || executionStatus === 'completed';
  const isFailed = executionStatus === 'failed';
  const isAborted = executionStatus === 'aborted';
  const isExecutionActive = isRunning || isPaused;

  // Use wizardPhase (from wizard's current step) for all display labels,
  // NOT progress?.phase (which tracks backend execution state and can be stale)
  const currentPhase = wizardPhase === 'execute' ? 'change_execution' : wizardPhase;
  const nextPhase = getNextPhase(currentPhase);
  const nextPhaseName = nextPhase ? getPhaseName(nextPhase) : null;

  // Determine if steps are currently running (not all complete, not all pending, or phase API in flight)
  const stepsRunning = isRunningPhase || (!allStepsComplete && !allStepsPending);

  return (
    <div style={{
      background: 'var(--bg-secondary, #252526)',
      borderRadius: 3,
      padding: 12,
      border: '1px solid var(--border-color, #3c3c3c)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 12, fontWeight: 500, color: 'var(--text-primary, #cccccc)' }}>
            Execution Control
          </h4>
          <div style={{ fontSize: 10, color: 'var(--text-secondary, #969696)', marginTop: 2 }}>
            Mode: {controlMode === 'manual' ? 'Manual' :
                   controlMode === 'auto_run' ? 'Auto Run' : 'AI Pilot'}
          </div>
        </div>
        <div style={{
          padding: '2px 8px',
          borderRadius: 2,
          fontSize: 10,
          fontWeight: 500,
          background: isRunning ? 'rgba(14, 99, 156, 0.2)' :
                      isPaused ? 'rgba(243, 156, 18, 0.15)' :
                      isComplete ? 'rgba(78, 201, 176, 0.15)' :
                      isFailed ? 'rgba(241, 76, 76, 0.15)' :
                      isAborted ? 'rgba(150, 150, 150, 0.15)' :
                      'rgba(150, 150, 150, 0.15)',
          color: isRunning ? '#569cd6' :
                 isPaused ? '#dcdcaa' :
                 isComplete ? '#4ec9b0' :
                 isFailed ? '#f14c4c' :
                 isAborted ? '#969696' :
                 '#969696',
        }}>
          {executionStatus.toUpperCase()}
        </div>
      </div>

      {/* Progress summary */}
      {progress && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 8,
          marginBottom: 12,
          padding: 10,
          background: 'var(--bg-primary, #1e1e1e)',
          borderRadius: 3,
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#4ec9b0' }}>
              {progress.completedSteps}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-secondary, #969696)' }}>Completed</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#f14c4c' }}>
              {progress.failedSteps}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-secondary, #969696)' }}>Failed</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#9b59b6' }}>
              {progress.skippedSteps + progress.mockedSteps}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-secondary, #969696)' }}>Skipped/Mocked</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary, #cccccc)' }}>
              {progress.totalSteps}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-secondary, #969696)' }}>Total</div>
          </div>
        </div>
      )}

      {/* Current phase */}
      <div style={{
        padding: 10,
        background: 'var(--bg-primary, #1e1e1e)',
        borderRadius: 3,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 9, color: 'var(--text-secondary, #969696)', marginBottom: 2, textTransform: 'uppercase' }}>
          Current Phase
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary, #cccccc)' }}>
          {getPhaseName(currentPhase)}
        </div>
        {nextPhase && isExecutionActive && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary, #969696)', marginTop: 2 }}>
            Next: {getPhaseName(nextPhase)}
          </div>
        )}
      </div>

      {/* Action Required Banner */}
      {controlMode === 'auto_run' && isExecutionActive && !isComplete && !isFailed && !isAborted && (
        <div style={{
          padding: 10,
          marginBottom: 12,
          borderRadius: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: phaseApproved
            ? 'rgba(78, 201, 176, 0.1)'
            : allStepsComplete
            ? 'rgba(14, 99, 156, 0.15)'
            : 'rgba(243, 156, 18, 0.1)',
          border: `1px solid ${phaseApproved
            ? 'rgba(78, 201, 176, 0.3)'
            : allStepsComplete
            ? 'rgba(14, 99, 156, 0.3)'
            : 'rgba(243, 156, 18, 0.25)'}`,
        }}>
          {/* Status dot — only pulses while actively running */}
          {!phaseApproved && (
            <span style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              background: allStepsComplete ? '#569cd6' : '#e2b93d',
              ...(stepsRunning ? { animation: 'mop-pulse 1.5s ease-in-out infinite' } : {}),
            }} />
          )}
          {phaseApproved && (
            <span style={{ width: 16, height: 16, flexShrink: 0, color: '#4ec9b0' }}>
              {Icons.check}
            </span>
          )}
          <span style={{
            fontSize: 11,
            color: phaseApproved
              ? '#4ec9b0'
              : allStepsComplete
              ? '#569cd6'
              : '#e2b93d',
          }}>
            {allStepsPending
              ? `Run the ${getPhaseName(currentPhase)} steps to begin`
              : stepsRunning
              ? 'Steps are executing...'
              : phaseApproved
              ? `Phase approved. Continue to ${nextPhaseName || 'Review'}.`
              : `Review results and approve to continue`}
          </span>
        </div>
      )}

      {/* Control buttons */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {/* Run Phase (executes pending steps) */}
        {controlMode === 'auto_run' && isExecutionActive && (allStepsPending || isRunningPhase) && (
          <button
            className="mop-btn mop-btn-primary"
            onClick={onRunPhase}
            disabled={isRunningPhase}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {Icons.play}
            {isRunningPhase ? `Running ${getPhaseName(currentPhase)}...` : `Run ${getPhaseName(currentPhase)}`}
          </button>
        )}

        {/* Pause/Resume */}
        {isRunning && !allStepsPending && (
          <button
            className="mop-btn mop-btn-secondary"
            onClick={onPause}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {Icons.pause}
            Pause
          </button>
        )}
        {isPaused && (
          <button
            className="mop-btn mop-btn-primary"
            onClick={onResume}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {Icons.play}
            Resume
          </button>
        )}

        {/* Approve (phase-based mode) */}
        {controlMode === 'auto_run' && isExecutionActive && (
          <button
            className={`mop-btn ${allStepsComplete && !phaseApproved ? 'mop-btn-primary' : phaseApproved ? 'mop-btn-success' : 'mop-btn-secondary'}`}
            onClick={onApprove}
            disabled={!allStepsComplete || phaseApproved}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              ...(allStepsComplete && !phaseApproved ? { animation: 'mop-pulse-btn 1.5s ease-in-out infinite' } : {}),
              ...(phaseApproved ? {
                background: 'rgba(78, 201, 176, 0.15)',
                borderColor: 'rgba(78, 201, 176, 0.4)',
                color: '#4ec9b0',
              } : {}),
            }}
          >
            {Icons.check}
            {phaseApproved ? 'Approved' : 'Approve'}
          </button>
        )}

        {/* Continue to next phase */}
        {controlMode === 'auto_run' && isExecutionActive && nextPhase && (
          <button
            className={`mop-btn ${phaseApproved ? 'mop-btn-primary' : 'mop-btn-secondary'}`}
            onClick={onContinue}
            disabled={!phaseApproved}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            Continue to {nextPhaseName}
            {Icons.arrowRight}
          </button>
        )}

        {/* Complete */}
        {isExecutionActive && currentPhase === 'post_checks' && (
          <button
            className="mop-btn mop-btn-primary"
            onClick={onComplete}
            disabled={!phaseApproved && controlMode === 'auto_run'}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {Icons.check}
            Complete Execution
          </button>
        )}

        {/* Abort */}
        {isExecutionActive && !showAbortConfirm && (
          <button
            className="mop-btn mop-btn-danger"
            onClick={() => setShowAbortConfirm(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
          >
            {Icons.stop}
            Abort
          </button>
        )}
      </div>

      {/* Abort confirmation */}
      {showAbortConfirm && (
        <div style={{
          marginTop: 12,
          padding: 10,
          background: 'rgba(241, 76, 76, 0.1)',
          border: '1px solid rgba(241, 76, 76, 0.3)',
          borderRadius: 3,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 6,
            color: '#f14c4c',
          }}>
            {Icons.warning}
            <span style={{ fontWeight: 500, fontSize: 11 }}>Confirm Abort</span>
          </div>
          <p style={{ fontSize: 10, color: 'var(--text-secondary, #969696)', margin: '0 0 10px 0' }}>
            Are you sure you want to abort this execution? This action cannot be undone.
            You may want to rollback completed changes.
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="mop-btn mop-btn-danger"
              onClick={() => {
                onAbort?.();
                setShowAbortConfirm(false);
              }}
            >
              Yes, Abort
            </button>
            <button
              className="mop-btn mop-btn-secondary"
              onClick={() => setShowAbortConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Completed/Failed/Aborted message */}
      {(isComplete || isFailed || isAborted) && (
        <div style={{
          marginTop: 12,
          padding: 10,
          background: isComplete ? 'rgba(78, 201, 176, 0.1)' :
                      isFailed ? 'rgba(241, 76, 76, 0.1)' :
                      'rgba(150, 150, 150, 0.1)',
          border: `1px solid ${isComplete ? 'rgba(78, 201, 176, 0.3)' :
                               isFailed ? 'rgba(241, 76, 76, 0.3)' :
                               'rgba(150, 150, 150, 0.3)'}`,
          borderRadius: 3,
          color: isComplete ? '#4ec9b0' : isFailed ? '#f14c4c' : '#969696',
        }}>
          <div style={{ fontWeight: 500, marginBottom: 2, fontSize: 11 }}>
            {isComplete ? 'Execution Complete' :
             isFailed ? 'Execution Failed' :
             'Execution Aborted'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary, #969696)' }}>
            {isComplete && 'All steps have been executed successfully.'}
            {isFailed && 'Some steps failed. Review the results and consider rollback.'}
            {isAborted && 'Execution was aborted. Some changes may need to be rolled back.'}
          </div>
        </div>
      )}
    </div>
  );
}
