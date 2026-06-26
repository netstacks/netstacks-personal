// API client for enterprise credentials (Controller API)

import { getClient } from './client';
import type { AccessibleCredential } from '../types/enterpriseCredential';

/**
 * List all credentials the current user has access to.
 * Returns safe metadata only (name, type, host, username) - never secrets.
 * Zero standing privileges: credentials stay on Controller, only metadata in Terminal.
 */
export async function listAccessibleCredentials(): Promise<AccessibleCredential[]> {
  const client = getClient();
  const res = await client.http.get('/credentials/accessible');
  return res.data.items;
}

/**
 * Get the user's default credential (first accessible SSH credential alphabetically).
 * Returns null if user has no accessible SSH credentials.
 */
export async function getUserDefaultCredential(): Promise<AccessibleCredential | null> {
  const client = getClient();
  const res = await client.http.get('/credentials/accessible/default');
  return res.data;
}

/**
 * List the current user's personal credentials.
 * Returns credentials where owner_id = current user.
 */
export async function listPersonalCredentials(): Promise<PersonalCredentialSummary[]> {
  const client = getClient();
  const res = await client.http.get('/credentials/personal');
  return res.data.items;
}

// =============================================================================
// Personal Credential CRUD (My Credentials)
// =============================================================================

export interface PersonalCredentialSummary {
  id: string;
  name: string;
  description: string | null;
  credential_type: 'ssh_password' | 'ssh_key' | 'api_token' | 'snmp_community' | 'generic_secret';
  username: string | null;
  host: string | null;
  port: number | null;
  has_enable_secret: boolean;
  created_at: string;
  updated_at: string;
}

export interface PersonalCredentialInput {
  name: string;
  credential_type: 'ssh_password' | 'ssh_key' | 'api_token' | 'snmp_community' | 'generic_secret';
  username?: string;
  host?: string;
  port?: number;
  secret: string;
  enable_secret?: string;
  description?: string;
}

export interface PersonalCredentialUpdate {
  name?: string;
  username?: string;
  host?: string;
  port?: number;
  secret?: string;
  enable_secret?: string;
  description?: string;
}

export async function createPersonalCredential(input: PersonalCredentialInput): Promise<PersonalCredentialSummary> {
  const client = getClient();
  const res = await client.http.post('/credentials/personal', input);
  return res.data;
}

export async function updatePersonalCredential(id: string, input: PersonalCredentialUpdate): Promise<void> {
  const client = getClient();
  await client.http.put(`/credentials/personal/${id}`, input);
}

export async function deletePersonalCredential(id: string): Promise<void> {
  const client = getClient();
  await client.http.delete(`/credentials/personal/${id}`);
}

export async function revealPersonalCredential(id: string, reason: string): Promise<{ secret: string }> {
  const client = getClient();
  const res = await client.http.post(`/credentials/personal/${id}/reveal`, { reason });
  return res.data;
}
