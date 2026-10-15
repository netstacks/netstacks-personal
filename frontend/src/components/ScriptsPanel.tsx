import { useState, useEffect, useCallback } from 'react';
import { SparkleIcon } from './icons/SparkleIcon';
import './ScriptsPanel.css';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { listScripts, getScript, deleteScript, type Script } from '../api/scripts';
import { confirmDialog } from './ConfirmDialog';

import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip';
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
};

function ScriptsPanel({ onOpenScript, onNewScript, onAIGenerate }: ScriptsPanelProps) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; scriptId: string } | null>(null);

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

  const scriptMenuItems = (scriptId: string): MenuItem[] => [
    { id: 'edit', label: 'Edit Script', icon: Icons.script, action: () => {
      const script = scripts.find(s => s.id === scriptId);
      if (script) void handleOpenScript(script);
    } },
    { id: 'delete-divider', label: '', divider: true, action: () => {} },
    { id: 'delete', label: 'Delete Script', icon: Icons.trash, danger: true, action: () => { void handleDelete(scriptId); } },
  ];

  const handleDelete = async (scriptId: string) => {
    setContextMenu(null);
    const script = scripts.find(s => s.id === scriptId);
    const ok = await confirmDialog({
      title: 'Delete script?',
      body: (
        <>
          Delete <strong>{script?.name ?? scriptId}</strong>? This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteScript(scriptId);
      setScripts(prev => prev.filter(s => s.id !== scriptId));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete script'));
    }
  };

  const renderScript = (script: Script) => (
    <div
      key={script.id}
      className="scripts-item"
      onClick={() => handleOpenScript(script)}
      onContextMenu={(e) => handleContextMenu(e, script.id)}
      title={script.name}
    >
      <span className="scripts-item-icon">{Icons.script}</span>
      <span className="scripts-item-name">{script.name}</span>
    </div>
  );

  return (
    <div className="scripts-panel">
      <div className="scripts-panel-toolbar">
        <Tooltip label="New Script"><button
          className="ns-btn ns-btn--primary ns-btn--small"
          onClick={onNewScript} data-testid="btn-new-script"
        >
          {Icons.plus}
          <span>New Script</span>
        </button></Tooltip>
        <Tooltip label="Generate a script with AI"><button
          className="ns-btn ns-btn--primary ns-btn--small scripts-panel-ai"
          onClick={onAIGenerate} data-testid="btn-ai-generate"
        >
          <SparkleIcon />
          <span>Generate</span>
        </button></Tooltip>
        <Tooltip label="Refresh"><button
          className="ns-btn ns-btn--ghost ns-icon-btn scripts-panel-refresh"
          onClick={fetchScripts}
          aria-label="Refresh"
          disabled={loading}
        >
          {Icons.refresh}
        </button></Tooltip>
      </div>

      {loading && (
        <div className="scripts-panel-status">Loading scripts...</div>
      )}

      {error && (
        <div className="scripts-panel-error">
          {error}
          <button className="ns-btn" onClick={fetchScripts}>Retry</button>
        </div>
      )}

      {!loading && !error && (
        <div className="scripts-list">
          {scripts.length > 0 ? (
            <div className="scripts-section-items">
              {scripts.map(renderScript)}
            </div>
          ) : (
            <div className="sidebar-empty"><p>No scripts yet</p></div>
          )}
        </div>
      )}

      <ContextMenu
        position={contextMenu}
        items={contextMenu ? scriptMenuItems(contextMenu.scriptId) : []}
        onClose={() => setContextMenu(null)}
      />
    </div>
  );
}

export default ScriptsPanel;
