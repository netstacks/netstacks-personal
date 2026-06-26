import { useState, useMemo, useCallback } from 'react';
import './DocumentViewer.css';

import { getErrorMessage } from '../api/errors'
interface JsonViewerProps {
  content: string;
  filename?: string; // Reserved for future use (e.g., display in header)
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
}

function JsonNode({
  name,
  value,
  path,
  expandedPaths,
  onToggle,
  isLast = false,
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

  // Render key/name part
  const renderName = (): React.ReactNode => {
    if (name === null) return null;
    if (typeof name === 'number') {
      return <span className="json-index">{name}</span>;
    }
    return (
      <>
        <span className="json-key">"{name}"</span>
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
        <button className="json-node-toggle" onClick={handleToggle} title={isExpanded ? 'Collapse' : 'Expand'}>
          {isExpanded ? Icons.chevronDown : Icons.chevronRight}
        </button>
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

function JsonViewer({ content }: JsonViewerProps) {
  const [parseError, setParseError] = useState<string | null>(null);

  // Parse JSON
  const parsedData = useMemo(() => {
    try {
      const data = JSON.parse(content);
      setParseError(null);
      return data;
    } catch (err) {
      setParseError(getErrorMessage(err, 'Invalid JSON'));
      return null;
    }
  }, [content]);

  // Initialize expanded paths (first 2 levels)
  const initialExpanded = useMemo(() => {
    if (parsedData === null) return new Set<string>();
    return getPathsToDepth(parsedData, 2, '');
  }, [parsedData]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(initialExpanded);

  // Reset expanded state when content changes
  useMemo(() => {
    setExpandedPaths(initialExpanded);
  }, [initialExpanded]);

  const togglePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

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
      />
    </div>
  );
}

export default JsonViewer;
