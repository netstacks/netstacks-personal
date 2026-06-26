import { useState } from 'react';
import { formatContextSummary, type AiContext } from '../api/ai';
import './AIContextSummary.css';

interface AIContextSummaryProps {
  context?: AiContext;
  defaultExpanded?: boolean;
}

const AIContextSummary = ({ context, defaultExpanded = false }: AIContextSummaryProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!context) return null;

  const lines = formatContextSummary(context);
  if (lines.length === 0) return null;

  return (
    <div className="ai-context-summary">
      <button
        className="ai-context-summary-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          className={`ai-context-summary-arrow ${expanded ? 'expanded' : ''}`}
        >
          <path
            fill="currentColor"
            d="M8 5l7 7-7 7"
          />
        </svg>
        <span>Context</span>
        {!expanded && lines.length > 0 && (
          <span className="ai-context-summary-preview">
            {lines[0].length > 30 ? lines[0].substring(0, 30) + '...' : lines[0]}
          </span>
        )}
      </button>

      {expanded && (
        <div className="ai-context-summary-content">
          {lines.map((line, i) => (
            <div key={i} className="ai-context-summary-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AIContextSummary;
