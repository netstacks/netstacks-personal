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

// Icons for the component
import { getErrorMessage } from '../api/errors'
const Icons = {
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
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
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

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
      <div className="jump-hosts-tab">
        <div className="jump-hosts-loading">Loading jump hosts...</div>
      </div>
    );
  }

  return (
    <div className="jump-hosts-tab">
      <div className="jump-hosts-header">
        <p className="jump-hosts-description">
          Jump hosts (bastion hosts) are intermediary SSH servers used to access internal networks.
          Configure them here and select them in session settings.
        </p>
      </div>

      {error && <div className="jump-hosts-error">{error}</div>}

      {profiles.length === 0 ? (
        <div className="jump-hosts-empty">
          <p>You need to create a profile before adding jump hosts.</p>
          <p>Go to the Profiles tab to create a profile first.</p>
        </div>
      ) : (
        <>
          <div className="jump-hosts-list">
            {jumpHosts.map((jh) => (
              <div key={jh.id} className="jump-host-card">
                {editing?.id === jh.id ? (
                  // Edit form
                  <div className="jump-host-form">
                    <div className="form-row">
                      <div className="form-group">
                        <label>Name</label>
                        <input
                          type="text"
                          value={formData.name}
                          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                          placeholder="Production Bastion"
                        />
                      </div>
                      <div className="form-group">
                        <label>Profile</label>
                        <select
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
                    <div className="form-row">
                      <div className="form-group flex-grow">
                        <label>Host</label>
                        <input
                          type="text"
                          value={formData.host}
                          onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                          placeholder="bastion.example.com"
                        />
                      </div>
                      <div className="form-group" style={{ width: '100px' }}>
                        <label>Port</label>
                        <input
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
                    <div className="form-actions">
                      <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                        {Icons.check}
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button className="btn btn-secondary" onClick={handleCancel}>
                        {Icons.close}
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  // Display card
                  <>
                    <div className="jump-host-info">
                      <div className="jump-host-name">{jh.name}</div>
                      <div className="jump-host-details">
                        <span className="jump-host-host">
                          {profiles.find((p) => p.id === jh.profile_id)?.username || '?'}@{jh.host}:
                          {jh.port}
                        </span>
                        <span className="jump-host-badge">{getProfileName(jh.profile_id)}</span>
                      </div>
                    </div>
                    <div className="jump-host-actions">
                      <button
                        className="jump-host-action"
                        onClick={() => handleEdit(jh)}
                        title="Edit"
                      >
                        {Icons.edit}
                      </button>
                      <button
                        className="jump-host-action danger"
                        onClick={() => handleDeleteClick(jh)}
                        title="Delete"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* New jump host form */}
            {isNew && (
              <div className="jump-host-card new">
                <div className="jump-host-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>Name</label>
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        placeholder="Production Bastion"
                        autoFocus
                      />
                    </div>
                    <div className="form-group">
                      <label>Profile</label>
                      <select
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
                  <div className="form-row">
                    <div className="form-group flex-grow">
                      <label>Host</label>
                      <input
                        type="text"
                        value={formData.host}
                        onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                        placeholder="bastion.example.com"
                      />
                    </div>
                    <div className="form-group" style={{ width: '100px' }}>
                      <label>Port</label>
                      <input
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
                  <div className="form-actions">
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                      {Icons.check}
                      {saving ? 'Creating...' : 'Create'}
                    </button>
                    <button className="btn btn-secondary" onClick={handleCancel}>
                      {Icons.close}
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Add button */}
          {!isNew && (
            <button className="jump-hosts-add-btn" onClick={handleCreate}>
              {Icons.plus}
              Add Jump Host
            </button>
          )}
        </>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="jump-hosts-dialog-overlay">
          <div className="jump-hosts-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Jump Host</h3>
            <p>
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
            </p>
            <p className="warning">
              Sessions using this jump host will have their jump host cleared.
            </p>
            <div className="dialog-actions">
              <button
                className="btn btn-danger"
                onClick={handleDeleteConfirm}
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
              <button className="btn btn-secondary" onClick={handleDeleteCancel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
