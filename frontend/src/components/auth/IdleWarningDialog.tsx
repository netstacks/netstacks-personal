import './IdleWarningDialog.css';

interface IdleWarningDialogProps {
  secondsRemaining: number;
  onStaySignedIn: () => void;
}

/**
 * Idle timeout warning dialog.
 *
 * Displays a full-screen overlay with a warning that the session will
 * expire due to inactivity. Shows a countdown and "Stay Signed In" button.
 *
 * Styled to match VS Code dark theme aesthetic.
 */
export function IdleWarningDialog({
  secondsRemaining,
  onStaySignedIn,
}: IdleWarningDialogProps) {
  return (
    <div className="idle-warning-overlay">
      <div className="idle-warning-card">
        <div className="idle-warning-icon">⚠️</div>
        <h2 className="idle-warning-title">Session Expiring</h2>
        <p className="idle-warning-message">
          Your session will expire due to inactivity.
        </p>
        <p className="idle-warning-countdown">
          Logging out in <strong>{secondsRemaining}</strong> seconds
        </p>
        <button className="idle-warning-button" onClick={onStaySignedIn}>
          Stay Signed In
        </button>
      </div>
    </div>
  );
}

export default IdleWarningDialog;
