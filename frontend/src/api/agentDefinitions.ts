/**
 * REST API client for agent definition management
 *
 * Agent definitions are named, reusable AI agent configurations with
 * custom system prompts, model settings, and execution parameters.
 *
 * - Standalone mode: Uses local agent's /agent-definitions endpoint
 * - Enterprise mode: Uses Controller's /api/agents endpoint
 */

import { getClient, getCurrentMode } from './client';
import type { AgentTask } from '../types/tasks';

const isEnterprise = () => getCurrentMode() === 'enterprise';

/** Agent definition record (union of standalone and enterprise fields) */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  max_iterations: number;
  max_tokens: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  // Enterprise-only fields
  agent_type?: string;
  protocol?: string | null;
  auto_triage_enabled?: boolean;
}

/** Request to create an agent definition */
export interface CreateAgentDefinitionRequest {
  name: string;
  description?: string;
  system_prompt: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_iterations?: number;
  max_tokens?: number;
}

/** Request to update an agent definition */
export interface UpdateAgentDefinitionRequest {
  name?: string;
  description?: string;
  system_prompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_iterations?: number;
  max_tokens?: number;
  enabled?: boolean;
}

/** List all agent definitions */
export async function listAgentDefinitions(): Promise<AgentDefinition[]> {
  const client = getClient();

  if (isEnterprise()) {
    const response = await client.http.get('/agents', { params: { enabled_only: false } });
    return Array.isArray(response.data) ? response.data : [];
  }

  const response = await client.http.get('/agent-definitions');
  return Array.isArray(response.data) ? response.data : [];
}

/** Get a single agent definition */
export async function getAgentDefinition(id: string): Promise<AgentDefinition> {
  const client = getClient();

  if (isEnterprise()) {
    const response = await client.http.get(`/agents/${id}`);
    return response.data;
  }

  const response = await client.http.get(`/agent-definitions/${id}`);
  return response.data;
}

/** Create a new agent definition */
export async function createAgentDefinition(req: CreateAgentDefinitionRequest): Promise<AgentDefinition> {
  const client = getClient();

  if (isEnterprise()) {
    // Controller requires agent_type, provider, and model as non-optional fields
    const body = {
      ...req,
      agent_type: 'custom',
      provider: req.provider || 'anthropic',
      model: req.model || 'claude-sonnet-4-5-20250929',
    };
    const response = await client.http.post('/agents', body);
    return response.data;
  }

  const response = await client.http.post('/agent-definitions', req);
  return response.data;
}

/** Update an existing agent definition */
export async function updateAgentDefinition(id: string, req: UpdateAgentDefinitionRequest): Promise<void> {
  const client = getClient();

  if (isEnterprise()) {
    await client.http.put(`/agents/${id}`, req);
    return;
  }

  await client.http.put(`/agent-definitions/${id}`, req);
}

/** Delete an agent definition */
export async function deleteAgentDefinition(id: string): Promise<void> {
  const client = getClient();

  if (isEnterprise()) {
    await client.http.delete(`/agents/${id}`);
    return;
  }

  await client.http.delete(`/agent-definitions/${id}`);
}

/** Run an agent definition (creates and executes a task) */
export async function runAgentDefinition(id: string, prompt: string): Promise<AgentTask> {
  const client = getClient();

  if (isEnterprise()) {
    // Enterprise: use the controller's run endpoint
    // Response is an AgentExecution object - map to AgentTask format
    const response = await client.http.post(`/agents/${id}/run`, { prompt });
    const exec = response.data;
    return mapExecutionToTask(exec);
  }

  const response = await client.http.post(`/agent-definitions/${id}/run`, { prompt });
  return response.data;
}

/**
 * List agent executions from the controller (enterprise mode).
 * Maps AgentExecution[] to ListTasksResponse format.
 */
export async function listAgentExecutions(params?: { limit?: number }): Promise<{
  tasks: AgentTask[];
  running_count: number;
  max_concurrent: number;
}> {
  const client = getClient();
  const response = await client.http.get('/agents/executions', { params });
  const executions: Array<Record<string, unknown>> = Array.isArray(response.data) ? response.data : [];

  const tasks = executions.map(mapExecutionToTask);
  const running_count = tasks.filter(t => t.status === 'running').length;

  return { tasks, running_count, max_concurrent: 10 };
}

/** Map a controller AgentExecution to the terminal's AgentTask format */
function mapExecutionToTask(exec: Record<string, unknown>): AgentTask {
  const state = (exec.state as string) || 'running';
  const status = mapState(state);
  const finalAnswer = (exec.final_answer as string) || null;
  const iterations = (exec.iterations_used as number) || 0;
  const toolCalls = (exec.tool_calls_made as number) || 0;

  // Build result_json from execution fields
  let result_json: string | null = null;
  if (finalAnswer) {
    result_json = JSON.stringify({
      status: state === 'completed' ? 'success' : state,
      answer: finalAnswer,
      iterations,
      tool_calls: toolCalls,
    });
  }

  return {
    id: exec.id as string,
    prompt: (exec.input_task as string) || '',
    status,
    progress_pct: status === 'completed' ? 100 : status === 'running' ? 50 : 0,
    result_json,
    error_message: (exec.error_message as string) || null,
    created_at: (exec.started_at as string) || new Date().toISOString(),
    updated_at: (exec.completed_at as string) || (exec.started_at as string) || new Date().toISOString(),
    started_at: (exec.started_at as string) || null,
    completed_at: (exec.completed_at as string) || null,
    agent_definition_id: (exec.agent_id as string) || null,
  };
}

function mapState(state: string): AgentTask['status'] {
  switch (state?.toLowerCase()) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'timeout': return 'failed';
    case 'running': return 'running';
    case 'approval_pending': return 'running';
    default: return 'pending';
  }
}
