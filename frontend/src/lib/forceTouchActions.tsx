import type { ForceTouchOption } from '../components/ForceTouchPopover'

/** Open a URL in the user's default browser (Tauri shell, with web fallback). */
async function openExternal(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

const CopyIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

/**
 * Force-click popover actions — the single extension point.
 *
 * Add new entries here (Quick Actions, AI lookups, NetBox/NetStacks lookups,
 * etc.) and they appear in the popover automatically. Use `visible` to hide an
 * option when it doesn't apply to the current selection.
 */
export const forceTouchOptions: ForceTouchOption[] = [
  {
    id: 'search-web',
    label: 'Search the Web',
    icon: SearchIcon,
    visible: (ctx) => ctx.text.trim().length > 0,
    run: (ctx) =>
      openExternal(`https://www.google.com/search?q=${encodeURIComponent(ctx.text.trim())}`),
  },
  {
    id: 'copy',
    label: 'Copy',
    icon: CopyIcon,
    visible: (ctx) => ctx.text.length > 0,
    run: (ctx) => navigator.clipboard.writeText(ctx.text),
  },
]
