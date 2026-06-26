import { logger } from '../lib/logger'
/**
 * useAgentTasks - Hook for managing AI agent tasks with real-time updates
 *
 * Provides:
 * - WebSocket subscription for real-time task progress
 * - Zustand store for task state management
 * - CRUD operations via REST API
 * - Automatic reconnection on WebSocket disconnect
 */

import { useEffect, useCallback } from 'react';
import { create } from 'zustand';
import { getClient, getCurrentMode } from '../api/client';
import * as tasksApi from '../api/tasks';
import { listAgentExecutions } from '../api/agentDefinitions';
import { saveTaskResultToDoc } from '../lib/taskExport';
import type {
  AgentTask,
  TaskStatus,
  TaskWsMessage,
  TaskCancelCommand,
  FailurePolicyConfig,
  TaskMessage,
} from '../types/tasks';

// Helper to check enterprise mode - must be called at runtime, not module load
// because getCurrentMode() returns null before client initialization
const checkIsEnterprise = () => getCurrentMode() === 'enterprise';

// ============================================================================
// Zustand Store
// ============================================================================

interface AgentTasksState {
  /** List of all tasks */
  tasks: AgentTask[];
  /** Count of currently running tasks */
  runningCount: number;
  /** Maximum concurrent tasks allowed */
  maxConcurrent: number;
  /** WebSocket connection status */
  isConnected: boolean;
  /** Set of task IDs that have been auto-saved to Documents (prevents duplicates) */
  savedTaskIds: Set<string>;
  /** Set of task IDs deleted locally (filtered out from poll results) */
  deletedTaskIds: Set<string>;
  /** Feature A: per-task transcript steps, keyed by task id, seq-ordered. */
  transcripts: Record<string, TaskMessage[]>;

  // Actions
  setTasks: (tasks: AgentTask[]) => void;
  updateTask: (taskId: string, updates: Partial<AgentTask>) => void;
  addTask: (task: AgentTask) => void;
  removeTask: (taskId: string) => void;
  setRunningCount: (count: number) => void;
  setMaxConcurrent: (max: number) => void;
  setConnected: (connected: boolean) => void;
  addSavedTaskId: (taskId: string) => void;
  addDeletedTaskId: (taskId: string) => void;
  appendTranscriptStep: (taskId: string, step: TaskMessage) => void;
  setTranscript: (taskId: string, steps: TaskMessage[]) => void;
}

const useAgentTasksStore = create<AgentTasksState>((set) => ({
  tasks: [],
  runningCount: 0,
  maxConcurrent: 3,
  isConnected: false,
  savedTaskIds: new Set<string>(),
  deletedTaskIds: new Set<string>(),
  transcripts: {},

  setTasks: (tasks) =>
    set((state) => ({
      // Filter out tasks that were deleted locally
      tasks: tasks.filter((t) => !state.deletedTaskIds.has(t.id)),
    })),

  updateTask: (taskId, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates } : t
      ),
    })),

  addTask: (task) =>
    set((state) => ({
      tasks: [task, ...state.tasks],
    })),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  setRunningCount: (count) => set({ runningCount: count }),
  setMaxConcurrent: (max) => set({ maxConcurrent: max }),
  setConnected: (connected) => set({ isConnected: connected }),
  addSavedTaskId: (taskId) =>
    set((state) => {
      const newSet = new Set(state.savedTaskIds);
      newSet.add(taskId);
      return { savedTaskIds: newSet };
    }),
  addDeletedTaskId: (taskId) =>
    set((state) => {
      const newSet = new Set(state.deletedTaskIds);
      newSet.add(taskId);
      return { deletedTaskIds: newSet };
    }),
  // Feature A: append a live transcript step, dedupe on seq, keep ascending.
  appendTranscriptStep: (taskId, step) =>
    set((state) => {
      const existing = state.transcripts[taskId] ?? [];
      if (existing.some((s) => s.seq === step.seq)) return state;
      const merged = [...existing, step].sort((a, b) => a.seq - b.seq);
      return { transcripts: { ...state.transcripts, [taskId]: merged } };
    }),
  // Feature A: merge a catch-up batch (catch-up wins on seq overlap).
  setTranscript: (taskId, steps) =>
    set((state) => {
      const bySeq = new Map<number, TaskMessage>();
      for (const s of state.transcripts[taskId] ?? []) bySeq.set(s.seq, s);
      for (const s of steps) bySeq.set(s.seq, s);
      const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
      return { transcripts: { ...state.transcripts, [taskId]: merged } };
    }),
}));

// ============================================================================
// Hook Return Type
// ============================================================================

export interface UseAgentTasksReturn {
  /** List of all tasks */
  tasks: AgentTask[];
  /** Count of currently running tasks */
  runningCount: number;
  /** Maximum concurrent tasks allowed */
  maxConcurrent: number;
  /** WebSocket connection status */
  isConnected: boolean;

  /** Create a new task */
  createTask: (prompt: string, failurePolicy?: FailurePolicyConfig) => Promise<AgentTask>;
  /** Cancel a running task via WebSocket */
  cancelTask: (taskId: string) => Promise<void>;
  /** Delete a task from history */
  deleteTask: (taskId: string) => Promise<void>;
  /** Add a task to the store (e.g. after running an agent) */
  addTask: (task: AgentTask) => void;
  /** Refresh task list from server */
  refreshTasks: () => Promise<void>;
  /** Get a task by ID */
  getTaskById: (taskId: string) => AgentTask | undefined;
}

// ============================================================================
// Module-level singleton WebSocket
// ============================================================================
//
// Two components consume useAgentTasks (AgentsPanel + AISidePanel). The old
// implementation kept WS state in per-hook useRef instances, so each
// consumer opened its OWN WebSocket — and the React-strict-mode double-
// mount in dev plus tab-switch unmount/remount cycles produced the rapid
// "connect → server-rejects → reconnect" loop visible in the console.
//
// The fix is a module-level singleton: one WS shared across all hook
// consumers, ref-counted so the WS opens on the first subscriber and
// closes after the last one unsubscribes (with a 1s debounce to absorb
// quick tab toggles). The onclose-reconnect path also checks `shouldStay`
// so it doesn't resurrect the WS after intentional disconnect.

let moduleWs: WebSocket | null = null;
let moduleReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let moduleDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Tasks we're fetching because a progress event arrived for an id we don't have
// yet (e.g. a sub-agent spawned server-side). Guards against duplicate fetches.
const inFlightTaskFetches = new Set<string>();
let moduleIsConnecting = false;
let moduleSubscriberCount = 0;
let moduleShouldStay = false; // false = intentional disconnect, don't reconnect
let modulePollInterval: ReturnType<typeof setInterval> | null = null;

function moduleConnect(): void {
  if (checkIsEnterprise()) {
    // Enterprise mode uses REST polling — Controller doesn't expose /ws/tasks.
    useAgentTasksStore.getState().setConnected(true);
    if (!modulePollInterval) {
      let consecutiveErrors = 0;
      const pollTasks = async () => {
        try {
          const response = await listAgentExecutions({ limit: 50 });
          const s = useAgentTasksStore.getState();
          s.setTasks(response.tasks);
          s.setRunningCount(response.running_count);
          s.setMaxConcurrent(response.max_concurrent);
          consecutiveErrors = 0;
        } catch {
          consecutiveErrors++;
          if (consecutiveErrors === 1) {
            console.warn('[useAgentTasks] Agent executions endpoint not available');
          }
        }
      };
      pollTasks();
      modulePollInterval = setInterval(pollTasks, 5000);
    }
    return;
  }

  // Prevent duplicate connection attempts (singleton-level, not per-hook).
  if (
    moduleWs?.readyState === WebSocket.OPEN ||
    moduleWs?.readyState === WebSocket.CONNECTING ||
    moduleIsConnecting
  ) {
    return;
  }

  moduleIsConnecting = true;
  moduleShouldStay = true;

  const client = getClient();
  const wsUrl = client.wsUrlWithAuth('/ws/tasks');
  const ws = new WebSocket(wsUrl);
  moduleWs = ws;

  ws.onopen = () => {
    logger.log('[useAgentTasks] WebSocket connected');
    moduleIsConnecting = false;
    useAgentTasksStore.getState().setConnected(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg: TaskWsMessage = JSON.parse(event.data);
      const store = useAgentTasksStore.getState();

      if (msg.type === 'init') {
        store.setTasks(msg.tasks);
        store.setRunningCount(msg.running_count);
        store.setMaxConcurrent(msg.max_concurrent);
      } else if (msg.type === 'task_progress') {
        // Backend sends camelCase (taskId, progressPct) per the Rust serde config
        const taskId = msg.taskId;
        const status = msg.status;
        const progressPct = msg.progressPct;
        const resultJson = msg.result ? JSON.stringify(msg.result) : undefined;
        const currentTask = store.tasks.find((t) => t.id === taskId);

        if (!currentTask && !inFlightTaskFetches.has(taskId)) {
          // First time we've seen this task — e.g. a sub-agent spawned
          // server-side by delegate_to_agent. Pull its FULL record (including
          // parent_task_id / root_task_id linkage) so it joins the store and
          // shows up in the workflow graph. Subsequent events then update it.
          inFlightTaskFetches.add(taskId);
          tasksApi
            .getTask(taskId)
            .then((full) => useAgentTasksStore.getState().addTask(full))
            .catch(() => { /* best-effort */ })
            .finally(() => inFlightTaskFetches.delete(taskId));
        }

        store.updateTask(taskId, {
          status: status as TaskStatus,
          progress_pct: progressPct,
          result_json: resultJson,
          error_message: msg.error,
        });

        // Feature A: live transcript step rides on task_progress events.
        if (msg.step) {
          store.appendTranscriptStep(msg.step.task_id, msg.step);
        }

        if (currentTask) {
          const wasRunning = currentTask.status === 'running';
          const isNowRunning = status === 'running';
          const isNowTerminal = ['completed', 'failed', 'cancelled'].includes(status);

          if (!wasRunning && isNowRunning) {
            store.setRunningCount(store.runningCount + 1);
          } else if (wasRunning && isNowTerminal) {
            store.setRunningCount(Math.max(0, store.runningCount - 1));
          }

          // Auto-save completed tasks to Documents.
          if (status === 'completed' && resultJson && !store.savedTaskIds.has(taskId)) {
            const updatedTask: AgentTask = {
              ...currentTask,
              status: 'completed',
              progress_pct: progressPct,
              result_json: resultJson,
            };
            saveTaskResultToDoc(updatedTask).then((docId) => {
              if (docId) {
                useAgentTasksStore.getState().addSavedTaskId(taskId);
              }
            });
          }
        }
      }
    } catch (e) {
      console.error('[useAgentTasks] Failed to parse WebSocket message:', e);
    }
  };

  ws.onclose = () => {
    logger.log('[useAgentTasks] WebSocket disconnected');
    moduleIsConnecting = false;
    useAgentTasksStore.getState().setConnected(false);
    moduleWs = null;

    // Only auto-reconnect if at least one component still wants the
    // connection. Prevents the orphan-reconnect leak that fired 3s after
    // tab unmount in the old implementation.
    if (moduleShouldStay && moduleSubscriberCount > 0) {
      if (moduleReconnectTimer) clearTimeout(moduleReconnectTimer);
      moduleReconnectTimer = setTimeout(() => {
        moduleReconnectTimer = null;
        if (moduleShouldStay && moduleSubscriberCount > 0) moduleConnect();
      }, 3000);
    }
  };

  ws.onerror = (error) => {
    console.error('[useAgentTasks] WebSocket error:', error);
    moduleIsConnecting = false;
  };
}

function moduleDisconnect(): void {
  moduleShouldStay = false;
  if (moduleReconnectTimer) {
    clearTimeout(moduleReconnectTimer);
    moduleReconnectTimer = null;
  }
  if (moduleWs) {
    moduleWs.close();
    moduleWs = null;
  }
  if (modulePollInterval) {
    clearInterval(modulePollInterval);
    modulePollInterval = null;
  }
}

export function sendTaskCancelCommand(taskId: string): boolean {
  if (moduleWs?.readyState === WebSocket.OPEN) {
    const cmd: TaskCancelCommand = { type: 'cancel', task_id: taskId };
    moduleWs.send(JSON.stringify(cmd));
    return true;
  }
  return false;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useAgentTasks(): UseAgentTasksReturn {
  const {
    tasks,
    runningCount,
    maxConcurrent,
    isConnected,
    setTasks,
    addTask,
    removeTask,
    setRunningCount,
    setMaxConcurrent,
    addDeletedTaskId,
  } = useAgentTasksStore();

  // Ref-counted singleton subscription. First hook to mount opens the WS;
  // last hook to unmount tears it down (with a 1s debounce so a quick tab
  // toggle doesn't close-and-reopen).
  useEffect(() => {
    moduleSubscriberCount++;
    if (moduleDisconnectTimer) {
      clearTimeout(moduleDisconnectTimer);
      moduleDisconnectTimer = null;
    }
    moduleConnect();

    return () => {
      moduleSubscriberCount = Math.max(0, moduleSubscriberCount - 1);
      if (moduleSubscriberCount === 0) {
        // Debounce — quick AgentsPanel→MopWorkspace tab switches shouldn't
        // cycle the WS. 1s covers React-strict-mode double-mount too.
        moduleDisconnectTimer = setTimeout(() => {
          moduleDisconnectTimer = null;
          if (moduleSubscriberCount === 0) moduleDisconnect();
        }, 1000);
      }
    };
  }, []);

  // Create a new task
  const createTask = useCallback(async (prompt: string, failurePolicy?: FailurePolicyConfig): Promise<AgentTask> => {
    const task = await tasksApi.createTask({
      prompt,
      failure_policy: failurePolicy,
    });
    addTask(task);
    return task;
  }, [addTask]);

  // Cancel a task via WebSocket (standalone) or REST API (enterprise)
  const cancelTask = useCallback(async (taskId: string): Promise<void> => {
    if (checkIsEnterprise()) {
      // Enterprise mode: use REST API
      await tasksApi.cancelTask(taskId);
      // Update will come via polling
    } else {
      // Standalone mode: send cancel command via the singleton WebSocket
      // for immediate response. The handler will broadcast the status
      // change, which updates the store via onmessage.
      sendTaskCancelCommand(taskId);
    }
  }, []);

  // Delete a task (removes from history)
  const deleteTask = useCallback(async (taskId: string): Promise<void> => {
    addDeletedTaskId(taskId);
    removeTask(taskId);
    await tasksApi.deleteTask(taskId).catch(() => {
      // Best-effort server deletion; local removal is already done
    });
  }, [removeTask, addDeletedTaskId]);

  // Refresh task list from server
  const refreshTasks = useCallback(async (): Promise<void> => {
    const response = await tasksApi.listTasks();
    setTasks(response.tasks);
    setRunningCount(response.running_count);
    setMaxConcurrent(response.max_concurrent);
  }, [setTasks, setRunningCount, setMaxConcurrent]);

  // Get a task by ID
  const getTaskById = useCallback((taskId: string): AgentTask | undefined => {
    return tasks.find((t) => t.id === taskId);
  }, [tasks]);

  return {
    tasks,
    runningCount,
    maxConcurrent,
    isConnected,
    createTask,
    cancelTask,
    deleteTask,
    addTask,
    refreshTasks,
    getTaskById,
  };
}

// Export the store for direct access if needed
export { useAgentTasksStore };
