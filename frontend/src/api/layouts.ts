// Saved tab layouts API (Phase 25)
import { getClient, getCurrentMode } from './client';

// Tab reference for mixed tab types in layouts
export interface LayoutTab {
  type: 'terminal' | 'topology' | 'document';
  // For terminal tabs
  sessionId?: string;
  // For topology tabs
  topologyId?: string;
  // For document tabs
  documentId?: string;
  documentName?: string;
}

// Layout orientation/arrangement types
export type LayoutOrientation = 'horizontal' | 'vertical' | '2-top-1-bottom' | '1-top-2-bottom';

export interface Layout {
  id: string;
  name: string;
  sessionIds: string[]; // Legacy: terminal-only session IDs
  tabs?: LayoutTab[];   // New: mixed tab types (if present, takes precedence)
  orientation: LayoutOrientation;
  sizes?: number[];
  createdAt: string;
  updatedAt: string;
}

// Tab reference DTO (snake_case version)
interface LayoutTabDTO {
  type: 'terminal' | 'topology' | 'document';
  session_id?: string;
  topology_id?: string;
  document_id?: string;
  document_name?: string;
}

// Backend uses snake_case, frontend uses camelCase
interface LayoutDTO {
  id: string;
  name: string;
  session_ids: string[];
  tabs?: LayoutTabDTO[];
  orientation: string; // Allow any string, frontend will validate
  sizes?: number[];
  created_at: string;
  updated_at: string;
}

function toLayoutTab(dto: LayoutTabDTO): LayoutTab {
  return {
    type: dto.type,
    sessionId: dto.session_id,
    topologyId: dto.topology_id,
    documentId: dto.document_id,
    documentName: dto.document_name,
  };
}

function toLayoutTabDTO(tab: LayoutTab): LayoutTabDTO {
  return {
    type: tab.type,
    session_id: tab.sessionId,
    topology_id: tab.topologyId,
    document_id: tab.documentId,
    document_name: tab.documentName,
  };
}

function toLayout(dto: LayoutDTO): Layout {
  // Validate orientation, default to horizontal if unknown
  const validOrientations: LayoutOrientation[] = ['horizontal', 'vertical', '2-top-1-bottom', '1-top-2-bottom'];
  const orientation: LayoutOrientation = validOrientations.includes(dto.orientation as LayoutOrientation)
    ? (dto.orientation as LayoutOrientation)
    : 'horizontal';

  return {
    id: dto.id,
    name: dto.name,
    sessionIds: dto.session_ids,
    tabs: dto.tabs?.map(toLayoutTab),
    orientation,
    sizes: dto.sizes,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
  };
}

function toDTO(layout: Partial<Layout> & { name: string; sessionIds: string[]; orientation: string }): Partial<LayoutDTO> {
  return {
    id: layout.id,
    name: layout.name,
    session_ids: layout.sessionIds,
    tabs: layout.tabs?.map(toLayoutTabDTO),
    orientation: layout.orientation, // Pass through the full orientation string
    sizes: layout.sizes,
    created_at: layout.createdAt,
    updated_at: layout.updatedAt,
  };
}

export async function listLayouts(): Promise<Layout[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.get('/layouts');
  return (data as LayoutDTO[]).map(toLayout);
}

export async function getLayout(id: string): Promise<Layout> {
  if (getCurrentMode() === 'enterprise') throw new Error('Layouts are not available in enterprise mode');
  const { data } = await getClient().http.get(`/layouts/${id}`);
  return toLayout(data as LayoutDTO);
}

export async function createLayout(layout: Omit<Layout, 'id' | 'createdAt' | 'updatedAt'>): Promise<Layout> {
  if (getCurrentMode() === 'enterprise') throw new Error('Layouts are not available in enterprise mode');
  const { data } = await getClient().http.post('/layouts', toDTO(layout as Layout));
  return toLayout(data as LayoutDTO);
}

export async function updateLayout(id: string, layout: Partial<Layout>): Promise<Layout> {
  if (getCurrentMode() === 'enterprise') throw new Error('Layouts are not available in enterprise mode');
  const { data } = await getClient().http.put(`/layouts/${id}`, toDTO({ ...layout, id } as Layout));
  return toLayout(data as LayoutDTO);
}

export async function deleteLayout(id: string): Promise<void> {
  if (getCurrentMode() === 'enterprise') throw new Error('Layouts are not available in enterprise mode');
  await getClient().http.delete(`/layouts/${id}`);
}
