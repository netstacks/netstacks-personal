import { useState } from 'react';
import AITabInput from './AITabInput';
import { useDeviceMemory } from '../hooks/useDeviceMemory';
import { useModeNames } from '../hooks/useModeNames';
import type { DeviceMemoryEntry } from '../types/deviceMemory';
import './DeviceMemoryEditor.css';

import DialogFooter from './DialogFooter';
import Tooltip from './Tooltip';
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
  const modeNames = useModeNames();
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
            <select className="ns-select"
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
            <select className="ns-select"
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
          <AITabInput
            as="textarea"
            value={memory.standing_instructions || ''}
            onChange={e => handleMetadataChange('standing_instructions', e.target.value)}
            placeholder="e.g., Never reload without CAB approval. OSPF area 0 ABR — changes cascade."
            rows={3}
            aiField="standing_instructions"
            aiPlaceholder="Standing operational instructions for this device"
            aiContext={{ role: memory.role, criticality: memory.criticality }}
            onAIValue={v => handleMetadataChange('standing_instructions', v)}
          />
        </label>

        <label>
          Notes
          <AITabInput
            as="textarea"
            value={memory.notes || ''}
            onChange={e => handleMetadataChange('notes', e.target.value)}
            placeholder="e.g., Runs JunOS 21.4R3, known memory leak on 22.x"
            rows={2}
            aiField="notes"
            aiPlaceholder="Freeform notes about this device"
            aiContext={{ role: memory.role, criticality: memory.criticality }}
            onAIValue={v => handleMetadataChange('notes', v)}
          />
        </label>
      </div>

      <div className="device-memory-section">
        <div className="section-header">
          <h4>Memories ({memory.entries.length})</h4>
          {!showAddForm && (
            <button className="ns-btn" onClick={() => setShowAddForm(true)}>
              + Add Memory
            </button>
          )}
        </div>

        {showAddForm && (
          <div className="entry-form">
            <AITabInput
              as="textarea"
              value={entryContent}
              onChange={e => setEntryContent(e.target.value)}
              placeholder="What should the AI remember about this device?"
              rows={3}
              autoFocus
              aiField="memory"
              aiPlaceholder="A fact the AI should remember about this device"
              aiContext={{ role: memory.role, criticality: memory.criticality }}
              onAIValue={v => setEntryContent(v)}
            />
            <DialogFooter
              primary={{ label: 'Save', onClick: handleAddEntry, disabled: !entryContent.trim() }}
              onCancel={() => { setShowAddForm(false); setEntryContent(''); }}
              inline
            />
          </div>
        )}

        {memory.entries.length === 0 && !showAddForm && (
          <p className="empty-state">No memories yet. Add one to give the AI context about this device.</p>
        )}

        <div className="entries-list">
          {memory.entries.map(entry => {
            const badge = SOURCE_BADGES[entry.source] || SOURCE_BADGES.manual;
            const badgeLabel = entry.source === 'overlord' ? modeNames.overlord : badge.label;
            const isEditing = editingEntryId === entry.id;

            return (
              <div key={entry.id} className="memory-entry">
                <div className="entry-header">
                  <span className={`source-badge ${badge.className}`}>{badgeLabel}</span>
                  <span className="entry-date">{entry.date}</span>
                  <span className="entry-author">{entry.author}</span>
                  <div className="entry-actions">
                    <Tooltip label="Edit"><button aria-label="Edit" className="ns-btn ns-btn--ghost ns-icon-btn" onClick={() => startEditing(entry)}>&#9998;</button></Tooltip>
                    <Tooltip label="Delete"><button aria-label="Delete" className="ns-btn ns-btn--danger ns-btn--ghost ns-icon-btn" onClick={() => removeEntry(entry.id)}>&#10005;</button></Tooltip>
                  </div>
                </div>

                {isEditing ? (
                  <div className="entry-form">
                    <AITabInput as="textarea" aria-label="Memory entry"
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      rows={3}
                      autoFocus
                      aiField="memory"
                      aiPlaceholder="A fact the AI should remember about this device"
                      aiContext={{ role: memory.role, criticality: memory.criticality }}
                      onAIValue={setEditContent}
                    />
                    <DialogFooter
                      primary={{ label: 'Save', onClick: () => handleEditEntry(entry), disabled: !editContent.trim() }}
                      onCancel={() => setEditingEntryId(null)}
                      inline
                    />
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
