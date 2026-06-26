/**
 * REST API client for task management
 *
 * Provides CRUD operations for AI agent tasks.
 *
 * NOTE: Endpoints differ between standalone and enterprise mode:
 * - Standalone: Uses local agent's /tasks endpoint
 * - Enterprise: Uses Controller's /admin/agent-tasks and /tasks/agent-schedules endpoints
 */

import { getClient, getCurrentMode } from './client';
import type { AgentTask, CreateTaskRequest, ListTasksResponse, TaskMessage } from '../types/tasks';

const isEnterprise = () => getCurrentMode() === 'enterprise';

/**
 * Shape of an execution record returned by the controller's
 * `/admin/agent-tasks/history` and `/admin/agent-tasks/history/:id` endpoints in
 * enterprise mode. Fields are best-effort because the controller schema
 * has drifted over time; map through `mapExecutionStatus` for state.
 *
 * If the controller backfills more required fields later, prefer adding
 * them here over re-introducing `Record<string, unknown>` casts.
 */
interface ControllerExecution {
  id: string;
  /** Controller's execution state — see mapExecutionStatus for the union. */
  state?: string;
  input_task?: string;
  prompt?: string;
  output?: string | null;
  final_answer?: string | null;
  error_message?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/**
 * Create a new task
 *
 * In enterprise mode, creates a one-off agent task execution via schedule endpoint.
 */
export async function createTask(req: CreateTaskRequest): Promise<AgentTask> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode workaround: the controller has no "one-off agent task"
    // endpoint, only scheduled tasks. We create a schedule with `enabled:
    // false` so the cron worker never picks it up, then immediately invoke
    // the schedule's /run endpoint. The schedule record is left behind as
    // an audit trail. Replace this whole branch when the controller
    // exposes a true one-off execution endpoint.
    //
    // The cron must be a *syntactically valid* expression — the controller
    // validates it via the `croner` crate (controller/crates/api/src/routes/tasks.rs
    // validate_cron) which rejects impossible dates like Feb 31. The old
    // sentinel `'0 0 31 2 *'` was rejected with HTTP 400, breaking
    // task creation in enterprise mode entirely. `0 0 1 1 *` (midnight
    // Jan 1) is valid; with enabled=false the cron worker never fires it.
    const scheduleResp = await client.http.post('/tasks/agent-schedules', {
      name: `One-off: ${req.prompt.slice(0, 30)} [${Date.now()}]`,
      prompt: req.prompt,
      cron_expression: '0 0 1 1 *',
      enabled: false,
    });

    // Run it immediately
    const runResp = await client.http.post(`/tasks/agent-schedules/${scheduleResp.data.id}/run`);

    // Return in AgentTask format
    return {
      id: runResp.data.id, // execution ID
      prompt: req.prompt,
      status: 'pending',
      progress_pct: 0,
      result_json: null,
      error_message: null,
      created_at: runResp.data.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: runResp.data.started_at || null,
      completed_at: null,
    };
  }

  // Standalone mode: direct task creation
  const response = await client.http.post('/tasks', req);
  return response.data;
}

/**
 * List tasks with optional filtering
 *
 * In enterprise mode, fetches from agent-tasks history endpoint.
 */
export async function listTasks(params?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<ListTasksResponse> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: use agent-tasks history endpoint (admin-gated on the
    // controller — mounted under /api/admin/agent-tasks; matches admin-ui).
    const response = await client.http.get('/admin/agent-tasks/history', { params });

    // Transform to ListTasksResponse format. Controller returns 'state'
    // (not 'status'); map through mapExecutionStatus.
    const executions: ControllerExecution[] = Array.isArray(response.data?.executions)
      ? response.data.executions
      : [];
    return {
      tasks: executions.map<AgentTask>(exec => ({
        id: exec.id,
        prompt: exec.input_task || exec.prompt || '',
        status: mapExecutionStatus(exec.state ?? ''),
        progress_pct: exec.state === 'running' ? 50 : ((exec.state === 'completed' || exec.state === 'success') ? 100 : 0),
        result_json: exec.output || exec.final_answer || null,
        error_message: exec.error_message || null,
        created_at: exec.created_at,
        updated_at: exec.completed_at || exec.created_at,
        started_at: exec.started_at || exec.created_at,
        completed_at: exec.completed_at || null,
      })),
      running_count: executions.filter(e => e.state === 'running').length,
      max_concurrent: 3, // Default, could fetch from limits endpoint
    };
  }

  // Standalone mode: direct list
  const response = await client.http.get('/tasks', { params });
  return response.data;
}

/**
 * Map Controller execution status to frontend TaskStatus.
 *
 * Controller emits the variants of `ExecutionState`
 * (controller/crates/models/src/task_execution.rs, serde rename_all =
 * snake_case): pending, running, completed, failed, cancelled, timeout,
 * approval_pending.
 *
 * 'success' / 'error' are kept as defensive aliases for older controller
 * builds but the current controller never emits them.
 */
function mapExecutionStatus(status: string): 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' {
  switch (status?.toLowerCase()) {
    case 'success':
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
    case 'timeout':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'pending':
    case 'approval_pending':
      return 'pending';
    default:
      return 'pending';
  }
}

/**
 * Get a task by ID
 */
export async function getTask(id: string): Promise<AgentTask> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: get from history endpoint (admin-gated; /api/admin/agent-tasks).
    // Controller returns 'state' field, not 'status'; map through mapExecutionStatus.
    const response = await client.http.get(`/admin/agent-tasks/history/${id}`);
    const exec = response.data as ControllerExecution;

    return {
      id: exec.id,
      prompt: exec.input_task || exec.prompt || '',
      status: mapExecutionStatus(exec.state ?? ''),
      progress_pct: exec.state === 'running' ? 50 : ((exec.state === 'completed' || exec.state === 'success') ? 100 : 0),
      result_json: exec.output || exec.final_answer || null,
      error_message: exec.error_message || null,
      created_at: exec.created_at,
      updated_at: exec.completed_at || exec.created_at,
      started_at: exec.started_at || exec.created_at,
      completed_at: exec.completed_at || null,
    };
  }

  const response = await client.http.get(`/tasks/${id}`);
  return response.data;
}

/**
 * Feature A: backfill transcript steps with seq > sinceSeq (-1 = all).
 * Enterprise has no transcript table yet, so it degrades to empty.
 */
export async function getTaskMessages(
  taskId: string,
  sinceSeq = -1,
): Promise<TaskMessage[]> {
  const client = getClient();

  if (isEnterprise()) {
    // Controller does not expose a transcript catch-up endpoint yet.
    return [];
  }

  const response = await client.http.get(`/tasks/${taskId}/messages`, {
    params: { since_seq: sinceSeq },
  });
  return response.data;
}

/**
 * Delete a task
 *
 * In enterprise mode, this deletes the execution record.
 */
export async function deleteTask(id: string): Promise<void> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: cancel first if running, then the record is kept for history
    // (Controller doesn't have delete for executions, they're kept for audit)
    await client.http.post(`/tasks/executions/${id}/cancel`).catch(() => {
      // Ignore if already completed or not found
    });
    return;
  }

  await client.http.delete(`/tasks/${id}`);
}

/**
 * Cancel a running task
 */
export async function cancelTask(taskId: string): Promise<void> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise mode: cancel via executions endpoint. The controller does not
    // yet expose this route, so tolerate a 404 (degrade to no-op) the same way
    // deleteTask does, instead of throwing an unhandled error to the caller.
    await client.http.post(`/tasks/executions/${taskId}/cancel`).catch((err) => {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status && status !== 404 && status !== 405) throw err;
    });
    return;
  }

  // Standalone mode: delete endpoint also cancels if running
  await client.http.delete(`/tasks/${taskId}`);
}

/**
 * Re-run a completed task with the same prompt (Enterprise only)
 * Creates a new task using the original task's prompt
 */
export async function rerunTask(taskId: string): Promise<AgentTask> {
  // First get the original task to extract prompt
  const original = await getTask(taskId);

  // The prompt is stored directly on the task
  const prompt = original.prompt;

  if (!prompt) {
    throw new Error('Cannot re-run task: no prompt found');
  }

  // Create new task with same prompt
  const newTask = await createTask({ prompt });
  return newTask;
}
