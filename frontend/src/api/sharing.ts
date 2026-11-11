// API client for session sharing (enterprise mode only)

import { getClient } from './client';

export interface CreateShareParams {
  permission: 'read-only' | 'read-write';
  ttl_minutes?: number;
  max_viewers?: number;
}

export interface CreateShareResponse {
  share_url: string;
  token: string;
  expires_at: string;
}

export interface ShareInfo {
  session_id: string;
  token: string;
  permission: string;
  max_viewers: number;
  viewer_count: number;
  expires_at: string;
  created_by: string;
}

export interface ShareListItem {
  token: string;
  permission: string;
  max_viewers: number;
  created_at: string;
  expires_at: string;
}

/**
 * List active shares for a session.
 */
export async function listSessionShares(
  sessionId: string,
): Promise<ShareListItem[]> {
  const { data } = await getClient().http.get(
    `/sessions/${sessionId}/share`,
  );
  return data;
}

/**
 * Create a share link for a session.
 */
export async function createSessionShare(
  sessionId: string,
  params: CreateShareParams,
): Promise<CreateShareResponse> {
  const { data } = await getClient().http.post(
    `/sessions/${sessionId}/share`,
    params,
  );
  return data;
}

/**
 * Get share info for a session.
 */
export async function getSessionShare(
  sessionId: string,
  token: string,
): Promise<ShareInfo> {
  const { data } = await getClient().http.get(
    `/sessions/${sessionId}/share/${token}`,
  );
  return data;
}

/**
 * Revoke (delete) a share link.
 */
export async function revokeSessionShare(
  sessionId: string,
  token: string,
): Promise<void> {
  await getClient().http.delete(`/sessions/${sessionId}/share/${token}`);
}
