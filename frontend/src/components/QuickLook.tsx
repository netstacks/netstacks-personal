import { useState, useCallback, useEffect, useRef } from 'react';
import './QuickLook.css';
import CsvViewer from './CsvViewer';
import JsonViewer from './JsonViewer';
import JinjaViewer from './JinjaViewer';
import type { Document, DocumentCategory } from '../api/docs';

// Icons
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  openInTab: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  ),
  cancel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
};

// Category badge info mapping
const CATEGORY_BADGES: Record<DocumentCategory, { label: string; className: string }> = {
  notes: { label: 'Note', className: 'category-notes' },
  templates: { label: 'Template', className: 'category-templates' },
  outputs: { label: 'Output', className: 'category-outputs' },
  backups: { label: 'Backup', className: 'category-backups' },
  history: { label: 'History', className: 'category-history' },
  troubleshooting: { label: 'Troubleshooting', className: 'category-troubleshooting' },
  mops: { label: 'MOP', className: 'category-mops' },
}

function getCategoryBadge(category: DocumentCategory): { label: string; className: string } {
  return CATEGORY_BADGES[category] || { label: 'Document', className: '' }
}

export interface QuickLookProps {
  /** Document to display (if null, loads most recent from category) */
  document: Document | null;
  /** Category for "most recent" lookup when document is null */
  category: DocumentCategory;
  /** Called when Quick Look should close */
  onClose: () => void;
  /** Called when user wants to open document in a tab */
  onOpenInTab: (doc: Document) => void;
  /** Called when user saves edits */
  onSave?: (content: string) => Promise<void>;
}

export default function QuickLook({
  document,
  category,
  onClose,
  onOpenInTab,
  onSave,
}: QuickLookProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(document?.content || '');
  const [isSaving, setIsSaving] = useState(false);
  const quickLookRef = useRef<HTMLDivElement>(null);

  // Update edit content when document changes
  useEffect(() => {
    if (document) {
      setEditContent(document.content);
    }
  }, [document]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (quickLookRef.current && !quickLookRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    // Delay adding listener to avoid immediate close from triggering click
    const timer = setTimeout(() => {
      document && window.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [document, onClose]);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Handle edit toggle
  const handleEditToggle = useCallback(() => {
    if (isEditing) {
      // Cancel edit - restore original content
      setEditContent(document?.content || '');
      setIsEditing(false);
    } else {
      setIsEditing(true);
    }
  }, [isEditing, document]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!onSave || !document) return;

    setIsSaving(true);
    try {
      await onSave(editContent);
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setIsSaving(false);
    }
  }, [editContent, onSave, document]);

  // Handle open in tab
  const handleOpenInTab = useCallback(() => {
    if (document) {
      onOpenInTab(document);
    }
  }, [document, onOpenInTab]);

  // Render content based on content_type
  const renderContent = () => {
    if (!document) {
      return (
        <div className="quicklook-empty">
          <p>No {category} documents</p>
        </div>
      );
    }

    // If editing, show textarea
    if (isEditing) {
      return (
        <div className="quicklook-edit">
          <textarea
            className="quicklook-edit-textarea"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      );
    }

    // Otherwise render appropriate viewer
    switch (document.content_type) {
      case 'csv':
        return <CsvViewer content={document.content} filename={document.name} />;
      case 'json':
        return <JsonViewer content={document.content} filename={document.name} />;
      case 'jinja':
        return <JinjaViewer content={document.content} filename={document.name} />;
      case 'config':
      case 'text':
      default:
        return (
          <div className="quicklook-text">
            <pre>{document.content}</pre>
          </div>
        );
    }
  };

  const categoryBadge = getCategoryBadge(category);
  const isEditable = document && ['text', 'json', 'jinja', 'config', 'csv'].includes(document.content_type);

  return (
    <div className="quicklook-container">
      <div className="quicklook" ref={quickLookRef}>
        {/* Header */}
        <div className="quicklook-header">
          <div className="quicklook-title">
            <span className="quicklook-name" title={document?.name || `No ${category}`}>
              {document?.name || `No ${category}`}
            </span>
            <span className={`quicklook-badge ${categoryBadge.className}`}>
              {categoryBadge.label}
            </span>
            {isEditing && (
              <span className="quicklook-badge quicklook-badge-editing">Editing</span>
            )}
          </div>
          <div className="quicklook-header-actions">
            {document && isEditable && (
              <button
                className={`quicklook-header-btn ${isEditing ? 'active' : ''}`}
                onClick={handleEditToggle}
                title={isEditing ? 'Cancel Edit' : 'Quick Edit'}
              >
                {isEditing ? Icons.cancel : Icons.edit}
              </button>
            )}
            <button
              className="quicklook-header-btn quicklook-close-btn"
              onClick={onClose}
              title="Close (Esc)"
            >
              {Icons.close}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="quicklook-content">
          {renderContent()}
        </div>

        {/* Footer Actions */}
        {document && (
          <div className="quicklook-footer">
            {isEditing ? (
              <>
                <button
                  className="quicklook-btn quicklook-btn-primary"
                  onClick={handleSave}
                  disabled={isSaving}
                  title="Save changes"
                >
                  {Icons.save}
                  <span>{isSaving ? 'Saving...' : 'Save'}</span>
                </button>
                <button
                  className="quicklook-btn"
                  onClick={handleEditToggle}
                  disabled={isSaving}
                  title="Cancel editing"
                >
                  {Icons.cancel}
                  <span>Cancel</span>
                </button>
              </>
            ) : (
              <button
                className="quicklook-btn quicklook-btn-primary"
                onClick={handleOpenInTab}
                title="Open in Tab"
              >
                {Icons.openInTab}
                <span>Open in Tab</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
