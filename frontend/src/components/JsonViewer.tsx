import { useState, useMemo, useCallback } from 'react';
import './DocumentViewer.css';

import { getErrorMessage } from '../api/errors'
import Tooltip from './Tooltip';
interface JsonViewerProps {
  content: string;
  filename?: string; // Reserved for future use (e.g., display in header)
  /** When set, keys and indexes become clickable and report their dot/bracket path. */
  onKeyClick?: (path: string) => void;
  /** Path to highlight (e.g. the current extract path). */
  highlightPath?: string;
}

// Icons
const Icons = {
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
};

// Get all paths up to depth N for initial expansion
function getPathsToDepth(value: unknown, maxDepth: number, currentPath = ''): Set<string> {
  const paths = new Set<string>();
  if (currentPath) paths.add(currentPath);

  const depth = currentPath.split('.').filter(Boolean).length;
  if (depth >= maxDepth) return paths;

  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const newPath = currentPath ? `${currentPath}[${index}]` : `[${index}]`;
        const childPaths = getPathsToDepth(item, maxDepth, newPath);
        childPaths.forEach((p) => paths.add(p));
      });
    } else {
      Object.entries(value as Record<string, unknown>).forEach(([key, val]) => {
        const newPath = currentPath ? `${currentPath}.${key}` : key;
        const childPaths = getPathsToDepth(val, maxDepth, newPath);
        childPaths.forEach((p) => paths.add(p));
      });
    }
  }

  return paths;
}

// Get preview text for collapsed containers
function getPreview(value: unknown): string {
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object);
    if (keys.length <= 3) {
      return `{${keys.join(', ')}}`;
    }
    return `{${keys.slice(0, 3).join(', ')}, ...}`;
  }
  return '';
}

interface JsonNodeProps {
  name: string | number | null;
  value: unknown;
  path: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  isLast?: boolean;
  onKeyClick?: (path: string) => void;
  highlightPath?: string;
}

function JsonNode({
  name,
  value,
  path,
  expandedPaths,
  onToggle,
  isLast = false,
  onKeyClick,
  highlightPath,
}: JsonNodeProps) {
  const isExpandable = value !== null && typeof value === 'object';
  const isExpanded = expandedPaths.has(path);
  const isArray = Array.isArray(value);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle(path);
    },
    [path, onToggle]
  );

  // Render primitive value
  const renderValue = (val: unknown): React.ReactNode => {
    if (val === null) {
      return <span className="json-null">null</span>;
    }
    if (typeof val === 'string') {
      return <span className="json-string">"{val}"</span>;
    }
    if (typeof val === 'number') {
      return <span className="json-number">{val}</span>;
    }
    if (typeof val === 'boolean') {
      return <span className="json-boolean">{String(val)}</span>;
    }
    return null;
  };

  // Render key/name part. With onKeyClick the name doubles as a button that
  // hands back this node's path (results[0].comments) so an extract path can
  // be set by clicking instead of typing.
  const renderName = (): React.ReactNode => {
    if (name === null) return null;
    const highlighted = highlightPath !== undefined && highlightPath !== '' && highlightPath === path;
    const clickable = onKeyClick !== undefined;
    const cls = (base: string) => `${base}${clickable ? ' json-key-clickable' : ''}${highlighted ? ' json-key-highlight' : ''}`;
    const onClick = clickable
      ? (e: React.MouseEvent) => {
          e.stopPropagation();
          onKeyClick(path);
        }
      : undefined;
    const title = clickable ? `Use ${path} as the extract path` : undefined;
    if (typeof name === 'number') {
      return <span className={cls('json-index')} onClick={onClick} title={title}>{name}</span>;
    }
    return (
      <>
        <span className={cls('json-key')} onClick={onClick} title={title}>"{name}"</span>
        <span className="json-punctuation">: </span>
      </>
    );
  };

  // Non-expandable value (primitives)
  if (!isExpandable) {
    return (
      <div className="json-node-line">
        <span className="json-node-placeholder" />
        {renderName()}
        {renderValue(value)}
        {!isLast && <span className="json-punctuation">,</span>}
      </div>
    );
  }

  // Expandable value (object or array)
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [i, v] as [number, unknown])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="json-node">
      <div className="json-node-line">
        <Tooltip label={isExpanded ? 'Collapse' : 'Expand'}><button aria-label={isExpanded ? 'Collapse' : 'Expand'} className="json-node-toggle" onClick={handleToggle}>
          {isExpanded ? Icons.chevronDown : Icons.chevronRight}
        </button></Tooltip>
        {renderName()}
        <span className="json-bracket">{isArray ? '[' : '{'}</span>
        {!isExpanded && (
          <>
            <span className="json-collapsed-preview">{getPreview(value)}</span>
            <span className="json-bracket">{isArray ? ']' : '}'}</span>
            {!isLast && <span className="json-punctuation">,</span>}
          </>
        )}
      </div>
      {isExpanded && (
        <>
          <div className="json-node-children">
            {entries.map(([key, val], idx) => {
              const childPath = isArray ? `${path}[${key}]` : (path ? `${path}.${key}` : String(key));
              return (
                <JsonNode
                  key={childPath}
                  name={key}
                  value={val}
                  path={childPath}
                  onKeyClick={onKeyClick}
                  highlightPath={highlightPath}
                  expandedPaths={expandedPaths}
                  onToggle={onToggle}
                  isLast={idx === entries.length - 1}
                />
              );
            })}
          </div>
          <div className="json-node-line">
            <span className="json-node-placeholder" />
            <span className="json-bracket">{isArray ? ']' : '}'}</span>
            {!isLast && <span className="json-punctuation">,</span>}
          </div>
        </>
      )}
    </div>
  );
}

function JsonViewer({ content, onKeyClick, highlightPath }: JsonViewerProps) {
  // Parse JSON: data and error are derived together so no state is set
  // during render.
  const { parsedData, parseError } = useMemo<{ parsedData: unknown; parseError: string | null }>(() => {
    try {
      return { parsedData: JSON.parse(content), parseError: null };
    } catch (err) {
      return { parsedData: null, parseError: getErrorMessage(err, 'Invalid JSON') };
    }
  }, [content]);

  // Initialize expanded paths (first 2 levels)
  const initialExpanded = useMemo(() => {
    if (parsedData === null) return new Set<string>();
    return getPathsToDepth(parsedData, 2, '');
  }, [parsedData]);

  // Expanded state is keyed by the content it was built for, so a new
  // response resets the tree without setting state during render.
  const [expandedState, setExpandedState] = useState<{ forContent: string; paths: Set<string> }>(
    () => ({ forContent: content, paths: initialExpanded })
  );
  const expandedPaths = expandedState.forContent === content ? expandedState.paths : initialExpanded;

  const togglePath = useCallback((path: string) => {
    setExpandedState((prev) => {
      const base = prev.forContent === content ? prev.paths : initialExpanded;
      const next = new Set(base);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { forContent: content, paths: next };
    });
  }, [content, initialExpanded]);

  // Render error state
  if (parseError) {
    return (
      <div className="json-viewer json-viewer-error">
        <div className="json-viewer-error-message">Failed to parse JSON</div>
        <div className="json-viewer-error-details">{parseError}</div>
      </div>
    );
  }

  // Handle empty/null content
  if (parsedData === null || parsedData === undefined) {
    return (
      <div className="json-viewer json-viewer-error">
        <div className="json-viewer-error-message">No data to display</div>
      </div>
    );
  }

  return (
    <div className="json-viewer">
      <JsonNode
        name={null}
        value={parsedData}
        path=""
        expandedPaths={expandedPaths}
        onToggle={togglePath}
        isLast={true}
        onKeyClick={onKeyClick}
        highlightPath={highlightPath}
      />
    </div>
  );
}

export default JsonViewer;
