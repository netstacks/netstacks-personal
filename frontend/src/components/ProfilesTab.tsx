import { useState, useEffect } from 'react';
import {
  listProfiles,
  deleteProfile,
  type CredentialProfile,
} from '../api/profiles';
import ProfileEditorDialog from './ProfileEditorDialog';
import './ProfilesTab.css';

// Icons for the component
import { getErrorMessage } from '../api/errors'
const Icons = {
  star: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  clone: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
};

export default function ProfilesTab() {
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CredentialProfile | null>(null);
  const [cloneMode, setCloneMode] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<CredentialProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Fetch profiles on mount
  useEffect(() => {
    fetchProfiles();
  }, []);

  const fetchProfiles = async () => {
    try {
      setLoading(true);
      const data = await listProfiles();
      setProfiles(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load profiles'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingProfile(null);
    setCloneMode(false);
    setDialogOpen(true);
  };

  const handleEdit = (profile: CredentialProfile) => {
    setEditingProfile(profile);
    setCloneMode(false);
    setDialogOpen(true);
  };

  const handleClone = (profile: CredentialProfile) => {
    setEditingProfile(profile);
    setCloneMode(true);
    setDialogOpen(true);
  };

  const handleDeleteClick = (profile: CredentialProfile) => {
    setDeleteConfirm(profile);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleting(true);
      await deleteProfile(deleteConfirm.id);
      setProfiles(profiles.filter((p) => p.id !== deleteConfirm.id));
      setDeleteConfirm(null);
      setError(null);
      window.dispatchEvent(new Event('profiles-changed'));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete profile'));
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingProfile(null);
    setCloneMode(false);
  };

  const handleProfileSaved = () => {
    fetchProfiles();
    handleDialogClose();
    // Notify App.tsx to refresh its profile cache (used for profileMap/font resolution)
    window.dispatchEvent(new Event('profiles-changed'));
  };

  const getAuthTypeBadge = (authType: string) => {
    return authType === 'key' ? 'Key' : 'Password';
  };

  if (loading) {
    return (
      <div className="profiles-tab">
        <div className="profiles-loading">Loading profiles...</div>
      </div>
    );
  }

  return (
    <div className="profiles-tab">
      <div className="profiles-header">
        <p className="profiles-description">
          Credential profiles define reusable authentication and connection settings for sessions.
        </p>
      </div>

      {error && <div className="profiles-error">{error}</div>}

      <div className="profiles-list">
        {profiles.length === 0 ? (
          <div className="profiles-empty">
            <p>No credential profiles yet.</p>
            <p>Create a profile to share authentication settings across multiple sessions.</p>
          </div>
        ) : (
          profiles.map((profile, index) => (
            <div key={profile.id} className="profile-item">
              <div className="profile-info">
                <div className="profile-name-row">
                  {index === 0 && (
                    <span className="profile-default-star" title="Default profile">
                      {Icons.star}
                    </span>
                  )}
                  <span className="profile-name">{profile.name}</span>
                  {index === 0 && <span className="profile-default-badge">Default</span>}
                </div>
                <div className="profile-details">
                  <span className="profile-user">
                    {profile.username} · port {profile.port}
                  </span>
                  <span className="profile-separator">-</span>
                  <span className={`profile-auth-badge ${profile.auth_type}`}>
                    {getAuthTypeBadge(profile.auth_type)}
                  </span>
                  <span className="profile-separator">-</span>
                  <span className="profile-sessions">0 sessions</span>
                </div>
              </div>
              <div className="profile-actions">
                <button
                  className="profile-action-btn"
                  onClick={() => handleEdit(profile)}
                  title="Edit profile"
                >
                  {Icons.edit}
                  <span>Edit</span>
                </button>
                <button
                  className="profile-action-btn"
                  onClick={() => handleClone(profile)}
                  title="Clone profile"
                >
                  {Icons.clone}
                  <span>Clone</span>
                </button>
                <button
                  className="profile-action-btn delete"
                  onClick={() => handleDeleteClick(profile)}
                  title="Delete profile"
                >
                  {Icons.trash}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="profiles-footer">
        <button className="btn-create-profile" onClick={handleCreate}>
          {Icons.plus}
          <span>Create Profile</span>
        </button>
      </div>

      {/* Profile Editor Dialog */}
      <ProfileEditorDialog
        isOpen={dialogOpen}
        profile={cloneMode ? null : editingProfile}
        cloneFrom={cloneMode ? editingProfile : null}
        profiles={profiles}
        onClose={handleDialogClose}
        onSaved={handleProfileSaved}
      />

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="delete-confirm-overlay" onClick={handleDeleteCancel}>
          <div className="delete-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Profile</h3>
            <p>
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
            </p>
            <p className="delete-confirm-warning">
              This action cannot be undone. Sessions using this profile will need to be updated.
            </p>
            <div className="delete-confirm-actions">
              <button className="btn-secondary" onClick={handleDeleteCancel} disabled={deleting}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
