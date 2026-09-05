// MopExecuteTab — extracted from MopWorkspace.renderExecuteTab
// Renders the Execute sub-tab: phase progress, config bar, executions list,
// phase/rollback controls, manual-mode drivers, device step list, output pane

import { useCallback, useMemo, useState } from 'react';
import type React from 'react';
import './MopWorkspace.css';
import type { MopStep, MopStepType } from '../../types/change';
import type { Session } from '../../api/sessions';
import type { DeviceSummary } from '../../api/enterpriseDevices';
import type {
  MopExecution,
  MopExecutionDevice,
  ControlMode,
  ExecutionStrategy,
  OnFailureBehavior,
} from '../../types/mop';
import type { MopExecutionState } from '../../hooks/useMopExecution';
import type { UseMopExecutionReturn } from '../../hooks/useMopExecution';
import type { UseAiPilotReturn } from '../../hooks/useAiPilot';
import type { UseMopExecuteViewReturn } from './useMopExecuteView';
import type { QuickAction } from '../../types/quickAction';
import type { Script } from '../../api/scripts';
import type { CliFlavor } from '../../types/enrichment';
import { CLI_FLAVOR_META } from '../../lib/cliFlavorMeta';
import {
  STEP_SECTIONS,
  DEVICE_STATUS_CLASSES,
  EXEC_STATUS_COLORS,
  EXEC_STATUS_LABELS,
  PHASE_STEP_TYPES,
  capitalize,
  isExecutionFinished,
  type PhaseStepType,
} from './constants';
import { resolveMopVariables, type VariableIssue } from '../../lib/mopVariables';
import {
  stepAppliesToDevice,
  scopedDeviceCount,
  sortPlanSteps,
  devicesEligibleForPhase,
  previousPhaseIncomplete,
  findNextPendingStep,
  pendingStepsInPhase,
  phaseResultNotes,
} from './mopHelpers';

// ============================================================================
// Props Interface
// ============================================================================

export interface MopExecuteExecProps {
  execution: MopExecutionState['execution'];
  devices: MopExecutionDevice[];
  execState: MopExecutionState;
  execHook: UseMopExecutionReturn;
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
  rollbackRunning: boolean;
  executingStepId: string | null;
}

export interface MopExecutePlanProps {
  // Plan steps (for pre-execution preview)
  steps: MopStep[];
  stepCount: number;
  stepsBySection: Record<MopStepType, MopStep[]>;
  selectedDeviceIds: Set<string>;
  selectedDeviceList: (DeviceSummary | Session)[];
  // Per-device steps
  hasPerDeviceSteps: boolean;
  perDeviceSteps: Record<string, MopStep[]>;
  // Quick actions & scripts (for output panel details)
  quickActions: QuickAction[];
  scripts: Script[];
  // Approval gating
  isApprovalGated: boolean | string | null;
  approvalStatus: string;
  // Plan variables: resolved map per selected device id (preview) and the
  // `device → variable` problems that block Start
  variableMaps: Record<string, Record<string, string>>;
  variableIssues: VariableIssue[];
}

export interface MopExecuteAiProps {
  aiRiskLevel: string | null;
  aiRiskReason: string | null;
  aiRiskChecking: boolean;
  aiPilot: UseAiPilotReturn;
}

/** Executions list (personal mode; every execution created from this plan). */
export interface MopExecuteExecutionsProps {
  planExecutions: MopExecution[];
  planExecutionsLoading: boolean;
  handleOpenExecution: (id: string) => void;
  handleRefreshExecutions: () => void;
}

export interface MopExecuteActions {
  startExecutionFlow: () => void;
  handleRunPhase: (stepType: PhaseStepType) => void;
  handleExecuteStep: (stepId: string) => void;
  handleSkipStep: (stepId: string) => void;
  handleRunNextStep: () => void;
  handleRunPendingInPhase: (deviceId: string, stepType: MopStepType) => void;
  handleRunStepOnAllDevices: (stepId: string) => void;
  /** Roll back one device, or every device when called without an id. */
  handleRunRollback: (deviceId?: string) => void;
  handleAbort: (reason?: string) => void;
  handleComplete: () => void;
  handleNewExecution: () => void;
  handleSaveEditStep: (stepId: string) => void;
  getStepStatusColor: (status: string) => string;
  getDeviceStatusInfo: (device: MopExecutionDevice) => { passed: number; failed: number; total: number; label: string };
  // Tab switching
  setActiveTab: (tab: 'plan' | 'devices' | 'execute' | 'review' | 'history') => void;
  // Formatters
  formatDurationMs: (ms: number) => string;
}

export interface MopExecuteTabProps {
  // Enterprise context
  isEnterprise: boolean;
  /** Split-pane view state (selection, collapsed phases, rollback, editing). */
  view: UseMopExecuteViewReturn;
  exec: MopExecuteExecProps;
  plan: MopExecutePlanProps;
  actions: MopExecuteActions;
  ai: MopExecuteAiProps;
  executions: MopExecuteExecutionsProps;
}


const PHASES: { key: string; label: string; stepType?: PhaseStepType }[] = [
  { key: 'pre_checks', label: 'Pre-Checks', stepType: 'pre_check' },
  { key: 'changes', label: 'Changes', stepType: 'change' },
  { key: 'post_checks', label: 'Post-Checks', stepType: 'post_check' },
  { key: 'review', label: 'Review' },
];

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function flavorLabel(flavor: string | null | undefined): string | null {
  if (!flavor || flavor === 'auto') return null;
  const meta = CLI_FLAVOR_META[flavor as CliFlavor];
  return meta ? (meta.vendor ? `${meta.vendor} ${meta.platform}` : meta.platform) : flavor;
}

// ============================================================================
// Component
// ============================================================================

export default function MopExecuteTab({ isEnterprise, view, exec, plan, actions, ai, executions }: MopExecuteTabProps) {
  const {
    execution,
    devices: executionDevices,
    execState,
    execHook,
    controlMode,
    setControlMode,
    executionStrategy,
    setExecutionStrategy,
    onFailure,
    setOnFailure,
    executionStarting,
    runningPhase,
    rollbackRunning,
    executingStepId,
  } = exec;
  const { currentPhase, progress: executionProgress } = view;
  const { selectedExecStepId, setSelectedExecStepId, selectedExecStepData } = view.selection;
  const { collapsedPhases, togglePhaseCollapse } = view.phases;
  const { rollbackVisible, setRollbackVisible } = view.rollback;
  const { expandedExecutionDevices, toggleExecutionDeviceExpand } = view.devices;
  const { editingStepId, setEditingStepId, editingStepCommand, setEditingStepCommand, handleStartEditStep } = view.editing;
  const {
    steps,
    stepCount,
    stepsBySection,
    selectedDeviceIds,
    selectedDeviceList,
    hasPerDeviceSteps,
    perDeviceSteps,
    quickActions,
    scripts,
    isApprovalGated,
    approvalStatus,
    variableMaps,
    variableIssues,
  } = plan;
  const { aiRiskLevel, aiRiskReason, aiRiskChecking, aiPilot } = ai;
  const { planExecutions, planExecutionsLoading, handleOpenExecution, handleRefreshExecutions } = executions;
  const {
    startExecutionFlow,
    handleRunPhase,
    handleExecuteStep,
    handleSkipStep,
    handleRunNextStep,
    handleRunPendingInPhase,
    handleRunStepOnAllDevices,
    handleRunRollback,
    handleAbort,
    handleComplete,
    handleNewExecution,
    handleSaveEditStep,
    getStepStatusColor,
    getDeviceStatusInfo,
    setActiveTab,
    formatDurationMs,
  } = actions;

  // Local UI state
  const { dialog, abortReason, setAbortReason, openDialog, closeDialog } = view.dialog;
  const [runAnyway, setRunAnyway] = useState<Set<string>>(new Set());
  const [executionsOpen, setExecutionsOpen] = useState(false);

  const phaseIndex = PHASES.findIndex(p => {
    if (currentPhase === 'pre_checks' && p.key === 'pre_checks') return true;
    if (currentPhase === 'change_execution' && p.key === 'changes') return true;
    if (currentPhase === 'post_checks' && p.key === 'post_checks') return true;
    if (currentPhase === 'review' && p.key === 'review') return true;
    return false;
  });

  const hasSteps = stepCount > 0;
  const hasDevices = selectedDeviceIds.size > 0;
  const hasVariableIssues = variableIssues.length > 0;
  const canStart = hasSteps && hasDevices && !execution && !executionStarting && !hasVariableIssues;
  const isRunning = execution?.status === 'running';
  const isPaused = execution?.status === 'paused';
  const isFinished = isExecutionFinished(execution?.status);
  const isActive = isRunning || isPaused;
  const busy = !!runningPhase || rollbackRunning || !!execState.phaseRunning;
  const failedSteps = executionProgress?.failedSteps ?? 0;
  const pendingSteps = useMemo(
    () => executionDevices.reduce((n, d) => n + (execState.stepsByDevice[d.id] || []).filter(s => s.status === 'pending' && s.step_type !== 'rollback').length, 0),
    [executionDevices, execState.stepsByDevice],
  );
  const anyRollbackSteps = useMemo(
    () => executionDevices.some(d => (execState.stepsByDevice[d.id] || []).some(s => s.step_type === 'rollback')),
    [executionDevices, execState.stepsByDevice],
  );
  const rollbackTitle = !anyRollbackSteps
    ? 'No rollback steps in this plan'
    : busy ? 'Wait for the current phase to finish'
      : isFinished ? 'Run the rollback steps against the finished execution'
        : 'Run the rollback steps';

  const phaseCount = (stepType: PhaseStepType): string | number => {
    if (!execution) return (stepsBySection[stepType] || []).length;
    let total = 0, done = 0;
    for (const d of executionDevices) {
      const devSteps = execState.stepsByDevice[d.id] || [];
      const phaseSteps = devSteps.filter(s => s.step_type === stepType);
      total += phaseSteps.length;
      done += phaseSteps.filter(s => s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked').length;
    }
    return `${done}/${total}`;
  };

  // Notes from the last phase / rollback (failures, skips, save errors, 409s)
  const phaseNotes = useMemo(() => {
    const summary = execState.lastPhaseSummary;
    if (!summary) return null;
    const lines: { deviceName: string; text: string; error: boolean }[] = [];
    for (const deviceId of summary.deviceIds) {
      const device = executionDevices.find(d => d.id === deviceId);
      const name = device?.device_name || deviceId;
      const err = summary.errors[deviceId];
      if (err) {
        lines.push({ deviceName: name, text: err, error: true });
        continue;
      }
      const result = execState.phaseResults[deviceId];
      if (!result) continue;
      const notes = phaseResultNotes(result);
      if (notes.length > 0) lines.push({ deviceName: name, text: notes.join(' · '), error: result.steps_failed > 0 || !!result.post_command_error });
    }
    const extras: string[] = [];
    if (summary.aborted) extras.push('Execution aborted (On Failure = Abort).');
    if (summary.paused) extras.push('Execution paused after this phase — Resume to continue.');
    if (lines.length === 0 && extras.length === 0) return null;
    return { stepType: summary.stepType, lines, extras };
  }, [execState.lastPhaseSummary, execState.phaseResults, executionDevices]);

  // Keyboard driver (manual mode): Enter = run selected/next, S = skip, N = next
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!execution || isFinished || controlMode !== 'manual') return;
    const target = e.target as HTMLElement;
    if (EDITABLE_TAGS.has(target.tagName) || target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const selected = selectedExecStepData?.step ?? null;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (busy || executingStepId) return;
      if (selected && selected.status === 'pending' && isActive) handleExecuteStep(selected.id);
      else handleRunNextStep();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      if (selected && (selected.status === 'pending' || selected.status === 'failed') && isActive) handleSkipStep(selected.id);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      const next = findNextPendingStep(executionDevices, execState.stepsByDevice, selectedExecStepData?.device.id ?? null);
      if (next) setSelectedExecStepId(next.step.id);
    }
  }, [execution, isFinished, controlMode, selectedExecStepData, busy, executingStepId, isActive, handleExecuteStep, handleRunNextStep, handleSkipStep, executionDevices, execState.stepsByDevice, setSelectedExecStepId]);

  const onCompleteClick = () => {
    if (failedSteps > 0 || pendingSteps > 0) openDialog('complete');
    else handleComplete();
  };

  const completeLabel = failedSteps > 0 ? `Complete with ${failedSteps} failure${failedSteps !== 1 ? 's' : ''}` : 'Complete';

  return (
    <div className="mop-execute-tab" tabIndex={0} onKeyDown={handleKeyDown} data-testid="mop-execute-tab">
      {/* Phase progress bar */}
      <div className="mop-execute-phase-bar">
        {PHASES.map((phase, idx) => (
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
                <span className="mop-execute-phase-count">{phaseCount(phase.stepType)}</span>
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
            {executionProgress.failedSteps > 0 && ` · ${executionProgress.failedSteps} failed`}
            {execState.phaseRunning && ` · running ${execState.phaseRunning.stepType.replace('_', ' ')} on ${execState.phaseRunning.deviceIds.length} device${execState.phaseRunning.deviceIds.length !== 1 ? 's' : ''}`}
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
                title={strategy === 'sequential' ? 'One device at a time per phase' : 'All devices at once per phase'}
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
                  className={`mop-execute-config-option ${aiPilot.state.level === level ? 'active' : ''}`}
                  onClick={() => aiPilot.setLevel(level)}
                  title={
                    level === 1 ? 'Observer: AI comments on every step result (saved as AI feedback)'
                      : level === 2 ? 'Advisor: AI proposes the next step or phase, you approve'
                      : level === 3 ? 'Co-Pilot: you start a phase; when the AI gate says proceed the next phase runs automatically'
                      : 'Autopilot: after you approve the plan, pre-checks → change → post-checks run back to back, stopping on any failure or non-proceed gate'
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
                  title={
                    b === 'pause' ? 'Pause the execution after a phase with failures'
                      : b === 'skip' ? 'Keep going on the remaining devices'
                      : 'Abort the execution after the first device with failures'
                  }
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
              title={!hasSteps ? 'Add steps first' : !hasDevices ? 'Select devices first' : hasVariableIssues ? 'Resolve the variable issues listed below first' : 'Start execution'}
            >
              {executionStarting ? 'Starting...' : 'Start Execution'}
            </button>
          )
        ) : isFinished ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <span className="mop-execute-finished-label" style={{ color: EXEC_STATUS_COLORS[execution.status] }}>
              {EXEC_STATUS_LABELS[execution.status] || capitalize(execution.status)}
            </span>
            <button
              className="mop-workspace-header-btn"
              onClick={() => openDialog('new')}
              title="Reset the view for another run — this execution stays in the Executions list"
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
            {isRunning && (
              <button className="mop-workspace-header-btn" onClick={() => execHook.pauseExecution()} disabled={busy}>
                Pause
              </button>
            )}
            {isPaused && (
              <button className="mop-workspace-header-btn primary" onClick={() => execHook.resumeExecution()} disabled={busy}>
                Resume
              </button>
            )}
            <button
              className="mop-workspace-header-btn primary"
              onClick={onCompleteClick}
              disabled={busy || !!executingStepId}
              title={pendingSteps > 0 ? `${pendingSteps} step${pendingSteps !== 1 ? 's' : ''} still pending` : 'Mark the execution complete'}
            >
              {completeLabel}
            </button>
            <button
              className="mop-workspace-header-btn danger"
              onClick={() => openDialog('abort')}
              title="Abort the execution (asks for confirmation)"
            >
              Abort
            </button>
          </div>
        )}
      </div>

      {/* Executions list (personal mode) */}
      {!isEnterprise && (planExecutions.length > 0 || planExecutionsLoading) && (
        <div className="mop-execute-executions">
          <div className="mop-execute-executions-header" onClick={() => setExecutionsOpen(o => !o)}>
            <span className={`mop-execute-step-group-chevron ${executionsOpen ? 'expanded' : ''}`}>
              <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                <path d="M6 4l4 4-4 4z" />
              </svg>
            </span>
            <span>Executions</span>
            <span className="mop-execute-step-group-count">{planExecutions.length}</span>
            <span style={{ flex: 1 }} />
            <button
              className="mop-plan-step-action-btn"
              onClick={(e) => { e.stopPropagation(); handleRefreshExecutions(); }}
              disabled={planExecutionsLoading}
              title="Refresh"
            >
              {planExecutionsLoading ? <span className="mop-ai-loading small" /> : 'Refresh'}
            </button>
          </div>
          {executionsOpen && (
            <div className="mop-execute-executions-list">
              {planExecutions.map(exec => {
                const isCurrent = execution?.id === exec.id;
                // The open execution's row follows the live status (pause/resume don't refetch the list)
                const status = isCurrent && execution ? execution.status : exec.status;
                return (
                  <div key={exec.id} className={`mop-execute-executions-row ${isCurrent ? 'current' : ''}`}>
                    <span className="mop-execute-executions-status" style={{ color: EXEC_STATUS_COLORS[status] || 'var(--text-secondary)' }}>
                      {EXEC_STATUS_LABELS[status] || status}
                    </span>
                    <span className="mop-execute-executions-name">{exec.name}</span>
                    <span className="mop-execute-executions-meta">
                      {exec.control_mode} · {new Date(exec.started_at || exec.created_at).toLocaleString()}
                    </span>
                    <span style={{ flex: 1 }} />
                    {isCurrent ? (
                      <span className="mop-execute-executions-current">Open</span>
                    ) : (
                      <button
                        className="mop-workspace-header-btn"
                        onClick={() => handleOpenExecution(exec.id)}
                        disabled={busy || !!executingStepId}
                      >
                        Open
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Phase controls (auto-run / AI pilot) + rollback */}
      {execution && controlMode !== 'manual' && !isFinished && (
        <div className="mop-execute-autorun-bar">
          {PHASE_STEP_TYPES.map(stepType => {
            const phase = PHASES.find(p => p.stepType === stepType)!;
            const isCurrentPhaseRunning = runningPhase === stepType || execState.phaseRunning?.stepType === stepType;
            const eligible = devicesEligibleForPhase(executionDevices, execState.stepsByDevice, stepType).length;
            const blocked = previousPhaseIncomplete(executionDevices, execState.stepsByDevice, stepType) && !runAnyway.has(stepType);
            const disabled = busy || eligible === 0 || blocked;
            const title = isCurrentPhaseRunning ? `Running ${phase.label}…`
              : eligible === 0 ? `No pending ${phase.label.toLowerCase()} on any device`
              : blocked ? 'Run the previous phase first (or use "Run anyway")'
              : `Run ${phase.label} on ${eligible} device${eligible !== 1 ? 's' : ''}`;
            return (
              <span key={phase.key} className="mop-execute-phase-btn-group">
                <button
                  className={`mop-workspace-header-btn ${isCurrentPhaseRunning ? '' : 'primary'}`}
                  disabled={disabled}
                  onClick={() => handleRunPhase(stepType)}
                  title={title}
                >
                  {isCurrentPhaseRunning ? `Running ${phase.label}...` : `Run ${phase.label}`}
                </button>
                {blocked && eligible > 0 && !busy && (
                  <button
                    className="mop-execute-run-anyway"
                    onClick={() => setRunAnyway(prev => new Set(prev).add(stepType))}
                    title="Ignore phase order for this phase"
                  >
                    Run anyway
                  </button>
                )}
              </span>
            );
          })}
          <span style={{ flex: 1 }} />
          <button
            className="mop-execute-rollback-btn"
            disabled={!anyRollbackSteps || busy || !isActive}
            onClick={() => handleRunRollback()}
            title={rollbackTitle}
          >
            {rollbackRunning ? 'Rolling back...' : 'Roll back all devices'}
          </button>
        </div>
      )}

      {/* Manual-mode driver bar */}
      {execution && controlMode === 'manual' && !isFinished && (
        <div className="mop-execute-autorun-bar mop-execute-manual-bar">
          <button
            className="mop-workspace-header-btn primary"
            onClick={handleRunNextStep}
            disabled={busy || !!executingStepId || !isActive || pendingSteps === 0}
            title={!isActive ? 'Resume the execution first' : pendingSteps === 0 ? 'No pending steps' : 'Run the next pending step (Enter)'}
          >
            Run next step
          </button>
          <button
            className="mop-workspace-header-btn"
            onClick={() => selectedExecStepData && handleSkipStep(selectedExecStepData.step.id)}
            disabled={!isActive || !selectedExecStepData || !(selectedExecStepData.step.status === 'pending' || selectedExecStepData.step.status === 'failed')}
            title="Skip the selected step (S)"
          >
            Skip selected
          </button>
          <button
            className="mop-workspace-header-btn"
            onClick={() => {
              const next = findNextPendingStep(executionDevices, execState.stepsByDevice, selectedExecStepData?.device.id ?? null);
              if (next) setSelectedExecStepId(next.step.id);
            }}
            disabled={pendingSteps === 0}
            title="Select the next pending step (N)"
          >
            Next
          </button>
          <span className="mop-execute-manual-hint">Enter = run · S = skip · N = next (focus this panel)</span>
          <span style={{ flex: 1 }} />
          <button
            className="mop-execute-rollback-btn"
            disabled={!anyRollbackSteps || busy || !isActive}
            onClick={() => handleRunRollback()}
            title={rollbackTitle}
          >
            {rollbackRunning ? 'Rolling back...' : 'Roll back all devices'}
          </button>
        </div>
      )}

      {/* Rollback affordance once the execution is finished (the agent accepts rollback in complete/failed/aborted) */}
      {execution && isFinished && anyRollbackSteps && (
        <div className="mop-execute-autorun-bar">
          <button
            className="mop-execute-rollback-btn"
            disabled={busy}
            onClick={() => handleRunRollback()}
            title={rollbackTitle}
          >
            {rollbackRunning ? 'Rolling back...' : 'Roll back all devices'}
          </button>
          <span className="mop-execute-manual-hint">Runs each device's rollback steps with the platform's config wrapper.</span>
        </div>
      )}

      {/* Notes from the last phase / rollback */}
      {phaseNotes && (
        <div className="mop-execute-phase-notes" data-testid="mop-phase-notes">
          <div className="mop-execute-phase-notes-title">
            Last {phaseNotes.stepType.replace('_', ' ')} run
          </div>
          {phaseNotes.lines.map(line => (
            <div key={line.deviceName} className={`mop-execute-phase-note ${line.error ? 'error' : ''}`}>
              <strong>{line.deviceName}</strong>: {line.text}
            </div>
          ))}
          {phaseNotes.extras.map(extra => (
            <div key={extra} className="mop-execute-phase-note">{extra}</div>
          ))}
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
              {aiPilot.state.driving && <span className="mop-ai-pilot-driving">running phases automatically…</span>}
              {aiPilot.state.processing && !aiPilot.state.driving && <span className="mop-ai-loading small" title="AI thinking" />}
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
                <p>On approval the pilot runs pre-checks, the change and post-checks back to back. Each phase gate must come back "proceed" with enough confidence; any failed step, other recommendation or low confidence stops it and hands control back to you.</p>
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

      {/* Pre-start block: unresolved placeholders / empty required variables */}
      {!execution && hasVariableIssues && (
        <div className="mop-workspace-banner error mop-variable-issues" role="alert" data-testid="mop-variable-issues">
          <span className="mop-variable-issues-title">
            Execution is blocked until every device resolves its variables (Plan tab → Variables, Devices tab → per-device values):
          </span>
          <ul>
            {variableIssues.map(issue => (
              <li key={`${issue.deviceId}:${issue.name}`}>
                {issue.deviceName} → <code>{`{{${issue.name}}}`}</code>{' '}
                {issue.reason === 'required' ? '(required, no value)' : '(not declared)'}
              </li>
            ))}
          </ul>
        </div>
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
                  const devicePlanSteps = hasPerDeviceSteps ? (perDeviceSteps[device.id] || steps) : steps;
                  const scopedSteps = sortPlanSteps(devicePlanSteps).filter(s => stepAppliesToDevice(s, device.id));
                  const flavor = flavorLabel((device as Session).cli_flavor);
                  return (
                    <div key={device.id} className="mop-execute-device-panel pending">
                      <div className="mop-execute-device-header" style={{ cursor: 'default' }}>
                        <span className="mop-execute-device-status pending" />
                        <span className="mop-execute-device-name">{deviceName}</span>
                        <span className="mop-execute-device-host">{deviceHost}</span>
                        {flavor && <span className="mop-execute-flavor-badge" title="CLI flavor">{flavor}</span>}
                        <span style={{ flex: 1 }} />
                        <span className="mop-execute-device-progress">
                          {scopedSteps.length === devicePlanSteps.length
                            ? `${scopedSteps.length} steps`
                            : `${scopedSteps.length} of ${devicePlanSteps.length} steps`}
                        </span>
                      </div>
                      <div className="mop-execute-device-steps">
                        {STEP_SECTIONS.filter(s => s.type !== 'rollback').map(({ type, label, color }) => {
                          const sectionSteps = scopedSteps.filter(s => s.step_type === type);
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
                              {!isPhaseCollapsed && sectionSteps.map((step, idx) => {
                                const scoped = step.device_scope === 'specific';
                                const n = scoped ? scopedDeviceCount(step, selectedDeviceIds) : selectedDeviceIds.size;
                                const deviceVars = variableMaps[device.id];
                                const resolvedCommand = deviceVars ? resolveMopVariables(step.command, deviceVars) : step.command;
                                const wasResolved = resolvedCommand !== step.command;
                                return (
                                  <div key={step.id} className="mop-execute-step pending">
                                    <div className="mop-execute-step-main">
                                      <span className="mop-execute-step-status pending" style={{ background: '#6e7681' }} />
                                      <span className="mop-execute-step-order" style={{ color }}>{idx + 1}</span>
                                      {step.execution_source === 'quick_action' && <span className="mop-step-source-badge api">API</span>}
                                      {step.execution_source === 'script' && <span className="mop-step-source-badge script">Script</span>}
                                      <span
                                        className={`mop-execute-step-command ${wasResolved ? 'resolved' : ''}`}
                                        title={wasResolved ? `Template: ${step.command}` : undefined}
                                      >
                                        {resolvedCommand || '(empty)'}
                                      </span>
                                      {scoped && (
                                        <span className="mop-execute-step-scope" title="Device scope from the Devices tab">
                                          ({n} of {selectedDeviceIds.size} devices)
                                        </span>
                                      )}
                                      <span style={{ flex: 1 }} />
                                      <span className="mop-execute-step-status-label pending">Pending</span>
                                    </div>
                                  </div>
                                );
                              })}
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
                const statusClass = DEVICE_STATUS_CLASSES[device.status] || 'pending';
                const hasRollback = deviceSteps.some(s => s.step_type === 'rollback');
                const isDeviceSkipped = device.status === 'skipped';
                const devicePhaseRunning = !!execState.phaseRunning?.deviceIds.includes(device.id);
                const flavor = flavorLabel(device.cli_flavor);

                return (
                  <div key={device.id} className={`mop-execute-device-panel ${statusClass}`}>
                    <div
                      className="mop-execute-device-header"
                      onClick={() => toggleExecutionDeviceExpand(device.id)}
                    >
                      <span className={`mop-execute-device-status ${statusClass}`} />
                      <span className="mop-execute-device-name">{device.device_name}</span>
                      <span className="mop-execute-device-host">{device.device_host}</span>
                      {flavor && <span className="mop-execute-flavor-badge" title="CLI flavor (drives the config wrapper)">{flavor}</span>}
                      {isDeviceSkipped && <span className="mop-execute-device-skipped">Skipped</span>}
                      {devicePhaseRunning && <span className="mop-ai-loading small" title="Phase running" />}
                      <span style={{ flex: 1 }} />
                      <span className="mop-execute-device-progress">
                        {statusInfo.label}
                      </span>
                      {hasRollback && !isDeviceSkipped && (
                        <button
                          className="mop-execute-rollback-btn run"
                          disabled={busy || !(isActive || isFinished)}
                          onClick={(e) => { e.stopPropagation(); handleRunRollback(device.id); }}
                          title={busy ? 'Wait for the current phase to finish' : !(isActive || isFinished) ? 'Start the execution first' : 'Run this device\'s rollback steps'}
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <polygon points="4,2 13,8 4,14" />
                          </svg>
                          Run rollback
                        </button>
                      )}
                      {hasRollback && (
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
                          title="Show / hide rollback steps"
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
                          const phaseSteps = deviceSteps
                            .filter(s => s.step_type === type)
                            .sort((a, b) => a.step_order - b.step_order);
                          if (phaseSteps.length === 0) return null;
                          const phaseKey = `${device.id}:${type}`;
                          // Rollback is always listed but collapsed until toggled
                          const isRollback = type === 'rollback';
                          const isPhaseCollapsed = isRollback ? !rollbackVisible.has(device.id) : collapsedPhases.has(phaseKey);
                          const toggleGroup = () => {
                            if (isRollback) {
                              setRollbackVisible(prev => {
                                const next = new Set(prev);
                                if (next.has(device.id)) next.delete(device.id);
                                else next.add(device.id);
                                return next;
                              });
                            } else {
                              togglePhaseCollapse(phaseKey);
                            }
                          };
                          const pendingHere = pendingStepsInPhase(phaseSteps, type).length;
                          const canRunPhaseHere = controlMode === 'manual' && !isRollback && isActive && !isDeviceSkipped && pendingHere > 0 && !busy && !executingStepId;

                          return (
                            <div key={type} className={`mop-execute-step-group ${isPhaseCollapsed ? 'collapsed' : ''}`}>
                              <div
                                className="mop-execute-step-group-header"
                                onClick={toggleGroup}
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
                                <span style={{ flex: 1 }} />
                                {canRunPhaseHere && (
                                  <button
                                    className="mop-execute-run-pending-btn"
                                    onClick={(e) => { e.stopPropagation(); handleRunPendingInPhase(device.id, type); }}
                                    title={`Run the ${pendingHere} pending ${label.toLowerCase()} on ${device.device_name}, in order`}
                                  >
                                    Run pending ({pendingHere})
                                  </button>
                                )}
                              </div>

                              {!isPhaseCollapsed && phaseSteps.map((step, idx) => {
                                const isExecuting = executingStepId === step.id;
                                const isEditing = editingStepId === step.id;
                                const isSelected = selectedExecStepId === step.id;
                                const stepActive = isActive && !isDeviceSkipped && !busy;
                                const canRun = controlMode === 'manual' && step.status === 'pending' && stepActive;
                                const canRunAll = canRun && executionDevices.length > 1 && !isRollback;
                                const canRetry = step.status === 'failed' && stepActive;
                                const canSkip = (step.status === 'pending' || step.status === 'failed') && stepActive;
                                const canEdit = step.status === 'pending' && stepActive;
                                const canReset = step.status === 'skipped' && stepActive;
                                const failedAssertions = step.assertion_results?.filter(a => !a.passed).length ?? 0;

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

                                      {step.error_message && (
                                        <span className="mop-execute-step-error-mark" title={step.error_message}>!</span>
                                      )}
                                      {failedAssertions > 0 && (
                                        <span className="mop-assertion-pill fail small" title={`${failedAssertions} assertion${failedAssertions !== 1 ? 's' : ''} failed`}>
                                          {failedAssertions} assert
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
                                            disabled={isExecuting || !!executingStepId}
                                            title="Run this step"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <polygon points="4,2 13,8 4,14" />
                                            </svg>
                                          </button>
                                        )}
                                        {canRunAll && (
                                          <button
                                            className="mop-execute-step-action-btn"
                                            onClick={(e) => { e.stopPropagation(); handleRunStepOnAllDevices(step.id); }}
                                            disabled={isExecuting || !!executingStepId}
                                            title="Run this step on all devices"
                                          >
                                            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                                              <polygon points="2,2 8,8 2,14" />
                                              <polygon points="8,2 14,8 8,14" />
                                            </svg>
                                          </button>
                                        )}
                                        {canRetry && (
                                          <button
                                            className="mop-execute-step-action-btn"
                                            onClick={(e) => { e.stopPropagation(); handleExecuteStep(step.id); }}
                                            disabled={!!executingStepId}
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

                  {/* Why the step failed (transport, vendor error marker, assertion, config save) */}
                  {selectedExecStepData.step.error_message && (
                    <div className="mop-execute-error-message" data-testid="mop-step-error">
                      {selectedExecStepData.step.error_message}
                    </div>
                  )}

                  {/* Evaluated expected_output assertions */}
                  {selectedExecStepData.step.assertion_results && selectedExecStepData.step.assertion_results.length > 0 && (
                    <div className="mop-assertion-results" data-testid="mop-assertion-results">
                      {selectedExecStepData.step.assertion_results.map((a, i) => (
                        <span
                          key={`${a.assertion}-${i}`}
                          className={`mop-assertion-pill ${a.passed ? 'pass' : 'fail'}`}
                          title={a.detail || (a.passed ? 'Passed' : 'Failed')}
                        >
                          {a.passed ? '✓' : '✗'} {a.assertion}
                        </span>
                      ))}
                    </div>
                  )}

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
                    ) : executingStepId === selectedExecStepData.step.id || execState.phaseRunning?.deviceIds.includes(selectedExecStepData.device.id) ? (
                      <div className="mop-execute-output-waiting">
                        <span className="mop-ai-loading small" /> {selectedExecStepData.step.status === 'running' || executingStepId === selectedExecStepData.step.id ? 'Executing...' : 'Waiting for this step...'}
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

      {/* Confirmation dialogs: Abort (with reason), Complete with failures/pending, New Execution */}
      {dialog && (
        <div className="mop-workspace-overlay" onClick={() => closeDialog()}>
          <div className="mop-workspace-dialog" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            {dialog === 'abort' && (
              <>
                <h3>Abort execution</h3>
                <p>Running steps are marked failed and pending steps skipped. This cannot be undone.</p>
                <textarea
                  className="mop-workspace-dialog-textarea"
                  value={abortReason}
                  onChange={(e) => setAbortReason(e.target.value)}
                  placeholder="Reason (optional) — recorded on the execution"
                  rows={2}
                  autoFocus
                />
                <div className="mop-workspace-dialog-actions">
                  <button className="mop-workspace-header-btn" onClick={() => closeDialog()}>Cancel</button>
                  <button
                    className="mop-workspace-header-btn danger"
                    onClick={() => { closeDialog(); handleAbort(abortReason.trim() || undefined); }}
                  >
                    Abort execution
                  </button>
                </div>
              </>
            )}
            {dialog === 'complete' && (
              <>
                <h3>Complete execution</h3>
                <p>
                  {failedSteps > 0 && `${failedSteps} step${failedSteps !== 1 ? 's' : ''} failed. `}
                  {pendingSteps > 0 && `${pendingSteps} step${pendingSteps !== 1 ? 's' : ''} never ran. `}
                  Mark the execution complete anyway? The results stay as they are.
                </p>
                <div className="mop-workspace-dialog-actions">
                  <button className="mop-workspace-header-btn" onClick={() => closeDialog()}>Cancel</button>
                  <button
                    className="mop-workspace-header-btn primary"
                    onClick={() => { closeDialog(); handleComplete(); }}
                  >
                    {completeLabel}
                  </button>
                </div>
              </>
            )}
            {dialog === 'new' && (
              <>
                <h3>Start a new execution?</h3>
                <p>The finished execution stays saved and can be reopened from the Executions list. Only this view is reset.</p>
                <div className="mop-workspace-dialog-actions">
                  <button className="mop-workspace-header-btn" onClick={() => closeDialog()}>Cancel</button>
                  <button
                    className="mop-workspace-header-btn primary"
                    onClick={() => { closeDialog(); handleNewExecution(); }}
                  >
                    New Execution
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
