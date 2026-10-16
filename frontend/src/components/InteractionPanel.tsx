/**
 * InteractionPanel (Feature B).
 *
 * A queued, kind-switched panel for human-in-the-loop interactions parked by
 * a running agent task:
 *   - `approval`: review a tool call the task's permission settings put to the
 *     user (Settings → AI, Auto Pilot), Approve / Reject.
 *   - `question`: the agent's `ask_user` free-form question — answer with text
 *     or a suggested choice chip.
 *
 * Polls the (now typed) pending-interactions list every 750ms, handles the
 * whole QUEUE (not just the first item), and short-circuits in enterprise mode
 * (the Controller owns interactions there).
 */
import { useEffect, useRef, useState } from 'react';
import { useMode } from '../hooks/useMode';
import { useActiveContextStore } from '../commands';
import {
  listAllPendingInteractions,
  resolveInteraction,
  type PendingInteraction,
  type ResolveBody,
} from '../api/taskApprovals';
import './InteractionPanel.css';

/** Tab types that are the AI interaction surface — show the full panel. */
const AI_TAB_TYPES = new Set(['agent-run', 'ai-chat']);

const POLL_INTERVAL_MS = 750;

export default function InteractionPanel() {
  const { isEnterprise } = useMode();
  const activeTabType = useActiveContextStore(s => s.activeTabType);
  const isAiTab = AI_TAB_TYPES.has(activeTabType ?? '');
  const [queue, setQueue] = useState<PendingInteraction[]>([]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isEnterprise) return; // enterprise has no local interaction surface
    const tick = async () => {
      try {
        setQueue(await listAllPendingInteractions());
      } catch {
        /* transient; keep the last queue */
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [isEnterprise]);

  // Reset collapsed state when switching to an AI tab so the panel re-expands.
  useEffect(() => {
    if (isAiTab) setCollapsed(false);
  }, [isAiTab]);

  const current = queue[0] ?? null;
  if (isEnterprise || !current) return null;

  const resolve = async (body: ResolveBody) => {
    if (busy) return;
    setBusy(true);
    // Clear answer text immediately, independent of API result
    setAnswer('');
    try {
      await resolveInteraction(current.id, body);
      // Optimistic dequeue; the next poll reconciles.
      setQueue((q) => q.filter((i) => i.id !== current.id));
    } catch {
      /* will retry on the next poll */
    } finally {
      setBusy(false);
    }
  };

  // Off-AI-tab: show only a small corner badge so the user knows something
  // is waiting without obscuring whatever they're doing.
  if (!isAiTab || collapsed) {
    return (
      <div className="interaction-panel-overlay">
        <button
          className={`interaction-corner-badge kind-${current.kind}`}
          onClick={() => { setCollapsed(false); }}
          title={`Agent is waiting for your input — ${queue.length} pending`}
        >
          <span className="interaction-corner-dot" />
          <span className="interaction-corner-label">{current.kind}</span>
          {queue.length > 1 && (
            <span className="interaction-corner-count">{queue.length}</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="interaction-panel-overlay">
      <div className="interaction-panel">
        <div className="interaction-header">
          <span className={`interaction-kind-badge kind-${current.kind}`}>{current.kind}</span>
          <span className="interaction-queue-count">
            {queue.length === 1 ? '1 pending' : `${queue.length} pending`}
          </span>
          {!isAiTab && (
            <button
              className="interaction-collapse-btn"
              onClick={() => setCollapsed(true)}
              title="Collapse"
            >
              ×
            </button>
          )}
        </div>

        <div className="interaction-prompt">{current.prompt}</div>

        {current.kind === 'approval' && (
          <>
            {current.tool_name && <div className="interaction-tool">{current.tool_name}</div>}
            {current.tool_input !== undefined && current.tool_input !== null && (
              <pre className="interaction-tool-input">
                {JSON.stringify(current.tool_input, null, 2)}
              </pre>
            )}
            <div className="interaction-actions">
              <button
                className="ns-btn"
                disabled={busy}
                onClick={() => void resolve({ kind: 'reject' })}
              >
                Reject
              </button>
              <button
                className="ns-btn ns-btn--primary"
                disabled={busy}
                onClick={() => void resolve({ kind: 'approve' })}
              >
                Approve
              </button>
            </div>
          </>
        )}

        {current.kind === 'question' && (
          <>
            {current.choices && current.choices.length > 0 && (
              <div className="interaction-chips">
                {current.choices.map((c) => (
                  <button
                    key={c}
                    className="interaction-chip"
                    disabled={busy}
                    onClick={() => void resolve({ kind: 'answer', text: c })}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <textarea data-ai-fill="off"
              className="ns-textarea interaction-answer"
              value={answer}
              placeholder="Type your answer…"
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
            />
            <div className="interaction-actions">
              <button
                className="ns-btn"
                disabled={busy}
                onClick={() => void resolve({ kind: 'reject', reason: 'user skipped' })}
              >
                Skip
              </button>
              <button
                className="ns-btn ns-btn--primary"
                disabled={busy || answer.trim().length === 0}
                onClick={() => void resolve({ kind: 'answer', text: answer.trim() })}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
