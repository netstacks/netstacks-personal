/**
 * MCP (Model Context Protocol) Server API
 *
 * Provides functions to manage MCP server connections and tool discovery.
 *
 * Whenever a state-changing call succeeds (add/delete server, connect/disconnect,
 * enable/disable tool) we dispatch a `mcp-state-changed` window event so other
 * parts of the app — notably useAIAgent's cached server snapshot — can refresh.
 * Without this, toggling a tool in Settings does not propagate to the AI side
 * panel until a full page reload.
 */

import { getClient } from './client';
import { getApiErrorMessage, isApiErrorCode } from './errors';

const MCP_STATE_CHANGED = 'mcp-state-changed';

function notifyMcpStateChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MCP_STATE_CHANGED));
  }
}

function toMcpError(
  err: unknown,
  fallback: string,
  vaultLockedMessage?: string,
): Error {
  if (vaultLockedMessage && isApiErrorCode(err, 'VAULT_LOCKED')) {
    return new Error(vaultLockedMessage);
  }
  return new Error(getApiErrorMessage(err, fallback));
}

export interface McpTool {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  input_schema: Record<string, unknown>;
}

/**
 * MCP server record. `auth_token_encrypted` / `auth_token` are intentionally
 * absent here — they live server-side and are only set/cleared via the
 * vault helper (see `AddMcpServerRequest.auth_token`). The presence of a
 * stored token is exposed indirectly via runtime fields below.
 *
 * Field provenance:
 *   - id, name, transport_type, command, args, url, auth_type, server_type,
 *     enabled  — stored in DB (mcp_servers table)
 *   - connected, tools — runtime/computed by the backend at list time;
 *     do not POST these back on update.
 */
export interface McpServer {
  id: string;
  name: string;
  transport_type: 'stdio' | 'sse';
  command: string;
  args: string[];
  url: string | null;
  auth_type: 'none' | 'bearer' | 'api-key';
  server_type: string;
  enabled: boolean;
  /** Computed: current client liveness, not persisted. */
  connected: boolean;
  /** Computed: tools discovered at last connect, not persisted. */
  tools: McpTool[];
}

export interface AddMcpServerRequest {
  name: string;
  transport_type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  auth_type?: string;
  auth_token?: string;
  server_type?: string;
}

/** Patch shape for updateMcpServer — all fields optional. Empty string
 *  for `auth_token` clears the stored token; absent leaves it alone. */
export interface UpdateMcpServerRequest {
  name?: string;
  transport_type?: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  auth_type?: string;
  auth_token?: string;
  server_type?: string;
}

export interface TestMcpServerResponse {
  success: boolean;
  message: string;
  tools_discovered: number;
}

/**
 * List all configured MCP servers
 */
export async function listMcpServers(): Promise<McpServer[]> {
  const { data } = await getClient().http.get('/mcp/servers');
  return Array.isArray(data) ? data : [];
}

/**
 * Add a new MCP server configuration.
 *
 * AUDIT FIX (CRYPTO-002): when an `auth_token` is supplied, the backend
 * requires the vault to be unlocked so it can encrypt the token before
 * storing it. We surface that error code with a friendlier message so the
 * UI can prompt the user to unlock first.
 */
export async function addMcpServer(req: AddMcpServerRequest): Promise<McpServer> {
  try {
    const { data } = await getClient().http.post('/mcp/servers', req);
    notifyMcpStateChanged();
    return data;
  } catch (err: unknown) {
    throw toMcpError(
      err,
      'Failed to add MCP server',
      'Unlock the vault before saving an MCP auth token — tokens are stored encrypted.',
    );
  }
}

/**
 * Delete an MCP server configuration
 */
export async function deleteMcpServer(id: string): Promise<void> {
  try {
    await getClient().http.delete(`/mcp/servers/${id}`);
    notifyMcpStateChanged();
  } catch (err: unknown) {
    throw toMcpError(err, 'Failed to delete MCP server');
  }
}

/**
 * Connect to an MCP server and discover tools.
 *
 * AUDIT FIX (CRYPTO-002): if the MCP server has an encrypted auth token
 * and the vault is locked, the backend returns 403 VAULT_LOCKED. Surface
 * with a clear message so the UI can prompt for unlock.
 */
export async function connectMcpServer(id: string): Promise<McpServer> {
  try {
    const { data } = await getClient().http.post(`/mcp/servers/${id}/connect`);
    notifyMcpStateChanged();
    return data;
  } catch (err: unknown) {
    throw toMcpError(
      err,
      'Failed to connect to MCP server',
      'Unlock the vault before connecting to this MCP server — its auth token is encrypted.',
    );
  }
}

/**
 * Disconnect from an MCP server
 */
export async function disconnectMcpServer(id: string): Promise<void> {
  try {
    await getClient().http.post(`/mcp/servers/${id}/disconnect`);
    notifyMcpStateChanged();
  } catch (err: unknown) {
    throw toMcpError(err, 'Failed to disconnect from MCP server');
  }
}

/**
 * Update an existing MCP server configuration. Backend disconnects the
 * server first (config changes need a fresh connect to take effect).
 */
export async function updateMcpServer(
  id: string,
  update: UpdateMcpServerRequest,
): Promise<McpServer> {
  try {
    const { data } = await getClient().http.put(`/mcp/servers/${id}`, update);
    notifyMcpStateChanged();
    return data;
  } catch (err: unknown) {
    throw toMcpError(
      err,
      'Failed to update MCP server',
      'Unlock the vault before changing the MCP auth token — tokens are stored encrypted.',
    );
  }
}

/**
 * Test an MCP server connection without persisting tools. Returns a
 * `{ success, message, tools_discovered }` payload. If the server is
 * already connected, just reports the live tool count rather than
 * tearing down the session.
 */
export async function testMcpServer(id: string): Promise<TestMcpServerResponse> {
  try {
    const { data } = await getClient().http.post(`/mcp/servers/${id}/test`);
    return data;
  } catch (err: unknown) {
    throw toMcpError(
      err,
      'Failed to test MCP server',
      'Unlock the vault before testing this MCP server — its auth token is encrypted.',
    );
  }
}

/**
 * Restart an MCP server — disconnect followed by reconnect. Useful when
 * a tool definition has changed on the server side and you need a fresh
 * discovery.
 */
export async function restartMcpServer(id: string): Promise<McpServer> {
  try {
    const { data } = await getClient().http.post(`/mcp/servers/${id}/restart`);
    notifyMcpStateChanged();
    return data;
  } catch (err: unknown) {
    throw toMcpError(
      err,
      'Failed to restart MCP server',
      'Unlock the vault before restarting this MCP server.',
    );
  }
}

/**
 * Set MCP tool enabled status (per-tool approval)
 */
export async function setMcpToolEnabled(toolId: string, enabled: boolean): Promise<void> {
  try {
    await getClient().http.put(`/mcp/tools/${toolId}/enabled`, { enabled });
    notifyMcpStateChanged();
  } catch (err: unknown) {
    throw toMcpError(err, 'Failed to update tool enabled status');
  }
}

/**
 * Execute an MCP tool
 */
export async function executeMcpTool(
  toolId: string,
  arguments_: Record<string, unknown>
): Promise<{ content: string; is_error: boolean }> {
  try {
    const { data } = await getClient().http.post(`/mcp/tools/${toolId}/execute`, { arguments: arguments_ });
    return data;
  } catch (err: unknown) {
    throw toMcpError(err, 'Failed to execute MCP tool');
  }
}
