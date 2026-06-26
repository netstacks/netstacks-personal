import { useState } from 'react';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import './LaunchDialog.css';

// Concrete user choice. Distinct from `LaunchAction` (which adds 'ask' as a preference value).
export type LaunchChoice = 'alongside' | 'replace' | 'new_window';

interface LaunchDialogProps {
  groupName: string;
  tabCount: number;
  tabSummary: string; // e.g., "core-1.dal, core-2.dal, edge-1.dal"
  hasTopology: boolean;
  defaultAction?: LaunchChoice;
  onConfirm: (action: LaunchChoice, dontAskAgain: boolean) => void;
  onCancel: () => void;
}

export default function LaunchDialog({
  groupName,
  tabCount,
  tabSummary,
  hasTopology,
  defaultAction = 'alongside',
  onConfirm,
  onCancel,
}: LaunchDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const choose = (action: LaunchChoice) => {
    onConfirm(action, dontAskAgain);
  };

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onCancel });

  return (
    <div className="launch-dialog-backdrop" {...backdropProps}>
      <div className="launch-dialog" {...contentProps}>
        <div className="launch-dialog-title">Launch &ldquo;{groupName}&rdquo;</div>
        <div className="launch-dialog-sub">
          {tabCount} {tabCount === 1 ? 'tab' : 'tabs'} · {tabSummary}
          {hasTopology && <span className="launch-dialog-topo"> · ◈ has topology</span>}
        </div>
        <div className="launch-dialog-opts">
          <button
            className={`launch-dialog-opt ${defaultAction === 'alongside' ? 'recommended' : ''}`}
            onClick={() => choose('alongside')}
          >
            <span className="launch-dialog-opt-icon">＋</span>
            <span className="launch-dialog-opt-body">
              <span className="launch-dialog-opt-name">Open alongside</span>
              <span className="launch-dialog-opt-desc">
                Add {tabCount} new {tabCount === 1 ? 'tab' : 'tabs'} next to your current tabs.
              </span>
            </span>
          </button>
          <button
            className={`launch-dialog-opt ${defaultAction === 'replace' ? 'recommended' : ''}`}
            onClick={() => choose('replace')}
          >
            <span className="launch-dialog-opt-icon">⇄</span>
            <span className="launch-dialog-opt-body">
              <span className="launch-dialog-opt-name">Replace current tabs</span>
              <span className="launch-dialog-opt-desc">Close all current tabs and open this group.</span>
            </span>
          </button>
          <button
            className={`launch-dialog-opt ${defaultAction === 'new_window' ? 'recommended' : ''}`}
            onClick={() => choose('new_window')}
          >
            <span className="launch-dialog-opt-icon">▢</span>
            <span className="launch-dialog-opt-body">
              <span className="launch-dialog-opt-name">Open in new window</span>
              <span className="launch-dialog-opt-desc">Spawn a new app window for this group.</span>
            </span>
          </button>
        </div>
        <div className="launch-dialog-foot">
          <label className="launch-dialog-remember">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            Don&rsquo;t ask again — always do this
          </label>
          <button className="launch-dialog-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
