// API client for global mapped keys (keyboard shortcut → command mappings)
// In standalone mode: stored on the agent sidecar (localhost:8080)
// In enterprise mode: stored per-user on the controller

import { createCrudApi } from './crudFactory';
import { getClient } from './client';

export interface MappedKey {
  id: string;
  key_combo: string;
  command: string;
  description: string | null;
  is_secret: boolean;
  created_at: string;
}

export interface NewMappedKey {
  key_combo: string;
  command: string;
  description?: string | null;
  is_secret?: boolean;
}

export interface UpdateMappedKey {
  key_combo?: string;
  command?: string;
  description?: string | null;
  is_secret?: boolean;
}

const api = createCrudApi<MappedKey, NewMappedKey, UpdateMappedKey>('/mapped-keys');

export const listMappedKeys = api.list;
export const createMappedKey = api.create;
export const updateMappedKey = api.update;
export const deleteMappedKey = api.delete;

/**
 * Decrypt and return a secret mapped key's command. Requires the vault to be
 * unlocked — throws with backend code VAULT_LOCKED (HTTP 403) otherwise.
 */
export async function revealMappedKey(id: string): Promise<string> {
  const { data } = await getClient().http.get(`/mapped-keys/${id}/reveal`);
  return data.command;
}
