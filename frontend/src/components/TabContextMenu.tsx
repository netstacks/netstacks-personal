import AITabInput from './AITabInput'
import { useEffect, useRef, useState } from 'react'
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition'
import ContextMenu, { type MenuItem } from './ContextMenu'
import './TabContextMenu.css'
import { ConsoleIcon } from './icons/ConsoleIcon'
import { getCurrentBinding } from '../hooks/useKeyboard'

import DialogFooter from './DialogFooter'
export interface TabGroup {
  id: string
  name: string
  tabIds: string[]
  orientation: 'horizontal' | 'vertical'
}

interface TabContextMenuProps {
  position: { x: number; y: number } | null
  tabId: string
  sessionId?: string
  isMultiSendEnabled: boolean
  groups: TabGroup[]
  currentGroupId: string | null
  onClose: () => void
  onReconnect: () => void
  onDuplicateTab: () => void
  onToggleMultiSend: () => void
  onSelectAllTabs: () => void
  onCreateGroup: (name: string) => void
  onMoveToGroup: (groupId: string) => void
  onRemoveFromGroup: () => void
  onCloseTab: () => void
  onCloseOtherTabs: () => void
  /** Close every tab in the window. */
  onCloseAllTabs?: () => void
  /** Close tabs to the right of this one (in tab strip order). */
  onCloseTabsToRight?: () => void
  /** Reopen the most-recently-closed tab. Disabled when the ring buffer is empty. */
  onReopenLastClosed?: () => void
  /** Whether a recently-closed tab is available to reopen. */
  canReopenClosed?: boolean
  onSessionSettings?: () => void
  /** Open (or set up) the OOB console for this tab's session */
  onOpenConsole?: () => void
  /** Split this terminal with a new one to the right (horizontal) */
  onSplitRight?: () => void
  /** Split this terminal with a new one below (vertical) */
  onSplitDown?: () => void
  /** Toggle SFTP file browser panel */
  onToggleSftp?: () => void
  /** Whether SFTP is currently enabled */
  isSftpEnabled?: boolean
  /** Pop out this terminal tab into its own window */
  onPopOut?: () => void
  /** Discover topology from the current group's tabs */
  onDiscoverTopology?: () => void
  /** Number of currently selected tabs */
  selectedTabCount?: number
  /** Create group from selected tabs */
  onGroupSelectedTabs?: () => void
  /** Open device details tab for this session */
  onOpenDeviceDetails?: () => void
  /** Share this session with others */
  onShareSession?: () => void
  /** Deploy a remote agent to this SSH session's host and open as workspace */
  onDeployRemoteAgent?: () => void
}

const Icons = {
  reconnect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 2v6h-6M3 22v-6h6M21 13a9 9 0 11-3-6.35M3 11a9 9 0 013 6.35" />
    </svg>
  ),
  duplicate: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  ),
  popOut: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  splitRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="8" height="18" rx="1" />
      <rect x="13" y="3" width="8" height="18" rx="1" />
    </svg>
  ),
  splitDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="8" rx="1" />
      <rect x="3" y="13" width="18" height="8" rx="1" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  device: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  ),
  share: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  deploy: (
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
      <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h5v2H5v1h6v-1H9v-2h5a1 1 0 001-1V2a1 1 0 00-1-1zm0 9H2V2h12v8z"/>
      <path d="M7 5.5l-.5 1h1L7 5.5zm-1 1.5H5l-.5 1h1L6 7zm2 0h-1l-.5 1h1L8 7z" opacity=".6"/>
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  ),
  discover: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="5" r="3" />
      <circle cx="5" cy="19" r="3" />
      <circle cx="19" cy="19" r="3" />
      <path d="M12 8v4M9.5 16.5l2.5-4.5M14.5 16.5l-2.5-4.5" />
    </svg>
  ),
  closeRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 18l6-6-6-6" />
    </svg>
  ),
  closeAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
      <path d="M14 2L2 14" />
    </svg>
  ),
  reopen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
    </svg>
  ),
}

export default function TabContextMenu({
  position,
  tabId: _tabId,
  sessionId,
  isMultiSendEnabled,
  groups,
  currentGroupId,
  onClose,
  onReconnect,
  onDuplicateTab,
  onToggleMultiSend,
  onSelectAllTabs,
  onCreateGroup,
  onMoveToGroup,
  onRemoveFromGroup,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onCloseTabsToRight,
  onReopenLastClosed,
  canReopenClosed,
  onSessionSettings,
  onSplitRight,
  onSplitDown,
  onPopOut,
  onToggleSftp,
  isSftpEnabled,
  onDiscoverTopology,
  selectedTabCount,
  onGroupSelectedTabs,
  onOpenDeviceDetails,
  onShareSession,
  onDeployRemoteAgent,
  onOpenConsole,
}: TabContextMenuProps) {
  // "New Group..." asks for a name in a small popover that outlives the menu,
  // so the menu's own close must not close this component while it is up.
  const [newGroupAt, setNewGroupAt] = useState<{ x: number; y: number } | null>(null)
  const newGroupAtRef = useRef(newGroupAt)
  const [newGroupName, setNewGroupName] = useState('')

  const sep = (id: string): MenuItem => ({ id, label: '', divider: true, action: () => {} })
  const otherGroups = groups.filter(g => g.id !== currentGroupId)

  const groupSubmenu: MenuItem[] = [
    { id: 'new-group', label: 'New Group...', icon: Icons.plus, action: () => {
      newGroupAtRef.current = position
      setNewGroupAt(position)
    } },
    ...(otherGroups.length > 0 ? [sep('move-divider'), ...otherGroups.map((group): MenuItem => (
      { id: `move-${group.id}`, label: `Move to "${group.name}"`, action: () => onMoveToGroup(group.id) }
    ))] : []),
    ...(currentGroupId ? [sep('remove-divider'), { id: 'remove-from-group', label: 'Remove from Group', icon: Icons.close, action: onRemoveFromGroup }] : []),
  ]

  const items: MenuItem[] = [
    { id: 'reconnect', label: 'Reconnect', icon: Icons.reconnect, action: onReconnect },
    { id: 'duplicate', label: 'Duplicate Tab', icon: Icons.duplicate, action: onDuplicateTab },
  ]
  if (onPopOut) items.push({ id: 'pop-out', label: 'Pop Out Terminal', icon: Icons.popOut, action: onPopOut })
  if (selectedTabCount !== undefined && selectedTabCount >= 2 && onGroupSelectedTabs) {
    items.push(sep('group-selected-divider'), {
      id: 'group-selected', label: `Group Selected Tabs (${selectedTabCount})`, icon: Icons.grid,
      shortcut: getCurrentBinding('groupSelectedTabs'), action: onGroupSelectedTabs,
    })
  }
  if (onSplitRight) items.push({ id: 'split-right', label: 'Split Right', icon: Icons.splitRight, action: onSplitRight })
  if (onSplitDown) items.push({ id: 'split-down', label: 'Split Down', icon: Icons.splitDown, action: onSplitDown })
  if (sessionId) {
    if (onSessionSettings) items.push({ id: 'session-settings', label: 'Session Settings', icon: Icons.settings, action: onSessionSettings })
    if (onOpenConsole) items.push({ id: 'open-console', label: 'Open Console', icon: <ConsoleIcon />, action: onOpenConsole })
    if (onOpenDeviceDetails) items.push({ id: 'device-details', label: 'Device Details', icon: Icons.device, action: onOpenDeviceDetails })
    if (onShareSession) items.push({ id: 'share-session', label: 'Share Session', icon: Icons.share, action: onShareSession })
    if (onToggleSftp) {
      items.push({ id: 'toggle-sftp', label: isSftpEnabled ? 'Close File Browser' : 'Open File Browser', icon: isSftpEnabled ? Icons.check : Icons.folder, action: onToggleSftp })
    }
    if (onDeployRemoteAgent) items.push({ id: 'deploy-remote-agent', label: 'Deploy Remote Agent', icon: Icons.deploy, action: onDeployRemoteAgent })
  }
  items.push(
    sep('multi-send-divider'),
    { id: 'multi-send', label: isMultiSendEnabled ? 'Disable Multi-Send' : 'Enable Multi-Send', icon: isMultiSendEnabled ? Icons.check : undefined, action: onToggleMultiSend },
    { id: 'select-all', label: 'Select All Tabs', icon: Icons.link, action: onSelectAllTabs },
    sep('group-divider'),
    { id: 'group-tabs', label: 'Group Tabs...', icon: Icons.grid, submenu: groupSubmenu, action: () => {} },
  )
  if (currentGroupId && onDiscoverTopology) {
    items.push(sep('discover-divider'), { id: 'discover-topology', label: 'Discover Topology', icon: Icons.discover, action: onDiscoverTopology })
  }
  items.push(
    sep('close-divider'),
    { id: 'close-tab', label: 'Close Tab', icon: Icons.close, danger: true, action: onCloseTab },
    { id: 'close-others', label: 'Close Other Tabs', icon: Icons.close, danger: true, action: onCloseOtherTabs },
  )
  if (onCloseTabsToRight) items.push({ id: 'close-right', label: 'Close Tabs to the Right', icon: Icons.closeRight, danger: true, action: onCloseTabsToRight })
  if (onCloseAllTabs) items.push({ id: 'close-all', label: 'Close All Tabs', icon: Icons.closeAll, danger: true, action: onCloseAllTabs })
  if (onReopenLastClosed) items.push({ id: 'reopen-closed', label: 'Reopen Closed Tab', icon: Icons.reopen, disabled: !canReopenClosed, action: onReopenLastClosed })

  const closeNewGroup = () => {
    newGroupAtRef.current = null
    setNewGroupAt(null)
    setNewGroupName('')
    onClose()
  }

  return (
    <>
      <ContextMenu
        position={newGroupAt ? null : position}
        items={items}
        onClose={() => { if (!newGroupAtRef.current) onClose() }}
      />
      {newGroupAt && (
        <NewGroupPrompt
          at={newGroupAt}
          name={newGroupName}
          onNameChange={setNewGroupName}
          onCancel={closeNewGroup}
          onCreate={() => {
            onCreateGroup(newGroupName.trim())
            closeNewGroup()
          }}
        />
      )}
    </>
  )
}

/** Name prompt for "New Group..." (a native menu cannot hold a text field). */
function NewGroupPrompt({ at, name, onNameChange, onCancel, onCreate }: {
  at: { x: number; y: number }
  name: string
  onNameChange: (name: string) => void
  onCancel: () => void
  onCreate: () => void
}) {
  const { ref, style } = useClampedMenuPosition(at)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [ref, onCancel])

  return (
    <div ref={ref} className="context-menu" style={style}>
      <div className="tab-new-group-prompt">
        <AITabInput
          ref={inputRef}
          aria-label="Group name"
          placeholder="Group name..."
          value={name}
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onCancel() }}
          aiField="tab group name"
          aiPlaceholder="Short name for a group of terminal tabs"
          onAIValue={onNameChange}
        />
        <DialogFooter
          primary={{ label: 'Create', onClick: onCreate, disabled: !name.trim() }}
          onCancel={onCancel}
          inline
          small
        />
      </div>
    </div>
  )
}
