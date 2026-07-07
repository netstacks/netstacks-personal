import { useState, useCallback, useEffect } from 'react'
import Terminal from './Terminal'
import TabContextMenu, { type TabGroup as TabGroupType } from './TabContextMenu'
import TabGroup, { type TabGroupData } from './TabGroup'
import SplitPaneContainer, { MAX_NESTING_DEPTH } from './SplitPaneContainer'
import { useMultiSend } from '../hooks/useMultiSend'
import { useSftpStore } from '../stores/sftpStore'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'
import { listSessions } from '../api/sessions'
import { useHostnameFormatter } from '../hooks/useHostnameFormatter'
import './TerminalPanel.css'

import { logger } from '../lib/logger'
type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'local'

interface TerminalTab {
  id: string
  title: string
  groupId: string | null
  status: ConnectionStatus
  sessionColor?: string
  /** Session ID if connected to SSH session */
  sessionId?: string
}

interface TerminalPanelProps {
  isOpen: boolean
  onClose: () => void
}

export default function TerminalPanel({ isOpen, onClose }: TerminalPanelProps) {
  const formatName = useHostnameFormatter()
  const [tabs, setTabs] = useState<TerminalTab[]>([
    { id: 'terminal-1', title: 'Terminal 1', groupId: null, status: 'local' }
  ])
  const [activeTabId, setActiveTabId] = useState('terminal-1')
  const [groups, setGroups] = useState<TabGroupData[]>([])
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [dropTargetTabId, setDropTargetTabId] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null)
  const [isDragOverTabs, setIsDragOverTabs] = useState(false)

  const {
    toggleMultiSend,
    isMultiSendEnabled,
    selectAllTerminals,
    registerListener,
    broadcast
  } = useMultiSend()

  const canSftp = useCapabilitiesStore(s => s.hasFeature)('local_sftp')

  const addTerminal = useCallback(() => {
    const newId = `terminal-${Date.now()}`
    const newTab: TerminalTab = {
      id: newId,
      title: `Terminal ${tabs.length + 1}`,
      groupId: null,
      status: 'local'
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [tabs.length])

  const closeTerminal = useCallback((id: string) => {
    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== id)
      if (filtered.length === 0) {
        onClose()
        return [{ id: 'terminal-1', title: 'Terminal 1', groupId: null, status: 'local' }]
      }
      if (activeTabId === id) {
        setActiveTabId(filtered[0].id)
      }
      return filtered
    })
  }, [activeTabId, onClose])

  const closeOtherTabs = useCallback((keepId: string) => {
    setTabs(prev => {
      const kept = prev.filter(t => t.id === keepId)
      if (kept.length === 0) {
        return prev
      }
      setActiveTabId(keepId)
      return kept
    })
  }, [])

  const duplicateTab = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id)
    if (!tab) return

    const newId = `terminal-${Date.now()}`
    const newTab: TerminalTab = {
      id: newId,
      title: `${tab.title} (copy)`,
      groupId: tab.groupId,
      status: 'local',
      sessionColor: tab.sessionColor
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }, [tabs])

  // Split terminal - creates a new terminal and groups it with the current one
  const splitTerminal = useCallback((id: string | null, orientation: 'horizontal' | 'vertical') => {
    logger.log('[TerminalPanel] splitTerminal called with id:', id, 'orientation:', orientation)

    if (!id) {
      console.warn('[TerminalPanel] splitTerminal: id is null')
      return
    }

    const tab = tabs.find(t => t.id === id)
    if (!tab) {
      console.warn('[TerminalPanel] splitTerminal: tab not found for id:', id)
      return
    }

    logger.log('[TerminalPanel] splitTerminal: found tab:', tab)

    const newTerminalId = `terminal-${Date.now()}`
    const newTab: TerminalTab = {
      id: newTerminalId,
      title: `Terminal ${tabs.length + 1}`,
      groupId: null,
      status: 'local'
    }

    // Check if tab is already in a group
    if (tab.groupId) {
      // Add new terminal to existing group
      logger.log('[TerminalPanel] splitTerminal: adding to existing group:', tab.groupId)
      newTab.groupId = tab.groupId
      setTabs(prev => [...prev, newTab])
      setGroups(prev => prev.map(g =>
        g.id === tab.groupId
          ? { ...g, tabIds: [...g.tabIds, newTerminalId], orientation }
          : g
      ))
    } else {
      // Create new group with both terminals
      const newGroupId = `group-${Date.now()}`
      logger.log('[TerminalPanel] splitTerminal: creating new group:', newGroupId)
      const newGroup: TabGroupData = {
        id: newGroupId,
        name: `Split ${orientation === 'horizontal' ? 'H' : 'V'}`,
        tabIds: [id, newTerminalId],
        orientation,
        isCollapsed: false
      }

      // Update both tabs to be in the new group
      newTab.groupId = newGroupId
      setTabs(prev => {
        const updated = [
          ...prev.map(t => t.id === id ? { ...t, groupId: newGroupId } : t),
          newTab
        ]
        logger.log('[TerminalPanel] splitTerminal: updated tabs:', updated)
        return updated
      })
      setGroups(prev => {
        const updated = [...prev, newGroup]
        logger.log('[TerminalPanel] splitTerminal: updated groups:', updated)
        return updated
      })
    }

    // Keep focus on current tab (the split is visible immediately)
    setActiveTabId(id)
    logger.log('[TerminalPanel] splitTerminal: complete')
  }, [tabs])

  // Tab context menu handlers
  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
    setContextMenuTabId(tabId)
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null)
    setContextMenuTabId(null)
  }, [])

  // Group management
  const createGroup = useCallback((name: string) => {
    const newGroup: TabGroupData = {
      id: `group-${Date.now()}`,
      name,
      tabIds: [],
      orientation: 'horizontal',
      isCollapsed: false
    }

    // Move the context menu tab to the new group
    if (contextMenuTabId) {
      newGroup.tabIds.push(contextMenuTabId)
      setTabs(prev => prev.map(t =>
        t.id === contextMenuTabId ? { ...t, groupId: newGroup.id } : t
      ))
    }

    setGroups(prev => [...prev, newGroup])
  }, [contextMenuTabId])

  const moveToGroup = useCallback((groupId: string) => {
    if (!contextMenuTabId) return

    // Remove from old group
    setGroups(prev => prev.map(g => ({
      ...g,
      tabIds: g.tabIds.filter(id => id !== contextMenuTabId)
    })))

    // Add to new group
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, tabIds: [...g.tabIds, contextMenuTabId] }
        : g
    ))

    // Update tab's group reference
    setTabs(prev => prev.map(t =>
      t.id === contextMenuTabId ? { ...t, groupId } : t
    ))
  }, [contextMenuTabId])

  const removeFromGroup = useCallback(() => {
    if (!contextMenuTabId) return

    // Remove from group
    setGroups(prev => prev.map(g => ({
      ...g,
      tabIds: g.tabIds.filter(id => id !== contextMenuTabId)
    })))

    // Update tab's group reference
    setTabs(prev => prev.map(t =>
      t.id === contextMenuTabId ? { ...t, groupId: null } : t
    ))

    // Clean up empty groups
    setGroups(prev => prev.filter(g => g.tabIds.length > 0))
  }, [contextMenuTabId])

  const renameGroup = useCallback((groupId: string, name: string) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, name } : g
    ))
  }, [])

  const setGroupOrientation = useCallback((groupId: string, orientation: 'horizontal' | 'vertical') => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, orientation } : g
    ))
  }, [])

  const setGroupCollapsed = useCallback((groupId: string, collapsed: boolean) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, isCollapsed: collapsed } : g
    ))
  }, [])

  const setGroupSizes = useCallback((groupId: string, sizes: number[]) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, sizes } : g
    ))
  }, [])

  const closeGroupTabs = useCallback((groupId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group) return

    // Close all tabs in the group
    setTabs(prev => {
      const remaining = prev.filter(t => !group.tabIds.includes(t.id))
      if (remaining.length === 0) {
        onClose()
        return [{ id: 'terminal-1', title: 'Terminal 1', groupId: null, status: 'local' }]
      }
      if (group.tabIds.includes(activeTabId)) {
        setActiveTabId(remaining[0].id)
      }
      return remaining
    })

    // Remove the group
    setGroups(prev => prev.filter(g => g.id !== groupId))
  }, [groups, activeTabId, onClose])

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData('text/plain', tabId)
    e.dataTransfer.effectAllowed = 'move'
    setDraggedTabId(tabId)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedTabId(null)
    setDropTargetTabId(null)
    setDropPosition(null)
    setIsDragOverTabs(false)
  }, [])

  const handleGroupDragOver = useCallback((_groupId: string) => (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleGroupDrop = useCallback((groupId: string) => (e: React.DragEvent) => {
    e.preventDefault()
    const tabId = e.dataTransfer.getData('text/plain')
    if (!tabId || tabId === draggedTabId) return

    // Remove from old group
    setGroups(prev => prev.map(g => ({
      ...g,
      tabIds: g.tabIds.filter(id => id !== tabId)
    })))

    // Add to new group
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, tabIds: [...g.tabIds, tabId] }
        : g
    ))

    // Update tab's group reference
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, groupId } : t
    ))

    // Clean up empty groups
    setGroups(prev => prev.filter(g => g.tabIds.length > 0))
  }, [draggedTabId])

  // Handle drag over individual tabs - calculate drop position
  const handleTabDragOver = useCallback((tabId: string) => (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    if (!draggedTabId || tabId === draggedTabId) {
      setDropTargetTabId(null)
      setDropPosition(null)
      return
    }

    // Determine if drop is before or after based on mouse position
    const rect = e.currentTarget.getBoundingClientRect()
    const midpoint = rect.left + rect.width / 2
    const position = e.clientX < midpoint ? 'before' : 'after'

    setDropTargetTabId(tabId)
    setDropPosition(position)
  }, [draggedTabId])

  // Handle drop on tabs container for reordering
  const handleTabsDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOverTabs(true)
  }, [])

  const handleTabsDragLeave = useCallback(() => {
    setIsDragOverTabs(false)
  }, [])

  const handleTabsDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOverTabs(false)
    setDropTargetTabId(null)
    setDropPosition(null)

    const tabId = e.dataTransfer.getData('text/plain')
    if (!tabId || !dropTargetTabId || tabId === dropTargetTabId) return

    // Reorder tabs
    setTabs(prev => {
      const fromIndex = prev.findIndex(t => t.id === tabId)
      let toIndex = prev.findIndex(t => t.id === dropTargetTabId)

      if (fromIndex === -1 || toIndex === -1) return prev

      // Adjust target index based on drop position
      if (dropPosition === 'after') {
        toIndex = toIndex + 1
      }

      // If moving forward, adjust for the removal
      if (fromIndex < toIndex) {
        toIndex = toIndex - 1
      }

      const newTabs = [...prev]
      const [removed] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, removed)

      return newTabs
    })
  }, [dropTargetTabId, dropPosition])

  // Keyboard shortcut for multi-send toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+Shift+M - Toggle multi-send on active tab
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        toggleMultiSend(activeTabId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, toggleMultiSend])

  // Get tabs not in any group
  const ungroupedTabs = tabs.filter(t => !t.groupId)

  // Get current tab's group
  const currentTab = contextMenuTabId ? tabs.find(t => t.id === contextMenuTabId) : null
  const currentGroupId = currentTab?.groupId || null

  // Convert groups to TabGroup format for context menu
  const tabGroups: TabGroupType[] = groups.map(g => ({
    id: g.id,
    name: g.name,
    tabIds: g.tabIds,
    orientation: g.orientation
  }))

  // Recursive renderer for nested groups
  const renderGroupContent = (
    group: TabGroupData,
    groupTabs: TerminalTab[],
    depth: number = 0
  ): React.ReactNode => {
    // Check for nested child groups
    const hasChildren = group.children && group.children.length > 0

    if (hasChildren && depth < MAX_NESTING_DEPTH) {
      // Render children recursively
      return (
        <SplitPaneContainer
          orientation={group.orientation}
          sizes={group.sizes}
          onSizesChange={(sizes) => setGroupSizes(group.id, sizes)}
          depth={depth}
        >
          {group.children!.map(childGroup => {
            const childTabs = tabs.filter(t => t.groupId === childGroup.id)
            return renderGroupContent(childGroup, childTabs, depth + 1)
          })}
        </SplitPaneContainer>
      )
    }

    // Leaf node - render terminals
    if (groupTabs.length === 1) {
      return (
        <Terminal
          id={groupTabs[0].id}
          onBroadcast={broadcast}
          onRegisterBroadcastListener={registerListener}
        />
      )
    }

    // Multiple tabs at this level
    return (
      <SplitPaneContainer
        orientation={group.orientation}
        sizes={group.sizes}
        onSizesChange={(sizes) => setGroupSizes(group.id, sizes)}
        depth={depth}
      >
        {groupTabs.map(tab => (
          <Terminal
            key={tab.id}
            id={tab.id}
            onBroadcast={broadcast}
            onRegisterBroadcastListener={registerListener}
          />
        ))}
      </SplitPaneContainer>
    )
  }

  if (!isOpen) return null

  // Render a tab button
  const renderTab = (tab: TerminalTab) => {
    const isDropTarget = dropTargetTabId === tab.id
    const tabClasses = [
      'terminal-panel-tab',
      activeTabId === tab.id ? 'active' : '',
      draggedTabId === tab.id ? 'dragging' : '',
      tab.sessionColor ? 'has-session-color' : '',
      isDropTarget && dropPosition === 'before' ? 'drop-before' : '',
      isDropTarget && dropPosition === 'after' ? 'drop-after' : ''
    ].filter(Boolean).join(' ')

    const tabStyle = tab.sessionColor ? { '--session-color': tab.sessionColor } as React.CSSProperties : undefined

    return (
      <button
        key={tab.id}
        className={tabClasses}
        style={tabStyle}
        onClick={() => setActiveTabId(tab.id)}
        onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
        onAuxClick={(e) => {
          // Middle-click to close
          if (e.button === 1) {
            e.preventDefault()
            closeTerminal(tab.id)
          }
        }}
        draggable
        onDragStart={(e) => handleDragStart(e, tab.id)}
        onDragEnd={handleDragEnd}
        onDragOver={handleTabDragOver(tab.id)}
        onDragLeave={() => {
          if (dropTargetTabId === tab.id) {
            setDropTargetTabId(null)
            setDropPosition(null)
          }
        }}
      >
        <span className={`terminal-panel-tab-status ${tab.status}`} title={tab.status} />
        {isMultiSendEnabled(tab.id) && (
          <span className="terminal-panel-tab-multisend" title="Multi-send enabled">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
            </svg>
          </span>
        )}
        <span className="terminal-panel-tab-title" title={tab.title}>{formatName(tab.title)}</span>
        <button
          className="terminal-panel-tab-close"
          onClick={(e) => {
            e.stopPropagation()
            closeTerminal(tab.id)
          }}
        >
          x
        </button>
      </button>
    )
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <div className="terminal-panel-tabs-container">
          {/* Render groups first */}
          {groups.map(group => (
            <TabGroup
              key={group.id}
              group={group}
              isDefault={false}
              onRename={(name) => renameGroup(group.id, name)}
              onOrientationChange={(orientation) => setGroupOrientation(group.id, orientation)}
              onCollapse={(collapsed) => setGroupCollapsed(group.id, collapsed)}
              onCloseAll={() => closeGroupTabs(group.id)}
              onDragOver={handleGroupDragOver(group.id)}
              onDrop={handleGroupDrop(group.id)}
            >
              {tabs
                .filter(t => t.groupId === group.id)
                .map(renderTab)}
            </TabGroup>
          ))}

          {/* Render ungrouped tabs */}
          {ungroupedTabs.length > 0 && (
            <div
              className={`terminal-panel-tabs ${isDragOverTabs ? 'drag-over' : ''}`}
              onDragOver={handleTabsDragOver}
              onDragLeave={handleTabsDragLeave}
              onDrop={handleTabsDrop}
            >
              {ungroupedTabs.map(renderTab)}
            </div>
          )}

          <button className="terminal-panel-tab-add" onClick={addTerminal} title="New Terminal">
            +
          </button>
        </div>
        <div className="terminal-panel-actions">
          <button className="terminal-panel-action" onClick={onClose} title="Close Panel">
            x
          </button>
        </div>
      </div>
      <div className="terminal-panel-content">
        {/* Render grouped terminals in split panes when any tab in group is active */}
        {groups.map(group => {
          const groupTabs = tabs.filter(t => t.groupId === group.id)
          // For nested groups, check if any child group's tabs are active
          const hasNestedActive = group.children?.some(child =>
            tabs.filter(t => t.groupId === child.id).some(t => t.id === activeTabId)
          )
          const isGroupActive = groupTabs.some(t => t.id === activeTabId) || hasNestedActive

          // Only render visible if group is active
          if (!isGroupActive || (groupTabs.length === 0 && !group.children?.length)) return null

          // Use recursive renderer for potentially nested groups
          return (
            <div
              key={group.id}
              className="terminal-panel-instance active"
            >
              {renderGroupContent(group, groupTabs, group.depth ?? 0)}
            </div>
          )
        })}

        {/* Render ungrouped terminals as overlapping layers */}
        {ungroupedTabs.map(tab => (
          <div
            key={tab.id}
            className={`terminal-panel-instance ${activeTabId === tab.id ? 'active' : ''}`}
          >
            <Terminal
              id={tab.id}
              onBroadcast={broadcast}
              onRegisterBroadcastListener={registerListener}
            />
          </div>
        ))}
      </div>

      {/* Tab context menu */}
      {contextMenuTabId && (
        <TabContextMenu
          position={contextMenuPosition}
          tabId={contextMenuTabId}
          sessionId={currentTab?.sessionId}
          isMultiSendEnabled={isMultiSendEnabled(contextMenuTabId)}
          groups={tabGroups}
          currentGroupId={currentGroupId}
          onClose={closeContextMenu}
          onReconnect={() => {
            // Terminal handles auto-reconnect internally via ReconnectOverlay
            // Manual reconnect would need TerminalHandle.reconnect() to be added
          }}
          onDuplicateTab={() => duplicateTab(contextMenuTabId)}
          onSplitRight={() => splitTerminal(contextMenuTabId, 'horizontal')}
          onSplitDown={() => splitTerminal(contextMenuTabId, 'vertical')}
          onToggleMultiSend={() => toggleMultiSend(contextMenuTabId)}
          onSelectAllTabs={() => selectAllTerminals(tabs.map(t => t.id))}
          onCreateGroup={createGroup}
          onMoveToGroup={moveToGroup}
          onRemoveFromGroup={removeFromGroup}
          onCloseTab={() => closeTerminal(contextMenuTabId)}
          onCloseOtherTabs={() => closeOtherTabs(contextMenuTabId)}
          onToggleSftp={canSftp && currentTab?.sessionId ? async () => {
            const sessionId = currentTab.sessionId!
            const sftpState = useSftpStore.getState()
            const existing = sftpState.getConnectionForSession(sessionId)
            if (existing) {
              await sftpState.closeConnection(existing.id)
            } else {
              try {
                const allSessions = await listSessions()
                const session = allSessions.find(s => s.id === sessionId)
                if (session) {
                  await sftpState.openConnection({
                    sessionId: session.id,
                    deviceName: session.name,
                    cliFlavor: session.cli_flavor,
                    sftpStartPath: session.sftp_start_path || null,
                  })
                }
              } catch (err) {
                console.error('Failed to open SFTP:', err)
              }
            }
          } : undefined}
          isSftpEnabled={!!useSftpStore.getState().getConnectionForSession(currentTab?.sessionId || '')}
        />
      )}
    </div>
  )
}
