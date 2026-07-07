import { useState, useEffect, useRef } from 'react';
import './QuickConnectDialog.css';
import { listHistory, createHistory, type ConnectionHistory, type Session, createSession, type NewSession } from '../api/sessions';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import { useHostnameFormatter } from '../hooks/useHostnameFormatter';

import { getErrorMessage } from '../api/errors'
interface QuickConnectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (session: Session | { host: string; port: number; profile_id: string; username: string }) => void;
  /** Pre-fill host field (e.g., from topology device) */
  initialHost?: string;
  /** Pre-fill profile ID */
  initialProfileId?: string;
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

function QuickConnectDialog({ isOpen, onClose, onConnect, initialHost, initialProfileId }: QuickConnectDialogProps) {
  const formatName = useHostnameFormatter()
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [profileId, setProfileId] = useState('');
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConnectionHistory[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [sessionName, setSessionName] = useState('');

  const hostInputRef = useRef<HTMLInputElement>(null);

  const selectedProfile = profiles.find(p => p.id === profileId);

  // Fetch history and profiles when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Load profiles
      listProfiles()
        .then(setProfiles)
        .catch(console.error);

      // Load history
      listHistory()
        .then(setHistory)
        .catch(console.error);

      // Set initial values if provided (e.g., from topology device)
      if (initialHost) {
        setHost(initialHost);
      }
      if (initialProfileId) {
        setProfileId(initialProfileId);
      }

      // Focus host input
      setTimeout(() => {
        if (initialHost) {
          // Focus profile selector if host is pre-filled
          document.querySelector<HTMLSelectElement>('.quick-connect-dialog #quick-profile')?.focus();
        } else {
          hostInputRef.current?.focus();
        }
      }, 50);
    }
  }, [isOpen, initialHost, initialProfileId]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setHost('');
      setPort(22);
      setProfileId('');
      setError(null);
      setShowSaveDialog(false);
      setSessionName('');
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        if (showSaveDialog) {
          setShowSaveDialog(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showSaveDialog]);

  const handleConnect = async () => {
    if (!host.trim()) {
      setError('Host is required');
      return;
    }
    if (!profileId) {
      setError('Credential profile is required');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      // Record history for quick connects
      if (selectedProfile) {
        await createHistory({
          host: host.trim(),
          port,
          username: selectedProfile.username,
        });
      }

      // Create connection object with profile
      const connectionInfo = {
        host: host.trim(),
        port,
        profile_id: profileId,
        username: selectedProfile!.username,
      };

      onConnect(connectionInfo);
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
          username: selectedProfile.username,
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

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay">
      <div className="dialog quick-connect-dialog" data-testid="quick-connect-dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>Quick Connect</h2>
          <button className="dialog-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        {showSaveDialog ? (
          <div className="dialog-content">
            <p className="save-dialog-info">Enter a name for this session:</p>

            {error && <div className="dialog-error">{error}</div>}

            <div className="form-group">
              <label htmlFor="session-name">Session Name</label>
              <input
                id="session-name"
                type="text"
                value={sessionName}
                onChange={e => setSessionName(e.target.value)}
                placeholder="My Server"
                autoFocus
              />
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowSaveDialog(false)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSaveAndConnect}
                disabled={connecting}
              >
                {connecting ? 'Saving...' : 'Save & Connect'}
              </button>
            </div>
          </div>
        ) : (
          <div className="dialog-content">
            {error && <div className="dialog-error">{error}</div>}

            <div className="form-row">
              <div className="form-group flex-grow">
                <label htmlFor="quick-host">Host</label>
                <input
                  ref={hostInputRef}
                  id="quick-host"
                  type="text"
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="192.168.1.1 or hostname"
                />
              </div>
              <div className="form-group" style={{ width: '100px' }}>
                <label htmlFor="quick-port">Port</label>
                <input
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
              <label htmlFor="quick-profile">Credential Profile <span className="required-marker">*</span></label>
              {profiles.length === 0 ? (
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
                    className={!profileId ? 'error' : ''}
                  >
                    <option value="">Select a profile...</option>
                    {profiles.map(profile => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} ({profile.username})
                      </option>
                    ))}
                  </select>
                  {selectedProfile && (
                    <span className="form-hint">
                      Will connect as: {selectedProfile.username} ({selectedProfile.auth_type})
                    </span>
                  )}
                </>
              )}
            </div>

            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleConnectAndSave}
                disabled={connecting || profiles.length === 0}
              >
                Connect & Save...
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleConnect}
                disabled={connecting || profiles.length === 0}
              >
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
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
        )}
      </div>
    </div>
  );
}

export default QuickConnectDialog;
