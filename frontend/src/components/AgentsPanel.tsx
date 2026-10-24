import React, { useState, useCallback, useEffect } from 'react';
import AITabInput from './AITabInput';
import { useAgentTasks, useAgentTasksStore } from '../hooks/useAgentTasks';
import { rerunTask, fetchTaskTranscript, taskTranscriptsSupported } from '../api/tasks';
import { getCurrentMode } from '../api/client';
import { listAgentDefinitions, createAgentDefinition, updateAgentDefinition, deleteAgentDefinition, runAgentDefinition } from '../api/agentDefinitions';
import type { AgentDefinition, CreateAgentDefinitionRequest, UpdateAgentDefinitionRequest } from '../api/agentDefinitions';
import { AgentDefinitionForm } from './AgentDefinitionForm';
import AgentActivity from './AgentActivity';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { exportTaskResultAsCsv } from '../lib/taskExport';
import { formatDurationBetween } from '../lib/formatters';
import ContextMenu from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { useContextMenu } from '../hooks/useContextMenu';
import type { TaskStatus, AgentTask, TaskMessage } from '../types/tasks';
import { confirmDialog } from './ConfirmDialog';
import './AgentsPanel.css';

import { logger } from '../lib/logger'
import DialogFooter from './DialogFooter';
import Tooltip from './Tooltip';
/** Parsed task result from result_json */
interface ParsedTaskResult {
  answer: string;
  status?: string;
  iterations?: number;
  tool_calls?: number;
}

/**
 * Parse result_json into structured output.
 * Handles both standalone format {"iterations": N, "result": "..."} and
 * enterprise format {"status": "success", "answer": "...", "iterations": N, "tool_calls": N}
 */
function parseTaskResult(raw: string): ParsedTaskResult | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const answer = parsed.answer ?? parsed.result ?? parsed.partial_answer ?? null;
    if (typeof answer !== 'string') return null;

    return {
      answer,
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
      iterations: typeof parsed.iterations === 'number' ? parsed.iterations : undefined,
      tool_calls: typeof parsed.tool_calls === 'number' ? parsed.tool_calls : undefined,
    };
  } catch {
    return null;
  }
}

// Check if running in enterprise mode (module level for performance)
const isEnterprise = getCurrentMode() === 'enterprise';

/** The Controller has no delete route for executions, so enterprise "delete"
 *  only removes the task from this client's list (audit 1.7). */
const removeTaskLabel = isEnterprise ? 'Remove from list' : 'Delete';
const removeTaskTooltip = isEnterprise ? 'Remove from list' : 'Delete task';

// Color palette for agent icons
const AGENT_COLORS = [
  '#2196f3', // blue
  '#9c27b0', // purple
  '#009688', // teal
  '#ff9800', // orange
  '#e91e63', // pink
  '#4caf50', // green
  '#ff5722', // deep orange
  '#00bcd4', // cyan
  '#673ab7', // deep purple
  '#8bc34a', // light green
];

function getAgentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

// Status icons following ChangesPanel pattern
const TaskStatusIcons: Record<TaskStatus, React.ReactElement> = {
  pending: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  running: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  completed: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  failed: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  cancelled: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ),
};

const TaskStatusColors: Record<TaskStatus, string> = {
  pending: 'var(--color-text-secondary)',
  running: 'var(--color-accent)',
  completed: 'var(--color-success, #4caf50)',
  failed: 'var(--color-error, #f44336)',
  cancelled: 'var(--color-warning, #ff9800)',
};

const TaskStatusLabels: Record<TaskStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};


/**
 * Format timestamp to relative time (e.g., "2 min ago")
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins} min${mins > 1 ? 's' : ''} ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }
  const days = Math.floor(diff / 86400000);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

/**
 * Format timestamp to readable date/time string
 */
function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ============================================================================
// TaskLogViewer Component
// ============================================================================

interface TaskLogViewerProps {
  task: AgentTask;
  onClose: () => void;
  onCancel: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onRerun: (taskId: string) => void;
}

/** Stable empty-array reference for the transcript selector below — returning a
 *  fresh `[]` from a Zustand selector trips useSyncExternalStore's loop guard. */
const EMPTY_TRANSCRIPT: TaskMessage[] = [];

function TaskLogViewer({ task, onClose, onCancel, onDelete, onRerun }: TaskLogViewerProps) {
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const isRunning = task.status === 'running';
  const duration = formatDurationBetween(task.started_at, task.completed_at);

  // Feature A: live glass-box transcript for this task. WS pushes steps live;
  // we backfill everything on open so a late-joining view stays correct.
  // NB: default to a STABLE empty array — a fresh `[]` in the selector returns
  // a new reference each render and trips useSyncExternalStore's loop guard.
  const transcript = useAgentTasksStore((s) => s.transcripts[task.id] ?? EMPTY_TRANSCRIPT);
  const setTranscript = useAgentTasksStore((s) => s.setTranscript);

  const transcriptUnavailable = !taskTranscriptsSupported();

  useEffect(() => {
    let cancelled = false;
    fetchTaskTranscript(task.id, -1)
      .then((result) => {
        if (!cancelled && result.supported && result.steps.length > 0) setTranscript(task.id, result.steps);
      })
      .catch(() => {
        /* transcript is best-effort; ignore fetch errors */
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, setTranscript]);

  return (
    <div className="task-log-viewer">
      <div
        className="task-log-header"
        style={{ '--task-status-color': TaskStatusColors[task.status] } as React.CSSProperties}
      >
        <span className="task-log-status-icon">
          {TaskStatusIcons[task.status]}
        </span>
        <span className="task-log-title">{TaskStatusLabels[task.status]}</span>
        {isRunning && (
          <span className="task-log-streaming">
            <span className="streaming-dot" />
            Live
          </span>
        )}
        <Tooltip label="Close"><button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button></Tooltip>
      </div>

      <div className="task-log-content">
        <div className="task-log-section">
          <div className="task-log-label">Prompt</div>
          <div className="task-log-prompt">{task.prompt}</div>
        </div>

        <div className="task-log-section">
          <div className="task-log-label">Status</div>
          <div className="task-log-status-detail">
            <span
              className="status-badge"
              style={{ '--task-status-color': TaskStatusColors[task.status] } as React.CSSProperties}
            >
              {TaskStatusLabels[task.status]}
            </span>
            {isRunning && (
              <div className="task-log-progress">
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${task.progress_pct}%` }}
                  />
                </div>
                <span className="progress-text">{task.progress_pct}%</span>
              </div>
            )}
            {duration && <span className="task-log-duration">{duration}</span>}
          </div>
        </div>

        {(transcript.length > 0 || transcriptUnavailable) && (
          <div className="task-log-section">
            <AgentActivity steps={transcript} live={isRunning} unavailable={transcriptUnavailable} />
          </div>
        )}

        <div className="task-log-section task-log-timestamps">
          <div className="timestamp-row">
            <span className="timestamp-label">Created:</span>
            <span className="timestamp-value">{formatTimestamp(task.created_at)}</span>
          </div>
          {task.started_at && (
            <div className="timestamp-row">
              <span className="timestamp-label">Started:</span>
              <span className="timestamp-value">{formatTimestamp(task.started_at)}</span>
            </div>
          )}
          {task.completed_at && (
            <div className="timestamp-row">
              <span className="timestamp-label">Completed:</span>
              <span className="timestamp-value">{formatTimestamp(task.completed_at)}</span>
            </div>
          )}
        </div>

        {(task.error_message || task.status === 'failed') && (
          <div className="task-log-section task-log-error-section">
            <div className="task-log-label">Error</div>
            <div className="task-log-error-message">{task.error_message || 'Unknown error (no error message recorded)'}</div>
          </div>
        )}

        {task.result_json && (() => {
          const parsed = parseTaskResult(task.result_json);
          return (
            <div className="task-log-section task-log-result-section">
              <div className="task-log-label">Result</div>
              {parsed ? (
                <>
                  <div className="task-log-result-answer">{parsed.answer}</div>
                  {(parsed.status || parsed.iterations != null || parsed.tool_calls != null) && (
                    <div className="task-log-result-meta">
                      {parsed.status && (
                        <span className={`result-meta-badge result-meta-status--${parsed.status}`}>
                          {parsed.status}
                        </span>
                      )}
                      {parsed.iterations != null && (
                        <span className="result-meta-badge">
                          {parsed.iterations} iteration{parsed.iterations !== 1 ? 's' : ''}
                        </span>
                      )}
                      {parsed.tool_calls != null && (
                        <span className="result-meta-badge">
                          {parsed.tool_calls} tool call{parsed.tool_calls !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <pre className="task-log-result">{task.result_json}</pre>
              )}
            </div>
          );
        })()}
      </div>

      <div className="task-log-footer">
        {isRunning && (
          <button
            className="ns-btn ns-btn--small"
            onClick={() => onCancel(task.id)}
          >
            Cancel Task
          </button>
        )}
        {isTerminal && task.result_json && (
          <Tooltip label="Export result as CSV"><button
            className="ns-btn ns-btn--small"
            onClick={() => exportTaskResultAsCsv(task)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export CSV
          </button></Tooltip>
        )}
        {isTerminal && isEnterprise && (
          <Tooltip label="Re-run task with same prompt"><button
            className="ns-btn ns-btn--small"
            onClick={() => onRerun(task.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
            Re-run
          </button></Tooltip>
        )}
        {isTerminal && (
          <button
            className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger"
            onClick={() => {
              onDelete(task.id);
              onClose();
            }}
          >
            {isEnterprise ? 'Remove from List' : 'Delete Task'}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// TaskItem Component
// ============================================================================

interface TaskItemProps {
  task: AgentTask;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
  onCancel: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onRerun: (taskId: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function TaskItem({ task, isSelected, onSelect, onCancel, onDelete, onRerun, onContextMenu }: TaskItemProps) {
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const isRunning = task.status === 'running';
  const duration = formatDurationBetween(task.started_at, task.completed_at);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Don't select if clicking on action buttons
    if ((e.target as HTMLElement).closest('.task-item-actions')) {
      return;
    }
    onSelect(task.id);
  }, [task.id, onSelect]);

  return (
    <div
      className={`task-item task-item--${task.status}${isSelected ? ' task-item--selected' : ''}`}
      style={{ '--task-status-color': TaskStatusColors[task.status] } as React.CSSProperties}
      onClick={handleClick}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
    >
      <div className="task-item-header">
        <Tooltip label={TaskStatusLabels[task.status]}><span className="task-status-icon">
          {TaskStatusIcons[task.status]}
        </span></Tooltip>
        <span className="task-prompt">{task.prompt}</span>
      </div>

      <div className="task-item-meta">
        <span className="task-status-label">{TaskStatusLabels[task.status]}</span>
        {isRunning && task.progress_pct > 0 && (
          <span className="task-progress">{task.progress_pct}%</span>
        )}
        {duration && <span className="task-duration">{duration}</span>}
        <span className="task-time">{formatRelativeTime(task.created_at)}</span>
      </div>

      {task.error_message && (
        <div className="task-error" title={task.error_message}>
          {task.error_message}
        </div>
      )}

      <div className="task-item-actions">
        {isRunning && (
          <Tooltip label="Cancel task"><button
            className="ns-btn ns-btn--ghost ns-icon-btn"
            onClick={() => onCancel(task.id)}
            aria-label="Cancel task"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          </button></Tooltip>
        )}
        {isTerminal && isEnterprise && (
          <Tooltip label="Re-run task"><button
            className="ns-btn ns-btn--ghost ns-icon-btn"
            onClick={() => onRerun(task.id)}
            aria-label="Re-run task"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
          </button></Tooltip>
        )}
        {isTerminal && (
          <Tooltip label={removeTaskTooltip}><button
            className="ns-btn ns-btn--ghost ns-btn--danger ns-icon-btn"
            onClick={() => onDelete(task.id)}
            aria-label={removeTaskTooltip}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button></Tooltip>
        )}
      </div>
    </div>
  );
}

type AgentsPanelView = 'tasks' | 'schedules';
type AgentFormMode = { type: 'create' } | { type: 'edit'; definition: AgentDefinition };

interface AgentsPanelProps {
  /** When provided, clicking a task opens it as a main-window tab instead of
   *  the cramped inline log viewer. */
  onOpenAgentRun?: (taskId: string, title: string) => void;
}

export default function AgentsPanel({ onOpenAgentRun }: AgentsPanelProps = {}) {
  const {
    tasks,
    isConnected,
    cancelTask,
    deleteTask,
    addTask,
  } = useAgentTasks();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AgentsPanelView>('tasks');

  // Agent definitions state
  const [agentDefs, setAgentDefs] = useState<AgentDefinition[]>([]);
  const [agentFormMode, setAgentFormMode] = useState<AgentFormMode | null>(null);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [runPromptAgentId, setRunPromptAgentId] = useState<string | null>(null);
  const [runPrompt, setRunPrompt] = useState('');
  const [isRunningAgent, setIsRunningAgent] = useState(false);
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const contextMenu = useContextMenu();

  const loadAgentDefs = useCallback(async () => {
    try {
      const defs = await listAgentDefinitions();
      setAgentDefs(defs);
    } catch (err) {
      console.error('[AgentsPanel] Failed to load agent definitions:', err);
    }
  }, []);

  // Load agent definitions on mount
  useEffect(() => {
    let cancelled = false;
    listAgentDefinitions()
      .then((defs) => { if (!cancelled) setAgentDefs(defs); })
      .catch((err: unknown) => console.error('[AgentsPanel] Failed to load agent definitions:', err));
    return () => { cancelled = true; };
  }, []);

  // Get selected task object
  const selectedTask = selectedTaskId
    ? tasks.find(t => t.id === selectedTaskId)
    : null;

  // Group runs by their root: only root runs (no parent) show at the top level;
  // their sub-agents are revealed by expanding. (Sub-agents share root_task_id.)
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(new Set());
  const toggleRoot = useCallback((rootId: string) => {
    setExpandedRoots(prev => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId); else next.add(rootId);
      return next;
    });
  }, []);
  const rootTasks = tasks.filter(t => !t.parent_task_id);
  const childrenByRoot = new Map<string, AgentTask[]>();
  for (const t of tasks) {
    if (t.parent_task_id) {
      const rid = t.root_task_id ?? t.parent_task_id;
      const arr = childrenByRoot.get(rid);
      if (arr) arr.push(t); else childrenByRoot.set(rid, [t]);
    }
  }
  for (const arr of childrenByRoot.values()) {
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  const handleSelectTask = useCallback((taskId: string) => {
    // Open the run in a full main-window tab when the host provides the handler;
    // otherwise fall back to the inline log viewer.
    if (onOpenAgentRun) {
      const t = tasks.find((x) => x.id === taskId);
      const title = t
        ? (t.prompt.length > 32 ? `${t.prompt.slice(0, 32)}…` : t.prompt)
        : 'Agent Run';
      onOpenAgentRun(taskId, title);
      return;
    }
    setSelectedTaskId(taskId);
  }, [onOpenAgentRun, tasks]);

  const handleCloseLogViewer = useCallback(() => {
    setSelectedTaskId(null);
  }, []);

  const handleRerunTask = useCallback(async (taskId: string) => {
    try {
      // Find the task to get prompt and agent_definition_id
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;

      if (task.agent_definition_id) {
        // Enterprise: re-run via the same agent definition
        const newTask = await runAgentDefinition(task.agent_definition_id, task.prompt);
        addTask(newTask);
        logger.log('[AgentsPanel] Re-run agent task created:', newTask.id);
      } else {
        // Standalone: use the old rerunTask API
        const newTask = await rerunTask(taskId);
        logger.log('[AgentsPanel] Created re-run task:', newTask.id);
      }
    } catch (err) {
      console.error('[AgentsPanel] Failed to re-run task:', err);
    }
  }, [tasks, addTask]);

  // Agent definition handlers
  const handleSaveAgentDef = useCallback(async (req: CreateAgentDefinitionRequest | UpdateAgentDefinitionRequest) => {
    setIsSavingAgent(true);
    try {
      if (agentFormMode?.type === 'edit') {
        await updateAgentDefinition(agentFormMode.definition.id, req as UpdateAgentDefinitionRequest);
      } else {
        await createAgentDefinition(req as CreateAgentDefinitionRequest);
      }
      setAgentFormMode(null);
      await loadAgentDefs();
    } catch (err) {
      console.error('[AgentsPanel] Failed to save agent definition:', err);
    } finally {
      setIsSavingAgent(false);
    }
  }, [agentFormMode, loadAgentDefs]);

  const handleDeleteAgentDef = useCallback(async (id: string) => {
    const def = agentDefs.find(d => d.id === id);
    const ok = await confirmDialog({
      title: 'Delete agent definition?',
      body: def ? <>Delete agent <strong>{def.name}</strong>? The system prompt and tool config are removed.</> : 'Delete this agent definition?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentDefinition(id);
      await loadAgentDefs();
    } catch (err) {
      console.error('[AgentsPanel] Failed to delete agent definition:', err);
    }
  }, [loadAgentDefs, agentDefs]);

  const handleDeleteTaskWithConfirm = useCallback(async (taskId: string) => {
    const ok = await confirmDialog(isEnterprise
      ? {
          title: 'Remove task from list?',
          body: 'Hide this task from your list on this device. The Controller keeps the execution history.',
          confirmLabel: 'Remove',
        }
      : {
          title: 'Delete task?',
          body: 'Delete this task and its result history?',
          confirmLabel: 'Delete',
          destructive: true,
        });
    if (ok) deleteTask(taskId);
  }, [deleteTask]);

  const handleRunAgent = useCallback(async (agentId: string) => {
    if (!runPrompt.trim() || isRunningAgent) return;
    setIsRunningAgent(true);
    try {
      const task = await runAgentDefinition(agentId, runPrompt.trim());
      addTask(task);
      logger.log('[AgentsPanel] Agent task created:', task.id);
      // Auto-open the run as a tab so the user lands in the live session.
      if (onOpenAgentRun) {
        const title = task.prompt.length > 32 ? `${task.prompt.slice(0, 32)}…` : task.prompt;
        onOpenAgentRun(task.id, title);
      }
      setRunPromptAgentId(null);
      setRunPrompt('');
    } catch (err) {
      console.error('[AgentsPanel] Failed to run agent:', err);
    } finally {
      setIsRunningAgent(false);
    }
  }, [runPrompt, isRunningAgent, addTask, onOpenAgentRun]);

  // Context menu for a task item
  const handleTaskContextMenu = useCallback((e: React.MouseEvent, task: AgentTask) => {
    const isTerminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    const isRunning = task.status === 'running';
    const items: MenuItem[] = [
      { id: 'view-details', label: 'View Details', action: () => handleSelectTask(task.id) },
    ];
    if (isRunning) {
      items.push({ id: 'cancel', label: 'Cancel', action: () => cancelTask(task.id) });
    }
    if (isTerminal && isEnterprise) {
      items.push({ id: 'rerun', label: 'Re-run', action: () => handleRerunTask(task.id) });
    }
    if (isTerminal && task.result_json) {
      items.push({ id: 'export-csv', label: 'Export CSV', action: () => exportTaskResultAsCsv(task) });
    }
    if (isTerminal) {
      items.push(
        { id: 'divider-1', label: '', divider: true, action: () => {} },
        { id: 'delete', label: removeTaskLabel, action: () => handleDeleteTaskWithConfirm(task.id) },
      );
    }
    contextMenu.open(e, items);
  }, [handleSelectTask, cancelTask, handleRerunTask, handleDeleteTaskWithConfirm, contextMenu]);

  // Context menu for an agent definition
  const handleAgentDefContextMenu = useCallback((e: React.MouseEvent, def: AgentDefinition) => {
    contextMenu.open(e, [
      { id: 'edit', label: 'Edit', action: () => setAgentFormMode({ type: 'edit', definition: def }) },
      { id: 'divider-1', label: '', divider: true, action: () => {} },
      { id: 'delete', label: 'Delete', action: () => handleDeleteAgentDef(def.id) },
    ]);
  }, [handleDeleteAgentDef, contextMenu]);

  return (
    <div className="agents-panel" data-testid="agents-panel">
      {/* Enterprise mode: show tab navigation */}
      {isEnterprise && (
        <div className="agents-panel-tabs">
          <div className="ns-segmented">
            <button
              className={`ns-segment ${activeView === 'tasks' ? 'active' : ''}`}
              onClick={() => setActiveView('tasks')}
            >
              Tasks
            </button>
            <button
              className={`ns-segment ${activeView === 'schedules' ? 'active' : ''}`}
              onClick={() => setActiveView('schedules')}
            >
              Schedules
            </button>
          </div>
        </div>
      )}

      {/* Schedules view (Enterprise only) */}
      {activeView === 'schedules' && isEnterprise ? (
        <ScheduledTasksPanel
          onViewHistory={(scheduleId) => {
            // Runs of a schedule show up as tasks — jump to the Tasks view (NS-FEAT-29).
            logger.log('[AgentsPanel] View history for schedule:', scheduleId);
            setActiveView('tasks');
          }}
        />
      ) : (
        <>
          {/* Agent Definitions Section */}
          {agentFormMode ? (
            <div className="agent-def-form-container">
              <AgentDefinitionForm
                definition={agentFormMode.type === 'edit' ? agentFormMode.definition : null}
                onSave={handleSaveAgentDef}
                onCancel={() => setAgentFormMode(null)}
                isSaving={isSavingAgent}
              />
            </div>
          ) : (
            <div className="agent-defs-section">
              <div className="agent-defs-header">
                <span className="agent-defs-title">Agents</span>
                <Tooltip label="Create new agent"><button
                  className="ns-btn ns-btn--ghost ns-icon-btn"
                  onClick={() => setAgentFormMode({ type: 'create' })}
                  aria-label="Create new agent"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button></Tooltip>
              </div>
              {agentDefs.length > 0 ? (
                <>
                  <div className="agent-icon-row">
                    {agentDefs.map((def) => {
                      const color = getAgentColor(def.name);
                      const isActive = runPromptAgentId === def.id;
                      return (
                        <button
                          key={def.id}
                          className={`agent-icon-btn${isActive ? ' agent-icon--active' : ''}${!def.enabled ? ' agent-icon--disabled' : ''}`}
                          style={{ '--agent-color': color } as React.CSSProperties}
                          onClick={() => setRunPromptAgentId(isActive ? null : def.id)}
                          aria-label={def.name}
                          aria-pressed={isActive}
                          onContextMenu={(e) => handleAgentDefContextMenu(e, def)}
                          onMouseEnter={() => setHoveredAgentId(def.id)}
                          onMouseLeave={() => setHoveredAgentId(null)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <rect x="3" y="11" width="18" height="10" rx="2" />
                            <circle cx="12" cy="5" r="3" />
                            <line x1="12" y1="8" x2="12" y2="11" />
                            <circle cx="8.5" cy="16" r="1.5" fill="currentColor" stroke="none" />
                            <circle cx="15.5" cy="16" r="1.5" fill="currentColor" stroke="none" />
                          </svg>
                        </button>
                      );
                    })}
                  </div>
                  {/* Hover detail bar - shows info for hovered or selected agent */}
                  {(() => {
                    const detailId = hoveredAgentId || runPromptAgentId;
                    const detailDef = detailId ? agentDefs.find(d => d.id === detailId) : null;
                    if (!detailDef) return null;
                    const color = getAgentColor(detailDef.name);
                    return (
                      <div className="agent-detail-bar" style={{ '--agent-color': color } as React.CSSProperties}>
                        <div className="agent-detail-info">
                          <span className="agent-detail-name">{detailDef.name}</span>
                          <div className="agent-detail-meta-row">
                            {!detailDef.enabled && <span className="agent-detail-disabled">disabled</span>}
                            {detailDef.description && <span className="agent-detail-desc">{detailDef.description}</span>}
                          </div>
                        </div>
                        <div className="agent-detail-actions">
                          <Tooltip label="Edit"><button className="ns-btn ns-btn--ghost ns-icon-btn" onClick={() => setAgentFormMode({ type: 'edit', definition: detailDef })} aria-label="Edit">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button></Tooltip>
                          <Tooltip label="Delete"><button onClick={() => handleDeleteAgentDef(detailDef.id)} aria-label="Delete" className="ns-btn ns-btn--ghost ns-btn--danger ns-icon-btn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                            </svg>
                          </button></Tooltip>
                        </div>
                      </div>
                    );
                  })()}
                  {runPromptAgentId && (() => {
                    const activeDef = agentDefs.find(d => d.id === runPromptAgentId);
                    if (!activeDef) return null;
                    return (
                      <div className="agent-run-prompt">
                        <AITabInput
                          as="textarea"
                          value={runPrompt}
                          onChange={(e) => setRunPrompt(e.target.value)}
                          placeholder={`Prompt for ${activeDef.name}...`}
                          rows={2}
                          disabled={isRunningAgent}
                          autoFocus
                          aiField="agent_run_prompt"
                          aiPlaceholder="Task prompt to run this agent with"
                          aiContext={{ agent: activeDef.name, description: activeDef.description }}
                          onAIValue={(v) => setRunPrompt(v)}
                        />
                        <DialogFooter
                          primary={{ label: isRunningAgent ? 'Running...' : 'Run', onClick: () => handleRunAgent(activeDef.id), disabled: !runPrompt.trim() || isRunningAgent }}
                          onCancel={() => { setRunPromptAgentId(null); setRunPrompt(''); }}
                          cancelDisabled={isRunningAgent}
                          inline
                        />
                      </div>
                    );
                  })()}
                </>
              ) : (
                <div className="agent-defs-empty">
                  No agents configured. Create one to get started.
                </div>
              )}
            </div>
          )}

          {/* Execution Monitor Section */}
          <div className="agents-header">
            <div className="agents-status">
              <span className={`connection-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
                {isConnected ? 'Connected' : 'Reconnecting...'}
              </span>
            </div>
            {tasks.some(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') && (
              <Tooltip label="Clear completed, failed, and cancelled tasks"><button
                className="ns-btn ns-btn--small"
                onClick={async () => {
                  const finishedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled');
                  if (finishedTasks.length === 0) return;
                  const plural = finishedTasks.length === 1 ? '' : 's';
                  const ok = await confirmDialog(isEnterprise
                    ? {
                        title: 'Clear finished tasks?',
                        body: `Remove ${finishedTasks.length} completed / failed / cancelled task${plural} from your list on this device? The Controller keeps the execution history.`,
                        confirmLabel: 'Clear',
                      }
                    : {
                        title: 'Clear finished tasks?',
                        body: `Delete ${finishedTasks.length} completed / failed / cancelled task${plural} and their result history?`,
                        confirmLabel: 'Clear',
                        destructive: true,
                      });
                  if (!ok) return;
                  finishedTasks.forEach(t => deleteTask(t.id));
                }}
              >
                Clear Completed
              </button></Tooltip>
            )}
          </div>

          <div className="agents-list">
            {selectedTask ? (
              <TaskLogViewer
                task={selectedTask}
                onClose={handleCloseLogViewer}
                onCancel={cancelTask}
                onDelete={deleteTask}
                onRerun={handleRerunTask}
              />
            ) : rootTasks.length === 0 ? (
              <div className="no-tasks">
                No tasks yet. Run an agent to get started.
              </div>
            ) : (
              rootTasks.map((task) => {
                const kids = childrenByRoot.get(task.id) ?? [];
                const isExpanded = expandedRoots.has(task.id);
                return (
                  <div key={task.id} className="task-group">
                    <TaskItem
                      task={task}
                      isSelected={task.id === selectedTaskId}
                      onSelect={handleSelectTask}
                      onCancel={cancelTask}
                      onDelete={deleteTask}
                      onRerun={handleRerunTask}
                      onContextMenu={(e) => handleTaskContextMenu(e, task)}
                    />
                    {kids.length > 0 && (
                      <Tooltip label={isExpanded ? 'Hide sub-agents' : 'Show sub-agents'}><button
                        className="task-group-toggle"
                        onClick={() => toggleRoot(task.id)}
                      >
                        <svg className={`tg-chev${isExpanded ? ' open' : ''}`} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="9 6 15 12 9 18" />
                        </svg>
                        {kids.length} sub-agent{kids.length === 1 ? '' : 's'}
                      </button></Tooltip>
                    )}
                    {isExpanded && kids.length > 0 && (
                      <div className="task-group-children">
                        {kids.map((kid) => (
                          <TaskItem
                            key={kid.id}
                            task={kid}
                            isSelected={kid.id === selectedTaskId}
                            onSelect={handleSelectTask}
                            onCancel={cancelTask}
                            onDelete={deleteTask}
                            onRerun={handleRerunTask}
                            onContextMenu={(e) => handleTaskContextMenu(e, kid)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="agents-panel-footer">
            <span className="agents-footer-info">
              Tasks persist across app restarts
            </span>
          </div>
        </>
      )}
      <ContextMenu position={contextMenu.position} items={contextMenu.items} onClose={contextMenu.close} />
    </div>
  );
}
