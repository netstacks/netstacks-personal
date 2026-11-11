import AITabInput from './AITabInput';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './DocsPanel.css';
import ContextMenu, { type MenuItem } from './ContextMenu';
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
import { DEFAULT_FILE_ICON, useFileIconsReady } from '../lib/iconifyInit';

import { getErrorMessage } from '../api/errors'
import DialogFooter from './DialogFooter';
import Tooltip from './Tooltip';
import ModalFrame from './ModalFrame';
interface DocsPanelProps {
  onOpenDocument: (doc: Document) => void;
  onNewDocument: (category: DocumentCategory) => void;
  /** Category to expand and scroll into view on mount / when it changes
   *  (Quick Look Notes / Templates / Outputs). */
  initialCategory?: DocumentCategory;
}

/** Dispatched (with `detail.category`) to focus a category in an already-mounted panel. */
export const DOCS_SELECT_CATEGORY_EVENT = 'netstacks:docs-select-category';

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

function DocsPanel({ onOpenDocument, onNewDocument, initialCategory }: DocsPanelProps) {
  const newDocFormRef = useRef<HTMLFormElement>(null);
  const hasFeature = useCapabilitiesStore((s) => s.hasFeature);
  const fileIconsReady = useFileIconsReady();
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
  // Per-category section elements + a category to scroll to once the list
  // has rendered (focus requested while documents were still loading).
  const sectionRefs = useRef<Partial<Record<DocumentCategory, HTMLDivElement | null>>>({});
  const pendingScrollRef = useRef<DocumentCategory | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    doc: Document;
  } | null>(null);

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
  }, []);

  const handleImportMopToChanges = useCallback(async (doc: Document) => {
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

  // Initial load: state starts as loading / no error, so the effect only
  // sets state from its callbacks (fetchDocuments is for later refreshes).
  useEffect(() => {
    listDocuments()
      .then(setDocuments)
      .catch((err: unknown) => setError(getErrorMessage(err, 'Failed to load documents')))
      .finally(() => setLoading(false));
  }, []);

  // Expand a category and bring its header into view (Quick Look shortcuts).
  const expandCategory = useCallback((category: DocumentCategory) => {
    setExpandedCategories((prev) => {
      if (prev.has(category)) return prev;
      const next = new Set(prev);
      next.add(category);
      return next;
    });
  }, []);
  const scrollToCategory = useCallback((category: DocumentCategory) => {
    const el = sectionRefs.current[category];
    if (el) el.scrollIntoView({ block: 'nearest' });
    else pendingScrollRef.current = category;
  }, []);
  const focusCategory = useCallback((category: DocumentCategory) => {
    expandCategory(category);
    scrollToCategory(category);
  }, [expandCategory, scrollToCategory]);

  // initialCategory: expand during render (no effect round-trip); scrolling
  // is DOM work, so it stays in an effect.
  const [prevInitialCategory, setPrevInitialCategory] = useState<DocumentCategory | undefined>(undefined);
  if (initialCategory !== prevInitialCategory) {
    setPrevInitialCategory(initialCategory);
    if (initialCategory) expandCategory(initialCategory);
  }
  useEffect(() => {
    if (initialCategory) scrollToCategory(initialCategory);
  }, [initialCategory, scrollToCategory]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { category } = (e as CustomEvent<{ category: DocumentCategory }>).detail;
      focusCategory(category);
    };
    window.addEventListener(DOCS_SELECT_CATEGORY_EVENT, handler);
    return () => window.removeEventListener(DOCS_SELECT_CATEGORY_EVENT, handler);
  }, [focusCategory]);

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
  };

  const docMenuItems = (doc: Document): MenuItem[] => [
    { id: 'open', label: 'Open', icon: Icons.document, action: () => onOpenDocument(doc) },
    ...(doc.category === 'mops' ? [
      { id: 'mop-divider', label: '', divider: true, action: () => {} },
      { id: 'download-mop', label: 'Download .mop.json', icon: Icons.download, action: () => { void handleDownloadMop(doc); } },
      { id: 'import-mop', label: 'Import to MOPs', icon: Icons.importArrow, action: () => { void handleImportMopToChanges(doc); } },
    ] : []),
    { id: 'move-divider', label: '', divider: true, action: () => {} },
    {
      id: 'move-to', label: 'Move to', icon: Icons.folder, action: () => {},
      submenu: visibleCategories.filter(c => c !== doc.category).map((cat): MenuItem => ({
        id: `move-${cat}`, label: cat.charAt(0).toUpperCase() + cat.slice(1), action: () => { void handleMoveCategory(doc, cat); },
      })),
    },
    { id: 'delete-divider', label: '', divider: true, action: () => {} },
    { id: 'delete', label: 'Delete', icon: Icons.trash, danger: true, action: () => handleDelete(doc) },
  ];

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
  const documentsByCategory = useMemo(() => {
    const byCategory = new Map<DocumentCategory, Document[]>();
    CATEGORY_ORDER.forEach((category) => {
      byCategory.set(category, []);
    });
    documents.forEach((doc) => {
      byCategory.get(doc.category)?.push(doc);
    });
    return byCategory;
  }, [documents]);

  // Auto-expand categories that have documents (once after first load)
  useEffect(() => {
    if (hasAutoExpanded || loading) return;
    const nonEmpty = CATEGORY_ORDER.filter((cat) => (documentsByCategory.get(cat)?.length ?? 0) > 0);
    // Keep a category focused (Quick Look) before load finished open too.
    const pending = pendingScrollRef.current;
    if (nonEmpty.length > 0 || pending) {
      setExpandedCategories(new Set(pending ? [...nonEmpty, pending] : nonEmpty));
    }
    setHasAutoExpanded(true);
  }, [loading, hasAutoExpanded, documentsByCategory]);

  // Deferred scroll: the section list only renders once loading finishes.
  // Declared after the auto-expand effect so it reads the pending category first.
  useEffect(() => {
    const target = pendingScrollRef.current;
    if (loading || !target) return;
    pendingScrollRef.current = null;
    sectionRefs.current[target]?.scrollIntoView({ block: 'nearest' });
  }, [loading]);

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
    // Default glyph until the lazily-loaded vscode-icons collection is registered.
    const svgName = fileIconsReady ? getIconForFile(lookupName) : undefined;
    const iconName = svgName
      ? `vscode-icons:${svgName.replace(/\.svg$/, '').replace(/_/g, '-')}`
      : DEFAULT_FILE_ICON;
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
        <Tooltip label="Select"><span
          className="docs-item-check"
          onClick={(e) => { e.stopPropagation(); toggleSelect(doc.id); }}
        >
          <input aria-label={`Select ${doc.name}`} type="checkbox" checked={isSel} readOnly tabIndex={-1} />
        </span></Tooltip>
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
      <div
        key={category}
        className="docs-section"
        ref={(el) => { sectionRefs.current[category] = el; }}
      >
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
            <Tooltip label="Encrypted at rest with your vault password"><span
              className="docs-section-lock"
              aria-label="Encrypted at rest"
            >
              {Icons.lock}
            </span></Tooltip>
          )}
          <span className="docs-section-count">{docs.length}</span>
          <span className="docs-section-actions">
            {meta.allowAdd && (
              <Tooltip label={`New ${meta.name.slice(0, -1)}`}><button
                className="ns-btn ns-btn--ghost ns-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenNewForm(category);
                }}
                aria-label={`New ${meta.name.slice(0, -1)}`}
              >
                {Icons.plus}
              </button></Tooltip>
            )}
            {category === 'mops' && (
              <Tooltip label="Import .mop.json file"><button
                className="ns-btn ns-btn--ghost ns-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUploadMopFile();
                }}
                aria-label="Import .mop.json file"
              >
                {Icons.upload}
              </button></Tooltip>
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
        <form ref={newDocFormRef} className="docs-new-form" data-testid="docs-new-form" onSubmit={handleCreateDocument}>
          <div className="docs-new-form-header">
            <span>New Document in {CATEGORIES[newFormCategory]!.name}</span>
          </div>
          <div className="docs-new-form-field">
            <AITabInput
              aria-label="Document name"
              placeholder="Document name..."
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              autoFocus
              disabled={isCreating}
              aiField="document name"
              aiPlaceholder="Short descriptive file name for a new NetStacks document"
              aiContext={{ contentType: newDocContentType, category: newFormCategory }}
              onAIValue={setNewDocName}
            />
          </div>
          <div className="docs-new-form-field">
            <select aria-label="Content type" className="ns-select"
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
          <DialogFooter
            primary={{ label: isCreating ? 'Creating...' : 'Create', onClick: () => newDocFormRef.current?.requestSubmit(), disabled: isCreating || !newDocName.trim() }}
            onCancel={handleCancelNewForm}
            cancelDisabled={isCreating}
            inline
            small
          />
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
            <Tooltip label="Move selected to a folder"><select aria-label="Move selected to a folder"
              className="docs-bulk-move ns-select"
              value=""
              onChange={(e) => {
                if (e.target.value) void moveDocsToCategory(Array.from(selected), e.target.value as DocumentCategory).then(clearSelection);
              }}
            >
              <option value="">Move to…</option>
              {visibleCategories.map((c) => (
                <option key={c} value={c}>{CATEGORIES[c]?.name ?? c}</option>
              ))}
            </select></Tooltip>
            <Tooltip label="Delete selected"><button className="ns-btn ns-btn--danger ns-btn--small" onClick={() => setConfirmBulkDelete(true)}>
              Delete
            </button></Tooltip>
            <Tooltip label="Clear selection"><button className="ns-btn ns-btn--small" onClick={clearSelection}>
              Clear
            </button></Tooltip>
          </div>
        </div>
      )}


      <div className="docs-panel-footer">
        <Tooltip label="Refresh"><button
          className="ns-btn ns-btn--ghost ns-icon-btn"
          onClick={fetchDocuments}
          aria-label="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button></Tooltip>
      </div>

      <ContextMenu
        position={contextMenu}
        items={contextMenu ? docMenuItems(contextMenu.doc) : []}
        onClose={() => setContextMenu(null)}
      />

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
        <ModalFrame id="docs-delete" onDismiss={() => setConfirmDelete(null)} resizable={false} className="docs-delete-dialog" label="Delete document">
          <h3 style={{ marginTop: 0, marginBottom: '12px', color: 'var(--color-text-primary)' }}>
            Delete Document
          </h3>
          <p style={{ marginBottom: '20px', color: 'var(--color-text-secondary)' }}>
            Are you sure you want to delete "{confirmDelete.name}"? This action cannot be undone.
          </p>
          <DialogFooter primary={{ label: 'Delete', onClick: handleConfirmDelete, danger: true }} onCancel={() => setConfirmDelete(null)} inline />
        </ModalFrame>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      {confirmBulkDelete && (
        <ModalFrame id="docs-bulk-delete" onDismiss={() => setConfirmBulkDelete(false)} resizable={false} className="docs-delete-dialog" label="Delete documents">
          <h3 style={{ marginTop: 0, marginBottom: '12px', color: 'var(--color-text-primary)' }}>
            Delete {selected.size} document{selected.size === 1 ? '' : 's'}
          </h3>
          <p style={{ marginBottom: '20px', color: 'var(--color-text-secondary)' }}>
            Are you sure you want to delete {selected.size} selected document{selected.size === 1 ? '' : 's'}? This action cannot be undone.
          </p>
          <DialogFooter primary={{ label: `Delete ${selected.size}`, onClick: handleBulkDelete, danger: true }} onCancel={() => setConfirmBulkDelete(false)} inline />
        </ModalFrame>
      )}
    </div>
  );
}

export default DocsPanel;
