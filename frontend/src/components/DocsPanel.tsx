import React, { useState, useEffect, useCallback, useRef } from 'react';
import './DocsPanel.css';
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition';
import {
  listDocuments,
  deleteDocument,
  createDocument,
  updateDocument,
  isSecureCategory,
  type Document,
  type DocumentCategory,
  type ContentType,
} from '../api/docs';
import { downloadMopPackage, importMopPackage, parseMopPackageJson } from '../lib/mopExport';
import { resolveDocSaveTarget } from '../lib/docSaveTargets';
import { showToast } from './Toast';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { Icon } from '@iconify/react';
import { getIconForFile } from 'vscode-icons-js';

import { getErrorMessage } from '../api/errors'
interface DocsPanelProps {
  onOpenDocument: (doc: Document) => void;
  onNewDocument: (category: DocumentCategory) => void;
}

// Icons
const Icons = {
  document: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  // Category-specific icons
  outputs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  templates: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  ),
  notes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  ),
  backups: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  troubleshooting: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
      <circle cx="12" cy="12" r="3" fill="none" />
    </svg>
  ),
  mops: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 14l2 2 4-4" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  importArrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3v12" />
      <polyline points="8 11 12 15 16 11" />
      <path d="M20 21H4" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </svg>
  ),
};

// Category metadata
interface CategoryMeta {
  name: string;
  icon: React.ReactNode;
  allowAdd: boolean;
}

const CATEGORIES: Partial<Record<DocumentCategory, CategoryMeta>> = {
  outputs: { name: 'Outputs', icon: Icons.outputs, allowAdd: true },
  templates: { name: 'Templates', icon: Icons.templates, allowAdd: true },
  notes: { name: 'Notes', icon: Icons.notes, allowAdd: true },
  backups: { name: 'Backups', icon: Icons.backups, allowAdd: true },
  troubleshooting: { name: 'Troubleshooting', icon: Icons.troubleshooting, allowAdd: false },
  mops: { name: 'MOPs', icon: Icons.mops, allowAdd: false },
};

const CATEGORY_ORDER: DocumentCategory[] = ['outputs', 'templates', 'notes', 'backups', 'troubleshooting', 'mops'];

// Content type options for the dropdown (reserved for new document form UI)
const CONTENT_TYPE_OPTIONS: { value: ContentType; label: string }[] = [
  { value: 'text', label: 'Plain Text' },
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'jinja', label: 'Jinja Template' },
  { value: 'config', label: 'Config' },
  { value: 'markdown', label: 'Markdown' },
];

function DocsPanel({ onOpenDocument, onNewDocument }: DocsPanelProps) {
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature);
  const visibleCategories = CATEGORY_ORDER.filter((cat) => {
    if (cat === 'mops') return hasFeature('mops');
    if (cat === 'troubleshooting') return hasFeature('local_ai_tools');
    return true;
  });

  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<DocumentCategory>>(new Set());
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    doc: Document;
  } | null>(null);
  const { ref: contextMenuRef, style: contextMenuStyle } = useClampedMenuPosition(contextMenu);

  // New document form state
  const [showNewForm, setShowNewForm] = useState(false);
  const [newFormCategory, setNewFormCategory] = useState<DocumentCategory>('notes');
  const [newDocName, setNewDocName] = useState('');
  const [newDocContentType, setNewDocContentType] = useState<ContentType>('text');
  const [isCreating, setIsCreating] = useState(false);

  // Delete confirmation state
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  // Multi-select (bulk delete / move) + drag-to-folder state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropCategory, setDropCategory] = useState<DocumentCategory | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  // MOP file upload ref
  const mopFileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listDocuments();
      setDocuments(data);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load documents'));
    } finally {
      setLoading(false);
    }
  }, []);

  // MOP handlers
  const handleDownloadMop = useCallback((doc: Document) => {
    try {
      const { package: pkg } = parseMopPackageJson(doc.content);
      downloadMopPackage(pkg);
      showToast(`Downloading "${doc.name}"`, 'success');
    } catch (err) {
      showToast(`Download failed: ${getErrorMessage(err, String(err))}`, 'error');
    }
    setContextMenu(null);
  }, []);

  const handleImportMopToChanges = useCallback(async (doc: Document) => {
    setContextMenu(null);
    try {
      const { package: pkg } = parseMopPackageJson(doc.content);
      const result = await importMopPackage(pkg);
      showToast(
        `Imported "${result.name}" — ${result.steps_imported} steps${result.overrides_imported > 0 ? `, ${result.overrides_imported} device overrides` : ''}`,
        'success'
      );
    } catch (err) {
      showToast(`Import failed: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, []);

  const handleUploadMopFile = useCallback(() => {
    mopFileInputRef.current?.click();
  }, []);

  const handleMopFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const content = await file.text();
      const { package: pkg, warnings } = parseMopPackageJson(content);

      const { category, folder } = resolveDocSaveTarget('mop');
      await createDocument({
        name: pkg.mop.name + '.mop.json',
        category,
        content_type: 'json',
        content,
        parent_folder: folder,
      });

      await fetchDocuments();

      if (warnings.length > 0) {
        showToast(`Uploaded "${pkg.mop.name}" with warnings: ${warnings.join('; ')}`, 'warning', 5000);
      } else {
        showToast(`Uploaded "${pkg.mop.name}" to MOPs`, 'success');
      }
    } catch (err) {
      showToast(`Upload failed: ${getErrorMessage(err, String(err))}`, 'error');
    }
  }, [fetchDocuments]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  const toggleCategory = (category: DocumentCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const handleContextMenu = (e: React.MouseEvent, doc: Document) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, doc });
  };

  const handleDelete = (doc: Document) => {
    setConfirmDelete({ id: doc.id, name: doc.name });
    setContextMenu(null);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteDocument(confirmDelete.id);
      setDocuments((prev) => prev.filter((d) => d.id !== confirmDelete.id));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete document'));
    }
    setConfirmDelete(null);
  };

  const handleMoveCategory = async (doc: Document, newCategory: DocumentCategory) => {
    try {
      await updateDocument(doc.id, { category: newCategory });
      setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, category: newCategory } : d));
      showToast(`Moved to ${newCategory}`, 'success');
    } catch {
      showToast('Failed to move document', 'error');
    }
    setContextMenu(null);
  };

  // --- Multi-select + bulk operations ---
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    setConfirmBulkDelete(false);
    let failed = 0;
    // Delete sequentially (like the single-delete path), removing each from the
    // list as it succeeds so the UI reflects progress.
    for (const id of ids) {
      try {
        await deleteDocument(id);
        setDocuments((prev) => prev.filter((d) => d.id !== id));
      } catch (e) {
        failed++;
        console.error('[DocsPanel] bulk delete failed for', id, e);
      }
    }
    clearSelection();
    // Re-sync with the backend so the list matches server truth either way.
    await fetchDocuments();
    if (failed > 0) showToast(`${failed} document${failed === 1 ? '' : 's'} failed to delete`, 'error');
    else showToast(`Deleted ${ids.length} document${ids.length === 1 ? '' : 's'}`, 'success');
  };

  // Move a set of doc ids into a category (skips docs already there). Used by
  // both the bulk "Move to…" menu and drag-to-folder.
  const moveDocsToCategory = async (ids: string[], category: DocumentCategory) => {
    const toMove = documents.filter((d) => ids.includes(d.id) && d.category !== category);
    if (toMove.length === 0) return;
    const results = await Promise.allSettled(
      toMove.map((d) => updateDocument(d.id, { category }))
    );
    const moved = new Set(toMove.filter((_, i) => results[i].status === 'fulfilled').map((d) => d.id));
    setDocuments((prev) => prev.map((d) => (moved.has(d.id) ? { ...d, category } : d)));
    const meta = CATEGORIES[category];
    if (moved.size > 0) showToast(`Moved ${moved.size} to ${meta?.name ?? category}`, 'success');
    if (moved.size < toMove.length) showToast('Some documents failed to move', 'error');
  };

  // --- Drag to folder (category) ---
  const handleDragStart = (e: React.DragEvent, doc: Document) => {
    // Dragging a selected doc drags the whole selection; otherwise just it.
    const ids = selected.has(doc.id) ? Array.from(selected) : [doc.id];
    e.dataTransfer.setData('application/x-doc-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(doc.id);
  };
  const handleDragEnd = () => {
    setDraggingId(null);
    setDropCategory(null);
  };
  const handleCategoryDrop = async (e: React.DragEvent, category: DocumentCategory) => {
    e.preventDefault();
    setDropCategory(null);
    let ids: string[] = [];
    try { ids = JSON.parse(e.dataTransfer.getData('application/x-doc-ids')); } catch { /* ignore */ }
    if (!Array.isArray(ids) || ids.length === 0) return;
    await moveDocsToCategory(ids, category);
    if (ids.some((id) => selected.has(id))) clearSelection();
  };

  // Open new document form for a specific category
  const handleOpenNewForm = (category: DocumentCategory) => {
    setNewFormCategory(category);
    setNewDocName('');
    setNewDocContentType('text');
    setShowNewForm(true);
    // Also notify parent (for compatibility)
    onNewDocument(category);
  };

  const handleCancelNewForm = () => {
    setShowNewForm(false);
    setNewDocName('');
    setNewDocContentType('text');
  };

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim()) return;

    setIsCreating(true);
    try {
      const newDoc = await createDocument({
        name: newDocName.trim(),
        category: newFormCategory,
        content_type: newDocContentType,
        content: '',
      });
      // Add to documents list
      setDocuments((prev) => [...prev, newDoc]);
      // Reset form
      setShowNewForm(false);
      setNewDocName('');
      setNewDocContentType('text');
      // Open the new document
      onOpenDocument(newDoc);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create document'));
    } finally {
      setIsCreating(false);
    }
  };

  // Group documents by category
  const documentsByCategory = new Map<DocumentCategory, Document[]>();
  CATEGORY_ORDER.forEach((category) => {
    documentsByCategory.set(category, []);
  });
  documents.forEach((doc) => {
    const list = documentsByCategory.get(doc.category);
    if (list) {
      list.push(doc);
    }
  });

  // Auto-expand categories that have documents (once after first load)
  useEffect(() => {
    if (hasAutoExpanded || loading) return;
    const nonEmpty = CATEGORY_ORDER.filter((cat) => (documentsByCategory.get(cat)?.length ?? 0) > 0);
    if (nonEmpty.length > 0) {
      setExpandedCategories(new Set(nonEmpty));
    }
    setHasAutoExpanded(true);
  }, [loading, hasAutoExpanded]);

  // Map our Document.content_type to a sensible file extension so vscode-icons
  // can pick a matching glyph. If the document's name already has an extension,
  // prefer that.
  const contentTypeExt: Record<ContentType, string> = {
    csv: 'csv',
    json: 'json',
    jinja: 'j2',
    config: 'conf',
    text: 'txt',
    markdown: 'md',
    recording: 'json',
  };

  const getDocIcon = (doc: Document) => {
    if (doc.parent_folder) {
      return Icons.folder;
    }
    const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(doc.name);
    const lookupName = hasExt ? doc.name : `${doc.name}.${contentTypeExt[doc.content_type] ?? 'txt'}`;
    const svgName = getIconForFile(lookupName);
    const iconName = svgName
      ? `vscode-icons:${svgName.replace(/\.svg$/, '').replace(/_/g, '-')}`
      : 'vscode-icons:default-file';
    return <Icon icon={iconName} width={16} height={16} />;
  };

  const renderDocument = (doc: Document) => {
    const isSel = selected.has(doc.id);
    return (
      <div
        key={doc.id}
        className={`docs-item ${doc.parent_folder ? 'folder' : ''}${isSel ? ' selected' : ''}${draggingId === doc.id ? ' dragging' : ''}`}
        draggable
        onDragStart={(e) => handleDragStart(e, doc)}
        onDragEnd={handleDragEnd}
        onClick={(e) => {
          // Ctrl/⌘-click toggles selection; a plain click opens the document.
          if (e.metaKey || e.ctrlKey) { e.preventDefault(); toggleSelect(doc.id); return; }
          onOpenDocument(doc);
        }}
        onContextMenu={(e) => handleContextMenu(e, doc)}
        title={doc.name}
      >
        <span
          className="docs-item-check"
          onClick={(e) => { e.stopPropagation(); toggleSelect(doc.id); }}
          title="Select"
        >
          <input type="checkbox" checked={isSel} readOnly tabIndex={-1} />
        </span>
        <span className="docs-item-icon">{getDocIcon(doc)}</span>
        <span className="docs-item-name">{doc.name}</span>
      </div>
    );
  };

  const renderCategory = (category: DocumentCategory) => {
    const meta = CATEGORIES[category];
    if (!meta) return null;
    const docs = documentsByCategory.get(category) || [];
    const isExpanded = expandedCategories.has(category);
    const secure = isSecureCategory(category);

    return (
      <div key={category} className="docs-section">
        <div
          className={`docs-section-header${dropCategory === category ? ' drop-target' : ''}`}
          onClick={() => toggleCategory(category)}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dropCategory !== category) setDropCategory(category);
          }}
          onDragLeave={() => setDropCategory((c) => (c === category ? null : c))}
          onDrop={(e) => handleCategoryDrop(e, category)}
        >
          <span className="docs-section-chevron">
            {isExpanded ? Icons.chevronDown : Icons.chevronRight}
          </span>
          <span className="docs-section-icon">{meta.icon}</span>
          <span className="docs-section-name">{meta.name}</span>
          {secure && (
            <span
              className="docs-section-lock"
              title="Encrypted at rest with your vault password"
              aria-label="Encrypted at rest"
            >
              {Icons.lock}
            </span>
          )}
          <span className="docs-section-count">{docs.length}</span>
          <span className="docs-section-actions">
            {meta.allowAdd && (
              <button
                className="docs-section-add"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenNewForm(category);
                }}
                title={`New ${meta.name.slice(0, -1)}`}
              >
                {Icons.plus}
              </button>
            )}
            {category === 'mops' && (
              <button
                className="docs-section-add"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUploadMopFile();
                }}
                title="Import .mop.json file"
              >
                {Icons.upload}
              </button>
            )}
          </span>
        </div>
        {isExpanded && (
          <div className="docs-section-items">
            {docs.length > 0 ? (
              docs.map(renderDocument)
            ) : (
              <div className="docs-section-empty">No {meta.name.toLowerCase()}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="docs-panel">
      {loading && (
        <div className="docs-panel-status">Loading documents...</div>
      )}

      {error && (
        <div className="docs-panel-error">
          {error}
          <button onClick={fetchDocuments}>Retry</button>
        </div>
      )}

      {/* New Document Form */}
      {showNewForm && CATEGORIES[newFormCategory] && (
        <form className="docs-new-form" data-testid="docs-new-form" onSubmit={handleCreateDocument}>
          <div className="docs-new-form-header">
            <span>New Document in {CATEGORIES[newFormCategory]!.name}</span>
          </div>
          <div className="docs-new-form-field">
            <input
              type="text"
              placeholder="Document name..."
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              autoFocus
              disabled={isCreating}
            />
          </div>
          <div className="docs-new-form-field">
            <select
              value={newDocContentType}
              onChange={(e) => setNewDocContentType(e.target.value as ContentType)}
              disabled={isCreating}
            >
              {CONTENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="docs-new-form-actions">
            <button type="submit" className="docs-new-form-btn primary" disabled={isCreating || !newDocName.trim()}>
              {isCreating ? 'Creating...' : 'Create'}
            </button>
            <button type="button" className="docs-new-form-btn" onClick={handleCancelNewForm} disabled={isCreating}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!loading && !error && (
        <div className={`docs-list${selected.size > 0 ? ' selecting' : ''}`}>
          {visibleCategories.map(renderCategory)}
        </div>
      )}

      {selected.size > 0 && (
        <div className="docs-bulk-bar">
          <span className="docs-bulk-count">{selected.size} selected</span>
          <div className="docs-bulk-actions">
            <select
              className="docs-bulk-move"
              value=""
              onChange={(e) => {
                if (e.target.value) void moveDocsToCategory(Array.from(selected), e.target.value as DocumentCategory).then(clearSelection);
              }}
              title="Move selected to a folder"
            >
              <option value="">Move to…</option>
              {visibleCategories.map((c) => (
                <option key={c} value={c}>{CATEGORIES[c]?.name ?? c}</option>
              ))}
            </select>
            <button className="docs-bulk-delete" onClick={() => setConfirmBulkDelete(true)} title="Delete selected">
              Delete
            </button>
            <button className="docs-bulk-clear" onClick={clearSelection} title="Clear selection">
              Clear
            </button>
          </div>
        </div>
      )}


      <div className="docs-panel-footer">
        <button
          className="docs-panel-refresh"
          onClick={fetchDocuments}
          title="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="docs-context-menu"
          style={contextMenuStyle}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              onOpenDocument(contextMenu.doc);
              setContextMenu(null);
            }}
          >
            {Icons.document}
            <span>Open</span>
          </button>
          {contextMenu.doc.category === 'mops' && (
            <>
              <div className="context-menu-divider" />
              <button
                className="context-menu-item"
                onClick={() => handleDownloadMop(contextMenu.doc)}
              >
                {Icons.download}
                <span>Download .mop.json</span>
              </button>
              <button
                className="context-menu-item"
                onClick={() => handleImportMopToChanges(contextMenu.doc)}
              >
                {Icons.importArrow}
                <span>Import to MOPs</span>
              </button>
            </>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-submenu">
            <button className="context-menu-item">
              {Icons.folder}
              <span>Move to</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" style={{ marginLeft: 'auto' }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <div className="context-submenu-dropdown">
              {visibleCategories.filter(c => c !== contextMenu.doc.category).map(cat => (
                <button
                  key={cat}
                  className="context-menu-item"
                  onClick={() => handleMoveCategory(contextMenu.doc, cat)}
                >
                  <span style={{ textTransform: 'capitalize' }}>{cat}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => handleDelete(contextMenu.doc)}
          >
            {Icons.trash}
            <span>Delete</span>
          </button>
        </div>
      )}

      {/* Hidden file input for MOP upload */}
      <input
        ref={mopFileInputRef}
        type="file"
        accept=".mop.json,.json"
        style={{ display: 'none' }}
        onChange={handleMopFileSelected}
      />

      {/* Delete Confirmation Dialog */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div
            className="docs-delete-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: 'var(--color-text-primary)' }}>
              Delete Document
            </h3>
            <p style={{ marginBottom: '20px', color: 'var(--color-text-secondary)' }}>
              Are you sure you want to delete "{confirmDelete.name}"? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => setConfirmDelete(null)}
                className="docs-new-form-btn"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="docs-new-form-btn"
                style={{
                  background: 'var(--color-error)',
                  borderColor: 'var(--color-error)',
                  color: 'white'
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      {confirmBulkDelete && (
        <div className="modal-overlay" onClick={() => setConfirmBulkDelete(false)}>
          <div className="docs-delete-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, marginBottom: '12px', color: 'var(--color-text-primary)' }}>
              Delete {selected.size} document{selected.size === 1 ? '' : 's'}
            </h3>
            <p style={{ marginBottom: '20px', color: 'var(--color-text-secondary)' }}>
              Are you sure you want to delete {selected.size} selected document{selected.size === 1 ? '' : 's'}? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setConfirmBulkDelete(false)} className="docs-new-form-btn">
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                className="docs-new-form-btn"
                style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)', color: 'white' }}
              >
                Delete {selected.size}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DocsPanel;
