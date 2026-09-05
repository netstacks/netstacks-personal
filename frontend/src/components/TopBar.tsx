import type { ReactNode } from 'react'
import './TopBar.css'
import { useShortcut } from '../hooks/useKeyboard'

export interface TopBarProps {
  platform: 'macos' | 'windows' | 'linux'
  sidebarOpen: boolean
  onToggleSidebar: () => void
  aiPanelOpen: boolean
  onToggleAiPanel: () => void
  onOpenCommandCenter: () => void
  /** Opens the clipboard-history palette (docs/clipboard-history-plan.md). */
  onOpenClipboardHistory?: () => void
  searchPlaceholder?: string
  menuSlot?: ReactNode
  windowControlsSlot?: ReactNode
}

export default function TopBar({
  platform,
  sidebarOpen,
  onToggleSidebar,
  aiPanelOpen,
  onToggleAiPanel,
  onOpenCommandCenter,
  onOpenClipboardHistory,
  searchPlaceholder = 'Search everything…',
  menuSlot,
  windowControlsSlot,
}: TopBarProps) {
  const paletteShortcut = useShortcut('commandPalette')
  const sidebarShortcut = useShortcut('toggleSidebar')
  const clipboardShortcut = useShortcut('clipboardHistory')
  const isMac = platform === 'macos'
  return (
    <div className={`topbar ${isMac ? 'is-macos' : ''}`} data-testid="topbar">
      {/* Left: traffic-light gap (mac) then menu slot (win/linux) */}
      <div className="topbar-left" data-tauri-drag-region>
        {!isMac && menuSlot}
      </div>

      {/* Center: command center */}
      <div className="topbar-center" data-tauri-drag-region>
        <button
          type="button"
          className="command-center"
          data-testid="command-center"
          onClick={onOpenCommandCenter}
          title={`Search everything (${paletteShortcut})`}
        >
          <span className="command-center-icon" aria-hidden>⌕</span>
          <span className="command-center-text">{searchPlaceholder}</span>
        </button>
      </div>

      {/* Right: panel toggles + window controls */}
      <div className="topbar-right" data-tauri-drag-region>
        {onOpenClipboardHistory && (
          <button
            type="button"
            className="topbar-icon-btn"
            data-testid="clipboard-history-btn"
            onClick={onOpenClipboardHistory}
            title={`Clipboard History (${clipboardShortcut})`}
            aria-label="Clipboard history"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="6" y="4" width="12" height="17" rx="2" />
              <path d="M9 4.5V3h6v1.5" />
              <path d="M9 10h6M9 14h6M9 18h4" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="topbar-icon-btn"
          data-testid="toggle-sidebar-btn"
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
          title={`Toggle Sidebar (${sidebarShortcut})`}
        >
          <span aria-hidden>▌</span>
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          data-testid="toggle-ai-panel-btn"
          aria-pressed={aiPanelOpen}
          onClick={onToggleAiPanel}
          title="Toggle AI Panel"
        >
          <span aria-hidden>▐</span>
        </button>
        {windowControlsSlot}
      </div>
    </div>
  )
}
