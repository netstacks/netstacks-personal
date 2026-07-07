import type { ReactNode } from 'react'
import './TopBar.css'

export interface TopBarProps {
  platform: 'macos' | 'windows' | 'linux'
  sidebarOpen: boolean
  onToggleSidebar: () => void
  aiPanelOpen: boolean
  onToggleAiPanel: () => void
  onOpenCommandCenter: () => void
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
  searchPlaceholder = 'Search everything…',
  menuSlot,
  windowControlsSlot,
}: TopBarProps) {
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
          title="Search everything (⌘⇧P)"
        >
          <span className="command-center-icon" aria-hidden>⌕</span>
          <span className="command-center-text">{searchPlaceholder}</span>
        </button>
      </div>

      {/* Right: panel toggles + window controls */}
      <div className="topbar-right" data-tauri-drag-region>
        <button
          type="button"
          className="topbar-icon-btn"
          data-testid="toggle-sidebar-btn"
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
          title="Toggle Sidebar (⌘B)"
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
