// Change Control Types (Phase 15)

export type ChangeStatus =
  | 'draft'
  | 'executing'
  | 'validating'
  | 'complete'
  | 'failed'
  | 'rolled_back'
  // Enterprise MOP statuses (from controller)
  | 'pending_review'
  | 'approved'
  | 'rejected';

export type MopStepType = 'pre_check' | 'change' | 'post_check' | 'rollback' | 'api_action';

export interface MopStep {
  id: string;
  order: number;
  step_type: MopStepType;
  command: string;
  description?: string;
  expected_output?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  output?: string;
  executed_at?: string;
  ai_feedback?: string; // AI analysis of command output during execution

  // Execution source: how this step runs
  execution_source?: 'cli' | 'quick_action' | 'script' | 'deploy_template' | 'deployment_link';  // default: 'cli'

  // Quick Action source
  quick_action_id?: string;
  quick_action_variables?: Record<string, string>;

  // Script source
  script_id?: string;
  script_args?: Record<string, unknown>;

  // Config deployment source (deploy_template or deployment_link)
  deploy_metadata?: {
    template_id?: string;
    deployment_id?: string;
    instance_id?: string;
    variables?: Record<string, string>;
  };

  // Pairing: auto-create mirror step in paired phase
  paired_step_id?: string;

  // Output handling
  output_format?: 'text' | 'json';

  // Device targeting: which devices this step runs on
  device_scope?: 'all' | 'specific';  // default: 'all'
  device_ids?: string[];              // Only when scope = 'specific'
}

/**
 * Plan-level variable: `{{name}}` in step commands / expected outputs /
 * quick-action variables / script args resolves to `value` (or the device's
 * override from `Change.device_variables`). Built-ins `{{device.host}}`,
 * `{{device.name}}` and `{{device.type}}` always win over user variables.
 */
export interface MopVariable {
  /** ^[A-Za-z_][A-Za-z0-9_]*$, unique per plan (case-sensitive). */
  name: string;
  /** Plan-level default; may be "". */
  value: string;
  description?: string;
  /** true → every device must resolve to a non-empty value before start. */
  required: boolean;
}

/** `{ <session_id>: { <variable name>: <value> } }` — blank/absent = inherit the plan default. */
export type MopDeviceVariables = Record<string, Record<string, string>>;

export interface Change {
  id: string;
  session_id?: string | null;
  name: string;
  description?: string;
  status: ChangeStatus;
  mop_steps: MopStep[];
  device_overrides?: Record<string, MopStep[]>;
  pre_snapshot_id?: string;
  post_snapshot_id?: string;
  ai_analysis?: string;
  document_id?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  executed_at?: string;
  completed_at?: string;
  // Plan metadata (persisted since the MOP fix pass; older agents omit them)
  risk_level?: string | null;
  change_ticket?: string | null;
  tags?: string[];
  // Every session selected in the Devices tab. `session_id` stays as the
  // primary/legacy target for older agents.
  session_ids?: string[];
  // Plan-level variables + per-session overrides (older agents omit both)
  variables?: MopVariable[];
  device_variables?: MopDeviceVariables;
}

export interface NewChange {
  session_id?: string | null;
  name: string;
  description?: string;
  mop_steps: MopStep[];
  device_overrides?: Record<string, MopStep[]>;
  document_id?: string;
  created_by: string;
  risk_level?: string | null;
  change_ticket?: string | null;
  tags?: string[];
  session_ids?: string[];
  variables?: MopVariable[];
  device_variables?: MopDeviceVariables;
}

export interface UpdateChange {
  name?: string;
  description?: string | null;
  status?: ChangeStatus;
  mop_steps?: MopStep[];
  device_overrides?: Record<string, MopStep[]> | null;
  document_id?: string | null;
  session_id?: string;
  pre_snapshot_id?: string | null;
  post_snapshot_id?: string | null;
  ai_analysis?: string | null;
  executed_at?: string | null;
  completed_at?: string | null;
  // null clears the field on the agent (double-option in Rust)
  risk_level?: string | null;
  change_ticket?: string | null;
  tags?: string[];
  session_ids?: string[];
  // Whole-list / whole-map replacement (no "clear" distinct from empty)
  variables?: MopVariable[];
  device_variables?: MopDeviceVariables;
}

// Snapshots are owned by either a Change (manual pre/post) or a MOP
// execution (phase snapshots) — at least one of the two ids is set.
export interface Snapshot {
  id: string;
  change_id?: string | null;
  execution_id?: string | null;
  snapshot_type: 'pre' | 'post';
  commands: string[];
  output: string;
  captured_at: string;
}

export interface NewSnapshot {
  change_id?: string | null;
  execution_id?: string | null;
  snapshot_type: 'pre' | 'post';
  commands: string[];
  output: string;
}

// Helper to create a new MOP step
export function createMopStep(
  stepType: MopStepType,
  command: string,
  order: number,
  description?: string,
  executionSource?: MopStep['execution_source'],
): MopStep {
  return {
    id: crypto.randomUUID(),
    order,
    step_type: stepType,
    command,
    description,
    status: 'pending',
    execution_source: executionSource || 'cli',
    device_scope: 'all',
  };
}

// Status display helpers
// Diff types for paired step comparison
export interface StepDiff {
  format: 'json' | 'text';
  changes: Array<{
    path: string;
    old: unknown;
    new: unknown;
    type: 'changed' | 'added' | 'removed';
  }>;
  summary: {
    changed: number;
    added: number;
    removed: number;
  };
}

export const changeStatusLabels: Record<ChangeStatus, string> = {
  draft: 'Draft',
  executing: 'Executing',
  validating: 'Validating',
  complete: 'Complete',
  failed: 'Failed',
  rolled_back: 'Rolled Back',
  pending_review: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const changeStatusColors: Record<ChangeStatus, string> = {
  draft: 'var(--text-secondary)',
  executing: 'var(--accent)',
  validating: 'var(--warning)',
  complete: 'var(--success)',
  failed: 'var(--error)',
  rolled_back: 'var(--warning)',
  pending_review: 'var(--warning)',
  approved: 'var(--success)',
  rejected: 'var(--error)',
};
