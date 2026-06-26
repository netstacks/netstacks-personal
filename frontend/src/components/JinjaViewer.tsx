import { useMemo } from 'react';
import './DocumentViewer.css';

interface JinjaViewerProps {
  content: string;
  filename?: string; // Reserved for future use (e.g., display in header)
}

// Tokenize Jinja2 content for syntax highlighting
interface Token {
  type: 'variable' | 'tag' | 'comment' | 'filter' | 'text';
  content: string;
}

function tokenizeJinja(content: string): Token[] {
  const tokens: Token[] = [];
  let remaining = content;

  // Regex patterns for Jinja2 syntax
  const patterns: Array<{ type: Token['type']; regex: RegExp }> = [
    { type: 'comment', regex: /^\{#[\s\S]*?#\}/ },
    { type: 'tag', regex: /^\{%[\s\S]*?%\}/ },
    { type: 'variable', regex: /^\{\{[\s\S]*?\}\}/ },
  ];

  while (remaining.length > 0) {
    let matched = false;

    for (const { type, regex } of patterns) {
      const match = remaining.match(regex);
      if (match) {
        tokens.push({ type, content: match[0] });
        remaining = remaining.slice(match[0].length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Find next Jinja token start
      const nextToken = remaining.search(/\{[{%#]/);
      if (nextToken === -1) {
        // No more tokens, rest is plain text
        tokens.push({ type: 'text', content: remaining });
        break;
      } else if (nextToken === 0) {
        // Incomplete token at start, treat first char as text
        tokens.push({ type: 'text', content: remaining[0] });
        remaining = remaining.slice(1);
      } else {
        // Text before next token
        tokens.push({ type: 'text', content: remaining.slice(0, nextToken) });
        remaining = remaining.slice(nextToken);
      }
    }
  }

  return tokens;
}

// Process variable content to highlight filters
function renderVariableContent(content: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match the delimiters and inner content
  const innerMatch = content.match(/^\{\{\s*([\s\S]*?)\s*\}\}$/);

  if (!innerMatch) {
    return [<span key={0}>{content}</span>];
  }

  nodes.push(<span key="open" className="jinja-delimiter">{'{{ '}</span>);

  const inner = innerMatch[1];
  // Split by pipe to find filters
  const parts = inner.split(/(\|)/);
  let partIndex = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '|') {
      nodes.push(<span key={`filter-pipe-${partIndex}`} className="jinja-filter-pipe">|</span>);
      // Next part is the filter name (possibly with args)
      if (i + 1 < parts.length) {
        const filterPart = parts[i + 1];
        nodes.push(<span key={`filter-${partIndex}`} className="jinja-filter">{filterPart}</span>);
        i++; // Skip the filter part as we've handled it
      }
    } else if (i === 0) {
      // First part is the variable name
      nodes.push(<span key={`var-${partIndex}`} className="jinja-var-name">{part}</span>);
    }
    partIndex++;
  }

  nodes.push(<span key="close" className="jinja-delimiter">{' }}'}</span>);

  return nodes;
}

// Render a single token with appropriate styling
function renderToken(token: Token, index: number): React.ReactNode {
  switch (token.type) {
    case 'variable':
      return (
        <span key={index} className="jinja-variable">
          {renderVariableContent(token.content)}
        </span>
      );
    case 'tag':
      return (
        <span key={index} className="jinja-tag">
          {token.content}
        </span>
      );
    case 'comment':
      return (
        <span key={index} className="jinja-comment">
          {token.content}
        </span>
      );
    case 'text':
    default:
      return <span key={index}>{token.content}</span>;
  }
}

function JinjaViewer({ content }: JinjaViewerProps) {
  // Split content into lines and tokenize
  const lines = useMemo(() => {
    return content.split('\n');
  }, [content]);

  // Tokenize entire content for proper multi-line token handling
  const tokens = useMemo(() => tokenizeJinja(content), [content]);

  // Convert tokens back into lines for display with line numbers
  const renderedLines = useMemo(() => {
    const result: React.ReactNode[][] = [];
    let currentLine: React.ReactNode[] = [];
    let lineIndex = 0;
    let tokenIndex = 0;

    for (const token of tokens) {
      const tokenLines = token.content.split('\n');

      for (let i = 0; i < tokenLines.length; i++) {
        if (i > 0) {
          // New line within token
          result.push(currentLine);
          currentLine = [];
          lineIndex++;
        }

        if (tokenLines[i].length > 0 || i === 0) {
          // Create a partial token for this line
          const partialToken: Token = { type: token.type, content: tokenLines[i] };
          currentLine.push(renderToken(partialToken, tokenIndex++));
        }
      }
    }

    // Push final line
    result.push(currentLine);

    return result;
  }, [tokens]);

  // Handle empty content
  if (!content.trim()) {
    return (
      <div className="jinja-viewer jinja-viewer-empty">
        <p>No content to display</p>
      </div>
    );
  }

  return (
    <div className="jinja-viewer">
      <div className="jinja-content">
        <pre className="jinja-pre">
          <code className="jinja-code">
            {renderedLines.map((lineNodes, idx) => (
              <div key={idx} className="jinja-line">
                <span className="jinja-line-number">{idx + 1}</span>
                <span className="jinja-line-content">
                  {lineNodes.length > 0 ? lineNodes : '\u00A0'}
                </span>
              </div>
            ))}
          </code>
        </pre>
      </div>
      <div className="jinja-footer">
        <span className="jinja-stats">
          {lines.length} line{lines.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

export default JinjaViewer;
