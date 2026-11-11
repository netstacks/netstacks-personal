// useMopExecuteView — Execute-tab view state for the MOP workspace (P2-5).
// Owns what the split-pane shows (selected step, collapsed phases, rollback
// visibility, expanded devices, inline command edit) plus the derived
// phase/progress. Execution *actions* stay in MopWorkspace — they need the
// plan, the execution hook and the AI pilot.

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { MopExecutionDevice, MopExecutionStep, ExecutionPhase } from '../../types/mop';
import type { MopExecutionState } from '../../hooks/useMopExecution';

// ============================================================================
// Types
// ============================================================================

export interface UseMopExecuteViewArgs {
  execState: MopExecutionState;
  /** Step currently being executed (manual mode) — auto-selected in the pane. */
  executingStepId: string | null;
}

export interface MopExecuteSelectionState {
  selectedExecStepId: string | null;
  setSelectedExecStepId: (v: string | null) => void;
  /** The selected step with its device (right pane), or null. */
  selectedExecStepData: { step: MopExecutionStep; device: MopExecutionDevice } | null;
}

export interface MopExecutePhasesState {
  collapsedPhases: Set<string>;
  togglePhaseCollapse: (key: string) => void;
}

export interface MopExecuteRollbackState {
  /** Devices whose rollback group is shown. */
  rollbackVisible: Set<string>;
  setRollbackVisible: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export interface MopExecuteDevicesState {
  expandedExecutionDevices: Set<string>;
  setExpandedExecutionDevices: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleExecutionDeviceExpand: (deviceId: string) => void;
}

export interface MopExecuteEditingState {
  editingStepId: string | null;
  setEditingStepId: (v: string | null) => void;
  editingStepCommand: string;
  setEditingStepCommand: (v: string) => void;
  handleStartEditStep: (step: MopExecutionStep) => void;
}

/** Confirmation dialogs owned by the Execute tab. Hoisted here so the
 *  command palette (`mop.abort` / `mop.complete`) opens the same dialogs the
 *  toolbar buttons do instead of bypassing the confirmation. */
export type MopExecuteDialogKind = 'abort' | 'complete' | 'new';

export interface MopExecuteDialogState {
  dialog: MopExecuteDialogKind | null;
  abortReason: string;
  setAbortReason: (v: string) => void;
  openDialog: (kind: MopExecuteDialogKind) => void;
  closeDialog: () => void;
}

export interface UseMopExecuteViewReturn {
  currentPhase: ExecutionPhase;
  progress: MopExecutionState['progress'];
  selection: MopExecuteSelectionState;
  phases: MopExecutePhasesState;
  rollback: MopExecuteRollbackState;
  devices: MopExecuteDevicesState;
  editing: MopExecuteEditingState;
  dialog: MopExecuteDialogState;
}

// ============================================================================
// Hook
// ============================================================================

export function useMopExecuteView({ execState, executingStepId }: UseMopExecuteViewArgs): UseMopExecuteViewReturn {
  const executionDevices = execState.devices;
  const stepsByDevice = execState.stepsByDevice;
  const progress = execState.progress;
  const currentPhase: ExecutionPhase = progress?.phase || 'device_selection';

  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingStepCommand, setEditingStepCommand] = useState('');
  const [expandedExecutionDevices, setExpandedExecutionDevices] = useState<Set<string>>(new Set());

  // Execute split-pane state
  const [selectedExecStepId, setSelectedExecStepId] = useState<string | null>(null);
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [rollbackVisible, setRollbackVisible] = useState<Set<string>>(new Set());

  // Confirmation dialogs (abort with reason, complete with failures, new execution)
  const [dialog, setDialog] = useState<MopExecuteDialogKind | null>(null);
  const [abortReason, setAbortReason] = useState('');
  const openDialog = useCallback((kind: MopExecuteDialogKind) => {
    if (kind === 'abort') setAbortReason('');
    setDialog(kind);
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);

  // Helper: find selected step and its device for split-pane right panel
  const selectedExecStepData = useMemo(() => {
    if (!selectedExecStepId) return null;
    for (const device of executionDevices) {
      const deviceSteps = stepsByDevice[device.id] || [];
      const step = deviceSteps.find(s => s.id === selectedExecStepId);
      if (step) return { step, device };
    }
    return null;
  }, [selectedExecStepId, executionDevices, stepsByDevice]);

  // Inline edit a step command before execution
  const handleStartEditStep = useCallback((step: MopExecutionStep) => {
    setEditingStepId(step.id);
    setEditingStepCommand(step.command);
  }, []);

  // Toggle execution device panel expand
  const toggleExecutionDeviceExpand = useCallback((deviceId: string) => {
    setExpandedExecutionDevices(prev => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }, []);

  // Auto-expand all execution devices when execution loads
  useEffect(() => {
    if (executionDevices.length > 0 && expandedExecutionDevices.size === 0) {
      setExpandedExecutionDevices(new Set(executionDevices.map(d => d.id)));
    }
  }, [executionDevices]);

  // Auto-select executing step in split-pane
  useEffect(() => {
    if (executingStepId) {
      setSelectedExecStepId(executingStepId);
    }
  }, [executingStepId]);

  // Toggle phase collapse in execute tab
  const togglePhaseCollapse = useCallback((key: string) => {
    setCollapsedPhases(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return {
    currentPhase,
    progress,
    selection: { selectedExecStepId, setSelectedExecStepId, selectedExecStepData },
    phases: { collapsedPhases, togglePhaseCollapse },
    rollback: { rollbackVisible, setRollbackVisible },
    devices: { expandedExecutionDevices, setExpandedExecutionDevices, toggleExecutionDeviceExpand },
    editing: { editingStepId, setEditingStepId, editingStepCommand, setEditingStepCommand, handleStartEditStep },
    dialog: { dialog, abortReason, setAbortReason, openDialog, closeDialog },
  };
}
