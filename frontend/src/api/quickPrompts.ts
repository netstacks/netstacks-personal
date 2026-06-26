// Quick Prompts API client

import { createCrudApi } from './crudFactory';

export interface QuickPrompt {
  id: string;
  name: string;
  prompt: string;
  is_favorite: boolean;
  shared?: boolean;
  owner_name?: string | null;
  is_own?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateQuickPromptRequest {
  name: string;
  prompt: string;
  is_favorite?: boolean;
  shared?: boolean;
}

export interface UpdateQuickPromptRequest {
  name?: string;
  prompt?: string;
  is_favorite?: boolean;
  shared?: boolean;
}

const api = createCrudApi<QuickPrompt, CreateQuickPromptRequest, UpdateQuickPromptRequest>('/quick-prompts');

export const listQuickPrompts = api.list;
export const createQuickPrompt = api.create;
export const updateQuickPrompt = api.update;
export const deleteQuickPrompt = api.delete;
