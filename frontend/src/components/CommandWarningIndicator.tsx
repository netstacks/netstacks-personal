import type { SafetyLevel } from '../types/commandSafety';
// getSafetyColor available for future styling enhancement

interface CommandWarningIndicatorProps {
  level: SafetyLevel;
  message?: string;
  visible: boolean;
}

export function CommandWarningIndicator({
  level,
  message,
  visible,
}: CommandWarningIndicatorProps) {
  if (!visible || level === 'safe') return null;

  // Color available for future styling: getSafetyColor(level)
  const icon = level === 'dangerous' ? '\u26A0\uFE0F' : '\u26A0';

  return (
    <div
      className="command-warning-indicator"
      style={{
        position: 'absolute',
        bottom: '8px',
        left: '8px',
        padding: '6px 12px',
        background: level === 'dangerous'
          ? 'rgba(220, 38, 38, 0.95)'
          : 'rgba(202, 138, 4, 0.95)',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 500,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        whiteSpace: 'nowrap',
        zIndex: 100,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
        animation: 'pulse 1.5s ease-in-out infinite',
      }}
    >
      <span style={{ fontSize: '14px' }}>{icon}</span>
      <span>{message || (level === 'dangerous' ? 'Dangerous command!' : 'Warning')}</span>
    </div>
  );
}
