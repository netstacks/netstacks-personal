import { useCallback, useState } from 'react';
import { useSessionContext } from '../hooks/useSessionContext';
import { useMode } from '../hooks/useMode';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { getErrorMessage, parseApiError } from '../api/errors';
import type { SessionContext } from '../types/sessionContext';
import './SessionContextEditor.css';
import AITabInput from './AITabInput';
import { showToast } from './Toast';

import DialogFooter from './DialogFooter';
interface SessionContextEditorProps {
  /** Standalone / session-keyed target. Provide exactly one of sessionId/deviceId. */
  sessionId?: string;
  /** Enterprise / device-keyed target (Controller device id). */
  deviceId?: string;
  /** For the author field; in enterprise, the signed-in username (the Controller's author). */
  currentUser: string;
  /** Entry to show expanded (and scrolled into view) when the editor opens. */
  initialExpandedId?: string;
}

export default function SessionContextEditor({ sessionId, deviceId, currentUser, initialExpandedId }: SessionContextEditorProps): React.ReactElement {
  const { contexts, loading, error, addContext, updateContext, deleteContext } = useSessionContext({ sessionId, deviceId });
  // Enterprise: adding needs `devices.manage`; editing or deleting an entry
  // needs to be its author or an org admin (`system.manage`). The Controller
  // enforces both (403); standalone has no such limits.
  const { isEnterprise } = useMode();
  const canAdd = useCapabilitiesStore((s) => !isEnterprise || s.hasPermission('devices.manage'));
  const isOrgAdmin = useCapabilitiesStore((s) => isEnterprise && s.hasPermission('system.manage'));
  const canModify = (ctx: SessionContext) => !isEnterprise || isOrgAdmin || ctx.author === currentUser;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);
  const scrollIntoView = useCallback((el: HTMLDivElement | null) => {
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Form state
  const [formData, setFormData] = useState({
    issue: '',
    root_cause: '',
    resolution: '',
    commands: '',
    ticket_ref: '',
  });

  // Helper to update a single form field
  const updateField = (field: keyof typeof formData, value: string): void => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const resetForm = () => {
    setFormData({ issue: '', root_cause: '', resolution: '', commands: '', ticket_ref: '' });
    setEditingId(null);
    setShowAddForm(false);
  };

  /** A refused save, as a toast: a 403 says who may do it; anything else, why it failed. */
  const reportFailure = (err: unknown, action: 'add' | 'update' | 'delete', forbidden: string) => {
    console.error(`Failed to ${action} context:`, err);
    showToast(
      parseApiError(err).status === 403 ? forbidden : getErrorMessage(err, `Failed to ${action} context`),
      'error',
    );
  };

  const handleAdd = async () => {
    try {
      await addContext({
        ...formData,
        author: currentUser,
      });
      resetForm();
    } catch (err) {
      reportFailure(err, 'add', 'You need permission to manage devices to add Team Knowledge.');
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      await updateContext(id, formData);
      resetForm();
    } catch (err) {
      reportFailure(err, 'update', 'Only the author or an administrator can edit this entry.');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteContext(id);
    } catch (err) {
      reportFailure(err, 'delete', 'Only the author or an administrator can delete this entry.');
    }
  };

  const startEdit = (ctx: SessionContext) => {
    setEditingId(ctx.id);
    setFormData({
      issue: ctx.issue,
      root_cause: ctx.root_cause || '',
      resolution: ctx.resolution || '',
      commands: ctx.commands || '',
      ticket_ref: ctx.ticket_ref || '',
    });
    setShowAddForm(true);
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  if (loading) {
    return (
      <div className="session-context-editor">
        <div className="context-loading">
          <div className="loading-spinner" />
          <span>Loading context...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="session-context-editor">
        <div className="context-error">
          <span className="error-icon">!</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="session-context-editor">
      <div className="context-header">
        <h3>Device Context</h3>
        <p className="context-description">
          Team knowledge about this device. Add troubleshooting notes, known issues, and helpful commands.
        </p>
        {!showAddForm && canAdd && (
          <button className="ns-btn ns-btn--primary" onClick={() => setShowAddForm(true)}>
            + Add Context
          </button>
        )}
      </div>

      {showAddForm && (
        <div className="context-form">
          <h4>{editingId ? 'Edit Context' : 'Add Context'}</h4>

          <div className="form-group">
            <label>Issue / Topic *</label>
            <AITabInput
              value={formData.issue}
              onChange={(e) => updateField('issue', e.target.value)}
              placeholder="Brief description of the issue or topic"
              aiField="issue_topic"
              aiPlaceholder="Issue or topic being investigated"
              aiContext={{}}
              onAIValue={(v) => updateField('issue', v)}
            />
          </div>

          <div className="form-group">
            <label>Root Cause</label>
            <AITabInput
              as="textarea"
              value={formData.root_cause}
              onChange={(e) => updateField('root_cause', e.target.value)}
              placeholder="What caused the issue"
              rows={2}
              aiField="root_cause"
              aiPlaceholder="Root cause analysis"
              aiContext={{ issue: formData.issue }}
              onAIValue={(v) => updateField('root_cause', v)}
            />
          </div>

          <div className="form-group">
            <label>Resolution</label>
            <AITabInput
              as="textarea"
              value={formData.resolution}
              onChange={(e) => updateField('resolution', e.target.value)}
              placeholder="How it was fixed or addressed"
              rows={2}
              aiField="resolution"
              aiPlaceholder="Resolution steps taken"
              aiContext={{ issue: formData.issue, root_cause: formData.root_cause }}
              onAIValue={(v) => updateField('resolution', v)}
            />
          </div>

          <div className="form-group">
            <label>Helpful Commands</label>
            <AITabInput
              as="textarea"
              value={formData.commands}
              onChange={(e) => updateField('commands', e.target.value)}
              placeholder="One command per line"
              rows={3}
              className="mono"
              aiField="helpful_commands"
              aiPlaceholder="CLI commands useful for this issue"
              aiContext={{ issue: formData.issue, root_cause: formData.root_cause, resolution: formData.resolution }}
              onAIValue={(v) => updateField('commands', v)}
            />
          </div>

          <div className="form-group">
            <label>Ticket Reference</label>
            <input data-ai-fill="off" className="ns-input"
              type="text"
              value={formData.ticket_ref}
              onChange={(e) => updateField('ticket_ref', e.target.value)}
              placeholder="e.g., JIRA-1234"
            />
          </div>

          <DialogFooter
            primary={{ label: editingId ? 'Save Changes' : 'Add Context', onClick: () => editingId ? handleUpdate(editingId) : handleAdd(), disabled: !formData.issue.trim() }}
            onCancel={resetForm}
            inline
          />
        </div>
      )}

      <div className="context-list">
        {contexts.length === 0 && !showAddForm && (
          <div className="no-context">
            <span className="no-context-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="32" height="32">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </span>
            <p>No context yet.</p>
            <p className="no-context-hint">Add notes about this device to help your team.</p>
          </div>
        )}

        {contexts.map((ctx) => {
          const isExpanded = expandedId === ctx.id;
          const hasDetails = ctx.root_cause || ctx.resolution || ctx.commands;

          return (
            <div
              key={ctx.id}
              ref={ctx.id === initialExpandedId ? scrollIntoView : undefined}
              className={`context-entry ${isExpanded ? 'expanded' : ''}`}
            >
              <div
                className="context-entry-header"
                onClick={() => hasDetails && toggleExpand(ctx.id)}
                style={{ cursor: hasDetails ? 'pointer' : 'default' }}
              >
                <div className="context-header-left">
                  {hasDetails && (
                    <span className={`expand-icon ${isExpanded ? 'expanded' : ''}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </span>
                  )}
                  <span className="context-issue">{ctx.issue}</span>
                  {ctx.ticket_ref && (
                    <span className="ticket-badge">{ctx.ticket_ref}</span>
                  )}
                </div>
                <span className="context-meta">
                  {ctx.author} &bull; {new Date(ctx.created_at).toLocaleDateString()}
                </span>
              </div>

              {isExpanded && (
                <div className="context-details">
                  {ctx.root_cause && (
                    <div className="context-field">
                      <label>Root Cause:</label>
                      <span>{ctx.root_cause}</span>
                    </div>
                  )}

                  {ctx.resolution && (
                    <div className="context-field">
                      <label>Resolution:</label>
                      <span>{ctx.resolution}</span>
                    </div>
                  )}

                  {ctx.commands && (
                    <div className="context-field">
                      <label>Commands:</label>
                      <pre>{ctx.commands}</pre>
                    </div>
                  )}

                  {canModify(ctx) && (
                    <div className="context-entry-actions">
                      <button className="ns-btn ns-btn--small" onClick={() => startEdit(ctx)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        Edit
                      </button>
                      <button className="ns-btn ns-btn--small ns-btn--danger" onClick={() => handleDelete(ctx.id)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
