import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import MopExecuteTab, { type MopExecuteTabProps } from '../MopExecuteTab';
import type { MopExecution, MopExecutionDevice, MopExecutionStep } from '../../../types/mop';
import type { MopExecutionState, UseMopExecutionReturn } from '../../../hooks/useMopExecution';
import type { UseAiPilotReturn } from '../../../hooks/useAiPilot';
import type { UseMopExecuteViewReturn, MopExecuteDialogKind } from '../useMopExecuteView';
import { useState } from 'react';

afterEach(() => cleanup());

function execution(over: Partial<MopExecution> = {}): MopExecution {
  return {
    id: 'e1', plan_id: 'p1', plan_revision: 1, name: 'Core BGP change', execution_strategy: 'sequential', control_mode: 'manual',
    status: 'running', on_failure: 'pause', created_by: 'u', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function device(id: string, order: number, over: Partial<MopExecutionDevice> = {}): MopExecutionDevice {
  return { id, execution_id: 'e1', device_name: id, device_host: `${id}.lab`, device_order: order, status: 'running', ...over };
}

function step(id: string, deviceId: string, type: MopExecutionStep['step_type'], over: Partial<MopExecutionStep> = {}): MopExecutionStep {
  return { id, execution_device_id: deviceId, step_order: 0, step_type: type, command: `cmd ${id}`, mock_enabled: false, status: 'pending', ...over };
}

function buildState(exec: MopExecution | null, devices: MopExecutionDevice[], stepsByDevice: Record<string, MopExecutionStep[]>): MopExecutionState {
  let total = 0, failed = 0, done = 0;
  for (const list of Object.values(stepsByDevice)) {
    for (const s of list) {
      if (s.step_type === 'rollback') continue;
      total++;
      if (s.status === 'failed') failed++;
      if (s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked') done++;
    }
  }
  return {
    execution: exec,
    devices,
    stepsByDevice,
    loading: false,
    error: null,
    progress: exec ? {
      phase: 'change_execution', totalDevices: devices.length, completedDevices: 0, currentDeviceIndex: 0,
      totalSteps: total, completedSteps: done, failedSteps: failed, skippedSteps: 0, mockedSteps: 0,
      percentComplete: total ? Math.round((done / total) * 100) : 0,
    } : null,
    phaseRunning: null,
    phaseResults: {},
    lastPhaseSummary: null,
  };
}

type BuildPropsOverrides = {
  [K in keyof MopExecuteTabProps]?: MopExecuteTabProps[K] extends object ? Partial<MopExecuteTabProps[K]> : MopExecuteTabProps[K];
};

function buildProps(state: MopExecutionState, over: BuildPropsOverrides = {}): MopExecuteTabProps {
  const noop = () => {};
  const execHook = {
    state,
    pauseExecution: vi.fn(async () => {}),
    resumeExecution: vi.fn(async () => {}),
    updateStepOutput: vi.fn(async () => {}),
    resetExecution: vi.fn(),
  } as unknown as UseMopExecutionReturn;
  const aiPilot = {
    state: { active: false, level: 1, commentary: [], planApproved: false, escalated: false, currentSuggestion: null, phaseGate: null },
    activate: noop, deactivate: noop,
  } as unknown as UseAiPilotReturn;
  const view: UseMopExecuteViewReturn = {
    currentPhase: state.progress?.phase ?? 'device_selection',
    progress: state.progress,
    selection: { selectedExecStepId: null, setSelectedExecStepId: vi.fn(), selectedExecStepData: null, ...over.view?.selection },
    phases: { collapsedPhases: new Set(), togglePhaseCollapse: noop, ...over.view?.phases },
    rollback: { rollbackVisible: new Set(), setRollbackVisible: noop, ...over.view?.rollback },
    devices: { expandedExecutionDevices: new Set(state.devices.map(d => d.id)), setExpandedExecutionDevices: noop, toggleExecutionDeviceExpand: noop, ...over.view?.devices },
    editing: { editingStepId: null, setEditingStepId: noop, editingStepCommand: '', setEditingStepCommand: noop, handleStartEditStep: noop, ...over.view?.editing },
    dialog: { dialog: null, abortReason: '', setAbortReason: noop, openDialog: noop, closeDialog: noop, ...over.view?.dialog },
  };
  return {
    isEnterprise: over.isEnterprise ?? false,
    view,
    exec: {
      execution: state.execution,
      devices: state.devices,
      execState: state,
      execHook,
      controlMode: 'manual',
      setControlMode: noop,
      executionStrategy: 'sequential',
      setExecutionStrategy: noop,
      onFailure: 'pause',
      setOnFailure: noop,
      executionStarting: false,
      runningPhase: null,
      rollbackRunning: false,
      executingStepId: null,
      ...over.exec,
    },
    plan: {
      steps: [],
      stepCount: 3,
      stepsBySection: { pre_check: [], change: [], post_check: [], rollback: [], api_action: [] },
      selectedDeviceIds: new Set(['r1', 'r2']),
      selectedDeviceList: [],
      hasPerDeviceSteps: false,
      perDeviceSteps: {},
      quickActions: [],
      scripts: [],
      isApprovalGated: false,
      approvalStatus: 'draft',
      variableMaps: {},
      variableIssues: [],
      ...over.plan,
    },
    ai: { aiRiskLevel: null, aiRiskReason: null, aiRiskChecking: false, aiPilot, ...over.ai },
    executions: {
      planExecutions: [],
      planExecutionsLoading: false,
      handleOpenExecution: vi.fn(),
      handleRefreshExecutions: vi.fn(),
      ...over.executions,
    },
    actions: {
      startExecutionFlow: vi.fn(),
      handleRunPhase: vi.fn(),
      handleExecuteStep: vi.fn(),
      handleSkipStep: vi.fn(),
      handleRunNextStep: vi.fn(),
      handleRunPendingInPhase: vi.fn(),
      handleRunStepOnAllDevices: vi.fn(),
      handleRunRollback: vi.fn(),
      handleAbort: vi.fn(),
      handleComplete: vi.fn(),
      handleNewExecution: vi.fn(),
      handleSaveEditStep: noop,
      getStepStatusColor: () => '#000',
      getDeviceStatusInfo: (d) => {
        const list = state.stepsByDevice[d.id] || [];
        const passed = list.filter(s => s.status === 'passed').length;
        const failed = list.filter(s => s.status === 'failed').length;
        return { passed, failed, total: list.length, label: `${passed}/${list.length} passed` };
      },
      setActiveTab: noop,
      formatDurationMs: (ms) => `${ms}ms`,
      ...over.actions,
    },
  };
}

const runningWithFailures = () => {
  const devices = [device('r1', 0, { cli_flavor: 'cisco-ios' }), device('r2', 1)];
  const steps = {
    r1: [
      step('s1', 'r1', 'pre_check', { status: 'passed' }),
      step('s2', 'r1', 'change', { status: 'failed', error_message: '% Invalid input detected', step_order: 1 }),
      step('s3', 'r1', 'rollback', { step_order: 2 }),
    ],
    r2: [
      step('s4', 'r2', 'pre_check', { status: 'failed', step_order: 0, assertion_results: [{ assertion: 'CONTAINS: Established', passed: false, detail: 'not found' }] }),
      step('s5', 'r2', 'change', { step_order: 1 }),
    ],
  };
  return buildState(execution(), devices, steps);
};


/** The confirm dialogs' state lives in useMopExecuteView; give the tab a real one. */
function StatefulTab(props: MopExecuteTabProps) {
  const [dialog, setDialog] = useState<MopExecuteDialogKind | null>(null);
  const [abortReason, setAbortReason] = useState('');
  const view: UseMopExecuteViewReturn = {
    ...props.view,
    dialog: {
      dialog,
      abortReason,
      setAbortReason,
      openDialog: (kind) => { if (kind === 'abort') setAbortReason(''); setDialog(kind); },
      closeDialog: () => setDialog(null),
    },
  };
  return <MopExecuteTab {...props} view={view} />;
}

describe('MopExecuteTab', () => {
  it('renders the devices, their flavor badge and the failure marker', () => {
    render(<MopExecuteTab {...buildProps(runningWithFailures())} />);
    expect(screen.getByText('r1')).toBeInTheDocument();
    expect(screen.getByText('r2')).toBeInTheDocument();
    expect(screen.getByText('Cisco IOS/IOS-XE')).toBeInTheDocument();
    expect(screen.getByTitle('% Invalid input detected')).toBeInTheDocument();
    // Rollback group is listed (collapsed) once an execution exists, with its
    // show/hide toggle and a per-device "Run rollback" action
    expect(screen.getAllByText('Rollback').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Run rollback/ })).toBeInTheDocument();
    expect(screen.queryByText('cmd s3')).not.toBeInTheDocument(); // collapsed until toggled
  });

  it('labels Complete with the failure count and confirms before completing', () => {
    const props = buildProps(runningWithFailures());
    render(<StatefulTab {...props} />);
    const complete = screen.getByRole('button', { name: 'Complete with 2 failures' });
    fireEvent.click(complete);
    expect(props.actions.handleComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Complete execution' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Complete with 2 failures' })[1]);
    expect(props.actions.handleComplete).toHaveBeenCalledTimes(1);
  });

  it('Abort asks for confirmation and passes the optional reason', () => {
    const props = buildProps(runningWithFailures());
    render(<StatefulTab {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    expect(props.actions.handleAbort).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Abort execution' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Reason \(optional\)/), { target: { value: 'BGP flapped' } });
    fireEvent.click(screen.getByRole('button', { name: 'Abort execution' }));
    expect(props.actions.handleAbort).toHaveBeenCalledWith('BGP flapped');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // There is exactly one abort control and no "Cancel" execution button
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('shows the selected step\'s error and assertion pills in the output pane', () => {
    const state = runningWithFailures();
    const props = buildProps(state, {
      view: { selection: { selectedExecStepId: 's4', selectedExecStepData: { step: state.stepsByDevice.r2[0], device: state.devices[1] } } },
    });
    render(<StatefulTab {...props} />);
    expect(screen.getByTestId('mop-assertion-results')).toHaveTextContent('CONTAINS: Established');
  });

  it('keyboard: Enter runs the next step, N selects it', () => {
    const props = buildProps(runningWithFailures());
    render(<StatefulTab {...props} />);
    const root = screen.getByTestId('mop-execute-tab');
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(props.actions.handleRunNextStep).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: 'n' });
    expect(props.view.selection.setSelectedExecStepId).toHaveBeenCalledWith('s5');
  });

  it('finished execution keeps the view, offers New Execution behind a confirm, and lists executions', () => {
    const state = runningWithFailures();
    state.execution = execution({ status: 'aborted' });
    const props = buildProps(state, {
      executions: { planExecutions: [execution({ id: 'e0', status: 'complete', name: 'Earlier run' }), state.execution] },
    });
    render(<StatefulTab {...props} />);
    expect(screen.getByText('r1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New Execution' }));
    expect(props.actions.handleNewExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'New Execution' })[1]);
    expect(props.actions.handleNewExecution).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Executions'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(props.executions.handleOpenExecution).toHaveBeenCalledWith('e0');
  });
});
