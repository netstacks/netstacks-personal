// MOP Package Export/Import Types

export interface MopPackageStep {
  order: number;
  step_type: string;
  command: string;
  description?: string;
  expected_output?: string;

  // Execution source routing
  execution_source?: 'cli' | 'quick_action' | 'script' | 'deploy_template' | 'deployment_link';
  quick_action_id?: string;
  quick_action_variables?: Record<string, string>;
  script_id?: string;
  script_args?: Record<string, unknown>;
  paired_step_id?: string;
  output_format?: 'text' | 'json';

  // Config deployment metadata
  deploy_metadata?: {
    template_id?: string;
    stack_id?: string;
    instance_id?: string;
    variables?: Record<string, unknown>;
    target_devices?: Array<{ device_id: string; device_name?: string }>;
  };

  // Device targeting
  device_scope?: 'all' | 'specific';
  device_ids?: string[];
}

export interface MopPackageDocument {
  name: string;
  content_type: string;
  content: string;
}

export interface MopPackageProcedure {
  name: string;
  description?: string;
  author: string;
  steps: MopPackageStep[];
  document?: MopPackageDocument;
}

export interface MopPackageLineage {
  revision: number;
  parent_id?: string | null;
  forked_from?: string | null;
}

export interface MopPackageReview {
  status?: string | null;
  reviewers: string[];
  approved_by?: string | null;
  comments: string[];
}

export interface MopPackageMetadata {
  tags: string[];
  risk_level?: string | null;
  platform_hints: string[];
  estimated_duration_minutes?: number | null;
  change_ticket?: string | null;
  lineage: MopPackageLineage;
  review: MopPackageReview;
  custom: Record<string, unknown>;
}

export interface MopPackageExecutionDefaults {
  control_mode?: 'manual' | 'auto_run' | 'ai_pilot';
  on_failure?: 'pause' | 'rollback' | 'continue';
  pause_after_pre_checks?: boolean;
  pause_after_changes?: boolean;
  ai_analysis_prompt?: string;
  ai_rollback_policy?: string;
}

export interface MopPackageLinkedStack {
  stack_id?: string;
  stack_name?: string;
}

export interface MopPackage {
  format: string;
  version: string;
  exported_at: string;
  source: string;
  mop: MopPackageProcedure;
  metadata: MopPackageMetadata;
  execution_defaults?: MopPackageExecutionDefaults;
  linked_stack?: MopPackageLinkedStack;
}

export interface MopImportResult {
  change_id: string;
  name: string;
  steps_imported: number;
  overrides_imported: number;
  document_created: boolean;
  warnings: string[];
}
