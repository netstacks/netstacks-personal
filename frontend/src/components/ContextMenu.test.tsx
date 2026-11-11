import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor, screen, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'

const popupNativeMenu = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../lib/nativeMenu', () => ({ popupNativeMenu }))

import ContextMenu, { type MenuItem } from './ContextMenu'
import { __resetPlatformForTests } from '../utils/platform'

const items: MenuItem[] = [
  { id: 'copy', label: 'Copy', shortcut: 'Cmd+C', icon: <svg />, action: () => {} },
]

function setPlatform(platform: 'macos' | 'windows', tauri: boolean) {
  vi.stubGlobal('location', { ...window.location, search: `?platform=${platform}` })
  __resetPlatformForTests()
  if (tauri) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetPlatformForTests()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  popupNativeMenu.mockClear()
})

describe('ContextMenu', () => {
  it('uses a native menu on macOS under Tauri and renders no HTML menu', async () => {
    setPlatform('macos', true)
    const onClose = vi.fn()
    const { container } = render(<ContextMenu position={{ x: 3, y: 4 }} items={items} onClose={onClose} />)
    expect(container.querySelector('.context-menu')).toBeNull()
    expect(popupNativeMenu).toHaveBeenCalledWith(items, { x: 3, y: 4 })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('renders the HTML menu on Windows, with the shortcut formatted for the platform', () => {
    setPlatform('windows', true)
    const { container } = render(<ContextMenu position={{ x: 3, y: 4 }} items={items} onClose={() => {}} />)
    expect(container.querySelector('.context-menu')).not.toBeNull()
    expect(container.querySelector('.context-menu-shortcut')?.textContent).toBe('Ctrl+C')
    expect(popupNativeMenu).not.toHaveBeenCalled()
  })

  it('renders the HTML menu on macOS in the browser build (no native menus there)', () => {
    setPlatform('macos', false)
    const { container } = render(<ContextMenu position={{ x: 3, y: 4 }} items={items} onClose={() => {}} />)
    expect(container.querySelector('.context-menu')).not.toBeNull()
    expect(popupNativeMenu).not.toHaveBeenCalled()
  })
})

describe('HTML context menu keyboard and semantics', () => {
  const keyboardItems = (actions: Record<string, () => void> = {}): MenuItem[] => [
    { id: 'open', label: 'Open', action: actions.open ?? (() => {}) },
    { id: 'gone', label: 'Disabled', disabled: true, action: () => {} },
    { id: 'div', label: '', divider: true, action: () => {} },
    { id: 'group', label: 'Group Tabs', action: () => {}, submenu: [
      { id: 'g1', label: 'Alpha', action: actions.alpha ?? (() => {}) },
      { id: 'g2', label: 'Beta', checked: true, action: () => {} },
    ] },
    { id: 'rename', label: 'Rename', action: () => {} },
  ]

  /** A trigger button that opens the menu, so focus return can be observed. */
  function Harness({ items: menuItemsProp, onClose = () => {} }: { items: MenuItem[]; onClose?: () => void }) {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
    return (
      <>
        <button onClick={() => setPos({ x: 10, y: 10 })}>Trigger</button>
        <ContextMenu position={pos} items={menuItemsProp} onClose={() => { setPos(null); onClose() }} />
      </>
    )
  }

  const openMenu = () => {
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    return trigger
  }

  it('exposes menu semantics: menu, menuitem, menuitemcheckbox, separator, submenu popup', () => {
    setPlatform('windows', false)
    render(<Harness items={keyboardItems()} />)
    openMenu()
    const menu = screen.getByRole('menu')
    expect(menu).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent?.replace('▶', '').trim())).toEqual(['Open', 'Disabled', 'Group Tabs', 'Rename'])
    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Group Tabs/ })).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('focuses the first enabled item, moves with wrapping arrows and Home/End, skipping disabled rows', () => {
    setPlatform('windows', false)
    render(<Harness items={keyboardItems()} />)
    openMenu()
    const name = () => document.activeElement?.textContent?.replace('▶', '').trim()
    expect(name()).toBe('Open')
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(name()).toBe('Group Tabs')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(name()).toBe('Rename')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(name()).toBe('Open')
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(name()).toBe('Rename')
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(name()).toBe('Open')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(name()).toBe('Rename')
    fireEvent.keyDown(menu, { key: 'g' })
    expect(name()).toBe('Group Tabs')
  })

  it('opens a submenu with ArrowRight, focuses its first item, and ArrowLeft returns to the row', async () => {
    setPlatform('windows', false)
    render(<Harness items={keyboardItems()} />)
    openMenu()
    const row = screen.getByRole('menuitem', { name: /Group Tabs/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Alpha'))
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const flyout = screen.getByRole('menu', { name: 'Group Tabs' })
    expect(screen.getByRole('menuitemcheckbox', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(flyout, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(row)
    expect(screen.queryByRole('menu', { name: 'Group Tabs' })).toBeNull()
  })

  it('Escape inside a submenu closes only the submenu', async () => {
    setPlatform('windows', false)
    const onClose = vi.fn()
    render(<Harness items={keyboardItems()} onClose={onClose} />)
    openMenu()
    const row = screen.getByRole('menuitem', { name: /Group Tabs/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Alpha'))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.activeElement).toBe(row)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape closes the menu and returns focus to the element that opened it', async () => {
    setPlatform('windows', false)
    render(<Harness items={keyboardItems()} />)
    const trigger = openMenu()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('choosing an item runs it and closes the menu', () => {
    setPlatform('windows', false)
    const open = vi.fn()
    render(<Harness items={keyboardItems({ open })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect(open).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
