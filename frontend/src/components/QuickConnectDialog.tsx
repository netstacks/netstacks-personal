import AITabInput from './AITabInput'
import { useState, useEffect, useRef } from 'react';
import './QuickConnectDialog.css';
import { listHistory, createHistory, type ConnectionHistory, type Session, createSession, type NewSession } from '../api/sessions';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import { listAccessibleProfiles } from '../api/enterpriseProfiles';
import { useMode } from '../hooks/useMode';
import type { QuickConnectInfo } from '../lib/terminalTarget';
import { useHostnameFormatter } from '../hooks/useHostnameFormatter';

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import Tooltip from './Tooltip';
import ModalFrame from './ModalFrame';
interface QuickConnectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (session: Session | QuickConnectInfo) => void;
  /** Pre-fill host field (e.g., from topology device) */
  initialHost?: string;
  /** Pre-fill profile ID */
  initialProfileId?: string;
}

/** A selectable credential profile (local profile or Controller accessible profile). */
interface ProfileOption {
  id: string;
  name: string;
  username: string | null;
  /** Shown after "Will connect as": local auth type or Controller auth mode. */
  authLabel: string;
}

async function loadProfileOptions(isEnterprise: boolean): Promise<ProfileOption[]> {
  if (isEnterprise) {
    const profiles = await listAccessibleProfiles();
    return profiles.map(p => ({ id: p.id, name: p.name, username: p.username, authLabel: p.auth_mode }));
  }
  const profiles: CredentialProfile[] = await listProfiles();
  return profiles.map(p => ({ id: p.id, name: p.name, username: p.username, authLabel: p.auth_type }));
}

// Format relative time (e.g., "2 hours ago")
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
}

// The form mounts fresh on every open, so it starts from the initial props
// and needs no reset-on-close.
function QuickConnectDialog(props: QuickConnectDialogProps) {
  if (!props.isOpen) return null;
  return <QuickConnectForm {...props} />;
}

function QuickConnectForm({ onClose, onConnect, initialHost, initialProfileId }: QuickConnectDialogProps) {
  const formatName = useHostnameFormatter()
  // Enterprise connects through the Controller's device-anchored /ws/ssh:
  // the profile is optional (the device's assigned profile applies), there
  // is no local connection history and no local saved sessions.
  const { isEnterprise } = useMode();
  const [host, setHost] = useState(initialHost ?? '');
  const [port, setPort] = useState(22);
  const [profileId, setProfileId] = useState(initialProfileId ?? '');
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConnectionHistory[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [sessionName, setSessionName] = useState('');

  const hostInputRef = useRef<HTMLInputElement>(null);

  const selectedProfile = profiles.find(p => p.id === profileId);

  // Fetch history and profiles when the dialog opens
  useEffect(() => {
    let cancelled = false;
    loadProfileOptions(isEnterprise)
      .then(list => { if (!cancelled) setProfiles(list); })
      .catch(console.error);
    if (!isEnterprise) {
      listHistory()
        .then(list => { if (!cancelled) setHistory(list); })
        .catch(console.error);
    }

    // Focus the profile selector when the host is pre-filled, else the host
    const focusTimer = setTimeout(() => {
      if (initialHost) {
        document.querySelector<HTMLSelectElement>('.quick-connect-dialog #quick-profile')?.focus();
      } else {
        hostInputRef.current?.focus();
      }
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(focusTimer);
    };
  }, [isEnterprise, initialHost]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSaveDialog) {
          setShowSaveDialog(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, showSaveDialog]);

  const handleConnect = async () => {
    if (!host.trim()) {
      setError('Host is required');
      return;
    }
    if (!profileId && !isEnterprise) {
      setError('Credential profile is required');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      // Record history for quick connects (standalone only)
      if (selectedProfile && !isEnterprise) {
        await createHistory({
          host: host.trim(),
          port,
          username: selectedProfile.username ?? '',
        });
      }

      onConnect({
        host: host.trim(),
        port,
        profile_id: profileId,
        username: selectedProfile?.username ?? undefined,
      });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Connection failed'));
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectAndSave = () => {
    if (!host.trim()) {
      setError('Host is required');
      return;
    }
    if (!profileId) {
      setError('Credential profile is required');
      return;
    }

    // Show save dialog
    const profile = profiles.find(p => p.id === profileId);
    setSessionName(`${profile?.username || 'user'}@${host.trim()}`);
    setShowSaveDialog(true);
  };

  const handleSaveAndConnect = async () => {
    if (!sessionName.trim()) {
      setError('Session name is required');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      // Create session first
      const newSession: NewSession = {
        name: sessionName.trim(),
        host: host.trim(),
        port,
        profile_id: profileId,
      };

      const session = await createSession(newSession);

      // Record history
      if (selectedProfile) {
        await createHistory({
          session_id: session.id,
          host: session.host,
          port: session.port,
          username: selectedProfile.username ?? '',
        });
      }

      onConnect(session);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save session'));
    } finally {
      setConnecting(false);
    }
  };

  const handleHistoryClick = (entry: ConnectionHistory) => {
    setHost(entry.host);
    setPort(entry.port);
    // Try to find a profile with matching username
    const matchingProfile = profiles.find(p => p.username === entry.username);
    if (matchingProfile) {
      setProfileId(matchingProfile.id);
    }
  };

  const canConnect = isEnterprise || profiles.length > 0;

  return (
    <ModalFrame id="quick-connect" className="dialog quick-connect-dialog" testId="quick-connect-dialog" label="Quick Connect">
      <div className="dialog-header">
        <h2>Quick Connect</h2>
        <Tooltip label="Close"><button aria-label="Close" className="ns-btn ns-btn--ghost ns-icon-btn" onClick={onClose}>
          ×
        </button></Tooltip>
      </div>

      {showSaveDialog ? (
        <>
          <div className="dialog-content">
            <p className="save-dialog-info">Enter a name for this session:</p>

            {error && <div className="dialog-error">{error}</div>}

            <div className="form-group">
              <label htmlFor="session-name">Session Name</label>
              <AITabInput
                id="session-name"
                value={sessionName}
                onChange={e => setSessionName(e.target.value)}
                placeholder="My Server"
                autoFocus
                aiField="session name"
                aiPlaceholder="Short name for this saved device session"
                aiContext={{ host }}
                onAIValue={setSessionName}
              />
            </div>
          </div>

          <div className="dialog-actions">
            <button
              type="button"
              className="ns-btn"
              onClick={() => setShowSaveDialog(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="ns-btn ns-btn--primary"
              onClick={handleSaveAndConnect}
              disabled={connecting}
            >
              {connecting ? 'Saving...' : 'Save & Connect'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="dialog-content">
            {error && <div className="dialog-error">{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="quick-host">Host</label>
                <input data-ai-fill="off" className="ns-input"
                  ref={hostInputRef}
                  id="quick-host"
                  type="text"
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="192.168.1.1 or hostname"
                />
              </div>
              <div className="form-group small">
                <label htmlFor="quick-port">Port</label>
                <input className="ns-input"
                  id="quick-port"
                  type="number"
                  value={port}
                  onChange={e => setPort(parseInt(e.target.value) || 22)}
                  min={1}
                  max={65535}
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="quick-profile">
                Credential Profile {!isEnterprise && <span className="required-marker">*</span>}
              </label>
              {!canConnect ? (
                <div className="profile-warning">
                  <span>No credential profiles configured.</span>
                  <span className="form-hint">Create a profile in Settings → Profiles first.</span>
                </div>
              ) : (
                <>
                  <select
                    id="quick-profile"
                    value={profileId}
                    onChange={e => setProfileId(e.target.value)}
                    className="ns-select"
                    aria-invalid={!isEnterprise && !profileId}
                  >
                    <option value="">{isEnterprise ? "Device's assigned profile" : 'Select a profile...'}</option>
                    {profiles.map(profile => (
                      <option key={profile.id} value={profile.id}>
                        {profile.username ? `${profile.name} (${profile.username})` : profile.name}
                      </option>
                    ))}
                  </select>
                  {selectedProfile ? (
                    <span className="form-hint">
                      Will connect as: {selectedProfile.username ?? 'profile user'} ({selectedProfile.authLabel})
                    </span>
                  ) : isEnterprise && (
                    <span className="form-hint">
                      The host must be a device in your organization.
                    </span>
                  )}
                </>
              )}
            </div>

            {history.length > 0 && (
              <div className="recent-connections">
                <div className="recent-header">Recent Connections</div>
                <div className="recent-list">
                  {history.slice(0, 5).map(entry => (
                    <button
                      key={entry.id}
                      className="recent-item"
                      onClick={() => handleHistoryClick(entry)}
                    >
                      <span className="recent-connection">
                        {entry.username}@{formatName(entry.host)}:{entry.port}
                      </span>
                      <span className="recent-time">
                        {formatRelativeTime(entry.connected_at)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter
            primary={{ label: connecting ? 'Connecting...' : 'Connect', onClick: handleConnect, disabled: connecting || !canConnect }}
            onCancel={onClose}
            leading={isEnterprise ? undefined : (
              <button
                type="button"
                className="ns-btn"
                onClick={handleConnectAndSave}
                disabled={connecting || profiles.length === 0}
              >
                Connect & Save...
              </button>
            )}
          />
        </>
      )}
    </ModalFrame>
  );
}

export default QuickConnectDialog;
