/**
 * REST API wrapper for LSP plugin installation endpoints.
 * Uses the existing API client pattern from `frontend/src/api/client.ts`.
 *
 * IMPORTANT: LSP routes are mounted at `/lsp/*` (NOT `/api/lsp/*`).
 * The `http` axios instance has baseURL = `${SERVER}/api`, so we override
 * with `baseURL: apiClient.baseUrl` per-request to hit `/lsp/plugins` directly.
 * This works in both modes: standalone hits the local agent, enterprise hits
 * the Controller (`${controllerUrl}/lsp/*`) with the JWT interceptors intact.
 */

import axios from 'axios';
import type { LspPluginListItem } from './types';
import { getClient } from '../api/client';
import { getSidecarAuthToken } from '../api/localClient';
import { useAuthStore } from '../stores/authStore';

// Re-export types for consumers
export type { LspPluginListItem } from './types';

/**
 * Thrown when the connected Controller does not expose the LSP surface
 * (old Controllers 404 on /lsp/plugins, or serve a non-JSON body for
 * unknown routes). Callers degrade gracefully instead of hard-failing.
 */
export class LspUnavailableError extends Error {
  constructor() {
    super('LSP is not available on this Controller');
    this.name = 'LspUnavailableError';
  }
}

/**
 * GET /lsp/plugins — list all plugins (built-in + user-added) with
 * computed install status. Used by the Settings UI (Phase 5) and the
 * useLspClient hook (next task) to decide whether to attempt a WS
 * connection or surface an install banner.
 */
export async function listPlugins(): Promise<LspPluginListItem[]> {
  const apiClient = getClient();

  let data: unknown;
  try {
    // Override baseURL to hit /lsp/plugins instead of /api/lsp/plugins
    ({ data } = await apiClient.http.get<LspPluginListItem[]>('/lsp/plugins', {
      baseURL: apiClient.baseUrl,
    }));
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      throw new LspUnavailableError();
    }
    throw err;
  }

  if (!Array.isArray(data)) {
    // e.g. an old Controller serving the SPA shell (HTML) for unknown routes
    throw new LspUnavailableError();
  }

  return data;
}

/**
 * POST /lsp/plugins/:id/install — start an install (returns 202 Accepted).
 * Then subscribe to install-progress SSE to track completion.
 */
export async function installPlugin(pluginId: string): Promise<void> {
  const apiClient = getClient();
  await apiClient.http.post(
    `/lsp/plugins/${encodeURIComponent(pluginId)}/install`,
    null,
    { baseURL: apiClient.baseUrl }
  );
}

/**
 * DELETE /lsp/plugins/:id — uninstall the plugin.
 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  const apiClient = getClient();
  await apiClient.http.delete(
    `/lsp/plugins/${encodeURIComponent(pluginId)}`,
    { baseURL: apiClient.baseUrl }
  );
}

/**
 * Input for creating a user-added plugin (POST /lsp/plugins).
 */
export interface UserPluginInput {
  id: string;
  displayName: string;
  language: string;
  fileExtensions: string[];
  command: string;
  args: string[];
  envVars: Record<string, string>;
}

/**
 * Input for updating a plugin (PUT /lsp/plugins/:id).
 * For built-ins, only command and args can be overridden.
 * For user-added, any field can be updated.
 */
export interface PluginUpdateInput {
  displayName?: string;
  language?: string;
  fileExtensions?: string[];
  command?: string;
  args?: string[];
  enabled?: boolean;
}

/**
 * Result from testing a plugin command (POST /lsp/plugins/test).
 */
export interface TestCommandResult {
  success: boolean;
  errorMessage?: string;
  stderr?: string;
}

/**
 * POST /lsp/plugins — create a user-added plugin.
 * Returns 201 with descriptor on success, 409 on conflict.
 */
export async function createUserPlugin(input: UserPluginInput): Promise<LspPluginListItem> {
  const apiClient = getClient();
  const { data } = await apiClient.http.post<LspPluginListItem>(
    '/lsp/plugins',
    input,
    { baseURL: apiClient.baseUrl }
  );
  return data;
}

/**
 * PUT /lsp/plugins/:id — update a plugin.
 * For built-ins: writes overrides to .netstacks-lsp/overrides.json.
 * For user-added: updates the descriptor in .netstacks-lsp/user-plugins.json.
 */
export async function updatePlugin(id: string, input: PluginUpdateInput): Promise<LspPluginListItem> {
  const apiClient = getClient();
  const { data } = await apiClient.http.put<LspPluginListItem>(
    `/lsp/plugins/${encodeURIComponent(id)}`,
    input,
    { baseURL: apiClient.baseUrl }
  );
  return data;
}

/**
 * DELETE /lsp/plugins/:id — remove a plugin.
 * For user-added: removes from user-plugins.json.
 * For built-in: routes to uninstall (deletes binary).
 */
export async function deletePlugin(id: string): Promise<void> {
  const apiClient = getClient();
  await apiClient.http.delete(
    `/lsp/plugins/${encodeURIComponent(id)}`,
    { baseURL: apiClient.baseUrl }
  );
}

/**
 * POST /lsp/plugins/test — spawn candidate command, send LSP initialize, return result.
 */
export async function testPluginCommand(command: string, args: string[]): Promise<TestCommandResult> {
  const apiClient = getClient();
  const { data } = await apiClient.http.post<TestCommandResult>(
    '/lsp/plugins/test',
    { command, args },
    { baseURL: apiClient.baseUrl }
  );
  return data;
}

/** Server-Sent Event payload from /lsp/plugins/:id/install-progress */
export interface InstallEvent {
  phase: 'downloading' | 'verifying' | 'extracting' | 'smoke-testing' | 'done' | 'error';
  bytesDownloaded?: number;
  totalBytes?: number | null;
  error?: string;
}

/**
 * Subscribe to install progress via SSE. Returns an unsubscribe function.
 * The browser EventSource auto-reconnects on transient failures; the
 * caller's onClose handler runs when the server sends `event: end` or
 * closes the stream after `done`.
 */
export function subscribeToInstallProgress(
  pluginId: string,
  onEvent: (e: InstallEvent) => void,
  onError: (err: Error) => void
): () => void {
  const apiClient = getClient();
  // Enterprise authenticates with the user's JWT; standalone with the sidecar token.
  const rawToken =
    apiClient.mode === 'enterprise'
      ? useAuthStore.getState().accessToken
      : getSidecarAuthToken();
  const token = encodeURIComponent(rawToken ?? '');
  const url = `${apiClient.baseUrl}/lsp/plugins/${encodeURIComponent(pluginId)}/install-progress?token=${token}`;

  // SSE: browser EventSource doesn't support custom headers, so token rides as query param.
  const es = new EventSource(url);
  es.addEventListener('progress', (msg) => {
    try {
      onEvent(JSON.parse((msg as MessageEvent).data) as InstallEvent);
    } catch (e) {
      onError(new Error(`bad SSE payload: ${(e as Error).message}`));
    }
  });
  es.onerror = () => {
    onError(new Error('SSE connection failed'));
  };
  return () => es.close();
}
