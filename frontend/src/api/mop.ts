// API client for MOP executions (Phase 30)

import { getClient } from './client';
import type {
  MopExecution,
  NewMopExecution,
  UpdateMopExecution,
  MopExecutionDevice,
  NewMopExecutionDevice,
  MopExecutionStep,
  NewMopExecutionStep,
  MockConfig,
  StepOutputUpdate,
  CompleteExecutionRequest,
} from '../types/mop';
import type { StepDiff } from '../types/change';
import { getErrorMessage, parseApiError } from './errors';

// === Error helpers ===

/** Agent error codes the MOP UI handles specially (all 409). */
export const MOP_CONFLICT_CODES = ['INVALID_STATE', 'PHASE_IN_PROGRESS', 'CONFLICT'] as const;

/** True for a 409 state-machine / concurrency rejection from the agent. */
export function isMopConflictError(err: unknown): boolean {
  const { status, code } = parseApiError(err);
  return status === 409 || (!!code && (MOP_CONFLICT_CODES as readonly string[]).includes(code));
}

/**
 * User-facing message for a MOP API failure. 409 INVALID_STATE /
 * PHASE_IN_PROGRESS get a stable explanation so the UI can show a banner
 * instead of a bare "Request failed with status code 409".
 */
export function getMopErrorMessage(err: unknown, fallback: string): string {
  const { code, error } = parseApiError(err);
  if (code === 'PHASE_IN_PROGRESS') {
    return error ? `A phase is already running on this device — ${error}` : 'A phase is already running on this device. Wait for it to finish.';
  }
  if (code === 'INVALID_STATE') {
    return error ? `Not allowed in the execution's current state — ${error}` : "Not allowed in the execution's current state.";
  }
  return getErrorMessage(err, fallback);
}

/** Per-step command timeout accepted by execute-phase / execute-step / rollback (agent default 60, max 600). */
export interface MopStepTimeoutOptions {
  timeoutSecs?: number;
}

// The agent blocks for the whole phase (one SSH batch per device). Give it
// room for a full 600 s step timeout plus connection setup.
const PHASE_HTTP_TIMEOUT_MS = 11 * 60 * 1000;
/** `/analyze` waits on one model round-trip; give it room past the default client timeout. */
const ANALYZE_HTTP_TIMEOUT_MS = 3 * 60 * 1000;
const STEP_HTTP_TIMEOUT_MS = 11 * 60 * 1000;

function timeoutBody(opts?: MopStepTimeoutOptions): { timeout_secs?: number } {
  return opts?.timeoutSecs != null ? { timeout_secs: opts.timeoutSecs } : {};
}

// === Execution CRUD ===

export async function listMopExecutions(): Promise<MopExecution[]> {
  const res = await getClient().http.get('/mop-executions');
  return res.data;
}

export async function getMopExecution(id: string): Promise<MopExecution> {
  const res = await getClient().http.get(`/mop-executions/${id}`);
  return res.data;
}

export async function createMopExecution(exec: NewMopExecution): Promise<MopExecution> {
  const res = await getClient().http.post('/mop-executions', exec);
  return res.data;
}

export async function updateMopExecution(id: string, update: UpdateMopExecution): Promise<MopExecution> {
  const res = await getClient().http.put(`/mop-executions/${id}`, update);
  return res.data;
}

export async function deleteMopExecution(id: string): Promise<void> {
  await getClient().http.delete(`/mop-executions/${id}`);
}

// === Execution Control ===

export async function startMopExecution(id: string): Promise<MopExecution> {
  const res = await getClient().http.post(`/mop-executions/${id}/start`);
  return res.data;
}

export async function pauseMopExecution(id: string): Promise<MopExecution> {
  const res = await getClient().http.post(`/mop-executions/${id}/pause`);
  return res.data;
}

export async function resumeMopExecution(id: string): Promise<MopExecution> {
  const res = await getClient().http.post(`/mop-executions/${id}/resume`);
  return res.data;
}

export async function abortMopExecution(id: string): Promise<MopExecution> {
  const res = await getClient().http.post(`/mop-executions/${id}/abort`);
  return res.data;
}

export async function completeMopExecution(id: string, req?: CompleteExecutionRequest): Promise<MopExecution> {
  const res = await getClient().http.post(`/mop-executions/${id}/complete`, req || {});
  return res.data;
}

// === Device Operations ===

export async function listExecutionDevices(executionId: string): Promise<MopExecutionDevice[]> {
  const res = await getClient().http.get(`/mop-executions/${executionId}/devices`);
  return res.data;
}

export async function addExecutionDevice(executionId: string, device: Omit<NewMopExecutionDevice, 'execution_id'>): Promise<MopExecutionDevice> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/devices`, { ...device, execution_id: executionId });
  return res.data;
}

export async function skipExecutionDevice(executionId: string, deviceId: string): Promise<MopExecutionDevice> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/devices/${deviceId}/skip`);
  return res.data;
}

export async function retryExecutionDevice(executionId: string, deviceId: string): Promise<MopExecutionDevice> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/devices/${deviceId}/retry`);
  return res.data;
}

/**
 * Run the device's rollback steps (same wrapper/batching as execute-phase).
 * Allowed while the execution is running, paused or finished
 * (complete/failed/aborted); 409 INVALID_STATE for pending ones.
 */
export async function rollbackExecutionDevice(
  executionId: string,
  deviceId: string,
  opts?: MopStepTimeoutOptions,
): Promise<PhaseExecutionResult> {
  const res = await getClient().http.post(
    `/mop-executions/${executionId}/devices/${deviceId}/rollback`,
    timeoutBody(opts),
    { timeout: PHASE_HTTP_TIMEOUT_MS },
  );
  return res.data;
}

// === Step Operations ===

export async function listExecutionSteps(executionId: string, deviceId: string): Promise<MopExecutionStep[]> {
  const res = await getClient().http.get(`/mop-executions/${executionId}/devices/${deviceId}/steps`);
  return res.data;
}

export async function addExecutionSteps(
  executionId: string,
  deviceId: string,
  steps: Omit<NewMopExecutionStep, 'execution_device_id'>[]
): Promise<MopExecutionStep[]> {
  const stepsWithDeviceId = steps.map(s => ({ ...s, execution_device_id: deviceId }));
  const res = await getClient().http.post(`/mop-executions/${executionId}/devices/${deviceId}/steps`, stepsWithDeviceId);
  return res.data;
}

export async function executeStep(executionId: string, stepId: string, opts?: MopStepTimeoutOptions): Promise<MopExecutionStep> {
  const res = await getClient().http.post(
    `/mop-executions/${executionId}/steps/${stepId}/execute`,
    timeoutBody(opts),
    { timeout: STEP_HTTP_TIMEOUT_MS },
  );
  return res.data;
}

export async function approveStep(executionId: string, stepId: string): Promise<MopExecutionStep> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/steps/${stepId}/approve`);
  return res.data;
}

export async function skipStep(executionId: string, stepId: string): Promise<MopExecutionStep> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/steps/${stepId}/skip`);
  return res.data;
}

export async function updateStepMock(executionId: string, stepId: string, mock: MockConfig): Promise<MopExecutionStep> {
  const res = await getClient().http.put(`/mop-executions/${executionId}/steps/${stepId}/mock`, mock);
  return res.data;
}

export async function updateStepOutput(executionId: string, stepId: string, output: StepOutputUpdate): Promise<MopExecutionStep> {
  const res = await getClient().http.put(`/mop-executions/${executionId}/steps/${stepId}/output`, output);
  return res.data;
}

/**
 * Persist an inline edit of a step's command before the step runs.
 *
 * The execute path re-reads the step row at execution time, so once
 * this returns the new command is what will actually be sent to the
 * device. Returns the updated step (mirrors updateStepMock / updateStepOutput).
 */
export async function updateStepCommand(executionId: string, stepId: string, command: string): Promise<MopExecutionStep> {
  const res = await getClient().http.put(`/mop-executions/${executionId}/steps/${stepId}/command`, { command });
  return res.data;
}

// === Phase Execution ===

export type PhaseStepTypeName = 'pre_check' | 'change' | 'post_check' | 'rollback' | 'api_action';

export interface PhaseExecutionResult {
  device_id: string;
  step_type: PhaseStepTypeName;
  steps_executed: number;
  steps_passed: number;
  steps_failed: number;
  steps_skipped: number;
  snapshot_id: string | null;
  combined_output: string;
  /** A step timed out / failed and the rest of the phase was not sent. */
  stopped_early: boolean;
  /** commit / write memory failed after the steps ran (last step is marked failed). */
  post_command_error: string | null;
}

export interface ExecutePhaseRequest {
  step_type: 'pre_check' | 'change' | 'post_check' | 'rollback';
  timeout_secs?: number;
}

/**
 * Execute all steps of a specific phase (pre_check, change, post_check, rollback) for a device.
 * Captures snapshot after pre_check and post_check phases.
 * Requires a running execution and a non-skipped device (409 otherwise);
 * a second call for a device with a phase in flight is rejected with
 * 409 PHASE_IN_PROGRESS.
 */
export async function executeDevicePhase(
  executionId: string,
  deviceId: string,
  stepType: ExecutePhaseRequest['step_type'],
  opts?: MopStepTimeoutOptions,
): Promise<PhaseExecutionResult> {
  const body: ExecutePhaseRequest = { step_type: stepType, ...timeoutBody(opts) };
  const res = await getClient().http.post(
    `/mop-executions/${executionId}/devices/${deviceId}/execute-phase`,
    body,
    { timeout: PHASE_HTTP_TIMEOUT_MS },
  );
  return res.data;
}

// === Snapshot Diff ===

export interface SnapshotDiff {
  pre_snapshot_id: string | null;
  post_snapshot_id: string | null;
  lines_added: string[];
  lines_removed: string[];
  has_changes: boolean;
  summary?: { changed: number; added: number; removed: number };
}

/**
 * Get the diff between pre and post snapshots for a device.
 */
export async function getDeviceSnapshotDiff(executionId: string, deviceId: string): Promise<SnapshotDiff> {
  const res = await getClient().http.get(`/mop-executions/${executionId}/devices/${deviceId}/diff`);
  return res.data;
}

// === AI Analysis ===

export interface MopAiAnalysisRequest {
  include_outputs: boolean;
  include_diff: boolean;
  /** Re-run the model even when a stored AI analysis exists (default false → cached). */
  force?: boolean;
}

export type MopAiAnalysisSource = 'ai' | 'rules';

export interface MopAiAnalysisResponse {
  execution_id?: string;
  analysis: string;
  risk_level: string;
  recommendations: string[];
  /** 'ai' = model output, 'rules' = the agent's rule-based fallback. Older agents omit it. */
  source?: MopAiAnalysisSource;
  /** Provider/model id when `source === 'ai'`. */
  model?: string | null;
  /** "cached", "AI provider not configured", provider errors, … */
  warnings?: string[];
}

/**
 * AI review of a finished execution. The agent builds the context from the
 * DB, calls the configured provider and falls back to a rule-based summary
 * (`source: 'rules'` + a warning) when the AI is unavailable. Without
 * `force` a stored AI analysis is returned as-is (`warnings: ['cached']`).
 */
export async function analyzeMopExecution(
  executionId: string,
  options: MopAiAnalysisRequest = { include_outputs: true, include_diff: true },
): Promise<MopAiAnalysisResponse> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/analyze`, options, { timeout: ANALYZE_HTTP_TIMEOUT_MS });
  return res.data;
}

// === Step Diff ===

/**
 * Compute a diff between two text outputs (pre-check vs post-check).
 * Supports both JSON and plain text formats.
 */
export async function computeStepDiff(a: string, b: string, format: 'json' | 'text'): Promise<StepDiff> {
  const res = await getClient().http.post('/mop/diff', { a, b, format });
  return res.data;
}
