import { getErrorMessage } from '../api/errors'
/**
 * ScheduledTasksPanel - Manage scheduled agent tasks (Enterprise)
 *
 * Provides UI for viewing, creating, editing, pausing/resuming, and deleting
 * scheduled agent tasks. Enterprise feature only.
 */

import { useState, useEffect, useCallback } from 'react';
import './ScheduledTasksPanel.css';
import * as scheduledTasksApi from '../api/scheduledTasks';
import type { ScheduledTask, CreateScheduledTaskRequest } from '../api/scheduledTasks';
import ContextMenu from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { useContextMenu } from '../hooks/useContextMenu';
import AITabInput from './AITabInput';
import { confirmDialog } from './ConfirmDialog';
import { useDirtyGuard } from '../hooks/useDirtyGuard';

interface ScheduledTasksPanelProps {
  /** Callback when user wants to view execution history for a task */
  onViewHistory?: (taskId: string) => void;
}

export function ScheduledTasksPanel({ onViewHistory }: ScheduledTasksPanelProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const contextMenu = useContextMenu();

  // Load tasks on mount
  const loadTasks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await scheduledTasksApi.listScheduledTasks();
      setTasks(data);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to load scheduled tasks'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Re-render the panel every 30s so the "Next: in 5 min" labels stay
  // honest without the user touching anything. formatNextRun is called
  // on every render anyway; the tick is purely to invalidate the
  // component view. Picked 30s rather than the obvious 60s so a task
  // scheduled for "in 1 minute" doesn't sit at "in 1 minute" for the
  // full minute before suddenly jumping to "in a few seconds".
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Toggle pause/resume
  const handleToggleEnabled = async (task: ScheduledTask) => {
    try {
      const updated = task.enabled
        ? await scheduledTasksApi.pauseScheduledTask(task.id)
        : await scheduledTasksApi.resumeScheduledTask(task.id);
      setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to update task'));
    }
  };

  // Delete task
  const handleDelete = async (taskId: string) => {
    const ok = await confirmDialog({
      title: 'Delete scheduled task?',
      body: 'Future runs of this task will be cancelled. Past run history is preserved.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await scheduledTasksApi.deleteScheduledTask(taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to delete task'));
    }
  };

  // Format next run time
  const formatNextRun = (isoString: string | null): string => {
    if (!isoString) return 'Not scheduled';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffMs < 0) return 'Overdue';
    if (diffHours < 1) return 'Less than 1 hour';
    if (diffHours < 24) return `In ${diffHours} hours`;
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays < 7) return `In ${diffDays} days`;
    return date.toLocaleDateString();
  };

  // Context menu for a scheduled task item
  const handleTaskContextMenu = useCallback((e: React.MouseEvent, task: ScheduledTask) => {
    const items: MenuItem[] = [
      { id: 'edit', label: 'Edit', action: () => setEditingTask(task) },
      {
        id: 'toggle',
        label: task.enabled ? 'Pause' : 'Resume',
        action: () => handleToggleEnabled(task),
      },
    ];
    if (onViewHistory) {
      items.push({ id: 'history', label: 'View History', action: () => onViewHistory(task.id) });
    }
    items.push(
      { id: 'divider-1', label: '', divider: true, action: () => {} },
      { id: 'delete', label: 'Delete', action: () => handleDelete(task.id) },
    );
    contextMenu.open(e, items);
  }, [onViewHistory, contextMenu]);

  // Context menu for empty area
  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    contextMenu.open(e, [
      { id: 'new-schedule', label: 'New Schedule', action: () => setShowCreateDialog(true) },
    ]);
  }, [contextMenu]);

  if (loading) {
    return (
      <div className="scheduled-tasks-panel">
        <div className="scheduled-tasks-loading">Loading scheduled tasks...</div>
      </div>
    );
  }

  return (
    <div className="scheduled-tasks-panel">
      <div className="scheduled-tasks-header">
        <h3>Scheduled Tasks</h3>
        <button
          className="scheduled-tasks-create-btn"
          onClick={() => setShowCreateDialog(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Schedule
        </button>
      </div>

      {error && (
        <div className="scheduled-tasks-error">{error}</div>
      )}

      {tasks.length === 0 ? (
        <div className="scheduled-tasks-empty" onContextMenu={handleEmptyContextMenu}>
          <p>No scheduled tasks yet.</p>
          <p>Create a schedule to run agent tasks automatically.</p>
        </div>
      ) : (
        <div className="scheduled-tasks-list" onContextMenu={handleEmptyContextMenu}>
          {tasks.map(task => (
            <div
              key={task.id}
              className={`scheduled-task-item ${task.enabled ? 'enabled' : 'paused'}`}
              onContextMenu={(e) => handleTaskContextMenu(e, task)}
            >
              <div className="scheduled-task-main">
                <div className="scheduled-task-name">{task.name}</div>
                <div className="scheduled-task-schedule">
                  <span className="scheduled-task-cron">
                    {scheduledTasksApi.describeCron(task.cron_expression)}
                  </span>
                  <span className="scheduled-task-timezone">({task.timezone})</span>
                </div>
                <div className="scheduled-task-next">
                  {task.enabled ? (
                    <>Next: {formatNextRun(task.next_run_at)}</>
                  ) : (
                    <span className="scheduled-task-paused-label">Paused</span>
                  )}
                </div>
              </div>

              <div className="scheduled-task-actions">
                <button
                  className="scheduled-task-action"
                  onClick={() => handleToggleEnabled(task)}
                  title={task.enabled ? 'Pause' : 'Resume'}
                >
                  {task.enabled ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  )}
                </button>

                <button
                  className="scheduled-task-action"
                  onClick={() => setEditingTask(task)}
                  title="Edit"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>

                {onViewHistory && (
                  <button
                    className="scheduled-task-action"
                    onClick={() => onViewHistory(task.id)}
                    title="View History"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </button>
                )}

                <button
                  className="scheduled-task-action delete"
                  onClick={() => handleDelete(task.id)}
                  title="Delete"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ContextMenu position={contextMenu.position} items={contextMenu.items} onClose={contextMenu.close} />

      {/* Create/Edit Dialog */}
      {(showCreateDialog || editingTask) && (
        <ScheduleTaskDialog
          task={editingTask}
          onClose={() => {
            setShowCreateDialog(false);
            setEditingTask(null);
          }}
          onSave={async (data) => {
            try {
              if (editingTask) {
                const updated = await scheduledTasksApi.updateScheduledTask(editingTask.id, data);
                setTasks(prev => prev.map(t => t.id === editingTask.id ? updated : t));
              } else {
                const created = await scheduledTasksApi.createScheduledTask(data as CreateScheduledTaskRequest);
                setTasks(prev => [created, ...prev]);
              }
              setShowCreateDialog(false);
              setEditingTask(null);
            } catch (e) {
              setError(getErrorMessage(e, 'Failed to save task'));
            }
          }}
        />
      )}
    </div>
  );
}

// Dialog component for create/edit
interface ScheduleTaskDialogProps {
  task: ScheduledTask | null;
  onClose: () => void;
  onSave: (data: CreateScheduledTaskRequest) => Promise<void>;
}

function ScheduleTaskDialog({ task, onClose, onSave }: ScheduleTaskDialogProps) {
  const [name, setName] = useState(task?.name || '');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [cronExpression, setCronExpression] = useState(task?.cron_expression || '0 9 * * *');
  const [timezone, setTimezone] = useState(task?.timezone || 'UTC');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against silent loss of a half-typed schedule. The X button and
  // the backdrop click both used to drop the form without confirming.
  const initialSnapshot = {
    name: task?.name || '',
    prompt: task?.prompt || '',
    cronExpression: task?.cron_expression || '0 9 * * *',
    timezone: task?.timezone || 'UTC',
  };
  const currentSnapshot = { name, prompt, cronExpression, timezone };
  const { confirmDiscard } = useDirtyGuard(currentSnapshot, {
    initial: initialSnapshot,
    resetKey: task?.id ?? 'new',
  });
  const handleClose = async () => {
    if (!(await confirmDiscard())) return;
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) {
      setError('Name and prompt are required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        cron_expression: cronExpression,
        timezone,
        enabled: true,
      });
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to save'));
    } finally {
      // Audit P2-7: always clear saving even on a silently-handled
      // parent error. Without finally, parent catching its OWN error
      // (and not re-throwing) left this dialog stuck on "Saving…"
      // forever. The parent normally unmounts on success, so the
      // setSaving(false) is a no-op in the happy path.
      setSaving(false);
    }
  };

  return (
    <div className="schedule-dialog-overlay" onClick={handleClose}>
      <div className="schedule-dialog" onClick={e => e.stopPropagation()}>
        <div className="schedule-dialog-header">
          <h3>{task ? 'Edit Schedule' : 'New Schedule'}</h3>
          <button className="schedule-dialog-close" onClick={handleClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="schedule-dialog-field">
            <label>Name</label>
            <AITabInput
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Daily network audit"
              aiField="task_name"
              aiPlaceholder="Name for this scheduled task"
              aiContext={{ prompt }}
              onAIValue={(v) => setName(v)}
              autoFocus
            />
          </div>

          <div className="schedule-dialog-field">
            <label>Prompt</label>
            <AITabInput
              as="textarea"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Check all core routers for interface errors and report anomalies..."
              rows={4}
              aiField="task_prompt"
              aiPlaceholder="Instructions for the AI agent task"
              aiContext={{ name }}
              onAIValue={(v) => setPrompt(v)}
            />
          </div>

          <div className="schedule-dialog-row">
            <div className="schedule-dialog-field">
              <label>Cron Expression</label>
              <input
                type="text"
                value={cronExpression}
                onChange={e => setCronExpression(e.target.value)}
                placeholder="0 9 * * *"
              />
              <div className="schedule-dialog-hint">
                {scheduledTasksApi.describeCron(cronExpression)}
              </div>
            </div>

            <div className="schedule-dialog-field">
              <label>Timezone</label>
              <select value={timezone} onChange={e => setTimezone(e.target.value)}>
                <option value="UTC">UTC</option>
                <option value="America/New_York">America/New_York</option>
                <option value="America/Los_Angeles">America/Los_Angeles</option>
                <option value="America/Chicago">America/Chicago</option>
                <option value="Europe/London">Europe/London</option>
                <option value="Europe/Paris">Europe/Paris</option>
                <option value="Asia/Tokyo">Asia/Tokyo</option>
                <option value="Australia/Sydney">Australia/Sydney</option>
              </select>
            </div>
          </div>

          {error && <div className="schedule-dialog-error">{error}</div>}

          <div className="schedule-dialog-actions">
            <button type="button" onClick={handleClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={saving || !name.trim() || !prompt.trim()}
              title={!name.trim() || !prompt.trim() ? 'Name and prompt are required' : undefined}
            >
              {saving ? 'Saving...' : task ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ScheduledTasksPanel;
