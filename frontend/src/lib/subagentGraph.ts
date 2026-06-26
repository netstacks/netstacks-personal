/**
 * subagentGraph — build a tidy top-down layout of an agent run + its sub-agents
 * from the flat task list (correlated via parent_task_id / root_task_id).
 *
 * Pure + deterministic so the graph is stable across re-renders; manual node
 * drags in the UI override these computed positions.
 */
import type { AgentTask } from '../types/tasks';

export const NODE_W = 248;
/** Fallback row height used until a node's real height is measured. */
export const NODE_H = 92;
const GAP_X = 36;
export const GAP_Y = 56;

export interface GraphNode {
  task: AgentTask;
  depth: number;
  /** Auto-layout position (top-left), in graph coordinates. */
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/**
 * Build the subtree rooted at `rootId` (the run itself + everything whose
 * `root_task_id` points at it) and lay it out as a tidy tree: leaves get
 * sequential columns, parents center over their children, depth = row.
 */
export function buildWorkflowGraph(tasks: AgentTask[], rootId: string): WorkflowGraph {
  const inTree = tasks.filter((t) => t.id === rootId || t.root_task_id === rootId);
  const byId = new Map(inTree.map((t) => [t.id, t]));
  if (!byId.has(rootId)) return { nodes: [], edges: [], width: 0, height: 0 };

  const children = new Map<string, string[]>();
  for (const t of inTree) {
    const p = t.parent_task_id;
    if (p && p !== t.id && byId.has(p)) {
      const arr = children.get(p);
      if (arr) arr.push(t.id);
      else children.set(p, [t.id]);
    }
  }
  // Deterministic child order (oldest first).
  for (const arr of children.values()) {
    arr.sort((a, b) => byId.get(a)!.created_at.localeCompare(byId.get(b)!.created_at));
  }

  const pos = new Map<string, { col: number; depth: number }>();
  let nextLeaf = 0;
  const walk = (id: string, depth: number): number => {
    const kids = children.get(id) ?? [];
    let col: number;
    if (kids.length === 0) {
      col = nextLeaf++;
    } else {
      const cols = kids.map((k) => walk(k, depth + 1));
      col = (cols[0] + cols[cols.length - 1]) / 2;
    }
    pos.set(id, { col, depth });
    return col;
  };
  walk(rootId, 0);

  const nodes: GraphNode[] = inTree.map((t) => {
    const p = pos.get(t.id) ?? { col: 0, depth: 0 };
    return {
      task: t,
      depth: p.depth,
      x: p.col * (NODE_W + GAP_X),
      y: p.depth * (NODE_H + GAP_Y),
    };
  });

  const edges: GraphEdge[] = inTree
    .filter((t) => t.parent_task_id && byId.has(t.parent_task_id) && t.id !== rootId)
    .map((t) => ({ from: t.parent_task_id!, to: t.id }));

  const width = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0);
  const height = nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 0);
  return { nodes, edges, width, height };
}
