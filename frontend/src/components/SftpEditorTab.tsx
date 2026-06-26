import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { sftpDownload, sftpUpload } from '../api/sftp';
import { confirmDialog } from './ConfirmDialog';
import './SftpEditorTab.css';

import { getErrorMessage } from '../api/errors'
interface SftpEditorTabProps {
  connectionId: string;
  filePath: string;
  fileName: string;
  deviceName: string;
  onDirtyChange: (isDirty: boolean) => void;
}

// Inline SVG icons matching the app pattern
const Icons = {
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  reload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  ),
};

export default function SftpEditorTab({
  connectionId,
  filePath,
  fileName,
  deviceName,
  onDirtyChange,
}: SftpEditorTabProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const isDirtyRef = useRef(false);

  const isDirty = content !== originalContent;

  // Track dirty state changes and notify parent
  useEffect(() => {
    if (isDirty !== isDirtyRef.current) {
      isDirtyRef.current = isDirty;
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  // Download file on mount
  const loadFile = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setError(null);
    try {
      const blob = await sftpDownload(connectionId, filePath);
      const text = await blob.text();
      setContent(text);
      setOriginalContent(text);
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to download file');
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [connectionId, filePath]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  // Save file
  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const blob = new Blob([content], { type: 'application/octet-stream' });
      await sftpUpload(connectionId, filePath, blob);
      setOriginalContent(content);
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to upload file');
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [connectionId, filePath, content, isDirty, saving]);

  // Reload file
  const handleReload = useCallback(async () => {
    if (isDirty) {
      const confirmed = await confirmDialog({
        title: 'Discard unsaved changes?',
        body: 'Reloading will overwrite your local edits with the remote file.',
        confirmLabel: 'Discard and reload',
        destructive: true,
      });
      if (!confirmed) return;
    }
    await loadFile();
  }, [isDirty, loadFile]);

  // Keyboard shortcut: Cmd+S / Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Tab key inserts 2 spaces
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = content.substring(0, start) + '  ' + content.substring(end);
      setContent(newContent);
      // Restore cursor position after React re-renders
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 2;
        textarea.selectionEnd = start + 2;
      });
    }
  }, [content]);

  // Sync gutter scroll with textarea
  const handleScroll = useCallback(() => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  // Line numbers
  const lineCount = useMemo(() => {
    const lines = content.split('\n').length;
    return Math.max(lines, 1);
  }, [content]);

  const lineNumbers = useMemo(() => {
    return Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');
  }, [lineCount]);

  // Character count
  const charCount = content.length;

  // Cursor position tracking
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);

  const handleSelect = useCallback(() => {
    if (textareaRef.current) {
      const pos = textareaRef.current.selectionStart;
      const textBefore = content.substring(0, pos);
      const lines = textBefore.split('\n');
      setCursorLine(lines.length);
      setCursorCol(lines[lines.length - 1].length + 1);
    }
  }, [content]);

  // Loading state
  if (loading) {
    return (
      <div className="sftp-editor">
        <div className="sftp-editor-loading">
          <div className="sftp-editor-spinner" />
          <span>Loading {fileName}...</span>
        </div>
      </div>
    );
  }

  // Load error state
  if (loadError) {
    return (
      <div className="sftp-editor">
        <div className="sftp-editor-load-error">
          <div className="sftp-editor-load-error-message">{loadError}</div>
          <button onClick={loadFile}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sftp-editor">
      {/* Toolbar */}
      <div className="sftp-editor-toolbar">
        <div className="sftp-editor-path">
          <span className="sftp-editor-path-text">
            {deviceName}:{filePath}
          </span>
          {isDirty && !saving && (
            <span className="sftp-editor-badge modified">Modified</span>
          )}
          {saving && (
            <span className="sftp-editor-badge saving">Saving...</span>
          )}
        </div>
        <div className="sftp-editor-actions">
          <button
            className="sftp-editor-btn primary"
            onClick={handleSave}
            disabled={!isDirty || saving}
            title="Save (Cmd+S)"
          >
            {Icons.save}
            Save
          </button>
          <button
            className="sftp-editor-btn"
            onClick={handleReload}
            disabled={saving}
            title="Reload from server"
          >
            {Icons.reload}
            Reload
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="sftp-editor-error">
          <span>{error}</span>
          <button
            className="sftp-editor-error-dismiss"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Editor body */}
      <div className="sftp-editor-body">
        <div className="sftp-editor-gutter" ref={gutterRef}>
          <div className="sftp-editor-line-numbers">{lineNumbers}</div>
        </div>
        <textarea
          ref={textareaRef}
          className="sftp-editor-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onClick={handleSelect}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
        />
      </div>

      {/* Status bar */}
      <div className="sftp-editor-footer">
        <div className="sftp-editor-stats">
          <span>{lineCount} lines</span>
          <span>{charCount} characters</span>
          <span>Ln {cursorLine}, Col {cursorCol}</span>
        </div>
        <span className={`sftp-editor-status ${isDirty ? 'modified' : 'saved'}`}>
          {isDirty ? 'Unsaved changes' : 'Saved'}
        </span>
      </div>
    </div>
  );
}
