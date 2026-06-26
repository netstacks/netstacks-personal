import { getErrorMessage } from '../api/errors'
/**
 * Change control hook. In enterprise mode, delegates to controller MOP APIs
 * (listControllerMops, getControllerMop, deleteControllerMop, etc.) rather than
 * maintaining separate change-tracking logic. Standalone mode uses the local
 * changes API (/api/changes) for full workflow operations (snapshots, execution,
 * rollback). There is no parallel implementation -- enterprise always goes through
 * the controller MOP functions.
 */
import { useState, useEffect, useCallback } from 'react';
import type { Change, NewChange, UpdateChange, Snapshot, MopStep } from '../types/change';
import * as api from '../api/changes';
import { useMode } from './useMode';
import {
  listControllerMops,
  getControllerMop,
  deleteControllerMop,
  controllerMopToChange,
} from '../api/controllerMop';

interface UseChangeControlOptions {
  sessionId?: string;
  changeId?: string;
  autoLoad?: boolean;
}

interface UseChangeControlReturn {
  // Data
  changes: Change[];
  selectedChange: Change | null;
  snapshots: Snapshot[];
  loading: boolean;
  error: string | null;

  // Change CRUD
  loadChanges: () => Promise<void>;
  selectChange: (id: string | null) => Promise<void>;
  createChange: (change: Omit<NewChange, 'created_by'>) => Promise<Change>;
  updateChange: (id: string, update: UpdateChange) => Promise<Change>;
  deleteChange: (id: string) => Promise<void>;

  // MOP step management
  addMopStep: (step: MopStep) => void;
  updateMopStep: (stepId: string, update: Partial<MopStep>) => void;
  removeMopStep: (stepId: string) => void;
  reorderMopSteps: (fromIndex: number, toIndex: number) => void;

  // Workflow
  startExecution: () => Promise<void>;
  capturePreSnapshot: (commands: string[], output: string) => Promise<Snapshot>;
  capturePostSnapshot: (commands: string[], output: string) => Promise<Snapshot>;
  completeWithAnalysis: (analysis: string) => Promise<void>;
  markFailed: (analysis: string) => Promise<void>;
  rollback: () => Promise<void>;

  // Snapshots
  loadSnapshots: (changeId: string) => Promise<void>;
}

export function useChangeControl({
  sessionId,
  changeId,
  autoLoad = true,
}: UseChangeControlOptions = {}): UseChangeControlReturn {
  const [changes, setChanges] = useState<Change[]>([]);
  const [selectedChange, setSelectedChange] = useState<Change | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isEnterprise } = useMode();

  // Get current user for change tracking
  // Placeholder: returns hardcoded 'engineer' until user profile is wired in
  const getCurrentUser = useCallback(() => {
    return 'engineer';
  }, []);

  const loadChanges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isEnterprise) {
        // Enterprise mode: fetch from controller's /api/mops
        const mops = await listControllerMops({ limit: 100 });
        const converted = mops.map(mop => {
          // listControllerMops returns ControllerMopSummary (no package_data)
          // Build a minimal Change for the list view
          const change: Change = {
            id: mop.id,
            name: mop.name,
            description: undefined,
            status: 'draft',
            mop_steps: [],
            created_by: mop.author,
            created_at: mop.created_at,
            updated_at: mop.updated_at,
          };
          return { change, mopStatus: mop.status };
        });
        setChanges(converted.map(c => c.change));

        // Now fetch full details for step counts (async, update in-place)
        const fullMops = await Promise.all(
          converted.map(async ({ change }) => {
            try {
              const full = await getControllerMop(change.id);
              return controllerMopToChange(full);
            } catch {
              return change;
            }
          })
        );
        setChanges(fullMops);
      } else {
        // Standalone mode: fetch from local agent's /api/changes
        const data = await api.listChanges(sessionId);
        setChanges(data);
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load changes'));
    } finally {
      setLoading(false);
    }
  }, [sessionId, isEnterprise]);

  const selectChange = useCallback(async (id: string | null) => {
    if (!id) {
      setSelectedChange(null);
      setSnapshots([]);
      return;
    }
    setLoading(true);
    try {
      if (isEnterprise) {
        const mop = await getControllerMop(id);
        setSelectedChange(controllerMopToChange(mop));
        setSnapshots([]); // Enterprise snapshots handled differently
      } else {
        const change = await api.getChange(id);
        setSelectedChange(change);
        const snaps = await api.listSnapshots(id);
        setSnapshots(snaps);
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load change'));
    } finally {
      setLoading(false);
    }
  }, [isEnterprise]);

  const createChange = useCallback(async (change: Omit<NewChange, 'created_by'>) => {
    // In enterprise mode, creation happens through MopWorkspace → pushPlanToController
    // This path is mainly for standalone mode
    const newChange = await api.createChange({
      ...change,
      created_by: getCurrentUser(),
    });
    setChanges(prev => [newChange, ...prev]);
    return newChange;
  }, [getCurrentUser]);

  const updateChange = useCallback(async (id: string, update: UpdateChange) => {
    const updated = await api.updateChange(id, update);
    setChanges(prev => prev.map(c => c.id === id ? updated : c));
    if (selectedChange?.id === id) {
      setSelectedChange(updated);
    }
    return updated;
  }, [selectedChange]);

  const deleteChange = useCallback(async (id: string) => {
    if (isEnterprise) {
      await deleteControllerMop(id);
    } else {
      await api.deleteChange(id);
    }
    setChanges(prev => prev.filter(c => c.id !== id));
    if (selectedChange?.id === id) {
      setSelectedChange(null);
      setSnapshots([]);
    }
  }, [selectedChange, isEnterprise]);

  // MOP step management (local state, save with updateChange)
  const addMopStep = useCallback((step: MopStep) => {
    if (!selectedChange) return;
    const updated = {
      ...selectedChange,
      mop_steps: [...selectedChange.mop_steps, step],
    };
    setSelectedChange(updated);
  }, [selectedChange]);

  const updateMopStep = useCallback((stepId: string, update: Partial<MopStep>) => {
    if (!selectedChange) return;
    const updated = {
      ...selectedChange,
      mop_steps: selectedChange.mop_steps.map(s =>
        s.id === stepId ? { ...s, ...update } : s
      ),
    };
    setSelectedChange(updated);
  }, [selectedChange]);

  const removeMopStep = useCallback((stepId: string) => {
    if (!selectedChange) return;
    const updated = {
      ...selectedChange,
      mop_steps: selectedChange.mop_steps.filter(s => s.id !== stepId),
    };
    setSelectedChange(updated);
  }, [selectedChange]);

  const reorderMopSteps = useCallback((fromIndex: number, toIndex: number) => {
    if (!selectedChange) return;
    const steps = [...selectedChange.mop_steps];
    const [moved] = steps.splice(fromIndex, 1);
    steps.splice(toIndex, 0, moved);
    // Update order numbers
    const reordered = steps.map((s, i) => ({ ...s, order: i }));
    setSelectedChange({ ...selectedChange, mop_steps: reordered });
  }, [selectedChange]);

  // Workflow actions
  const startExecution = useCallback(async () => {
    if (!selectedChange) return;
    await api.startChange(selectedChange.id);
    await selectChange(selectedChange.id);
  }, [selectedChange, selectChange]);

  const capturePreSnapshot = useCallback(async (commands: string[], output: string) => {
    if (!selectedChange) throw new Error('No change selected');
    const snapshot = await api.createSnapshot({
      change_id: selectedChange.id,
      snapshot_type: 'pre',
      commands,
      output,
    });
    setSnapshots(prev => [...prev, snapshot]);
    await updateChange(selectedChange.id, { pre_snapshot_id: snapshot.id });
    return snapshot;
  }, [selectedChange, updateChange]);

  const capturePostSnapshot = useCallback(async (commands: string[], output: string) => {
    if (!selectedChange) throw new Error('No change selected');
    const snapshot = await api.createSnapshot({
      change_id: selectedChange.id,
      snapshot_type: 'post',
      commands,
      output,
    });
    setSnapshots(prev => [...prev, snapshot]);
    await updateChange(selectedChange.id, { post_snapshot_id: snapshot.id, status: 'validating' });
    return snapshot;
  }, [selectedChange, updateChange]);

  const completeWithAnalysis = useCallback(async (analysis: string) => {
    if (!selectedChange) return;
    await api.completeChange(selectedChange.id, analysis);
    await selectChange(selectedChange.id);
  }, [selectedChange, selectChange]);

  const markFailed = useCallback(async (analysis: string) => {
    if (!selectedChange) return;
    await api.failChange(selectedChange.id, analysis);
    await selectChange(selectedChange.id);
  }, [selectedChange, selectChange]);

  const rollback = useCallback(async () => {
    if (!selectedChange) return;
    await api.rollbackChange(selectedChange.id);
    await selectChange(selectedChange.id);
  }, [selectedChange, selectChange]);

  const loadSnapshots = useCallback(async (changeId: string) => {
    const snaps = await api.listSnapshots(changeId);
    setSnapshots(snaps);
  }, []);

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad) {
      loadChanges();
    }
  }, [autoLoad, loadChanges]);

  // Auto-select change if changeId provided
  useEffect(() => {
    if (changeId) {
      selectChange(changeId);
    }
  }, [changeId, selectChange]);

  return {
    changes,
    selectedChange,
    snapshots,
    loading,
    error,
    loadChanges,
    selectChange,
    createChange,
    updateChange,
    deleteChange,
    addMopStep,
    updateMopStep,
    removeMopStep,
    reorderMopSteps,
    startExecution,
    capturePreSnapshot,
    capturePostSnapshot,
    completeWithAnalysis,
    markFailed,
    rollback,
    loadSnapshots,
  };
}
