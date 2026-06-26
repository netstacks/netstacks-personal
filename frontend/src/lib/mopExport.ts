/**
 * MOP Package Export/Import utilities
 *
 * Handles exporting MOPs as portable .mop.json packages and importing them.
 * Package format strips instance-specific data and uses portable device identifiers.
 */

import { getClient, getCurrentMode } from '../api/client';
import { getControllerMop } from '../api/controllerMop';
import type { MopPackage, MopImportResult, MopPackageStep } from '../types/mopPackage';
import { downloadFile } from './formatters';

/**
 * Export a MOP as a portable package.
 * Enterprise mode: fetches from /api/mops/:id and builds the package client-side.
 * Standalone mode: calls /api/changes/:id/export-mop on the local agent.
 */
export async function exportMopPackage(mopId: string): Promise<MopPackage> {
  if (getCurrentMode() === 'enterprise') {
    const mop = await getControllerMop(mopId);
    type PkgStep = {
      order?: number; step_type: string; command: string; description?: string; expected_output?: string;
      execution_source?: string; quick_action_id?: string; quick_action_variables?: Record<string, string>;
      script_id?: string; script_args?: Record<string, unknown>; paired_step_id?: string; output_format?: 'text' | 'json';
      deploy_metadata?: Record<string, unknown>; device_scope?: string; device_ids?: string[];
    };
    const pkg = mop.package_data as {
      mop?: { name?: string; description?: string; steps?: PkgStep[] };
      metadata?: Record<string, unknown>;
      execution_defaults?: Record<string, unknown>;
      linked_stack?: Record<string, unknown>;
    };
    const rawSteps = pkg?.mop?.steps || [];

    return {
      format: 'netstacks-mop',
      version: '2.0',
      exported_at: new Date().toISOString(),
      source: 'NetStacks Controller',
      mop: {
        name: mop.name,
        description: mop.description,
        author: mop.author,
        steps: rawSteps.map((s, i) => ({
          order: s.order ?? i + 1,
          step_type: s.step_type,
          command: s.command,
          description: s.description,
          expected_output: s.expected_output,
          execution_source: s.execution_source as MopPackageStep['execution_source'],
          quick_action_id: s.quick_action_id,
          quick_action_variables: s.quick_action_variables,
          script_id: s.script_id,
          script_args: s.script_args,
          paired_step_id: s.paired_step_id,
          output_format: s.output_format,
          deploy_metadata: s.deploy_metadata as MopPackageStep['deploy_metadata'],
          device_scope: (s.device_scope as 'all' | 'specific') || 'all',
          device_ids: s.device_ids,
        })),
      },
      metadata: {
        tags: mop.tags || [],
        risk_level: mop.risk_level,
        platform_hints: mop.platform_hints || [],
        estimated_duration_minutes: mop.estimated_duration_minutes,
        change_ticket: mop.change_ticket,
        lineage: { revision: mop.revision },
        review: { status: mop.status, reviewers: [], comments: [] },
        custom: {},
      },
      execution_defaults: pkg?.execution_defaults as MopPackage['execution_defaults'],
      linked_stack: pkg?.linked_stack as MopPackage['linked_stack'],
    };
  }

  // Standalone mode: use local agent endpoint
  const { data } = await getClient().http.get(`/changes/${mopId}/export-mop`);
  return data;
}

/**
 * Import a MOP package, creating a new MOP/Change.
 * Enterprise mode: creates via /api/mops.
 * Standalone mode: calls /api/changes/import-mop on the local agent.
 */
export async function importMopPackage(pkg: MopPackage): Promise<MopImportResult> {
  if (getCurrentMode() === 'enterprise') {
    const { data } = await getClient().http.post('/mops', {
      package_data: {
        version: pkg.version || '2.0',
        mop: {
          name: pkg.mop.name,
          description: pkg.mop.description,
          steps: pkg.mop.steps,
        },
        metadata: pkg.metadata,
        execution_defaults: pkg.execution_defaults,
        linked_stack: pkg.linked_stack,
      },
    });
    return {
      change_id: data.id,
      name: data.name,
      steps_imported: pkg.mop.steps.length,
      overrides_imported: 0,
      document_created: false,
      warnings: [],
    };
  }

  // Standalone mode: use local agent endpoint
  const { data } = await getClient().http.post('/changes/import-mop', pkg);
  return data;
}

/**
 * Download a MOP package as a .mop.json file
 */
export function downloadMopPackage(pkg: MopPackage): void {
  const json = JSON.stringify(pkg, null, 2);

  // Sanitize name for filename
  const safeName = pkg.mop.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);

  downloadFile(json, `${safeName || 'mop-export'}.mop.json`, 'application/json');
}

/**
 * Read and validate a MOP package from a File object
 */
export async function readMopPackageFromFile(
  file: File
): Promise<{ package: MopPackage; warnings: string[] }> {
  const content = await file.text();
  return parseMopPackageJson(content);
}

/**
 * Parse and validate a MOP package from a JSON string
 */
export function parseMopPackageJson(
  json: string
): { package: MopPackage; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON format');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Validate format
  if (obj.format !== 'netstacks-mop') {
    throw new Error(
      `Unknown format: '${String(obj.format || '')}', expected 'netstacks-mop'`
    );
  }

  // Validate version
  const version = String(obj.version || '');
  if (!version.startsWith('1.') && !version.startsWith('2.') && version !== '1' && version !== '2') {
    throw new Error(`Unsupported version: '${version}', expected 1.x or 2.x`);
  }

  // Validate mop field exists
  if (typeof obj.mop !== 'object' || obj.mop === null) {
    throw new Error('Missing or invalid "mop" field');
  }

  const mop = obj.mop as Record<string, unknown>;

  // Validate name
  if (typeof mop.name !== 'string' || !mop.name.trim()) {
    throw new Error('MOP name is required');
  }

  // Validate steps
  if (!Array.isArray(mop.steps) || mop.steps.length === 0) {
    throw new Error('MOP must have at least one step');
  }

  const validStepTypes = ['pre_check', 'change', 'post_check', 'rollback'];
  for (let i = 0; i < mop.steps.length; i++) {
    const step = mop.steps[i] as Record<string, unknown>;
    if (typeof step.command !== 'string' || !step.command.trim()) {
      throw new Error(`Step ${i + 1} has an empty or missing command`);
    }
    if (typeof step.step_type === 'string') {
      if (step.step_type === 'api_action') {
        // v1.x backward compat: convert api_action to change with quick_action source
        step.step_type = 'change';
        if (!step.execution_source) {
          step.execution_source = 'quick_action';
        }
        warnings.push(`Step ${i + 1}: converted api_action to change (quick_action source)`);
      } else if (!validStepTypes.includes(step.step_type)) {
        warnings.push(`Step ${i + 1} has unknown type '${step.step_type}'`);
      }
    }
    // v1.x backward compat: default device_scope
    if (!step.device_scope) {
      step.device_scope = 'all';
    }
  }

  // v1.x backward compat: flatten device_overrides into per-step device_ids
  if (mop.device_overrides && typeof mop.device_overrides === 'object') {
    warnings.push('device_overrides migrated to per-step device_scope — review device targeting');
    delete mop.device_overrides;
  }

  return { package: parsed as MopPackage, warnings };
}
