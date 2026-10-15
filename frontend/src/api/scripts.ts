// API client for scripts
// In Enterprise mode, scripts are stored on the Controller via /api/scripts.
// In Professional mode, scripts are stored on the local agent.

import { getClient, getCurrentMode } from './client';
import { resolveProvider } from '../lib/aiProviderResolver';
import { AiNotConfiguredError, aiNotConfiguredMessage } from './ai';

export interface Script {
  id: string;
  name: string;
  content: string;
  last_run_at: string | null;
  shared?: boolean;
  owner_name?: string | null;
  is_own?: boolean;
  created_at: string;
  updated_at: string;
  /** Provenance — `'user'` (default) or `'ai'`. AUDIT FIX (EXEC-014).
   *  The Controller sends it as `created_by_role`; see fromController(). */
  created_by?: 'user' | 'ai';
  /** Approval flag for AI-authored scripts. False means the user must call
   *  approveScript() before runScript() will be accepted by the backend. */
  approved?: boolean;
  /** Controller only: whether this user may edit/delete the script (own
   *  scripts, plus shared ones for `system.manage` admins). The standalone
   *  agent omits it — every local script is the user's own. */
  can_edit?: boolean;
}

export interface NewScript {
  name: string;
  content: string;
  shared?: boolean;
}

export interface UpdateScript {
  name?: string;
  content?: string;
  shared?: boolean;
}

export interface ScriptOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

/** Options for running a script with device targeting */
export interface RunScriptOptions {
  device_ids?: string[];
  custom_input?: string;
  execution_mode?: 'parallel' | 'sequential';
  /** JSON-serialized main() arguments (Windmill-style convention) */
  main_args?: string;
}

/** A detected parameter from a script's main() function */
export interface ScriptParam {
  name: string;
  param_type: 'str' | 'int' | 'float' | 'bool' | 'list' | 'dict';
  default_value: unknown | null;
  required: boolean;
}

/** Analysis result for a script */
export interface ScriptAnalysis {
  has_main: boolean;
  params: ScriptParam[];
  has_inline_metadata: boolean;
}

/** Per-device result when running with device targeting */
export interface DeviceResult {
  device_id: string;
  device_name: string;
  host: string;
  status: 'success' | 'failed' | 'running' | 'pending';
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

/** Output when running with device targeting */
export interface MultiDeviceOutput {
  status: string;
  execution_mode: string;
  total_devices: number;
  success_count: number;
  failed_count: number;
  results: DeviceResult[];
}

export interface GenerateScriptResponse {
  script: string;
  explanation: string;
}

/** Events emitted during streaming script execution */
export type ScriptStreamEvent =
  | { event: 'status'; data: string }
  | { event: 'stderr'; data: string }
  | { event: 'stdout'; data: string }
  | { event: 'complete'; data: { exit_code: number; duration_ms: number } }
  | { event: 'error'; data: string };

// === Controller (Enterprise) types ===

/** Script as the Controller serialises it (routes/scripts.rs ScriptResponse). */
interface ControllerScript {
  id: string;
  name: string;
  content: string;
  last_run_at: string | null;
  shared: boolean;
  owner_name: string | null;
  is_own: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
  created_by_role: string;
  approved: boolean;
}

function fromController(s: ControllerScript): Script {
  return {
    id: s.id,
    name: s.name,
    content: s.content,
    last_run_at: s.last_run_at,
    shared: s.shared,
    owner_name: s.owner_name,
    is_own: s.is_own,
    can_edit: s.can_edit,
    created_at: s.created_at,
    updated_at: s.updated_at,
    created_by: s.created_by_role === 'ai' ? 'ai' : 'user',
    approved: s.approved,
  };
}

interface ControllerExecution {
  id: string;
  script_id: string;
  state: string;
  output: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function isEnterprise(): boolean {
  return getCurrentMode() === 'enterprise';
}

/** The one place a script response becomes a `Script`: the Controller's shape
 *  is mapped, the standalone agent's already matches. */
function toScript(data: unknown): Script {
  return isEnterprise() ? fromController(data as ControllerScript) : data as Script;
}

// === Scripts API ===

export async function listScripts(): Promise<Script[]> {
  const { data } = await getClient().http.get<unknown[]>('/scripts');
  return data.map(toScript);
}

export async function getScript(id: string): Promise<Script> {
  const { data } = await getClient().http.get(`/scripts/${id}`);
  return toScript(data);
}

export async function createScript(script: NewScript): Promise<Script> {
  try {
    if (isEnterprise()) {
      const { data } = await getClient().http.post('/scripts', {
        name: script.name,
        content: script.content,
        shared: script.shared || false,
      });
      return toScript(data);
    }

    const { data } = await getClient().http.post('/scripts', script);
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `Failed to create script (${axiosErr.response?.status})`);
  }
}

export async function updateScript(id: string, script: UpdateScript): Promise<Script> {
  try {
    const { data } = await getClient().http.put(`/scripts/${id}`, script);
    return toScript(data);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `Failed to update script (${axiosErr.response?.status})`);
  }
}

export async function deleteScript(id: string): Promise<void> {
  try {
    await getClient().http.delete(`/scripts/${id}`);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `Failed to delete script (${axiosErr.response?.status})`);
  }
}

/**
 * Approve an AI-authored script for execution. The backend audit-logs every
 * approval. Editing the script content via `updateScript()` will revoke
 * approval and require re-review.
 */
export async function approveScript(id: string): Promise<Script> {
  try {
    const { data } = await getClient().http.post(`/scripts/${id}/approve`);
    return toScript(data);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
    throw new Error(axiosErr.response?.data?.error || `Failed to approve script (${axiosErr.response?.status})`);
  }
}

export async function analyzeScript(id: string): Promise<ScriptAnalysis> {
  const { data } = await getClient().http.get(`/scripts/${id}/analyze`);
  return data;
}

/**
 * Run a script with streaming output (standalone mode only).
 * Uses SSE to stream real-time status, stderr (uv progress), stdout, and completion.
 */
export async function runScriptStream(
  id: string,
  options: RunScriptOptions | undefined,
  onEvent: (event: ScriptStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const client = getClient();
  const baseUrl = client.baseUrl;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // Get auth token for standalone mode
  const { getSidecarAuthToken } = await import('./localClient');
  const token = getSidecarAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Signal is plumbed all the way through fetch — aborting it closes the
  // SSE stream, which trips the backend's tx.closed() handler and kills
  // the underlying Python child (see agent/src/scripts.rs P1-4).
  const response = await fetch(`${baseUrl}/api/scripts/${id}/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options || {}),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Script execution failed (${response.status})`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const data = line.slice(5);
        if (currentEvent === 'complete') {
          try {
            onEvent({ event: 'complete', data: JSON.parse(data) });
          } catch {
            onEvent({ event: 'error', data: 'Failed to parse completion data' });
          }
        } else if (currentEvent === 'error' || currentEvent === 'status' || currentEvent === 'stderr' || currentEvent === 'stdout') {
          onEvent({ event: currentEvent, data });
        }
        currentEvent = '';
      }
    }
  }
}

export async function runScript(id: string, options?: RunScriptOptions, signal?: AbortSignal): Promise<ScriptOutput | MultiDeviceOutput> {
  if (isEnterprise()) {
    const client = getClient();
    // Trigger execution on the controller, passing device targeting options
    const body = options && (options.device_ids?.length || options.custom_input || options.main_args)
      ? options
      : undefined;
    let execution: ControllerExecution;
    try {
      const res = await client.http.post<ControllerExecution>(`/scripts/${id}/run`, body, { signal });
      execution = res.data;
    } catch (err: unknown) {
      // The controller returns 403 for AI-authored scripts awaiting approval
      // (the only 403 path in run_script). Surface the same friendly message
      // as the standalone APPROVAL_REQUIRED branch instead of a generic error.
      const axiosErr = err as { response?: { data?: { error?: string } | string; status?: number } };
      if (axiosErr.response?.status === 403) {
        const d = axiosErr.response.data;
        const serverMsg = typeof d === 'string' ? d : d?.error;
        throw new Error(
          serverMsg ||
          'This script was authored by the AI. Click "Approve" after reviewing the content before running.'
        );
      }
      throw err;
    }

    // Poll until execution completes. Exponential backoff on consecutive
    // errors so a transient controller blip doesn't hammer the API every
    // 1s for 2 minutes. signal lets the caller (e.g. tab close, Stop
    // button) cancel mid-poll.
    const execId = execution.id;
    const maxWait = 120000; // 2 minute timeout
    let pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (signal?.aborted) {
        throw new DOMException('Script execution polling aborted', 'AbortError');
      }
      let status: ControllerExecution;
      try {
        const res = await client.http.get<ControllerExecution>(`/scripts/executions/${execId}`, { signal });
        status = res.data;
        pollInterval = 1000;
      } catch (err) {
        // Re-throw aborts so callers see them. Otherwise back off and try
        // again — capped at 8s to avoid runaway waits on long outages.
        if ((err as Error).name === 'AbortError') throw err;
        pollInterval = Math.min(pollInterval * 2, 8000);
        await new Promise((r) => setTimeout(r, pollInterval));
        continue;
      }
      if (status.state === 'completed' || status.state === 'failed' || status.state === 'timeout') {
        const outputStr = status.output || '';
        // Try to parse as multi-device output
        if (options?.device_ids?.length) {
          try {
            const parsed = JSON.parse(outputStr);
            if (parsed.results && Array.isArray(parsed.results)) {
              return parsed as MultiDeviceOutput;
            }
          } catch { /* fall through to flat output */ }
        }
        return {
          stdout: outputStr,
          stderr: status.error_message || '',
          exit_code: status.state === 'completed' ? 0 : 1,
          duration_ms: status.started_at && status.completed_at
            ? new Date(status.completed_at).getTime() - new Date(status.started_at).getTime()
            : 0,
        };
      }
      // Sleep between polls, but wake immediately on abort so the caller
      // sees the AbortError without waiting up to pollInterval ms.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, pollInterval);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('Script execution polling aborted', 'AbortError'));
          }, { once: true });
        }
      });
    }

    return {
      stdout: '',
      stderr: 'Execution timed out waiting for results',
      exit_code: 1,
      duration_ms: maxWait,
    };
  }

  // Professional mode
  try {
    const { data } = await getClient().http.post(`/scripts/${id}/run`, options || {});
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string }; status?: number } };
    const code = axiosErr.response?.data?.code;
    // AUDIT FIX (EXEC-014): surface APPROVAL_REQUIRED with a clearer message.
    if (code === 'APPROVAL_REQUIRED') {
      throw new Error(
        axiosErr.response?.data?.error ||
        'This script was authored by the AI. Click "Approve" after reviewing the content before running.'
      );
    }
    throw new Error(axiosErr.response?.data?.error || `Failed to run script (${axiosErr.response?.status})`);
  }
}

export async function generateScript(
  prompt: string,
  signal?: AbortSignal
): Promise<GenerateScriptResponse> {
  const { provider, model } = resolveProvider();
  const body: Record<string, unknown> = { prompt };
  if (provider) body.provider = provider;
  if (model) body.model = model;

  try {
    const { data } = await getClient().http.post('/ai/generate-script', body, { signal });
    return data;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string }; status?: number } };
    const responseData = axiosErr.response?.data;

    // Handle AI not configured specifically
    if (axiosErr.response?.status === 503 || responseData?.code === 'NOT_CONFIGURED') {
      throw new AiNotConfiguredError(aiNotConfiguredMessage());
    }

    throw new Error(responseData?.error || 'Failed to generate script');
  }
}
