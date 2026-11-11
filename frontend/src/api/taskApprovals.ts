// Task interaction API (AUDIT FIX EXEC-017, Feature B).
//
// Background ReAct tasks pause on a tool call their permission settings put
// to the user (Settings → AI, Auto Pilot), or on an ask_user question. The
// InteractionPanel polls this surface while a task runs and resolves each one.

import { getClient } from './client';

// ── Feature B: typed interactions (generalizes the binary approval) ──────────

export type InteractionKind = 'approval' | 'question';

/** A parked interaction awaiting the user. Mirrors the Rust PendingInteraction
 *  (snake_case on the wire — these list endpoints are NOT camelCase). */
export interface PendingInteraction {
  id: string;
  task_id: string;
  kind: InteractionKind;
  prompt: string;
  choices?: string[];
  tool_name?: string;
  tool_input?: unknown;
  diff?: string;
  created_at: string;
}

/** Typed body for the resolve endpoint (mirrors the Rust HumanResponse). */
export type ResolveBody =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'answer_structured'; json: unknown };

/** GET /api/task-approvals — every pending interaction (the existing list
 *  endpoint now returns typed PendingInteraction rows). */
export async function listAllPendingInteractions(): Promise<PendingInteraction[]> {
  const { data } = await getClient().http.get('/task-approvals');
  return Array.isArray(data) ? data : [];
}

/** GET /api/tasks/:task_id/pending-approvals — pending interactions for one
 *  task (now typed). Used by the agent-run tab to show inline questions. */
export async function listTaskPendingInteractions(taskId: string): Promise<PendingInteraction[]> {
  const { data } = await getClient().http.get(`/tasks/${taskId}/pending-approvals`);
  return Array.isArray(data) ? data : [];
}

/** POST /api/task-interactions/:id/resolve — typed resolution (approve /
 *  reject / free-text answer). */
export async function resolveInteraction(id: string, body: ResolveBody): Promise<void> {
  await getClient().http.post(`/task-interactions/${id}/resolve`, body);
}
