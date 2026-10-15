/**
 * NextStepSuggestions - Displays AI-generated next command suggestions
 *
 * A collapsible panel that shows suggested next commands after command execution,
 * categorized by purpose with confidence indicators.
 */

import type { NextStepSuggestion } from '../hooks/useNextStepSuggestions';
import './NextStepSuggestions.css';
import Tooltip from './Tooltip';

interface NextStepSuggestionsProps {
  suggestions: NextStepSuggestion[];
  loading: boolean;
  onUseSuggestion: (command: string) => void;
  onDismiss: () => void;
  visible: boolean;
}

const CATEGORY_ICONS: Record<NextStepSuggestion['category'], string> = {
  verification: '\u2713', // checkmark
  related: '\u2192',      // right arrow
  troubleshoot: '\uD83D\uDD0D', // magnifying glass
  documentation: '\uD83D\uDCC4', // document
};

const CATEGORY_LABELS: Record<NextStepSuggestion['category'], string> = {
  verification: 'Verify',
  related: 'Related',
  troubleshoot: 'Diagnose',
  documentation: 'Document',
};

const CONFIDENCE_COLORS: Record<NextStepSuggestion['confidence'], string> = {
  high: '#22c55e',
  medium: '#eab308',
  low: '#6b7280',
};

export function NextStepSuggestions({
  suggestions,
  loading,
  onUseSuggestion,
  onDismiss,
  visible,
}: NextStepSuggestionsProps) {
  if (!visible || (suggestions.length === 0 && !loading)) return null;

  return (
    <div className="next-step-suggestions">
      <div className="next-step-header">
        <span className="next-step-title">
          Suggested Next Steps
        </span>
        <Tooltip label="Dismiss"><button className="ns-btn ns-btn--ghost ns-icon-btn ns-btn--small" onClick={onDismiss}>
          &times;
        </button></Tooltip>
      </div>

      {loading ? (
        <div className="next-step-loading">
          <span className="loading-dots">Thinking</span>
        </div>
      ) : (
        <div className="next-step-list">
          {suggestions.map((suggestion, index) => (
            <Tooltip key={index} label={suggestion.description}><button
              className="next-step-item"
              onClick={() => onUseSuggestion(suggestion.command)}
            >
              <Tooltip label={CATEGORY_LABELS[suggestion.category]}><span className="next-step-icon">
                {CATEGORY_ICONS[suggestion.category]}
              </span></Tooltip>
              <div className="next-step-content">
                <code className="next-step-command">{suggestion.command}</code>
                <span className="next-step-description">{suggestion.description}</span>
              </div>
              <Tooltip label={`${suggestion.confidence} confidence`}><span
                className="next-step-confidence"
                style={{ color: CONFIDENCE_COLORS[suggestion.confidence] }}
              >
                {suggestion.confidence === 'high' ? '\u25CF' : suggestion.confidence === 'medium' ? '\u25D0' : '\u25CB'}
              </span></Tooltip>
            </button></Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}
