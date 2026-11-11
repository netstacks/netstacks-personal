// Native (NSMenu) context menus for macOS under Tauri.
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { toAccelerator } from '../commands/keybindingLinks'

export interface NativeMenuItem {
  id: string
  label: string
  /** Keybinding (e.g. "Cmd+I", "Del"); shown as the native key equivalent. */
  shortcut?: string
  disabled?: boolean
  divider?: boolean
  /** Shows a checkmark state (a native check item). */
  checked?: boolean
  submenu?: NativeMenuItem[]
  action: () => void
}

type NativeEntry = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu

// Popup items share the app-wide menu event channel with the menu bar (main.rs
// emits `menu://<id>` and MenuBridge runs the matching command), so each popup
// namespaces its ids: `close-tab` here must never also fire File → Close Tab.
let popupSeq = 0

/** Builds the entries for one menu level; every created resource is pushed to `created` for freeing. */
async function buildEntries(items: NativeMenuItem[], prefix: string, created: NativeEntry[]): Promise<NativeEntry[]> {
  return Promise.all(items.map(async (item) => {
    const id = `${prefix}${item.id}`
    const opts = {
      id,
      text: item.label,
      enabled: !item.disabled,
      accelerator: item.shortcut ? toAccelerator(item.shortcut) : undefined,
      action: item.action,
    }
    const entry: NativeEntry = item.divider
      ? await PredefinedMenuItem.new({ item: 'Separator' })
      : item.submenu
        ? await Submenu.new({ id, text: item.label, enabled: !item.disabled, items: await buildEntries(item.submenu, prefix, created) })
        : item.checked === undefined
          ? await MenuItem.new(opts)
          : await CheckMenuItem.new({ ...opts, checked: item.checked })
    created.push(entry)
    return entry
  }))
}

/** Shows the menu at a point in the window; resolves once it has closed. */
export async function popupNativeMenu(items: NativeMenuItem[], at: { x: number; y: number }): Promise<void> {
  const created: NativeEntry[] = []
  const menu = await Menu.new({ items: await buildEntries(items, `ctx-${++popupSeq}-`, created) })
  try {
    await menu.popup(new LogicalPosition(at.x, at.y))
  } finally {
    await Promise.all([menu.close(), ...created.map(entry => entry.close())])
  }
}
