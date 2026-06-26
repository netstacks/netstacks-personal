// API client for credential profiles

import { getClient, getCurrentMode } from './client';

// Auth type enum matching backend
export type AuthType = 'password' | 'key';

// Credential profile interface matching backend model
export interface CredentialProfile {
  id: string;
  name: string;

  // Identity & Auth
  username: string;
  auth_type: AuthType;
  key_path: string | null;

  // Connection Defaults
  port: number;
  keepalive_interval: number;
  connection_timeout: number;

  // Terminal Defaults
  terminal_theme: string | null;
  default_font_size: number | null;
  default_font_family: string | null;
  scrollback_lines: number;
  local_echo: boolean;
  auto_reconnect: boolean;
  reconnect_delay: number;
  cli_flavor: string;
  auto_commands: string[];

  /** Optional default jump host. Sessions/tunnels using this profile
   *  inherit it unless they set their own `jump_host_id`. */
  jump_host_id: string | null;

  /** Alternative default jump: another Session used as the jump endpoint
   *  (mutually exclusive with jump_host_id; backend rejects setting both). */
  jump_session_id: string | null;

  created_at: string;
  updated_at: string;
}

// Request to create a new credential profile
export interface NewCredentialProfile {
  name: string;
  username: string;
  auth_type?: AuthType;
  key_path?: string | null;
  port?: number;
  keepalive_interval?: number;
  connection_timeout?: number;
  terminal_theme?: string | null;
  default_font_size?: number | null;
  default_font_family?: string | null;
  scrollback_lines?: number;
  local_echo?: boolean;
  auto_reconnect?: boolean;
  reconnect_delay?: number;
  cli_flavor?: string;
  auto_commands?: string[];
  jump_host_id?: string | null;
  jump_session_id?: string | null;
}

// Request to update a credential profile (all fields optional)
export interface UpdateCredentialProfile {
  name?: string;
  username?: string;
  auth_type?: AuthType;
  key_path?: string | null;
  port?: number;
  keepalive_interval?: number;
  connection_timeout?: number;
  terminal_theme?: string | null;
  default_font_size?: number | null;
  default_font_family?: string | null;
  scrollback_lines?: number;
  local_echo?: boolean;
  auto_reconnect?: boolean;
  reconnect_delay?: number;
  cli_flavor?: string;
  auto_commands?: string[];
  jump_host_id?: string | null;
  jump_session_id?: string | null;
}

// Credential for a profile (stored encrypted in vault)
export interface ProfileCredential {
  password?: string;
  key_passphrase?: string;
  jump_password?: string;
  jump_key_passphrase?: string;
  /** SNMP community strings for this profile (e.g., ["public", "private"]) */
  snmp_communities?: string[];
}

// List all credential profiles
export async function listProfiles(): Promise<CredentialProfile[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/profiles');
  return data;
}

// Get a single profile by ID
export async function getProfile(id: string): Promise<CredentialProfile> {
  if (getCurrentMode() === 'enterprise') throw new Error('Credential profiles are not available in enterprise mode');
  const { data } = await getClient().http.get(`/profiles/${id}`);
  return data;
}

// Create a new credential profile
export async function createProfile(profile: NewCredentialProfile): Promise<CredentialProfile> {
  if (getCurrentMode() === 'enterprise') throw new Error('Credential profiles are not available in enterprise mode');
  const { data } = await getClient().http.post('/profiles', profile);
  return data;
}

// Update an existing credential profile
export async function updateProfile(id: string, update: UpdateCredentialProfile): Promise<CredentialProfile> {
  if (getCurrentMode() === 'enterprise') throw new Error('Credential profiles are not available in enterprise mode');
  const { data } = await getClient().http.put(`/profiles/${id}`, update);
  return data;
}

// Delete a credential profile
export async function deleteProfile(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Credential profiles are not available in enterprise mode');
  try {
    await getClient().http.delete(`/profiles/${id}`);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: string } };
    const text = axiosErr.response?.data || '';
    if (typeof text === 'string' && text.includes('sessions')) {
      throw new Error('Cannot delete profile: sessions are using this profile');
    }
    throw new Error('Failed to delete profile');
  }
}

// Credential metadata (non-secret summary)
export interface ProfileCredentialMeta {
  has_password: boolean;
  has_key_passphrase: boolean;
  snmp_community_count: number;
}

// Get credential metadata for a profile (non-secret)
export async function getProfileCredentialMeta(id: string): Promise<ProfileCredentialMeta> {
  if (getCurrentMode() === 'enterprise') return { has_password: false, has_key_passphrase: false, snmp_community_count: 0 };
  try {
    const { data } = await getClient().http.get(`/profiles/${id}/credential`);
    return data;
  } catch {
    return { has_password: false, has_key_passphrase: false, snmp_community_count: 0 };
  }
}

// Store credentials for a profile in the vault
export async function storeProfileCredential(id: string, credential: ProfileCredential): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Credential profiles are not available in enterprise mode');
  try {
    await getClient().http.put(`/profiles/${id}/credential`, credential);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { code?: string; error?: string } } };
    const responseData = axiosErr.response?.data;
    if (responseData?.code === 'VAULT_LOCKED') {
      throw new Error('Vault is locked. Go to Settings → Security to unlock with your master password.');
    }
    throw new Error(responseData?.error || 'Failed to store profile credential');
  }
}

// Delete credentials for a profile from the vault
export async function deleteProfileCredential(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Credential profiles are not available in enterprise mode');
  await getClient().http.delete(`/profiles/${id}/credential`);
}
