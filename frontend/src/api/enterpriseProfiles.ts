// API client for enterprise profiles (Controller API, profile contract).
//
// Profile-by-reference is the single connect contract: the terminal always
// uses /profiles/accessible (+/default). Safe metadata only — never secrets.

import { getClient } from './client';
import type { AccessibleProfile } from '../types/enterpriseProfile';

/**
 * List all profiles the current user has access to.
 * Returns safe metadata only (name, auth_mode, transports, username) — never secrets.
 */
export async function listAccessibleProfiles(): Promise<AccessibleProfile[]> {
  const client = getClient();
  const res = await client.http.get('/profiles/accessible');
  return res.data.items;
}

/**
 * Get the user's default profile.
 * Returns null if the user has no accessible default profile.
 */
export async function getUserDefaultProfile(): Promise<AccessibleProfile | null> {
  const client = getClient();
  const res = await client.http.get('/profiles/accessible/default');
  return res.data;
}

/**
 * Set (or clear) the current user's default connection profile.
 * PUT /api/profiles/accessible/default with { profile_id }. Pass null to clear
 * the pointer (the controller then auto-resolves: is_default → first accessible).
 * Returns the resolved default profile (or null).
 */
export async function setDefaultProfile(profileId: string | null): Promise<AccessibleProfile | null> {
  const client = getClient();
  const res = await client.http.put('/profiles/accessible/default', { profile_id: profileId });
  return res.data ?? null;
}

/**
 * List of connect targets — always the AccessibleProfile contract
 * (/profiles/accessible).
 */
export async function loadConnectTargets(): Promise<AccessibleProfile[]> {
  return listAccessibleProfiles();
}

/**
 * Default connect target — always the AccessibleProfile contract
 * (/profiles/accessible/default).
 */
export async function getDefaultConnectTarget(): Promise<AccessibleProfile | null> {
  return getUserDefaultProfile();
}

/** A profile the current user owns (from the management list, incl. empty ones). */
export interface OwnedProfile {
  id: string;
  name: string;
  profile_type: 'personal' | 'shared' | 'service';
  username: string | null;
  is_default: boolean;
}

/**
 * List the profiles owned by the current user (personal profiles), including
 * empty ones with no auth yet — so they can be populated in Settings. Uses the
 * management list (GET /api/profiles, requires credentials.manage) filtered to
 * the caller's own profiles. Falls back to [] if not permitted.
 */
export async function listMyProfiles(ownerId: string): Promise<OwnedProfile[]> {
  const client = getClient();
  try {
    const res = await client.http.get('/profiles');
    const rows = (Array.isArray(res.data) ? res.data : res.data?.data ?? []) as Array<{
      id: string;
      name: string;
      profile_type: 'personal' | 'shared' | 'service';
      username: string | null;
      is_default: boolean;
      owner_id: string | null;
    }>;
    return rows
      .filter((p) => p.owner_id === ownerId)
      .map(({ id, name, profile_type, username, is_default }) => ({
        id,
        name,
        profile_type,
        username,
        is_default,
      }));
  } catch {
    return [];
  }
}

// ===========================================================================
// Profile secrets (the auth methods a profile owns) — enterprise Settings.
// The controller owns the vault; we only ever see metadata, never the bytes,
// except via the audited reveal route. Mirrors the controller's profile-secret
// routes (crates/api/src/routes/profiles.rs).
// ===========================================================================

/** A profile secret's metadata (never includes encrypted bytes). */
export interface ProfileSecret {
  id: string;
  profile_id: string;
  /** password | ssh_key | snmp_community | api_token | generic_secret | certificate */
  secret_type: string;
  priority: number;
  username: string | null;
  host: string | null;
  port: number | null;
  metadata: unknown;
  allow_port_forwarding: boolean;
  allow_scp_sftp: boolean;
  record_sessions: boolean;
  expires_at: string | null;
  created_at: string;
}

/** Input for creating a profile secret (plaintext is encrypted server-side). */
export interface CreateProfileSecretInput {
  secret_type: string;
  username?: string | null;
  host?: string | null;
  port?: number | null;
  /** Plaintext secret — REQUIRED by the API (send '' for certificate mode). */
  secret: string;
  passphrase?: string | null;
  enable_secret?: string | null;
  priority?: number;
}

export interface RevealProfileSecretResult {
  secret: string;
  passphrase?: string;
  enable_secret?: string;
}

/** List a profile's secret metadata. GET /api/profiles/:id/secrets */
export async function listProfileSecrets(profileId: string): Promise<ProfileSecret[]> {
  const client = getClient();
  const res = await client.http.get(`/profiles/${profileId}/secrets`);
  return res.data as ProfileSecret[];
}

/** Create a profile secret. POST /api/profiles/:id/secrets */
export async function createProfileSecret(
  profileId: string,
  input: CreateProfileSecretInput,
): Promise<ProfileSecret> {
  const client = getClient();
  const res = await client.http.post(`/profiles/${profileId}/secrets`, input);
  return res.data as ProfileSecret;
}

/** Delete a profile secret. DELETE /api/profiles/:id/secrets/:secretId */
export async function deleteProfileSecret(profileId: string, secretId: string): Promise<void> {
  const client = getClient();
  await client.http.delete(`/profiles/${profileId}/secrets/${secretId}`);
}

/**
 * Audited reveal of a profile secret's plaintext. Reason is mandatory and
 * logged. POST /api/profiles/:id/secrets/:secretId/reveal
 */
export async function revealProfileSecret(
  profileId: string,
  secretId: string,
  reason: string,
): Promise<RevealProfileSecretResult> {
  const client = getClient();
  const res = await client.http.post(
    `/profiles/${profileId}/secrets/${secretId}/reveal`,
    { reason },
  );
  return res.data as RevealProfileSecretResult;
}
