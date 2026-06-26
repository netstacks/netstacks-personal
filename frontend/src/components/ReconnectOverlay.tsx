import './ReconnectOverlay.css'

interface ReconnectOverlayProps {
  visible: boolean
  countdown: number
  attemptCount: number
  onReconnectNow: () => void
  onCancel: () => void
  onDisableAutoReconnect: () => void
  autoReconnectDisabled: boolean
  maxAttempts?: number
}

export default function ReconnectOverlay({
  visible,
  countdown,
  attemptCount,
  onReconnectNow,
  onCancel,
  onDisableAutoReconnect,
  autoReconnectDisabled,
  maxAttempts = 0,
}: ReconnectOverlayProps) {
  if (!visible) return null

  const hasMaxAttempts = maxAttempts > 0
  const isLastAttempt = hasMaxAttempts && attemptCount >= maxAttempts
  const title = isLastAttempt ? 'Session Ended' : 'Connection Lost'

  return (
    <div className="reconnect-overlay">
      <div className="reconnect-overlay-content">
        <div className="reconnect-overlay-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>

        <h3 className="reconnect-overlay-title">{title}</h3>

        {!autoReconnectDisabled && countdown > 0 && !isLastAttempt ? (
          <p className="reconnect-overlay-message">
            Reconnecting in <span className="reconnect-countdown">{countdown}</span> second{countdown !== 1 ? 's' : ''}...
            {attemptCount > 0 && hasMaxAttempts && (
              <span className="reconnect-attempts">
                <br />
                Attempt {attemptCount}/{maxAttempts}
              </span>
            )}
            {attemptCount > 0 && !hasMaxAttempts && (
              <span className="reconnect-attempts"> (Attempt {attemptCount + 1})</span>
            )}
          </p>
        ) : isLastAttempt ? (
          <p className="reconnect-overlay-message">
            Maximum reconnection attempts reached. Click Reconnect to try again.
          </p>
        ) : (
          <p className="reconnect-overlay-message">
            {autoReconnectDisabled ? 'Auto-reconnect is disabled' : 'Ready to reconnect'}
          </p>
        )}

        <div className="reconnect-overlay-actions">
          <button
            className="reconnect-btn reconnect-btn-primary"
            onClick={onReconnectNow}
          >
            Reconnect Now
          </button>
          <button
            className="reconnect-btn reconnect-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>

        {/* Audit P2-6: this was a checkbox with no `checked` prop and an
          * onChange that only fired on `e.target.checked === true`.
          * Unchecking did nothing, and after the user opted in the
          * `!autoReconnectDisabled` gate hid the whole block. A one-shot
          * button matches the actual semantics (the action is
          * irreversible from this UI — the user has to reopen Session
          * Settings to flip it back on). */}
        {!autoReconnectDisabled && (
          <button
            type="button"
            className="reconnect-overlay-disable-btn"
            onClick={onDisableAutoReconnect}
          >
            Don't auto-reconnect this session
          </button>
        )}
      </div>
    </div>
  )
}
