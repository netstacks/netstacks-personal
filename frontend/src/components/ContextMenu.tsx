import { useEffect, useCallback } from 'react'
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition'
import './ContextMenu.css'
import type { Detection } from '../types/detection'
import { isIPv4Metadata, isIPv6Metadata } from '../types/detection'
import { lookupOui, lookupDns, lookupWhois, lookupAsn, formatOuiResult, formatDnsResult, formatWhoisResult, formatAsnResult } from '../api/lookup'
import { showToast } from './Toast'

interface MenuItem {
  id: string
  label: string
  icon?: React.ReactNode
  shortcut?: string
  divider?: boolean
  disabled?: boolean
  action: () => void
}

interface ContextMenuProps {
  position: { x: number; y: number } | null
  items: MenuItem[]
  onClose: () => void
}

function ContextMenu({ position, items, onClose }: ContextMenuProps): React.ReactElement | null {
  const { ref, style } = useClampedMenuPosition(position)

  // Close on click outside or Escape key
  useEffect(() => {
    if (!position) return

    const handleClickOutside = () => onClose()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    // Delay to avoid immediate close from the right-click event
    const timerId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
      document.addEventListener('contextmenu', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }, 0)

    return () => {
      clearTimeout(timerId)
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('contextmenu', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [position, onClose])

  const handleItemClick = useCallback((item: MenuItem) => {
    if (!item.disabled) {
      item.action()
      onClose()
    }
  }, [onClose])

  if (!position) return null

  return (
    <div
      ref={ref}
      className="context-menu"
      style={style}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={`divider-${index}`} className="context-menu-divider" />
        }
        const className = item.disabled ? 'context-menu-item disabled' : 'context-menu-item'
        return (
          <button
            key={item.id}
            className={className}
            onClick={() => handleItemClick(item)}
            disabled={item.disabled}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
}

export default ContextMenu

// Export MenuItem type for external use
export type { MenuItem }

// Device context menu items with Edit, Delete, and AI options
export const getDeviceMenuItems = (
  _deviceName: string,
  onEdit: () => void,
  onDelete: () => void,
  onAnalyze: () => void,
  onShowConfig: () => void,
  onTroubleshoot: () => void,
  onFindPath: () => void,
  onFocusTerminal: () => void,
  onOpenAIChat: () => void,
  onDiscoverNeighbors: () => void,
  onConnect?: () => void,
  onAddToDiscovery?: () => void
): MenuItem[] => {
  return [
    {
      id: 'device-edit',
      label: 'Edit Device',
      icon: <EditIcon />,
      action: onEdit
    },
    {
      id: 'device-delete',
      label: 'Delete Device',
      shortcut: 'Del',
      icon: <DeleteIcon />,
      action: onDelete
    },
    {
      id: 'divider-edit',
      label: '',
      divider: true,
      action: () => {}
    },
    ...(onConnect ? [{
      id: 'device-connect',
      label: 'Connect',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
      action: onConnect
    },
    {
      id: 'divider-connect',
      label: '',
      divider: true,
      action: () => {}
    }] as MenuItem[] : []),
    {
      id: 'ai-analyze',
      label: 'AI: Analyze Device',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
          <path d="M11 8v6M8 11h6" />
        </svg>
      ),
      action: onAnalyze
    },
    {
      id: 'ai-config',
      label: 'AI: Show Config',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M7 8h10M7 12h10M7 16h6" />
        </svg>
      ),
      action: onShowConfig
    },
    {
      id: 'ai-troubleshoot',
      label: 'AI: Troubleshoot',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      ),
      action: onTroubleshoot
    },
    {
      id: 'ai-find-path',
      label: 'AI: Find Path To...',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="5" cy="12" r="3" />
          <circle cx="19" cy="12" r="3" />
          <path d="M8 12h8" strokeDasharray="2 2" />
        </svg>
      ),
      action: onFindPath
    },
    {
      id: 'divider-1',
      label: '',
      divider: true,
      action: () => {}
    },
    {
      id: 'focus-terminal',
      label: 'Focus Terminal',
      shortcut: 'Enter',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
      action: onFocusTerminal
    },
    {
      id: 'open-ai-chat',
      label: 'Open AI Assistant',
      shortcut: 'Cmd+I',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
      action: onOpenAIChat
    },
    {
      id: 'discover-neighbors',
      label: 'Discover Neighbors',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3" />
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="5" cy="18" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M9 10l-2-2M15 10l2-2M9 14l-2 2M15 14l2 2" />
        </svg>
      ),
      action: onDiscoverNeighbors
    },
    ...(onAddToDiscovery ? [{
      id: 'add-to-discovery',
      label: 'Add to Discovery',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
        </svg>
      ),
      action: onAddToDiscovery
    }] as MenuItem[] : []),
  ]
}

// Pre-built AI menu items for device context menu (topology right-click)
export const getDeviceAIMenuItems = (
  _deviceName: string,
  onAnalyze: () => void,
  onShowConfig: () => void,
  onTroubleshoot: () => void,
  onFindPath: () => void,
  onFocusTerminal: () => void,
  onOpenAIChat: () => void,
  onDiscoverNeighbors: () => void
): MenuItem[] => {
  return [
    {
      id: 'ai-analyze',
      label: 'AI: Analyze Device',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
          <path d="M11 8v6M8 11h6" />
        </svg>
      ),
      action: onAnalyze
    },
    {
      id: 'ai-config',
      label: 'AI: Show Config',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M7 8h10M7 12h10M7 16h6" />
        </svg>
      ),
      action: onShowConfig
    },
    {
      id: 'ai-troubleshoot',
      label: 'AI: Troubleshoot',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      ),
      action: onTroubleshoot
    },
    {
      id: 'ai-find-path',
      label: 'AI: Find Path To...',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="5" cy="12" r="3" />
          <circle cx="19" cy="12" r="3" />
          <path d="M8 12h8" strokeDasharray="2 2" />
        </svg>
      ),
      action: onFindPath
    },
    {
      id: 'divider-1',
      label: '',
      divider: true,
      action: () => {}
    },
    {
      id: 'focus-terminal',
      label: 'Focus Terminal',
      shortcut: 'Enter',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
      action: onFocusTerminal
    },
    {
      id: 'open-ai-chat',
      label: 'Open AI Assistant',
      shortcut: 'Cmd+I',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
      action: onOpenAIChat
    },
    {
      id: 'discover-neighbors',
      label: 'Discover Neighbors',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3" />
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="5" cy="18" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M9 10l-2-2M15 10l2-2M9 14l-2 2M15 14l2 2" />
        </svg>
      ),
      action: onDiscoverNeighbors
    },
  ]
}

// Pre-built AI menu items
export const getAIMenuItems = (
  selectedText: string,
  onExplain: () => void,
  onFix: () => void,
  onSuggest: () => void,
  onCopy: () => void,
  onAskAI: () => void,
  onSessionSettings?: () => void
): MenuItem[] => {
  const hasSelection = selectedText.trim().length > 0

  const items: MenuItem[] = [
    {
      id: 'ask-ai',
      label: 'Ask AI',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
      action: onAskAI
    },
    {
      id: 'divider-0',
      label: '',
      divider: true,
      action: () => {}
    },
    {
      id: 'ai-explain',
      label: 'AI: Explain',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ),
      disabled: !hasSelection,
      action: onExplain
    },
    {
      id: 'ai-fix',
      label: 'AI: Fix/Debug',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      ),
      disabled: !hasSelection,
      action: onFix
    },
    {
      id: 'ai-suggest',
      label: 'AI: Suggest',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      ),
      disabled: !hasSelection,
      action: onSuggest
    },
    {
      id: 'divider-1',
      label: '',
      divider: true,
      action: () => {}
    },
    {
      id: 'copy',
      label: 'Copy',
      shortcut: 'Cmd+C',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      ),
      disabled: !hasSelection,
      action: onCopy
    },
  ]

  // Add session settings if callback provided (for saved sessions)
  if (onSessionSettings) {
    items.push(
      {
        id: 'divider-3',
        label: '',
        divider: true,
        action: () => {}
      },
      {
        id: 'session-settings',
        label: 'Session Settings',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        ),
        action: onSessionSettings
      }
    )
  }

  return items
}

// Bolt icon for custom commands
const BoltIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M13 2L3 14h9l-1 10 10-12h-9l1-10z" />
  </svg>
)

/**
 * Generate context menu items for user-defined custom commands.
 *
 * Static commands (detection_types = null) appear when there is no detection.
 * Dynamic commands appear when the detection type matches.
 */
export const getCustomCommandMenuItems = (
  commands: { id: string; name: string; command: string; detection_types: string | null; enabled: boolean; action_type?: string; quick_action_id?: string | null; quick_action_variable?: string | null; script_id?: string | null }[],
  detection: Detection | null,
  onRunCommand: (cmd: string) => void,
  onRunQuickAction?: (quickActionId: string, variableName: string, value: string) => void,
  onRunScript?: (scriptId: string, detectedValue: string | null) => void,
): MenuItem[] => {
  const items: MenuItem[] = []
  const applicableCommands = commands.filter(cmd => {
    if (!cmd.enabled) return false
    if (!cmd.detection_types) {
      // Static command: always show regardless of context
      return true
    }
    if (!detection) return false
    // Dynamic command: show when detection type matches
    try {
      const types: string[] = JSON.parse(cmd.detection_types)
      // For custom regex types, match if the detection metadata has the same pattern
      return types.some(t => {
        if (t.startsWith('regex:') && detection.metadata.type === 'regex') {
          return t.slice(6) === (detection.metadata as { pattern: string }).pattern
        }
        return t === detection.type
      })
    } catch {
      return false
    }
  })

  if (applicableCommands.length === 0) return []

  items.push({ id: 'custom-cmd-divider', label: '', divider: true, action: () => {} })

  for (const cmd of applicableCommands) {
    if (cmd.action_type === 'script' && cmd.script_id) {
      items.push({
        id: `custom-cmd-${cmd.id}`,
        label: cmd.name,
        icon: <ScriptIcon />,
        action: () => onRunScript?.(cmd.script_id!, detection?.value ?? null),
      })
    } else if (cmd.action_type === 'quick_action' && cmd.quick_action_id && cmd.quick_action_variable) {
      items.push({
        id: `custom-cmd-${cmd.id}`,
        label: cmd.name,
        icon: <QuickActionIcon />,
        action: () => onRunQuickAction?.(cmd.quick_action_id!, cmd.quick_action_variable!, detection?.value ?? ''),
      })
    } else {
      const resolvedCommand = detection
        ? cmd.command.replace(/\{value\}/g, detection.value)
        : cmd.command
      items.push({
        id: `custom-cmd-${cmd.id}`,
        label: cmd.name,
        icon: <BoltIcon />,
        action: () => onRunCommand(resolvedCommand),
      })
    }
  }
  return items
}

// Code icon for script custom commands
const ScriptIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
)

// Zap icon for quick action custom commands
const QuickActionIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
)

// SVG icon components for detection menu items
const PingIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
)

const TracerouteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
    <path d="M7 12h3M14 12h3" strokeDasharray="2 2" />
  </svg>
)

const DnsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </svg>
)

const WhoisIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
    <path d="M11 8v6M8 11h6" />
  </svg>
)

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

// AIIcon available if needed for future AI menu items

const InterfaceIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01" />
  </svg>
)

const VlanIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z" />
  </svg>
)

const SubnetIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
  </svg>
)

const AsnIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </svg>
)

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
)

const SnmpStatsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="14" width="4" height="7" rx="1" />
    <rect x="10" y="9" width="4" height="12" rx="1" />
    <rect x="17" y="4" width="4" height="17" rx="1" />
    <path d="M3 3l4 4M10 3l2 3M17 1l2 2" strokeDasharray="1.5 1.5" />
  </svg>
)

// SVG icons for annotation context menu
const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
)

const DeleteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
)

const BringToFrontIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="8" y="8" width="12" height="12" rx="1" />
    <path d="M4 16V6a2 2 0 012-2h10" />
  </svg>
)

const SendToBackIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="4" y="4" width="12" height="12" rx="1" />
    <path d="M20 8v10a2 2 0 01-2 2H8" />
  </svg>
)

const BringForwardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

const SendBackwardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>
)

/**
 * Generate context menu items for an annotation (text, shape, line)
 */
export const getAnnotationMenuItems = (
  annotationType: 'text' | 'shape' | 'line' | 'group',
  onEdit: () => void,
  onDelete: () => void,
  onBringToFront: () => void,
  onBringForward: () => void,
  onSendBackward: () => void,
  onSendToBack: () => void
): MenuItem[] => {
  const items: MenuItem[] = []

  // Edit option (only for text annotations)
  if (annotationType === 'text') {
    items.push({
      id: 'annotation-edit',
      label: 'Edit Text',
      icon: <EditIcon />,
      action: onEdit
    })
  }

  // Delete
  items.push({
    id: 'annotation-delete',
    label: 'Delete',
    shortcut: 'Del',
    icon: <DeleteIcon />,
    action: onDelete
  })

  // Divider
  items.push({
    id: 'annotation-divider-1',
    label: '',
    divider: true,
    action: () => {}
  })

  // Layer ordering
  items.push(
    {
      id: 'annotation-bring-to-front',
      label: 'Bring to Front',
      icon: <BringToFrontIcon />,
      action: onBringToFront
    },
    {
      id: 'annotation-bring-forward',
      label: 'Bring Forward',
      icon: <BringForwardIcon />,
      action: onBringForward
    },
    {
      id: 'annotation-send-backward',
      label: 'Send Backward',
      icon: <SendBackwardIcon />,
      action: onSendBackward
    },
    {
      id: 'annotation-send-to-back',
      label: 'Send to Back',
      icon: <SendToBackIcon />,
      action: onSendToBack
    }
  )

  return items
}

/**
 * Generate context menu items for a detected network identifier
 *
 * Actions are split into two categories:
 * 1. Terminal commands (ping, traceroute) - sent directly to terminal
 * 2. Lookups (OUI, DNS, WHOIS, ASN) - direct API calls with toast results
 */
export const getDetectionMenuItems = (
  detection: Detection,
  onRunCommand: (cmd: string) => void,
  onCopy: (text: string) => void,
  onAIAction: (action: string, context: string) => void,
  onSnmpQuickLook?: (interfaceName: string) => void
): MenuItem[] => {
  const { type, value, normalizedValue, metadata } = detection
  const items: MenuItem[] = []

  // Build label with metadata badges
  const getBadge = (): string | null => {
    if (isIPv4Metadata(metadata)) {
      if (metadata.isPrivate) return ' (Private)'
      if (metadata.isMulticast) return ' (Multicast)'
      if (metadata.isLoopback) return ' (Loopback)'
    }
    if (isIPv6Metadata(metadata)) {
      if (metadata.isLinkLocal) return ' (Link-Local)'
      if (metadata.isLoopback) return ' (Loopback)'
    }
    return null
  }

  const badge = getBadge()
  const displayValue = value.length > 30 ? value.slice(0, 27) + '...' : value

  // Helper for async lookup actions - only show result (success/error), not loading state
  const doOuiLookup = async (mac: string) => {
    const result = await lookupOui(mac)
    const message = formatOuiResult(result)
    showToast(`${mac}: ${message}`, result.error ? 'error' : 'success', 8000)
  }

  const doDnsLookup = async (query: string) => {
    const result = await lookupDns(query)
    const message = formatDnsResult(result)
    showToast(`${query} → ${message}`, result.error ? 'error' : 'success', 8000)
  }

  const doWhoisLookup = async (query: string) => {
    const result = await lookupWhois(query)
    const message = formatWhoisResult(result)
    showToast(message, result.error ? 'error' : 'success', 10000)
  }

  const doAsnLookup = async (asn: string) => {
    const result = await lookupAsn(asn)
    const message = formatAsnResult(result)
    showToast(message, result.error ? 'error' : 'success', 10000)
  }

  switch (type) {
    case 'ipv4':
    case 'ipv6':
      items.push(
        {
          id: 'detection-ping',
          label: `Ping ${displayValue}${badge || ''}`,
          icon: <PingIcon />,
          action: () => onRunCommand(`ping ${value}`)
        },
        {
          id: 'detection-traceroute',
          label: `Traceroute`,
          icon: <TracerouteIcon />,
          action: () => onRunCommand(`traceroute ${value}`)
        },
        {
          id: 'detection-mtr',
          label: `MTR`,
          icon: <TracerouteIcon />,
          action: () => onRunCommand(`mtr ${value}`)
        },
        {
          id: 'detection-dns',
          label: 'DNS Reverse Lookup',
          icon: <DnsIcon />,
          action: () => doDnsLookup(value)
        },
        {
          id: 'detection-whois',
          label: 'Whois Lookup',
          icon: <WhoisIcon />,
          action: () => doWhoisLookup(value)
        }
      )
      break

    case 'mac':
      items.push(
        {
          id: 'detection-oui',
          label: `OUI Lookup: ${displayValue}`,
          icon: <SearchIcon />,
          action: () => doOuiLookup(value)
        }
      )
      break

    case 'hostname':
      items.push(
        {
          id: 'detection-dns-lookup',
          label: `DNS Lookup: ${displayValue}`,
          icon: <DnsIcon />,
          action: () => doDnsLookup(value)
        },
        {
          id: 'detection-ping',
          label: 'Ping',
          icon: <PingIcon />,
          action: () => onRunCommand(`ping ${value}`)
        },
        {
          id: 'detection-traceroute',
          label: 'Traceroute',
          icon: <TracerouteIcon />,
          action: () => onRunCommand(`traceroute ${value}`)
        },
        {
          id: 'detection-mtr',
          label: 'MTR',
          icon: <TracerouteIcon />,
          action: () => onRunCommand(`mtr ${value}`)
        },
        {
          id: 'detection-whois',
          label: 'Whois Lookup',
          icon: <WhoisIcon />,
          action: () => doWhoisLookup(value)
        }
      )
      break

    case 'interface':
      if (onSnmpQuickLook) {
        items.push({
          id: 'detection-snmp-quicklook',
          label: `SNMP Stats: ${displayValue}`,
          icon: <SnmpStatsIcon />,
          action: () => onSnmpQuickLook(value)
        })
      }
      items.push(
        {
          id: 'detection-interface-info',
          label: `Show Interface: ${displayValue}`,
          icon: <InterfaceIcon />,
          action: () => onAIAction('interface-info', `Show information about network interface: ${value}`)
        }
      )
      break

    case 'vlan':
      items.push(
        {
          id: 'detection-vlan-info',
          label: `Show VLAN Info: ${displayValue}`,
          icon: <VlanIcon />,
          action: () => onAIAction('vlan-info', `Show information about VLAN: ${value}`)
        }
      )
      break

    case 'cidr':
      items.push(
        {
          id: 'detection-subnet-calc',
          label: `Calculate Subnet: ${displayValue}`,
          icon: <SubnetIcon />,
          action: () => onAIAction('subnet-calc', `Calculate subnet details for CIDR notation: ${value}`)
        },
        {
          id: 'detection-whois',
          label: 'Whois Lookup',
          icon: <WhoisIcon />,
          action: () => {
            // Extract network address from CIDR for whois
            const network = value.split('/')[0]
            doWhoisLookup(network)
          }
        },
        {
          id: 'detection-ping-network',
          label: 'Ping Network',
          icon: <PingIcon />,
          action: () => {
            // Extract network address from CIDR
            const network = value.split('/')[0]
            onRunCommand(`ping ${network}`)
          }
        }
      )
      break

    case 'asn':
      items.push(
        {
          id: 'detection-asn-lookup',
          label: `ASN Lookup: ${displayValue}`,
          icon: <AsnIcon />,
          action: () => doAsnLookup(value)
        }
      )
      break
  }

  // Add divider before copy action
  items.push(
    {
      id: 'detection-divider',
      label: '',
      divider: true,
      action: () => {}
    },
    {
      id: 'detection-copy',
      label: `Copy: ${normalizedValue}`,
      icon: <CopyIcon />,
      action: () => onCopy(normalizedValue)
    }
  )

  return items
}
