import { useState, useEffect, useRef } from 'react';
import './AIProgressPanel.css';

export interface AIProgressLog {
  timestamp: Date;
  message: string;
  level: 'info' | 'success' | 'error' | 'warning';
}

interface AIProgressPanelProps {
  isRunning: boolean;
  currentTask: string;
  logs: AIProgressLog[];
  progress: number; // 0-100
  onDismiss: () => void;
  onExpand?: () => void;
  // For enrichment completion
  isComplete?: boolean;
  onOpenInAIPanel?: () => void;
}

export default function AIProgressPanel({
  isRunning,
  currentTask,
  logs,
  progress,
  onDismiss,
  onExpand,
  isComplete = false,
  onOpenInAIPanel,
}: AIProgressPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (isExpanded && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isExpanded]);

  // Auto-expand when complete to show results
  useEffect(() => {
    if (isComplete && !isRunning) {
      setIsExpanded(true);
    }
  }, [isComplete, isRunning]);

  // Don't render if not running and not complete
  if (!isRunning && !isComplete) {
    return null;
  }

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
    if (!isExpanded && onExpand) {
      onExpand();
    }
  };

  return (
    <div className={`ai-progress-panel ${isExpanded ? 'expanded' : 'collapsed'}`}>
      {/* Collapsed view - pill */}
      {!isExpanded && (
        <div className="ai-progress-pill" onClick={handleToggleExpand}>
          <div className="ai-progress-spinner">
            {isRunning ? (
              <svg viewBox="0 0 24 24" className="spinner">
                <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="checkmark">
                <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            )}
          </div>
          <span className="ai-progress-text">
            {isComplete ? 'AI Complete!' : 'AI Working...'}
          </span>
          <div className="ai-progress-mini-bar">
            <div
              className="ai-progress-mini-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Expanded view - full panel */}
      {isExpanded && (
        <div className="ai-progress-expanded">
          <div className="ai-progress-header">
            <div className="ai-progress-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2z" />
                <circle cx="7.5" cy="14.5" r="1.5" fill="currentColor" />
                <circle cx="16.5" cy="14.5" r="1.5" fill="currentColor" />
              </svg>
              <span>AI Discovery</span>
            </div>
            <div className="ai-progress-actions">
              <button
                className="ai-progress-minimize"
                onClick={() => setIsExpanded(false)}
                title="Minimize"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <button
                className="ai-progress-close"
                onClick={onDismiss}
                title="Dismiss"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Progress bar */}
          <div className="ai-progress-bar-container">
            <div className="ai-progress-bar">
              <div
                className={`ai-progress-fill ${progress === 100 ? 'complete' : ''}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="ai-progress-percent">{progress}%</span>
          </div>

          {/* Current task */}
          {currentTask && (
            <div className="ai-progress-current">
              <span className="ai-progress-label">Current:</span>
              <span className="ai-progress-task">{currentTask}</span>
            </div>
          )}

          {/* Logs */}
          <div className="ai-progress-logs">
            {logs.map((log, i) => (
              <div key={i} className={`ai-progress-log ${log.level}`}>
                <span className="ai-progress-log-time">{formatTime(log.timestamp)}</span>
                <span className={`ai-progress-log-level ${log.level}`}>
                  {log.level === 'info' && 'INFO'}
                  {log.level === 'success' && '✓'}
                  {log.level === 'warning' && 'WARN'}
                  {log.level === 'error' && 'ERR'}
                </span>
                <span className="ai-progress-log-message">{log.message}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {/* Action buttons when complete */}
          {isComplete && onOpenInAIPanel && (
            <div className="ai-progress-footer">
              <button
                className="ai-progress-open-panel"
                onClick={onOpenInAIPanel}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
                Open in AI Panel
              </button>
              <button
                className="ai-progress-dismiss-btn"
                onClick={onDismiss}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
