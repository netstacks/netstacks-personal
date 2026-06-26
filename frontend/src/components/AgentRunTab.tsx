/**
 * AgentRunTab — full main-window view of a single agent run.
 *
 * Reads the run + transcript from the useAgentTasks store by task id, so it's
 * a pure VIEW: closing the tab does not stop the run (it lives on the backend
 * + in the store), and reopening reconstructs from the same source. Renders the
 * prompt, status, the macOS AgentActivity feed (with room to breathe), and the
 * final result. Can be popped out into its own window.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useAgentTasks, useAgentTasksStore } from '../hooks/useAgentTasks';
import { getTaskMessages } from '../api/tasks';
import {
  listTaskPendingInteractions,
  resolveInteraction,
  type PendingInteraction,
} from '../api/taskApprovals';
import type { TaskMessage } from '../types/tasks';
import { createUserMessage, createThinkingMessage, type AgentMessage } from '../api/agent';
import AgentActivity from './AgentActivity';
import AgentWorkflowGraph from './AgentWorkflowGraph';
import './AgentRunTab.css';

const EMPTY: TaskMessage[] = [];

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Best-effort extraction of the human-readable answer from result_json. */
function resultText(resultJson: string | null | undefined): string | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson);
    if (typeof parsed === 'string') return parsed;
    return parsed.result ?? parsed.answer ?? parsed.final_answer ?? resultJson;
  } catch {
    return resultJson;
  }
}

interface AgentRunTabProps {
  taskId: string;
  /** Open a document the agent saved (by id) — reuses the app's document tab. */
  onOpenArtifact?: (docId: string) => void;
  /** Continue this finished run as a chat in the same tab (seeded with the
   *  run's conversation). */
  onContinueChat?: (seed: AgentMessage[]) => void;
  /** Open another run (a sub-agent) as its own tab. */
  onOpenRun?: (taskId: string) => void;
}

export default function AgentRunTab({ taskId, onOpenArtifact, onContinueChat, onOpenRun }: AgentRunTabProps) {
  // Mounting the hook keeps the shared task WebSocket alive while this tab is
  // open (so live updates work even if the Agents panel is closed) and gives
  // us cancel.
  const { cancelTask } = useAgentTasks();
  const task = useAgentTasksStore((s) => s.tasks.find((t) => t.id === taskId));
  const transcript = useAgentTasksStore((s) => s.transcripts[taskId] ?? EMPTY);
  const setTranscript = useAgentTasksStore((s) => s.setTranscript);

  const [pending, setPending] = useState<PendingInteraction | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'activity' | 'both' | 'workflow'>('both');
  const [splitPct, setSplitPct] = useState(50);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const divDrag = useRef(false);
  const onDivDown = (e: ReactPointerEvent) => {
    divDrag.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDivMove = (e: ReactPointerEvent) => {
    if (!divDrag.current || !splitRef.current) return;
    const r = splitRef.current.getBoundingClientRect();
    setSplitPct(Math.min(80, Math.max(20, ((e.clientX - r.left) / r.width) * 100)));
  };
  const onDivUp = (e: ReactPointerEvent) => {
    divDrag.current = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Does this run have any sub-agents? (children share root_task_id = this id.)
  const hasSubagents = useAgentTasksStore((s) => s.tasks.some((t) => t.root_task_id === taskId));

  const isActive = task?.status === 'running' || task?.status === 'pending';

  // Backfill the transcript on open (and when the run id changes).
  useEffect(() => {
    let cancelled = false;
    getTaskMessages(taskId, -1)
      .then((steps) => {
        if (!cancelled && steps.length > 0) setTranscript(taskId, steps);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, setTranscript]);

  // Poll for a pending interaction (the agent's ask_user / approval) while the
  // run is active, so the user can answer it inline like a chat turn.
  useEffect(() => {
    if (!isActive) {
      setPending(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const items = await listTaskPendingInteractions(taskId);
        if (!cancelled) setPending(items[0] ?? null);
      } catch {
        /* transient */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 750);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, isActive]);

  const resolve = async (body: Parameters<typeof resolveInteraction>[1]) => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await resolveInteraction(pending.id, body);
      setAnswer('');
      setPending(null);
    } catch {
      /* will retry on next poll */
    } finally {
      setBusy(false);
    }
  };

  // Artifacts this run saved — parsed from save_document tool results. Opening
  // one reuses the app's normal document tab (and your split-screen).
  const artifacts = useMemo(() => {
    const out: { id: string; name: string; type: string }[] = [];
    for (const s of transcript) {
      if (s.tool_name === 'save_document' && s.kind === 'tool_result') {
        try {
          const j = JSON.parse(s.content);
          if (j && typeof j.document_id === 'string') {
            out.push({ id: j.document_id, name: j.name ?? 'Document', type: j.content_type ?? 'markdown' });
          }
        } catch {
          /* older shape / not JSON — ignore */
        }
      }
    }
    return out;
  }, [transcript]);

  const [showArtifacts, setShowArtifacts] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const openedArtifacts = useRef<Set<string>>(new Set());

  // Auto-open newly-created artifacts — but only while the run is live, so
  // reopening a finished run doesn't spawn a pile of tabs (use the tray then).
  useEffect(() => {
    if (!onOpenArtifact || !isActive) return;
    for (const a of artifacts) {
      if (!openedArtifacts.current.has(a.id)) {
        openedArtifacts.current.add(a.id);
        onOpenArtifact(a.id);
      }
    }
  }, [artifacts, onOpenArtifact, isActive]);

  if (!task) {
    return (
      <div className="agent-run-tab agent-run-empty">
        <div className="agent-run-empty-inner">This agent run is no longer available.</div>
      </div>
    );
  }

  const isRunning = task.status === 'running';
  const resultAnswer = task.status === 'completed' ? resultText(task.result_json) : null;

  // Seed for continuing this run as a chat: the original ask + the agent's
  // outcome, so the chat resumes with the conversation in context.
  const buildSeed = (): AgentMessage[] => {
    const outcome = resultAnswer ?? task.error_message ?? 'The previous run finished.';
    return [createUserMessage(task.prompt), createThinkingMessage(outcome)];
  };

  // The agent's own activity (thinking / commands / results) — shown alone, or
  // as the left pane beside the sub-agent workflow graph.
  const activityCenter = (
    <div className="agent-run-center">
      <AgentActivity steps={transcript} live={isRunning} />

      {task.error_message && (
        <section className="agent-run-result agent-run-result-error">
          <div className="agent-run-result-label">Error</div>
          <pre className="agent-run-result-body">{task.error_message}</pre>
        </section>
      )}

      {resultAnswer && (
        <section className="agent-run-result">
          <div className="agent-run-result-label">Result</div>
          <div className="agent-run-result-body agent-run-result-text">{resultAnswer}</div>
        </section>
      )}
    </div>
  );

  return (
    <div className="agent-run-tab">
      <header className="agent-run-head">
        <div className="agent-run-center">
        <div className="agent-run-head-top">
          <span className={`agent-run-status status-${task.status}`}>
            {isRunning && <span className="agent-run-status-dot" />}
            {STATUS_LABEL[task.status] ?? task.status}
          </span>
          <div className="agent-run-prompt-wrap">
            <button
              className="agent-run-prompt"
              onClick={() => setShowPrompt((v) => !v)}
              title="Click to view the full prompt"
            >
              {task.prompt}
            </button>
            {showPrompt && (
              <>
                <div className="agent-run-prompt-backdrop" onClick={() => setShowPrompt(false)} />
                <div className="agent-run-prompt-pop">
                  <div className="agent-run-prompt-pop-label">Prompt</div>
                  <div className="agent-run-prompt-pop-body">{task.prompt}</div>
                </div>
              </>
            )}
          </div>
          <div className="agent-run-head-actions">
            {!isActive && onContinueChat && (
              <button
                className="agent-run-continue-btn"
                onClick={() => onContinueChat(buildSeed())}
                title="Continue this run as a chat"
              >
                Continue in chat
              </button>
            )}
            {hasSubagents && (
              <div className="agent-run-viewtoggle">
                <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>
                  Activity
                </button>
                <button className={view === 'both' ? 'active' : ''} onClick={() => setView('both')}>
                  Both
                </button>
                <button className={view === 'workflow' ? 'active' : ''} onClick={() => setView('workflow')}>
                  Workflow
                </button>
              </div>
            )}
            {artifacts.length > 0 && (
              <div className="agent-run-artifacts">
                <button
                  className="agent-run-artifacts-btn"
                  onClick={() => setShowArtifacts((v) => !v)}
                  title="Documents the agent saved this run — click to open"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                    <path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                  </svg>
                  {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
                </button>
                {showArtifacts && (
                  <div className="agent-run-artifacts-list">
                    {artifacts.map((a) => (
                      <button
                        key={a.id}
                        className="agent-run-artifact-card"
                        onClick={() => {
                          onOpenArtifact?.(a.id);
                          setShowArtifacts(false);
                        }}
                      >
                        <span className="agent-run-artifact-name">{a.name}</span>
                        <span className="agent-run-artifact-type">{a.type}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        </div>
      </header>

      {hasSubagents && view === 'workflow' ? (
        <div className="agent-run-split">
          <div className="agent-run-split-graph">
            <AgentWorkflowGraph rootId={taskId} onOpenRun={(id) => onOpenRun?.(id)} />
          </div>
        </div>
      ) : hasSubagents && view === 'both' ? (
        <div className="agent-run-split" ref={splitRef}>
          <div className="agent-run-body agent-run-split-main" style={{ flex: `0 0 ${splitPct}%` }}>
            {activityCenter}
          </div>
          <div
            className="agent-run-divider"
            onPointerDown={onDivDown}
            onPointerMove={onDivMove}
            onPointerUp={onDivUp}
            title="Drag to resize"
          />
          <div className="agent-run-split-graph">
            <AgentWorkflowGraph rootId={taskId} onOpenRun={(id) => onOpenRun?.(id)} />
          </div>
        </div>
      ) : (
        <div className="agent-run-body">{activityCenter}</div>
      )}

      {isActive && (
        <div className="agent-run-composer">
          <div className="agent-run-center">
          {pending && pending.kind === 'question' ? (
            <div className="agent-run-question">
              <div className="agent-run-ask-prompt">{pending.prompt}</div>
              {pending.choices && pending.choices.length > 0 && (
                <div className="agent-run-chips">
                  {pending.choices.map((c) => (
                    <button key={c} className="agent-run-chip" disabled={busy}
                      onClick={() => void resolve({ kind: 'answer', text: c })}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
              <div className="agent-run-input-row">
                <textarea
                  className="agent-run-input"
                  rows={1}
                  value={answer}
                  placeholder="Type your answer…"
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (answer.trim()) void resolve({ kind: 'answer', text: answer.trim() });
                    }
                  }}
                />
                <button
                  className="agent-run-btn approve"
                  disabled={busy || !answer.trim()}
                  onClick={() => void resolve({ kind: 'answer', text: answer.trim() })}
                >
                  Send
                </button>
              </div>
            </div>
          ) : pending && pending.kind === 'approval' ? (
            <div className="agent-run-approval">
              <div className="agent-run-ask-prompt">
                The agent wants to run <strong>{pending.tool_name}</strong>
              </div>
              {pending.tool_input !== undefined && pending.tool_input !== null && (
                <pre className="agent-run-approval-args">
                  {JSON.stringify(pending.tool_input, null, 2)}
                </pre>
              )}
              <div className="agent-run-input-row agent-run-approval-actions">
                <button className="agent-run-btn reject" disabled={busy}
                  onClick={() => void resolve({ kind: 'reject' })}>
                  Reject
                </button>
                <button className="agent-run-btn approve" disabled={busy}
                  onClick={() => void resolve({ kind: 'approve' })}>
                  Approve
                </button>
              </div>
            </div>
          ) : (
            <div className="agent-run-working">
              <span className="agent-run-working-text">
                <span className="agent-run-working-dot" />
                Agent is working… it'll ask here if it needs you.
              </span>
              <button className="agent-run-btn stop" onClick={() => cancelTask(taskId)}>
                Stop
              </button>
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
