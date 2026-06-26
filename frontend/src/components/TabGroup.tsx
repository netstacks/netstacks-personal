import { useState, useCallback, useRef, useEffect } from 'react'
import './TabGroup.css'
import { useClampedMenuPosition } from '../hooks/useClampedMenuPosition'

export interface TabGroupData {
  id: string
  name: string
  tabIds: string[]
  orientation: 'horizontal' | 'vertical'
  isCollapsed: boolean
  /** Pane sizes as percentages (must sum to 100) */
  sizes?: number[]
  /** Nested child groups for complex layouts (max depth: 3) */
  children?: TabGroupData[]
  /** Nesting depth (0 = top-level) */
  depth?: number
}

interface TabGroupProps {
  group: TabGroupData
  isDefault: boolean
  children: React.ReactNode
  onRename: (name: string) => void
  onOrientationChange: (orientation: 'horizontal' | 'vertical') => void
  onCollapse: (collapsed: boolean) => void
  onCloseAll: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onSaveAsLayout?: () => void
  onUngroupAll?: () => void
}

export default function TabGroup({
  group,
  isDefault,
  children,
  onRename,
  onOrientationChange,
  onCollapse,
  onCloseAll,
  onDragOver,
  onDrop,
  onSaveAsLayout,
  onUngroupAll
}: TabGroupProps) {
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const [isRenaming, setIsRenaming] = useState(false)
  const [newName, setNewName] = useState(group.name)
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { ref: menuRef, style: menuStyle } = useClampedMenuPosition(showContextMenu ? contextMenuPos : null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  useEffect(() => {
    if (!showContextMenu) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowContextMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [showContextMenu, menuRef])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
  }, [])

  const handleRenameSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (newName.trim()) {
      onRename(newName.trim())
      setIsRenaming(false)
    }
  }, [newName, onRename])

  const handleHeaderDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
    onDragOver(e)
  }, [onDragOver])

  const handleHeaderDragLeave = useCallback(() => {
    setIsDragOver(false)
  }, [])

  const handleHeaderDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    onDrop(e)
  }, [onDrop])

  // Don't show header for default unnamed group
  if (isDefault) {
    return (
      <div className="tab-group tab-group-default">
        <div className="tab-group-tabs">{children}</div>
      </div>
    )
  }

  return (
    <div className={`tab-group ${group.isCollapsed ? 'tab-group-collapsed' : ''}`}>
      <div
        className={`tab-group-header ${isDragOver ? 'tab-group-header-drag-over' : ''}`}
        onContextMenu={handleContextMenu}
        onDragOver={handleHeaderDragOver}
        onDragLeave={handleHeaderDragLeave}
        onDrop={handleHeaderDrop}
      >
        {isRenaming ? (
          <form onSubmit={handleRenameSubmit} className="tab-group-rename-form">
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onBlur={() => {
                if (newName.trim()) {
                  onRename(newName.trim())
                }
                setIsRenaming(false)
              }}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setNewName(group.name)
                  setIsRenaming(false)
                }
              }}
            />
          </form>
        ) : (
          <>
            <button
              className="tab-group-collapse-btn"
              onClick={() => onCollapse(!group.isCollapsed)}
              title={group.isCollapsed ? 'Expand' : 'Collapse'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {group.isCollapsed ? (
                  <path d="M9 18l6-6-6-6" />
                ) : (
                  <path d="M19 9l-7 7-7-7" />
                )}
              </svg>
            </button>
            <span
              className="tab-group-name"
              onDoubleClick={() => setIsRenaming(true)}
            >
              {group.name}
            </span>
            <span className="tab-group-count">{group.tabIds.length}</span>
            <span className="tab-group-orientation" title={`Tiled ${group.orientation}`}>
              {group.orientation === 'horizontal' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="8" height="18" rx="1" />
                  <rect x="13" y="3" width="8" height="18" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="8" rx="1" />
                  <rect x="3" y="13" width="18" height="8" rx="1" />
                </svg>
              )}
            </span>
          </>
        )}
      </div>

      {!group.isCollapsed && (
        <div className="tab-group-tabs">{children}</div>
      )}

      {showContextMenu && (
        <div
          ref={menuRef}
          className="tab-group-context-menu"
          style={menuStyle}
        >
          <button
            className="tab-group-context-menu-item"
            onClick={() => {
              setIsRenaming(true)
              setShowContextMenu(false)
            }}
          >
            <span className="tab-group-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </span>
            Rename Group
          </button>

          <div className="tab-group-context-menu-divider" />

          <button
            className="tab-group-context-menu-item"
            onClick={() => {
              onOrientationChange('horizontal')
              setShowContextMenu(false)
            }}
          >
            <span className="tab-group-context-menu-icon">
              {group.orientation === 'horizontal' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </span>
            Tile Horizontally
          </button>

          <button
            className="tab-group-context-menu-item"
            onClick={() => {
              onOrientationChange('vertical')
              setShowContextMenu(false)
            }}
          >
            <span className="tab-group-context-menu-icon">
              {group.orientation === 'vertical' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </span>
            Tile Vertically
          </button>

          <div className="tab-group-context-menu-divider" />

          <button
            className="tab-group-context-menu-item"
            onClick={() => {
              onCollapse(!group.isCollapsed)
              setShowContextMenu(false)
            }}
          >
            <span className="tab-group-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {group.isCollapsed ? (
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                ) : (
                  <path d="M4 14h6v6M20 10h-6V4M4 14l6-6M20 10l-6 6" />
                )}
              </svg>
            </span>
            {group.isCollapsed ? 'Expand' : 'Collapse'}
          </button>

          <div className="tab-group-context-menu-divider" />

          {onSaveAsLayout && (
            <button
              className="tab-group-context-menu-item"
              onClick={() => {
                onSaveAsLayout()
                setShowContextMenu(false)
              }}
            >
              <span className="tab-group-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
              </span>
              Save as Layout...
            </button>
          )}

          {onUngroupAll && (
            <button
              className="tab-group-context-menu-item"
              onClick={() => {
                onUngroupAll()
                setShowContextMenu(false)
              }}
            >
              <span className="tab-group-context-menu-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </span>
              Ungroup All Tabs
            </button>
          )}

          <div className="tab-group-context-menu-divider" />

          <button
            className="tab-group-context-menu-item tab-group-context-menu-item-danger"
            onClick={() => {
              onCloseAll()
              setShowContextMenu(false)
            }}
          >
            <span className="tab-group-context-menu-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </span>
            Close All Tabs in Group
          </button>
        </div>
      )}
    </div>
  )
}
