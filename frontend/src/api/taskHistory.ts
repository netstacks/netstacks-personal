/**
 * taskHistory.ts - API client for task execution history search (Enterprise)
 *
 * Provides search and browse operations for task execution history.
 */

import { getClient } from './client';

export interface TaskHistoryResult {
  execution_id: string;
  task_id: string;
  task_name: string;
  prompt: string | null;
  state: string;
  output: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  relevance: number;
}

export interface TaskExecutionSummary {
  id: string;
  task_id: string;
  task_name: string;
  prompt: string | null;
  state: string;
  created_at: string;
  completed_at: string | null;
}

export interface SearchResponse {
  results: TaskHistoryResult[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListHistoryResponse {
  executions: TaskExecutionSummary[];
  limit: number;
  offset: number;
}

/**
 * Search task history by prompt text
 */
export async function searchTaskHistory(
  query: string,
  limit = 20,
  offset = 0
): Promise<SearchResponse> {
  const response = await getClient().http.get<SearchResponse>(
    `/agent-tasks/history/search`,
    {
      params: {
        q: query,
        limit,
        offset,
      },
    }
  );
  return response.data;
}

/**
 * List recent task executions (browse without search)
 */
export async function listTaskHistory(
  taskId?: string,
  limit = 50,
  offset = 0
): Promise<ListHistoryResponse> {
  const params: Record<string, string | number> = { limit, offset };
  if (taskId) {
    params.task_id = taskId;
  }
  const response = await getClient().http.get<ListHistoryResponse>(
    '/agent-tasks/history',
    { params }
  );
  return response.data;
}

/**
 * Get single execution details
 */
export async function getTaskExecution(
  executionId: string
): Promise<TaskExecutionSummary> {
  const response = await getClient().http.get<TaskExecutionSummary>(
    `/agent-tasks/history/${executionId}`
  );
  return response.data;
}
