// API client for custom right-click commands
// In standalone mode: stored on the agent sidecar (localhost:8080)
// In enterprise mode: stored per-user on the controller

import { createCrudApi } from './crudFactory';

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
  detection_types: string | null; // JSON array of detection types, null = static/always show
  sort_order: number;
  enabled: boolean;
  created_at: string;
  action_type: string; // 'terminal' | 'quick_action' | 'script'
  quick_action_id: string | null;
  quick_action_variable: string | null;
  script_id: string | null;
  show_in_force_click: boolean;
}

export interface NewCustomCommand {
  name: string;
  command: string;
  detection_types?: string | null;
  sort_order?: number;
  enabled?: boolean;
  action_type?: string;
  quick_action_id?: string | null;
  quick_action_variable?: string | null;
  script_id?: string | null;
  show_in_force_click?: boolean;
}

export interface UpdateCustomCommand {
  name?: string;
  command?: string;
  detection_types?: string | null;
  sort_order?: number;
  enabled?: boolean;
  action_type?: string;
  quick_action_id?: string | null;
  quick_action_variable?: string | null;
  script_id?: string | null;
  show_in_force_click?: boolean;
}

const api = createCrudApi<CustomCommand, NewCustomCommand, UpdateCustomCommand>('/custom-commands');

export const listCustomCommands = api.list;
export const createCustomCommand = api.create;
export const updateCustomCommand = api.update;
export const deleteCustomCommand = api.delete;
