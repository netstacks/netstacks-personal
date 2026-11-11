// Shared MOP constants — single source for section metadata, status colours
// and ordering used by MopWorkspace and its sub-tabs.

import type { MopStepType } from '../../types/change';
import type { AssertionType } from './mopHelpers';

// Step section configuration (Plan tab sections, Execute tab groups)
export const STEP_SECTIONS: { type: MopStepType; label: string; color: string }[] = [
  { type: 'pre_check', label: 'Pre-Checks', color: '#4fc1ff' },
  { type: 'change', label: 'Changes', color: '#dcdcaa' },
  { type: 'post_check', label: 'Post-Checks', color: '#4ec9b0' },
  { type: 'rollback', label: 'Rollback', color: '#ce9178' },
];

// Colour per step type (same palette as STEP_SECTIONS, keyed for lookups)
export const STEP_TYPE_COLORS: Record<string, string> = Object.fromEntries(
  STEP_SECTIONS.map(s => [s.type, s.color]),
);

// Short letter used in the device assignment matrix headers
export const STEP_TYPE_LETTERS: Record<string, string> = {
  pre_check: 'P',
  change: 'C',
  post_check: 'V',
  rollback: 'R',
  api_action: 'A',
};

// Execution order of step types (pre_check → change → post_check → rollback)
export const STEP_TYPE_ORDER: Record<string, number> = {
  pre_check: 0,
  change: 1,
  post_check: 2,
  rollback: 3,
  api_action: 4,
};

// Phases that the auto-run bar drives, in the order they must run
export const PHASE_STEP_TYPES: readonly ['pre_check', 'change', 'post_check'] = ['pre_check', 'change', 'post_check'];
export type PhaseStepType = (typeof PHASE_STEP_TYPES)[number];

// Step status colours used in execution and review views
export const STEP_STATUS_COLORS: Record<string, string> = {
  passed: '#4ec9b0',
  failed: '#f44747',
  running: '#dcdcaa',
  skipped: '#858585',
  mocked: '#c586c0',
};
export const DEFAULT_STEP_STATUS_COLOR = '#6e7681';

// Device panel CSS class per device status (anything else renders as pending)
export const DEVICE_STATUS_CLASSES: Record<string, string> = {
  complete: 'complete',
  failed: 'failed',
  running: 'running',
  skipped: 'skipped',
};

// Execution status colours / labels (execution lists, history)
export const EXEC_STATUS_COLORS: Record<string, string> = {
  complete: '#4ec9b0',
  completed: '#4ec9b0',
  failed: '#f44747',
  aborted: '#ce9178',
  running: '#4fc1ff',
  paused: '#dcdcaa',
};

export const EXEC_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  complete: 'Completed',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
  running: 'Running',
  paused: 'Paused',
};

// Capitalize first letter of a string
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Check if execution is finished (terminal status)
export function isExecutionFinished(status: string | undefined): boolean {
  return status === 'complete' || status === 'completed' || status === 'failed' || status === 'aborted';
}

// Colour per assertion type (Plan tab pills)
export const ASSERTION_COLORS: Record<AssertionType, string> = {
  CONTAINS: '#4fc1ff',
  NOT_CONTAINS: '#f44747',
  REGEX: '#c586c0',
  TEXT: '#858585',
};
