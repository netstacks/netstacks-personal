import { useState, useEffect } from 'react';
import {
  listProfiles,
  deleteProfile,
  type CredentialProfile,
} from '../api/profiles';
import ProfileEditorDialog from './ProfileEditorDialog';
import './ProfilesTab.css';

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
import ModalFrame from './ModalFrame';
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
      <p className="form-hint">Loading profiles…</p>
    );
  }

  return (
    <>
      <SettingsSection
        title="Credential Profiles"
        description="Reusable authentication and connection settings for sessions."
        help={{
          topic: 'credential profiles',
          prompt: `Help me set up credential profiles in NetStacks. I have ${profiles.length} profile(s)`
            + (profiles.length ? ` (${profiles.map(p => `${p.name}: ${p.auth_type}`).join(', ')})` : '')
            + '. Explain the auth types (password, SSH key, key + passphrase, agent), where secrets are stored (the vault), jump hosts and SNMP communities on a profile, how the first profile is the default, and how sessions and NetBox imports pick a profile.',
        }}
        actions={<button className="ns-btn ns-btn--small" onClick={handleCreate}>+ New profile</button>}
      >
        {error && <p className="settings-error">{error}</p>}
        {profiles.length === 0 ? (
          <p className="form-hint">No credential profiles yet. Create one to share authentication settings across sessions.</p>
        ) : (
          <div className="settings-group">
            {profiles.map((profile, index) => (
              <SettingsItem
                key={profile.id}
                title={profile.name}
                badges={
                  <>
                    {index === 0 && <span className="settings-badge settings-badge--accent">default</span>}
                    <span className={profile.auth_type === 'key' ? 'settings-badge settings-badge--success' : 'settings-badge'}>
                      {getAuthTypeBadge(profile.auth_type)}
                    </span>
                  </>
                }
                meta={
                  <>
                    <span>{profile.username} · port {profile.port}</span>
                    <span>0 sessions</span>
                  </>
                }
                actions={
                  <>
                    <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => handleEdit(profile)}>Edit</button>
                    <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => handleClone(profile)}>Clone</button>
                    <button className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small" onClick={() => handleDeleteClick(profile)}>Delete</button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

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
        <ModalFrame id="profile-delete" resizable={false} className="delete-confirm-dialog" label="Delete profile">
          <h3>Delete Profile</h3>
          <p>
            Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
          </p>
          <p className="delete-confirm-warning">
            This action cannot be undone. Sessions using this profile will need to be updated.
          </p>
          <DialogFooter
            primary={{ label: deleting ? 'Deleting...' : 'Delete', onClick: handleDeleteConfirm, disabled: deleting, danger: true }}
            onCancel={handleDeleteCancel}
            cancelDisabled={deleting}
            inline
          />
        </ModalFrame>
      )}
    </>
  );
}
