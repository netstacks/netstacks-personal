/** AI sparkle glyph — Ask AI buttons and AI actions. */
export function SparkleIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 1l1.4 3.6L13 6l-3.6 1.4L8 11 6.6 7.4 3 6l3.6-1.4z" />
      <path d="M13 10l.7 1.8 1.8.7-1.8.7L13 15l-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}
