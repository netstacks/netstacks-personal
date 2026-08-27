import { useRef } from 'react';
import { useModalKeyboard } from '../hooks/useModalKeyboard';
import './CommandWarningDialog.css';

/** Payload of a `GuardHold` terminal message from the agent. */
export interface GuardHoldData {
  id: string;
  command: string;
  verdict: string;
  reason: string;
  objects: string[];
  block_lines: number;
}

interface GuardHoldDialogProps {
  hold: GuardHoldData;
  onProceed: () => void;
  onCancel: () => void;
  /** Why the last decision could not be delivered (e.g. connection lost). */
  error?: string | null;
}

/**
 * Session Guard hold: the agent withheld Enter because the command would
 * sever this SSH session. Reuses the command-warning styling so the two
 * dialogs read as one family. Enter is deliberately a no-op; Escape cancels.
 */
export function GuardHoldDialog({ hold, onProceed, onCancel, error }: GuardHoldDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useModalKeyboard({
    isOpen: true,
    containerRef,
    onEscape: onCancel,
    autoFocusSelector: '.btn-secondary',
  });

  return (
    <div className="command-warning-overlay">
      <div
        className="command-warning-dialog"
        style={{ borderTopColor: '#f44336' }}
        ref={containerRef}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="command-warning-header">
          <span className="command-warning-icon">{'\u26D4'}</span>
          <h3>Session Guard: this will sever your session</h3>
        </div>

        <div className="command-warning-command">
          <code>{hold.command}</code>
          {hold.block_lines > 1 && (
            <span className="alternatives-label"> in a pasted block of {hold.block_lines} lines</span>
          )}
        </div>

        <div className="command-warning-list">
          <div className="command-warning-item severity-high">
            <span className="warning-bullet">{'\u2022'}</span>
            <span>{hold.reason}</span>
          </div>
          {hold.objects.map((o) => (
            <div key={o} className="command-warning-item severity-medium">
              <span className="warning-bullet">{'\u2022'}</span>
              <code>{o}</code>
            </div>
          ))}
        </div>

        {error && (
          <div className="command-warning-item severity-high" role="alert">
            <span className="warning-bullet">{'\u26A0'}</span>
            <span>{error}</span>
          </div>
        )}

        <div className="command-warning-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-danger" onClick={onProceed}>
            Send anyway
          </button>
        </div>
      </div>
    </div>
  );
}
