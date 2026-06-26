// Profiling Agents Plugin API client

import { getClient } from './client';

const PLUGIN_BASE = '/plugins/profiling-agents';

// ============================================================================
// Types
// ============================================================================

export interface ProfilingAgent {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  provider: string;
  model: string;
  cycle_model: string | null;
  temperature: number;
  max_iterations: number;
  active: boolean;
  activated_at: string | null;
  proactive_enabled: boolean;
  proactive_channels: string[];
  awareness_interval_mins: number;
  anomaly_rules: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface DeviceState {
  id: string;
  agent_id: string;
  device_id: string;
  state_summary: string | null;
  structured_state: Record<string, unknown> | null;
  health_score: number | null;
  config_digest: string | null;
  behavioral_profile: Record<string, unknown> | null;
  baseline_status: string | null;
  last_telemetry_at: string | null;
  updated_at: string;
}

export type AnomalySeverity = 'critical' | 'warning' | 'info';

export interface AnomalyEvent {
  id: string;
  agent_id: string;
  device_id: string;
  severity: AnomalySeverity;
  anomaly_type: string;
  description: string;
  metric_path: string | null;
  current_value: number | null;
  baseline_value: number | null;
  ai_summary: string | null;
  source: string;
  acknowledged: boolean;
  acknowledged_by: string | null;
  created_at: string;
}

export interface WatchRule {
  id: string;
  agent_id: string;
  device_id: string | null;
  name: string;
  rule_type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_by: string;
  suppressed_until: string | null;
  suppression_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentMeshEntry {
  id: string;
  agent_id: string;
  coordinator: boolean;
  topology_score: number;
  parent_agent_id: string | null;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  message_type: string;
  content: Record<string, unknown>;
  context: Record<string, unknown> | null;
  priority: number;
  expects_reply: boolean;
  reply_to_id: string | null;
  processed: boolean;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatConversation {
  messages: ChatMessage[];
}

export interface ChatContextResponse {
  agent: ProfilingAgent;
  device_states: DeviceState[];
  anomalies: AnomalyEvent[];
  watch_rules: WatchRule[];
  conversation_history: ChatMessage[];
}

export interface ChatResponse {
  response: string;
  tool_calls_made: number;
}

export interface NotificationLog {
  id: string;
  agent_id: string;
  device_id: string | null;
  channel: string;
  severity: AnomalySeverity;
  summary: string;
  context: Record<string, unknown> | null;
  delivered: boolean;
  error: string | null;
  created_at: string;
}

export interface CreateAgentInput {
  name: string;
  description?: string | null;
  system_prompt: string;
  provider: string;
  model: string;
  cycle_model?: string | null;
  temperature?: number;
  max_iterations?: number;
  proactive_enabled?: boolean;
  proactive_channels?: string[];
  awareness_interval_mins?: number;
  anomaly_rules?: Record<string, unknown> | null;
}

export interface AssignDeviceInput {
  device_id: string;
  subscription_config_id?: string | null;
}

export interface SendChatMessageInput {
  message: string;
  user_id: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * List all profiling agents
 */
export async function listAgents(): Promise<ProfilingAgent[]> {
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/agents`);
  // Handle both wrapped { agents: [...] } and raw array responses
  return Array.isArray(data) ? data : (data.agents || []);
}

/**
 * Get a single profiling agent by ID
 */
export async function getAgent(id: string): Promise<ProfilingAgent> {
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/agents/${id}`);
  // Handle both wrapped { agent: {...} } and raw object responses
  return data.agent || data;
}

/**
 * Create a new profiling agent
 */
export async function createAgent(input: CreateAgentInput): Promise<ProfilingAgent> {
  const { data } = await getClient().http.post(`${PLUGIN_BASE}/admin/agents`, input);
  // Handle both wrapped { agent: {...} } and raw object responses
  return data.agent || data;
}

/**
 * Delete a profiling agent
 */
export async function deleteAgent(id: string): Promise<void> {
  await getClient().http.delete(`${PLUGIN_BASE}/admin/agents/${id}`);
}

/**
 * Activate a profiling agent
 */
export async function activateAgent(id: string): Promise<ProfilingAgent> {
  const { data } = await getClient().http.post(`${PLUGIN_BASE}/admin/agents/${id}/activate`);
  // Handle both wrapped { agent: {...} } and raw object responses
  return data.agent || data;
}

/**
 * Deactivate a profiling agent
 */
export async function deactivateAgent(id: string): Promise<ProfilingAgent> {
  const { data } = await getClient().http.post(`${PLUGIN_BASE}/admin/agents/${id}/deactivate`);
  // Handle both wrapped { agent: {...} } and raw object responses
  return data.agent || data;
}

/**
 * List devices assigned to an agent
 */
export async function listAgentDevices(id: string): Promise<DeviceState[]> {
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/agents/${id}/devices`);
  // Handle both wrapped { devices: [...] } and raw array responses
  return Array.isArray(data) ? data : (data.devices || []);
}

/**
 * Assign a device to an agent
 */
export async function assignDevice(
  agentId: string,
  deviceId: string,
  subscriptionConfigId?: string | null
): Promise<DeviceState> {
  const { data } = await getClient().http.post(
    `${PLUGIN_BASE}/admin/agents/${agentId}/devices`,
    {
      device_id: deviceId,
      subscription_config_id: subscriptionConfigId,
    }
  );
  // Handle both wrapped { device_state: {...} } and raw object responses
  return data.device_state || data;
}

/**
 * Unassign a device from an agent
 */
export async function unassignDevice(agentId: string, deviceId: string): Promise<void> {
  await getClient().http.delete(`${PLUGIN_BASE}/admin/agents/${agentId}/devices/${deviceId}`);
}

/**
 * Get chat context for an agent and user
 */
export async function getChatContext(agentId: string, userId: string): Promise<ChatContextResponse> {
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/agents/${agentId}/chat`, {
    params: { user_id: userId },
  });
  return data;
}

/**
 * Send a chat message to an agent
 */
export async function sendChatMessage(
  agentId: string,
  message: string,
  userId: string
): Promise<ChatResponse> {
  const { data } = await getClient().http.post(`${PLUGIN_BASE}/admin/agents/${agentId}/chat`, {
    message,
    user_id: userId,
  });
  return data;
}

/**
 * List anomalies detected by an agent
 */
export async function listAnomalies(agentId: string, hours?: number): Promise<AnomalyEvent[]> {
  const params = hours ? { hours } : {};
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/agents/${agentId}/anomalies`, {
    params,
  });
  // Handle both wrapped { anomalies: [...] } and raw array responses
  return Array.isArray(data) ? data : (data.anomalies || []);
}

/**
 * Acknowledge an anomaly
 */
export async function acknowledgeAnomaly(agentId: string, anomalyId: string): Promise<AnomalyEvent> {
  const { data } = await getClient().http.post(
    `${PLUGIN_BASE}/admin/agents/${agentId}/anomalies/${anomalyId}/acknowledge`
  );
  // Handle both wrapped { anomaly: {...} } and raw object responses
  return data.anomaly || data;
}

/**
 * List notification logs for an agent
 */
export async function listNotifications(agentId: string): Promise<NotificationLog[]> {
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/agents/${agentId}/notifications`);
  // Handle both wrapped { notifications: [...] } and raw array responses
  return Array.isArray(data) ? data : (data.notifications || []);
}

/**
 * Get agent mesh topology
 */
export async function getMesh(): Promise<AgentMeshEntry[]> {
  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/mesh`);
  // Handle both wrapped { mesh: [...] } and raw array responses
  return Array.isArray(data) ? data : (data.mesh || []);
}

/**
 * Trigger a coordinator election
 */
export async function triggerElection(): Promise<void> {
  await getClient().http.post(`${PLUGIN_BASE}/admin/mesh/elect`);
}

/**
 * List inter-agent messages
 */
export async function listMessages(agentId?: string, hours?: number): Promise<AgentMessage[]> {
  const params: Record<string, string | number> = {};
  if (agentId) params.agent_id = agentId;
  if (hours) params.hours = hours;

  const { data } = await getClient().http.get(`${PLUGIN_BASE}/admin/messages`, { params });
  // Handle both wrapped { messages: [...] } and raw array responses
  return Array.isArray(data) ? data : (data.messages || []);
}
