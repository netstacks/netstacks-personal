import { useState, useEffect, useCallback } from 'react';
import {
  listGlobalSnippets,
  createGlobalSnippet,
  updateGlobalSnippet,
  deleteGlobalSnippet,
  type GlobalSnippet,
} from '../api/snippets';
import AITabInput from './AITabInput';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';

import DialogFooter from './DialogFooter';
import SettingsSection from './settings/SettingsSection';
import SettingsItem from './settings/SettingsItem';
export default function SnippetsSettingsTab() {
  const [snippets, setSnippets] = useState<GlobalSnippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');

  // Edit state — id of the snippet being edited (null = none) plus
  // form fields that mirror the create form layout.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCommand, setEditCommand] = useState('');

  useEffect(() => {
    listGlobalSnippets()
      .then(setSnippets)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleCreateNew = useCallback(() => {
    setIsCreating(true);
    setNewName('');
    setNewCommand('');
  }, []);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewName('');
    setNewCommand('');
  }, []);

  const handleSaveNew = useCallback(async () => {
    if (!newName.trim() || !newCommand.trim()) return;

    try {
      const created = await createGlobalSnippet({
        name: newName.trim(),
        command: newCommand.trim(),
      });
      setSnippets(prev => [...prev, created]);
      setIsCreating(false);
      setNewName('');
      setNewCommand('');
    } catch (err) {
      console.error('Failed to create snippet:', err);
      showToast('Failed to create snippet', 'error');
    }
  }, [newName, newCommand]);

  const startEdit = useCallback((s: GlobalSnippet) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditCommand(s.command);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditName('');
    setEditCommand('');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId || !editName.trim() || !editCommand.trim()) return;
    try {
      const updated = await updateGlobalSnippet(editingId, {
        name: editName.trim(),
        command: editCommand.trim(),
      });
      setSnippets((prev) => prev.map((s) => (s.id === editingId ? updated : s)));
      cancelEdit();
    } catch (err) {
      console.error('Failed to update snippet:', err);
      showToast('Failed to update snippet', 'error');
    }
  }, [editingId, editName, editCommand, cancelEdit]);

  const handleDelete = useCallback(async (id: string) => {
    const snippet = snippets.find(s => s.id === id);
    const ok = await confirmDialog({
      title: 'Delete snippet?',
      body: snippet ? <>Delete snippet <strong>{snippet.name}</strong>?</> : 'Delete this snippet?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteGlobalSnippet(id);
      setSnippets(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Failed to delete snippet:', err);
      showToast('Failed to delete snippet', 'error');
    }
  }, [snippets]);

  return (
    <SettingsSection
      title="Global Snippets"
      description="Reusable command snippets available across all sessions."
      actions={!isCreating && (
        <button className="ns-btn ns-btn--small" onClick={handleCreateNew}>+ New snippet</button>
      )}
    >
      {isCreating && (
          <div className="settings-form">
            <h4 className="settings-form-title">New Snippet</h4>
            <div className="form-group">
              <label htmlFor="snippet-new-name">Name</label>
              <AITabInput id="snippet-new-name" value={newName}
                onChange={(e) => setNewName(e.target.value)} placeholder="e.g., Check BGP Status"
                autoFocus
                aiField="snippet_name"
                aiPlaceholder="Name for this command snippet"
                aiContext={{ command: newCommand }}
                onAIValue={(v) => setNewName(v)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="snippet-new-command">Command</label>
              <AITabInput id="snippet-new-command" className="settings-code" value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)} placeholder="e.g., show ip bgp summary"
                aiField="snippet_command"
                aiPlaceholder="Network CLI command"
                aiContext={{ name: newName }}
                onAIValue={(v) => setNewCommand(v)}
              />
            </div>
            <DialogFooter
              primary={{ label: 'Save', onClick: handleSaveNew, disabled: !newName.trim() || !newCommand.trim() }}
              onCancel={handleCancelCreate}
              inline
            />
          </div>
      )}

      {loading ? (
        <p className="form-hint">Loading…</p>
      ) : snippets.length === 0 ? (
        !isCreating && <p className="form-hint">No global snippets yet. Create reusable command snippets that work across all sessions.</p>
      ) : (
        <div className="settings-group">
          {snippets.map(snippet => editingId === snippet.id ? (
            <div key={snippet.id} className="settings-form">
            <div className="form-group">
              <label htmlFor="snippet-edit-name">Name</label>
              <AITabInput id="snippet-edit-name" value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
                aiField="snippet_name"
                aiPlaceholder="Name for this command snippet"
                aiContext={{ command: editCommand }}
                onAIValue={(v) => setEditName(v)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="snippet-edit-command">Command</label>
              <AITabInput id="snippet-edit-command" className="settings-code" value={editCommand}
                onChange={(e) => setEditCommand(e.target.value)}
                aiField="snippet_command"
                aiPlaceholder="Network CLI command"
                aiContext={{ name: editName }}
                onAIValue={(v) => setEditCommand(v)}
              />
            </div>
            <DialogFooter
              primary={{ label: 'Save', onClick: saveEdit, disabled: !editName.trim() || !editCommand.trim() }}
              onCancel={cancelEdit}
              inline
            />
          </div>
          ) : (
            <SettingsItem
              key={snippet.id}
              title={snippet.name}
              meta={<code>$ {snippet.command}</code>}
              actions={
                <>
                  <button className="ns-btn ns-btn--ghost ns-btn--small" onClick={() => startEdit(snippet)}>Edit</button>
                  <button className="ns-btn ns-btn--ghost ns-btn--danger ns-btn--small" onClick={() => handleDelete(snippet.id)}>Delete</button>
                </>
              }
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
