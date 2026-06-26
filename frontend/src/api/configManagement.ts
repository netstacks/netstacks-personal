import { getClient } from './client';

const BASE = '/config';

// === Types ===
export interface ConfigPlatform {
  id: string; name: string; display_name: string; transport: string;
  default_port: number; config_format: string; capabilities: Record<string, any>;
}

export interface ConfigTemplate {
  id: string; org_id: string; name: string; description: string | null;
  target_path: string | null; operation: string; platform: string;
  config_format: string; source: string; current_version: number;
  variables: Array<{ name: string; type: string; required: boolean; description?: string }>;
  created_by: string; created_at: string; updated_at: string;
}

/**
 * Optional deployment-procedure block on a ConfigStack. All fields
 * optional because the controller may return a sparse object or null,
 * but the keys callers actually read are listed here so consumers don't
 * have to cast through `Record<string, any>`.
 */
export interface DeploymentProcedure {
  require_mop?: boolean;
  pre_checks?: unknown[];
  post_checks?: unknown[];
  on_post_check_failure?: string;
  // Extra fields the controller may send are accepted but not narrowed.
  [extra: string]: unknown;
}

export interface ConfigStack {
  id: string; org_id: string; name: string; description: string | null;
  atomic: boolean; services: ConfigStackService[];
  variable_config?: Record<string, any>;
  deployment_procedure?: DeploymentProcedure | null;
  created_by: string;
  created_at: string; updated_at: string;
}

export interface ConfigStackService {
  template_id: string;
  name: string;
  order: number;
}

export interface ConfigDeployment {
  id: string; org_id: string; stack_id: string; name: string;
  status: string; target_devices: any; variable_values: any;
  device_overrides: any; total_devices: number; succeeded_count: number;
  failed_count: number; created_by: string; started_at: string | null;
  completed_at: string | null; created_at: string;
  // Present on the per-deployment detail response (getConfigDeploymentDetail);
  // not always populated on list responses. Was previously read via
  // `useState<any>` to bypass this typing gap.
  device_results?: ConfigDeviceDeployment[];
}

export interface ConfigDeviceDeployment {
  id: string; deployment_id: string; device_id: string;
  service_name: string | null; status: string; rendered_config: string | null;
  target_path: string | null; error_message: string | null;
}

export interface DeploymentLog {
  id: string; deployment_id: string; device_id: string | null;
  level: string; message: string; created_at: string;
}

export interface DeviceConfig {
  id: string; device_id: string; config_format: string; config_hash: string;
  version: number; source: string; pulled_via: string; created_at: string;
  notes?: string | null; notes_by?: string | null; notes_updated_at?: string | null;
}

export interface ConfigStackInstance {
  id: string
  org_id: string
  stack_id: string
  name: string
  target_devices: any
  variable_values: any
  device_overrides: any
  state: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface VersionDiffResponse {
  old_version: number
  new_version: number
  old_format: string
  new_format: string
  identical: boolean
  diff: string
  additions: number
  deletions: number
}

export interface DeviceConfigFull {
  id: string
  device_id: string
  org_id: string
  config_text: string
  config_format: string
  config_hash: string
  version: number
  source: string
  pulled_via: string
  created_by: string | null
  created_at: string
  notes?: string | null
  notes_by?: string | null
  notes_updated_at?: string | null
}

export interface TemplateVersion {
  version: number;
  source: string;
  created_by: string;
  created_at: string;
}

// === API Functions ===
export async function listPlatforms(): Promise<ConfigPlatform[]> {
  const { data } = await getClient().http.get(`${BASE}/platforms`);
  return data;
}

export async function listConfigTemplates(): Promise<ConfigTemplate[]> {
  const { data } = await getClient().http.get(`${BASE}/templates`);
  return Array.isArray(data) ? data : data.data || [];
}

export async function getConfigTemplate(id: string): Promise<ConfigTemplate> {
  const { data } = await getClient().http.get(`${BASE}/templates/${id}`);
  return data;
}

export async function createConfigTemplate(body: any): Promise<ConfigTemplate> {
  const { data } = await getClient().http.post(`${BASE}/templates`, body);
  return data;
}

export async function updateConfigTemplate(id: string, body: any): Promise<ConfigTemplate> {
  const { data } = await getClient().http.put(`${BASE}/templates/${id}`, body);
  return data;
}

export async function deleteConfigTemplate(id: string): Promise<void> {
  await getClient().http.delete(`${BASE}/templates/${id}`);
}

export async function renderConfigTemplate(id: string, body: { variables: Record<string, any>; version?: number }): Promise<{ rendered: string; format: string }> {
  const { data } = await getClient().http.post(`${BASE}/templates/${id}/render`, body);
  return data;
}

export async function listTemplateVersions(id: string): Promise<TemplateVersion[]> {
  const { data } = await getClient().http.get(`${BASE}/templates/${id}/versions`);
  return Array.isArray(data) ? data : data.data || [];
}

export async function listConfigStacks(): Promise<ConfigStack[]> {
  const { data } = await getClient().http.get(`${BASE}/stacks`);
  return Array.isArray(data) ? data : data.data || [];
}

export async function getConfigStack(id: string): Promise<ConfigStack> {
  const { data } = await getClient().http.get(`${BASE}/stacks/${id}`);
  return data;
}

export async function createConfigStack(body: any): Promise<ConfigStack> {
  const { data } = await getClient().http.post(`${BASE}/stacks`, body);
  return data;
}

export async function updateConfigStack(id: string, body: any): Promise<ConfigStack> {
  const { data } = await getClient().http.put(`${BASE}/stacks/${id}`, body);
  return data;
}

export async function deleteConfigStack(id: string): Promise<void> {
  await getClient().http.delete(`${BASE}/stacks/${id}`);
}

export async function renderConfigStack(id: string, body: any): Promise<any> {
  const { data } = await getClient().http.post(`${BASE}/stacks/${id}/render`, body);
  return data;
}

export async function resolveStackVariables(id: string, body: any): Promise<any> {
  const { data } = await getClient().http.post(`${BASE}/stacks/${id}/resolve-variables`, body);
  return data;
}

export async function listConfigDeployments(): Promise<ConfigDeployment[]> {
  const { data } = await getClient().http.get(`${BASE}/deployments`);
  return Array.isArray(data) ? data : data.data || [];
}

export async function createConfigDeployment(body: any): Promise<ConfigDeployment> {
  const { data } = await getClient().http.post(`${BASE}/deployments`, body);
  return data;
}

export async function getConfigDeploymentDetail(id: string): Promise<ConfigDeployment> {
  const { data } = await getClient().http.get(`${BASE}/deployments/${id}`);
  return data;
}

export async function getDeploymentLogs(id: string): Promise<DeploymentLog[]> {
  const { data } = await getClient().http.get(`${BASE}/deployments/${id}/logs`);
  return Array.isArray(data) ? data : data.data || [];
}

export async function rollbackDeployment(id: string): Promise<any> {
  const { data } = await getClient().http.post(`${BASE}/deployments/${id}/rollback`);
  return data;
}

export async function listDeviceConfigs(deviceId: string): Promise<DeviceConfig[]> {
  const { data } = await getClient().http.get(`${BASE}/devices/${deviceId}/configs`);
  return Array.isArray(data) ? data : data.configs || data.data || [];
}

export async function pullDeviceConfig(deviceId: string): Promise<any> {
  const { data } = await getClient().http.post(`${BASE}/devices/${deviceId}/pull`);
  return data;
}

// === Stack Instances ===
export async function listStackInstances(stackId?: string): Promise<ConfigStackInstance[]> {
  const params = stackId ? { stack_id: stackId } : undefined;
  const { data } = await getClient().http.get(`${BASE}/instances`, { params });
  return Array.isArray(data) ? data : data.data || [];
}

export async function getStackInstance(id: string): Promise<ConfigStackInstance> {
  const { data } = await getClient().http.get(`${BASE}/instances/${id}`);
  return data;
}

export async function createStackInstance(body: any): Promise<ConfigStackInstance> {
  const { data } = await getClient().http.post(`${BASE}/instances`, body);
  return data;
}

export async function updateStackInstance(id: string, body: any): Promise<ConfigStackInstance> {
  const { data } = await getClient().http.put(`${BASE}/instances/${id}`, body);
  return data;
}

export async function deleteStackInstance(id: string): Promise<void> {
  await getClient().http.delete(`${BASE}/instances/${id}`);
}

export async function deployStackInstance(id: string): Promise<any> {
  const { data } = await getClient().http.post(`${BASE}/instances/${id}/deploy`);
  return data;
}

/**
 * @deprecated Use deployment_link MOP steps instead. Will be removed in a future version.
 */
export async function deployInstanceWithMop(
  instanceId: string,
  options?: { control_mode?: string; name?: string }
): Promise<{ mop_plan_id: string; mop_execution_id: string; instance_id: string; stack_id: string }> {
  const { data } = await getClient().http.post(`${BASE}/instances/${instanceId}/deploy-with-mop`, options || {});
  return data;
}

// === Device Config (full text) ===
export async function getDeviceConfigVersion(deviceId: string, version: number): Promise<DeviceConfigFull> {
  const { data } = await getClient().http.get(`${BASE}/devices/${deviceId}/configs/${version}`);
  return data;
}

/**
 * Update operator notes (tribal knowledge) on a specific config version.
 * Notes are metadata only — they never modify the stored config text.
 * Pass `null`/empty to clear the note. Enterprise (Controller) only.
 */
export async function updateDeviceConfigNotes(
  deviceId: string,
  version: number,
  notes: string | null
): Promise<DeviceConfigFull> {
  const { data } = await getClient().http.put(
    `${BASE}/devices/${deviceId}/configs/${version}/notes`,
    { notes }
  );
  return data;
}

export async function diffConfigVersions(
  deviceId: string,
  oldVersion: number,
  newVersion: number
): Promise<VersionDiffResponse> {
  const { data } = await getClient().http.get(`${BASE}/devices/${deviceId}/diff-versions`, {
    params: { old_version: oldVersion, new_version: newVersion },
  });
  return data;
}
