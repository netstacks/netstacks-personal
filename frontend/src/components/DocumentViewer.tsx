import { useState, useCallback, useMemo } from 'react';
import './DocumentViewer.css';
import CsvViewer from './CsvViewer';
import JsonViewer from './JsonViewer';
import JinjaViewer from './JinjaViewer';
import MarkdownViewer from './MarkdownViewer';
import RecordingPlayer from './RecordingPlayer';
import type { Document, DocumentVersionMeta, DocumentVersion } from '../api/docs';
import { listVersions, getVersion, restoreVersion, updateDocument, deleteDocument } from '../api/docs';
import { confirmDialog } from './ConfirmDialog';
import { showToast } from './Toast';
import { downloadFile } from '../lib/formatters';

import { getErrorMessage } from '../api/errors'
interface DocumentViewerProps {
  document: Document;
  onClose: () => void;
  onDocumentUpdate?: (doc: Document) => void;
}

// Icons
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  restore: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  ),
  cancel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
};

// Get content type badge info
function getContentTypeBadge(contentType: string): { label: string; className: string } {
  switch (contentType) {
    case 'json':
      return { label: 'JSON', className: 'content-type-json' };
    case 'csv':
      return { label: 'CSV', className: 'content-type-csv' };
    case 'jinja':
      return { label: 'Jinja2', className: 'content-type-jinja' };
    case 'config':
      return { label: 'Config', className: 'content-type-config' };
    case 'markdown':
      return { label: 'Markdown', className: 'content-type-markdown' };
    case 'recording':
      return { label: 'Recording', className: 'content-type-recording' };
    case 'text':
    default:
      return { label: 'Text', className: 'content-type-text' };
  }
}

// Format relative time for display
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function DocumentViewer({ document, onClose, onDocumentUpdate }: DocumentViewerProps) {
  // Edit mode state (reserved for future inline editing)
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(document.content ?? '');
  const [isSaving, setIsSaving] = useState(false);

  // History panel state
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<DocumentVersionMeta[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<DocumentVersion | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(false);

  // Check if content is editable (text-based content types, not recordings)
  const isEditable = ['text', 'json', 'jinja', 'config', 'csv', 'markdown'].includes(document.content_type);

  // Check if content is markdown (by content_type or file extension)
  const isMarkdown = document.content_type === 'markdown' || document.name.endsWith('.md');

  // Parse recording reference if this is a recording document
  const recordingRef = useMemo(() => {
    if (document.content_type !== 'recording') return null;
    try {
      return JSON.parse(document.content) as { recording_id: string; name: string; duration_ms: number };
    } catch {
      return null;
    }
  }, [document.content, document.content_type]);

  // Fetch versions when history panel opens
  const handleShowHistory = useCallback(async () => {
    if (showHistory) {
      setShowHistory(false);
      setSelectedVersion(null);
      return;
    }

    setShowHistory(true);
    setLoadingVersions(true);
    try {
      const vers = await listVersions(document.id);
      setVersions(vers);
    } catch (err) {
      console.error('Failed to load versions:', err);
    } finally {
      setLoadingVersions(false);
    }
  }, [showHistory, document.id]);

  // Select a version to preview
  const handleSelectVersion = useCallback(async (versionMeta: DocumentVersionMeta) => {
    setLoadingVersion(true);
    try {
      const fullVersion = await getVersion(versionMeta.id);
      setSelectedVersion(fullVersion);
    } catch (err) {
      console.error('Failed to load version:', err);
    } finally {
      setLoadingVersion(false);
    }
  }, []);

  // Restore selected version
  const handleRestoreVersion = useCallback(async () => {
    if (!selectedVersion) return;

    setRestoringVersion(true);
    try {
      const updatedDoc = await restoreVersion(document.id, selectedVersion.id);
      // Notify parent of update
      onDocumentUpdate?.(updatedDoc);
      // Refresh versions list
      const vers = await listVersions(document.id);
      setVersions(vers);
      setSelectedVersion(null);
    } catch (err) {
      console.error('Failed to restore version:', err);
    } finally {
      setRestoringVersion(false);
    }
  }, [document.id, selectedVersion, onDocumentUpdate]);

  // Handle edit mode toggle
  const handleEditToggle = useCallback(() => {
    if (isEditing) {
      setEditContent(document.content);
      setIsEditing(false);
    } else {
      setEditContent(document.content);
      setIsEditing(true);
    }
  }, [isEditing, document.content]);

  // Handle save document
  const handleSave = useCallback(async () => {
    if (!isEditing) return;

    setIsSaving(true);
    try {
      const updatedDoc = await updateDocument(document.id, { content: editContent });
      onDocumentUpdate?.(updatedDoc);
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to save document:', err);
    } finally {
      setIsSaving(false);
    }
  }, [document.id, editContent, isEditing, onDocumentUpdate]);

  // Handle cancel editing
  const handleCancelEdit = useCallback(() => {
    setEditContent(document.content);
    setIsEditing(false);
  }, [document.content]);

  const handleDownload = () => {
    downloadFile(document.content, document.name, 'text/plain');
  };

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: 'Delete document?',
      body: (
        <>
          Permanently delete <strong>{document.name}</strong>? Version
          history is removed and cannot be recovered.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteDocument(document.id);
      showToast(`Deleted "${document.name}"`, 'success');
      onClose();
    } catch (e) {
      showToast(getErrorMessage(e, 'Failed to delete document'), 'error');
    }
  };

  // Render content based on content_type
  const renderContent = (content: string = document.content) => {
    // Recording content renders the RecordingPlayer
    if (document.content_type === 'recording' && recordingRef) {
      return <RecordingPlayer recordingId={recordingRef.recording_id} />;
    }

    // Markdown content uses MarkdownViewer with its own edit mode
    if (isMarkdown) {
      return (
        <MarkdownViewer
          content={isEditing ? editContent : content}
          isEditing={isEditing}
          onChange={setEditContent}
          onSave={handleSave}
          onCancel={handleCancelEdit}
        />
      );
    }

    // If editing (non-markdown), show textarea instead of formatted view
    if (isEditing) {
      return (
        <div className="edit-viewer">
          <textarea
            className="edit-textarea"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      );
    }

    switch (document.content_type) {
      case 'csv':
        return <CsvViewer content={content} filename={document.name} />;
      case 'json':
        return <JsonViewer content={content} filename={document.name} />;
      case 'jinja':
        return <JinjaViewer content={content} filename={document.name} />;
      case 'config':
      case 'text':
      default:
        return (
          <div className="text-viewer">
            <pre>{content}</pre>
          </div>
        );
    }
  };

  return (
    <div className="document-viewer-overlay" onClick={onClose}>
      <div className="document-viewer" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="document-viewer-header">
          <div className="document-viewer-title">
            <span className="document-viewer-name" title={document.name}>
              {document.name}
            </span>
            <span className={`document-viewer-badge ${document.category}`}>
              {document.category}
            </span>
            <span className={`document-viewer-badge content-type ${getContentTypeBadge(document.content_type).className}`}>
              {getContentTypeBadge(document.content_type).label}
            </span>
            {isEditing && (
              <span className="document-viewer-badge editing">Editing</span>
            )}
          </div>
          {isEditable && (
            <button
              className={`document-viewer-header-btn ${isEditing ? 'active' : ''}`}
              onClick={handleEditToggle}
              title={isEditing ? 'Cancel Edit' : 'Edit Document'}
              disabled={!!selectedVersion}
            >
              {isEditing ? Icons.cancel : Icons.edit}
            </button>
          )}
          <button
            className={`document-viewer-header-btn ${showHistory ? 'active' : ''}`}
            onClick={handleShowHistory}
            title="Version History"
            disabled={isEditing}
          >
            {Icons.history}
          </button>
          <button
            className="document-viewer-close"
            onClick={onClose}
            title="Close"
          >
            {Icons.close}
          </button>
        </div>

        {/* Main content area with optional history sidebar */}
        <div className={`document-viewer-body ${showHistory ? 'with-history' : ''}`}>
          {/* Content */}
          <div className="document-viewer-content">
            {selectedVersion ? (
              <div className="version-preview">
                <div className="version-preview-header">
                  <button
                    className="version-preview-back"
                    onClick={() => setSelectedVersion(null)}
                    title="Back to list"
                  >
                    {Icons.back}
                    <span>Back</span>
                  </button>
                  <span className="version-preview-label">
                    Preview: {formatRelativeTime(selectedVersion.created_at)}
                  </span>
                  <button
                    className="version-preview-restore"
                    onClick={handleRestoreVersion}
                    disabled={restoringVersion}
                    title="Restore this version"
                  >
                    {Icons.restore}
                    <span>{restoringVersion ? 'Restoring...' : 'Restore'}</span>
                  </button>
                </div>
                <div className="version-preview-content">
                  {renderContent(selectedVersion.content)}
                </div>
              </div>
            ) : (
              renderContent()
            )}
          </div>

          {/* History sidebar */}
          {showHistory && (
            <div className="document-viewer-history">
              <div className="history-header">
                <h3>Version History</h3>
              </div>
              <div className="history-list">
                {loadingVersions ? (
                  <div className="history-loading">Loading versions...</div>
                ) : versions.length === 0 ? (
                  <div className="history-empty">No previous versions</div>
                ) : (
                  versions.map((version) => (
                    <button
                      key={version.id}
                      className={`history-item ${
                        selectedVersion?.id === version.id ? 'selected' : ''
                      } ${loadingVersion ? 'loading' : ''}`}
                      onClick={() => handleSelectVersion(version)}
                      disabled={loadingVersion}
                    >
                      <span className="history-item-time">
                        {formatRelativeTime(version.created_at)}
                      </span>
                      <span className="history-item-date">
                        {new Date(version.created_at).toLocaleString()}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions - changes based on edit mode */}
        {!selectedVersion && (
          <div className="document-viewer-actions">
            {isEditing ? (
              <>
                <button
                  className="document-viewer-btn primary"
                  onClick={handleSave}
                  disabled={isSaving}
                  title="Save changes"
                >
                  {Icons.save}
                  <span>{isSaving ? 'Saving...' : 'Save'}</span>
                </button>
                <button
                  className="document-viewer-btn"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  title="Cancel editing"
                >
                  {Icons.cancel}
                  <span>Cancel</span>
                </button>
              </>
            ) : (
              <>
                <button
                  className="document-viewer-btn"
                  onClick={handleDownload}
                  title="Download file"
                >
                  {Icons.download}
                  <span>Download</span>
                </button>
                <button
                  className="document-viewer-btn danger"
                  onClick={handleDelete}
                  title="Delete document"
                >
                  {Icons.trash}
                  <span>Delete</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default DocumentViewer;
