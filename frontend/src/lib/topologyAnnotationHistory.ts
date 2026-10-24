/**
 * Undo/redo for annotation history actions (add/remove/update_annotation).
 *
 * The device/connection executor (topologyHistoryActions) works on topology
 * state; annotations live in a separate array in TopologyTabEditor, so they
 * get their own executor that the editor calls with its annotation setter.
 *
 * Re-creating an annotation on a saved topology (redo of an add, undo of a
 * remove) gets a new backend ID. `idAliases` maps the ID recorded in the
 * history action to the ID the annotation has now, so later undo/redo steps
 * act on the right record.
 */

import type React from 'react';
import type { Annotation } from '../types/annotations';
import type { TopologyAction } from '../types/topologyHistory';
import type { ExecutionDirection } from './topologyHistoryActions';
import { createAnnotation, deleteAnnotation, updateAnnotation, toElementData } from '../api/annotations';

/** Type-specific payload accepted by `createAnnotation`. */
type AnnotationElementData = Parameters<typeof createAnnotation>[2];

export interface AnnotationHistoryDeps {
  topologyId: string | undefined;
  isTemporary: boolean;
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  /** history-action annotation ID -> current annotation ID */
  idAliases: Map<string, string>;
}

const ANNOTATION_ACTIONS = new Set<TopologyAction['type']>(['add_annotation', 'remove_annotation', 'update_annotation']);

export function isAnnotationAction(action: TopologyAction): boolean {
  return ANNOTATION_ACTIONS.has(action.type);
}

function persists(deps: AnnotationHistoryDeps): deps is AnnotationHistoryDeps & { topologyId: string } {
  return !deps.isTemporary && !!deps.topologyId;
}

function currentId(annotation: Annotation, deps: AnnotationHistoryDeps): string {
  return deps.idAliases.get(annotation.id) ?? annotation.id;
}

async function removeAnnotation(annotation: Annotation, deps: AnnotationHistoryDeps): Promise<void> {
  const id = currentId(annotation, deps);
  if (persists(deps)) {
    await deleteAnnotation(deps.topologyId, id);
  }
  deps.setAnnotations(prev => prev.filter(a => a.id !== id));
}

async function restoreAnnotation(annotation: Annotation, deps: AnnotationHistoryDeps): Promise<void> {
  if (persists(deps)) {
    const created = await createAnnotation(
      deps.topologyId,
      annotation.type,
      toElementData(annotation) as AnnotationElementData,
      annotation.zIndex,
    );
    deps.idAliases.set(annotation.id, created.id);
    deps.setAnnotations(prev => [...prev, created]);
    return;
  }
  const restored = { ...annotation, id: currentId(annotation, deps) } as Annotation;
  deps.setAnnotations(prev => [...prev, restored]);
}

async function replaceAnnotation(annotation: Annotation, deps: AnnotationHistoryDeps): Promise<void> {
  const id = currentId(annotation, deps);
  if (persists(deps)) {
    await updateAnnotation(deps.topologyId, id, { elementData: toElementData(annotation) });
  }
  deps.setAnnotations(prev => prev.map(a => (a.id === id ? ({ ...annotation, id } as Annotation) : a)));
}

/**
 * Apply an annotation history action in the given direction. Backend calls
 * run before the local state change, so a failed call leaves the canvas
 * matching what is stored (and the caller sees the rejection).
 */
export async function executeAnnotationHistoryAction(
  action: TopologyAction,
  direction: ExecutionDirection,
  deps: AnnotationHistoryDeps,
): Promise<void> {
  const isUndo = direction === 'undo';
  const before = action.data.before as Annotation | null;
  const after = action.data.after as Annotation | null;

  switch (action.type) {
    case 'add_annotation':
      if (!after) return;
      await (isUndo ? removeAnnotation(after, deps) : restoreAnnotation(after, deps));
      return;
    case 'remove_annotation':
      if (!before) return;
      await (isUndo ? restoreAnnotation(before, deps) : removeAnnotation(before, deps));
      return;
    case 'update_annotation': {
      const target = isUndo ? before : after;
      if (target) await replaceAnnotation(target, deps);
      return;
    }
    default:
      throw new Error(`Not an annotation action: ${action.type}`);
  }
}
