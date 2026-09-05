// One context builder for every MOP AI call.
//
// Every AI action in the MOP workspace (suggest / review / parse / analyse /
// explain / pilot) used to hand-roll its own prompt from a subset of the
// workspace state, so none of them knew the target platform, the expected
// outputs, the per-device overrides or the execution results. This module
// renders the whole plan (and the execution, when there is one) into one
// text block that is prepended to every prompt, plus the structured
// `AiContext` the agent enriches server-side (`build_system_prompt`).
//
// Pure: no React, no network. Unit-tested in `lib/__tests__/mopAiContext.test.ts`.

import type { AiContext } from '../api/ai';
import type { CliFlavor } from '../types/enrichment';
import type { MopStep, MopStepType, MopVariable } from '../types/change';
import type { MopExecution, MopExecutionDevice, MopExecutionStep } from '../types/mop';
import type { MopLiveSummary } from './aiLiveContext';
import { CLI_FLAVOR_META } from './cliFlavorMeta';

// ============================================================================
// Inputs
// ============================================================================

/** A plan target: a session (personal mode) or an inventory device. */
export interface MopAiDevice {
  id: string;
  name: string;
  host?: string;
  /** Session.cli_flavor / MopExecutionDevice.cli_flavor (kebab string, may be 'auto'). */
  cliFlavor?: string | null;
}

/** Snapshot diff as returned by `GET …/devices/:d/diff` (only the fields the block uses). */
export interface MopAiDeviceDiff {
  lines_added: string[];
  lines_removed: string[];
  has_changes: boolean;
}

export interface MopAiExecutionInput {
  execution: Pick<MopExecution, 'id' | 'status'> & Partial<Pick<MopExecution, 'control_mode' | 'execution_strategy' | 'on_failure'>>;
  devices: MopExecutionDevice[];
  stepsByDevice: Record<string, MopExecutionStep[]>;
  /** Keyed by execution device id. */
  diffs?: Record<string, MopAiDeviceDiff>;
}

export interface MopAiContextInput {
  name: string;
  description?: string;
  riskLevel?: string | null;
  changeTicket?: string | null;
  tags?: string[];
  /** Base steps (all sections). */
  steps: MopStep[];
  /** Per-device step lists keyed by device/session id (stack templates). */
  deviceOverrides?: Record<string, MopStep[]>;
  devices: MopAiDevice[];
  /** Config-template variables ({{name}} → value) when a template source is active. */
  variables?: Record<string, string>;
  /** Declared plan variables (P1-11): name / default / required / description. */
  planVariables?: MopVariable[];
  /** Resolved `{{name}}` map per plan device id (`deviceVariableMap`), rendered for in-scope devices. */
  deviceVariableMaps?: Record<string, Record<string, string>>;
  execution?: MopAiExecutionInput | null;
  /** Overrides the derived "MOP: <name>" session name in the AiContext. */
  sessionName?: string;
}

export interface MopAiContextOptions {
  /** Max chars of each step output kept (the tail). Default 4 kB. */
  stepOutputTailChars?: number;
  /** Max chars of step output across the whole block. Default 32 kB. */
  totalOutputChars?: number;
  /** Max diff lines (added + removed) rendered per device. Default 20. */
  diffLines?: number;
  /** Render the execution section when one is present. Default true. */
  includeExecution?: boolean;
  /** Render step outputs (false → status/assertions/errors only). Default true. */
  includeOutputs?: boolean;
}

export interface MopAiContextResult {
  /** Markdown-ish text block to prepend to the user prompt. */
  block: string;
  /** Structured context for `POST /ai/chat` (`context`). */
  aiContext: AiContext;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_STEP_OUTPUT_TAIL_CHARS = 4096;
export const DEFAULT_TOTAL_OUTPUT_CHARS = 32768;
export const DEFAULT_DIFF_LINES = 20;

const SECTION_LABELS: Array<{ type: MopStepType; label: string; noun: string }> = [
  { type: 'pre_check', label: 'Pre-checks', noun: 'pre-check' },
  { type: 'change', label: 'Changes', noun: 'change' },
  { type: 'post_check', label: 'Post-checks', noun: 'post-check' },
  { type: 'rollback', label: 'Rollback', noun: 'rollback' },
  { type: 'api_action', label: 'API actions', noun: 'API action' },
];

/**
 * The expected_output grammar the executor evaluates (agent
 * `evaluate_assertions`). Handed to the model whenever it is asked to write
 * an expected output so it produces something the executor can actually
 * check instead of prose.
 */
export const MOP_ASSERTION_GRAMMAR = `Expected-output grammar (one assertion per line, evaluated by the executor after the command runs):
CONTAINS: <text>        — output must contain the text (case-sensitive)
NOT_CONTAINS: <text>    — output must not contain the text
REGEX: <pattern>        — a Rust/RE2-style regex must match somewhere in the output
Any other non-empty line is treated as reference text: reported, but it never fails the step.
Use one to three lines. Do not add prose, markdown or explanations.`;

// ============================================================================
// Helpers
// ============================================================================

/** "Cisco IOS-XR", "Juniper Junos", "Linux" — null for 'auto' / unknown. */
export function flavorDisplayName(flavor: string | null | undefined): string | null {
  if (!flavor || flavor === 'auto') return null;
  const meta = CLI_FLAVOR_META[flavor as CliFlavor];
  if (!meta) return flavor;
  return meta.vendor ? `${meta.vendor} ${meta.platform}` : meta.platform;
}

/** Distinct CLI flavors (excluding 'auto'/unknown) in first-seen order. */
export function distinctFlavors(devices: Array<{ cliFlavor?: string | null }>): string[] {
  const seen: string[] = [];
  for (const d of devices) {
    const f = d.cliFlavor;
    if (!f || f === 'auto' || seen.includes(f)) continue;
    seen.push(f);
  }
  return seen;
}

/**
 * Platform fields for `AiContext` when every device shares one flavor. Mixed
 * fleets get no platform (the block already lists each device's platform).
 */
export function derivePlatformContext(devices: Array<{ cliFlavor?: string | null }>): Pick<AiContext, 'cliFlavor' | 'terminal'> {
  const flavors = distinctFlavors(devices);
  if (flavors.length !== 1) return {};
  const flavor = flavors[0] as CliFlavor;
  const meta = CLI_FLAVOR_META[flavor];
  const ctx: Pick<AiContext, 'cliFlavor' | 'terminal'> = { cliFlavor: flavor };
  if (meta) ctx.terminal = { detectedVendor: meta.vendor, detectedPlatform: meta.platform };
  return ctx;
}

/** Keep the last `max` chars of `text`, prefixed with a truncation note. */
export function tailText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…[truncated: showing last ${max} of ${text.length} chars]\n${text.slice(-max)}`;
}

/**
 * Cap the total step output per device at `maxPerDevice` chars (tails are
 * kept, split evenly across the steps that have output). Used before a
 * generated document goes to the AI so one long "show run" cannot blow the
 * provider's output limit. Returns the capped copy and the device names
 * that were truncated.
 */
export function capDeviceOutputs<T extends { name: string; steps: Array<{ output?: string }> }>(
  devices: T[],
  maxPerDevice: number,
): { devices: T[]; truncated: string[] } {
  const truncated: string[] = [];
  const capped = devices.map(device => {
    const withOutput = device.steps.filter(s => s.output);
    const total = withOutput.reduce((n, s) => n + (s.output?.length ?? 0), 0);
    if (total <= maxPerDevice || withOutput.length === 0) return device;
    truncated.push(device.name);
    const perStep = Math.max(200, Math.floor(maxPerDevice / withOutput.length));
    return {
      ...device,
      steps: device.steps.map(s => (s.output && s.output.length > perStep ? { ...s, output: tailText(s.output, perStep) } : s)),
    };
  });
  return { devices: capped, truncated };
}

function oneLine(text: string, max = 200): string {
  const flat = text.split('\n').map(l => l.trim()).filter(Boolean).join(' | ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function deviceLabel(d: MopAiDevice): string {
  const platform = flavorDisplayName(d.cliFlavor);
  return `${d.name}${d.host ? ` (${d.host})` : ''}${platform ? ` — ${platform}` : ''}`;
}

function renderPlanStep(step: MopStep, index: number, deviceNames: Map<string, string>): string {
  const parts = [`  ${index + 1}. ${step.command || '(empty command)'}`];
  if (step.description) parts.push(` — ${step.description}`);
  if (step.expected_output) parts.push(` [expect: ${oneLine(step.expected_output)}]`);
  if (step.execution_source && step.execution_source !== 'cli') parts.push(` [source: ${step.execution_source}]`);
  if (step.device_scope === 'specific' && step.device_ids?.length) {
    parts.push(` [devices: ${step.device_ids.map(id => deviceNames.get(id) || id).join(', ')}]`);
  }
  return parts.join('');
}

function renderSections(steps: MopStep[], deviceNames: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const { type, label } of SECTION_LABELS) {
    const section = steps.filter(s => s.step_type === type).sort((a, b) => a.order - b.order);
    if (type === 'api_action' && section.length === 0) continue;
    lines.push(`### ${label} (${section.length})`);
    if (section.length === 0) lines.push('  (none)');
    section.forEach((s, i) => lines.push(renderPlanStep(s, i, deviceNames)));
  }
  return lines;
}

/**
 * "sw1 has 3 change steps that differ, 1 post-check step dropped" per
 * overridden device: steps whose command is not in the base section, and
 * base commands the device list no longer carries.
 */
export function summariseOverrides(
  base: MopStep[],
  overrides: Record<string, MopStep[]> | undefined,
  deviceNames: Map<string, string>,
): string[] {
  if (!overrides) return [];
  const out: string[] = [];
  for (const [deviceId, deviceSteps] of Object.entries(overrides)) {
    if (!deviceSteps?.length) continue;
    const name = deviceNames.get(deviceId) || deviceId;
    const perSection: string[] = [];
    for (const { type, noun } of SECTION_LABELS) {
      const baseCmds = new Set(base.filter(s => s.step_type === type).map(s => s.command.trim()));
      const differing = deviceSteps.filter(s => s.step_type === type && !baseCmds.has(s.command.trim())).length;
      const missing = [...baseCmds].filter(c => !deviceSteps.some(s => s.step_type === type && s.command.trim() === c)).length;
      if (differing > 0) perSection.push(`${differing} ${noun} step${differing !== 1 ? 's' : ''} that differ`);
      else if (missing > 0) perSection.push(`${missing} ${noun} step${missing !== 1 ? 's' : ''} dropped`);
    }
    if (perSection.length) out.push(`${name} has ${perSection.join(', ')}`);
  }
  return out;
}

/**
 * Declared plan variables as a table, then each in-scope device's resolved
 * values for those names (so the model can reason per device). The
 * `device.*` built-ins are described once rather than listed per device.
 */
function renderPlanVariables(
  variables: MopVariable[] | undefined,
  maps: Record<string, Record<string, string>> | undefined,
  devices: MopAiDevice[],
): string[] {
  const declared = (variables || []).filter(v => v.name.trim());
  if (!declared.length) return [];
  const lines = [`### Variables (${declared.length}) — steps reference them as {{name}}; {{device.host}}, {{device.name}}, {{device.type}} are built in`];
  for (const v of declared) {
    const parts = [`  {{${v.name}}} = ${v.value ? JSON.stringify(v.value) : '(empty)'}`];
    if (v.required) parts.push(' [required]');
    if (v.description) parts.push(` — ${v.description}`);
    lines.push(parts.join(''));
  }
  if (maps) {
    for (const d of devices) {
      const map = maps[d.id];
      if (!map) continue;
      const values = declared.map(v => `${v.name}=${map[v.name] ? JSON.stringify(map[v.name]) : '(empty)'}`);
      lines.push(`  ${d.name}: ${values.join(', ')}`);
    }
  }
  return lines;
}

interface OutputBudget {
  remaining: number;
  perStep: number;
}

function renderStepOutput(step: MopExecutionStep, budget: OutputBudget): string | null {
  const output = step.output ?? '';
  if (!output.trim()) return null;
  if (budget.remaining <= 0) return 'output: (omitted — context budget exhausted)';
  const cap = Math.min(budget.perStep, budget.remaining);
  const text = tailText(output, cap);
  budget.remaining -= Math.min(output.length, cap);
  const label = output.length > cap ? `output (tail, ${cap} of ${output.length} chars)` : 'output';
  return `${label}:\n${indent(text, '      ')}`;
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(l => prefix + l).join('\n');
}

function renderExecutionStep(step: MopExecutionStep, budget: OutputBudget, includeOutputs: boolean): string[] {
  const status = step.status.toUpperCase();
  const mocked = step.status === 'mocked' || step.mock_enabled ? ' (mocked)' : '';
  const duration = step.duration_ms != null ? ` ${step.duration_ms} ms` : '';
  const source = step.execution_source && step.execution_source !== 'cli' ? ` [source: ${step.execution_source}]` : '';
  const lines = [`  [${step.step_type}] ${step.command} — ${status}${mocked}${duration}${source}`];
  if (step.expected_output) lines.push(`    expected: ${oneLine(step.expected_output)}`);
  if (includeOutputs) {
    const out = renderStepOutput(step, budget);
    if (out) lines.push(`    ${out}`);
  }
  if (step.assertion_results?.length) {
    const results = step.assertion_results
      .map(a => `${a.assertion} ${a.passed ? 'PASS' : 'FAIL'}${a.detail ? ` (${a.detail})` : ''}`)
      .join('; ');
    lines.push(`    assertions: ${results}`);
  }
  if (step.error_message) lines.push(`    error: ${step.error_message}`);
  if (step.ai_feedback) lines.push(`    ai_feedback: ${oneLine(step.ai_feedback, 300)}`);
  return lines;
}

function renderDiff(diff: MopAiDeviceDiff | undefined, maxLines: number): string[] {
  if (!diff) return [];
  if (!diff.has_changes) return ['  config diff: no changes'];
  const lines = [`  config diff: +${diff.lines_added.length} / −${diff.lines_removed.length} lines`];
  const shown: string[] = [];
  for (const l of diff.lines_removed) {
    if (shown.length >= maxLines) break;
    shown.push(`    - ${l}`);
  }
  for (const l of diff.lines_added) {
    if (shown.length >= maxLines) break;
    shown.push(`    + ${l}`);
  }
  lines.push(...shown);
  const total = diff.lines_added.length + diff.lines_removed.length;
  if (total > shown.length) lines.push(`    … ${total - shown.length} more diff lines`);
  return lines;
}

function executionProgress(devices: MopExecutionDevice[], stepsByDevice: Record<string, MopExecutionStep[]>): { passed: number; failed: number; total: number } {
  let passed = 0, failed = 0, total = 0;
  for (const d of devices) {
    for (const s of stepsByDevice[d.id] || []) {
      if (s.step_type === 'rollback') continue;
      total += 1;
      if (s.status === 'passed' || s.status === 'mocked') passed += 1;
      else if (s.status === 'failed') failed += 1;
    }
  }
  return { passed, failed, total };
}

function renderExecution(exec: MopAiExecutionInput, opts: Required<MopAiContextOptions>): string[] {
  const { passed, failed, total } = executionProgress(exec.devices, exec.stepsByDevice);
  const anyMocked = exec.devices.some(d => (exec.stepsByDevice[d.id] || []).some(s => s.status === 'mocked' || s.mock_enabled));
  const header = `### Execution (${exec.execution.status}, ${passed}/${total} passed${failed ? `, ${failed} failed` : ''}${anyMocked ? ', contains mocked steps' : ''})`;
  const lines = [header];
  const meta: string[] = [];
  if (exec.execution.control_mode) meta.push(`mode: ${exec.execution.control_mode}`);
  if (exec.execution.execution_strategy) meta.push(`strategy: ${exec.execution.execution_strategy}`);
  if (exec.execution.on_failure) meta.push(`on failure: ${exec.execution.on_failure}`);
  if (meta.length) lines.push(`  ${meta.join(' | ')}`);

  const budget: OutputBudget = { remaining: opts.totalOutputChars, perStep: opts.stepOutputTailChars };
  const devices = [...exec.devices].sort((a, b) => a.device_order - b.device_order);
  for (const device of devices) {
    const platform = flavorDisplayName(device.cli_flavor);
    lines.push(`Device ${device.device_name}${device.device_host ? ` (${device.device_host})` : ''}${platform ? ` — ${platform}` : ''} — ${device.status}${device.error_message ? ` (${device.error_message})` : ''}`);
    const steps = [...(exec.stepsByDevice[device.id] || [])].sort((a, b) => a.step_order - b.step_order);
    if (steps.length === 0) lines.push('  (no steps)');
    for (const step of steps) lines.push(...renderExecutionStep(step, budget, opts.includeOutputs));
    lines.push(...renderDiff(exec.diffs?.[device.id], opts.diffLines));
  }
  return lines;
}

// ============================================================================
// Builder
// ============================================================================

export function buildMopAiContext(input: MopAiContextInput, options: MopAiContextOptions = {}): MopAiContextResult {
  const opts: Required<MopAiContextOptions> = {
    stepOutputTailChars: options.stepOutputTailChars ?? DEFAULT_STEP_OUTPUT_TAIL_CHARS,
    totalOutputChars: options.totalOutputChars ?? DEFAULT_TOTAL_OUTPUT_CHARS,
    diffLines: options.diffLines ?? DEFAULT_DIFF_LINES,
    includeExecution: options.includeExecution ?? true,
    includeOutputs: options.includeOutputs ?? true,
  };

  const deviceNames = new Map<string, string>(input.devices.map(d => [d.id, d.name]));
  const lines: string[] = ['## MOP context'];

  // Header
  const header = [`Name: ${input.name?.trim() || 'Untitled MOP'}`];
  if (input.riskLevel) header.push(`Risk: ${input.riskLevel}`);
  if (input.changeTicket) header.push(`Ticket: ${input.changeTicket}`);
  if (input.tags?.length) header.push(`Tags: ${input.tags.join(', ')}`);
  lines.push(header.join(' | '));
  lines.push(`Description: ${input.description?.trim() || '(none)'}`);

  // Devices + platforms. Execution devices carry the flavor resolved by the
  // agent; fall back to the plan's session flavors.
  const flavorSources: Array<{ cliFlavor?: string | null }> = input.execution?.devices.length
    ? input.execution.devices.map(d => ({ cliFlavor: d.cli_flavor ?? input.devices.find(p => p.id === d.session_id)?.cliFlavor }))
    : input.devices;
  if (input.devices.length) {
    lines.push(`Target devices (${input.devices.length}): ${input.devices.map(deviceLabel).join(' · ')}`);
  } else {
    lines.push('Target devices: none selected yet');
  }
  const platforms = distinctFlavors(flavorSources).map(f => flavorDisplayName(f)).filter((p): p is string => !!p);
  lines.push(`Platforms in scope: ${platforms.length ? platforms.join(', ') : 'unknown (no CLI flavor set on the selected sessions)'}`);

  // Variables
  const vars = Object.entries(input.variables || {}).filter(([k]) => k.trim());
  if (vars.length) lines.push(`Variables: ${vars.map(([k, v]) => `{{${k}}}=${v}`).join(' ')}`);
  lines.push(...renderPlanVariables(input.planVariables, input.deviceVariableMaps, input.devices));

  // Sections
  lines.push(...renderSections(input.steps, deviceNames));

  // Overrides
  const overrides = summariseOverrides(input.steps, input.deviceOverrides, deviceNames);
  if (overrides.length) lines.push(`Per-device overrides: ${overrides.join('; ')}`);

  // Execution
  if (opts.includeExecution && input.execution) lines.push(...renderExecution(input.execution, opts));

  const aiContext: AiContext = {
    sessionName: input.sessionName || `MOP: ${input.name?.trim() || 'Untitled MOP'}`,
    ...derivePlatformContext(flavorSources),
  };

  return { block: lines.join('\n'), aiContext };
}

// ============================================================================
// Live-chat summary (open MOP tab → AI live context)
// ============================================================================

export interface MopLiveSummaryInput {
  id: string | null;
  name: string;
  dirty: boolean;
  steps: MopStep[];
  deviceOverrides?: Record<string, MopStep[]>;
  devices: MopAiDevice[];
  execution?: MopAiExecutionInput | null;
}

/** Compact summary of an open MOP tab for the live workspace context. */
export function buildMopLiveSummary(input: MopLiveSummaryInput): MopLiveSummary {
  const counts: MopLiveSummary['stepCounts'] = { pre_check: 0, change: 0, post_check: 0, rollback: 0 };
  const stepSource = Object.keys(input.deviceOverrides || {}).length
    ? Object.values(input.deviceOverrides!).flat()
    : input.steps;
  for (const s of stepSource) {
    if (s.step_type in counts) counts[s.step_type as keyof typeof counts] += 1;
  }
  const flavorSources: Array<{ cliFlavor?: string | null }> = input.execution?.devices.length
    ? input.execution.devices.map(d => ({ cliFlavor: d.cli_flavor }))
    : input.devices;
  const flavors = distinctFlavors(flavorSources);
  const summary: MopLiveSummary = {
    id: input.id,
    name: input.name?.trim() || 'Untitled MOP',
    dirty: input.dirty,
    stepCounts: counts,
    devices: input.devices.map(d => d.name),
    platforms: flavors.map(f => flavorDisplayName(f)).filter((p): p is string => !!p),
    cliFlavor: flavors.length === 1 ? (flavors[0] as CliFlavor) : undefined,
    execution: null,
  };
  if (input.execution) {
    const { passed, failed, total } = executionProgress(input.execution.devices, input.execution.stepsByDevice);
    summary.execution = { id: input.execution.execution.id, status: input.execution.execution.status, passed, failed, total };
  }
  return summary;
}

// Module-level registry: each open MopWorkspace publishes its summary keyed
// by tab id; App reads the active tab's entry when assembling live context
// (same pattern as `registerFormAiContext`).
const mopTabSummaries = new Map<string, MopLiveSummary>();

export function registerMopTabSummary(tabId: string, summary: MopLiveSummary | null): void {
  if (summary) mopTabSummaries.set(tabId, summary);
  else mopTabSummaries.delete(tabId);
}

export function getMopTabSummary(tabId: string): MopLiveSummary | null {
  return mopTabSummaries.get(tabId) ?? null;
}
