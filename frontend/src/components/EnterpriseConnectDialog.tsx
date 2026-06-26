import { useState, useEffect } from 'react';
import { listAccessibleCredentials, getUserDefaultCredential } from '../api/enterpriseCredentials';
import type { AccessibleCredential } from '../types/enterpriseCredential';
import type { EnterpriseSession } from '../api/enterpriseSessions';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import './EnterpriseConnectDialog.css';

import { getErrorMessage } from '../api/errors'
interface EnterpriseConnectDialogProps {
  session: EnterpriseSession;
  onConnect: (credentialId: string) => void;
  onCancel: () => void;
  deviceName?: string; // Show device name in title if connecting from device panel (Phase 42.2-03)
}

const Icons = {
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
};

export default function EnterpriseConnectDialog({
  session,
  onConnect,
  onCancel,
  deviceName,
}: EnterpriseConnectDialogProps) {
  const [credentials, setCredentials] = useState<AccessibleCredential[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOverride, setIsOverride] = useState(false);

  // Load credentials on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        // Fetch accessible credentials and default credential in parallel
        const [credsList, defaultCred] = await Promise.all([
          listAccessibleCredentials(),
          getUserDefaultCredential(),
        ]);

        if (cancelled) return;

        setCredentials(credsList);

        // Determine which credential to select
        if (session.credential_override_id) {
          // Session has an override credential
          const override = credsList.find((c) => c.id === session.credential_override_id);
          if (override) {
            setSelectedCredentialId(override.id);
            setIsOverride(true);
          } else if (defaultCred) {
            // Override credential not accessible, fall back to default
            setSelectedCredentialId(defaultCred.id);
            setIsOverride(false);
          }
        } else if (defaultCred) {
          // No override, use default
          setSelectedCredentialId(defaultCred.id);
          setIsOverride(false);
        }
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err, 'Failed to load credentials'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session.credential_override_id]);

  const handleConnect = () => {
    if (!selectedCredentialId) {
      setError('Please select a credential');
      return;
    }
    onConnect(selectedCredentialId);
  };

  const getCredentialIcon = (type: string) => {
    if (type.includes('key')) return Icons.key;
    return Icons.lock;
  };

  const formatCredentialLabel = (cred: AccessibleCredential) => {
    const parts: string[] = [cred.name];
    if (cred.username) parts.push(`(${cred.username})`);
    if (cred.credential_type === 'ssh_key') {
      parts.push('[SSH Key]');
    } else if (cred.credential_type === 'ssh_password') {
      parts.push('[Password]');
    }
    return parts.join(' ');
  };

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onCancel });

  return (
    <div className="enterprise-connect-dialog-overlay" {...backdropProps}>
      <div className="enterprise-connect-dialog" {...contentProps}>
        <div className="enterprise-connect-dialog-header">
          <h3>Connect to {deviceName || session.name}</h3>
          <button
            className="enterprise-connect-dialog-close"
            onClick={onCancel}
            title="Cancel"
          >
            {Icons.x}
          </button>
        </div>

        <div className="enterprise-connect-dialog-body">
          <div className="enterprise-connect-session-info">
            <div className="enterprise-connect-info-row">
              <span className="label">Host:</span>
              <span className="value">{session.host}:{session.port}</span>
            </div>
            {session.description && (
              <div className="enterprise-connect-info-row">
                <span className="label">Description:</span>
                <span className="value">{session.description}</span>
              </div>
            )}
          </div>

          {loading && (
            <div className="enterprise-connect-loading">
              Loading credentials...
            </div>
          )}

          {error && !loading && (
            <div className="enterprise-connect-error">
              {error}
            </div>
          )}

          {!loading && !error && credentials.length === 0 && (
            <div className="enterprise-connect-empty">
              <p>No credentials available.</p>
              <p className="help-text">Contact your administrator to request access.</p>
            </div>
          )}

{!loading && !error && credentials.length > 0 && (() => {
            const personalCreds = credentials.filter(c => c.vault_type === 'personal');
            const sharedCreds = credentials.filter(c => c.vault_type === 'shared');

            return (
              <div className="enterprise-connect-credential-select">
                <label htmlFor="credential-select">
                  Select Credential:
                  {isOverride && (
                    <span className="override-badge">session override</span>
                  )}
                </label>
                <div className="credential-select-wrapper">
                  <select
                    id="credential-select"
                    value={selectedCredentialId}
                    onChange={(e) => setSelectedCredentialId(e.target.value)}
                    className="credential-select"
                  >
                    {personalCreds.length > 0 && (
                      <optgroup label="My Credentials">
                        {personalCreds.map((cred) => (
                          <option key={cred.id} value={cred.id}>
                            {formatCredentialLabel(cred)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {sharedCreds.length > 0 && (
                      <optgroup label="Shared Credentials">
                        {sharedCreds.map((cred) => (
                          <option key={cred.id} value={cred.id}>
                            {formatCredentialLabel(cred)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                {personalCreds.length === 0 && (
                  <div className="credential-section-info">
                    <span className="vault-icon">{Icons.user}</span>
                    <span className="info-text">No personal credentials yet</span>
                  </div>
                )}
                {sharedCreds.length === 0 && (
                  <div className="credential-section-info">
                    <span className="vault-icon">{Icons.users}</span>
                    <span className="info-text">No shared credentials available</span>
                  </div>
                )}

                {selectedCredentialId && (
                  <div className="credential-details">
                    {(() => {
                      const cred = credentials.find((c) => c.id === selectedCredentialId);
                      if (!cred) return null;

                      return (
                        <div className="credential-info">
                          <span className="credential-icon">
                            {getCredentialIcon(cred.credential_type)}
                          </span>
                          <div className="credential-meta">
                            <div className="credential-name">
                              {cred.name}
                              <span className={`vault-badge ${cred.vault_type}`}>
                                {cred.vault_type === 'personal' ? Icons.user : Icons.users}
                              </span>
                            </div>
                            {cred.description && (
                              <div className="credential-description">{cred.description}</div>
                            )}
                            {cred.host && (
                              <div className="credential-host">
                                Target: {cred.host}
                                {cred.port && cred.port !== 22 && `:${cred.port}`}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <div className="enterprise-connect-dialog-footer">
          <button
            className="enterprise-connect-btn secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="enterprise-connect-btn primary"
            onClick={handleConnect}
            disabled={loading || !selectedCredentialId || credentials.length === 0}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
