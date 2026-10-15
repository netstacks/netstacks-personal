import type { KeyboardEvent, ReactNode } from 'react'
import Tooltip from './Tooltip'
import './SidebarSections.css'

export interface SidebarNavItem<Id extends string = string> {
  id: Id
  label: string
  icon: ReactNode
  testId?: string
}

interface SidebarSectionsProps<Id extends string> {
  items: SidebarNavItem<Id>[]
  activeId: Id
  onSelect: (id: Id) => void
  /** Small controls after the capsule (the sidebar pin). */
  trailing: ReactNode
}

const optionId = (id: string) => `sidebar-section-${id.replace(/[^a-z0-9-]/gi, '-')}`

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * macOS navigator bar (as in Xcode): the sidebar views as one full-width capsule
 * of icons. Settings live in the app menu (⌘,), as in native macOS apps.
 */
export default function SidebarSections<Id extends string>({ items, activeId, onSelect, trailing }: SidebarSectionsProps<Id>) {
  const handleKeyDown = (e: KeyboardEvent) => {
    const step = STEP[e.key]
    if (!step || items.length === 0) return
    e.preventDefault()
    const index = items.findIndex(item => item.id === activeId)
    onSelect(items[Math.min(items.length - 1, Math.max(0, index + step))].id)
  }

  return (
    <nav className="sidebar-sections" aria-label="Sidebar">
      <div
        className="sidebar-sections-bar"
        role="listbox"
        tabIndex={0}
        aria-label="Navigate"
        aria-orientation="horizontal"
        aria-activedescendant={items.some(i => i.id === activeId) ? optionId(activeId) : undefined}
        onKeyDown={handleKeyDown}
      >
        {items.map(item => (
          <Tooltip key={item.id} label={item.label}>
            <div
              id={optionId(item.id)}
              role="option"
              aria-label={item.label}
              aria-selected={item.id === activeId}
              className="sidebar-section"
              data-testid={item.testId}
              onClick={() => onSelect(item.id)}
            >
              {item.icon}
            </div>
          </Tooltip>
        ))}
      </div>
      {trailing}
    </nav>
  )
}
