/**
 * Task types for AI agent task management
 *
 * These types match the backend models in terminal/agent/src/tasks/models.rs
 */

/** Task status enum matching backend TaskStatus */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Agent task record from backend */
export interface AgentTask {
  id: string;
  prompt: string;
  status: TaskStatus;
  progress_pct: number;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  agent_definition_id?: string | null;
  // Sub-agent orchestration linkage (Phase 1).
  /** Immediate parent run (null/absent = top-level). */
  parent_task_id?: string | null;
  /** Top of the delegation tree (denormalized for cheap subtree fetch). */
  root_task_id?: string | null;
  /** 0 = root; incremented per delegation level. */
  depth?: number;
  /** Specialist definition this child was delegated to (null = ephemeral). */
  spawned_by_agent_definition_id?: string | null;
  /** Short label the parent gave the sub-job. */
  delegation_label?: string | null;
}

/** Failure policy options for task execution */
export type FailurePolicy = 'stop' | 'continue' | 'retry';

/** Full failure policy configuration */
export interface FailurePolicyConfig {
  policy: FailurePolicy;
  /** Number of retries (only applicable when policy is 'retry') */
  retry_count?: number;
}

/** Request to create a new task */
export interface CreateTaskRequest {
  prompt: string;
  /** Failure policy configuration (optional, defaults to 'stop') */
  failure_policy?: FailurePolicyConfig;
}

/** Response from list tasks endpoint */
export interface ListTasksResponse {
  tasks: AgentTask[];
  running_count: number;
  max_concurrent: number;
}

/** One durable transcript step for the glass-box view (Feature A).
 *  Mirrors the serialized Rust TaskMessage (snake_case — no camelCase rename). */
export interface TaskMessage {
  id: string;
  task_id: string;
  seq: number;
  iteration: number;
  kind: 'thought' | 'command' | 'tool_result' | 'error' | 'status';
  tool_name: string | null;
  content: string;
  created_at: string;
}

/** Task progress event sent via WebSocket */
export interface TaskProgressEvent {
  type: 'task_progress';
  taskId: string;
  status: TaskStatus;
  progressPct: number;
  message?: string;
  result?: unknown;
  error?: string;
  /** Feature A: optional persisted transcript step (snake_case TaskMessage). */
  step?: TaskMessage;
}

/** Init event sent on WebSocket connection */
export interface TaskInitEvent {
  type: 'init';
  tasks: AgentTask[];
  running_count: number;
  max_concurrent: number;
}

/** Union of all WebSocket message types */
export type TaskWsMessage = TaskProgressEvent | TaskInitEvent;

/** WebSocket command to cancel a task */
export interface TaskCancelCommand {
  type: 'cancel';
  task_id: string;
}
