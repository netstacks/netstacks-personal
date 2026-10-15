import type { SidebarNavItem } from './SidebarSections'
import './PanelTab.css'

interface PanelTabRailProps<Id extends string> {
  items: SidebarNavItem<Id>[]
  activeId: Id
  onOpen: (id: Id) => void
}

/** Docked panel tabs along the window edge (as in SecureCRT), shown while the macOS sidebar is hidden. */
export default function PanelTabRail<Id extends string>({ items, activeId, onOpen }: PanelTabRailProps<Id>) {
  return (
    <div className="panel-tab-rail" role="tablist" aria-label="Panels" aria-orientation="vertical" data-testid="panel-tab-rail">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === activeId}
          className="panel-tab"
          onClick={() => onOpen(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
