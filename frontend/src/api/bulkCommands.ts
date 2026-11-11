// API client for bulk command execution across multiple SSH sessions

import { getClient } from './client';

/**
 * Request to execute a command on multiple sessions
 */
export interface BulkCommandRequest {
  sessionIds: string[];
  command: string;
  timeoutSecs?: number;
}

/**
 * Status of command execution on a single session
 */
export type CommandStatus = 'success' | 'error' | 'timeout' | 'authfailed';

/**
 * Result of command execution on a single session
 */
export interface CommandResult {
  sessionId: string;
  sessionName: string;
  host: string;
  status: CommandStatus;
  output: string;
  error: string | null;
  executionTimeMs: number;
}

/**
 * Response from bulk command execution
 */
export interface BulkCommandResponse {
  results: CommandResult[];
  totalTimeMs: number;
  successCount: number;
  errorCount: number;
}

/**
 * API error response
 */
export interface ApiError {
  error: string;
  code: string;
}

/**
 * Transform snake_case response to camelCase
 */
function transformResult(raw: Record<string, unknown>): CommandResult {
  return {
    sessionId: raw.session_id as string,
    sessionName: raw.session_name as string,
    host: raw.host as string,
    status: raw.status as CommandStatus,
    output: raw.output as string,
    error: raw.error as string | null,
    executionTimeMs: raw.execution_time_ms as number,
  };
}

/**
 * Transform snake_case response to camelCase
 */
function transformResponse(raw: Record<string, unknown>): BulkCommandResponse {
  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const results = rawResults.map(transformResult);
  return {
    results,
    totalTimeMs: raw.total_time_ms as number,
    successCount: raw.success_count as number,
    errorCount: raw.error_count as number,
  };
}

/**
 * Execute a command on multiple SSH sessions
 *
 * @param request - The bulk command request with session IDs, command, and optional timeout
 * @returns The bulk command response with results from each session
 * @throws Error if the request fails or validation errors occur
 */
export async function executeBulkCommand(
  request: BulkCommandRequest
): Promise<BulkCommandResponse> {
  // Transform camelCase to snake_case for backend
  const body = {
    session_ids: request.sessionIds,
    command: request.command,
    timeout_secs: request.timeoutSecs,
  };

  try {
    const { data } = await getClient().http.post('/bulk-command', body);
    return transformResponse(data as Record<string, unknown>);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string; code?: string } } };
    const errorData = axiosErr.response?.data;
    throw new Error(errorData?.error || 'Failed to execute bulk command');
  }
}
