import './InlineSuggestion.css';

interface InlineSuggestionProps {
  /** The full suggested command */
  suggestion: string | null;
  /** What the user has typed so far */
  currentInput: string;
  /** Position in pixels relative to terminal container */
  position: { x: number; y: number };
  /** Whether suggestions are loading */
  isLoading: boolean;
}

/**
 * Renders inline ghost text suggestion like VS Code inline suggestions.
 * Shows only the remaining part of the suggestion after what's typed.
 */
const InlineSuggestion = ({
  suggestion,
  currentInput,
  position,
  isLoading,
}: InlineSuggestionProps) => {
  // Don't show anything if no suggestion or still loading
  if (!suggestion || isLoading) return null;

  // Only show if suggestion starts with current input (case-insensitive match)
  const lowerSuggestion = suggestion.toLowerCase();
  const lowerInput = currentInput.toLowerCase();

  if (!lowerSuggestion.startsWith(lowerInput)) return null;

  // Get the remaining part of the suggestion (what hasn't been typed)
  const remaining = suggestion.slice(currentInput.length);

  // Don't show if nothing remaining
  if (!remaining) return null;

  return (
    <div
      className="inline-suggestion"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      <span className="inline-suggestion-text">{remaining}</span>
      <span className="inline-suggestion-hint">Tab</span>
    </div>
  );
};

export default InlineSuggestion;
