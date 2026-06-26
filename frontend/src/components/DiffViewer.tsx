import { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import './DiffViewer.css';

interface DiffViewerProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  onClose: () => void;
}

interface DiffLine {
  type: 'unchanged' | 'added' | 'removed' | 'modified';
  beforeLine?: string;
  afterLine?: string;
  lineNumber: number;
}

export default function DiffViewer({
  before,
  after,
  beforeLabel = 'Before',
  afterLabel = 'After',
  onClose,
}: DiffViewerProps) {
  const beforePaneRef = useRef<HTMLDivElement>(null);
  const afterPaneRef = useRef<HTMLDivElement>(null);
  const [syncScroll, setSyncScroll] = useState(true);

  const diffLines = useMemo(() => {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const maxLines = Math.max(beforeLines.length, afterLines.length);
    const lines: DiffLine[] = [];

    for (let i = 0; i < maxLines; i++) {
      const beforeLine = beforeLines[i];
      const afterLine = afterLines[i];

      if (beforeLine === afterLine) {
        lines.push({ type: 'unchanged', beforeLine, afterLine, lineNumber: i + 1 });
      } else if (beforeLine === undefined) {
        lines.push({ type: 'added', afterLine, lineNumber: i + 1 });
      } else if (afterLine === undefined) {
        lines.push({ type: 'removed', beforeLine, lineNumber: i + 1 });
      } else {
        lines.push({ type: 'modified', beforeLine, afterLine, lineNumber: i + 1 });
      }
    }

    return lines;
  }, [before, after]);

  const stats = useMemo(() => {
    return {
      added: diffLines.filter(l => l.type === 'added').length,
      removed: diffLines.filter(l => l.type === 'removed').length,
      modified: diffLines.filter(l => l.type === 'modified').length,
      unchanged: diffLines.filter(l => l.type === 'unchanged').length,
    };
  }, [diffLines]);

  // Synchronized scrolling
  const handleScroll = useCallback((source: 'before' | 'after') => {
    if (!syncScroll) return;

    const sourcePane = source === 'before' ? beforePaneRef.current : afterPaneRef.current;
    const targetPane = source === 'before' ? afterPaneRef.current : beforePaneRef.current;

    if (sourcePane && targetPane) {
      targetPane.scrollTop = sourcePane.scrollTop;
      targetPane.scrollLeft = sourcePane.scrollLeft;
    }
  }, [syncScroll]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Jump to first change
  const jumpToFirstChange = useCallback(() => {
    const firstChangeIndex = diffLines.findIndex(l => l.type !== 'unchanged');
    if (firstChangeIndex > -1 && beforePaneRef.current) {
      const lineHeight = 22; // Approximate line height
      beforePaneRef.current.scrollTop = Math.max(0, (firstChangeIndex - 3) * lineHeight);
    }
  }, [diffLines]);

  return (
    <div className="diff-viewer-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="diff-viewer">
        <div className="diff-header">
          <h2>Configuration Diff</h2>
          <div className="diff-stats">
            <span className="stat added" title="Lines added">+{stats.added}</span>
            <span className="stat removed" title="Lines removed">-{stats.removed}</span>
            <span className="stat modified" title="Lines modified">~{stats.modified}</span>
          </div>
          <div className="diff-actions">
            <button
              className="jump-btn"
              onClick={jumpToFirstChange}
              title="Jump to first change"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              First Change
            </button>
            <label className="sync-toggle" title="Sync scrolling between panes">
              <input
                type="checkbox"
                checked={syncScroll}
                onChange={(e) => setSyncScroll(e.target.checked)}
              />
              Sync Scroll
            </label>
          </div>
          <button className="close-btn" onClick={onClose} title="Close (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="diff-labels">
          <div className="label before">{beforeLabel}</div>
          <div className="label after">{afterLabel}</div>
        </div>

        <div className="diff-content">
          <div
            className="diff-pane before"
            ref={beforePaneRef}
            onScroll={() => handleScroll('before')}
          >
            {diffLines.map((line, i) => (
              <div
                key={i}
                className={`diff-line ${line.type}`}
              >
                <span className="line-number">{line.lineNumber}</span>
                <span className="line-marker">
                  {line.type === 'removed' && '-'}
                  {line.type === 'modified' && '~'}
                </span>
                <span className="line-content">
                  {line.type === 'added' ? '' : line.beforeLine}
                </span>
              </div>
            ))}
          </div>
          <div className="diff-divider" />
          <div
            className="diff-pane after"
            ref={afterPaneRef}
            onScroll={() => handleScroll('after')}
          >
            {diffLines.map((line, i) => (
              <div
                key={i}
                className={`diff-line ${line.type}`}
              >
                <span className="line-number">{line.lineNumber}</span>
                <span className="line-marker">
                  {line.type === 'added' && '+'}
                  {line.type === 'modified' && '~'}
                </span>
                <span className="line-content">
                  {line.type === 'removed' ? '' : line.afterLine}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="diff-footer">
          <div className="legend">
            <span className="legend-item added">
              <span className="legend-color"></span>
              Added ({stats.added})
            </span>
            <span className="legend-item removed">
              <span className="legend-color"></span>
              Removed ({stats.removed})
            </span>
            <span className="legend-item modified">
              <span className="legend-color"></span>
              Modified ({stats.modified})
            </span>
            <span className="legend-item unchanged">
              <span className="legend-color"></span>
              Unchanged ({stats.unchanged})
            </span>
          </div>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
