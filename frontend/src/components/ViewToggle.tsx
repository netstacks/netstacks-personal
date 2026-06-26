import './ViewToggle.css';

type ViewMode = '2d' | '3d';

interface ViewToggleProps {
  /** Current view mode */
  view: ViewMode;
  /** Callback when view changes */
  onViewChange: (view: ViewMode) => void;
  /** Additional CSS class */
  className?: string;
}

/**
 * ViewToggle - A toggle button group for switching between 2D and 3D views.
 */
export default function ViewToggle({
  view,
  onViewChange,
  className = '',
}: ViewToggleProps): React.ReactElement {
  const containerClass = className ? `view-toggle ${className}` : 'view-toggle'

  return (
    <div className={containerClass}>
      <button
        className={view === '2d' ? 'view-toggle-btn active' : 'view-toggle-btn'}
        onClick={() => onViewChange('2d')}
        title="2D View"
        aria-pressed={view === '2d'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
        <span>2D</span>
      </button>
      <button
        className={`view-toggle-btn ${view === '3d' ? 'active' : ''}`}
        onClick={() => onViewChange('3d')}
        title="3D View (Ctrl+Shift+V to toggle)"
        aria-pressed={view === '3d'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14" aria-hidden="true">
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span>3D</span>
      </button>
    </div>
  )
}
