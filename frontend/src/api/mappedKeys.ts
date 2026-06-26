// API client for global mapped keys (keyboard shortcut → command mappings)
// In standalone mode: stored on the agent sidecar (localhost:8080)
// In enterprise mode: stored per-user on the controller

import { createCrudApi } from './crudFactory';

export interface MappedKey {
  id: string;
  key_combo: string;
  command: string;
  description: string | null;
  created_at: string;
}

export interface NewMappedKey {
  key_combo: string;
  command: string;
  description?: string | null;
}

export interface UpdateMappedKey {
  key_combo?: string;
  command?: string;
  description?: string | null;
}

const api = createCrudApi<MappedKey, NewMappedKey, UpdateMappedKey>('/mapped-keys');

export const listMappedKeys = api.list;
export const createMappedKey = api.create;
export const updateMappedKey = api.update;
export const deleteMappedKey = api.delete;
