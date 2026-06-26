import type { SessionContext } from '../types/sessionContext';
import './SessionContextPopup.css';

interface SessionContextPopupProps {
  contexts: SessionContext[];
  sessionName: string;
  onDismiss: () => void;
  onAskAI: (context: SessionContext) => void;
  onViewAll: () => void;
}

/**
 * Proactive popup that appears when connecting to a device with existing context.
 * Shows the most recent context entry and offers to ask AI about it.
 * Visibility is controlled by the parent component.
 */
export default function SessionContextPopup({
  contexts,
  sessionName,
  onDismiss,
  onAskAI,
  onViewAll,
}: SessionContextPopupProps): React.ReactElement | null {
  if (contexts.length === 0) return null;

  const latestContext = contexts[0];

  return (
    <div className="session-context-popup">
      <div className="popup-header">
        <span className="popup-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </span>
        <span className="popup-title">Team Knowledge Available</span>
        <button className="close-btn" onClick={onDismiss} title="Dismiss">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="popup-content">
        <p className="context-preview">
          <strong>{latestContext.author}</strong> noted:{' '}
          <span className="context-issue-text">{latestContext.issue}</span>
        </p>

        {latestContext.ticket_ref && (
          <span className="ticket-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            {latestContext.ticket_ref}
          </span>
        )}

        <div className="popup-actions">
          <button className="btn-primary" onClick={() => onAskAI(latestContext)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            Ask AI about this
          </button>
          {contexts.length > 1 && (
            <button className="btn-secondary" onClick={onViewAll}>
              View all ({contexts.length})
            </button>
          )}
        </div>
      </div>

      <div className="popup-footer">
        <span className="session-name">{sessionName}</span>
      </div>
    </div>
  );
}
