// Pure helpers shared by MopWorkspace / MopExecuteTab / MopDevicesTab and
// covered by src/components/mop/__tests__/mopHelpers.test.ts. Nothing here
// touches React or the API client.

import type { MopStep, MopStepType } from '../../types/change';
import { createMopStep } from '../../types/change';
import type { MopExecution, MopExecutionDevice, MopExecutionStep, NewMopExecutionStep } from '../../types/mop';
import type { PhaseExecutionResult, MopAiAnalysisResponse } from '../../api/mop';
import { PHASE_STEP_TYPES, STEP_TYPE_ORDER, type PhaseStepType } from './constants';
import { resolveMopVariables, resolveScriptArgs } from '../../lib/mopVariables';

// ============================================================================
// Plan-step selection (the "current steps for the active device" ternary)
// ============================================================================

/** Steps the Plan tab is editing: the active device's override list when a
 *  per-device plan is in use, otherwise the base plan. */
export function stepsForActiveDevice(
  hasPerDeviceSteps: boolean,
  activeDevicePill: string | null,
  perDeviceSteps: Record<string, MopStep[]>,
  steps: MopStep[],
): MopStep[] {
  if (hasPerDeviceSteps && activeDevicePill) {
    return perDeviceSteps[activeDevicePill] || [];
  }
  return steps;
}

/** Highest `order` in a section (0 when empty) — the next new step gets +1. */
export function maxOrderInSection(steps: MopStep[], stepType: MopStepType): number {
  let max = 0;
  for (const s of steps) {
    if (s.step_type === stepType && s.order > max) max = s.order;
  }
  return max;
}

/** Build new plan steps for `commands` appended to a section. */
export function buildStepsForSection(
  existing: MopStep[],
  stepType: MopStepType,
  items: Array<{ command: string; description?: string }>,
): MopStep[] {
  let order = maxOrderInSection(existing, stepType);
  return items.map(item => createMopStep(stepType, item.command, ++order, item.description));
}

/** Non-mutating sort: section order first, then `order` within the section. */
export function sortPlanSteps(steps: MopStep[]): MopStep[] {
  return [...steps].sort((a, b) => {
    const typeDiff = (STEP_TYPE_ORDER[a.step_type] ?? 99) - (STEP_TYPE_ORDER[b.step_type] ?? 99);
    return typeDiff !== 0 ? typeDiff : a.order - b.order;
  });
}

// ============================================================================
// Device scope
// ============================================================================

/** Device-scope predicate: `specific` steps only run on their listed devices. */
export function stepAppliesToDevice(step: Pick<MopStep, 'device_scope' | 'device_ids'>, deviceId: string): boolean {
  if (step.device_scope !== 'specific') return true;
  return (step.device_ids || []).includes(deviceId);
}

/** How many of `selectedIds` a step will actually run on. */
export function scopedDeviceCount(step: Pick<MopStep, 'device_scope' | 'device_ids'>, selectedIds: Iterable<string>): number {
  let n = 0;
  for (const id of selectedIds) if (stepAppliesToDevice(step, id)) n++;
  return n;
}

export interface ExecutionStepBatch {
  /** Steps to POST for the device (execution_device_id is added by the API wrapper). */
  execSteps: Omit<NewMopExecutionStep, 'execution_device_id'>[];
  /** Plan step id at each index of `execSteps` — used to remap pairings after creation. */
  planIds: string[];
}

/** Clone plan steps for one execution device, honouring device scope. Pairings
 *  still carry the plan id here; call `remapPairedStepIds` once the agent has
 *  assigned execution ids. When `vars` (the device's resolved variable map)
 *  is given, `{{name}}` placeholders in the command, expected output,
 *  quick-action variables and script-arg strings are resolved; unknown
 *  placeholders are left verbatim (the agent re-resolves idempotently). */
export function buildExecutionStepsForDevice(planSteps: MopStep[], deviceId: string, vars?: Record<string, string>): ExecutionStepBatch {
  const scoped = sortPlanSteps(planSteps).filter(s => stepAppliesToDevice(s, deviceId));
  const planIds = scoped.map(s => s.id);
  const inBatch = new Set(planIds);
  const text = (value: string | undefined): string | undefined => (vars && value ? resolveMopVariables(value, vars) : value);
  const execSteps = scoped.map((step, idx) => ({
    step_order: idx,
    step_type: step.step_type,
    command: text(step.command) ?? '',
    description: step.description,
    expected_output: text(step.expected_output),
    mock_enabled: false,
    execution_source: step.execution_source,
    quick_action_id: step.quick_action_id,
    quick_action_variables: vars && step.quick_action_variables
      ? Object.fromEntries(Object.entries(step.quick_action_variables).map(([k, v]) => [k, resolveMopVariables(v, vars)]))
      : step.quick_action_variables,
    script_id: step.script_id,
    script_args: vars && step.script_args ? resolveScriptArgs(step.script_args, vars) : step.script_args,
    // A partner that is out of scope for this device cannot be paired here.
    paired_step_id: step.paired_step_id && inBatch.has(step.paired_step_id) ? step.paired_step_id : undefined,
    output_format: step.output_format,
  }));
  return { execSteps, planIds };
}

/** Rewrite `paired_step_id` from plan ids to the execution ids the agent
 *  returned. `created[i]` must correspond to `planIds[i]`. Unknown ids are
 *  left untouched so a pairing never silently disappears. */
export function remapPairedStepIds(created: MopExecutionStep[], planIds: string[]): MopExecutionStep[] {
  const planToExec = new Map<string, string>();
  planIds.forEach((planId, i) => {
    if (created[i]) planToExec.set(planId, created[i].id);
  });
  return created.map(step => {
    if (!step.paired_step_id) return step;
    const mapped = planToExec.get(step.paired_step_id);
    return mapped ? { ...step, paired_step_id: mapped } : step;
  });
}

// ============================================================================
// Pairing on the plan
// ============================================================================

/** Link two plan steps both ways. */
export function pairPlanSteps(steps: MopStep[], aId: string, bId: string): MopStep[] {
  return steps.map(s => {
    if (s.id === aId) return { ...s, paired_step_id: bId };
    if (s.id === bId) return { ...s, paired_step_id: aId };
    return s;
  });
}

/** Clear the link on `stepId` and on whichever step points back at it. Never removes a step. */
export function unpairPlanStep(steps: MopStep[], stepId: string): MopStep[] {
  const target = steps.find(s => s.id === stepId);
  const partnerId = target?.paired_step_id;
  return steps.map(s => {
    if (s.id === stepId || s.id === partnerId || s.paired_step_id === stepId) {
      if (!s.paired_step_id) return s;
      return { ...s, paired_step_id: undefined };
    }
    return s;
  });
}

/** Apply a partial update; when `paired_step_id` is part of the update the
 *  partner is kept in sync (set both ways, or cleared both ways). */
export function applyPlanStepUpdate(steps: MopStep[], stepId: string, updates: Partial<MopStep>): MopStep[] {
  let next = steps;
  if ('paired_step_id' in updates) {
    next = unpairPlanStep(next, stepId);
    if (updates.paired_step_id) next = pairPlanSteps(next, stepId, updates.paired_step_id);
    const rest = { ...updates };
    delete rest.paired_step_id;
    updates = rest;
  }
  if (Object.keys(updates).length === 0) return next;
  return next.map(s => (s.id === stepId ? { ...s, ...updates } : s));
}

/** Remove a step and clear the partner's dangling link. */
export function removePlanStep(steps: MopStep[], stepId: string): MopStep[] {
  return unpairPlanStep(steps, stepId).filter(s => s.id !== stepId);
}

/** Copy of a step for "Duplicate": keeps source/args/scope/format, never the
 *  pairing or any run-time result. Inserted right after the original and the
 *  section is renumbered. */
export function duplicatePlanStep(steps: MopStep[], stepId: string): MopStep[] {
  const step = steps.find(s => s.id === stepId);
  if (!step) return steps;
  const copy: MopStep = {
    ...createMopStep(step.step_type, step.command, step.order + 0.5, step.description, step.execution_source),
    expected_output: step.expected_output,
    quick_action_id: step.quick_action_id,
    quick_action_variables: step.quick_action_variables ? { ...step.quick_action_variables } : undefined,
    script_id: step.script_id,
    script_args: step.script_args ? { ...step.script_args } : undefined,
    deploy_metadata: step.deploy_metadata ? { ...step.deploy_metadata } : undefined,
    output_format: step.output_format,
    device_scope: step.device_scope,
    device_ids: step.device_ids ? [...step.device_ids] : undefined,
  };
  const withNew = [...steps, copy];
  const orderMap = new Map<string, number>();
  let order = 1;
  for (const s of sortPlanSteps(withNew.filter(s => s.step_type === step.step_type))) {
    orderMap.set(s.id, order++);
  }
  return withNew.map(s => (orderMap.has(s.id) ? { ...s, order: orderMap.get(s.id)! } : s));
}

// ============================================================================
// Execution-side predicates
// ============================================================================

const DONE_STATUSES = new Set(['passed', 'skipped', 'mocked']);

export function isStepDone(step: Pick<MopExecutionStep, 'status'>): boolean {
  return DONE_STATUSES.has(step.status);
}

/** Devices that a phase still has work on: not skipped, with at least one
 *  pending step of that type. */
export function devicesEligibleForPhase(
  devices: MopExecutionDevice[],
  stepsByDevice: Record<string, MopExecutionStep[]>,
  stepType: MopStepType,
): MopExecutionDevice[] {
  return devices.filter(d =>
    d.status !== 'skipped' &&
    (stepsByDevice[d.id] || []).some(s => s.step_type === stepType && s.status === 'pending'),
  );
}

/** True when the phase before `stepType` still has pending steps on any
 *  non-skipped device — the phase buttons use this to enforce order. */
export function previousPhaseIncomplete(
  devices: MopExecutionDevice[],
  stepsByDevice: Record<string, MopExecutionStep[]>,
  stepType: PhaseStepType,
): boolean {
  const idx = PHASE_STEP_TYPES.indexOf(stepType);
  if (idx <= 0) return false;
  for (let i = 0; i < idx; i++) {
    if (devicesEligibleForPhase(devices, stepsByDevice, PHASE_STEP_TYPES[i]).length > 0) return true;
  }
  return false;
}

export interface NextPendingStep {
  device: MopExecutionDevice;
  step: MopExecutionStep;
}

/** Next runnable step in manual mode: device order, then phase order, then
 *  step_order. Rollback steps and skipped devices are never auto-selected.
 *  When `preferredDeviceId` is given that device is searched first. */
export function findNextPendingStep(
  devices: MopExecutionDevice[],
  stepsByDevice: Record<string, MopExecutionStep[]>,
  preferredDeviceId?: string | null,
): NextPendingStep | null {
  const ordered = [...devices].sort((a, b) => a.device_order - b.device_order);
  if (preferredDeviceId) {
    const prefIdx = ordered.findIndex(d => d.id === preferredDeviceId);
    if (prefIdx > 0) {
      const [pref] = ordered.splice(prefIdx, 1);
      ordered.unshift(pref);
    }
  }
  for (const device of ordered) {
    if (device.status === 'skipped') continue;
    const candidates = (stepsByDevice[device.id] || [])
      .filter(s => s.status === 'pending' && s.step_type !== 'rollback')
      .sort((a, b) => {
        const typeDiff = (STEP_TYPE_ORDER[a.step_type] ?? 99) - (STEP_TYPE_ORDER[b.step_type] ?? 99);
        return typeDiff !== 0 ? typeDiff : a.step_order - b.step_order;
      });
    if (candidates.length > 0) return { device, step: candidates[0] };
  }
  return null;
}

/** Pending steps of one phase on one device, in step order. */
export function pendingStepsInPhase(steps: MopExecutionStep[], stepType: MopStepType): MopExecutionStep[] {
  return steps
    .filter(s => s.step_type === stepType && s.status === 'pending')
    .sort((a, b) => a.step_order - b.step_order);
}

/** The "same" step on other devices: same type + command (device clones share
 *  both). Returns pending matches only, excluding the source step. */
export function matchingStepsOnOtherDevices(
  source: MopExecutionStep,
  devices: MopExecutionDevice[],
  stepsByDevice: Record<string, MopExecutionStep[]>,
): MopExecutionStep[] {
  const out: MopExecutionStep[] = [];
  for (const device of devices) {
    if (device.id === source.execution_device_id || device.status === 'skipped') continue;
    const match = (stepsByDevice[device.id] || []).find(s =>
      s.id !== source.id && s.step_type === source.step_type && s.command === source.command && s.status === 'pending',
    );
    if (match) out.push(match);
  }
  return out;
}

/** Human-readable notes for a phase result (skips, early stop, save errors). */
export function phaseResultNotes(result: PhaseExecutionResult): string[] {
  const notes: string[] = [];
  if (result.steps_failed > 0) notes.push(`${result.steps_failed} failed`);
  if (result.steps_skipped > 0) notes.push(`${result.steps_skipped} skipped`);
  if (result.stopped_early) notes.push('stopped early');
  if (result.post_command_error) notes.push(`config save failed: ${result.post_command_error}`);
  return notes;
}

/** Per-device pass/fail summary used by device headers. */
export function deviceStepSummary(steps: MopExecutionStep[]): { passed: number; failed: number; total: number; label: string } {
  const passed = steps.filter(s => s.status === 'passed' || s.status === 'mocked').length;
  const failed = steps.filter(s => s.status === 'failed').length;
  const total = steps.length;
  return { passed, failed, total, label: `${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}` };
}

// ============================================================================
// Expected-output assertions (grammar mirrored by the agent's evaluate_assertions)
// ============================================================================

export type AssertionType = 'CONTAINS' | 'NOT_CONTAINS' | 'REGEX' | 'TEXT';
export interface Assertion {
  type: AssertionType;
  value: string;
  line: number; // line index in the expected_output string
}

export function parseAssertions(expectedOutput: string): Assertion[] {
  if (!expectedOutput) return [];
  return expectedOutput.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('CONTAINS:')) return { type: 'CONTAINS' as const, value: trimmed.slice(9).trim(), line: i };
    if (trimmed.startsWith('NOT_CONTAINS:')) return { type: 'NOT_CONTAINS' as const, value: trimmed.slice(13).trim(), line: i };
    if (trimmed.startsWith('REGEX:')) return { type: 'REGEX' as const, value: trimmed.slice(6).trim(), line: i };
    if (!trimmed) return null;
    return { type: 'TEXT' as const, value: trimmed, line: i };
  }).filter((a): a is Assertion => a !== null);
}

export function hasStructuredAssertions(expectedOutput: string | undefined): boolean {
  if (!expectedOutput) return false;
  return expectedOutput.split('\n').some(line => {
    const t = line.trim();
    return t.startsWith('CONTAINS:') || t.startsWith('NOT_CONTAINS:') || t.startsWith('REGEX:');
  });
}

// ============================================================================
// AI analysis (Review tab)
// ============================================================================

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical', 'unknown']);

/** Fill in the provenance fields older agents omit and sanitise the shape. */
export function normalizeAnalysisResponse(res: Partial<MopAiAnalysisResponse> & Pick<MopAiAnalysisResponse, 'analysis'>): MopAiAnalysisResponse {
  // The agent emits lowercase (low|medium|high|critical|unknown); tolerate any case.
  const riskRaw = typeof res.risk_level === 'string' ? res.risk_level.trim().toLowerCase() : '';
  const risk = RISK_LEVELS.has(riskRaw) ? riskRaw : 'unknown';
  return {
    execution_id: res.execution_id,
    analysis: typeof res.analysis === 'string' ? res.analysis : '',
    risk_level: risk,
    recommendations: Array.isArray(res.recommendations) ? res.recommendations.filter((r): r is string => typeof r === 'string') : [],
    source: res.source === 'rules' ? 'rules' : 'ai',
    model: typeof res.model === 'string' ? res.model : null,
    warnings: Array.isArray(res.warnings) ? res.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}

/** Stored analysis of a (re)opened execution, or null when it has none. */
export function analysisFromExecution(execution: Pick<MopExecution, 'id' | 'ai_analysis' | 'ai_analysis_meta'>): MopAiAnalysisResponse | null {
  if (!execution.ai_analysis?.trim()) return null;
  const meta = execution.ai_analysis_meta;
  return normalizeAnalysisResponse({
    execution_id: execution.id,
    analysis: execution.ai_analysis,
    risk_level: meta?.risk_level,
    recommendations: meta?.recommendations,
    source: meta?.source,
    model: meta?.model,
    warnings: ['cached'],
  });
}
