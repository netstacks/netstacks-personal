// API client for MOP sync with Controller (enterprise mode only)
// Terminal pushes plans and execution results to controller for audit/approval/RAG

import { getClient } from './client';
import type { MopStep } from '../types/change';

// Controller MOP plan (matches controller's Mop model)
export interface ControllerMop {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  description?: string;
  author: string;
  revision: number;
  status: string; // 'draft' | 'pending_review' | 'approved' | 'rejected'
  risk_level?: string;
  change_ticket?: string;
  tags: string[];
  platform_hints: string[];
  estimated_duration_minutes?: number;
  mop_lineage_id: string;
  parent_id?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_comment?: string;
  package_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Controller MOP execution log
export interface ControllerMopExecutionLog {
  id: string;
  org_id: string;
  mop_id?: string;
  started_by: string;
  name: string;
  status: string;
  control_mode: string;
  execution_strategy: string;
  device_results: unknown[];
  step_results: unknown[];
  ai_analysis?: Record<string, unknown>;
  snapshot_diffs?: Record<string, unknown>;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  skipped_steps: number;
  started_at: string;
  completed_at?: string;
  created_at: string;
}

export interface ControllerMopSummary {
  id: string;
  name: string;
  status: string;
  revision: number;
  author: string;
  risk_level?: string;
  change_ticket?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ControllerExecLogSummary {
  id: string;
  mop_id?: string;
  name: string;
  status: string;
  control_mode: string;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  skipped_steps: number;
  started_at: string;
  completed_at?: string;
}

// === Conversion ===

/**
 * Convert a ControllerMop into a Change object for use in the local UI.
 * Maps package_data.mop.steps → mop_steps and controller status → change status.
 */
export function controllerMopToChange(mop: ControllerMop): import('../types/change').Change {
  // Extract steps from package_data
  const pkg = mop.package_data as { mop?: { steps?: Array<{ order?: number; step_type: string; command: string; description?: string; expected_output?: string }> }; metadata?: Record<string, unknown> };
  const rawSteps = pkg?.mop?.steps || [];
  const mopSteps: import('../types/change').MopStep[] = rawSteps.map((s, i) => ({
    id: crypto.randomUUID(),
    order: s.order ?? i,
    step_type: s.step_type as import('../types/change').MopStepType,
    command: s.command,
    description: s.description,
    expected_output: s.expected_output,
    status: 'pending' as const,
  }));

  return {
    id: mop.id,
    name: mop.name,
    description: mop.description,
    status: (mop.status as import('../types/change').ChangeStatus) || 'draft',
    mop_steps: mopSteps,
    device_overrides: undefined,
    created_by: mop.author,
    created_at: mop.created_at,
    updated_at: mop.updated_at,
  };
}

// === Plan Sync ===

/** Shared input type for MOP plan data used by push and update operations */
export interface MopPlanInput {
  name: string;
  description?: string;
  steps: MopStep[];
  risk_level?: string;
  change_ticket?: string;
  tags?: string[];
  device_overrides?: Record<string, MopStep[]>;
}

/**
 * Build the package_data payload from a MOP plan input.
 * Shared by pushPlanToController and updateControllerMop to avoid duplication.
 */
export function buildMopPackageData(plan: MopPlanInput): Record<string, unknown> {
  return {
    mop: {
      name: plan.name,
      description: plan.description,
      steps: plan.steps.map(s => ({
        step_type: s.step_type,
        command: s.command,
        description: s.description,
        expected_output: s.expected_output,
      })),
      device_overrides: plan.device_overrides,
    },
    metadata: {
      riskLevel: plan.risk_level,
      changeTicket: plan.change_ticket,
      tags: plan.tags || [],
    },
  };
}

/**
 * Push a MOP plan to the controller. Creates a new revision if lineage exists,
 * or creates a brand new MOP if no lineage_id is provided.
 */
export async function pushPlanToController(
  plan: MopPlanInput,
  lineageId?: string,
): Promise<ControllerMop> {
  const client = getClient();
  const packageData = buildMopPackageData(plan);

  const res = await client.http.post('/mops', {
    package_data: packageData,
    mop_lineage_id: lineageId || undefined,
  });
  return res.data;
}

/**
 * Update an existing draft MOP on the controller.
 */
export async function updateControllerMop(
  mopId: string,
  plan: MopPlanInput,
): Promise<ControllerMop> {
  const client = getClient();
  const packageData = buildMopPackageData(plan);

  const res = await client.http.put(`/mops/${mopId}`, {
    package_data: packageData,
  });
  return res.data;
}

/**
 * Delete a MOP from the controller (draft or rejected only).
 */
export async function deleteControllerMop(mopId: string): Promise<void> {
  const client = getClient();
  await client.http.delete(`/mops/${mopId}`);
}

/**
 * Get a MOP from the controller by ID.
 */
export async function getControllerMop(mopId: string): Promise<ControllerMop> {
  const client = getClient();
  const res = await client.http.get(`/mops/${mopId}`);
  return res.data;
}

/**
 * List MOPs from the controller.
 */
export async function listControllerMops(
  params?: { status?: string; limit?: number; offset?: number },
): Promise<ControllerMopSummary[]> {
  const client = getClient();
  const res = await client.http.get('/mops', { params });
  return res.data;
}

/**
 * Submit a MOP for review (draft → pending_review).
 */
export async function submitMopForReview(mopId: string): Promise<ControllerMop> {
  const client = getClient();
  const res = await client.http.post(`/mops/${mopId}/submit`);
  return res.data;
}

/**
 * Get the approval status of a MOP.
 */
export async function getMopApprovalStatus(mopId: string): Promise<{
  status: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_comment?: string;
}> {
  const mop = await getControllerMop(mopId);
  return {
    status: mop.status,
    reviewed_by: mop.reviewed_by,
    reviewed_at: mop.reviewed_at,
    review_comment: mop.review_comment,
  };
}

// === Execution Log Sync ===
// Uses the /mop-executions engine routes. Summary data (device_results,
// step_results, counts) is stored in the ai_analysis TEXT field as JSON.

/** Input type for execution log push/update */
export interface ExecutionLogInput {
  name: string;
  status: string;
  control_mode: string;
  execution_strategy: string;
  device_results: unknown[];
  step_results: unknown[];
  ai_analysis?: Record<string, unknown>;
  snapshot_diffs?: Record<string, unknown>;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  skipped_steps: number;
  started_at: string;
  completed_at?: string;
}

/** Build the ai_analysis JSON string that stores execution summary data */
function buildAnalysisPayload(log: ExecutionLogInput): string {
  return JSON.stringify({
    device_results: log.device_results,
    step_results: log.step_results,
    total_steps: log.total_steps,
    passed_steps: log.passed_steps,
    failed_steps: log.failed_steps,
    skipped_steps: log.skipped_steps,
    ai_analysis: log.ai_analysis,
    snapshot_diffs: log.snapshot_diffs,
  });
}

/** Map a controller MopExec record to our ControllerMopExecutionLog type */
function mapExecToLog(exec: Record<string, unknown>): ControllerMopExecutionLog {
  let analysis: Record<string, unknown> = {};
  if (typeof exec.ai_analysis === 'string') {
    try { analysis = JSON.parse(exec.ai_analysis); } catch { /* ignore */ }
  }
  return {
    id: exec.id as string,
    org_id: exec.org_id as string,
    mop_id: exec.plan_id as string | undefined,
    started_by: exec.started_by as string,
    name: exec.name as string,
    status: exec.status as string,
    control_mode: exec.control_mode as string,
    execution_strategy: exec.execution_strategy as string,
    device_results: (analysis.device_results as unknown[]) || [],
    step_results: (analysis.step_results as unknown[]) || [],
    ai_analysis: analysis.ai_analysis as Record<string, unknown> | undefined,
    snapshot_diffs: analysis.snapshot_diffs as Record<string, unknown> | undefined,
    total_steps: (analysis.total_steps as number) || 0,
    passed_steps: (analysis.passed_steps as number) || 0,
    failed_steps: (analysis.failed_steps as number) || 0,
    skipped_steps: (analysis.skipped_steps as number) || 0,
    started_at: (exec.started_at || exec.created_at) as string,
    completed_at: exec.completed_at as string | undefined,
    created_at: exec.created_at as string,
  };
}

/**
 * Push execution results to the controller for audit logging.
 * Creates a mop_executions record and updates it with results.
 */
export async function pushExecutionLog(
  mopId: string,
  log: ExecutionLogInput,
): Promise<ControllerMopExecutionLog> {
  const client = getClient();
  // 1. Create the execution record linked to the MOP plan
  const createRes = await client.http.post('/mop-executions', {
    plan_id: mopId,
    name: log.name,
    execution_strategy: log.execution_strategy,
    control_mode: log.control_mode,
  });
  const execId = createRes.data.id;

  // 2. Update with status, timing, and summary data
  const updateRes = await client.http.put(`/mop-executions/${execId}`, {
    status: log.status,
    started_at: log.started_at,
    completed_at: log.completed_at,
    ai_analysis: buildAnalysisPayload(log),
  });
  return mapExecToLog(updateRes.data);
}

/**
 * Update an existing execution log on the controller.
 */
export async function updateExecutionLog(
  logId: string,
  log: ExecutionLogInput,
): Promise<ControllerMopExecutionLog> {
  const client = getClient();
  const res = await client.http.put(`/mop-executions/${logId}`, {
    name: log.name,
    status: log.status,
    execution_strategy: log.execution_strategy,
    control_mode: log.control_mode,
    started_at: log.started_at,
    completed_at: log.completed_at,
    ai_analysis: buildAnalysisPayload(log),
  });
  return mapExecToLog(res.data);
}

/**
 * List execution logs from the controller.
 */
export async function listExecutionLogs(
  params?: { mop_id?: string; status?: string; limit?: number; offset?: number },
): Promise<ControllerExecLogSummary[]> {
  const client = getClient();
  const res = await client.http.get('/mop-executions', { params });
  const data = Array.isArray(res.data) ? res.data : [];
  return data.map(mapExecToSummary);
}

/**
 * List execution logs for a specific MOP.
 */
export async function listMopExecutionHistory(mopId: string): Promise<ControllerExecLogSummary[]> {
  const client = getClient();
  const res = await client.http.get('/mop-executions', { params: { mop_id: mopId } });
  const data = Array.isArray(res.data) ? res.data : [];
  return data.map(mapExecToSummary);
}

/** Map a controller MopExec record to summary type */
function mapExecToSummary(exec: Record<string, unknown>): ControllerExecLogSummary {
  let analysis: Record<string, unknown> = {};
  if (typeof exec.ai_analysis === 'string') {
    try { analysis = JSON.parse(exec.ai_analysis); } catch { /* ignore */ }
  }
  return {
    id: exec.id as string,
    mop_id: exec.plan_id as string | undefined,
    name: exec.name as string,
    status: exec.status as string,
    control_mode: exec.control_mode as string,
    total_steps: (analysis.total_steps as number) || 0,
    passed_steps: (analysis.passed_steps as number) || 0,
    failed_steps: (analysis.failed_steps as number) || 0,
    skipped_steps: (analysis.skipped_steps as number) || 0,
    started_at: (exec.started_at || exec.created_at) as string,
    completed_at: exec.completed_at as string | undefined,
  };
}
