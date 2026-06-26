/**
 * TroubleshootingDialog - Modal for starting a troubleshooting session
 * Allows selecting terminals to capture and naming the session
 */

import { useState, useCallback, useEffect } from 'react';
import { getTroubleshootingSettings } from '../api/troubleshootingSettings';
import './TroubleshootingDialog.css';

interface ConnectedSession {
  id: string;
  name: string;
}

interface TroubleshootingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onStart: (name: string, terminalIds: string[], includeAI: boolean) => void;
  connectedSessions: ConnectedSession[];
}

export default function TroubleshootingDialog({
  isOpen,
  onClose,
  onStart,
  connectedSessions,
}: TroubleshootingDialogProps) {
  const [sessionName, setSessionName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [includeAI, setIncludeAI] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load settings for defaults
  const settings = getTroubleshootingSettings();

  // Reset form when dialog opens
  useEffect(() => {
    if (!isOpen) return;

    // Pre-select all connected sessions
    setSelectedIds(connectedSessions.map(s => s.id));
    setSessionName('');
    setIncludeAI(settings.captureAIConversations);
    setError(null);
  }, [isOpen, connectedSessions, settings.captureAIConversations]);

  const handleStart = useCallback(() => {
    if (!sessionName.trim()) {
      setError('Please enter a session name');
      return;
    }
    if (selectedIds.length === 0) {
      setError('Please select at least one terminal');
      return;
    }

    onStart(sessionName.trim(), selectedIds, includeAI);
    onClose();
  }, [sessionName, selectedIds, includeAI, onStart, onClose]);

  const toggleTerminal = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === connectedSessions.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(connectedSessions.map(s => s.id));
    }
  };

  const handleClose = useCallback(() => {
    setSessionName('');
    setSelectedIds([]);
    setError(null);
    onClose();
  }, [onClose]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      } else if (e.key === 'Enter' && sessionName.trim() && selectedIds.length > 0) {
        handleStart();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose, handleStart, sessionName, selectedIds]);

  if (!isOpen) return null;

  const allSelected = selectedIds.length === connectedSessions.length && connectedSessions.length > 0;
  const someSelected = selectedIds.length > 0 && selectedIds.length < connectedSessions.length;

  return (
    <div className="troubleshooting-dialog-overlay" onClick={handleClose}>
      <div className="troubleshooting-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="troubleshooting-dialog-header">
          <h2>Start Troubleshooting Session</h2>
          <button className="troubleshooting-dialog-close" onClick={handleClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="troubleshooting-dialog-content">
          <p className="troubleshooting-dialog-description">
            Record terminal commands and outputs during your troubleshooting session.
            The recorded session can be exported as documentation.
          </p>

          <div className="troubleshooting-form-field">
            <label htmlFor="session-name">Session Name</label>
            <input
              id="session-name"
              type="text"
              value={sessionName}
              onChange={(e) => {
                setSessionName(e.target.value);
                setError(null);
              }}
              placeholder="e.g., Router BGP Issue, Switch Loop Investigation"
              autoFocus
            />
          </div>

          <div className="troubleshooting-form-field">
            <div className="troubleshooting-field-header">
              <label>Terminals to Capture</label>
              <label className="troubleshooting-select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleSelectAll}
                />
                <span>Select All</span>
              </label>
            </div>
            <div className="troubleshooting-terminal-list">
              {connectedSessions.map(session => (
                <label key={session.id} className="troubleshooting-terminal-item">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(session.id)}
                    onChange={() => toggleTerminal(session.id)}
                  />
                  <span className="troubleshooting-terminal-dot" />
                  <span className="troubleshooting-terminal-name">{session.name}</span>
                </label>
              ))}
              {connectedSessions.length === 0 && (
                <div className="troubleshooting-empty-state">
                  No connected terminals. Connect to a device first.
                </div>
              )}
            </div>
          </div>

          <div className="troubleshooting-form-field">
            <label className="troubleshooting-checkbox-option">
              <input
                type="checkbox"
                checked={includeAI}
                onChange={(e) => setIncludeAI(e.target.checked)}
              />
              <span>Include AI conversations in recording</span>
            </label>
          </div>

          <div className="troubleshooting-settings-preview">
            <div className="troubleshooting-settings-label">Session Settings</div>
            <div className="troubleshooting-settings-info">
              <span className="troubleshooting-setting-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Auto-timeout: {settings.inactivityTimeout} min
              </span>
              <span className="troubleshooting-setting-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                {settings.autoSaveOnTimeout ? 'Auto-save on timeout' : 'No auto-save'}
              </span>
            </div>
          </div>

          {error && (
            <div className="troubleshooting-dialog-error">
              {error}
            </div>
          )}
        </div>

        <div className="troubleshooting-dialog-footer">
          <button className="troubleshooting-dialog-btn secondary" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="troubleshooting-dialog-btn primary"
            onClick={handleStart}
            disabled={!sessionName.trim() || selectedIds.length === 0}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <circle cx="12" cy="12" r="10" />
            </svg>
            Start Recording
          </button>
        </div>
      </div>
    </div>
  );
}
