// AI conversation history (DB-backed). The side panel saves each conversation
// here so it persists across closing the panel and app restarts.
//
// Circuit breaker: in enterprise mode these calls route to the Controller,
// which may not implement `/ai-conversations` yet (→ 404). The first 404 flips
// `endpointMissing` so subsequent calls short-circuit (no network) instead of
// hammering a 404 on every chat message. Standalone (local agent supports the
// endpoints) never trips it. It auto-recovers per app session if the backend
// starts supporting them after a reload.

import { getClient } from './client';
import { createCrudApi } from './crudFactory';
import type { AgentMessage } from '../hooks/useAIAgent';

export interface AiConversationSummary {
  id: string;
  title: string;
  agent_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiConversation extends AiConversationSummary {
  messages: AgentMessage[];
}

export interface NewAiConversation {
  title?: string;
  messages?: AgentMessage[];
  agent_type?: string | null;
}

export interface UpdateAiConversation {
  title?: string;
  messages?: AgentMessage[];
}

const api = createCrudApi<AiConversation, NewAiConversation, UpdateAiConversation>('/ai-conversations');

let endpointMissing = false;

/** True when the backend returned 404 — i.e. it doesn't implement these routes. */
function isNotFound(e: unknown): boolean {
  return !!(
    e &&
    typeof e === 'object' &&
    'response' in e &&
    (e as { response?: { status?: number } }).response?.status === 404
  );
}

/** Whether conversation persistence is currently usable (false after a 404). */
export function aiConversationsAvailable(): boolean {
  return !endpointMissing;
}

export async function listAiConversations(): Promise<AiConversationSummary[]> {
  if (endpointMissing) return [];
  try {
    return (await api.list()) as unknown as AiConversationSummary[];
  } catch (e) {
    if (isNotFound(e)) endpointMissing = true;
    return [];
  }
}

export async function getAiConversation(id: string): Promise<AiConversation> {
  if (endpointMissing) throw new Error('ai-conversations endpoint unavailable');
  try {
    const { data } = await getClient().http.get(`/ai-conversations/${id}`);
    return data;
  } catch (e) {
    if (isNotFound(e)) endpointMissing = true;
    throw e;
  }
}

export async function createAiConversation(body: NewAiConversation): Promise<AiConversation> {
  if (endpointMissing) throw new Error('ai-conversations endpoint unavailable');
  try {
    return await api.create(body);
  } catch (e) {
    if (isNotFound(e)) endpointMissing = true;
    throw e;
  }
}

export async function updateAiConversation(
  id: string,
  body: UpdateAiConversation,
): Promise<AiConversation> {
  if (endpointMissing) throw new Error('ai-conversations endpoint unavailable');
  try {
    return await api.update(id, body);
  } catch (e) {
    if (isNotFound(e)) endpointMissing = true;
    throw e;
  }
}

export async function deleteAiConversation(id: string): Promise<void> {
  if (endpointMissing) return;
  try {
    await api.delete(id);
  } catch (e) {
    if (isNotFound(e)) endpointMissing = true;
  }
}
