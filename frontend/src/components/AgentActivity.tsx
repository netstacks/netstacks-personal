/**
 * AgentActivity — a macOS/Xcode-style activity feed for an agent task's
 * glass-box transcript. Each ReAct step is a labeled card: a tinted leading
 * icon, a title ("Thinking", "Command", "Result"), a tool chip + right-aligned
 * metadata, and the body (reasoning text, the exact command in a terminal row,
 * or the tool result/error). Kind-coded accents, a live pulse, auto-scroll.
 *
 * Extended-reasoning ('thinking') steps are shown only while the
 * "Show AI Reasoning" setting (`ai.showThinking`) is on. When the backend
 * cannot serve transcripts at all (enterprise: the Controller has no
 * transcript route) pass `unavailable` to say so instead of "0 steps".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskMessage } from '../types/tasks';
import { useSettings } from '../hooks/useSettings';
import './AgentActivity.css';
import Tooltip from './Tooltip';

type StepKind = TaskMessage['kind'];

const KIND_TITLE: Record<StepKind, string> = {
  thought: 'Thinking',
  thinking: 'Extended Reasoning',
  command: 'Command',
  tool_result: 'Result',
  error: 'Error',
  status: 'Status',
};

/** Right-aligned metadata, e.g. "6 lines" for a result block. */
function metaFor(step: TaskMessage): string | null {
  if (step.kind === 'tool_result' || step.kind === 'error') {
    const n = step.content ? step.content.split('\n').length : 0;
    return n > 0 ? `${n} line${n === 1 ? '' : 's'}` : null;
  }
  return null;
}

function KindIcon({ kind }: { kind: StepKind }) {
  switch (kind) {
    case 'thought':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
        </svg>
      );
    case 'thinking':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9.5 2a6.5 6.5 0 0 1 5 10.6A5 5 0 1 1 7 17.4" />
          <circle cx="9.5" cy="19" r="2" />
          <path d="M14.5 4a3 3 0 0 1 0 6" />
        </svg>
      );
    case 'command':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 8l3 3-3 3" />
          <path d="M13 16h4" />
        </svg>
      );
    case 'tool_result':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4 4L19 7" />
        </svg>
      );
    case 'error':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3.5l9 16H3z" />
          <path d="M12 10v4" />
          <path d="M12 17.2v.2" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8v.2" />
        </svg>
      );
  }
}

/** Shown in place of the feed when the backend has no transcript support. */
export const ACTIVITY_UNAVAILABLE_TEXT = "Detailed activity isn't available from this Controller.";

interface AgentActivityProps {
  steps: TaskMessage[];
  live?: boolean;
  fill?: boolean;
  /** The backend cannot serve per-step transcripts (enterprise Controller). */
  unavailable?: boolean;
}

export default function AgentActivity({ steps: allSteps, live, fill, unavailable }: AgentActivityProps) {
  const { settings } = useSettings();
  const showThinking = !!settings['ai.showThinking'];
  const steps = useMemo(
    () => (showThinking ? allSteps : allSteps.filter((s) => s.kind !== 'thinking')),
    [allSteps, showThinking],
  );
  const feedRef = useRef<HTMLDivElement | null>(null);
  // Per-step collapse (by seq) so a busy feed can be folded down to headers.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  // Auto-scroll the inner feed (not the page) to the newest step.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  const toggle = (seq: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq); else next.add(seq);
      return next;
    });
  const allCollapsed = steps.length > 0 && steps.every((s) => collapsed.has(s.seq));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(steps.map((s) => s.seq)));

  if (unavailable) {
    return (
      <div className={`agent-activity${fill ? ' fill' : ''}`}>
        <div className="agent-activity-header">
          <span className="agent-activity-title">Agent Activity</span>
        </div>
        <div className="agent-activity-feed">
          <div className="aa-body aa-text agent-activity-unavailable" role="note">{ACTIVITY_UNAVAILABLE_TEXT}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`agent-activity${fill ? ' fill' : ''}`}>
      <div className="agent-activity-header">
        <span className="agent-activity-title">Agent Activity</span>
        {live && (
          <span className="agent-activity-live">
            <span className="aa-pulse" />
            Live
          </span>
        )}
        <span className="agent-activity-count">
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
        {steps.length > 1 && (
          <button className="ns-btn ns-btn--small" onClick={toggleAll}>
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>

      <div className="agent-activity-feed" ref={feedRef}>
        {steps.map((step) => {
          const meta = metaFor(step);
          const isCollapsed = collapsed.has(step.seq);
          return (
            <div key={step.seq} className={`aa-card aa-${step.kind}${isCollapsed ? ' collapsed' : ''}`}>
              <Tooltip label={isCollapsed ? 'Expand' : 'Collapse'}><div className="aa-card-head" onClick={() => toggle(step.seq)}>
                <span className="aa-chevron">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </span>
                <span className="aa-ico">
                  <KindIcon kind={step.kind} />
                </span>
                <span className="aa-title">{KIND_TITLE[step.kind] ?? step.kind}</span>
                {step.tool_name && <span className="aa-tool">{step.tool_name}</span>}
                {meta && <span className="aa-meta">{meta}</span>}
              </div></Tooltip>

              {!isCollapsed && (
                step.kind === 'command' ? (
                  <div className="aa-body">
                    <pre className="aa-code aa-cmd">
                      <span className="aa-prompt">›</span>
                      {step.content}
                    </pre>
                  </div>
                ) : step.kind === 'tool_result' || step.kind === 'error' ? (
                  <div className="aa-body">
                    <pre className="aa-code">{step.content}</pre>
                  </div>
                ) : step.kind === 'thinking' ? (
                  <div className="aa-body aa-text" style={{ opacity: 0.8, fontStyle: 'italic' }}>{step.content}</div>
                ) : (
                  <div className="aa-body aa-text">{step.content}</div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
