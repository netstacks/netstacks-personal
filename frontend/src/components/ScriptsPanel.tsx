import { useState, useEffect, useCallback } from 'react';
import './ScriptsPanel.css';
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition';
import { listScripts, getScript, deleteScript, type Script } from '../api/scripts';

import { getErrorMessage } from '../api/errors'
interface ScriptsPanelProps {
  onOpenScript: (script: Script) => void;
  onNewScript: () => void;
  onAIGenerate: () => void;
}

// Icons
const Icons = {
  script: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10 12l-2 2 2 2" />
      <path d="M14 12l2 2-2 2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 2a10 10 0 0110 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="15" cy="10" r="1" fill="currentColor" />
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
  template: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  ),
};

function ScriptsPanel({ onOpenScript, onNewScript, onAIGenerate }: ScriptsPanelProps) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; scriptId: string } | null>(null);
  const { ref: contextMenuRef, style: contextMenuStyle } = useClampedMenuPosition(contextMenu);

  const fetchScripts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listScripts();
      setScripts(data);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load scripts'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScripts();
  }, [fetchScripts]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, scriptId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, scriptId });
  };

  const handleOpenScript = async (script: Script) => {
    // If content is empty, fetch full script (enterprise list doesn't include parameters)
    if (!script.content) {
      try {
        const full = await getScript(script.id);
        onOpenScript(full);
      } catch {
        onOpenScript(script);
      }
    } else {
      onOpenScript(script);
    }
  };

  const handleDelete = async (scriptId: string) => {
    try {
      await deleteScript(scriptId);
      setScripts(prev => prev.filter(s => s.id !== scriptId));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete script'));
    }
    setContextMenu(null);
  };

  // Categorize scripts
  const myScripts = scripts.filter(s => !s.is_template);
  const templateScripts = scripts.filter(s => s.is_template);

  const renderScript = (script: Script) => (
    <div
      key={script.id}
      className="scripts-item"
      onClick={() => handleOpenScript(script)}
      onContextMenu={(e) => handleContextMenu(e, script.id)}
      title={script.name}
    >
      <span className="scripts-item-icon">
        {script.is_template ? Icons.template : Icons.script}
      </span>
      <span className="scripts-item-name">{script.name}</span>
    </div>
  );

  return (
    <div className="scripts-panel">
      <div className="scripts-panel-toolbar">
        <button
          className="scripts-panel-btn primary"
          onClick={onNewScript} data-testid="btn-new-script"
          title="New Script"
        >
          {Icons.plus}
          <span>New Script</span>
        </button>
        <button
          className="scripts-panel-btn ai"
          onClick={onAIGenerate} data-testid="btn-ai-generate"
          title="AI Generate"
        >
          {Icons.ai}
          <span>AI Generate</span>
        </button>
        <button
          className="scripts-panel-btn icon-only"
          onClick={fetchScripts}
          title="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button>
      </div>

      {loading && (
        <div className="scripts-panel-status">Loading scripts...</div>
      )}

      {error && (
        <div className="scripts-panel-error">
          {error}
          <button onClick={fetchScripts}>Retry</button>
        </div>
      )}

      {!loading && !error && (
        <div className="scripts-list">
          {/* My Scripts Section */}
          <div className="scripts-section">
            <div className="scripts-section-header">
              <span className="scripts-section-icon">{Icons.script}</span>
              <span>My Scripts</span>
              <span className="scripts-section-count">{myScripts.length}</span>
            </div>
            {myScripts.length > 0 ? (
              <div className="scripts-section-items">
                {myScripts.map(renderScript)}
              </div>
            ) : (
              <div className="scripts-section-empty">No scripts yet</div>
            )}
          </div>

          {/* Templates Section */}
          <div className="scripts-section">
            <div className="scripts-section-header">
              <span className="scripts-section-icon">{Icons.template}</span>
              <span>Templates</span>
              <span className="scripts-section-count">{templateScripts.length}</span>
            </div>
            {templateScripts.length > 0 ? (
              <div className="scripts-section-items">
                {templateScripts.map(renderScript)}
              </div>
            ) : (
              <div className="scripts-section-empty">No templates</div>
            )}
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="scripts-context-menu"
          style={contextMenuStyle}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              const script = scripts.find(s => s.id === contextMenu.scriptId);
              if (script) handleOpenScript(script);
              setContextMenu(null);
            }}
          >
            {Icons.script}
            <span>Edit Script</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => handleDelete(contextMenu.scriptId)}
          >
            {Icons.trash}
            <span>Delete Script</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default ScriptsPanel;
