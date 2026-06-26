// MOP Types - Plan layer (reusable procedure definitions) + Execution layer (runtime instances)

import type { MopStep, MopStepType } from './change';

// Re-export MopStepType from change.ts (canonical source) for backward compatibility
export type { MopStepType } from './change';

// ============================================================================
// SHARED PRIMITIVES
// ============================================================================

// Execution strategy options
export type ExecutionStrategy = 'sequential' | 'parallel_by_phase';

// Control mode options (updated to match design)
export type ControlMode = 'manual' | 'auto_run' | 'ai_pilot';

// Execution status.
//
// The MOP backend (agent/src/models.rs::ExecutionStatus) only ever emits
// 'complete' (snake_case serde). 'completed' is kept in this union because
// several consumers also branch on TaskStatus / deployment status, both of
// which use 'completed' — and a few sites (ApprovalControls, MopWorkspace,
// useMopExecution) accept either spelling defensively. Don't trim 'completed'
// without auditing those consumers.
export type ExecutionStatus = 'pending' | 'running' | 'paused' | 'complete' | 'completed' | 'failed' | 'aborted';

// Device status
export type DeviceStatus = 'pending' | 'running' | 'waiting' | 'complete' | 'failed' | 'skipped';

// Step status
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'mocked';

// Execution phase
export type ExecutionPhase = 'device_selection' | 'configuration' | 'pre_checks' | 'change_execution' | 'post_checks' | 'review';

// Risk level for enterprise change management
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// How steps were generated
export type StepSourceType = 'manual' | 'config_template';

// AI Pilot autonomy levels (1 = most supervised, 4 = fully autonomous)
export type AiAutonomyLevel = 1 | 2 | 3 | 4;

// Behavior when a step fails during auto_run or ai_pilot
export type OnFailureBehavior = 'pause' | 'skip' | 'abort';

// ============================================================================
// PLAN LAYER — Reusable procedure definitions
// ============================================================================

// MopPlan is the reusable, versioned procedure definition. It is authored once,
// reviewed/approved, and then instantiated as MopExecution records at runtime.
export interface MopPlan {
  id: string;
  name: string;
  description?: string;
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived';
  revision: number;

  // Change management metadata (enterprise-enhanced)
  risk_level?: RiskLevel;
  change_ticket?: string;       // ITSM ticket reference (e.g. CHG-1234)
  tags?: string[];

  // Step source: how the steps were created
  source_type: StepSourceType;
  source_id?: string;           // Template or stack ID if steps were generated
  source_variables?: Record<string, Record<string, string>>; // per-device/role variable overrides

  // The procedure itself
  steps: MopStep[];             // Default ordered step list
  device_overrides?: Record<string, MopStep[]>; // Per-device step overrides (keyed by role or device_id)

  // Enterprise sync fields
  org_id?: string;
  controller_id?: string;       // Corresponding ID on the controller
  approved_by?: string;
  approved_at?: string;

  created_by: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// LEGACY — MopTemplate (kept for backward compatibility)
// MopTemplate predates the Plan layer. Prefer MopPlan for new code.
// ============================================================================

export interface MopTemplate {
  id: string;
  name: string;
  description?: string;
  mop_steps: MopStep[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface NewMopTemplate {
  name: string;
  description?: string;
  mop_steps: MopStep[];
  created_by: string;
}

export interface UpdateMopTemplate {
  name?: string;
  description?: string | null;
  mop_steps?: MopStep[];
}

// ============================================================================
// EXECUTION LAYER — Runtime instances of a MopPlan
// ============================================================================

// MopExecution is a single run of a MopPlan against a set of devices.
// It references the plan and the revision that was active at execution time.
export interface MopExecution {
  id: string;

  // Plan reference (preferred; replaces legacy template_id)
  plan_id?: string | null;
  plan_revision: number;

  // Legacy template reference (kept for backward compatibility)
  template_id?: string;

  name: string;
  description?: string;
  execution_strategy: ExecutionStrategy;
  control_mode: ControlMode;
  status: ExecutionStatus;
  current_phase?: string;
  ai_analysis?: string;

  // AI Pilot settings (applicable when control_mode === 'ai_pilot')
  ai_autonomy_level?: AiAutonomyLevel;

  // Auto-run / AI Pilot pause gates
  pause_after_pre_checks?: boolean;
  pause_after_changes?: boolean;
  pause_after_post_checks?: boolean;

  // What to do when a step fails (auto_run / ai_pilot)
  on_failure: OnFailureBehavior;

  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  last_checkpoint?: string;     // JSON serialized

  // Joined data (when fetched with devices)
  devices?: MopExecutionDevice[];
}

export interface NewMopExecution {
  // Plan reference (required for new executions)
  plan_id: string;
  plan_revision?: number;       // defaults to current plan revision if omitted

  // Legacy template reference (kept for backward compatibility)
  template_id?: string;

  name: string;
  description?: string;
  execution_strategy: ExecutionStrategy;
  control_mode: ControlMode;
  ai_autonomy_level?: AiAutonomyLevel;
  pause_after_pre_checks?: boolean;
  pause_after_changes?: boolean;
  pause_after_post_checks?: boolean;
  on_failure?: OnFailureBehavior; // defaults to 'pause'
}

export interface UpdateMopExecution {
  name?: string;
  description?: string | null;
  execution_strategy?: ExecutionStrategy;
  control_mode?: ControlMode;
  status?: ExecutionStatus;
  current_phase?: string | null;
  ai_analysis?: string | null;
  ai_autonomy_level?: AiAutonomyLevel | null;
  pause_after_pre_checks?: boolean;
  pause_after_changes?: boolean;
  pause_after_post_checks?: boolean;
  on_failure?: OnFailureBehavior;
  started_at?: string | null;
  completed_at?: string | null;
  last_checkpoint?: string | null;
}

// ============================================================================
// EXECUTION DEVICE — A device participating in a MopExecution
// ============================================================================

// Supports dual-mode: professional (session_id) and enterprise (device_id + credential_id).
export interface MopExecutionDevice {
  id: string;
  execution_id: string;

  // Professional mode: reference an active session
  session_id?: string;

  // Enterprise mode: reference device inventory + vault credential
  device_id?: string;           // Device inventory ID
  credential_id?: string;       // Vault credential ID

  // Display / routing fields
  device_name: string;
  device_host: string;
  role?: string;                // Stack role (e.g. PE, CE, P, RR)

  device_order: number;
  status: DeviceStatus;
  current_step_id?: string;
  pre_snapshot_id?: string;
  post_snapshot_id?: string;
  ai_analysis?: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;

  // Joined data
  steps?: MopExecutionStep[];
}

export interface NewMopExecutionDevice {
  execution_id: string;
  device_order: number;

  // One of session_id (professional) or device_id (enterprise) must be provided
  session_id?: string;
  device_id?: string;
  credential_id?: string;
  device_name: string;
  device_host: string;
  role?: string;
}

// ============================================================================
// EXECUTION STEP — A single step result within a MopExecutionDevice
// ============================================================================

export interface MopExecutionStep {
  id: string;
  execution_device_id: string;
  step_order: number;
  step_type: MopStepType;
  command: string;
  description?: string;
  expected_output?: string;
  mock_enabled: boolean;
  mock_output?: string;
  status: StepStatus;
  output?: string;
  ai_feedback?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;

  // Execution source fields (carried from plan step)
  execution_source?: 'cli' | 'quick_action' | 'script';
  quick_action_id?: string;
  quick_action_variables?: Record<string, string>;
  script_id?: string;
  script_args?: Record<string, unknown>;
  paired_step_id?: string;
  output_format?: 'text' | 'json';
}

export interface NewMopExecutionStep {
  execution_device_id: string;
  step_order: number;
  step_type: MopStepType;
  command: string;
  description?: string;
  expected_output?: string;
  mock_enabled: boolean;
  mock_output?: string;

  // Execution source fields (carried from plan step)
  execution_source?: 'cli' | 'quick_action' | 'script' | 'deploy_template' | 'deployment_link';
  quick_action_id?: string;
  quick_action_variables?: Record<string, string>;
  script_id?: string;
  script_args?: Record<string, unknown>;
  paired_step_id?: string;
  output_format?: 'text' | 'json';
}

export interface UpdateMopExecutionStep {
  step_order?: number;
  command?: string;
  description?: string | null;
  expected_output?: string | null;
  mock_enabled?: boolean;
  mock_output?: string | null;
  status?: StepStatus;
  output?: string | null;
  ai_feedback?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

// Mock configuration
export interface MockConfig {
  mock_enabled: boolean;
  mock_output?: string;
}

// Step output update
export interface StepOutputUpdate {
  output?: string;
  status: StepStatus;
  ai_feedback?: string;
}

// Complete execution request
export interface CompleteExecutionRequest {
  ai_analysis?: string;
}
