// MopExecuteTab — extracted from MopWorkspace.renderExecuteTab
// Renders the Execute sub-tab: phase progress, config bar, device step list, output pane

import type React from 'react';
import './MopWorkspace.css';
import type { MopStep, MopStepType } from '../../types/change';
import type { Session } from '../../api/sessions';
import type { DeviceSummary } from '../../api/enterpriseDevices';
import type {
  MopExecutionDevice,
  MopExecutionStep,
  ControlMode,
  ExecutionStrategy,
  ExecutionPhase,
  OnFailureBehavior,
} from '../../types/mop';
import type { MopExecutionState } from '../../hooks/useMopExecution';
import type { UseMopExecutionReturn } from '../../hooks/useMopExecution';
import type { UseAiPilotReturn } from '../../hooks/useAiPilot';
import type { QuickAction } from '../../types/quickAction';
import type { Script } from '../../api/scripts';

// Re-export constants and helpers from MopWorkspace
import { STEP_SECTIONS, capitalize, isExecutionFinished } from './MopWorkspace';

// ============================================================================
// Props Interface
// ============================================================================

export interface MopExecuteTabProps {
  // Enterprise context
  isEnterprise: boolean;

  // Execution state (from useMopExecution hook)
  execution: MopExecutionState['execution'];
  executionDevices: MopExecutionDevice[];
  execState: MopExecutionState;
  execHook: UseMopExecutionReturn;
  executionProgress: MopExecutionState['progress'];
  currentPhase: ExecutionPhase;

  // Execution config
  controlMode: ControlMode;
  setControlMode: (v: ControlMode) => void;
  executionStrategy: ExecutionStrategy;
  setExecutionStrategy: (v: ExecutionStrategy) => void;
  onFailure: OnFailureBehavior;
  setOnFailure: (v: OnFailureBehavior) => void;

  // Execution flow
  executionStarting: boolean;
  runningPhase: string | null;
  executingStepId: string | null;
  editingStepId: string | null;
  editingStepCommand: string;
  setEditingStepCommand: (v: string) => void;
  setEditingStepId: (v: string | null) => void;
  expandedExecutionDevices: Set<string>;

  // Execute split-pane
  selectedExecStepId: string | null;
  setSelectedExecStepId: (v: string | null) => void;
  collapsedPhases: Set<string>;
  rollbackVisible: Set<string>;
  setRollbackVisible: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Selected exec step data (computed)
  selectedExecStepData: { step: MopExecutionStep; device: MopExecutionDevice } | null;

  // Plan steps (for pre-execution preview)
  steps: MopStep[];
  stepCount: number;
  stepsBySection: Record<MopStepType, MopStep[]>;
  selectedDeviceIds: Set<string>;
  selectedDeviceList: (DeviceSummary | Session)[];

  // Per-device steps
  hasPerDeviceSteps: boolean;
  perDeviceSteps: Record<string, MopStep[]>;

  // Approval gating
  isApprovalGated: boolean | string | null;
  approvalStatus: string;

  // AI risk assessment
  aiRiskLevel: string | null;
  aiRiskReason: string | null;
  aiRiskChecking: boolean;

  // AI Pilot
  aiPilot: UseAiPilotReturn;

  // Tab switching
  setActiveTab: (tab: 'plan' | 'devices' | 'execute' | 'review' | 'history') => void;

  // Execution action callbacks
  startExecutionFlow: () => void;
  handleRunPhase: (stepType: 'pre_check' | 'change' | 'post_check') => void;
  handleExecuteStep: (stepId: string) => void;
  handleSkipStep: (stepId: string) => void;
  handleStartEditStep: (step: MopExecutionStep) => void;
  handleSaveEditStep: (stepId: string) => void;
  toggleExecutionDeviceExpand: (deviceId: string) => void;
  togglePhaseCollapse: (key: string) => void;
  getStepStatusColor: (status: string) => string;
  getDeviceStatusInfo: (device: MopExecutionDevice) => { passed: number; failed: number; total: number; label: string };

  // Quick actions & scripts (for output panel details)
  quickActions: QuickAction[];
  scripts: Script[];

  // Formatters
  formatDurationMs: (ms: number) => string;
}

// ============================================================================
// Component
// ============================================================================

export default function MopExecuteTab(props: MopExecuteTabProps) {
  const {
    isEnterprise: _isEnterprise,
    execution,
    executionDevices,
    execState,
    execHook,
    executionProgress,
    currentPhase,
    controlMode,
    setControlMode,
    executionStrategy,
    setExecutionStrategy,
    onFailure,
    setOnFailure,
    executionStarting,
    runningPhase,
    executingStepId,
    editingStepId,
    editingStepCommand,
    setEditingStepCommand,
    setEditingStepId,
    expandedExecutionDevices,
    selectedExecStepId: _selectedExecStepId,
    setSelectedExecStepId,
    collapsedPhases,
    rollbackVisible,
    setRollbackVisible,
    selectedExecStepData,
    steps: _steps,
    stepCount,
    stepsBySection,
    selectedDeviceIds,
    selectedDeviceList,
    hasPerDeviceSteps: _hasPerDeviceSteps,
    perDeviceSteps: _perDeviceSteps,
    isApprovalGated,
    approvalStatus,
    aiRiskLevel,
    aiRiskReason,
    aiRiskChecking,
    aiPilot,
    setActiveTab,
    startExecutionFlow,
    handleRunPhase,
    handleExecuteStep,
    handleSkipStep,
    handleStartEditStep,
    handleSaveEditStep,
    toggleExecutionDeviceExpand,
    togglePhaseCollapse,
    getStepStatusColor,
    getDeviceStatusInfo,
    quickActions,
    scripts,
    formatDurationMs,
  } = props;

  const phases: { key: string; label: string; stepType?: 'pre_check' | 'change' | 'post_check' }[] = [
    { key: 'pre_checks', label: 'Pre-Checks', stepType: 'pre_check' },
    { key: 'changes', label: 'Changes', stepType: 'change' },
    { key: 'post_checks', label: 'Post-Checks', stepType: 'post_check' },
    { key: 'review', label: 'Review' },
  ];

  const phaseIndex = phases.findIndex(p => {
    if (currentPhase === 'pre_checks' && p.key === 'pre_checks') return true;
    if (currentPhase === 'change_execution' && p.key === 'changes') return true;
    if (currentPhase === 'post_checks' && p.key === 'post_checks') return true;
    if (currentPhase === 'review' && p.key === 'review') return true;
    return false;
  });

  const hasSteps = stepCount > 0;
  const hasDevices = selectedDeviceIds.size > 0;
  const canStart = hasSteps && hasDevices && !execution && !executionStarting;
  const isRunning = execution?.status === 'running';
  const isPaused = execution?.status === 'paused';
  const isFinished = isExecutionFinished(execution?.status);

  return (
    <div className="mop-execute-tab">
      {/* Phase progress bar */}
      <div className="mop-execute-phase-bar">
        {phases.map((phase, idx) => (
          <span key={phase.key} style={{ display: 'contents' }}>
            {idx > 0 && <span className="mop-execute-phase-arrow">&rarr;</span>}
            <span className={`mop-execute-phase ${idx === phaseIndex ? 'active' : ''} ${idx < phaseIndex ? 'complete' : ''}`}>
              {idx < phaseIndex && (
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style={{ marginRight: 4 }}>
                  <path d="M6.5 12l-4-4 1.4-1.4L6.5 9.2l5.6-5.6L13.5 5z" />
                </svg>
              )}
              {phase.label}
              {phase.stepType && (
                <span className="mop-execute-phase-count">
                  {execution
                    ? (() => {
                        let total = 0, done = 0;
                        for (const d of executionDevices) {
                          const devSteps = execState.stepsByDevice[d.id] || [];
                          const phaseSteps = devSteps.filter(s => s.step_type === phase.stepType);
                          total += phaseSteps.length;
                          done += phaseSteps.filter(s => s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked').length;
                        }
                        return `${done}/${total}`;
                      })()
                    : (stepsBySection[phase.stepType] || []).length
                  }
                </span>
              )}
            </span>
          </span>
        ))}
      </div>

      {/* Overall progress bar */}
      {execution && executionProgress && (
        <div className="mop-execute-progress-bar">
          <div
            className={`mop-execute-progress-fill ${executionProgress.failedSteps > 0 ? 'has-failures' : ''}`}
            style={{ width: `${executionProgress.percentComplete}%` }}
          />
          <span className="mop-execute-progress-label">
            {executionProgress.percentComplete}% complete
            {executionProgress.failedSteps > 0 && ` \u00b7 ${executionProgress.failedSteps} failed`}
          </span>
        </div>
      )}

      {/* Configuration bar */}
      <div className="mop-execute-config-bar">
        {/* AI Risk Badge */}
        {aiRiskLevel && (
          <div
            className={`mop-ai-risk-badge ${aiRiskLevel}`}
            title={aiRiskReason || `Risk: ${aiRiskLevel}`}
          >
            {aiRiskLevel === 'critical' && (
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M8 1l7 14H1L8 1zm-.5 5v4h1V6h-1zm0 5v1.5h1V11h-1z" />
              </svg>
            )}
            {capitalize(aiRiskLevel)} Risk
          </div>
        )}
        {aiRiskChecking && (
          <div className="mop-ai-risk-badge checking">
            <span className="mop-ai-loading small" /> Checking...
          </div>
        )}

        <div className="mop-execute-config-group">
          <label>Control Mode</label>
          <div className="mop-execute-config-select">
            {(['manual', 'auto_run', 'ai_pilot'] as ControlMode[]).map(m => (
              <button
                key={m}
                className={`mop-execute-config-option ${controlMode === m ? 'active' : ''}`}
                onClick={() => setControlMode(m)}
                disabled={!!execution}
              >
                {m === 'manual' ? 'Manual' : m === 'auto_run' ? 'Auto-Run' : 'AI Pilot'}
              </button>
            ))}
          </div>
        </div>

        <div className="mop-execute-config-group">
          <label>Strategy</label>
          <div className="mop-execute-config-select">
            {(['sequential', 'parallel_by_phase'] as ExecutionStrategy[]).map(strategy => (
              <button
                key={strategy}
                className={`mop-execute-config-option ${executionStrategy === strategy ? 'active' : ''}`}
                onClick={() => setExecutionStrategy(strategy)}
                disabled={!!execution}
              >
                {strategy === 'sequential' ? 'Sequential' : 'Parallel'}
              </button>
            ))}
          </div>
        </div>

        {controlMode === 'ai_pilot' && !execution && (
          <div className="mop-execute-config-group">
            <label>Trust Level</label>
            <div className="mop-execute-config-select">
              {([1, 2, 3, 4] as const).map(level => (
                <button
                  key={level}
                  className={`mop-execute-config-option ${(aiPilot.state.level === level && aiPilot.state.active) ? 'active' : ''}`}
                  onClick={() => aiPilot.activate(level)}
                  title={
                    level === 1 ? 'Observer: AI provides commentary only'
                      : level === 2 ? 'Advisor: AI suggests, you approve'
                      : level === 3 ? 'Co-Pilot: AI runs steps, pauses at phase boundaries'
                      : 'Autopilot: AI runs entire MOP after plan approval'
                  }
                >
                  L{level}
                </button>
              ))}
            </div>
          </div>
        )}

        {controlMode !== 'manual' && !execution && (
          <div className="mop-execute-config-group">
            <label>On Failure</label>
            <div className="mop-execute-config-select">
              {(['pause', 'skip', 'abort'] as OnFailureBehavior[]).map(b => (
                <button
                  key={b}
                  className={`mop-execute-config-option ${onFailure === b ? 'active' : ''}`}
                  onClick={() => setOnFailure(b)}
                >
                  {capitalize(b)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {!execution ? (
          isApprovalGated ? (
            <span className="mop-approval-gate-label">
              {approvalStatus === 'pending_review' ? 'Awaiting Approval' : 'Rejected — Edit & Resubmit'}
            </span>
          ) : (
            <button
              className="mop-workspace-header-btn primary"
              disabled={!canStart}
              onClick={startExecutionFlow}
              title={!hasSteps ? 'Add steps first' : !hasDevices ? 'Select devices first' : 'Start execution'}
            >
              {executionStarting ? 'Starting...' : 'Start Execution'}
            </button>
          )
        ) : isFinished ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="mop-workspace-header-btn"
              onClick={() => {
                execHook.resetExecution();
              }}
            >
              New Execution
            </button>
            <button
              className="mop-workspace-header-btn primary"
              onClick={() => setActiveTab('review')}
            >
              View Results
            </button>
          </div>
        ) : (
          <div className="mop-execute-config-group" style={{ flexDirection: 'row', gap: 6 }}>
            {executionProgress && executionProgress.percentComplete >= 100 ? (
              <button
                className="mop-workspace-header-btn primary"
                onClick={() => execHook.completeExecution()}
              >
                Complete
              </button>
            ) : (
              <>
                {isRunning && (
                  <button className="mop-workspace-header-btn" onClick={() => execHook.pauseExecution()}>
                    Pause
                  </button>
                )}
                {isPaused && (
                  <button className="mop-workspace-header-btn primary" onClick={() => execHook.resumeExecution()}>
                    Resume
                  </button>
                )}
              </>
            )}
            <button className="mop-workspace-header-btn" onClick={() => execHook.cancelExecution()}>
              Cancel
            </button>
            <button className="mop-workspace-header-btn danger" onClick={() => execHook.abortExecution()}>
              Abort
            </button>
          </div>
        )}
      </div>

      {/* Auto-run phase controls */}
      {execution && controlMode === 'auto_run' && !isFinished && (
        <div className="mop-execute-autorun-bar">
          {phases.filter(p => p.stepType).map(phase => {
            const isCurrentPhaseRunning = runningPhase === phase.stepType;
            return (
              <button
                key={phase.key}
                className={`mop-workspace-header-btn ${isCurrentPhaseRunning ? '' : 'primary'}`}
                disabled={isCurrentPhaseRunning || !!runningPhase}
                onClick={() => handleRunPhase(phase.stepType!)}
              >
                {isCurrentPhaseRunning ? `Running ${phase.label}...` : `Run ${phase.label}`}
              </button>
            );
          })}
        </div>
      )}

      {/* AI Pilot panels */}
      {controlMode === 'ai_pilot' && aiPilot.state.active && execution && (
        <>
          {/* AI Pilot header — shows active level + emergency off switch.
              Critical for L4 (Autopilot) where the only off-switch otherwise
              is to close the tab. */}
          <div className="mop-ai-pilot-header">
            <div className="mop-ai-pilot-header-status">
              <span className="mop-ai-pilot-header-dot" />
              <span>AI Pilot active · L{aiPilot.state.level}</span>
            </div>
            <button
              className="mop-workspace-header-btn"
              onClick={aiPilot.deactivate}
              title="Deactivate AI Pilot — execution stays running, AI stops driving"
            >
              Stop AI Pilot
            </button>
          </div>

          {/* L4 plan approval gate */}
          {aiPilot.state.level === 4 && !aiPilot.state.planApproved && (
            <div className="mop-ai-pilot-gate">
              <div className="mop-ai-pilot-gate-icon">
                <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z" />
                </svg>
              </div>
              <div className="mop-ai-pilot-gate-content">
                <strong>L4 Autopilot requires plan approval</strong>
                <p>The AI will execute the entire MOP autonomously. Review the plan before approving.</p>
              </div>
              <button className="mop-workspace-header-btn primary" onClick={aiPilot.approvePlan}>
                Approve Plan
              </button>
            </div>
          )}

          {/* Confidence escalation */}
          {aiPilot.state.escalated && (
            <div className="mop-ai-pilot-escalation">
              <div className="mop-ai-pilot-gate-icon">
                <svg viewBox="0 0 16 16" width="20" height="20" fill="#f48747">
                  <path d="M8 1l7 14H1L8 1zm-.5 5v4h1V6h-1zm0 5v1.5h1V11h-1z" />
                </svg>
              </div>
              <div className="mop-ai-pilot-gate-content">
                <strong>AI confidence below threshold</strong>
                <p>The AI is uncertain about the current state. Human review recommended before continuing.</p>
              </div>
              <button
                className="mop-workspace-header-btn"
                onClick={() => aiPilot.activate(aiPilot.state.level)}
              >
                Acknowledge &amp; Continue
              </button>
            </div>
          )}

          {/* L2 suggestion dialog */}
          {aiPilot.state.currentSuggestion && (
            <div className="mop-ai-pilot-suggestion">
              <div className="mop-ai-pilot-suggestion-header">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="#c586c0">
                  <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5z" />
                </svg>
                AI Suggestion
                <span className="mop-ai-pilot-confidence">
                  {(aiPilot.state.currentSuggestion.confidence * 100).toFixed(0)}% confident
                </span>
              </div>
              <div className="mop-ai-pilot-suggestion-body">
                <strong>Action: </strong>{aiPilot.state.currentSuggestion.action.replace(/_/g, ' ')}
                <p>{aiPilot.state.currentSuggestion.rationale}</p>
              </div>
              <div className="mop-ai-pilot-suggestion-actions">
                <button className="mop-workspace-header-btn primary" onClick={aiPilot.approveSuggestion}>
                  Approve
                </button>
                <button className="mop-workspace-header-btn" onClick={aiPilot.dismissSuggestion}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* L3 phase gate dialog */}
          {aiPilot.state.phaseGate && (
            <div className="mop-ai-pilot-gate">
              <div className="mop-ai-pilot-gate-content">
                <strong>Phase Gate: {aiPilot.state.phaseGate.phase.replace(/_/g, ' ')}</strong>
                <p>{aiPilot.state.phaseGate.rationale}</p>
                <div className="mop-ai-pilot-gate-results">
                  {aiPilot.state.phaseGate.deviceResults.map(d => (
                    <span key={d.name} className="mop-ai-pilot-gate-device">
                      {d.name}: {d.passed}/{d.total}
                      {d.failed > 0 && <span className="mop-ai-pilot-gate-failed"> ({d.failed} failed)</span>}
                    </span>
                  ))}
                </div>
                <span className={`mop-ai-pilot-recommendation ${aiPilot.state.phaseGate.recommendation}`}>
                  AI recommends: {aiPilot.state.phaseGate.recommendation}
                </span>
              </div>
              <div className="mop-ai-pilot-suggestion-actions">
                <button className="mop-workspace-header-btn primary" onClick={aiPilot.approvePhaseGate}>
                  Proceed
                </button>
                <button className="mop-workspace-header-btn danger" onClick={aiPilot.rejectPhaseGate}>
                  Pause
                </button>
              </div>
            </div>
          )}

          {/* AI commentary feed */}
          {aiPilot.state.commentary.length > 0 && (
            <div className="mop-ai-pilot-commentary">
              <div className="mop-ai-pilot-commentary-header">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="#c586c0">
                  <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7z" />
                </svg>
                AI Commentary
                <span style={{ flex: 1 }} />
                <button className="mop-plan-step-action-btn" onClick={aiPilot.clearCommentary} title="Clear">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3 8H5V7h6v2z" />
                  </svg>
                </button>
              </div>
              <div className="mop-ai-pilot-commentary-feed">
                {aiPilot.state.commentary.slice(-10).map(entry => (
                  <div key={entry.id} className={`mop-ai-pilot-comment ${entry.type}`}>
                    <span className="mop-ai-pilot-comment-time">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    {entry.deviceName && (
                      <span className="mop-ai-pilot-comment-device">{entry.deviceName}</span>
                    )}
                    {entry.stepCommand && (
                      <span className="mop-ai-pilot-comment-cmd">{entry.stepCommand}</span>
                    )}
                    <span className="mop-ai-pilot-comment-msg">{entry.message}</span>
                    {entry.confidence != null && (
                      <span className={`mop-ai-pilot-confidence ${entry.confidence < 0.5 ? 'low' : ''}`}>
                        {(entry.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Execution content */}
      <div className="mop-execute-content">
        {!hasSteps && !hasDevices && !execution && !executionStarting ? (
          <div className="mop-workspace-empty">
            <div className="mop-workspace-empty-icon">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </div>
            <h3>Ready to Execute</h3>
            <p>Add steps to your plan and select target devices to start execution.</p>
            <div className="mop-workspace-empty-actions">
              <button className="mop-workspace-header-btn" onClick={() => setActiveTab('plan')}>
                Go to Plan
              </button>
              <button className="mop-workspace-header-btn" onClick={() => setActiveTab('devices')}>
                Go to Devices
              </button>
            </div>
          </div>
        ) : executionStarting ? (
          <div className="mop-workspace-empty">
            <p>Creating execution and cloning steps to devices...</p>
          </div>
        ) : !execution ? (
          /* Pre-execution preview: show plan steps and selected devices */
          <div className="mop-execute-split-pane">
            <div className="mop-execute-left">
              {/* Selected devices summary */}
              {selectedDeviceList.length > 0 ? (
                selectedDeviceList.map(device => {
                  const deviceName = 'name' in device ? device.name : (device as Session).name;
                  const deviceHost = 'host' in device ? device.host : '';
                  return (
                    <div key={device.id} className="mop-execute-device-panel pending">
                      <div className="mop-execute-device-header" style={{ cursor: 'default' }}>
                        <span className="mop-execute-device-status pending" />
                        <span className="mop-execute-device-name">{deviceName}</span>
                        <span className="mop-execute-device-host">{deviceHost}</span>
                        <span style={{ flex: 1 }} />
                        <span className="mop-execute-device-progress">{stepCount} steps</span>
                      </div>
                      <div className="mop-execute-device-steps">
                        {STEP_SECTIONS.filter(s => s.type !== 'rollback').map(({ type, label, color }) => {
                          const sectionSteps = stepsBySection[type] || [];
                          if (sectionSteps.length === 0) return null;
                          const phaseKey = `preview:${device.id}:${type}`;
                          const isPhaseCollapsed = collapsedPhases.has(phaseKey);
                          return (
                            <div key={type} className={`mop-execute-step-group ${isPhaseCollapsed ? 'collapsed' : ''}`}>
                              <div
                                className="mop-execute-step-group-header"
                                onClick={() => togglePhaseCollapse(phaseKey)}
                              >
                                <span className={`mop-execute-step-group-chevron ${isPhaseCollapsed ? '' : 'expanded'}`}>
                                  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                                    <path d="M6 4l4 4-4 4z" />
                                  </svg>
                                </span>
                                <span className="mop-plan-section-dot" style={{ background: color }} />
                                <span>{label}</span>
                                <span className="mop-execute-step-group-count">{sectionSteps.length}</span>
                              </div>
                              {!isPhaseCollapsed && sectionSteps.map((step, idx) => (
                                <div key={step.id} className="mop-execute-step pending">
                                  <div className="mop-execute-step-main">
                                    <span className="mop-execute-step-status pending" style={{ background: '#6e7681' }} />
                                    <span className="mop-execute-step-order" style={{ color }}>{idx + 1}</span>
                                    {step.execution_source === 'quick_action' && <span className="mop-step-source-badge api">API</span>}
                                    {step.execution_source === 'script' && <span className="mop-step-source-badge script">Script</span>}
                                    <span className="mop-execute-step-command">{step.command || '(empty)'}</span>
                                    <span style={{ flex: 1 }} />
                                    <span className="mop-execute-step-status-label pending">Pending</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              ) : hasSteps ? (
                <div className="mop-workspace-empty" style={{ height: '100%' }}>
                  <p>Select devices in the Devices tab to preview execution.</p>
                  <button className="mop-workspace-header-btn" onClick={() => setActiveTab('devices')}>Go to Devices</button>
                </div>
              ) : (
                <div className="mop-workspace-empty" style={{ height: '100%' }}>
                  <p>Add steps in the Plan tab.</p>
                  <button className="mop-workspace-header-btn" onClick={() => setActiveTab('plan')}>Go to Plan</button>
                </div>
              )}
            </div>
            <div className="mop-execute-right">
              <div className="mop-execute-output-empty">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                  <rect x="2" y="3" width="20" height="18" rx="2" />
                  <line x1="2" y1="9" x2="22" y2="9" />
                </svg>
                <span>Step output will appear here during execution</span>
              </div>
            </div>
          </div>
        ) : (
          /* Split-pane: steps on left, selected step output on right */
          <div className="mop-execute-split-pane">
            {/* Left panel — device step list */}
            <div className="mop-execute-left">
              {executionDevices.map(device => {
                const deviceSteps = execState.stepsByDevice[device.id] || [];
                const statusInfo = getDeviceStatusInfo(device);
                const isExpanded = expandedExecutionDevices.has(device.id);
                const DEVICE_STATUS_CLASSES: Record<string, string> = {
                  complete: 'complete', failed: 'failed', running: 'running', skipped: 'skipped',
                };
                const statusClass = DEVICE_STATUS_CLASSES[device.status] || 'pending';

                return (
                  <div key={device.id} className={`mop-execute-device-panel ${statusClass}`}>
                    <div
                      className="mop-execute-device-header"
                      onClick={() => toggleExecutionDeviceExpand(device.id)}
                    >
                      <span className={`mop-execute-device-status ${statusClass}`} />
                      <span className="mop-execute-device-name">{device.device_name}</span>
                      <span className="mop-execute-device-host">{device.device_host}</span>
                      <span style={{ flex: 1 }} />
                      <span className="mop-execute-device-progress">
                        {statusInfo.label}
                      </span>
                      {deviceSteps.some(s => s.step_type === 'rollback') && (isRunning || isPaused) && (
                        <button
                          className={`mop-execute-rollback-btn ${rollbackVisible.has(device.id) ? 'active' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRollbackVisible(prev => {
                              const next = new Set(prev);
                              if (next.has(device.id)) next.delete(device.id);
                              else next.add(device.id);
                              return next;
                            });
                          }}
                          title="Toggle rollback steps"
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <path d="M8 1v2a5 5 0 110 10v2a7 7 0 100-14zm0 4v2l3 3h-2v2H7V10H5l3-3z" />
                          </svg>
                          Rollback
                        </button>
                      )}
                      <span className={`mop-execute-device-chevron ${isExpanded ? 'expanded' : ''}`}>
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <path d="M6 4l4 4-4 4z" />
                        </svg>
                      </span>
                    </div>

                    {isExpanded && (
                      <div className="mop-execute-device-steps">
                        {STEP_SECTIONS.map(({ type, label, color }) => {
                          // Show rollback if device has failures or user toggled it visible
                          if (type === 'rollback' && !deviceSteps.some(s => s.status === 'failed') && !rollbackVisible.has(device.id)) return null;
                          const phaseSteps = deviceSteps
                            .filter(s => s.step_type === type)
                            .sort((a, b) => a.step_order - b.step_order);
                          if (phaseSteps.length === 0) return null;
                          const phaseKey = `${device.id}:${type}`;
                          const isPhaseCollapsed = collapsedPhases.has(phaseKey);

                          return (
                            <div key={type} className={`mop-execute-step-group ${isPhaseCollapsed ? 'collapsed' : ''}`}>
                              <div
                                className="mop-execute-step-group-header"
                                onClick={() => togglePhaseCollapse(phaseKey)}
                              >
                                <span className={`mop-execute-step-group-chevron ${isPhaseCollapsed ? '' : 'expanded'}`}>
                                  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                                    <path d="M6 4l4 4-4 4z" />
                                  </svg>
                                </span>
                                <span className="mop-plan-section-dot" style={{ background: color }} />
                                <span>{label}</span>
                                <span className="mop-execute-step-group-count">
                                  {phaseSteps.filter(s => s.status === 'passed' || s.status === 'mocked' || s.status === 'skipped').length}/{phaseSteps.length}
                                </span>
                              </div>

                              {!isPhaseCollapsed && phaseSteps.map((step, idx) => {
                                const isExecuting = executingStepId === step.id;
                                const isEditing = editingStepId === step.id;
                                const isSelected = selectedExecStepData?.step.id === step.id;
                                const canRun = controlMode === 'manual' && step.status === 'pending' && (isRunning || isPaused);
                                const canRetry = step.status === 'failed' && (isRunning || isPaused);
                                const canSkip = (step.status === 'pending' || step.status === 'failed') && (isRunning || isPaused);
                                const canEdit = step.status === 'pending' && (isRunning || isPaused);
                                const canReset = step.status === 'skipped' && (isRunning || isPaused);

                                return (
                                  <div
                                    key={step.id}
                                    className={`mop-execute-step ${step.status} ${isSelected ? 'selected' : ''}`}
                                    onClick={() => setSelectedExecStepId(step.id)}
                                  >
                                    <div className="mop-execute-step-main">
                                      <span
                                        className={`mop-execute-step-status ${step.status}`}
                                        style={{ background: getStepStatusColor(step.status) }}
                                        title={step.status}
                                      />
                                      <span className="mop-execute-step-order" style={{ color }}>{idx + 1}</span>
                                      {step.execution_source === 'quick_action' && <span className="mop-step-source-badge api">API</span>}
                                      {step.execution_source === 'script' && <span className="mop-step-source-badge script">Script</span>}

                                      {isEditing ? (
                                        <input
                                          className="mop-execute-step-edit-input"
                                          value={editingStepCommand}
                                          onChange={(e) => setEditingStepCommand(e.target.value)}
                                          onBlur={() => handleSaveEditStep(step.id)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleSaveEditStep(step.id);
                                            if (e.key === 'Escape') setEditingStepId(null);
                                          }}
                                          onClick={(e) => e.stopPropagation()}
                                          autoFocus
                                        />
                                      ) : (
                                        <span className="mop-execute-step-command">
                                          {step.command || '(empty)'}
                                        </span>
                                      )}

                                      <span style={{ flex: 1 }} />

                                      {step.duration_ms != null && (
                                        <span className="mop-execute-step-duration">
                                          {formatDurationMs(step.duration_ms)}
                                        </span>
                                      )}

                                      <span className={`mop-execute-step-status-label ${step.status}`}>
                                        {isExecuting ? 'Running...' : capitalize(step.status)}
                                      </span>

                                      <div className="mop-execute-step-actions">
                                        {canRun && (
                                          <button
                                            className="mop-execute-step-action-btn run"
                                            onClick={(e) => { e.stopPropagation(); handleExecuteStep(step.id); }}
                                            disabled={isExecuting}
                                            title="Run this step"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <polygon points="4,2 13,8 4,14" />
                                            </svg>
                                          </button>
                                        )}
                                        {canRetry && (
                                          <button
                                            className="mop-execute-step-action-btn"
                                            onClick={(e) => { e.stopPropagation(); handleExecuteStep(step.id); }}
                                            title="Retry this step"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <path d="M13 8a5 5 0 01-5 5 5 5 0 01-5-5 5 5 0 015-5v2l3-3-3-3v2a7 7 0 107 7h-2z" />
                                            </svg>
                                          </button>
                                        )}
                                        {canSkip && (
                                          <button
                                            className="mop-execute-step-action-btn"
                                            onClick={(e) => { e.stopPropagation(); handleSkipStep(step.id); }}
                                            title="Skip this step"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <path d="M4 3l5 5-5 5V3zm6 0h2v10h-2V3z" />
                                            </svg>
                                          </button>
                                        )}
                                        {canEdit && !isEditing && (
                                          <button
                                            className="mop-execute-step-action-btn"
                                            onClick={(e) => { e.stopPropagation(); handleStartEditStep(step); }}
                                            title="Edit command before running"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l6.69-6.69 1.77 1.77-6.69 6.69z" />
                                            </svg>
                                          </button>
                                        )}
                                        {canReset && (
                                          <button
                                            className="mop-execute-step-action-btn"
                                            onClick={(e) => { e.stopPropagation(); execHook.updateStepOutput(step.id, { output: '', status: 'pending' }); }}
                                            title="Revert to pending"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <path d="M8 1v2a5 5 0 110 10v2a7 7 0 100-14z" />
                                            </svg>
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Right panel — selected step output */}
            <div className="mop-execute-right">
              {selectedExecStepData ? (
                <>
                  <div className="mop-execute-output-header">
                    <div className="mop-execute-output-meta">
                      {selectedExecStepData.step.execution_source === 'quick_action' && <span className="mop-step-source-badge api">API</span>}
                      {selectedExecStepData.step.execution_source === 'script' && <span className="mop-step-source-badge script">Script</span>}
                      <span className="mop-execute-output-command">{selectedExecStepData.step.command}</span>
                      <span className="mop-execute-output-device">{selectedExecStepData.device.device_name}</span>
                    </div>
                    <div className="mop-execute-output-status-row">
                      <span
                        className={`mop-execute-step-status-label ${selectedExecStepData.step.status}`}
                      >
                        {executingStepId === selectedExecStepData.step.id ? 'Running...' : capitalize(selectedExecStepData.step.status)}
                      </span>
                      {selectedExecStepData.step.duration_ms != null && (
                        <span className="mop-execute-step-duration">
                          {formatDurationMs(selectedExecStepData.step.duration_ms)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Request details for API / Script steps */}
                  {selectedExecStepData.step.execution_source === 'quick_action' && (
                    <div className="mop-execute-request-details">
                      <div className="mop-execute-request-title">Request</div>
                      {selectedExecStepData.step.quick_action_id && (() => {
                        const qa = quickActions.find(q => q.id === selectedExecStepData.step.quick_action_id);
                        if (!qa) return <span className="mop-execute-request-line">Action: {selectedExecStepData.step.quick_action_id}</span>;
                        return (
                          <>
                            <span className="mop-execute-request-line"><strong>{qa.method}</strong> {qa.path}</span>
                            {qa.headers && Object.keys(qa.headers).length > 0 && (
                              <span className="mop-execute-request-line mop-dim">Headers: {Object.keys(qa.headers).join(', ')}</span>
                            )}
                          </>
                        );
                      })()}
                      {selectedExecStepData.step.quick_action_variables && Object.keys(selectedExecStepData.step.quick_action_variables).length > 0 && (
                        <div className="mop-execute-request-vars">
                          <span className="mop-execute-request-line mop-dim">Variables (resolved):</span>
                          {Object.entries(selectedExecStepData.step.quick_action_variables).map(([k, v]) => (
                            <span key={k} className="mop-execute-request-line">&nbsp;&nbsp;{k} = <code>{String(v)}</code></span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {selectedExecStepData.step.execution_source === 'script' && (
                    <div className="mop-execute-request-details">
                      <div className="mop-execute-request-title">Script Execution</div>
                      {selectedExecStepData.step.script_id && (() => {
                        const sc = scripts.find(s => s.id === selectedExecStepData.step.script_id);
                        return <span className="mop-execute-request-line">Script: <strong>{sc?.name || selectedExecStepData.step.script_id}</strong></span>;
                      })()}
                      {selectedExecStepData.step.script_args && Object.keys(selectedExecStepData.step.script_args).length > 0 && (
                        <div className="mop-execute-request-vars">
                          <span className="mop-execute-request-line mop-dim">Parameters (as sent):</span>
                          {Object.entries(selectedExecStepData.step.script_args).map(([k, v]) => (
                            <span key={k} className="mop-execute-request-line">&nbsp;&nbsp;{k} = <code>{String(v)}</code></span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mop-execute-output-body">
                    {selectedExecStepData.step.output ? (
                      <>
                        {(selectedExecStepData.step.execution_source === 'quick_action' || selectedExecStepData.step.execution_source === 'script') && (
                          <div className="mop-execute-response-title">Response</div>
                        )}
                        <pre>{selectedExecStepData.step.output}</pre>
                      </>
                    ) : executingStepId === selectedExecStepData.step.id ? (
                      <div className="mop-execute-output-waiting">
                        <span className="mop-ai-loading small" /> Executing...
                      </div>
                    ) : (
                      <div className="mop-execute-output-empty-msg">No output yet</div>
                    )}
                  </div>
                  {selectedExecStepData.step.ai_feedback && (
                    <div className="mop-execute-output-ai-feedback">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" opacity="0.6">
                        <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm-.5-3h1v1h-1v-1zm0-6h1v5h-1V4z" />
                      </svg>
                      <span>{selectedExecStepData.step.ai_feedback}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="mop-execute-output-empty">
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                    <rect x="2" y="3" width="20" height="18" rx="2" />
                    <line x1="2" y1="9" x2="22" y2="9" />
                  </svg>
                  <span>Select a step to view its output</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
