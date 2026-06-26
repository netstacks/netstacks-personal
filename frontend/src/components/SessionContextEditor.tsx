import { useState } from 'react';
import { useSessionContext } from '../hooks/useSessionContext';
import type { SessionContext } from '../types/sessionContext';
import './SessionContextEditor.css';
import AITabInput from './AITabInput';

interface SessionContextEditorProps {
  /** Standalone / session-keyed target. Provide exactly one of sessionId/deviceId. */
  sessionId?: string;
  /** Enterprise / device-keyed target (Controller device id). */
  deviceId?: string;
  currentUser: string; // For author field
}

export default function SessionContextEditor({ sessionId, deviceId, currentUser }: SessionContextEditorProps): React.ReactElement {
  const { contexts, loading, error, addContext, updateContext, deleteContext } = useSessionContext({ sessionId, deviceId });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const handleAdd = async () => {
    try {
      await addContext({
        ...formData,
        author: currentUser,
      });
      resetForm();
    } catch (err) {
      console.error('Failed to add context:', err);
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      await updateContext(id, formData);
      resetForm();
    } catch (err) {
      console.error('Failed to update context:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteContext(id);
    } catch (err) {
      console.error('Failed to delete context:', err);
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
        {!showAddForm && (
          <button className="add-context-btn" onClick={() => setShowAddForm(true)}>
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
              aiContext={{ issue: formData.issue, root_cause: formData.root_cause }}
              onAIValue={(v) => updateField('commands', v)}
            />
          </div>

          <div className="form-group">
            <label>Ticket Reference</label>
            <input
              type="text"
              value={formData.ticket_ref}
              onChange={(e) => updateField('ticket_ref', e.target.value)}
              placeholder="e.g., JIRA-1234"
            />
          </div>

          <div className="form-actions">
            <button className="btn-secondary" onClick={resetForm}>Cancel</button>
            <button
              className="btn-primary"
              onClick={() => editingId ? handleUpdate(editingId) : handleAdd()}
              disabled={!formData.issue.trim()}
            >
              {editingId ? 'Save Changes' : 'Add Context'}
            </button>
          </div>
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
            <div key={ctx.id} className={`context-entry ${isExpanded ? 'expanded' : ''}`}>
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

                  <div className="context-entry-actions">
                    <button className="btn-small" onClick={() => startEdit(ctx)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                      Edit
                    </button>
                    <button className="btn-small btn-danger" onClick={() => handleDelete(ctx.id)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
