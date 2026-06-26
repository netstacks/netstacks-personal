import { getErrorMessage } from '../api/errors'
/**
 * useMopExecution - Hook for managing MOP execution state
 *
 * This hook provides:
 * - Load/create/update execution
 * - Device and step state management
 * - Execution control actions (start, pause, resume, abort)
 * - Step execution with mock support
 * - Auto-save checkpoints
 * - Progress tracking and phase detection
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import * as mopApi from '../api/mop';
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

// Hook state
export interface MopExecutionState {
  execution: MopExecution | null;
  devices: MopExecutionDevice[];
  stepsByDevice: Record<string, MopExecutionStep[]>;
  loading: boolean;
  error: string | null;
  progress: ExecutionProgress | null;
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
  addDevice: (sessionId: string, order: number, deviceName?: string, deviceHost?: string, deviceId?: string, credentialId?: string, role?: string) => Promise<MopExecutionDevice>;
  removeDevice: (deviceId: string) => Promise<void>;
  reorderDevices: (deviceIds: string[]) => Promise<void>;

  // Step management
  loadSteps: (deviceId: string) => Promise<MopExecutionStep[]>;
  addSteps: (deviceId: string, steps: Omit<NewMopExecutionStep, 'execution_device_id'>[]) => Promise<MopExecutionStep[]>;
  updateStepMock: (stepId: string, config: MockConfig) => Promise<void>;

  // Execution control
  startExecution: () => Promise<void>;
  pauseExecution: () => Promise<void>;
  resumeExecution: () => Promise<void>;
  abortExecution: () => Promise<void>;
  completeExecution: (aiAnalysis?: string) => Promise<void>;
  cancelExecution: () => Promise<void>;

  // Device control
  skipDevice: (deviceId: string) => Promise<void>;
  retryDevice: (deviceId: string) => Promise<void>;
  rollbackDevice: (deviceId: string) => Promise<void>;

  // Step control
  executeStep: (stepId: string) => Promise<void>;
  approveStep: (stepId: string) => Promise<void>;
  skipStep: (stepId: string) => Promise<void>;
  updateStepOutput: (stepId: string, output: StepOutputUpdate) => Promise<void>;
  updateStepCommand: (stepId: string, command: string) => Promise<void>;

  // Phase execution (runs all steps for a phase across all devices sequentially)
  runPhase: (stepType: 'pre_check' | 'change' | 'post_check') => Promise<void>;

  // Progress
  calculateProgress: () => ExecutionProgress;
  detectPhase: () => ExecutionPhase;

  // Checkpoint
  saveCheckpoint: () => Promise<void>;
  loadCheckpoint: () => ExecutionCheckpoint | null;

  // Refresh
  refresh: () => Promise<void>;

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

export function useMopExecution(executionId?: string): UseMopExecutionReturn {
  const [state, setState] = useState<MopExecutionState>(initialState);
  const autoSaveRef = useRef<TimerRef>(null);
  // Ref for immediate access to execution (avoids React stale closure issue)
  const execRef = useRef<MopExecution | null>(null);

  // Load execution by ID
  const loadExecution = useCallback(async (id: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const execution = await mopApi.getMopExecution(id);
      execRef.current = execution;
      const devices = await mopApi.listExecutionDevices(id);

      // Load steps for each device (deduplicate by step ID)
      const stepsByDevice: Record<string, MopExecutionStep[]> = {};
      for (const device of devices) {
        const raw = await mopApi.listExecutionSteps(id, device.id);
        const seen = new Set<string>();
        stepsByDevice[device.id] = raw.filter(s => {
          if (seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        });
      }

      const progress = calculateProgressFromState(devices, stepsByDevice);
      progress.phase = detectPhaseFromState(execution, devices, stepsByDevice);

      setState({
        execution,
        devices,
        stepsByDevice,
        loading: false,
        error: null,
        progress,
      });
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err, 'Failed to load execution'),
      }));
    }
  }, []);

  // Create new execution
  const createExecution = useCallback(async (data: NewMopExecution): Promise<MopExecution> => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const execution = await mopApi.createMopExecution(data);
      execRef.current = execution;
      setState({
        execution,
        devices: [],
        stepsByDevice: {},
        loading: false,
        error: null,
        progress: {
          phase: 'device_selection',
          totalDevices: 0,
          completedDevices: 0,
          currentDeviceIndex: 0,
          totalSteps: 0,
          completedSteps: 0,
          failedSteps: 0,
          skippedSteps: 0,
          mockedSteps: 0,
          percentComplete: 0,
        },
      });
      return execution;
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err, 'Failed to create execution'),
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
        error: getErrorMessage(err, 'Failed to update execution'),
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
    const steps = await mopApi.listExecutionSteps(exec.id, deviceId);
    setState(prev => ({
      ...prev,
      stepsByDevice: { ...prev.stepsByDevice, [deviceId]: steps },
    }));
    return steps;
  }, []);

  // Add steps to a device
  const addSteps = useCallback(async (
    deviceId: string,
    steps: Omit<NewMopExecutionStep, 'execution_device_id'>[]
  ): Promise<MopExecutionStep[]> => {
    const exec = execRef.current;
    if (!exec) throw new Error('No execution loaded');
    const created = await mopApi.addExecutionSteps(exec.id, deviceId, steps);
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

  const abortExecution = useCallback(async () => {
    const exec = execRef.current;
    if (!exec) return;
    const execution = await mopApi.abortMopExecution(exec.id);
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
  }, []);

  const completeExecution = useCallback(async (aiAnalysis?: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const execution = await mopApi.completeMopExecution(exec.id, { ai_analysis: aiAnalysis });
    execRef.current = execution;
    setState(prev => ({ ...prev, execution }));
  }, []);

  const cancelExecution = useCallback(async () => {
    const exec = execRef.current;
    if (!exec) return;
    try {
      await mopApi.abortMopExecution(exec.id);
    } catch {
      // If abort fails (already completed, etc.), still clear local state
    }
    execRef.current = null;
    setState({
      execution: null,
      devices: [],
      stepsByDevice: {},
      loading: false,
      error: null,
      progress: null,
    });
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
    setState(prev => ({
      ...prev,
      devices: prev.devices.map(d => d.id === deviceId ? device : d),
    }));
  }, []);

  const rollbackDevice = useCallback(async (deviceId: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const device = await mopApi.rollbackExecutionDevice(exec.id, deviceId);
    setState(prev => ({
      ...prev,
      devices: prev.devices.map(d => d.id === deviceId ? device : d),
    }));
  }, []);

  // Step control
  const executeStep = useCallback(async (stepId: string) => {
    const exec = execRef.current;
    if (!exec) return;
    const step = await mopApi.executeStep(exec.id, stepId);
    setState(prev => updateStepInState(prev, stepId, step));
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

  // Run all steps for a phase across all devices (one API call per device, sequential)
  const runPhase = useCallback(async (stepType: 'pre_check' | 'change' | 'post_check') => {
    const exec = execRef.current;
    if (!exec) return;

    for (const device of state.devices) {
      try {
        await mopApi.executeDevicePhase(exec.id, device.id, stepType);
      } catch (err) {
        console.error(`Failed to execute phase for device ${device.id}:`, err);
      }
    }

    // Refresh all devices and steps after phase execution (deduplicate by step ID)
    try {
      const devices = await mopApi.listExecutionDevices(exec.id);
      const stepsByDevice: Record<string, MopExecutionStep[]> = {};
      for (const device of devices) {
        const raw = await mopApi.listExecutionSteps(exec.id, device.id);
        const seen = new Set<string>();
        stepsByDevice[device.id] = raw.filter(s => {
          if (seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        });
      }
      setState(prev => ({ ...prev, devices, stepsByDevice }));
    } catch (err) {
      console.error('Failed to refresh execution state:', err);
    }
  }, [state.devices]);

  // Calculate progress
  const calculateProgress = useCallback((): ExecutionProgress => {
    const progress = calculateProgressFromState(state.devices, state.stepsByDevice);
    progress.phase = detectPhaseFromState(state.execution, state.devices, state.stepsByDevice);
    return progress;
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

  // Update progress when state changes
  useEffect(() => {
    if (state.execution) {
      const progress = calculateProgressFromState(state.devices, state.stepsByDevice);
      progress.phase = detectPhaseFromState(state.execution, state.devices, state.stepsByDevice);
      setState(prev => ({ ...prev, progress }));
    }
  }, [state.execution, state.devices, state.stepsByDevice]);

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

  return {
    state,
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
    cancelExecution,
    skipDevice,
    retryDevice,
    rollbackDevice,
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
    resetExecution,
  };
}
