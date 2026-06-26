import { useState } from 'react';
import { useDeviceMemory } from '../hooks/useDeviceMemory';
import type { DeviceMemoryEntry } from '../types/deviceMemory';
import './DeviceMemoryEditor.css';

interface DeviceMemoryEditorProps {
  /** Standalone / session-keyed target. */
  sessionId?: string;
  /** Enterprise / device-keyed target. Provide exactly one of sessionId/deviceId. */
  deviceId?: string;
  currentUser: string;
}

const ROLE_OPTIONS = [
  '', 'Core Router', 'Edge Router', 'Distribution Switch', 'Access Switch',
  'Firewall', 'Load Balancer', 'Server', 'Jumpbox', 'Wireless Controller', 'Other',
];

const CRITICALITY_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const SOURCE_BADGES: Record<string, { label: string; className: string }> = {
  manual: { label: 'Manual', className: 'source-manual' },
  troubleshooting: { label: 'Troubleshoot', className: 'source-troubleshooting' },
  overlord: { label: 'Overlord', className: 'source-overlord' },
};

export default function DeviceMemoryEditor({ sessionId, deviceId, currentUser }: DeviceMemoryEditorProps): React.ReactElement {
  const { memory, loading, error, updateMemory, addEntry, editEntry, removeEntry } = useDeviceMemory({ sessionId, deviceId });
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [entryContent, setEntryContent] = useState('');
  const [editContent, setEditContent] = useState('');

  if (loading && !memory) {
    return <div className="device-memory-editor"><div className="loading">Loading device memory...</div></div>;
  }

  if (error) {
    return <div className="device-memory-editor"><div className="error">{error}</div></div>;
  }

  if (!memory) return <div className="device-memory-editor" />;

  const handleMetadataChange = (field: string, value: string) => {
    updateMemory({ [field]: value || null });
  };

  const handleAddEntry = async () => {
    if (!entryContent.trim()) return;
    await addEntry({
      date: new Date().toISOString().split('T')[0],
      source: 'manual',
      author: currentUser,
      content: entryContent.trim(),
    });
    setEntryContent('');
    setShowAddForm(false);
  };

  const handleEditEntry = async (entry: DeviceMemoryEntry) => {
    if (!editContent.trim()) return;
    await editEntry(entry.id, { content: editContent.trim() });
    setEditingEntryId(null);
  };

  const startEditing = (entry: DeviceMemoryEntry) => {
    setEditingEntryId(entry.id);
    setEditContent(entry.content);
  };

  return (
    <div className="device-memory-editor">
      <div className="device-memory-section">
        <h4>Device Metadata</h4>
        <p className="section-hint">Tell the AI about this device. These fields are always included in AI context.</p>

        <div className="metadata-grid">
          <label>
            Role
            <select
              value={memory.role || ''}
              onChange={e => handleMetadataChange('role', e.target.value)}
            >
              {ROLE_OPTIONS.map(r => (
                <option key={r} value={r}>{r || 'Not set'}</option>
              ))}
            </select>
          </label>

          <label>
            Criticality
            <select
              value={memory.criticality || ''}
              onChange={e => handleMetadataChange('criticality', e.target.value)}
            >
              {CRITICALITY_OPTIONS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label>
          Standing Instructions
          <textarea
            value={memory.standing_instructions || ''}
            onChange={e => handleMetadataChange('standing_instructions', e.target.value)}
            placeholder="e.g., Never reload without CAB approval. OSPF area 0 ABR — changes cascade."
            rows={3}
          />
        </label>

        <label>
          Notes
          <textarea
            value={memory.notes || ''}
            onChange={e => handleMetadataChange('notes', e.target.value)}
            placeholder="e.g., Runs JunOS 21.4R3, known memory leak on 22.x"
            rows={2}
          />
        </label>
      </div>

      <div className="device-memory-section">
        <div className="section-header">
          <h4>Memories ({memory.entries.length})</h4>
          {!showAddForm && (
            <button className="btn-add" onClick={() => setShowAddForm(true)}>
              + Add Memory
            </button>
          )}
        </div>

        {showAddForm && (
          <div className="entry-form">
            <textarea
              value={entryContent}
              onChange={e => setEntryContent(e.target.value)}
              placeholder="What should the AI remember about this device?"
              rows={3}
              autoFocus
            />
            <div className="form-actions">
              <button className="btn-save" onClick={handleAddEntry} disabled={!entryContent.trim()}>
                Save
              </button>
              <button className="btn-cancel" onClick={() => { setShowAddForm(false); setEntryContent(''); }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {memory.entries.length === 0 && !showAddForm && (
          <p className="empty-state">No memories yet. Add one to give the AI context about this device.</p>
        )}

        <div className="entries-list">
          {memory.entries.map(entry => {
            const badge = SOURCE_BADGES[entry.source] || SOURCE_BADGES.manual;
            const isEditing = editingEntryId === entry.id;

            return (
              <div key={entry.id} className="memory-entry">
                <div className="entry-header">
                  <span className={`source-badge ${badge.className}`}>{badge.label}</span>
                  <span className="entry-date">{entry.date}</span>
                  <span className="entry-author">{entry.author}</span>
                  <div className="entry-actions">
                    <button className="btn-icon" title="Edit" onClick={() => startEditing(entry)}>&#9998;</button>
                    <button className="btn-icon btn-danger" title="Delete" onClick={() => removeEntry(entry.id)}>&#10005;</button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="entry-form">
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      rows={3}
                      autoFocus
                    />
                    <div className="form-actions">
                      <button className="btn-save" onClick={() => handleEditEntry(entry)} disabled={!editContent.trim()}>
                        Save
                      </button>
                      <button className="btn-cancel" onClick={() => setEditingEntryId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="entry-content">{entry.content}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
