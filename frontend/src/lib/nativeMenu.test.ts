import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => {
  const created: Array<{ kind: string; opts: Record<string, unknown>; close: ReturnType<typeof vi.fn> }> = []
  const popup = vi.fn().mockResolvedValue(undefined)
  const menuClose = vi.fn().mockResolvedValue(undefined)
  const make = (kind: string) => async (opts: Record<string, unknown>) => {
    const entry = { kind, opts, close: vi.fn().mockResolvedValue(undefined) }
    created.push(entry)
    return entry
  }
  return { created, popup, menuClose, makeItem: make('item'), makeSeparator: make('separator'), makeSubmenu: make('submenu'), makeCheck: make('check') }
})

vi.mock('@tauri-apps/api/menu', () => ({
  MenuItem: { new: api.makeItem },
  PredefinedMenuItem: { new: api.makeSeparator },
  Submenu: { new: api.makeSubmenu },
  CheckMenuItem: { new: api.makeCheck },
  Menu: { new: vi.fn(async () => ({ popup: api.popup, close: api.menuClose })) },
}))

import { popupNativeMenu } from './nativeMenu'

beforeEach(() => {
  api.created.length = 0
  vi.clearAllMocks()
})

describe('popupNativeMenu', () => {
  it('maps items, separators, disabled state and shortcuts to native menu items', async () => {
    const action = vi.fn()
    await popupNativeMenu([
      { id: 'copy', label: 'Copy', shortcut: 'Cmd+C', action },
      { id: 'sep', label: '', divider: true, action: () => {} },
      { id: 'del', label: 'Delete', shortcut: 'Del', disabled: true, action: () => {} },
    ], { x: 10, y: 20 })

    expect(api.created.map(c => c.kind)).toEqual(['item', 'separator', 'item'])
    expect(api.created[0].opts).toMatchObject({ text: 'Copy', enabled: true, accelerator: 'CmdOrCtrl+C' })
    expect(api.created[1].opts).toEqual({ item: 'Separator' })
    expect(api.created[2].opts).toMatchObject({ enabled: false, accelerator: 'Delete' })

    ;(api.created[0].opts.action as () => void)()
    expect(action).toHaveBeenCalled()
  })

  it('pops up at the given logical position and frees the menu afterwards', async () => {
    await popupNativeMenu([{ id: 'a', label: 'A', action: () => {} }], { x: 5, y: 7 })
    expect(api.popup).toHaveBeenCalledWith(expect.objectContaining({ x: 5, y: 7 }))
    expect(api.menuClose).toHaveBeenCalled()
    expect(api.created[0].close).toHaveBeenCalled()
  })

  it('nests submenus and frees their items too', async () => {
    const move = vi.fn()
    await popupNativeMenu([
      { id: 'group', label: 'Group Tabs...', action: () => {}, submenu: [
        { id: 'move', label: 'Move to "Core"', action: move },
      ] },
    ], { x: 0, y: 0 })

    const sub = api.created.find(c => c.kind === 'submenu')!
    const child = api.created.find(c => c.kind === 'item')!
    expect(sub.opts).toMatchObject({ text: 'Group Tabs...', enabled: true })
    expect(sub.opts.items).toEqual([child])
    ;(child.opts.action as () => void)()
    expect(move).toHaveBeenCalled()
    expect(sub.close).toHaveBeenCalled()
    expect(child.close).toHaveBeenCalled()
  })

  it('renders checked state as a native check item', async () => {
    await popupNativeMenu([
      { id: 'h', label: 'Tile Horizontally', checked: true, action: () => {} },
      { id: 'v', label: 'Tile Vertically', checked: false, action: () => {} },
    ], { x: 0, y: 0 })
    expect(api.created.map(c => c.kind)).toEqual(['check', 'check'])
    expect(api.created[0].opts).toMatchObject({ text: 'Tile Horizontally', checked: true })
    expect(api.created[1].opts).toMatchObject({ checked: false })
  })

  it('namespaces item ids per popup so they never collide with menu-bar ids', async () => {
    await popupNativeMenu([{ id: 'close-tab', label: 'Close Tab', action: () => {} }], { x: 0, y: 0 })
    await popupNativeMenu([{ id: 'close-tab', label: 'Close Tab', action: () => {} }], { x: 0, y: 0 })
    const [first, second] = api.created.map(c => c.opts.id as string)
    expect(first).toMatch(/^ctx-\d+-close-tab$/)
    expect(second).toMatch(/^ctx-\d+-close-tab$/)
    expect(first).not.toBe(second)
  })
})
