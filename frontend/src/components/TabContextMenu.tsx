import { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react'
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition'
import './TabContextMenu.css'
import { displayShortcut } from '../hooks/useKeyboard'

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
}: TabContextMenuProps) {
  const { ref: menuRef, style: menuStyle } = useClampedMenuPosition(position)
  const [showGroupSubmenu, setShowGroupSubmenu] = useState(false)
  const [showNewGroupPrompt, setShowNewGroupPrompt] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const submenuTriggerRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })

  useEffect(() => {
    if (!position) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showNewGroupPrompt) {
          setShowNewGroupPrompt(false)
          setNewGroupName('')
        } else {
          onClose()
        }
      }
    }

    // Use setTimeout to allow the menu to render before adding listener
    // This prevents the same click that opened the menu from closing it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)
    document.addEventListener('keydown', handleEscape)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [position, onClose, showNewGroupPrompt, menuRef])

  useEffect(() => {
    if (showNewGroupPrompt && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showNewGroupPrompt])

  // Position the "Group Tabs..." flyout. It is rendered position:fixed so it
  // escapes the menu's overflow clip, then measured and flipped to the left /
  // nudged up if it would run off the right or bottom edge of the window.
  useLayoutEffect(() => {
    let next: React.CSSProperties = { visibility: 'hidden' }
    if (showGroupSubmenu && submenuTriggerRef.current && submenuRef.current) {
      const margin = 8
      const trigger = submenuTriggerRef.current.getBoundingClientRect()
      const sub = submenuRef.current.getBoundingClientRect()
      let left = trigger.right
      if (left + sub.width + margin > window.innerWidth) {
        left = Math.max(margin, trigger.left - sub.width)
      }
      const top = Math.max(margin, Math.min(trigger.top, window.innerHeight - sub.height - margin))
      next = { position: 'fixed', left, top }
    }
    // Flyout placement depends on the measured DOM rect — must run post-layout.
     
    setSubmenuStyle(next)
  }, [showGroupSubmenu, groups.length, currentGroupId])

  const handleGroupSubmenuEnter = useCallback((_e: React.MouseEvent) => {
    setShowGroupSubmenu(true)
  }, [])

  const handleGroupSubmenuLeave = useCallback(() => {
    setShowGroupSubmenu(false)
  }, [])

  const handleNewGroupClick = useCallback(() => {
    setShowNewGroupPrompt(true)
    setShowGroupSubmenu(false)
  }, [])

  const handleNewGroupSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (newGroupName.trim()) {
      onCreateGroup(newGroupName.trim())
      setNewGroupName('')
      setShowNewGroupPrompt(false)
      onClose()
    }
  }, [newGroupName, onCreateGroup, onClose])

  if (!position) return null

  // Filter out the current group from move options
  const otherGroups = groups.filter(g => g.id !== currentGroupId)

  return (
    <div
      ref={menuRef}
      className="tab-context-menu"
      style={menuStyle}
    >
      {showNewGroupPrompt ? (
        <form className="tab-context-menu-new-group" onSubmit={handleNewGroupSubmit}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Group name..."
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setShowNewGroupPrompt(false)
                setNewGroupName('')
              }
            }}
          />
          <div className="tab-context-menu-new-group-actions">
            <button type="button" onClick={() => {
              setShowNewGroupPrompt(false)
              setNewGroupName('')
            }}>
              Cancel
            </button>
            <button type="submit" disabled={!newGroupName.trim()}>
              Create
            </button>
          </div>
        </form>
      ) : (
        <>
          <button className="tab-context-menu-item" onClick={() => { onReconnect(); onClose(); }}>
            <span className="tab-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 2v6h-6M3 22v-6h6M21 13a9 9 0 11-3-6.35M3 11a9 9 0 013 6.35" />
              </svg>
            </span>
            Reconnect
          </button>

          <button className="tab-context-menu-item" onClick={() => { onDuplicateTab(); onClose(); }}>
            <span className="tab-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </span>
            Duplicate Tab
          </button>

          {onPopOut && (
            <button className="tab-context-menu-item" onClick={() => { onPopOut(); onClose(); }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </span>
              Pop Out Terminal
            </button>
          )}

          {selectedTabCount !== undefined && selectedTabCount >= 2 && onGroupSelectedTabs && (
            <>
              <div className="tab-context-menu-divider" />
              <button className="tab-context-menu-item tab-context-menu-item-accent" onClick={() => { onGroupSelectedTabs(); onClose(); }}>
                <span className="tab-context-menu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                  </svg>
                </span>
                Group Selected Tabs ({selectedTabCount})
                <span className="tab-context-menu-shortcut">{displayShortcut('⌘G')}</span>
              </button>
            </>
          )}

          {onSplitRight && (
            <button className="tab-context-menu-item" onClick={() => {
              onSplitRight();
              onClose();
            }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="8" height="18" rx="1" />
                  <rect x="13" y="3" width="8" height="18" rx="1" />
                </svg>
              </span>
              Split Right
            </button>
          )}

          {onSplitDown && (
            <button className="tab-context-menu-item" onClick={() => {
              onSplitDown();
              onClose();
            }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="8" rx="1" />
                  <rect x="3" y="13" width="18" height="8" rx="1" />
                </svg>
              </span>
              Split Down
            </button>
          )}

          {sessionId && onSessionSettings && (
            <button className="tab-context-menu-item" onClick={() => { onSessionSettings(); onClose(); }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
              </span>
              Session Settings
            </button>
          )}

          {sessionId && onOpenDeviceDetails && (
            <button className="tab-context-menu-item" onClick={() => { onOpenDeviceDetails(); onClose(); }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </span>
              Device Details
            </button>
          )}

          {sessionId && onShareSession && (
            <button className="tab-context-menu-item" onClick={() => { onShareSession(); onClose(); }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
              </span>
              Share Session
            </button>
          )}

          {sessionId && onToggleSftp && (
            <button className="tab-context-menu-item" onClick={() => { onToggleSftp(); onClose(); }}>
              <span className="tab-context-menu-icon">
                {isSftpEnabled ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M14.5 3H7.71l-.85-.85A.5.5 0 006.5 2h-5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-10a.5.5 0 00-.5-.5z" />
                  </svg>
                )}
              </span>
              {isSftpEnabled ? 'Close File Browser' : 'Open File Browser'}
            </button>
          )}

          {sessionId && onDeployRemoteAgent && (
            <button className="tab-context-menu-item" onClick={() => { onDeployRemoteAgent(); onClose(); }}>
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
                  <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h5v2H5v1h6v-1H9v-2h5a1 1 0 001-1V2a1 1 0 00-1-1zm0 9H2V2h12v8z"/>
                  <path d="M7 5.5l-.5 1h1L7 5.5zm-1 1.5H5l-.5 1h1L6 7zm2 0h-1l-.5 1h1L8 7z" opacity=".6"/>
                </svg>
              </span>
              Deploy Remote Agent
            </button>
          )}

          <div className="tab-context-menu-divider" />

          <button className="tab-context-menu-item" onClick={() => { onToggleMultiSend(); onClose(); }}>
            <span className="tab-context-menu-icon">
              {isMultiSendEnabled ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : null}
            </span>
            {isMultiSendEnabled ? 'Disable Multi-Send' : 'Enable Multi-Send'}
          </button>

          <button className="tab-context-menu-item" onClick={() => { onSelectAllTabs(); onClose(); }}>
            <span className="tab-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
            </span>
            Select All Tabs
          </button>

          <div className="tab-context-menu-divider" />

          <div
            ref={submenuTriggerRef}
            className="tab-context-menu-item tab-context-menu-item-submenu"
            onMouseEnter={handleGroupSubmenuEnter}
            onMouseLeave={handleGroupSubmenuLeave}
          >
            <span className="tab-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </span>
            Group Tabs...
            <span className="tab-context-menu-arrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </span>

            {showGroupSubmenu && (
              <div
                ref={submenuRef}
                className="tab-context-menu-submenu"
                style={submenuStyle}
              >
                <button className="tab-context-menu-item" onClick={handleNewGroupClick}>
                  <span className="tab-context-menu-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </span>
                  New Group...
                </button>

                {otherGroups.length > 0 && (
                  <>
                    <div className="tab-context-menu-divider" />
                    {otherGroups.map(group => (
                      <button
                        key={group.id}
                        className="tab-context-menu-item"
                        onClick={() => { onMoveToGroup(group.id); onClose(); }}
                      >
                        <span className="tab-context-menu-icon" />
                        Move to "{group.name}"
                      </button>
                    ))}
                  </>
                )}

                {currentGroupId && (
                  <>
                    <div className="tab-context-menu-divider" />
                    <button className="tab-context-menu-item" onClick={() => { onRemoveFromGroup(); onClose(); }}>
                      <span className="tab-context-menu-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </span>
                      Remove from Group
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Discover Topology - only show when tab is in a group */}
          {currentGroupId && onDiscoverTopology && (
            <>
              <div className="tab-context-menu-divider" />
              <button className="tab-context-menu-item tab-context-menu-item-accent" onClick={() => { onDiscoverTopology(); onClose(); }}>
                <span className="tab-context-menu-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="5" r="3" />
                    <circle cx="5" cy="19" r="3" />
                    <circle cx="19" cy="19" r="3" />
                    <path d="M12 8v4M9.5 16.5l2.5-4.5M14.5 16.5l-2.5-4.5" />
                  </svg>
                </span>
                Discover Topology
              </button>
            </>
          )}

          <div className="tab-context-menu-divider" />

          <button className="tab-context-menu-item tab-context-menu-item-danger" onClick={() => { onCloseTab(); onClose(); }}>
            <span className="tab-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </span>
            Close Tab
          </button>

          <button className="tab-context-menu-item tab-context-menu-item-danger" onClick={() => { onCloseOtherTabs(); onClose(); }}>
            <span className="tab-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </span>
            Close Other Tabs
          </button>

          {onCloseTabsToRight && (
            <button
              className="tab-context-menu-item tab-context-menu-item-danger"
              onClick={() => { onCloseTabsToRight(); onClose(); }}
            >
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
              Close Tabs to the Right
            </button>
          )}

          {onCloseAllTabs && (
            <button
              className="tab-context-menu-item tab-context-menu-item-danger"
              onClick={() => { onCloseAllTabs(); onClose(); }}
            >
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                  <path d="M14 2L2 14" />
                </svg>
              </span>
              Close All Tabs
            </button>
          )}

          {onReopenLastClosed && (
            <button
              className="tab-context-menu-item"
              onClick={() => { onReopenLastClosed(); onClose(); }}
              disabled={!canReopenClosed}
              title={canReopenClosed ? 'Reopen the most recently closed tab' : 'No closed tabs to reopen'}
            >
              <span className="tab-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                </svg>
              </span>
              Reopen Closed Tab
            </button>
          )}
        </>
      )}
    </div>
  )
}
