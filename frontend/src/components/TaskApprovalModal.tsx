// AUDIT FIX (EXEC-017): per-tool-call user approval modal for ReAct tasks.
//
// Polls /api/task-approvals every 750 ms. When a pending approval shows
// up, surfaces a modal showing the tool name + arguments so the user can
// review before the agent actually runs the call. While waiting, the
// task itself stays in `Running` state but the agent loop is parked on
// the oneshot channel inside the backend approval service.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAllTaskApprovals,
  approveTaskToolUse,
  rejectTaskToolUse,
  type PendingTaskApproval,
} from '../api/taskApprovals';
import { useMode } from '../hooks/useMode';

import { getErrorMessage } from '../api/errors'
const POLL_INTERVAL_MS = 750;
/** Matches `tasks::approvals::APPROVAL_TIMEOUT`. */
const APPROVAL_TIMEOUT_SECS = 600;

export default function TaskApprovalModal() {
  const [approval, setApproval] = useState<PendingTaskApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const { isEnterprise } = useMode();
  const lastIdRef = useRef<string | null>(null);

  // Poll for pending approvals — sidecar/standalone only.
  useEffect(() => {
    if (isEnterprise) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const items = await listAllTaskApprovals();
        if (cancelled) return;
        const next = items[0] ?? null;
        const nextId = next?.id ?? null;
        if (nextId !== lastIdRef.current) {
          lastIdRef.current = nextId;
          setApproval(next);
          setError(null);
        }
      } catch {
        // Backend unreachable / vault locked → no prompts to surface.
      }
    };

    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [isEnterprise]);

  // Tick for countdown.
  useEffect(() => {
    if (!approval) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [approval]);

  const secondsRemaining = approval
    ? Math.max(
        0,
        APPROVAL_TIMEOUT_SECS -
          Math.floor((now - new Date(approval.created_at).getTime()) / 1000)
      )
    : 0;

  const handleApprove = useCallback(async () => {
    if (!approval) return;
    setBusy(true); setError(null);
    try {
      await approveTaskToolUse(approval.id);
      setApproval(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to approve'));
    } finally { setBusy(false); }
  }, [approval]);

  const handleReject = useCallback(async () => {
    if (!approval) return;
    setBusy(true); setError(null);
    try {
      await rejectTaskToolUse(approval.id);
      setApproval(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to reject'));
    } finally { setBusy(false); }
  }, [approval]);

  if (!approval) return null;

  const inputJson = (() => {
    try { return JSON.stringify(approval.tool_input, null, 2); }
    catch { return String(approval.tool_input); }
  })();

  // High-risk tools get a red border; everything else amber.
  const isDestructive =
    approval.tool_name.startsWith('mcp_') ||
    approval.tool_name === 'send_email' ||
    approval.tool_name.includes('write_file') ||
    approval.tool_name.includes('edit_file') ||
    approval.tool_name.includes('patch_file');

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} role="alertdialog" aria-modal="true">
      <div style={{
        background: '#1f2937', color: '#f3f4f6',
        border: isDestructive ? '2px solid #dc2626' : '1px solid #b45309',
        borderRadius: 8, padding: 24, maxWidth: 640, width: '90%',
        fontFamily: 'system-ui, sans-serif',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ margin: '0 0 8px', fontSize: '18px' }}>
          {isDestructive ? '⚠ Agent wants to run a mutating tool' : '🔧 Agent requests tool use'}
        </h2>
        <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#d1d5db' }}>
          The background agent task <code>{approval.task_id.slice(0, 8)}…</code> wants to invoke
          <strong> {approval.tool_name}</strong> with the arguments below. Review and approve only
          if this matches what you asked the agent to do.
        </p>
        <pre style={{
          fontFamily: 'ui-monospace, monospace', fontSize: '12px',
          background: '#111827', padding: '10px 12px', borderRadius: 4,
          border: '1px solid #374151', maxHeight: 280, overflow: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0 0 12px',
        }}>{inputJson}</pre>
        <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: 16 }}>
          Auto-rejects in <strong>{secondsRemaining}s</strong> if not resolved.
        </div>
        {error && (
          <div style={{ color: '#fca5a5', fontSize: '12px', marginBottom: 12 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={handleReject} disabled={busy}
            style={{
              padding: '8px 16px', borderRadius: 4,
              background: 'transparent', color: '#9ca3af',
              border: '1px solid #4b5563', cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1, fontSize: '14px', fontWeight: 500,
            }}>Reject</button>
          <button onClick={handleApprove} disabled={busy}
            style={{
              padding: '8px 16px', borderRadius: 4,
              background: isDestructive ? '#dc2626' : '#16a34a',
              color: '#fff', border: 'none',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1, fontSize: '14px', fontWeight: 500,
            }}>{busy ? 'Working…' : 'Approve'}</button>
        </div>
      </div>
    </div>
  );
}
