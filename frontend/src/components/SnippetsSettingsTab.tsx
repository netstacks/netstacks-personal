import { useState, useEffect, useCallback } from 'react';
import {
  listGlobalSnippets,
  createGlobalSnippet,
  updateGlobalSnippet,
  deleteGlobalSnippet,
  type GlobalSnippet,
} from '../api/snippets';
import './SnippetsSettingsTab.css';
import AITabInput from './AITabInput';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';

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
    <div className="snippets-settings">
      <div className="snippets-section">
        <div className="snippets-section-header">
          <span className="snippets-section-title">Global Snippets</span>
          {!isCreating && (
            <button className="btn-new-snippet" onClick={handleCreateNew}>
              + New Snippet
            </button>
          )}
        </div>
        <p className="snippets-section-description">
          Reusable command snippets available across all sessions.
        </p>

        {loading ? (
          <p className="snippets-loading">Loading...</p>
        ) : snippets.length === 0 && !isCreating ? (
          <div className="snippets-empty">
            No global snippets. Create reusable command snippets that work across all sessions.
          </div>
        ) : (
          <div className="snippets-list">
            {snippets.map(snippet => {
              const isEditing = editingId === snippet.id;
              if (!isEditing) {
                return (
                  <div key={snippet.id} className="snippet-item">
                    <div className="snippet-item-header">
                      <span className="snippet-item-icon">⌘</span>
                      <span className="snippet-item-name">{snippet.name}</span>
                      <div className="snippet-item-actions">
                        <button onClick={() => startEdit(snippet)} title="Edit">
                          ✎
                        </button>
                        <button onClick={() => handleDelete(snippet.id)} title="Delete">
                          🗑
                        </button>
                      </div>
                    </div>
                    <div className="snippet-item-command">
                      $ {snippet.command.length > 60 ? snippet.command.substring(0, 60) + '...' : snippet.command}
                    </div>
                  </div>
                );
              }
              // Inline edit form
              return (
                <div key={snippet.id} className="snippet-item">
                  <div className="snippet-form">
                    <div className="snippet-form-field">
                      <label>Name</label>
                      <AITabInput
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        autoFocus
                        aiField="snippet_name"
                        aiPlaceholder="Name for this command snippet"
                        aiContext={{ command: editCommand }}
                        onAIValue={(v) => setEditName(v)}
                      />
                    </div>
                    <div className="snippet-form-field">
                      <label>Command</label>
                      <AITabInput
                        value={editCommand}
                        onChange={(e) => setEditCommand(e.target.value)}
                        aiField="snippet_command"
                        aiPlaceholder="Network CLI command"
                        aiContext={{ name: editName }}
                        onAIValue={(v) => setEditCommand(v)}
                      />
                    </div>
                    <div className="snippet-form-actions">
                      <button className="btn-cancel" onClick={cancelEdit}>
                        Cancel
                      </button>
                      <button
                        className="btn-save"
                        onClick={saveEdit}
                        disabled={!editName.trim() || !editCommand.trim()}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {isCreating && (
          <div className="snippet-form">
            <div className="snippet-form-field">
              <label>Name</label>
              <AITabInput
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g., Check BGP Status"
                autoFocus
                aiField="snippet_name"
                aiPlaceholder="Name for this command snippet"
                aiContext={{ command: newCommand }}
                onAIValue={(v) => setNewName(v)}
              />
            </div>
            <div className="snippet-form-field">
              <label>Command</label>
              <AITabInput
                value={newCommand}
                onChange={e => setNewCommand(e.target.value)}
                placeholder="e.g., show ip bgp summary"
                aiField="snippet_command"
                aiPlaceholder="Network CLI command"
                aiContext={{ name: newName }}
                onAIValue={(v) => setNewCommand(v)}
              />
            </div>
            <div className="snippet-form-actions">
              <button className="btn-cancel" onClick={handleCancelCreate}>
                Cancel
              </button>
              <button
                className="btn-save"
                onClick={handleSaveNew}
                disabled={!newName.trim() || !newCommand.trim()}
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
