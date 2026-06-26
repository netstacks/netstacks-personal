/**
 * InteractionPanel (Feature B) — replaces the binary TaskApprovalModal.
 *
 * A queued, kind-switched panel for human-in-the-loop interactions parked by
 * a running agent task:
 *   - `approval`: review a mutating tool's args, Approve / Reject.
 *   - `question`: the agent's `ask_user` free-form question — answer with text
 *     or a suggested choice chip.
 *
 * Polls the (now typed) pending-interactions list every 750ms, handles the
 * whole QUEUE (not just the first item), and short-circuits in enterprise mode
 * (the Controller owns interactions there).
 */
import { useEffect, useRef, useState } from 'react';
import { useMode } from '../hooks/useMode';
import {
  listAllPendingInteractions,
  resolveInteraction,
  type PendingInteraction,
  type ResolveBody,
} from '../api/taskApprovals';
import './InteractionPanel.css';

const POLL_INTERVAL_MS = 750;

export default function InteractionPanel() {
  const { isEnterprise } = useMode();
  const [queue, setQueue] = useState<PendingInteraction[]>([]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
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

  const current = queue[0] ?? null;
  if (isEnterprise || !current) return null;

  const resolve = async (body: ResolveBody) => {
    if (busy) return;
    setBusy(true);
    try {
      await resolveInteraction(current.id, body);
      setAnswer('');
      // Optimistic dequeue; the next poll reconciles.
      setQueue((q) => q.filter((i) => i.id !== current.id));
    } catch {
      /* will retry on the next poll */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="interaction-panel-overlay">
      <div className="interaction-panel">
        <div className="interaction-header">
          <span className={`interaction-kind-badge kind-${current.kind}`}>{current.kind}</span>
          <span className="interaction-queue-count">
            {queue.length > 1 ? `${queue.length} pending` : '1 pending'}
          </span>
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
                className="interaction-btn reject"
                disabled={busy}
                onClick={() => void resolve({ kind: 'reject' })}
              >
                Reject
              </button>
              <button
                className="interaction-btn approve"
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
            <textarea
              className="interaction-answer"
              value={answer}
              placeholder="Type your answer…"
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
            />
            <div className="interaction-actions">
              <button
                className="interaction-btn reject"
                disabled={busy}
                onClick={() => void resolve({ kind: 'reject', reason: 'user skipped' })}
              >
                Skip
              </button>
              <button
                className="interaction-btn approve"
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
