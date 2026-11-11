/** OOB console glyph — used in the session tree, tab strip, and context menus. */
export function ConsoleIcon({ size = 16, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} width={size} height={size}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 9 9 12 6 15" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </svg>
  );
}
