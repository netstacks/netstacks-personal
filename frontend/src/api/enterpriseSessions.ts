// API client for enterprise session definitions (Controller API)

import { getClient } from './client';
import type {
  EnterpriseSession,
  CreateEnterpriseSession,
  UpdateEnterpriseSession,
  UserSessionFolder,
  CreateUserSessionFolder,
  UpdateUserSessionFolder,
  SessionAssignment,
  AssignSessionToFolder,
} from '../types/enterpriseSession';

// Re-export types for convenience
export type {
  EnterpriseSession,
  CreateEnterpriseSession,
  UpdateEnterpriseSession,
  UserSessionFolder,
  SessionAssignment,
} from '../types/enterpriseSession';

/**
 * List all session definitions for the current org.
 * Returns sessions with active connection counts.
 */
export async function listEnterpriseSessionDefinitions(): Promise<{
  items: EnterpriseSession[];
  total: number;
}> {
  const client = getClient();
  const res = await client.http.get('/session-definitions');
  return res.data;
}

/**
 * Get a single session definition by ID.
 */
export async function getSessionDefinition(id: string): Promise<EnterpriseSession> {
  const client = getClient();
  const res = await client.http.get(`/session-definitions/${id}`);
  return res.data;
}

/**
 * Create a new session definition.
 */
export async function createSessionDefinition(
  data: CreateEnterpriseSession
): Promise<EnterpriseSession> {
  const client = getClient();
  const res = await client.http.post('/session-definitions', data);
  return res.data;
}

/**
 * Update an existing session definition.
 */
export async function updateSessionDefinition(
  id: string,
  data: UpdateEnterpriseSession
): Promise<EnterpriseSession> {
  const client = getClient();
  const res = await client.http.put(`/session-definitions/${id}`, data);
  return res.data;
}

/**
 * Delete a session definition.
 * Cascades to user_session_assignments.
 */
export async function deleteSessionDefinition(id: string): Promise<void> {
  const client = getClient();
  await client.http.delete(`/session-definitions/${id}`);
}

/**
 * List all folders for the current user.
 */
export async function listUserFolders(): Promise<UserSessionFolder[]> {
  const client = getClient();
  const res = await client.http.get('/session-definitions/folders');
  return res.data;
}

/**
 * Create a new folder for the current user.
 */
export async function createUserFolder(
  name: string,
  parentId?: string | null
): Promise<UserSessionFolder> {
  const client = getClient();
  const data: CreateUserSessionFolder = {
    name,
    parent_id: parentId,
  };
  const res = await client.http.post('/session-definitions/folders', data);
  return res.data;
}

/**
 * Update a folder (rename or move).
 */
export async function updateUserFolder(
  id: string,
  data: UpdateUserSessionFolder
): Promise<UserSessionFolder> {
  const client = getClient();
  const res = await client.http.put(`/session-definitions/folders/${id}`, data);
  return res.data;
}

/**
 * Delete a user folder.
 * Moves contained sessions to root (folder_id = null).
 */
export async function deleteUserFolder(id: string): Promise<void> {
  const client = getClient();
  await client.http.delete(`/session-definitions/folders/${id}`);
}

/**
 * Assign a session definition to a folder (or root if null).
 * UPSERT behavior - updates existing assignment if one exists.
 */
export async function assignSessionToFolder(
  sessionId: string,
  folderId: string | null,
  sortOrder?: number
): Promise<void> {
  const client = getClient();
  const data: AssignSessionToFolder = {
    folder_id: folderId,
    sort_order: sortOrder,
  };
  await client.http.put(`/session-definitions/${sessionId}/folder`, data);
}

/**
 * List all session-to-folder assignments for the current user.
 */
export async function listUserAssignments(): Promise<SessionAssignment[]> {
  const client = getClient();
  try {
    const res = await client.http.get('/session-definitions/assignments');
    return res.data;
  } catch {
    // Endpoint not yet implemented on controller — return empty array
    return [];
  }
}
