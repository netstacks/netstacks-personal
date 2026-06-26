// API client for session context (tribal knowledge)

import type {
  SessionContext,
  NewSessionContext,
  UpdateSessionContext,
} from '../types/sessionContext';
import { getClient } from './client';

/**
 * List all context entries for a session.
 * Returns entries sorted by created_at DESC (newest first).
 */
export async function listSessionContext(
  sessionId: string
): Promise<SessionContext[]> {
  const { data } = await getClient().http.get(`/sessions/${sessionId}/context`);
  return data;
}

/**
 * List context entries for a Controller device (enterprise / device-keyed).
 * Mirrors device-memory's device-keyed variant. Entries are shared org-wide
 * for the device. Returns newest-first.
 */
export async function listSessionContextForDevice(
  deviceId: string
): Promise<SessionContext[]> {
  const { data } = await getClient().http.get(`/devices/${deviceId}/context`);
  return data;
}

/**
 * Create a context entry for a Controller device (enterprise / device-keyed).
 */
export async function createSessionContextForDevice(
  deviceId: string,
  context: Omit<NewSessionContext, 'session_id'>
): Promise<SessionContext> {
  const { data } = await getClient().http.post(`/devices/${deviceId}/context`, {
    ...context,
    session_id: `device-${deviceId}`,
  });
  return data;
}

/**
 * Get a single context entry by ID.
 */
export async function getContext(contextId: string): Promise<SessionContext> {
  const { data } = await getClient().http.get(`/context/${contextId}`);
  return data;
}

/**
 * Create a new context entry for a session.
 * The session_id is taken from the path parameter.
 */
export async function createSessionContext(
  sessionId: string,
  context: Omit<NewSessionContext, 'session_id'>
): Promise<SessionContext> {
  const { data } = await getClient().http.post(`/sessions/${sessionId}/context`, {
    ...context,
    session_id: sessionId,
  });
  return data;
}

/**
 * Update an existing context entry.
 */
export async function updateContext(
  contextId: string,
  update: UpdateSessionContext
): Promise<SessionContext> {
  const { data } = await getClient().http.put(`/context/${contextId}`, update);
  return data;
}

/**
 * Delete a context entry.
 */
export async function deleteContext(contextId: string): Promise<void> {
  await getClient().http.delete(`/context/${contextId}`);
}

/**
 * Get all context for multiple sessions (batch).
 * Useful for loading context when connecting to devices.
 * Returns a Map keyed by session ID.
 */
export async function batchListSessionContext(
  sessionIds: string[]
): Promise<Map<string, SessionContext[]>> {
  const results = new Map<string, SessionContext[]>();

  // Fetch in parallel
  const promises = sessionIds.map(async (id) => {
    try {
      const contexts = await listSessionContext(id);
      results.set(id, contexts);
    } catch {
      // On error, set empty array (session may have no context)
      results.set(id, []);
    }
  });

  await Promise.all(promises);
  return results;
}
