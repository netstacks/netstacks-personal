import { useState, useCallback, useRef } from 'react';
import { useChangeControl } from '../hooks/useChangeControl';
import type { Change } from '../types/change';
import { changeStatusLabels, changeStatusColors } from '../types/change';
import ContextMenu from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { useContextMenu } from '../hooks/useContextMenu';
import { exportMopPackage, readMopPackageFromFile, importMopPackage, parseMopPackageJson } from '../lib/mopExport';
import { getCurrentMode } from '../api/client';
import { showToast } from './Toast';
import { confirmDialog } from './ConfirmDialog';

import { getErrorMessage } from '../api/errors'
async function confirmDeleteChange(name: string): Promise<boolean> {
  return confirmDialog({
    title: 'Delete MOP plan?',
    body: <>Delete <strong>{name}</strong>? This removes the plan and its snapshots.</>,
    confirmLabel: 'Delete',
    destructive: true,
  });
}
import { listDocuments, createDocument, type Document } from '../api/docs';
import { updateChange as apiUpdateChange } from '../api/changes';
import './ChangesPanel.css';

interface ChangesPanelProps {
  sessionId?: string;
  onSelectChange?: (change: Change) => void;
  onOpenMopTab?: (planId?: string, planName?: string, executionId?: string) => void;
}

export default function ChangesPanel({ sessionId, onSelectChange, onOpenMopTab }: ChangesPanelProps) {
  const {
    changes,
    selectedChange,
    loading,
    error,
    loadChanges,
    selectChange,
    deleteChange,
  } = useChangeControl({ sessionId });

  const [searchText, setSearchText] = useState('');
  const contextMenu = useContextMenu();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Docs picker state for importing from Docs > MOPs
  const [showDocsPicker, setShowDocsPicker] = useState(false);
  const [mopDocs, setMopDocs] = useState<Document[]>([]);


  // Attach document picker state
  const [showAttachPicker, setShowAttachPicker] = useState(false);
  const [attachDocTarget, setAttachDocTarget] = useState<Change | null>(null);
  const [attachDocs, setAttachDocs] = useState<Document[]>([]);

  // MOP Export handler — saves to Docs > MOPs (Knowledge Base in enterprise)
  const handleExportMop = useCallback(async (change: Change) => {
    try {
      const pkg = await exportMopPackage(change.id);
      // In enterprise mode, save to Docs (Knowledge Base) from the frontend.
      // In standalone mode, the agent already saves to docs server-side.
      if (getCurrentMode() === 'enterprise') {
        await createDocument({
          name: `${change.name}.mop.json`,
          category: 'mops',
          content_type: 'json',
          content: JSON.stringify(pkg, null, 2),
        });
      }
      showToast(`Exported "${change.name}" to Docs > MOPs`, 'success');
    } catch (err) {
      showToast(`Export failed: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, []);

  // MOP Import handlers
  const handleImportMop = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be re-selected
    e.target.value = '';

    try {
      const { package: pkg, warnings } = await readMopPackageFromFile(file);
      const result = await importMopPackage(pkg);

      if (result.warnings.length > 0 || warnings.length > 0) {
        const allWarnings = [...warnings, ...result.warnings];
        showToast(
          `Imported "${result.name}" (${result.steps_imported} steps). Warnings: ${allWarnings.join('; ')}`,
          'warning',
          5000
        );
      } else {
        showToast(
          `Imported "${result.name}" — ${result.steps_imported} steps${result.overrides_imported > 0 ? `, ${result.overrides_imported} device overrides` : ''}${result.document_created ? ', document created' : ''}`,
          'success'
        );
      }

      loadChanges();
    } catch (err) {
      showToast(`Import failed: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, [loadChanges]);

  // Import from Docs handlers
  const handleImportFromDocs = useCallback(async () => {
    try {
      const docs = await listDocuments('mops');
      if (docs.length === 0) {
        showToast('No MOP documents found in Docs', 'warning');
        return;
      }
      setMopDocs(docs);
      setShowDocsPicker(true);
    } catch (err) {
      showToast(`Failed to load docs: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, []);

  const handleSelectDocForImport = useCallback(async (doc: Document) => {
    setShowDocsPicker(false);
    try {
      const { package: pkg } = parseMopPackageJson(doc.content);
      const result = await importMopPackage(pkg);
      showToast(
        `Imported "${result.name}" — ${result.steps_imported} steps${result.overrides_imported > 0 ? `, ${result.overrides_imported} device overrides` : ''}`,
        'success'
      );
      loadChanges();
    } catch (err) {
      showToast(`Import failed: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, [loadChanges]);

  // Attach document to a Change
  const handleAttachDoc = useCallback(async (change: Change) => {
    try {
      const docs = await listDocuments();
      const eligible = docs.filter(d => d.content_type === 'markdown' || d.content_type === 'text');
      if (eligible.length === 0) {
        showToast('No markdown or text documents available to attach', 'warning');
        return;
      }
      setAttachDocTarget(change);
      setAttachDocs(eligible);
      setShowAttachPicker(true);
    } catch (err) {
      showToast(`Failed to load documents: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, []);

  const handleSelectDocForAttach = useCallback(async (doc: Document) => {
    setShowAttachPicker(false);
    if (!attachDocTarget) return;
    try {
      await apiUpdateChange(attachDocTarget.id, { document_id: doc.id });
      showToast(`Attached "${doc.name}" to MOP`, 'success');
      loadChanges();
    } catch (err) {
      showToast(`Failed to attach document: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, [attachDocTarget, loadChanges]);

  // Detach document from a Change
  const handleDetachDoc = useCallback(async (change: Change) => {
    try {
      await apiUpdateChange(change.id, { document_id: null });
      showToast('Detached document from MOP', 'success');
      loadChanges();
    } catch (err) {
      showToast(`Failed to detach document: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, [loadChanges]);

  // Handle execute button
  const handleExecute = useCallback((change: Change) => {
    onOpenMopTab?.(change.id, change.name);
  }, [onOpenMopTab]);

  const filteredChanges = searchText
    ? changes.filter(c => c.name.toLowerCase().includes(searchText.toLowerCase()) || c.description?.toLowerCase().includes(searchText.toLowerCase()))
    : changes;

  const handleNewChange = useCallback(() => {
    onOpenMopTab?.();
  }, [onOpenMopTab]);

  const handleEditChange = useCallback((change: Change) => {
    onOpenMopTab?.(change.id, change.name);
  }, [onOpenMopTab]);

  const handleSelectChange = useCallback((change: Change) => {
    selectChange(change.id);
    onSelectChange?.(change);
  }, [selectChange, onSelectChange]);

  // Context menu for a change item
  const handleChangeContextMenu = useCallback((e: React.MouseEvent, change: Change) => {
    const items: MenuItem[] = [
      {
        id: 'open-tab',
        label: 'Open in Workspace',
        action: () => onOpenMopTab?.(change.id, change.name),
      },
      {
        id: 'view-details',
        label: 'View Details',
        action: () => handleSelectChange(change),
      },
      { id: 'divider-1', label: '', divider: true, action: () => {} },
    ];
    if (change.status === 'draft') {
      items.push(
        { id: 'execute', label: 'Execute', action: () => handleExecute(change) },
        { id: 'edit', label: 'Edit', action: () => handleEditChange(change) },
        { id: 'delete', label: 'Delete', action: async () => {
          if (await confirmDeleteChange(change.name)) deleteChange(change.id);
        }},
      );
    }
    items.push(
      { id: 'divider-export', label: '', divider: true, action: () => {} },
      { id: 'export-mop', label: 'Export as .mop.json', action: () => handleExportMop(change) },
    );
    // Attach/detach document
    if (change.document_id) {
      items.push({ id: 'detach-doc', label: 'Detach Document', action: () => handleDetachDoc(change) });
    } else {
      items.push({ id: 'attach-doc', label: 'Attach Document...', action: () => handleAttachDoc(change) });
    }
    contextMenu.open(e, items);
  }, [handleSelectChange, handleExecute, handleEditChange, deleteChange, handleExportMop, handleAttachDoc, handleDetachDoc, onOpenMopTab, contextMenu]);

  // Context menu for empty area
  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { id: 'new-mop', label: 'New MOP Plan', action: handleNewChange },
      { id: 'import-mop', label: 'Import MOP...', action: handleImportMop },
      { id: 'import-docs', label: 'Import from Docs...', action: handleImportFromDocs },
      { id: 'refresh', label: 'Refresh', action: loadChanges },
    ];
    contextMenu.open(e, items);
  }, [handleNewChange, handleImportMop, handleImportFromDocs, loadChanges, contextMenu]);

  // SVG icons for status
  const StatusIcons = {
    draft: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="7" y1="8" x2="17" y2="8" />
        <line x1="7" y1="12" x2="17" y2="12" />
        <line x1="7" y1="16" x2="12" y2="16" />
      </svg>
    ),
    executing: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    validating: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
    ),
    complete: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    failed: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    rolled_back: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="1 4 1 10 7 10" />
        <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
      </svg>
    ),
    pending_review: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
    approved: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <polyline points="9 12 11 14 15 10" />
      </svg>
    ),
    rejected: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
  };

  if (loading && changes.length === 0) {
    return (
      <div className="changes-panel">
        <div className="changes-panel-status">Loading changes...</div>
      </div>
    );
  }

  return (
    <div className="changes-panel" data-testid="changes-panel">
      <div className="changes-header">
        <div className="changes-actions">
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search MOPs..."
            className="mop-search-input"
          />
          <button className="import-mop-btn" onClick={handleImportMop} title="Import MOP from .mop.json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <button className="new-change-btn" onClick={handleNewChange} title="Create new MOP Plan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New MOP Plan
          </button>
        </div>
      </div>

      {error && (
        <div className="changes-panel-error">
          {error}
          <button onClick={loadChanges}>Retry</button>
        </div>
      )}

      <div className="changes-list" onContextMenu={handleEmptyContextMenu}>
        {filteredChanges.length === 0 ? (
          <div className="no-changes">
            {searchText
              ? `No MOP Plans matching "${searchText}".`
              : 'No MOP Plans yet. Create a MOP Plan to get started.'}
          </div>
        ) : (
          filteredChanges.map((change) => (
            <div
              key={change.id}
              className={`change-item ${selectedChange?.id === change.id ? 'selected' : ''}`}
              onClick={() => handleSelectChange(change)}
              onDoubleClick={() => onOpenMopTab?.(change.id, change.name)}
              onContextMenu={(e) => handleChangeContextMenu(e, change)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleSelectChange(change);
              }}
            >
              <div className="change-item-header">
                <span
                  className="change-status-icon"
                  style={{ color: changeStatusColors[change.status] }}
                  title={changeStatusLabels[change.status]}
                >
                  {StatusIcons[change.status]}
                </span>
                <span className="change-name">{change.name}</span>
                <span className="change-status-badge" style={{ color: changeStatusColors[change.status] }}>
                  {changeStatusLabels[change.status]}
                </span>
              </div>
              <div className="change-item-details">
                <div className="change-item-details-inner">
                  <div className="change-item-meta">
                    <span className="step-count">
                      {change.mop_steps.length} step{change.mop_steps.length !== 1 ? 's' : ''}
                    </span>
                    <span className="change-date">
                      {new Date(change.created_at).toLocaleDateString()}
                    </span>
                    <span className="change-author">by {change.created_by}</span>
                    {change.document_id && (
                      <span className="change-doc-badge" title="Has attached document">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                        </svg>
                      </span>
                    )}
                  </div>
                  {change.description && (
                    <div className="change-description">{change.description}</div>
                  )}
                  <div className="change-item-actions">
                    {(change.status === 'draft' || change.status === 'approved' || change.status === 'rejected' || change.status === 'pending_review') && (
                      <>
                        <button
                          className="execute-btn"
                          onClick={(e) => { e.stopPropagation(); handleExecute(change); }}
                          title="Execute this MOP Plan"
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          Execute
                        </button>
                        <button
                          className="edit-btn"
                          onClick={(e) => { e.stopPropagation(); handleEditChange(change); }}
                        >
                          Edit
                        </button>
                        <button
                          className="delete-btn"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (await confirmDeleteChange(change.name)) deleteChange(change.id);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="changes-panel-footer">
        <button
          className="changes-panel-refresh"
          onClick={loadChanges}
          disabled={loading}
          title="Refresh changes"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      <ContextMenu position={contextMenu.position} items={contextMenu.items} onClose={contextMenu.close} />

      {/* Docs Picker Modal */}
      {showDocsPicker && (
        <div className="modal-overlay" onClick={() => setShowDocsPicker(false)}>
          <div className="docs-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="docs-picker-header">
              <span>Import MOP from Docs</span>
              <button className="docs-picker-close" onClick={() => setShowDocsPicker(false)}>&times;</button>
            </div>
            <div className="docs-picker-list">
              {mopDocs.length === 0 ? (
                <div className="docs-picker-empty">No MOP documents available</div>
              ) : (
                mopDocs.map((doc) => (
                  <button
                    key={doc.id}
                    className="docs-picker-item"
                    onClick={() => handleSelectDocForImport(doc)}
                  >
                    <span className="docs-picker-item-name">{doc.name}</span>
                    <span className="docs-picker-item-date">
                      {new Date(doc.updated_at).toLocaleDateString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Attach Document Picker Modal */}
      {showAttachPicker && (
        <div className="modal-overlay" onClick={() => setShowAttachPicker(false)}>
          <div className="docs-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="docs-picker-header">
              <span>Attach Document to "{attachDocTarget?.name}"</span>
              <button className="docs-picker-close" onClick={() => setShowAttachPicker(false)}>&times;</button>
            </div>
            <div className="docs-picker-list">
              {attachDocs.length === 0 ? (
                <div className="docs-picker-empty">No documents available</div>
              ) : (
                attachDocs.map((doc) => (
                  <button
                    key={doc.id}
                    className="docs-picker-item"
                    onClick={() => handleSelectDocForAttach(doc)}
                  >
                    <span className="docs-picker-item-name">{doc.name}</span>
                    <span className="docs-picker-item-date">
                      {new Date(doc.updated_at).toLocaleDateString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".mop.json,.json"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />
    </div>
  );
}
