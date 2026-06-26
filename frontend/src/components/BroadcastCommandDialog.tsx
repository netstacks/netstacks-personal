import { useState, useEffect, useCallback } from 'react';
import './BroadcastCommandDialog.css';
import {
  executeBulkCommand,
  type BulkCommandResponse,
  type CommandResult,
  type CommandStatus,
} from '../api/bulkCommands';
import { type Session } from '../api/sessions';
import { downloadFile } from '../lib/formatters';
import AITabInput from './AITabInput';

import { getErrorMessage } from '../api/errors'
interface BroadcastCommandDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedSessionIds: string[];
  sessions: Session[];
}

// Timeout options in seconds
const TIMEOUT_OPTIONS = [
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
  { value: 120, label: '120s' },
];

// Icons for the dialog
const Icons = {
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
  export: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
};

// Status icons
function StatusIcon({ status }: { status: CommandStatus }) {
  switch (status) {
    case 'success':
      return <span className="status-icon status-success" title="Success">&#10003;</span>;
    case 'error':
      return <span className="status-icon status-error" title="Error">&#10007;</span>;
    case 'timeout':
      return <span className="status-icon status-timeout" title="Timeout">&#9201;</span>;
    case 'authfailed':
      return <span className="status-icon status-error" title="Auth Failed">&#10007;</span>;
    default:
      return null;
  }
}

function BroadcastCommandDialog({
  isOpen,
  onClose,
  selectedSessionIds,
  sessions,
}: BroadcastCommandDialogProps) {
  // State management
  const [command, setCommand] = useState('');
  const [timeoutSecs, setTimeoutSecs] = useState(30);
  const [isExecuting, setIsExecuting] = useState(false);
  const [results, setResults] = useState<BulkCommandResponse | null>(null);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Get selected sessions with their details
  const selectedSessions = sessions.filter(s => selectedSessionIds.includes(s.id));

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCommand('');
      setTimeoutSecs(30);
      setResults(null);
      setExpandedResults(new Set());
      setError(null);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Execute command handler
  const handleExecute = useCallback(async () => {
    if (!command.trim() || selectedSessionIds.length === 0 || isExecuting) return;

    setIsExecuting(true);
    setError(null);
    setResults(null);

    try {
      const response = await executeBulkCommand({
        sessionIds: selectedSessionIds,
        command: command.trim(),
        timeoutSecs: timeoutSecs,
      });

      setResults(response);

      // Auto-expand first 3 results
      const toExpand = response.results.slice(0, 3).map(r => r.sessionId);
      setExpandedResults(new Set(toExpand));
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to execute command'));
    } finally {
      setIsExecuting(false);
    }
  }, [command, selectedSessionIds, timeoutSecs, isExecuting]);

  // Handle Cmd+Enter to execute
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    }
  }, [handleExecute]);

  // Toggle result expansion
  const toggleResultExpansion = (sessionId: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  // Export results as markdown
  const handleExport = useCallback(() => {
    if (!results) return;

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dateStr = now.toLocaleString();

    let markdown = `# Broadcast Command Results\n\n`;
    markdown += `**Command:** \`${command}\`\n`;
    markdown += `**Executed:** ${dateStr}\n`;
    markdown += `**Sessions:** ${results.results.length} (${results.successCount} succeeded, ${results.errorCount} failed)\n`;
    markdown += `**Total Time:** ${(results.totalTimeMs / 1000).toFixed(2)}s\n\n`;
    markdown += `## Results\n\n`;

    results.results.forEach((result: CommandResult) => {
      const statusIcon = result.status === 'success' ? '✓' : '✗';
      markdown += `### ${result.sessionName} (${result.host}) ${statusIcon}\n\n`;
      markdown += `**Status:** ${result.status}\n`;
      markdown += `**Execution Time:** ${(result.executionTimeMs / 1000).toFixed(2)}s\n\n`;

      if (result.status === 'success') {
        markdown += '```\n' + result.output + '\n```\n\n';
      } else {
        markdown += `**Error:** ${result.error || result.output}\n\n`;
      }
    });

    // Download the file
    downloadFile(markdown, `broadcast-results-${timestamp}.md`, 'text/markdown');
  }, [results, command]);

  // Copy all outputs to clipboard
  const handleCopyAll = useCallback(async () => {
    if (!results) return;

    const text = results.results
      .map((r: CommandResult) => `=== ${r.sessionName} (${r.host}) ===\n${r.output || r.error || 'No output'}`)
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(text);
      // Could add a toast notification here
    } catch {
      // Fallback for older browsers
      console.error('Failed to copy to clipboard');
    }
  }, [results]);

  if (!isOpen) return null;

  return (
    <div className="broadcast-dialog-overlay" onClick={onClose}>
      <div className="broadcast-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="broadcast-dialog-header">
          <h2>Broadcast Command to {selectedSessionIds.length} Session{selectedSessionIds.length === 1 ? '' : 's'}</h2>
          <button className="broadcast-dialog-close" onClick={onClose} title="Close">
            {Icons.close}
          </button>
        </div>

        <div className="broadcast-dialog-content">
          {/* Session list preview */}
          <div className="broadcast-sessions-preview">
            <label>Selected Sessions:</label>
            <div className="broadcast-sessions-list">
              {selectedSessions.slice(0, 5).map(session => (
                <div key={session.id} className="broadcast-session-item">
                  <span
                    className="broadcast-session-color"
                    style={{ backgroundColor: session.color || 'var(--color-accent)' }}
                  />
                  <span className="broadcast-session-name">{session.name}</span>
                  <span className="broadcast-session-host">({session.host})</span>
                </div>
              ))}
              {selectedSessions.length > 5 && (
                <div className="broadcast-sessions-more">
                  +{selectedSessions.length - 5} more...
                </div>
              )}
            </div>
          </div>

          {/* Command input */}
          <div className="broadcast-command-input">
            <label htmlFor="broadcast-command">Command:</label>
            <AITabInput
              as="textarea"
              id="broadcast-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter command to execute on all sessions..."
              rows={3}
              disabled={isExecuting}
              aiField="broadcast_command"
              aiPlaceholder="CLI command to broadcast to all sessions"
              aiContext={{ sessionCount: selectedSessionIds.length }}
              onAIValue={(v) => setCommand(v)}
            />
            <span className="broadcast-hint">Press Cmd+Enter to execute</span>
          </div>

          {/* Options row */}
          <div className="broadcast-options">
            <div className="broadcast-timeout">
              <label htmlFor="broadcast-timeout">Timeout:</label>
              <select
                id="broadcast-timeout"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(parseInt(e.target.value))}
                disabled={isExecuting}
              >
                {TIMEOUT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="broadcast-error">
              {error}
              <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}

          {/* Results area */}
          {(isExecuting || results) && (
            <div className="broadcast-results">
              <div className="broadcast-results-header">
                <h3>Results</h3>
                {results && (
                  <div className="broadcast-results-summary">
                    <span className="summary-success">{results.successCount} succeeded</span>
                    <span className="summary-divider">|</span>
                    <span className="summary-error">{results.errorCount} failed</span>
                    <span className="summary-divider">|</span>
                    <span className="summary-time">{(results.totalTimeMs / 1000).toFixed(2)}s</span>
                  </div>
                )}
              </div>

              {isExecuting && (
                <div className="broadcast-loading">
                  <div className="broadcast-spinner" />
                  <span>Executing command on {selectedSessionIds.length} sessions...</span>
                </div>
              )}

              {results && (
                <div className="broadcast-results-list">
                  {results.results.map((result: CommandResult) => (
                    <div key={result.sessionId} className="broadcast-result-item">
                      <div
                        className="broadcast-result-header"
                        onClick={() => toggleResultExpansion(result.sessionId)}
                      >
                        <span className="result-chevron">
                          {expandedResults.has(result.sessionId) ? Icons.chevronDown : Icons.chevronRight}
                        </span>
                        <StatusIcon status={result.status} />
                        <span className="result-session-name">{result.sessionName}</span>
                        <span className="result-host">({result.host})</span>
                        <span className="result-time">{(result.executionTimeMs / 1000).toFixed(2)}s</span>
                      </div>
                      {expandedResults.has(result.sessionId) && (
                        <div className="broadcast-result-output">
                          <pre>{result.output || result.error || 'No output'}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="broadcast-dialog-actions">
          {results && (
            <>
              <button className="btn-secondary" onClick={handleCopyAll} title="Copy all outputs">
                {Icons.copy}
                <span>Copy All</span>
              </button>
              <button className="btn-secondary" onClick={handleExport} title="Export as Markdown">
                {Icons.export}
                <span>Export Results</span>
              </button>
            </>
          )}
          <div className="broadcast-actions-spacer" />
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleExecute}
            disabled={isExecuting || !command.trim()}
          >
            {Icons.play}
            <span>{isExecuting ? 'Executing...' : 'Execute'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default BroadcastCommandDialog;
