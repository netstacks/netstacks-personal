/**
 * SubagentNode — one box in the Agent Workflow graph. Collapsed = status + label;
 * expanded = the run's live AgentActivity feed. Draggable (header) and resizable
 * (corner). Double-click opens the run as its own tab. Positions are in graph
 * coordinates; the parent graph applies pan/zoom, so drag deltas are divided by
 * zoom to stay 1:1 with the cursor.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useAgentTasksStore } from '../hooks/useAgentTasks';
import { getTaskMessages } from '../api/tasks';
import type { AgentTask, TaskMessage } from '../types/tasks';
import AgentActivity from './AgentActivity';

const EMPTY: TaskMessage[] = [];

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Props {
  task: AgentTask;
  x: number;
  y: number;
  w: number;
  /** Explicit height (px) when the user has resized; undefined = auto-size. */
  h?: number;
  zoom: number;
  isRoot: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onOpenRun: () => void;
  /** Report the node's real rendered height so the graph can lay out + wire edges. */
  onHeight?: (id: string, height: number) => void;
}

export default function SubagentNode({
  task, x, y, w, h, zoom, isRoot, expanded,
  onToggleExpand, onMove, onResize, onOpenRun, onHeight,
}: Props) {
  const transcript = useAgentTasksStore((s) => s.transcripts[task.id] ?? EMPTY);
  const setTranscript = useAgentTasksStore((s) => s.setTranscript);
  const isRunning = task.status === 'running';

  // Report the node's actual height (auto-sized to content) so the graph can
  // pack rows and connect edges to the real box bottom.
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    const report = () => onHeightRef.current?.(task.id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [task.id]);

  // Backfill the transcript when first expanded.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    getTaskMessages(task.id, -1)
      .then((steps) => { if (!cancelled && steps.length) setTranscript(task.id, steps); })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [expanded, task.id, setTranscript]);

  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onHeadDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: x, oy: y };
  };
  const onHeadMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    onMove(drag.current.ox + (e.clientX - drag.current.sx) / zoom, drag.current.oy + (e.clientY - drag.current.sy) / zoom);
  };
  const endDrag = (e: ReactPointerEvent) => {
    drag.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const rez = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);
  const onRezDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Start from the current rendered height when auto-sized (h undefined).
    const oh = h ?? nodeRef.current?.offsetHeight ?? 240;
    rez.current = { sx: e.clientX, sy: e.clientY, ow: w, oh };
  };
  const onRezMove = (e: ReactPointerEvent) => {
    if (!rez.current) return;
    onResize(
      Math.max(210, rez.current.ow + (e.clientX - rez.current.sx) / zoom),
      Math.max(150, rez.current.oh + (e.clientY - rez.current.sy) / zoom),
    );
  };
  const endRez = (e: ReactPointerEvent) => {
    rez.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const title = task.delegation_label || task.prompt;
  const kind = isRoot ? 'Root' : task.spawned_by_agent_definition_id ? 'Specialist' : 'Ephemeral';

  return (
    <div
      ref={nodeRef}
      className={`saw-node status-${task.status}${expanded ? ' expanded' : ''}${isRoot ? ' root' : ''}`}
      style={{
        transform: `translate(${x}px, ${y}px)`,
        width: w,
        height: expanded && h ? h : undefined,
        // When the user has resized, honor it past the auto cap.
        maxHeight: expanded && h ? 'none' : undefined,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="saw-node-header"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={endDrag}
        onDoubleClick={onOpenRun}
        title="Drag to move · double-click to open as a tab"
      >
        <button
          className="saw-node-expand"
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <svg className={`saw-chevron${expanded ? ' open' : ''}`} viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        <span className={`saw-node-status status-${task.status}`}>
          {isRunning && <span className="saw-dot" />}
          {STATUS_LABEL[task.status] ?? task.status}
        </span>
        <span className={`saw-node-kind kind-${kind.toLowerCase()}`}>{kind}</span>
      </div>

      <div className="saw-node-title" onDoubleClick={onOpenRun} title={title}>{title}</div>

      {expanded && (
        <div className="saw-node-body">
          <AgentActivity steps={transcript} live={isRunning} fill />
        </div>
      )}

      {expanded && (
        <div
          className="saw-node-resize"
          onPointerDown={onRezDown}
          onPointerMove={onRezMove}
          onPointerUp={endRez}
          title="Resize"
        />
      )}
    </div>
  );
}
