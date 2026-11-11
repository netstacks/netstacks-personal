/**
 * useMopExecution - Hook for managing MOP execution state
 *
 * This hook provides:
 * - Load/create/update execution
 * - Device and step state management
 * - Execution control actions (start, pause, resume, abort, complete)
 * - Step execution with mock support
 * - Phase execution that honours the execution's strategy / on_failure /
 *   pause_after_* settings, skips skipped devices and polls step rows
 *   every 2 s while a phase is in flight
 * - Rollback per device / for every device
 * - Auto-save checkpoints
 * - Progress tracking and phase detection
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import * as mopApi from '../api/mop';
import { getMopErrorMessage, type PhaseExecutionResult, type MopStepTimeoutOptions } from '../api/mop';
import type {
  MopExecution,
  MopExecutionDevice,
  MopExecutionStep,
  ExecutionPhase,
  NewMopExecution,
  UpdateMopExecution,
  NewMopExecutionStep,
  MockConfig,
  StepOutputUpdate,
} from '../types/mop';
import type { MopStepType } from '../types/change';
import {
  devicesEligibleForPhase,
  remapPairedStepIds,
} from '../components/mop/mopHelpers';
import type { PhaseStepType } from '../components/mop/constants';

/** How often step rows are re-fetched for a device while a phase runs on it. */
export const PHASE_POLL_INTERVAL_MS = 2000;

// Progress info for the execution
export interface ExecutionProgress {
  phase: ExecutionPhase;
  totalDevices: number;
  completedDevices: number;
  currentDeviceIndex: number;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  mockedSteps: number;
  percentComplete: number;
}

// Checkpoint for pause/resume
export interface ExecutionCheckpoint {
  executionId: string;
  phase: ExecutionPhase;
  currentDeviceId: string | null;
  currentStepId: string | null;
  timestamp: string;
}

// Timer ref type
type TimerRef = ReturnType<typeof setInterval> | null;

/** Options for runPhase. */
export interface RunPhaseOptions extends MopStepTimeoutOptions {
  /** Restrict the phase to these devices (default: every eligible device). */
  deviceIds?: string[];
}

/** What happened during one runPhase / rollback call. */
export interface PhaseRunSummary {
  stepType: MopStepType;
  /** Devices the phase actually ran on. */
  deviceIds: string[];
  results: PhaseExecutionResult[];
  /** Devices whose phase reported failures or whose request failed. */
  failedDeviceIds: string[];
  /** Request errors keyed by device id (409s, transport errors …). */
  errors: Record<string, string>;
  /** on_failure=abort fired — the execution was aborted. */
  aborted: boolean;
  /** The execution was paused after the phase (on_failure=pause or pause_after_*). */
  paused: boolean;
}

// Hook state
export interface MopExecutionState {
  execution: MopExecution | null;
  devices: MopExecutionDevice[];
  stepsByDevice: Record<string, MopExecutionStep[]>;
  loading: boolean;
  /** Last action error — rendered by the workspace banner; clear with clearError(). */
  error: string | null;
  progress: ExecutionProgress | null;
  /** Phase currently in flight (step type + devices), or null. */
  phaseRunning: { stepType: MopStepType; deviceIds: string[] } | null;
  /** Result of the most recent phase / rollback per device id. */
  phaseResults: Record<string, PhaseExecutionResult>;
  /** Summary of the most recent runPhase / rollback call. */
  lastPhaseSummary: PhaseRunSummary | null;
}

/** Extra per-device fields for `addDevice` (appended as an options object). */
export interface AddDeviceOptions {
  /** Resolved `{{name}}` map for the device (plan defaults ∪ overrides). */
  variables?: Record<string, string>;
}

// Hook return type
export interface UseMopExecutionReturn {
  // State
  state: MopExecutionState;

  // Execution CRUD
  loadExecution: (id: string) => Promise<void>;
  createExecution: (data: NewMopExecution) => Promise<MopExecution>;
  updateExecution: (update: UpdateMopExecution) => Promise<void>;

  // Device management
  addDevice: (sessionId: string, order: number, deviceName?: string, deviceHost?: string, deviceId?: string, credentialId?: string, role?: string, options?: AddDeviceOptions) => Promise<MopExecutionDevice>;
  removeDevice: (deviceId: string) => Promise<void>;
  reorderDevices: (deviceIds: string[]) => Promise<void>;

  // Step management
  loadSteps: (deviceId: string) => Promise<MopExecutionStep[]>;
  /** `planStepIds[i]` is the plan step `steps[i]` was cloned from — used to
   *  remap `paired_step_id` onto the execution ids the agent assigns. */
  addSteps: (deviceId: string, steps: Omit<NewMopExecutionStep, 'execution_device_id'>[], planStepIds?: string[]) => Promise<MopExecutionStep[]>;
  updateStepMock: (stepId: string, config: MockConfig) => Promise<void>;

  // Execution control
  startExecution: () => Promise<void>;
  pauseExecution: () => Promise<void>;
  resumeExecution: () => Promise<void>;
  /** Abort. `reason` (optional) is appended to the execution description —
   *  the agent has no dedicated abort-reason field. */
  abortExecution: (reason?: string) => Promise<void>;
  completeExecution: (aiAnalysis?: string) => Promise<void>;

  // Device control
  skipDevice: (deviceId: string) => Promise<void>;
  retryDevice: (deviceId: string) => Promise<void>;
  /** Run the device's rollback steps. Requires a running execution. */
  rollbackDevice: (deviceId: string, opts?: MopStepTimeoutOptions) => Promise<PhaseRunSummary>;
  /** Roll back every non-skipped device that has rollback steps (sequential). */
  rollbackAllDevices: (opts?: MopStepTimeoutOptions) => Promise<PhaseRunSummary>;

  // Step control. executeStep resolves with the updated step row (undefined when no execution is loaded).
  executeStep: (stepId: string, opts?: MopStepTimeoutOptions) => Promise<MopExecutionStep | undefined>;
  approveStep: (stepId: string) => Promise<void>;
  skipStep: (stepId: string) => Promise<void>;
  updateStepOutput: (stepId: string, output: StepOutputUpdate) => Promise<void>;
  updateStepCommand: (stepId: string, command: string) => Promise<void>;

  // Phase execution — honours execution_strategy / on_failure / pause_after_*
  runPhase: (stepType: PhaseStepType, opts?: RunPhaseOptions) => Promise<PhaseRunSummary | null>;

  // Progress
  calculateProgress: () => ExecutionProgress;
  detectPhase: () => ExecutionPhase;

  // Checkpoint
  saveCheckpoint: () => Promise<void>;
  loadCheckpoint: () => ExecutionCheckpoint | null;

  // Refresh
  refresh: () => Promise<void>;

  // Errors
  setError: (message: string | null) => void;
  clearError: () => void;

  // Reset (clear execution state for fresh start)
  resetExecution: () => void;
}

// Initial state
const initialState: MopExecutionState = {
  execution: null,
  devices: [],
  stepsByDevice: {},
  loading: false,
  error: null,
  progress: null,
  phaseRunning: null,
  phaseResults: {},
  lastPhaseSummary: null,
};

// Calculate progress from devices and steps
function calculateProgressFromState(
  devices: MopExecutionDevice[],
  stepsByDevice: Record<string, MopExecutionStep[]>
): ExecutionProgress {
  let totalSteps = 0;
  let completedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;
  let mockedSteps = 0;
  let completedDevices = 0;
  let currentDeviceIndex = 0;

  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const steps = stepsByDevice[device.id] || [];

    if (device.status === 'complete') {
      completedDevices++;
    } else if (device.status === 'running' || device.status === 'waiting') {
      currentDeviceIndex = i;
    }

    for (const step of steps) {
      // Exclude rollback steps from progress — they only run on failure
      if (step.step_type === 'rollback') continue;
      totalSteps++;
      if (step.status === 'passed') completedSteps++;
      else if (step.status === 'failed') failedSteps++;
      else if (step.status === 'skipped') skippedSteps++;
      else if (step.status === 'mocked') {
        mockedSteps++;
        completedSteps++;
      }
    }
  }

  const percentComplete = totalSteps > 0
    ? Math.round(((completedSteps + skippedSteps) / totalSteps) * 100)
    : 0;

  return {
    phase: 'device_selection', // Will be overridden by detectPhase
    totalDevices: devices.length,
    completedDevices,
    currentDeviceIndex,
    totalSteps,
    completedSteps,
    failedSteps,
    skippedSteps,
    mockedSteps,
    percentComplete,
  };
}

// Detect current phase based on execution state
function detectPhaseFromState(
  execution: MopExecution | null,
  devices: MopExecutionDevice[],
  stepsByDevice: Record<string, MopExecutionStep[]>
): ExecutionPhase {
  if (!execution) return 'device_selection';

  // Check execution status
  if (execution.status === 'pending') {
    // No devices = device selection
    if (devices.length === 0) return 'device_selection';
    // Has devices but not started = configuration
    return 'configuration';
  }

  if (execution.status === 'complete' || execution.status === 'completed' || execution.status === 'failed' || execution.status === 'aborted') {
    return 'review';
  }

  // Running or paused - check step progress
  for (const device of devices) {
    const steps = stepsByDevice[device.id] || [];

    // Check for pre_check steps in progress
    const preChecks = steps.filter(s => s.step_type === 'pre_check');
    const preChecksComplete = preChecks.every(s =>
      s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
    );
    if (!preChecksComplete && preChecks.some(s => s.status !== 'pending')) {
      return 'pre_checks';
    }

    // Check for change steps in progress
    const changes = steps.filter(s => s.step_type === 'change');
    const changesComplete = changes.every(s =>
      s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
    );
    if (!changesComplete && changes.some(s => s.status !== 'pending')) {
      return 'change_execution';
    }

    // Check for post_check steps in progress
    const postChecks = steps.filter(s => s.step_type === 'post_check');
    const postChecksComplete = postChecks.every(s =>
      s.status === 'passed' || s.status === 'skipped' || s.status === 'mocked'
    );
    if (!postChecksComplete && postChecks.some(s => s.status !== 'pending')) {
      return 'post_checks';
    }
  }

  // If we have devices and all steps pending, we're in pre_checks
  const hasAnySteps = devices.some(d => (stepsByDevice[d.id] || []).length > 0);
  if (hasAnySteps) return 'pre_checks';

  return 'configuration';
}

// Helper to update a single step across all devices in the stepsByDevice map
function updateStepInState(
  prev: MopExecutionState,
  stepId: string,
  updatedStep: MopExecutionStep
): MopExecutionState {
  const newStepsByDevice = { ...prev.stepsByDevice };
  for (const deviceId of Object.keys(newStepsByDevice)) {
    newStepsByDevice[deviceId] = newStepsByDevice[deviceId].map(s =>
      s.id === stepId ? updatedStep : s
    );
  }
  return { ...prev, stepsByDevice: newStepsByDevice };
}

// Drop duplicate step rows (older agents could return a step twice)
function dedupeSteps(raw: MopExecutionStep[]): MopExecutionStep[] {
  const seen = new Set<string>();
  return raw.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

async function fetchDevicesAndSteps(execId: string): Promise<{
  devices: MopExecutionDevice[];
  stepsByDevice: Record<string, MopExecutionStep[]>;
}> {
  const devices = await mopApi.listExecutionDevices(execId);
  const stepsByDevice: Record<string, MopExecutionStep[]> = {};
  for (const device of devices) {
    stepsByDevice[device.id] = dedupeSteps(await mopApi.listExecutionSteps(execId, device.id));
  }
  return { devices, stepsByDevice };
}

function emptySummary(stepType: MopStepType): PhaseRunSummary {
  return { stepType, deviceIds: [], results: [], failedDeviceIds: [], errors: {}, aborted: false, paused: false };
}

export function useMopExecution(executionId?: string): UseMopExecutionReturn {
  const [state, setState] = useState<MopExecutionState>(initialState);
  const autoSaveRef = useRef<TimerRef>(null);
  // Ref for immediate access to execution (avoids React stale closure issue)
  const execRef = useRef<MopExecution | null>(null);
  // Latest devices/steps for async loops (runPhase must not close over stale state)
  const stateRef = useRef<MopExecutionState>(initialState);
  // Active step pollers, so unmount never leaves an interval behind
  const pollersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const pollers = pollersRef.current;
    return () => {
      for (const timer of pollers) clearInterval(timer);
      pollers.clear();
    };
  }, []);

  const setError = useCallback((message: string | null) => {
    setState(prev => ({ ...prev, error: message }));
  }, []);

  const clearError = useCallback(() => {
    setState(prev => (prev.error === null ? prev : { ...prev, error: null }));
  }, []);

  // Refresh devices + steps (+ the execution row, whose status may have moved)
  const refreshAll = useCallback(async (execId: string) => {
    const [execution, { devices, stepsByDevice }] = await Promise.all([
      mopApi.getMopExecution(execId),
      fetchDevicesAndSteps(execId),
    ]);
    execRef.current = execution;
    setState(prev => ({ ...prev, execution, devices, stepsByDevice }));
  }, []);

  // Poll one device's step rows every PHASE_POLL_INTERVAL_MS until stopped
  const startStepPoller = useCallback((execId: string, deviceId: string): (() => void) => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const steps = dedupeSteps(await mopApi.listExecutionSteps(execId, deviceId));
        setState(prev => ({ ...prev, stepsByDevice: { ...prev.stepsByDevice, [deviceId]: steps } }));
      } catch {
        // Polling is best-effort; the phase result refresh is authoritative.
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(tick, PHASE_POLL_INTERVAL_MS);
    pollersRef.current.add(timer);
    return () => {
      clearInterval(timer);
      pollersRef.current.delete(timer);
    };
  }, []);

  // Load execution by ID
  const loadExecution = useCallback(async (id: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const execution = await mopApi.getMopExecution(id);
      execRef.current = execution;
      const { devices, stepsByDevice } = await fetchDevicesAndSteps(id);

      setState({
        ...initialState,
        execution,
        devices,
        stepsByDevice,
      });
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: getMopErrorMessage(err, 'Failed to load execution'),
      }));
    }
  }, []);

  // Create new execution
  const createExecution = useCallback(async (data: NewMopExecution): Promise<MopExecution> => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const execution = await mopApi.createMopExecution(data);
      execRef.current = execution;
      setState({ ...initialState, execution });
      return execution;
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: getMopErrorMessage(err, 'Failed to create execution'),
      }));
      throw err;
    }
  }, []);

  // Update execution
  const updateExecution = useCallback(async (update: UpdateMopExecution) => {
    const exec = execRef.current;
    if (!exec) return;
    try {
      const execution = await mopApi.updateMopExecution(exec.id, update);
      execRef.current = execution;
      setState(prev => ({ ...prev, execution }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: getMopErrorMessage(err, 'Failed to update execution'),
      }));
    }
  }, []);

  // Add device to execution.
  // Professional mode: supply sessionId. Enterprise mode: supply deviceId + credentialId.
  // device_name and device_host are always required for display/routing.
  const addDevice = useCallback(async (
    sessionId: string,
    order: number,
    deviceName: string = '',
    deviceHost: string = '',
    deviceId?: string,
    credentialId?: string,
    role?: string,
    options?: AddDeviceOptions,
  ): Promise<MopExecutionDevice> => {
    const exec = execRef.current;
    if (!exec) throw new Error('No execution loaded');
    const device = await mopApi.addExecutionDevice(exec.id, {
      session_id: sessionId || undefined,
      device_id: deviceId,
      credential_id: credentialId,
      device_name: deviceName,
      device_host: deviceHost,
      role,
      device_order: order,
      variables: options?.variables,
    });
    setState(prev => ({
      ...prev,
      devices: [...prev.devices, device],
      stepsByDevice: { ...prev.stepsByDevice, [device.id]: [] },
    }));
    return device;
  }, []);

  // Remove device (client-side only - would need API endpoint)
  const removeDevice = useCallback(async (deviceId: string) => {
    setState(prev => ({
      ...prev,
      devices: prev.devices.filter(d => d.id !== deviceId),
      stepsByDevice: Object.fromEntries(
        Object.entries(prev.stepsByDevice).filter(([id]) => id !== deviceId)
      ),
    }));
  }, []);

  // Reorder devices
  const reorderDevices = useCallback(async (deviceIds: string[]) => {
    setState(prev => {
      const deviceMap = new Map(prev.devices.map(d => [d.id, d]));
      const reordered = deviceIds
        .map((id, idx) => {
          const device = deviceMap.get(id);
          return device ? { ...device, device_order: idx } : null;
        })
        .filter((d): d is MopExecutionDevice => d !== null);
      return { ...prev, devices: reordered };
    });
  }, []);

  // Load steps for a device
  const loadSteps = useCallback(async (deviceId: string): Promise<MopExecutionStep[]> => {
    const exec = execRef.current;
    if (!exec) return [];
    const steps = dedupeSteps(await mopApi.listExecutionSteps(exec.id, deviceId));
    setState(prev => ({
      ...prev,
      stepsByDevice: { ...prev.stepsByDevice, [deviceId]: steps },
    }));
    return steps;
  }, []);

  // Add steps to a device. Pairings are sent with plan ids and remapped to
  // the execution ids the agent returns (created[i] ↔ planStepIds[i]).
  const addSteps = useCallback(async (
    deviceId: string,
    steps: Omit<NewMopExecutionStep, 'execution_device_id'>[],
    planStepIds?: string[],
  ): Promise<MopExecutionStep[]> => {
    const exec = execRef.current;
    if (!exec) throw new Error('No execution loaded');
    const raw = await mopApi.addExecutionSteps(exec.id, deviceId, steps);
    const created = planStepIds ? remapPairedStepIds(raw, planStepIds) : raw;
    setState(prev => ({
      ...prev,
      stepsByDevice: {
        ...prev.stepsByDevice,
        [deviceId]: [...(prev.stepsByDevice[deviceId] || []), ...created],
      },
    }));
    return created;
  }, []);

  // Update step mock configuration
  const updateStepMock = useCallback(async (stepId: string, config: MockConfig) => {
    const exec = execRef.current;
    if (!exec) return;
    const step = await mopApi.updateStepMock(exec.id, stepId, config);
    setState(prev => updateStepInState(prev, stepId, step));
  }, []);

  // Execution control
  const startExecution = useCallback(async () => {
    const exec = execRef.current;
    if (!exec) return;
    const execution = await mopApi.startMopExecution(exec.id);
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
  }, []);

  const pauseExecution = useCallback(async () => {
    const exec = execRef.current;
    if (!exec) return;
    const execution = await mopApi.pauseMopExecution(exec.id);
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
  }, []);

  const resumeExecution = useCallback(async () => {
    const exec = execRef.current;
    if (!exec) return;
    const execution = await mopApi.resumeMopExecution(exec.id);
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
  }, []);

  const abortExecution = useCallback(async (reason?: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const trimmed = reason?.trim();
    if (trimmed) {
      // No abort_reason column on the agent — keep it on the description so
      // it survives in the executions list.
      try {
        await mopApi.updateMopExecution(exec.id, {
          description: [exec.description, `Aborted: ${trimmed}`].filter(Boolean).join('\n'),
        });
      } catch {
        // The reason is informational; the abort itself must still go through.
      }
    }
    const execution = await mopApi.abortMopExecution(exec.id);
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
    // Abort flips running devices/steps to failed and pending steps to skipped.
    try {
      const { devices, stepsByDevice } = await fetchDevicesAndSteps(exec.id);
      setState(prev => ({ ...prev, devices, stepsByDevice }));
    } catch {
      // Status already updated; a stale step list is recoverable via refresh().
    }
  }, []);

  const completeExecution = useCallback(async (aiAnalysis?: string) => {
    const exec = execRef.current;
    if (!exec) return;
    // Only send ai_analysis when there is one — the agent keeps the stored
    // value when the body carries no non-null analysis.
    const execution = await mopApi.completeMopExecution(exec.id, aiAnalysis ? { ai_analysis: aiAnalysis } : {});
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
  }, []);

  // Device control
  const skipDevice = useCallback(async (deviceId: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const device = await mopApi.skipExecutionDevice(exec.id, deviceId);
    setState(prev => ({
      ...prev,
      devices: prev.devices.map(d => d.id === deviceId ? device : d),
    }));
  }, []);

  const retryDevice = useCallback(async (deviceId: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const device = await mopApi.retryExecutionDevice(exec.id, deviceId);
    // Retry also resets the device's failed/skipped steps to pending.
    const steps = dedupeSteps(await mopApi.listExecutionSteps(exec.id, deviceId));
    setState(prev => ({
      ...prev,
      devices: prev.devices.map(d => d.id === deviceId ? device : d),
      stepsByDevice: { ...prev.stepsByDevice, [deviceId]: steps },
    }));
  }, []);

  // Run one device's phase (or rollback) with live step polling. Returns
  // whether the device should count as failed for on_failure purposes.
  const runDevicePhase = useCallback(async (
    execId: string,
    device: MopExecutionDevice,
    stepType: PhaseStepType | 'rollback',
    summary: PhaseRunSummary,
    opts?: MopStepTimeoutOptions,
  ): Promise<boolean> => {
    const stopPolling = startStepPoller(execId, device.id);
    try {
      const result = stepType === 'rollback'
        ? await mopApi.rollbackExecutionDevice(execId, device.id, opts)
        : await mopApi.executeDevicePhase(execId, device.id, stepType, opts);
      summary.results.push(result);
      setState(prev => ({ ...prev, phaseResults: { ...prev.phaseResults, [device.id]: result } }));
      const failed = result.steps_failed > 0 || result.stopped_early || !!result.post_command_error;
      if (failed) summary.failedDeviceIds.push(device.id);
      return failed;
    } catch (err) {
      const message = getMopErrorMessage(err, `Failed to run ${stepType} on ${device.device_name}`);
      summary.errors[device.id] = message;
      summary.failedDeviceIds.push(device.id);
      setState(prev => ({ ...prev, error: `${device.device_name}: ${message}` }));
      return true;
    } finally {
      stopPolling();
    }
  }, [startStepPoller]);

  // Pause only when the execution is still running (a 409 here is noise).
  const pauseIfRunning = useCallback(async (): Promise<boolean> => {
    if (execRef.current?.status !== 'running') return false;
    try {
      const execution = await mopApi.pauseMopExecution(execRef.current.id);
      execRef.current = execution;
      setState(prev => ({ ...prev, execution }));
      return true;
    } catch (err) {
      setState(prev => ({ ...prev, error: getMopErrorMessage(err, 'Failed to pause execution') }));
      return false;
    }
  }, []);

  // Run a phase across the eligible devices, honouring execution settings.
  const runPhase = useCallback(async (stepType: PhaseStepType, opts: RunPhaseOptions = {}): Promise<PhaseRunSummary | null> => {
    const exec = execRef.current;
    if (!exec) return null;

    const { devices, stepsByDevice } = stateRef.current;
    let targets = devicesEligibleForPhase(devices, stepsByDevice, stepType);
    if (opts.deviceIds) {
      const wanted = new Set(opts.deviceIds);
      targets = targets.filter(d => wanted.has(d.id));
    }
    targets = [...targets].sort((a, b) => a.device_order - b.device_order);

    const summary = emptySummary(stepType);
    summary.deviceIds = targets.map(d => d.id);
    if (targets.length === 0) {
      setState(prev => ({ ...prev, lastPhaseSummary: summary }));
      return summary;
    }

    const targetIds = new Set(summary.deviceIds);
    setState(prev => ({
      ...prev,
      error: null,
      phaseRunning: { stepType, deviceIds: summary.deviceIds },
      phaseResults: Object.fromEntries(Object.entries(prev.phaseResults).filter(([id]) => !targetIds.has(id))),
    }));

    const onFailure = exec.on_failure || 'pause';
    const timeoutOpts = opts.timeoutSecs != null ? { timeoutSecs: opts.timeoutSecs } : undefined;

    try {
      if (exec.execution_strategy === 'parallel_by_phase') {
        await Promise.all(targets.map(device => runDevicePhase(exec.id, device, stepType, summary, timeoutOpts)));
      } else {
        for (const device of targets) {
          const failed = await runDevicePhase(exec.id, device, stepType, summary, timeoutOpts);
          if (failed && onFailure === 'abort') break;
        }
      }

      if (summary.failedDeviceIds.length > 0 && onFailure === 'abort') {
        summary.aborted = true;
        try {
          const execution = await mopApi.abortMopExecution(exec.id);
          execRef.current = execution;
          setState(prev => ({ ...prev, execution }));
        } catch (err) {
          setState(prev => ({ ...prev, error: getMopErrorMessage(err, 'Failed to abort execution') }));
        }
      } else if (summary.failedDeviceIds.length > 0 && onFailure === 'pause') {
        summary.paused = await pauseIfRunning();
      } else {
        const pauseAfter =
          (stepType === 'pre_check' && !!exec.pause_after_pre_checks) ||
          (stepType === 'change' && !!exec.pause_after_changes) ||
          (stepType === 'post_check' && !!exec.pause_after_post_checks);
        if (pauseAfter) summary.paused = await pauseIfRunning();
      }
    } finally {
      try {
        await refreshAll(exec.id);
      } catch (err) {
        setState(prev => ({ ...prev, error: getMopErrorMessage(err, 'Failed to refresh execution state') }));
      }
      setState(prev => ({ ...prev, phaseRunning: null, lastPhaseSummary: summary }));
    }

    return summary;
  }, [runDevicePhase, pauseIfRunning, refreshAll]);

  // Rollback: one device or every device with rollback steps (sequential —
  // rollback is the one place we never want to race the devices).
  const runRollback = useCallback(async (deviceIds: string[] | null, opts?: MopStepTimeoutOptions): Promise<PhaseRunSummary> => {
    const summary = emptySummary('rollback');
    const exec = execRef.current;
    if (!exec) return summary;

    const { devices, stepsByDevice } = stateRef.current;
    let targets = devices.filter(d =>
      d.status !== 'skipped' && (stepsByDevice[d.id] || []).some(s => s.step_type === 'rollback'),
    );
    if (deviceIds) {
      const wanted = new Set(deviceIds);
      targets = targets.filter(d => wanted.has(d.id));
    }
    targets = [...targets].sort((a, b) => a.device_order - b.device_order);
    summary.deviceIds = targets.map(d => d.id);
    if (targets.length === 0) {
      setState(prev => ({ ...prev, lastPhaseSummary: summary }));
      return summary;
    }

    setState(prev => ({ ...prev, error: null, phaseRunning: { stepType: 'rollback', deviceIds: summary.deviceIds } }));
    try {
      for (const device of targets) {
        await runDevicePhase(exec.id, device, 'rollback', summary, opts);
      }
    } finally {
      try {
        await refreshAll(exec.id);
      } catch (err) {
        setState(prev => ({ ...prev, error: getMopErrorMessage(err, 'Failed to refresh execution state') }));
      }
      setState(prev => ({ ...prev, phaseRunning: null, lastPhaseSummary: summary }));
    }
    return summary;
  }, [runDevicePhase, refreshAll]);

  const rollbackDevice = useCallback(
    (deviceId: string, opts?: MopStepTimeoutOptions) => runRollback([deviceId], opts),
    [runRollback],
  );

  const rollbackAllDevices = useCallback(
    (opts?: MopStepTimeoutOptions) => runRollback(null, opts),
    [runRollback],
  );

  // Step control
  const executeStep = useCallback(async (stepId: string, opts?: MopStepTimeoutOptions): Promise<MopExecutionStep | undefined> => {
    const exec = execRef.current;
    if (!exec) return undefined;
    const step = await mopApi.executeStep(exec.id, stepId, opts);
    setState(prev => updateStepInState(prev, stepId, step));
    return step;
  }, []);

  const approveStep = useCallback(async (stepId: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const step = await mopApi.approveStep(exec.id, stepId);
    setState(prev => updateStepInState(prev, stepId, step));
  }, []);

  const skipStep = useCallback(async (stepId: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const step = await mopApi.skipStep(exec.id, stepId);
    setState(prev => updateStepInState(prev, stepId, step));
  }, []);

  const updateStepOutput = useCallback(async (stepId: string, output: StepOutputUpdate) => {
    const exec = execRef.current;
    if (!exec) return;
    const step = await mopApi.updateStepOutput(exec.id, stepId, output);
    setState(prev => updateStepInState(prev, stepId, step));
  }, []);

  const updateStepCommand = useCallback(async (stepId: string, command: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const step = await mopApi.updateStepCommand(exec.id, stepId, command);
    setState(prev => updateStepInState(prev, stepId, step));
  }, []);

  // Derived progress (no effect round-trip)
  const progress = useMemo<ExecutionProgress | null>(() => {
    if (!state.execution) return null;
    const p = calculateProgressFromState(state.devices, state.stepsByDevice);
    p.phase = detectPhaseFromState(state.execution, state.devices, state.stepsByDevice);
    return p;
  }, [state.execution, state.devices, state.stepsByDevice]);

  // Calculate progress
  const calculateProgress = useCallback((): ExecutionProgress => {
    const p = calculateProgressFromState(state.devices, state.stepsByDevice);
    p.phase = detectPhaseFromState(state.execution, state.devices, state.stepsByDevice);
    return p;
  }, [state.execution, state.devices, state.stepsByDevice]);

  // Detect current phase
  const detectPhase = useCallback((): ExecutionPhase => {
    return detectPhaseFromState(state.execution, state.devices, state.stepsByDevice);
  }, [state.execution, state.devices, state.stepsByDevice]);

  // Save checkpoint
  const saveCheckpoint = useCallback(async () => {
    const exec = execRef.current;
    if (!exec) return;

    const checkpoint: ExecutionCheckpoint = {
      executionId: exec.id,
      phase: detectPhase(),
      currentDeviceId: state.devices.find(d => d.status === 'running')?.id || null,
      currentStepId: null, // Would need to find current step
      timestamp: new Date().toISOString(),
    };

    await mopApi.updateMopExecution(exec.id, {
      last_checkpoint: JSON.stringify(checkpoint),
    });
  }, [state.devices, detectPhase]);

  // Load checkpoint
  const loadCheckpoint = useCallback((): ExecutionCheckpoint | null => {
    if (!state.execution?.last_checkpoint) return null;
    try {
      return JSON.parse(state.execution.last_checkpoint) as ExecutionCheckpoint;
    } catch {
      return null;
    }
  }, [state.execution]);

  // Refresh all data
  const refresh = useCallback(async () => {
    const exec = execRef.current;
    if (exec) {
      await loadExecution(exec.id);
    }
  }, [loadExecution]);

  // Auto-load if executionId provided
  useEffect(() => {
    if (executionId) {
      loadExecution(executionId);
    }
  }, [executionId, loadExecution]);

  // Auto-save checkpoint every 30 seconds during running execution
  useEffect(() => {
    if (state.execution?.status === 'running') {
      autoSaveRef.current = setInterval(() => {
        saveCheckpoint();
      }, 30000);
      return () => {
        if (autoSaveRef.current) {
          clearInterval(autoSaveRef.current);
        }
      };
    }
  }, [state.execution?.status, saveCheckpoint]);

  // Reset execution state (for starting fresh after plan edits)
  const resetExecution = useCallback(() => {
    setState(initialState);
    execRef.current = null;
  }, []);

  const stateWithProgress = useMemo<MopExecutionState>(() => ({ ...state, progress }), [state, progress]);

  return useMemo<UseMopExecutionReturn>(() => ({
    state: stateWithProgress,
    loadExecution,
    createExecution,
    updateExecution,
    addDevice,
    removeDevice,
    reorderDevices,
    loadSteps,
    addSteps,
    updateStepMock,
    startExecution,
    pauseExecution,
    resumeExecution,
    abortExecution,
    completeExecution,
    skipDevice,
    retryDevice,
    rollbackDevice,
    rollbackAllDevices,
    executeStep,
    approveStep,
    skipStep,
    updateStepOutput,
    updateStepCommand,
    runPhase,
    calculateProgress,
    detectPhase,
    saveCheckpoint,
    loadCheckpoint,
    refresh,
    setError,
    clearError,
    resetExecution,
  }), [
    stateWithProgress, loadExecution, createExecution, updateExecution, addDevice, removeDevice, reorderDevices,
    loadSteps, addSteps, updateStepMock, startExecution, pauseExecution, resumeExecution, abortExecution,
    completeExecution, skipDevice, retryDevice, rollbackDevice, rollbackAllDevices, executeStep, approveStep,
    skipStep, updateStepOutput, updateStepCommand, runPhase, calculateProgress, detectPhase, saveCheckpoint,
    loadCheckpoint, refresh, setError, clearError, resetExecution,
  ]);
}
