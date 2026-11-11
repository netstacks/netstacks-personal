/**
 * scheduledTasks.ts - API client for scheduled agent tasks (Enterprise)
 *
 * Provides CRUD operations for managing scheduled agent tasks.
 */

import { getClient } from './client';

export interface ScheduledTask {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface CreateScheduledTaskRequest {
  name: string;
  description?: string;
  prompt: string;
  cron_expression: string;
  timezone?: string;
  enabled?: boolean;
}

export interface UpdateScheduledTaskRequest {
  name?: string;
  description?: string;
  prompt?: string;
  cron_expression?: string;
  timezone?: string;
  enabled?: boolean;
}

/**
 * List all scheduled agent tasks for current user
 */
export async function listScheduledTasks(
  limit = 50,
  offset = 0
): Promise<ScheduledTask[]> {
  const response = await getClient().http.get(
    '/tasks/agent-schedules',
    { params: { limit, offset } }
  );
  // Controller wraps in { tasks: [...], total, limit, offset }
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.tasks)) return data.tasks;
  return [];
}

/**
 * Get a scheduled task by ID
 */
export async function getScheduledTask(taskId: string): Promise<ScheduledTask> {
  const response = await getClient().http.get<ScheduledTask>(
    `/tasks/agent-schedules/${taskId}`
  );
  return response.data;
}

/**
 * Create a new scheduled agent task
 */
export async function createScheduledTask(
  req: CreateScheduledTaskRequest
): Promise<ScheduledTask> {
  const response = await getClient().http.post<ScheduledTask>(
    '/tasks/agent-schedules',
    req
  );
  return response.data;
}

/**
 * Update a scheduled task
 */
export async function updateScheduledTask(
  taskId: string,
  req: UpdateScheduledTaskRequest
): Promise<ScheduledTask> {
  const response = await getClient().http.put<ScheduledTask>(
    `/tasks/agent-schedules/${taskId}`,
    req
  );
  return response.data;
}

/**
 * Pause a scheduled task (set enabled = false)
 */
export async function pauseScheduledTask(taskId: string): Promise<ScheduledTask> {
  return updateScheduledTask(taskId, { enabled: false });
}

/**
 * Resume a scheduled task (set enabled = true)
 */
export async function resumeScheduledTask(taskId: string): Promise<ScheduledTask> {
  return updateScheduledTask(taskId, { enabled: true });
}

/**
 * Delete a scheduled task
 */
export async function deleteScheduledTask(taskId: string): Promise<void> {
  await getClient().http.delete(`/tasks/agent-schedules/${taskId}`);
}

/**
 * Parse cron expression to human-readable format
 */
export function describeCron(cron: string): string {
  // Simple cron description - common patterns
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Daily at specific time
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (minute === '0' && hour !== '*') {
      return `Daily at ${hour}:00`;
    }
    if (minute !== '*' && hour !== '*') {
      return `Daily at ${hour}:${minute.padStart(2, '0')}`;
    }
  }

  // Weekdays
  if (dayOfWeek === '1-5' && dayOfMonth === '*' && month === '*') {
    if (minute === '0' && hour !== '*') {
      return `Weekdays at ${hour}:00`;
    }
  }

  // Weekly
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayNum = parseInt(dayOfWeek, 10);
    if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
      return `Every ${days[dayNum]} at ${hour}:${minute.padStart(2, '0')}`;
    }
  }

  // Monthly
  if (dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    return `Monthly on day ${dayOfMonth} at ${hour}:${minute.padStart(2, '0')}`;
  }

  // Fallback to raw cron
  return cron;
}
