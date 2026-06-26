/**
 * AgentWorkflowGraph — the sub-agent workflow as a pan/zoom canvas of boxes,
 * styled to match the Topology view. Each box is a SubagentNode (expand to its
 * live activity feed, drag, resize); edges wire parents to their delegated
 * children. Auto-layout from subagentGraph; manual drags override per node.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useAgentTasksStore } from '../hooks/useAgentTasks';
import { buildWorkflowGraph, NODE_W, NODE_H, GAP_Y, type GraphNode } from '../lib/subagentGraph';
import SubagentNode from './SubagentNode';
import './AgentWorkflowGraph.css';

const EXPANDED_W = 320;

interface Props {
  rootId: string;
  onOpenRun: (taskId: string) => void;
}

export default function AgentWorkflowGraph({ rootId, onOpenRun }: Props) {
  const tasks = useAgentTasksStore((s) => s.tasks);
  const graph = useMemo(() => buildWorkflowGraph(tasks, rootId), [tasks, rootId]);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 28, y: 24 });
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({});
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Real, content-driven node heights reported by each box (for layout + edges).
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onHeight = useCallback((id: string, hgt: number) => {
    setHeights((prev) => (prev[id] === hgt ? prev : { ...prev, [id]: hgt }));
  }, []);

  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onBgDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onBgMove = (e: ReactPointerEvent) => {
    if (!panRef.current) return;
    setPan({ x: panRef.current.ox + (e.clientX - panRef.current.sx), y: panRef.current.oy + (e.clientY - panRef.current.sy) });
  };
  const onBgUp = (e: ReactPointerEvent) => {
    panRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Latest view for the native wheel handler (avoids stale closures).
  const viewRef = useRef({ zoom, pan });
  viewRef.current = { zoom, pan };

  // Zoom by `factor` keeping the point (cx,cy) [canvas px] fixed under the cursor.
  const zoomAround = (factor: number, cx: number, cy: number) => {
    const { zoom: z, pan: p } = viewRef.current;
    const nz = Math.min(2, Math.max(0.3, z * factor));
    const wx = (cx - p.x) / z;
    const wy = (cy - p.y) / z;
    setZoom(nz);
    setPan({ x: cx - wx * nz, y: cy - wy * nz });
  };
  const zoomButton = (factor: number) => {
    const el = canvasRef.current;
    zoomAround(factor, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
  };

  // Ctrl/⌘+wheel (and trackpad pinch, which the browser delivers as ctrl+wheel)
  // zooms around the cursor; a plain wheel passes through so an expanded node's
  // text/feed scrolls normally. Native listener so preventDefault isn't passive.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { zoom: z, pan: p } = viewRef.current;
      const nz = Math.min(2, Math.max(0.3, z * Math.exp(-e.deltaY * 0.0015)));
      const wx = (cx - p.x) / z;
      const wy = (cy - p.y) / z;
      setZoom(nz);
      setPan({ x: cx - wx * nz, y: cy - wy * nz });
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  // Pack rows by each row's tallest measured node, so auto-sized boxes neither
  // overlap nor leave big gaps.
  const rowY = useMemo(() => {
    const rowHeight: Record<number, number> = {};
    let maxDepth = 0;
    for (const n of graph.nodes) {
      const hh = heights[n.task.id] ?? NODE_H;
      rowHeight[n.depth] = Math.max(rowHeight[n.depth] ?? 0, hh);
      if (n.depth > maxDepth) maxDepth = n.depth;
    }
    const ys: number[] = [];
    let acc = 0;
    for (let d = 0; d <= maxDepth; d++) {
      ys[d] = acc;
      acc += (rowHeight[d] ?? NODE_H) + GAP_Y;
    }
    return ys;
  }, [graph, heights]);

  const posOf = (n: GraphNode) => overrides[n.task.id] ?? { x: n.x, y: rowY[n.depth] ?? n.y };
  const widthOf = (id: string) => (expanded.has(id) ? (sizes[id]?.w ?? EXPANDED_W) : NODE_W);
  const heightOf = (id: string) => heights[id] ?? (expanded.has(id) ? (sizes[id]?.h ?? 240) : NODE_H);

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.task.id, n])), [graph]);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  if (graph.nodes.length === 0) {
    return (
      <div className="saw-empty">
        This run hasn’t delegated to any sub-agents. When it calls <code>delegate_to_agent</code>, the workflow appears here.
      </div>
    );
  }

  return (
    <div className="saw-canvas" ref={canvasRef} onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp}>
      <div className="saw-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <svg className="saw-edges" width={graph.width + 400} height={graph.height + 400}>
          {graph.edges.map((e) => {
            const a = nodeById.get(e.from);
            const b = nodeById.get(e.to);
            if (!a || !b) return null;
            const ap = posOf(a);
            const bp = posOf(b);
            const x1 = ap.x + widthOf(e.from) / 2;
            const y1 = ap.y + heightOf(e.from);
            const x2 = bp.x + widthOf(e.to) / 2;
            const y2 = bp.y;
            const mid = (y1 + y2) / 2;
            return <path key={`${e.from}-${e.to}`} className="saw-edge" d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`} />;
          })}
        </svg>
        {graph.nodes.map((n) => {
          const p = posOf(n);
          return (
            <SubagentNode
              key={n.task.id}
              task={n.task}
              x={p.x}
              y={p.y}
              w={widthOf(n.task.id)}
              h={sizes[n.task.id]?.h}
              zoom={zoom}
              isRoot={n.task.id === rootId}
              expanded={expanded.has(n.task.id)}
              onToggleExpand={() => toggleExpand(n.task.id)}
              onMove={(x, y) => setOverrides((prev) => ({ ...prev, [n.task.id]: { x, y } }))}
              onResize={(w, h) => setSizes((prev) => ({ ...prev, [n.task.id]: { w, h } }))}
              onOpenRun={() => onOpenRun(n.task.id)}
              onHeight={onHeight}
            />
          );
        })}
      </div>

      <div className="saw-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => zoomButton(1.15)} title="Zoom in">+</button>
        <button onClick={() => zoomButton(1 / 1.15)} title="Zoom out">−</button>
        <button
          className="saw-reset"
          onClick={() => { setZoom(1); setPan({ x: 28, y: 24 }); setOverrides({}); }}
          title="Reset view + layout"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
