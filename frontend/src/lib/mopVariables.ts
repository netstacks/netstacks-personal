// Plan-level `{{name}}` variables for MOPs (P1-11).
//
// Resolution semantics are shared with the agent (`resolve_runtime_vars`):
// `{{name}}` with optional whitespace inside the braces; the `device.host`,
// `device.name` and `device.type` built-ins always win over user variables;
// unknown placeholders are left verbatim. Pure — no React, no network.
// Unit-tested in `lib/__tests__/mopVariables.test.ts`.

import type { Change, MopStep, MopVariable } from '../types/change';

/** Valid user variable name: identifier, case-sensitive, no dots. */
export const MOP_VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Placeholder scanner — accepts dotted names so the built-ins match too. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

/** Names the executor derives from the target device (never user-declared). */
export const MOP_BUILTIN_VARIABLES = ['device.host', 'device.name', 'device.type'] as const;

export function isBuiltinVariable(name: string): boolean {
  return (MOP_BUILTIN_VARIABLES as readonly string[]).includes(name);
}

/** Distinct placeholder names in `text`, in first-seen order (built-ins included). */
export function findPlaceholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Replace every `{{name}}` that `vars` knows; unknown placeholders stay verbatim. */
export function resolveMopVariables(text: string, vars: Record<string, string>): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/** Placeholder names still present after resolving `text` with `vars`. */
export function unresolvedPlaceholders(text: string | null | undefined, vars: Record<string, string>): string[] {
  return findPlaceholders(text).filter(name => !Object.prototype.hasOwnProperty.call(vars, name));
}

/** Resolve the string leaves of a script-args object (arrays/objects recursed, other types untouched). */
export function resolveScriptArgs(args: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const resolveValue = (v: unknown): unknown => {
    if (typeof v === 'string') return resolveMopVariables(v, vars);
    if (Array.isArray(v)) return v.map(resolveValue);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolveValue(x)]));
    }
    return v;
  };
  return resolveValue(args) as Record<string, unknown>;
}

/** Every string leaf of a script-args object (for placeholder scans). */
function scriptArgStrings(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(args);
  return out;
}

/** The texts of a plan step that are subject to variable resolution. */
export function stepTemplateTexts(step: MopStep): string[] {
  return [
    step.command || '',
    step.expected_output || '',
    ...Object.values(step.quick_action_variables || {}),
    ...scriptArgStrings(step.script_args),
  ].filter(Boolean);
}

/** Distinct placeholder names used anywhere in `steps` (built-ins included). */
export function planPlaceholders(steps: MopStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    for (const text of stepTemplateTexts(step)) {
      for (const name of findPlaceholders(text)) if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Placeholders used in steps that are neither declared nor built-in. */
export function undeclaredPlaceholders(steps: MopStep[], declared: Pick<MopVariable, 'name'>[]): string[] {
  const names = new Set(declared.map(v => v.name));
  return planPlaceholders(steps).filter(name => !names.has(name) && !isBuiltinVariable(name));
}

export interface VariableDevice {
  name: string;
  host?: string | null;
  /** Session.cli_flavor wire string, passed through as-is (may be 'auto'; "" when unknown). */
  cliFlavor?: string | null;
}

/**
 * Final map for one device: plan defaults, then the device's overrides (for
 * declared names only), then the `device.*` built-ins on top.
 */
export function deviceVariableMap(
  plan: Pick<Change, 'variables' | 'device_variables'>,
  sessionId: string,
  device: VariableDevice,
): Record<string, string> {
  const map: Record<string, string> = {};
  const declared = plan.variables || [];
  for (const v of declared) {
    if (v.name) map[v.name] = v.value ?? '';
  }
  const overrides = plan.device_variables?.[sessionId] || {};
  for (const v of declared) {
    const override = overrides[v.name];
    if (typeof override === 'string' && override !== '') map[v.name] = override;
  }
  // Same as the agent: the raw cli_flavor wire string (may be 'auto').
  map['device.host'] = device.host ?? '';
  map['device.name'] = device.name;
  map['device.type'] = device.cliFlavor ?? '';
  return map;
}

/** Null when `name` is a valid user variable name, otherwise the reason. */
export function validateVariableName(name: string): string | null {
  const trimmed = name ?? '';
  if (!trimmed) return 'Name is required';
  if (trimmed.startsWith('device.') || trimmed === 'device') return '"device.*" names are reserved for built-ins';
  if (!MOP_VARIABLE_NAME_RE.test(trimmed)) return 'Use letters, digits and underscores; must not start with a digit';
  return null;
}

/** Per-row validation for the Variables card: name errors + duplicates. */
export function variableRowErrors(variables: Pick<MopVariable, 'name'>[]): (string | null)[] {
  const counts = new Map<string, number>();
  for (const v of variables) counts.set(v.name, (counts.get(v.name) ?? 0) + 1);
  return variables.map(v => validateVariableName(v.name) ?? ((counts.get(v.name) ?? 0) > 1 ? 'Duplicate name' : null));
}

/** A `device → variable` problem that blocks Start. */
export interface VariableIssue {
  deviceId: string;
  deviceName: string;
  name: string;
  reason: 'unresolved' | 'required';
}

/**
 * Pre-start check: for each device, placeholders in its scoped steps that the
 * device's map cannot resolve, plus `required` variables that resolve empty.
 */
export function preStartVariableIssues(
  plan: Pick<Change, 'variables' | 'device_variables'>,
  targets: Array<{ id: string; device: VariableDevice; steps: MopStep[] }>,
): VariableIssue[] {
  const issues: VariableIssue[] = [];
  const push = (issue: VariableIssue) => {
    if (!issues.some(i => i.deviceId === issue.deviceId && i.name === issue.name)) issues.push(issue);
  };
  for (const target of targets) {
    const vars = deviceVariableMap(plan, target.id, target.device);
    const used = planPlaceholders(target.steps);
    for (const name of used) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) {
        push({ deviceId: target.id, deviceName: target.device.name, name, reason: 'unresolved' });
      }
    }
    // Mirrors the agent's add-device check: a required variable must be
    // non-empty for every device, whether or not the steps reference it.
    for (const v of plan.variables || []) {
      if (v.required && v.name && !(vars[v.name] ?? '').trim()) {
        push({ deviceId: target.id, deviceName: target.device.name, name: v.name, reason: 'required' });
      }
    }
  }
  return issues;
}
