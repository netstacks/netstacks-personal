// Saved tab groups API (Plan 1: Tab Groups Redesign)
import { getClient, getCurrentMode } from './client';

// Frontend-facing types (camelCase)

export type LaunchAction = 'alongside' | 'replace' | 'new_window' | 'ask';

export interface GroupTab {
  type: 'terminal' | 'topology' | 'document';
  sessionId?: string;
  topologyId?: string;
  documentId?: string;
  documentName?: string;
}

export interface Group {
  id: string;
  name: string;
  tabs: GroupTab[];
  topologyId?: string | null;
  defaultLaunchAction?: LaunchAction | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export interface CreateGroupRequest {
  name: string;
  tabs: GroupTab[];
  topologyId?: string | null;
  defaultLaunchAction?: LaunchAction | null;
}

export interface UpdateGroupRequest {
  name?: string;
  tabs?: GroupTab[];
  topologyId?: string | null; // null clears
  defaultLaunchAction?: LaunchAction | null;
  lastUsedAt?: string;
}

// Backend DTOs (snake_case)

interface GroupTabDTO {
  type: 'terminal' | 'topology' | 'document';
  session_id?: string;
  topology_id?: string;
  document_id?: string;
  document_name?: string;
}

interface GroupDTO {
  id: string;
  name: string;
  tabs: GroupTabDTO[];
  topology_id?: string | null;
  default_launch_action?: LaunchAction | null;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
}

interface CreateGroupRequestDTO {
  name: string;
  tabs: GroupTabDTO[];
  topology_id?: string | null;
  default_launch_action?: LaunchAction | null;
}

interface UpdateGroupRequestDTO {
  name?: string;
  tabs?: GroupTabDTO[];
  topology_id?: string | null;
  default_launch_action?: LaunchAction | null;
  last_used_at?: string;
}

// Converters

function toGroupTab(d: GroupTabDTO): GroupTab {
  return {
    type: d.type,
    sessionId: d.session_id,
    topologyId: d.topology_id,
    documentId: d.document_id,
    documentName: d.document_name,
  };
}

function toGroupTabDTO(t: GroupTab): GroupTabDTO {
  return {
    type: t.type,
    session_id: t.sessionId,
    topology_id: t.topologyId,
    document_id: t.documentId,
    document_name: t.documentName,
  };
}

function toGroup(d: GroupDTO): Group {
  return {
    id: d.id,
    name: d.name,
    tabs: d.tabs.map(toGroupTab),
    topologyId: d.topology_id ?? null,
    defaultLaunchAction: d.default_launch_action ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    lastUsedAt: d.last_used_at ?? null,
  };
}

function toCreateDTO(req: CreateGroupRequest): CreateGroupRequestDTO {
  return {
    name: req.name,
    tabs: req.tabs.map(toGroupTabDTO),
    topology_id: req.topologyId,
    default_launch_action: req.defaultLaunchAction,
  };
}

function toUpdateDTO(req: UpdateGroupRequest): UpdateGroupRequestDTO {
  const out: UpdateGroupRequestDTO = {};
  if (req.name !== undefined) out.name = req.name;
  if (req.tabs !== undefined) out.tabs = req.tabs.map(toGroupTabDTO);
  if (req.topologyId !== undefined) out.topology_id = req.topologyId;
  if (req.defaultLaunchAction !== undefined) out.default_launch_action = req.defaultLaunchAction;
  if (req.lastUsedAt !== undefined) out.last_used_at = req.lastUsedAt;
  return out;
}

// Public API

const NOT_AVAILABLE = 'Groups are not available in enterprise mode (will be in Plan 3)';

export async function listGroups(): Promise<Group[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/groups');
  return (data as GroupDTO[]).map(toGroup);
}

export async function getGroup(id: string): Promise<Group> {
  if (getCurrentMode() === 'enterprise') throw new Error(NOT_AVAILABLE);
  const { data } = await getClient().http.get(`/groups/${encodeURIComponent(id)}`);
  return toGroup(data as GroupDTO);
}

export async function createGroup(req: CreateGroupRequest): Promise<Group> {
  if (getCurrentMode() === 'enterprise') throw new Error(NOT_AVAILABLE);
  const { data } = await getClient().http.post('/groups', toCreateDTO(req));
  return toGroup(data as GroupDTO);
}

export async function updateGroup(id: string, req: UpdateGroupRequest): Promise<Group> {
  if (getCurrentMode() === 'enterprise') throw new Error(NOT_AVAILABLE);
  const { data } = await getClient().http.put(`/groups/${encodeURIComponent(id)}`, toUpdateDTO(req));
  return toGroup(data as GroupDTO);
}

export async function deleteGroup(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error(NOT_AVAILABLE);
  await getClient().http.delete(`/groups/${encodeURIComponent(id)}`);
}
