import { useState, useEffect, useCallback } from 'react';
import {
  listMappedKeys,
  createMappedKey,
  updateMappedKey,
  deleteMappedKey,
  revealMappedKey,
  type MappedKey,
} from '../api/mappedKeys';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import { useMode } from '../hooks/useMode';
import { getErrorMessage } from '../api/errors';
import { eventToBinding, formatShortcut, findShortcutOwner, parseKeybinding } from '../hooks/useKeyboard';
import { findDuplicateMappedKey, notifyMappedKeysChanged } from '../lib/mappedKeys';
import './SettingsMappedKeys.css';

export default function SettingsMappedKeys() {
  const { isEnterprise } = useMode();
  const [keys, setKeys] = useState<MappedKey[]>([]);
  const [loading, setLoading] = useState(true);

  // New key form state
  const [isCapturingKey, setIsCapturingKey] = useState(false);
  const [capturedKeyCombo, setCapturedKeyCombo] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newIsSecret, setNewIsSecret] = useState(false);

  // Secret reveal state — id of the row whose secret command is shown, + value
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState('');

  // Edit state — id of the row being edited (null = none), plus a draft
  // of the captured combo / command / description that mirrors the
  // add-form fields. Edits reuse the existing key-capture flow.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCombo, setEditCombo] = useState('');
  const [editCommand, setEditCommand] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editIsSecret, setEditIsSecret] = useState(false);
  const [isEditCapturing, setIsEditCapturing] = useState(false);

  useEffect(() => {
    listMappedKeys()
      .then(setKeys)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Key capture handler — used by both add-new and edit-existing flows.
  // Same chord grammar as the app shortcuts (Cmd and Ctrl are distinct),
  // so the terminal matcher and the Keyboard settings page agree.
  const handleKeyCapture = useCallback(
    (e: KeyboardEvent, target: 'add' | 'edit') => {
      e.preventDefault();
      e.stopPropagation();

      const combo = eventToBinding(e);
      if (!combo) return;
      if (target === 'add') {
        setCapturedKeyCombo(combo);
        setIsCapturingKey(false);
      } else {
        setEditCombo(combo);
        setIsEditCapturing(false);
      }
    },
    [],
  );

  /**
   * Why a chord cannot (or should not) be a mapped key: another mapped key
   * already uses it, or an app shortcut claims it. App shortcuts are
   * matched before the terminal sees the key, except single-Ctrl chords
   * inside the terminal, which are left to it — so those only warn.
   */
  const comboProblem = useCallback((combo: string, exceptId?: string): { message: string; blocking: boolean } | null => {
    if (!combo) return null;
    const dup = findDuplicateMappedKey(combo, keys, exceptId);
    if (dup) return { message: `Already mapped to "${dup.is_secret ? '(secret)' : dup.command}"`, blocking: true };
    const owner = findShortcutOwner(combo);
    if (owner) {
      const p = parseKeybinding(combo);
      const deferredToTerminal = p.ctrl && !p.meta && !p.alt && !p.shift;
      return deferredToTerminal
        ? { message: `Also the app shortcut for "${owner.label}" — the terminal wins while it has focus`, blocking: false }
        : { message: `Used by the app shortcut "${owner.label}", which fires first. Change it in Settings → Keyboard to use this chord here.`, blocking: true };
    }
    return null;
  }, [keys]);
  const addProblem = comboProblem(capturedKeyCombo);
  const editProblem = editingId ? comboProblem(editCombo, editingId) : null;

  // Attach/detach key listener for capture mode (add or edit)
  useEffect(() => {
    if (isCapturingKey) {
      const handler = (e: KeyboardEvent) => handleKeyCapture(e, 'add');
      window.addEventListener('keydown', handler, true);
      return () => window.removeEventListener('keydown', handler, true);
    }
  }, [isCapturingKey, handleKeyCapture]);

  useEffect(() => {
    if (isEditCapturing) {
      const handler = (e: KeyboardEvent) => handleKeyCapture(e, 'edit');
      window.addEventListener('keydown', handler, true);
      return () => window.removeEventListener('keydown', handler, true);
    }
  }, [isEditCapturing, handleKeyCapture]);

  const handleAdd = useCallback(async () => {
    if (!capturedKeyCombo.trim() || !newCommand.trim() || addProblem?.blocking) return;
    try {
      const created = await createMappedKey({
        key_combo: capturedKeyCombo.trim(),
        command: newCommand.trim(),
        description: newDescription.trim() || null,
        is_secret: newIsSecret,
      });
      setKeys(prev => [...prev, created]);
      notifyMappedKeysChanged();
      setCapturedKeyCombo('');
      setNewCommand('');
      setNewDescription('');
      setNewIsSecret(false);
    } catch (err) {
      console.error('Failed to create mapped key:', err);
      showToast(getErrorMessage(err, 'Failed to create mapped key'), 'error');
    }
  }, [capturedKeyCombo, newCommand, newDescription, newIsSecret, addProblem]);

  const startEdit = useCallback(async (key: MappedKey) => {
    // Secret commands aren't held in the list payload — fetch the plaintext
    // to prefill the edit form (requires the vault unlocked).
    let command = key.command;
    if (key.is_secret) {
      try {
        command = await revealMappedKey(key.id);
      } catch (err) {
        showToast(getErrorMessage(err, 'Unlock the vault to edit this secret shortcut'), 'warning');
        return;
      }
    }
    setEditingId(key.id);
    setEditCombo(key.key_combo);
    setEditCommand(command);
    setEditDescription(key.description || '');
    setEditIsSecret(key.is_secret);
    setIsEditCapturing(false);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditCombo('');
    setEditCommand('');
    setEditDescription('');
    setEditIsSecret(false);
    setIsEditCapturing(false);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId || !editCombo.trim() || !editCommand.trim() || editProblem?.blocking) return;
    try {
      const updated = await updateMappedKey(editingId, {
        key_combo: editCombo.trim(),
        command: editCommand.trim(),
        description: editDescription.trim() || null,
        is_secret: editIsSecret,
      });
      setKeys((prev) => prev.map((k) => (k.id === editingId ? updated : k)));
      notifyMappedKeysChanged();
      cancelEdit();
    } catch (err) {
      console.error('Failed to update mapped key:', err);
      showToast(getErrorMessage(err, 'Failed to update mapped key'), 'error');
    }
  }, [editingId, editCombo, editCommand, editDescription, editIsSecret, cancelEdit, editProblem]);

  const toggleReveal = useCallback(async (key: MappedKey) => {
    if (revealedId === key.id) {
      setRevealedId(null);
      setRevealedValue('');
      return;
    }
    try {
      const value = await revealMappedKey(key.id);
      setRevealedId(key.id);
      setRevealedValue(value);
    } catch (err) {
      showToast(getErrorMessage(err, 'Unlock the vault to reveal this shortcut'), 'warning');
    }
  }, [revealedId]);

  const handleDelete = useCallback(async (id: string) => {
    const ok = await confirmDialog({
      title: 'Delete mapped key?',
      body: 'Remove this key combo and its mapped command?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteMappedKey(id);
      setKeys(prev => prev.filter(k => k.id !== id));
      notifyMappedKeysChanged();
    } catch (err) {
      console.error('Failed to delete mapped key:', err);
    }
  }, []);

  if (loading) {
    return <div className="mapped-keys-settings"><div className="mapped-keys-loading">Loading mapped keys...</div></div>;
  }

  return (
    <div className="mapped-keys-settings">
      <div className="mapped-keys-section">
        <div className="mapped-keys-section-header">
          <span className="mapped-keys-section-title">Keyboard Shortcuts</span>
        </div>
        <div className="mapped-keys-section-description">
          Define keyboard shortcuts that send commands to the terminal. These apply to all sessions and take effect in open terminals immediately.
        </div>

        {keys.length === 0 && (
          <div className="mapped-keys-empty">
            No mapped keys configured. Add a keyboard shortcut below.
          </div>
        )}

        {keys.length > 0 && (
          <div className="mapped-keys-list">
            {keys.map((key) => {
              const isEditing = editingId === key.id;
              if (!isEditing) {
                return (
                  <div key={key.id} className="mapped-keys-item">
                    <div className="mapped-keys-item-main">
                      <span className="mapped-keys-combo" title={key.key_combo}>{formatShortcut(key.key_combo)}</span>
                      <span className="mapped-keys-arrow">&rarr;</span>
                      {key.is_secret ? (
                        <>
                          <span className="mapped-keys-command mapped-keys-command-secret">
                            {revealedId === key.id ? revealedValue : '•••••••'}
                          </span>
                          <button
                            className="mapped-keys-reveal"
                            onClick={() => toggleReveal(key)}
                            title={revealedId === key.id ? 'Hide' : 'Reveal'}
                          >
                            {revealedId === key.id ? 'Hide' : 'Reveal'}
                          </button>
                          <span className="mapped-keys-secret-badge" title="Encrypted in vault">🔒</span>
                        </>
                      ) : (
                        <span className="mapped-keys-command">{key.command}</span>
                      )}
                      <button
                        className="mapped-keys-edit"
                        onClick={() => startEdit(key)}
                        title="Edit"
                      >
                        Edit
                      </button>
                      <button
                        className="mapped-keys-delete"
                        onClick={() => handleDelete(key.id)}
                        title="Delete"
                      >
                        &times;
                      </button>
                    </div>
                    {key.description && (
                      <div className="mapped-keys-description">{key.description}</div>
                    )}
                  </div>
                );
              }
              // Inline edit form — mirrors the add form layout.
              return (
                <div key={key.id} className="mapped-keys-item mapped-keys-item-editing">
                  <div className="mapped-keys-add-row">
                    <div className="mk-capture-row">
                      <button
                        type="button"
                        className={`mk-capture-btn ${isEditCapturing ? 'capturing' : ''}`}
                        onClick={() => setIsEditCapturing(true)}
                      >
                        {isEditCapturing ? 'Press a key combo…' : (editCombo ? formatShortcut(editCombo) : 'Click to capture')}
                      </button>
                      {editProblem && (
                        <span className={`mk-combo-problem${editProblem.blocking ? ' blocking' : ''}`}>{editProblem.message}</span>
                      )}
                    </div>
                    <input
                      type={editIsSecret ? 'password' : 'text'}
                      value={editCommand}
                      onChange={(e) => setEditCommand(e.target.value)}
                      className="mk-input-command"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editCombo && editCommand.trim()) {
                          e.preventDefault();
                          saveEdit();
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="mk-add-btn"
                      onClick={saveEdit}
                      disabled={!editCombo || !editCommand.trim() || !!editProblem?.blocking}
                      title="Save"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="mapped-keys-delete"
                      onClick={cancelEdit}
                      title="Cancel"
                    >
                      &times;
                    </button>
                  </div>
                  <input
                    type="text"
                    placeholder="Description (optional)"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className="mk-input-description"
                  />
                  {!isEnterprise && (
                    <label className="mk-secret-toggle">
                      <input
                        type="checkbox"
                        checked={editIsSecret}
                        onChange={(e) => setEditIsSecret(e.target.checked)}
                      />
                      <span>Secret (encrypt command in vault)</span>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mapped-keys-add">
          <div className="mapped-keys-add-row">
            <div className="mk-capture-row">
              <button
                type="button"
                className={`mk-capture-btn ${isCapturingKey ? 'capturing' : ''}`}
                onClick={() => setIsCapturingKey(true)}
              >
                {isCapturingKey
                  ? 'Press a key combo...'
                  : (capturedKeyCombo ? formatShortcut(capturedKeyCombo) : 'Click to capture key')}
              </button>
              {capturedKeyCombo && !isCapturingKey && (
                <button
                  type="button"
                  className="mk-capture-clear"
                  onClick={() => setCapturedKeyCombo('')}
                  title="Clear"
                >
                  &times;
                </button>
              )}
              {addProblem && (
                <span className={`mk-combo-problem${addProblem.blocking ? ' blocking' : ''}`}>{addProblem.message}</span>
              )}
            </div>
            <input
              type={newIsSecret ? 'password' : 'text'}
              placeholder="Command to send"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && capturedKeyCombo && newCommand.trim()) {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              className="mk-input-command"
            />
            <button
              type="button"
              className="mk-add-btn"
              onClick={handleAdd}
              disabled={!capturedKeyCombo || !newCommand.trim() || !!addProblem?.blocking}
              title="Add shortcut"
            >
              +
            </button>
          </div>
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            className="mk-input-description"
          />
          {!isEnterprise && (
            <label className="mk-secret-toggle">
              <input
                type="checkbox"
                checked={newIsSecret}
                onChange={(e) => setNewIsSecret(e.target.checked)}
              />
              <span>Secret (encrypt command in vault)</span>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
