// API client for enterprise profiles (Controller API, Phase 8 profile contract).
//
// Profile-by-reference replaces credential-by-reference. The terminal negotiates
// the contract via the `profile_contract` capability: when the controller
// advertises it, we use /profiles/accessible; otherwise we fall back to the
// legacy /credentials/accessible path and map credentials into the profile shape
// so an older controller still works.

import { getClient } from './client';
import type { AccessibleProfile } from '../types/enterpriseProfile';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { listAccessibleCredentials, getUserDefaultCredential } from './enterpriseCredentials';
import type { AccessibleCredential } from '../types/enterpriseCredential';

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
 * Negotiation helper: true when the controller advertises the profile contract.
 * Reads the capabilities store directly (non-reactive) for use in API helpers.
 */
export function hasProfileContract(): boolean {
  return useCapabilitiesStore.getState().hasFeature('profile_contract');
}

/**
 * Back-compat mapping: project a legacy AccessibleCredential into the
 * AccessibleProfile shape so old-controller responses are uniform for callers.
 */
function credentialToProfile(c: AccessibleCredential): AccessibleProfile {
  const auth_mode: AccessibleProfile['auth_mode'] =
    c.credential_type === 'ssh_key' ? 'ssh_key'
    : c.credential_type === 'ssh_password' ? 'password'
    : 'none';
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    profile_type: c.vault_type === 'shared' ? 'shared' : 'personal',
    username: c.username,
    auth_mode,
    transports: ['ssh'],
    host: c.host,
    port: c.port,
    is_default: false,
  };
}

/**
 * Capability-aware list of connect targets.
 * - profile_contract enabled → AccessibleProfiles (/profiles/accessible)
 * - otherwise → legacy credentials mapped into the profile shape.
 */
export async function loadConnectTargets(): Promise<AccessibleProfile[]> {
  if (hasProfileContract()) {
    return listAccessibleProfiles();
  }
  const creds = await listAccessibleCredentials();
  return creds.map(credentialToProfile);
}

/**
 * Capability-aware default connect target (default profile, or legacy default
 * credential mapped into the profile shape).
 */
export async function getDefaultConnectTarget(): Promise<AccessibleProfile | null> {
  if (hasProfileContract()) {
    return getUserDefaultProfile();
  }
  const cred = await getUserDefaultCredential();
  return cred ? credentialToProfile(cred) : null;
}
