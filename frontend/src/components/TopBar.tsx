import type { ReactNode } from 'react'
import './TopBar.css'
import { useBinding } from '../hooks/useKeyboard'
import Tooltip from './Tooltip'

export interface TopBarProps {
  platform: 'macos' | 'windows' | 'linux'
  onOpenCommandCenter: () => void
  /** Opens the clipboard-history palette (docs/clipboard-history-plan.md). */
  onOpenClipboardHistory?: () => void
  searchPlaceholder?: string
  menuSlot?: ReactNode
}

export default function TopBar({
  platform,
  onOpenCommandCenter,
  onOpenClipboardHistory,
  searchPlaceholder = 'Search everything…',
  menuSlot,
}: TopBarProps) {
  const paletteBinding = useBinding('commandPalette')
  const clipboardBinding = useBinding('clipboardHistory')
  const isMac = platform === 'macos'
  return (
    <div className={`topbar ${isMac ? 'is-macos' : ''}`} data-testid="topbar">
      {/* Left: traffic-light gap (mac) then menu slot (win/linux) */}
      <div className="topbar-left" data-tauri-drag-region>
        {!isMac && menuSlot}
      </div>

      {/* Center: command center */}
      <div className="topbar-center" data-tauri-drag-region>
        <Tooltip label="Search everything" shortcut={paletteBinding}><button
          type="button"
          className="command-center"
          data-testid="command-center"
          onClick={onOpenCommandCenter}
        >
          <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="6.5" cy="6.5" r="5" />
            <path d="M10.3 10.3L15 15" strokeLinecap="round" />
          </svg>
          <span className="command-center-text">{searchPlaceholder}</span>
        </button></Tooltip>
      </div>

      {/* Right: clipboard history */}
      <div className="topbar-right" data-tauri-drag-region>
        {onOpenClipboardHistory && (
          <Tooltip label="Clipboard History" shortcut={clipboardBinding}><button
            type="button"
            className="topbar-icon-btn"
            data-testid="clipboard-history-btn"
            onClick={onOpenClipboardHistory}
            aria-label="Clipboard history"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="6" y="4" width="12" height="17" rx="2" />
              <path d="M9 4.5V3h6v1.5" />
              <path d="M9 10h6M9 14h6M9 18h4" />
            </svg>
          </button></Tooltip>
        )}
      </div>
    </div>
  )
}
