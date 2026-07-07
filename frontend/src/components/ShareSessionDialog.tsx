import { useState, useEffect, useCallback, useRef } from 'react';
import { copyToClipboard } from '../lib/clipboard';
import './ShareSessionDialog.css';
import {
  createSessionShare,
  listSessionShares,
  revokeSessionShare,
  type CreateShareResponse,
  type ShareListItem,
} from '../api/sharing';

import { getErrorMessage } from '../api/errors'
interface ShareSessionDialogProps {
  isOpen: boolean;
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  /** Called when share status changes (created/revoked/viewer count update) */
  onShareStatusChange?: (sessionId: string, share: { token: string; viewerCount: number } | null) => void;
}

export default function ShareSessionDialog({
  isOpen,
  sessionId,
  sessionName,
  onClose,
  onShareStatusChange,
}: ShareSessionDialogProps) {
  const [permission, setPermission] = useState<'read-only' | 'read-write'>('read-only');
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [maxViewers, setMaxViewers] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Existing shares for this session
  const [existingShares, setExistingShares] = useState<ShareListItem[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Newly created share (show URL)
  const [newShare, setNewShare] = useState<CreateShareResponse | null>(null);

  // Polling for share list refresh
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch existing shares when dialog opens
  const fetchShares = useCallback(async () => {
    try {
      const shares = await listSessionShares(sessionId);
      setExistingShares(shares);
    } catch {
      // Non-fatal — might not have shares yet
    }
  }, [sessionId]);

  useEffect(() => {
    if (!isOpen) return;
    setLoadingShares(true);
    fetchShares().finally(() => setLoadingShares(false));

    // Poll every 10 seconds for updated share list
    pollRef.current = setInterval(fetchShares, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isOpen, fetchShares]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setNewShare(null);
      setShowCreateForm(false);
      setError(null);
      setCopied(null);
    }
  }, [isOpen]);

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await createSessionShare(sessionId, {
        permission,
        ttl_minutes: ttlMinutes,
        max_viewers: maxViewers,
      });
      setNewShare(result);
      setShowCreateForm(false);
      onShareStatusChange?.(sessionId, { token: result.token, viewerCount: 0 });
      await fetchShares();
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Failed to create share link');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [sessionId, permission, ttlMinutes, maxViewers, fetchShares, onShareStatusChange]);

  const handleRevoke = useCallback(async (token: string) => {
    setLoading(true);
    setError(null);
    try {
      await revokeSessionShare(sessionId, token);
      if (newShare?.token === token) setNewShare(null);
      await fetchShares();
      // If no shares left, notify parent
      const remaining = existingShares.filter(s => s.token !== token);
      if (remaining.length === 0) {
        onShareStatusChange?.(sessionId, null);
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Failed to revoke share');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [sessionId, newShare, existingShares, fetchShares, onShareStatusChange]);

  const handleRevokeAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      for (const share of existingShares) {
        await revokeSessionShare(sessionId, share.token);
      }
      setNewShare(null);
      setExistingShares([]);
      onShareStatusChange?.(sessionId, null);
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Failed to revoke shares');
      setError(msg);
      await fetchShares();
    } finally {
      setLoading(false);
    }
  }, [sessionId, existingShares, fetchShares, onShareStatusChange]);

  const handleCopy = useCallback(async (url: string, token: string) => {
    if (await copyToClipboard(url)) {
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
    }
  }, []);

  const handleClose = useCallback(() => {
    setError(null);
    setCopied(null);
    onClose();
  }, [onClose]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const hasShares = existingShares.length > 0;

  return (
    <div className="share-dialog-overlay">
      <div className="share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-dialog-header">
          <h2>Share Session: {sessionName}</h2>
          <button className="share-dialog-close" onClick={handleClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="share-dialog-body">
          {error && <div className="share-error">{error}</div>}

          {/* Newly created share URL */}
          {newShare && (
            <div className="share-new-link">
              <div className="share-link-row">
                <input
                  className="share-link-input"
                  readOnly
                  value={newShare.share_url}
                  onFocus={(e) => e.target.select()}
                />
                <button className="share-link-copy" onClick={() => handleCopy(newShare.share_url, newShare.token)}>
                  {copied === newShare.token ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Existing shares list */}
          {loadingShares ? (
            <div className="share-loading">Loading shares...</div>
          ) : hasShares ? (
            <div className="share-list">
              <div className="share-list-header">
                <span>Active Shares ({existingShares.length})</span>
                {existingShares.length > 1 && (
                  <button
                    className="share-revoke-all"
                    onClick={handleRevokeAll}
                    disabled={loading}
                  >
                    Revoke All
                  </button>
                )}
              </div>
              {existingShares.map(share => (
                <div key={share.token} className="share-list-item">
                  <div className="share-list-item-info">
                    <span className={`share-permission-badge ${share.permission}`}>
                      {share.permission === 'read-only' ? 'Read Only' : 'Read Write'}
                    </span>
                    <span className="share-list-item-meta">
                      Expires {new Date(share.expires_at).toLocaleTimeString()}
                    </span>
                    <span className="share-list-item-token" title={share.token}>
                      {share.token.substring(0, 8)}...
                    </span>
                  </div>
                  <div className="share-list-item-actions">
                    <button
                      className="share-list-item-btn"
                      onClick={() => handleCopy(
                        `${window.location.origin}/terminal/#share=${share.token}`,
                        share.token
                      )}
                    >
                      {copied === share.token ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      className="share-list-item-btn share-list-item-btn-danger"
                      onClick={() => handleRevoke(share.token)}
                      disabled={loading}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : !showCreateForm ? (
            <div className="share-empty">No active shares for this session</div>
          ) : null}

          {/* Create form */}
          {showCreateForm && (
            <>
              <div className="share-dialog-field">
                <label>Permission</label>
                <select
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as 'read-only' | 'read-write')}
                >
                  <option value="read-only">Read Only (view terminal output)</option>
                  <option value="read-write">Read Write (can type commands)</option>
                </select>
              </div>

              <div className="share-dialog-field">
                <label>Expiry (minutes)</label>
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={ttlMinutes}
                  onChange={(e) => setTtlMinutes(Number(e.target.value))}
                />
              </div>

              <div className="share-dialog-field">
                <label>Max Viewers</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxViewers}
                  onChange={(e) => setMaxViewers(Number(e.target.value))}
                />
              </div>
            </>
          )}
        </div>

        <div className="share-dialog-actions">
          {showCreateForm ? (
            <>
              <button
                className="share-dialog-btn share-dialog-btn-secondary"
                onClick={() => setShowCreateForm(false)}
              >
                Back
              </button>
              <button
                className="share-dialog-btn share-dialog-btn-primary"
                onClick={handleCreate}
                disabled={loading}
              >
                {loading ? 'Creating...' : 'Create Share Link'}
              </button>
            </>
          ) : (
            <>
              <button
                className="share-dialog-btn share-dialog-btn-secondary"
                onClick={handleClose}
              >
                {hasShares ? 'Done' : 'Cancel'}
              </button>
              <button
                className="share-dialog-btn share-dialog-btn-primary"
                onClick={() => { setShowCreateForm(true); setNewShare(null); }}
              >
                New Share Link
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
