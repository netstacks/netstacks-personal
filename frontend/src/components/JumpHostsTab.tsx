import AITabInput from './AITabInput'
import { useState, useEffect } from 'react';
import {
  listJumpHosts,
  createJumpHost,
  updateJumpHost,
  deleteJumpHost,
  type JumpHost,
  type NewJumpHost,
  type UpdateJumpHost,
} from '../api/sessions';
import { listProfiles, type CredentialProfile } from '../api/profiles';
import './JumpHostsTab.css';

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import SettingsSection from './settings/SettingsSection';
import SettingsItem from './settings/SettingsItem';
import ModalFrame from './ModalFrame';
export default function JumpHostsTab() {
  const [jumpHosts, setJumpHosts] = useState<JumpHost[]>([]);
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editor state
  const [editing, setEditing] = useState<JumpHost | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    host: '',
    port: 22,
    profile_id: '',
  });
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<JumpHost | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Fetch data on mount
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [jh, p] = await Promise.all([listJumpHosts(), listProfiles()]);
      setJumpHosts(jh);
      setProfiles(p);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load jump hosts'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setIsNew(true);
    setEditing(null);
    setFormData({
      name: '',
      host: '',
      port: 22,
      profile_id: profiles[0]?.id || '',
    });
  };

  const handleEdit = (jh: JumpHost) => {
    setIsNew(false);
    setEditing(jh);
    setFormData({
      name: jh.name,
      host: jh.host,
      port: jh.port,
      profile_id: jh.profile_id,
    });
  };

  const handleCancel = () => {
    setEditing(null);
    setIsNew(false);
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.host.trim() || !formData.profile_id) {
      setError('Name, host, and profile are required');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (isNew) {
        const newJh: NewJumpHost = {
          name: formData.name.trim(),
          host: formData.host.trim(),
          port: formData.port,
          profile_id: formData.profile_id,
        };
        const created = await createJumpHost(newJh);
        setJumpHosts([...jumpHosts, created]);
      } else if (editing) {
        const update: UpdateJumpHost = {
          name: formData.name.trim(),
          host: formData.host.trim(),
          port: formData.port,
          profile_id: formData.profile_id,
        };
        const updated = await updateJumpHost(editing.id, update);
        setJumpHosts(jumpHosts.map((jh) => (jh.id === editing.id ? updated : jh)));
      }

      setEditing(null);
      setIsNew(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save jump host'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (jh: JumpHost) => {
    setDeleteConfirm(jh);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleting(true);
      await deleteJumpHost(deleteConfirm.id);
      setJumpHosts(jumpHosts.filter((jh) => jh.id !== deleteConfirm.id));
      setDeleteConfirm(null);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete jump host'));
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

  const getProfileName = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    return profile ? profile.name : 'Unknown';
  };

  if (loading) {
    return (
      <p className="form-hint">Loading jump hosts…</p>
    );
  }

  const renderForm = (key: string, creating: boolean) => (
    <div key={key} className="settings-form">
      {creating && <h4 className="settings-form-title">New Jump Host</h4>}
      <div className="settings-form-row">
        <div className="form-group">
          <label htmlFor={`jump-name-${key}`}>Name</label>
          <AITabInput
            id={`jump-name-${key}`}
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Production Bastion"
            autoFocus={creating}
            aiField="jump host name"
            aiPlaceholder="Short descriptive name for this SSH bastion"
            aiContext={{ host: formData.host }}
            onAIValue={(v) => setFormData({ ...formData, name: v })}
          />
        </div>
        <div className="form-group">
          <label htmlFor={`jump-profile-${key}`}>Profile</label>
          <select id={`jump-profile-${key}`} className="ns-select"
            value={formData.profile_id}
            onChange={(e) => setFormData({ ...formData, profile_id: e.target.value })}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.username})
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="settings-form-row">
        <div className="form-group">
          <label htmlFor={`jump-host-${key}`}>Host</label>
          <input data-ai-fill="off" className="ns-input"
            id={`jump-host-${key}`}
            type="text"
            value={formData.host}
            onChange={(e) => setFormData({ ...formData, host: e.target.value })}
            placeholder="bastion.example.com"
          />
        </div>
        <div className="form-group form-group--narrow">
          <label htmlFor={`jump-port-${key}`}>Port</label>
          <input id={`jump-port-${key}`} className="ns-input"
            type="number"
            value={formData.port}
            onChange={(e) =>
              setFormData({ ...formData, port: parseInt(e.target.value) || 22 })
            }
            min={1}
            max={65535}
          />
        </div>
      </div>
      <DialogFooter
        primary={{
          label: creating ? (saving ? 'Creating...' : 'Create') : (saving ? 'Saving...' : 'Save'),
          onClick: handleSave,
          disabled: saving,
        }}
        onCancel={handleCancel}
        inline
      />
    </div>
  );

  return (
    <>
      <SettingsSection
        title="Jump Hosts"
        description="Bastion servers used to reach internal networks. Select them on a profile or session."
        help={{
          topic: 'jump hosts',
          prompt: `Help me set up jump hosts (bastions) in NetStacks. I have ${jumpHosts.length} jump host(s)`
            + (jumpHosts.length ? ` (${jumpHosts.map(jh => `${jh.name} → ${jh.host}:${jh.port}`).join(', ')})` : '')
            + ` and ${profiles.length} credential profile(s). Explain how a jump host uses a profile for its own login, how a session or profile picks a jump (or uses another session as the jump), how chained jumps and console servers behind a bastion work, and how to troubleshoot a failing jump.`,
        }}
        actions={profiles.length > 0 && !isNew && (
          <button className="ns-btn ns-btn--small" onClick={handleCreate}>+ Add jump host</button>
        )}
      >
        {error && <p className="settings-error">{error}</p>}

        {profiles.length === 0 ? (
          <p className="form-hint">Create a credential profile first (Settings → Profiles); a jump host logs in with one.</p>
        ) : (
          <>
            {isNew && renderForm('new', true)}
            {jumpHosts.length === 0 ? (
              !isNew && <p className="form-hint">No jump hosts yet.</p>
            ) : (
              <div className="settings-group">
                {jumpHosts.map((jh) => editing?.id === jh.id ? renderForm(jh.id, false) : (
                  <SettingsItem
                    key={jh.id}
                    title={jh.name}
                    badges={<span className="settings-badge">{getProfileName(jh.profile_id)}</span>}
                    meta={<span>{profiles.find((p) => p.id === jh.profile_id)?.username || '?'}@{jh.host}:{jh.port}</span>}
                    actions={
                      <>
                        <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => handleEdit(jh)}>Edit</button>
                        <button className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small" onClick={() => handleDeleteClick(jh)}>Delete</button>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <ModalFrame id="jump-host-delete" resizable={false} className="jump-hosts-dialog" label="Delete jump host">
          <h3>Delete Jump Host</h3>
          <p>
            Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
          </p>
          <p className="warning">
            Sessions using this jump host will have their jump host cleared.
          </p>
          <DialogFooter
            primary={{ label: deleting ? 'Deleting...' : 'Delete', onClick: handleDeleteConfirm, disabled: deleting, danger: true }}
            onCancel={handleDeleteCancel}
            inline
          />
        </ModalFrame>
      )}
    </>
  );
}
