import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useEditorFontSettings } from '../hooks/useEditorFontSettings';
import './DocumentTabEditor.css';
import CsvViewer from './CsvViewer';
import JsonViewer from './JsonViewer';
import JinjaViewer from './JinjaViewer';
import MarkdownViewer from './MarkdownViewer';
import RecordingPlayer from './RecordingPlayer';
import { TemplateRenderModal } from './TemplateRenderModal';
import type { Document } from '../api/docs';
import { sendChatMessage } from '../api/ai';
import { resolveProvider } from '../lib/aiProviderResolver';
import { useMonacoOverlord } from '../hooks/useMonacoOverlord';
import MonacoOverlordWidget from './MonacoOverlordWidget';

import { getErrorMessage } from '../api/errors'
interface DocumentTabEditorProps {
  document: Document;
  tabId?: string; // Tab ID for matching save events
  onSave: (content: string) => Promise<void>;
  onModified: (isModified: boolean) => void;
}

// Icons
const Icons = {
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  cancel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  view: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  markdown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8v8l3-3 3 3V8" />
      <path d="M18 12l-3-3v6" />
    </svg>
  ),
  render: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  aiEnhance: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
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

// Check if content looks like markdown (has markdown syntax)
function looksLikeMarkdown(content: string): boolean {
  // Check for common markdown patterns
  const mdPatterns = [
    /^#{1,6}\s+/m,           // Headers
    /\*\*[^*]+\*\*/,         // Bold
    /\*[^*]+\*/,             // Italic
    /^\s*[-*+]\s+/m,         // Unordered lists
    /^\s*\d+\.\s+/m,         // Ordered lists
    /\[.+\]\(.+\)/,          // Links
    /```[\s\S]*?```/,        // Code blocks
    /^\|.+\|$/m,             // Tables
    /^>\s+/m,                // Blockquotes
  ];
  return mdPatterns.some(pattern => pattern.test(content));
}

// Count lines in content
function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

function DocumentTabEditor({ document, tabId, onSave, onModified }: DocumentTabEditorProps) {
  const overlord = useMonacoOverlord();
  const editorFont = useEditorFontSettings();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(document.content);
  const [isSaving, setIsSaving] = useState(false);
  const [originalContent, setOriginalContent] = useState(document.content);
  const [showRaw, setShowRaw] = useState(false);
  const [showRenderModal, setShowRenderModal] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  // Check if this is a Jinja template
  const isJinjaTemplate = document.content_type === 'jinja';

  // Check if content is editable (text-based content types, not recordings)
  const isEditable = ['text', 'json', 'jinja', 'config', 'csv', 'markdown'].includes(document.content_type);

  // Parse recording reference if this is a recording document
  const recordingRef = useMemo(() => {
    if (document.content_type !== 'recording') return null;
    try {
      return JSON.parse(document.content) as { recording_id: string; name: string; duration_ms: number };
    } catch {
      return null;
    }
  }, [document.content, document.content_type]);

  // Check if content should be rendered as markdown
  const isMarkdownContent = useMemo(() => {
    // Explicit markdown content type
    if (document.content_type === 'markdown') return true;
    // Text content that looks like markdown (auto-detect)
    if (document.content_type === 'text' && looksLikeMarkdown(editContent)) return true;
    return false;
  }, [document.content_type, editContent]);

  // Track if content has been modified
  const isModified = editContent !== originalContent;

  // Use ref to avoid infinite loops from callback reference changes
  const onModifiedRef = useRef(onModified);
  onModifiedRef.current = onModified;

  // Notify parent of modified state changes
  useEffect(() => {
    onModifiedRef.current(isModified);
  }, [isModified]);

  // Update content when document changes (e.g., external save)
  useEffect(() => {
    setEditContent(document.content);
    setOriginalContent(document.content);
  }, [document.content]);

  // Line count for footer
  const lineCount = useMemo(() => countLines(editContent), [editContent]);

  // Handle edit mode toggle
  const handleEditToggle = useCallback(() => {
    if (isEditing) {
      // Cancel editing - restore original content
      setEditContent(originalContent);
      setIsEditing(false);
    } else {
      setIsEditing(true);
    }
  }, [isEditing, originalContent]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!isModified) return;

    setIsSaving(true);
    try {
      await onSave(editContent);
      setOriginalContent(editContent);
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to save document:', err);
      // Keep editing mode open on error
    } finally {
      setIsSaving(false);
    }
  }, [editContent, isModified, onSave]);

  // Listen for global save events from useKeyboard hook
  useEffect(() => {
    const handleSaveEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string }>;
      // Only respond if this is the active tab
      if (tabId && customEvent.detail.tabId === tabId && isModified && !isSaving) {
        handleSave();
      }
    };

    window.addEventListener('netstacks:save-document', handleSaveEvent);
    return () => window.removeEventListener('netstacks:save-document', handleSaveEvent);
  }, [tabId, handleSave, isModified, isSaving]);

  // AI Enhance - send content to AI for enrichment, then auto-save
  const handleAIEnhance = useCallback(async () => {
    setIsEnhancing(true);
    setEnhanceError(null);
    try {
      const isTroubleshooting = document.category === 'troubleshooting';
      const prompt = isTroubleshooting
        ? `You are a network troubleshooting documentation specialist. Analyze the raw session data below and produce a comprehensive, well-structured markdown document. Include:
- Executive summary of the troubleshooting session (2-3 sentences)
- Key findings and issues identified (bullet points)
- Actions taken table (Time | Device | Command | Purpose) - only significant commands
- Resolution status and next steps
- Recommendations
- Keep all factual data accurate — do not invent data not present in the input
- Clean up ANSI escape codes and terminal artifacts from the raw log
- Output ONLY the markdown document, no preamble or explanation

Here is the session data to analyze:

${editContent}`
        : `You are a network documentation specialist. Analyze the content below and produce a comprehensive, well-structured markdown document. Include:
- Clear section headings and organization
- Key insights and analysis
- Recommendations where applicable
- Keep all factual data accurate — do not invent data not present in the input
- Output ONLY the markdown document, no preamble or explanation

Here is the content to enhance:

${editContent}`;

      const { provider, model } = resolveProvider();
      const aiResponse = await sendChatMessage(
        [{ role: 'user', content: prompt }],
        { provider, model }
      );

      if (!aiResponse) {
        throw new Error('AI returned empty response');
      }

      // Update content with AI response
      setEditContent(aiResponse);

      // Auto-save the enhanced content
      await onSave(aiResponse);
      setOriginalContent(aiResponse);
    } catch (err) {
      setEnhanceError(getErrorMessage(err, 'AI enhancement failed'));
    } finally {
      setIsEnhancing(false);
    }
  }, [editContent, document.category, onSave]);

  // Render content based on content_type
  const renderContent = () => {
    // Recording content renders the RecordingPlayer
    if (document.content_type === 'recording' && recordingRef) {
      return <RecordingPlayer recordingId={recordingRef.recording_id} />;
    }

    // If editing, show Monaco editor with Cmd+I overlord
    if (isEditing) {
      const monacoLang = document.content_type === 'json' ? 'json'
        : document.content_type === 'jinja' ? 'jinja'
        : document.content_type === 'csv' ? 'plaintext'
        : document.content_type === 'markdown' ? 'markdown'
        : 'plaintext';
      return (
        <div className="doc-tab-edit-viewer">
          <Editor
            height="100%"
            language={monacoLang}
            value={editContent}
            onChange={(v) => setEditContent(v || '')}
            onMount={(editor) => overlord.register(editor)}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              lineNumbers: 'on',
              wordWrap: 'on',
              // fontSize / fontFamily honor Settings → Appearance.
              ...editorFont,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12, bottom: 12 },
            }}
          />
          {overlord.isOpen && overlord.widgetPosition && (
            <MonacoOverlordWidget
              position={overlord.widgetPosition}
              onSubmit={overlord.handleSubmit}
              onCancel={overlord.close}
              loading={overlord.loading}
              error={overlord.error}
            />
          )}
          {overlord.hasPendingEdit && (
            <div className="overlord-accept-bar">
              <span>AI edit applied — review the highlighted changes</span>
              <button className="overlord-accept-btn" onClick={overlord.accept}>Accept</button>
              <button className="overlord-reject-btn" onClick={overlord.reject}>Reject</button>
            </div>
          )}
        </div>
      );
    }

    // View mode - render based on content type
    switch (document.content_type) {
      case 'csv':
        return <CsvViewer content={editContent} filename={document.name} />;
      case 'json':
        return <JsonViewer content={editContent} filename={document.name} />;
      case 'jinja':
        return <JinjaViewer content={editContent} filename={document.name} />;
      case 'markdown':
        // Markdown: show rendered or raw based on toggle
        if (showRaw) {
          return (
            <div className="doc-tab-text-viewer">
              <pre>{editContent}</pre>
            </div>
          );
        }
        return (
          <div className="doc-tab-markdown-viewer">
            <MarkdownViewer content={editContent} />
          </div>
        );
      case 'config':
      case 'text':
      default:
        // Text: if it looks like markdown and not showing raw, render as markdown
        if (isMarkdownContent && !showRaw) {
          return (
            <div className="doc-tab-markdown-viewer">
              <MarkdownViewer content={editContent} />
            </div>
          );
        }
        return (
          <div className="doc-tab-text-viewer">
            <pre>{editContent}</pre>
          </div>
        );
    }
  };

  return (
    <div className="doc-tab-editor" data-testid="document-editor">
      {/* Header toolbar */}
      <div className="doc-tab-editor-header">
        <div className="doc-tab-editor-title">
          <span className="doc-tab-editor-name" title={document.name}>
            {document.name}
          </span>
          <span className={`doc-tab-editor-badge ${document.category}`}>
            {document.category}
          </span>
          <span className={`doc-tab-editor-badge content-type ${getContentTypeBadge(document.content_type).className}`}>
            {getContentTypeBadge(document.content_type).label}
          </span>
          {isEditing && (
            <span className="doc-tab-editor-badge editing">Editing</span>
          )}
          {isModified && !isEditing && (
            <span className="doc-tab-editor-badge modified">Modified</span>
          )}
        </div>

        <div className="doc-tab-editor-actions">
          {/* Save button - only shown when modified */}
          {isModified && (
            <button
              className="doc-tab-editor-btn primary"
              onClick={handleSave}
              disabled={isSaving}
              title="Save (Cmd+S)"
            >
              {Icons.save}
              <span>{isSaving ? 'Saving...' : 'Save'}</span>
            </button>
          )}

          {/* AI Enhance button - shown for markdown/text content when not editing.
              Hidden for Secure Notes so private content never leaves the vault for an AI provider. */}
          {isEditable && !isEditing && !isEnhancing && document.content_type !== 'csv' && document.content_type !== 'json' && document.category !== 'notes' && (
            <button
              className="doc-tab-editor-btn ai-enhance"
              onClick={handleAIEnhance}
              title="Use AI to analyze and enhance this document"
            >
              {Icons.aiEnhance}
              <span>AI Enhance</span>
            </button>
          )}
          {isEnhancing && (
            <span className="doc-tab-editor-badge enhancing">AI Enhancing...</span>
          )}

          {/* Render button - only shown for Jinja templates when not editing */}
          {isJinjaTemplate && !isEditing && (
            <button
              className="doc-tab-editor-btn render"
              onClick={() => setShowRenderModal(true)}
              title="Render Template"
            >
              {Icons.render}
              <span>Render</span>
            </button>
          )}

          {/* Markdown/Raw toggle - only shown for markdown content when not editing */}
          {isMarkdownContent && !isEditing && (
            <button
              className={`doc-tab-editor-btn ${showRaw ? '' : 'active'}`}
              onClick={() => setShowRaw(!showRaw)}
              title={showRaw ? 'Show Rendered Markdown' : 'Show Raw Text'}
            >
              {showRaw ? Icons.markdown : Icons.code}
              <span>{showRaw ? 'Rendered' : 'Raw'}</span>
            </button>
          )}

          {/* Edit/View toggle */}
          {isEditable && (
            <button
              className={`doc-tab-editor-btn ${isEditing ? 'active' : ''}`}
              onClick={handleEditToggle}
              title={isEditing ? 'Cancel Edit' : 'Edit Document'}
              disabled={isSaving}
            >
              {isEditing ? Icons.view : Icons.edit}
              <span>{isEditing ? 'View' : 'Edit'}</span>
            </button>
          )}
        </div>
      </div>

      {/* AI enhance error banner */}
      {enhanceError && (
        <div className="doc-tab-editor-error-banner" onClick={() => setEnhanceError(null)}>
          {enhanceError}
          <span className="doc-tab-editor-error-dismiss">Dismiss</span>
        </div>
      )}

      {/* Content area */}
      <div className="doc-tab-editor-content">
        {renderContent()}
      </div>

      {/* Footer with stats (hidden for recordings which have their own controls) */}
      {document.content_type !== 'recording' && (
      <div className="doc-tab-editor-footer">
        <span className="doc-tab-editor-stats">
          {lineCount} line{lineCount !== 1 ? 's' : ''}
        </span>
        <span className="doc-tab-editor-stats">
          {editContent.length} character{editContent.length !== 1 ? 's' : ''}
        </span>
        {isModified && (
          <span className="doc-tab-editor-status modified">
            Unsaved changes <kbd>Cmd+S</kbd>
          </span>
        )}
      </div>
      )}

      {/* Template Render Modal */}
      <TemplateRenderModal
        isOpen={showRenderModal}
        onClose={() => setShowRenderModal(false)}
        documentId={document.id}
        documentName={document.name}
        templateContent={editContent}
      />
    </div>
  );
}

export default DocumentTabEditor;
