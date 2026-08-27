// Annotations API for topology visual documentation

import type {
  Annotation,
  AnnotationType,
  TextAnnotation,
  ShapeAnnotation,
  LineAnnotation,
  GroupAnnotation,
  BaseAnnotation,
} from '../types/annotations';

import { getClient } from './client';

// Backend response type (snake_case)
interface BackendAnnotation {
  id: string;
  topology_id: string;
  annotation_type: string;
  element_data: Record<string, unknown>;
  z_index: number;
  created_at: string;
  updated_at: string;
}

/**
 * Transform backend annotation to frontend format
 */
function transformAnnotation(backend: BackendAnnotation): Annotation {
  const base: BaseAnnotation = {
    id: backend.id,
    topologyId: backend.topology_id,
    type: backend.annotation_type as AnnotationType,
    zIndex: backend.z_index,
    createdAt: backend.created_at,
    updatedAt: backend.updated_at,
  };

  // Merge type-specific fields from element_data
  return {
    ...base,
    ...backend.element_data,
  } as Annotation;
}

/** Keys owned by `BaseAnnotation` — never part of `element_data`. */
const BASE_ANNOTATION_KEYS: ReadonlySet<string> = new Set<keyof BaseAnnotation>([
  'id', 'topologyId', 'type', 'zIndex', 'createdAt', 'updatedAt',
]);

/**
 * Strip base fields from an annotation, leaving only the type-specific
 * payload that belongs in `element_data`.
 *
 * The backend PUT replaces the whole `element_data` blob, so every update
 * must send the FULL merged payload (position + size + points + styling),
 * never a partial. Callers pass the already-merged annotation here.
 */
export function toElementData(annotation: Partial<Annotation>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotation)) {
    if (BASE_ANNOTATION_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Transform frontend annotation to backend request format
 */
function transformToBackend(
  type: AnnotationType,
  data: Omit<Annotation, keyof BaseAnnotation>,
  zIndex: number = 0
): { annotation_type: string; element_data: Record<string, unknown>; z_index: number } {
  return {
    annotation_type: type,
    element_data: toElementData(data as Partial<Annotation>),
    z_index: zIndex,
  };
}

/**
 * Get all annotations for a topology
 */
export async function getAnnotations(topologyId: string): Promise<Annotation[]> {
  const { data } = await getClient().http.get(`/topologies/${topologyId}/annotations`);
  return Array.isArray(data) ? data.map(transformAnnotation) : [];
}

/**
 * Create a new annotation
 */
export async function createAnnotation(
  topologyId: string,
  type: AnnotationType,
  data: Omit<TextAnnotation, keyof BaseAnnotation> |
        Omit<ShapeAnnotation, keyof BaseAnnotation> |
        Omit<LineAnnotation, keyof BaseAnnotation> |
        Omit<GroupAnnotation, keyof BaseAnnotation>,
  zIndex: number = 0
): Promise<Annotation> {
  const { data: backend } = await getClient().http.post(
    `/topologies/${topologyId}/annotations`,
    transformToBackend(type, data as Omit<Annotation, keyof BaseAnnotation>, zIndex)
  );
  return transformAnnotation(backend as BackendAnnotation);
}

/**
 * Update an existing annotation
 */
export async function updateAnnotation(
  topologyId: string,
  annotationId: string,
  updates: {
    /**
     * FULL merged type-specific payload for the annotation (the backend
     * replaces the blob wholesale). Use `toElementData(mergedAnnotation)`.
     */
    elementData?: Partial<Omit<Annotation, keyof BaseAnnotation>>;
    zIndex?: number;
  }
): Promise<void> {
  const body: { element_data?: Record<string, unknown>; z_index?: number } = {};

  if (updates.elementData) {
    body.element_data = toElementData(updates.elementData as Partial<Annotation>);
  }
  if (updates.zIndex !== undefined) {
    body.z_index = updates.zIndex;
  }

  await getClient().http.put(`/topologies/${topologyId}/annotations/${annotationId}`, body);
}

/**
 * Delete an annotation
 */
export async function deleteAnnotation(topologyId: string, annotationId: string): Promise<void> {
  await getClient().http.delete(`/topologies/${topologyId}/annotations/${annotationId}`);
}

/**
 * Reorder annotations by z-index
 * @param topologyId - Parent topology ID
 * @param idOrder - Array of annotation IDs in desired z-index order (first = lowest/back)
 */
export async function reorderAnnotations(topologyId: string, idOrder: string[]): Promise<void> {
  await getClient().http.post(`/topologies/${topologyId}/annotations/reorder`, { id_order: idOrder });
}
