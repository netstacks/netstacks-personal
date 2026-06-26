// API client for MOP Execution Wizard (Phase 30)

import { getClient, getCurrentMode } from './client';
import type {
  MopTemplate,
  NewMopTemplate,
  UpdateMopTemplate,
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

// === Template CRUD ===

export async function listMopTemplates(): Promise<MopTemplate[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const res = await getClient().http.get('/mop-templates');
  return res.data;
}

export async function getMopTemplate(id: string): Promise<MopTemplate> {
  if (getCurrentMode() === 'enterprise') throw new Error('MOP templates are not available in enterprise mode');
  const res = await getClient().http.get(`/mop-templates/${id}`);
  return res.data;
}

export async function createMopTemplate(template: NewMopTemplate): Promise<MopTemplate> {
  if (getCurrentMode() === 'enterprise') throw new Error('MOP templates are not available in enterprise mode');
  const res = await getClient().http.post('/mop-templates', template);
  return res.data;
}

export async function updateMopTemplate(id: string, update: UpdateMopTemplate): Promise<MopTemplate> {
  if (getCurrentMode() === 'enterprise') throw new Error('MOP templates are not available in enterprise mode');
  const res = await getClient().http.put(`/mop-templates/${id}`, update);
  return res.data;
}

export async function deleteMopTemplate(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('MOP templates are not available in enterprise mode');
  await getClient().http.delete(`/mop-templates/${id}`);
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

export async function rollbackExecutionDevice(executionId: string, deviceId: string): Promise<MopExecutionDevice> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/devices/${deviceId}/rollback`);
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

export async function executeStep(executionId: string, stepId: string): Promise<MopExecutionStep> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/steps/${stepId}/execute`);
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

export interface PhaseExecutionResult {
  device_id: string;
  step_type: string;
  steps_executed: number;
  steps_passed: number;
  steps_failed: number;
  snapshot_id: string | null;
  combined_output: string;
}

export interface ExecutePhaseRequest {
  step_type: 'pre_check' | 'change' | 'post_check' | 'rollback';
}

/**
 * Execute all steps of a specific phase (pre_check, change, post_check, rollback) for a device.
 * Captures snapshot after pre_check and post_check phases.
 */
export async function executeDevicePhase(
  executionId: string,
  deviceId: string,
  stepType: ExecutePhaseRequest['step_type']
): Promise<PhaseExecutionResult> {
  const res = await getClient().http.post(
    `/mop-executions/${executionId}/devices/${deviceId}/execute-phase`,
    { step_type: stepType },
    { timeout: 120000 }, // 2 min — SSH connection + multiple commands
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
}

export interface MopAiAnalysisResponse {
  analysis: string;
  risk_level: string;
  recommendations: string[];
  success: boolean;
}

/**
 * Get AI analysis of MOP execution results.
 * AI analyzes outputs and diffs to provide insights and recommendations.
 */
export async function analyzeMopExecution(
  executionId: string,
  options: MopAiAnalysisRequest = { include_outputs: true, include_diff: true }
): Promise<MopAiAnalysisResponse> {
  const res = await getClient().http.post(`/mop-executions/${executionId}/analyze`, options);
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
