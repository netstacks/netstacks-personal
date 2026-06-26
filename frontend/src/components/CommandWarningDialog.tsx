import { useRef } from 'react';
import type { SafetyAnalysis } from '../types/commandSafety';
import { getSafetyColor, getSafeAlternatives } from '../lib/commandSafetyEngine';
import { useModalKeyboard } from '../hooks/useModalKeyboard';
import './CommandWarningDialog.css';

interface CommandWarningDialogProps {
  analysis: SafetyAnalysis;
  onProceed: () => void;
  onCancel: () => void;
  onUseAlternative?: (command: string) => void;
}

export function CommandWarningDialog({
  analysis,
  onProceed,
  onCancel,
  onUseAlternative,
}: CommandWarningDialogProps) {
  const alternatives = getSafeAlternatives(analysis.command, analysis.context?.cliFlavor || 'auto');
  const borderColor = getSafetyColor(analysis.level);

  // P1-16: this is the destructive-command warning. Without keyboard
  // discipline, a stray Enter could trigger Proceed Anyway. We
  // explicitly DON'T pass onEnter — Enter is a no-op here. Escape
  // maps to Cancel (the safe default). Focus traps onto Cancel.
  const containerRef = useRef<HTMLDivElement>(null);
  useModalKeyboard({
    isOpen: true,
    containerRef,
    onEscape: onCancel,
    autoFocusSelector: '.btn-secondary', // Cancel button
  });

  return (
    <div className="command-warning-overlay">
      <div
        className="command-warning-dialog"
        style={{ borderTopColor: borderColor }}
        ref={containerRef}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="command-warning-header">
          <span className="command-warning-icon">
            {analysis.level === 'dangerous' ? '\u26A0\uFE0F' : '\u26A0'}
          </span>
          <h3>
            {analysis.level === 'dangerous' ? 'Dangerous Command' : 'Command Warning'}
          </h3>
        </div>

        <div className="command-warning-command">
          <code>{analysis.command}</code>
        </div>

        <div className="command-warning-list">
          {analysis.warnings.map((warning, i) => (
            <div key={i} className={`command-warning-item severity-${warning.severity}`}>
              <span className="warning-bullet">{'\u2022'}</span>
              <span>{warning.message}</span>
            </div>
          ))}
        </div>

        {alternatives.length > 0 && (
          <div className="command-warning-alternatives">
            <p className="alternatives-label">Consider instead:</p>
            {alternatives.map((alt, i) => (
              <button
                key={i}
                className="alternative-button"
                onClick={() => onUseAlternative?.(alt)}
                title={`Use: ${alt}`}
              >
                <code>{alt}</code>
              </button>
            ))}
          </div>
        )}

        <div className="command-warning-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`btn-${analysis.level === 'dangerous' ? 'danger' : 'warning'}`}
            onClick={onProceed}
          >
            {analysis.level === 'dangerous' ? 'Proceed Anyway' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
