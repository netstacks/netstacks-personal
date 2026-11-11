// AUDIT FIX (REMOTE-001): host-key fingerprint approval modal.
//
// Polls /api/host-keys/prompts every 750 ms. When a pending prompt
// appears, surfaces a modal with the SHA-256 fingerprint and (if the key
// has changed) the previously-trusted fingerprint side-by-side. The user
// must explicitly Accept or Reject before the SSH handshake proceeds.
//
// This component should be mounted once at the app root so it's always
// available. The polling overhead is minimal (one HTTP GET per 750 ms)
// and only runs when the user is signed in / standalone agent is up.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listHostKeyPrompts,
  approveHostKeyPrompt,
  rejectHostKeyPrompt,
  type HostKeyPrompt,
} from '../api/hostKeys';
import { useMode } from '../hooks/useMode';
import { useAuthStore } from '../stores/authStore';

import { getErrorMessage } from '../api/errors'
import ModalFrame from './ModalFrame';
import './HostKeyPromptModal.css'
/** Server-side prompt timeout (matches `approvals::PROMPT_TIMEOUT`). */
const PROMPT_TIMEOUT_SECS = 120;

const POLL_INTERVAL_MS = 750;

export default function HostKeyPromptModal() {
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const { isEnterprise } = useMode();
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const lastPromptIdRef = useRef<string | null>(null);

  // In enterprise mode, wait until authenticated before polling —
  // the controller requires a valid JWT for /api/host-keys/prompts.
  const shouldPoll = isEnterprise ? isAuthenticated : true;

  // Poll for pending host-key prompts. In standalone mode this hits the
  // local sidecar; in enterprise mode it hits the controller — both expose
  // the same /api/host-keys/prompts surface via getClient().
  useEffect(() => {
    if (!shouldPoll) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const prompts = await listHostKeyPrompts();
        if (cancelled) return;
        const next = prompts[0] ?? null;
        // Only swap state when the active prompt actually changes — avoids
        // re-render churn from the 750 ms poll.
        const nextId = next?.id ?? null;
        if (nextId !== lastPromptIdRef.current) {
          lastPromptIdRef.current = nextId;
          setPrompt(next);
          setError(null);
        }
      } catch {
        // Backend unreachable / vault locked → no prompts to surface.
      }
    };

    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [shouldPoll]);

  // Tick a 1 s clock so the countdown updates without prop-drilling.
  useEffect(() => {
    if (!prompt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [prompt]);

  const secondsRemaining = prompt
    ? Math.max(
        0,
        PROMPT_TIMEOUT_SECS -
          Math.floor((now - new Date(prompt.created_at).getTime()) / 1000)
      )
    : 0;

  const handleApprove = useCallback(async () => {
    if (!prompt) return;
    setBusy(true);
    setError(null);
    try {
      await approveHostKeyPrompt(prompt.id);
      setPrompt(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to approve host key'));
    } finally {
      setBusy(false);
    }
  }, [prompt]);

  const handleReject = useCallback(async () => {
    if (!prompt) return;
    setBusy(true);
    setError(null);
    try {
      await rejectHostKeyPrompt(prompt.id);
      setPrompt(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to reject host key'));
    } finally {
      setBusy(false);
    }
  }, [prompt]);

  if (!prompt) return null;

  return (
    <ModalFrame id="host-key-prompt" layer="gate" role="alertdialog" className={`dialog host-key-prompt${prompt.is_changed_key ? ' changed' : ''}`} labelledBy="host-key-prompt-title">
      <div className="dialog-header">
        <h2 id="host-key-prompt-title">
          {prompt.is_changed_key
            ? '⚠ SSH host key has CHANGED'
            : '🔑 Confirm SSH host key'}
        </h2>
      </div>

      <div className="dialog-content host-key-prompt-content">
        <p>
          {prompt.is_changed_key ? (
            <>
              The remote host <strong>{prompt.host}:{prompt.port}</strong> presented
              a different SSH key than what NetStacks has on file. This <strong>could
              indicate a man-in-the-middle attack</strong>, or the device may have
              been re-imaged. <strong>Verify with the device owner before accepting.</strong>
            </>
          ) : (
            <>
              First connection to <strong>{prompt.host}:{prompt.port}</strong>.
              Verify the SHA-256 fingerprint below against an out-of-band source
              (the device's <code>show crypto key mypubkey</code>,
              <code>show ssh server host-keys</code>, or your inventory record)
              before accepting.
            </>
          )}
        </p>

        {prompt.is_changed_key && prompt.previous_fingerprint && (
          <div className="form-group">
            <span className="form-hint">Previously-trusted key:</span>
            <div className="host-key-prompt-fingerprint">{prompt.previous_fingerprint}</div>
          </div>
        )}

        <div className="form-group">
          <span className="form-hint">Key the host just presented:</span>
          <div className="host-key-prompt-fingerprint">{prompt.fingerprint}</div>
        </div>

        <p className="form-hint">
          Auto-rejects in <strong>{secondsRemaining}s</strong> if not resolved.
        </p>

        {error && <div className="dialog-error">{error}</div>}
      </div>

      <div className="dialog-actions">
        <button type="button" className="ns-btn" onClick={handleReject} disabled={busy}>
          Reject
        </button>
        <button
          type="button"
          className={`ns-btn ${prompt.is_changed_key ? 'ns-btn--danger' : 'ns-btn--primary'}`}
          onClick={handleApprove}
          disabled={busy}
        >
          {busy ? 'Working…' : prompt.is_changed_key ? 'Trust New Key Anyway' : 'Trust This Key'}
        </button>
      </div>
    </ModalFrame>
  );
}
