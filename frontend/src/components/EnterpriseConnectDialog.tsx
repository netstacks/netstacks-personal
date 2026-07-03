import { useState, useEffect } from 'react';
import { loadConnectTargets } from '../api/enterpriseProfiles';
import type { AccessibleProfile } from '../types/enterpriseProfile';
import type { EnterpriseSession } from '../api/enterpriseSessions';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import './EnterpriseConnectDialog.css';

import { getErrorMessage } from '../api/errors'
interface EnterpriseConnectDialogProps {
  session: EnterpriseSession;
  /** Called with the chosen profile id, or '' to send NO profile_id (let the
   *  controller device-anchor: device's assigned profile → user default). */
  onConnect: (profileId: string) => void;
  onCancel: () => void;
  deviceName?: string; // Show device name in title if connecting from device panel (Phase 42.2-03)
  /** The device's assigned profile id (device-anchored default), used to label
   *  the "Device default" option with the resolved profile name when known. */
  deviceProfileId?: string;
}

// Sentinel select value representing "no explicit override" — send no profile_id
// so the controller device-anchors. Distinct from '' (which means "nothing picked").
const DEVICE_DEFAULT = '__device_default__';

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

const PROFILE_TYPE_LABEL: Record<AccessibleProfile['profile_type'], string> = {
  personal: 'My Profiles',
  shared: 'Shared',
  service: 'Service',
};

function authModeLabel(authMode: AccessibleProfile['auth_mode']): string {
  switch (authMode) {
    case 'certificate': return 'Certificate';
    case 'ssh_key': return 'SSH Key';
    case 'password': return 'Password';
    default: return 'No auth';
  }
}

export default function EnterpriseConnectDialog({
  session,
  onConnect,
  onCancel,
  deviceName,
  deviceProfileId,
}: EnterpriseConnectDialogProps) {
  const [profiles, setProfiles] = useState<AccessibleProfile[]>([]);
  // Default to the device-anchored option (no explicit override).
  const [selectedProfileId, setSelectedProfileId] = useState<string>(DEVICE_DEFAULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load profiles on mount (capability-aware: profiles, or legacy creds mapped)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        // Fetch the list of selectable override profiles. The default selection
        // stays DEVICE_DEFAULT (send no profile_id) so the controller device-anchors;
        // the user only picks a specific profile to *override* that.
        const list = await loadConnectTargets();

        if (cancelled) return;

        setProfiles(list);
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err, 'Failed to load profiles'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnect = () => {
    if (!selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    // Device default → send NO profile_id (empty string) so the controller
    // device-anchors. Any other value is an explicit per-connection override.
    onConnect(selectedProfileId === DEVICE_DEFAULT ? '' : selectedProfileId);
  };

  const getProfileIcon = (authMode: AccessibleProfile['auth_mode']) => {
    if (authMode === 'ssh_key' || authMode === 'certificate') return Icons.key;
    return Icons.lock;
  };

  const formatProfileLabel = (profile: AccessibleProfile) => {
    const parts: string[] = [profile.name];
    if (profile.username) parts.push(`(${profile.username})`);
    parts.push(`[${authModeLabel(profile.auth_mode)}]`);
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
              <span className="value">{session.port ? `${session.host}:${session.port}` : session.host}</span>
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
              Loading profiles...
            </div>
          )}

          {error && !loading && (
            <div className="enterprise-connect-error">
              {error}
            </div>
          )}

{!loading && !error && (() => {
            const personalProfiles = profiles.filter(p => p.profile_type === 'personal');
            const sharedProfiles = profiles.filter(p => p.profile_type === 'shared');
            const serviceProfiles = profiles.filter(p => p.profile_type === 'service');

            // Label the device-anchored option with the resolved profile name
            // when the device has an assigned profile we can see in the list.
            const deviceDefaultProfile = deviceProfileId
              ? profiles.find((p) => p.id === deviceProfileId)
              : undefined;
            const deviceDefaultLabel = deviceDefaultProfile
              ? `Device default (recommended) — ${deviceDefaultProfile.name}`
              : 'Device default (recommended)';

            return (
              <div className="enterprise-connect-credential-select">
                <label htmlFor="profile-select">
                  Select Profile:
                </label>
                <div className="credential-select-wrapper">
                  <select
                    id="profile-select"
                    value={selectedProfileId}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                    className="credential-select"
                  >
                    <option value={DEVICE_DEFAULT}>{deviceDefaultLabel}</option>
                    {personalProfiles.length > 0 && (
                      <optgroup label={PROFILE_TYPE_LABEL.personal}>
                        {personalProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {formatProfileLabel(profile)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {sharedProfiles.length > 0 && (
                      <optgroup label={PROFILE_TYPE_LABEL.shared}>
                        {sharedProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {formatProfileLabel(profile)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {serviceProfiles.length > 0 && (
                      <optgroup label={PROFILE_TYPE_LABEL.service}>
                        {serviceProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {formatProfileLabel(profile)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                {personalProfiles.length === 0 && (
                  <div className="credential-section-info">
                    <span className="vault-icon">{Icons.user}</span>
                    <span className="info-text">No personal profiles yet</span>
                  </div>
                )}

                {selectedProfileId && (
                  <div className="credential-details">
                    {(() => {
                      const profile = profiles.find((p) => p.id === selectedProfileId);
                      if (!profile) return null;

                      return (
                        <div className="credential-info">
                          <span className="credential-icon">
                            {getProfileIcon(profile.auth_mode)}
                          </span>
                          <div className="credential-meta">
                            <div className="credential-name">
                              {profile.name}
                              <span className={`vault-badge ${profile.profile_type}`}>
                                {profile.profile_type === 'personal' ? Icons.user : Icons.users}
                              </span>
                            </div>
                            {profile.description && (
                              <div className="credential-description">{profile.description}</div>
                            )}
                            <div className="credential-host">
                              Auth: {authModeLabel(profile.auth_mode)}
                              {profile.transports.length > 0 && ` · ${profile.transports.join(', ')}`}
                            </div>
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
            disabled={loading || !selectedProfileId}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
