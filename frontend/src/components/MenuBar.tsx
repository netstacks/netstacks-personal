import { useState, useRef, useEffect, useCallback } from 'react'
import { MENU_MODEL, type MenuEntry } from '../commands/menuModel'
import { useCommandStore, dispatchCommand, getActiveContext } from '../commands'
import { currentAcceleratorForCommand } from '../commands/keybindingLinks'
import { displayShortcut, useKeybindings } from '../hooks/useKeyboard'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import './MenuBar.css'

const PREDEFINED_LABEL: Record<string, string> = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
  selectAll: 'Select All', fullscreen: 'Toggle Full Screen', minimize: 'Minimize', maximize: 'Zoom',
  exit: 'Exit',
}

/** Alt-mnemonic index per top-level menu: first letter not taken by an earlier menu. */
function mnemonicIndexes(titles: string[]): number[] {
  const used = new Set<string>()
  return titles.map(title => {
    const index = [...title].findIndex(ch => /[a-z]/i.test(ch) && !used.has(ch.toLowerCase()))
    if (index >= 0) used.add(title[index].toLowerCase())
    return index
  })
}

const TITLES = MENU_MODEL.map(s => s.title)
const MNEMONIC_INDEX = mnemonicIndexes(TITLES)
const MNEMONIC_KEY = TITLES.map((t, i) => (MNEMONIC_INDEX[i] >= 0 ? t[MNEMONIC_INDEX[i]].toLowerCase() : ''))

/**
 * Alt belongs to the focused surface when it is the terminal (readline Alt+F/B/…)
 * or Monaco, as in VS Code, or a modal / the command palette (focus is trapped there).
 */
function menuKeysBlocked(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(
    '.xterm, .monaco-editor, [aria-modal="true"], [role="dialog"], [role="alertdialog"], .command-palette-overlay',
  ) !== null
}

async function runPredefined(action: string) {
  switch (action) {
    case 'undo': case 'redo': case 'cut': case 'copy': case 'paste':
      document.execCommand(action); return
    case 'selectAll': document.execCommand('selectAll'); return
    case 'minimize': (await import('@tauri-apps/api/window')).getCurrentWindow().minimize(); return
    case 'maximize': (await import('@tauri-apps/api/window')).getCurrentWindow().toggleMaximize(); return
    case 'fullscreen': {
      const w = (await import('@tauri-apps/api/window')).getCurrentWindow()
      const on = await w.isFullscreen(); await w.setFullscreen(!on); return
    }
    // Same path as the title-bar X: close-requested → App's NS-APP-12
    // prompt about live sessions / unsaved edits → destroy.
    case 'exit': (await import('@tauri-apps/api/window')).getCurrentWindow().close(); return
  }
}

function MenuTitle({ title, index }: { title: string; index: number }) {
  const m = MNEMONIC_INDEX[index]
  if (m < 0) return <>{title}</>
  return <>{title.slice(0, m)}<u className="mnemonic">{title[m]}</u>{title.slice(m + 1)}</>
}

export default function MenuBar() {
  // Re-render when the user rebinds a shortcut so accelerators stay current.
  useKeybindings()
  const [open, setOpen] = useState<string | null>(null)
  const [altHeld, setAltHeld] = useState(false)
  const [keyboardMode, setKeyboardMode] = useState(false)
  // Set when a menu was opened from the keyboard: focus its first item once rendered.
  const focusFirstItem = useRef(false)
  const commands = useCommandStore(s => s.commands)
  const barRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])
  // Where focus returns when a keyboard-opened menu closes.
  const returnFocusTo = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open || !returnFocusTo.current) return
    const target = returnFocusTo.current
    returnFocusTo.current = null
    target.focus()
  }, [open])

  const openFromKeyboard = useCallback((index: number) => {
    if (!openRef.current) returnFocusTo.current = document.activeElement as HTMLElement | null
    setOpen(TITLES[(index + TITLES.length) % TITLES.length])
    setKeyboardMode(true)
    focusFirstItem.current = true
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  useOverlayDismiss({ onDismiss: () => setOpen(null), enabled: open !== null, clickOutside: false })

  useEffect(() => {
    if (!open || !focusFirstItem.current) return
    focusFirstItem.current = false
    dropdownRef.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus()
  }, [open])

  // Alt mnemonics: Alt+<letter> opens that menu; a bare Alt press+release opens the first.
  useEffect(() => {
    let bareAlt = false
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        bareAlt = !e.repeat && !menuKeysBlocked(e.target)
        if (bareAlt) setAltHeld(true)
        return
      }
      bareAlt = false
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || menuKeysBlocked(e.target)) return
      const index = MNEMONIC_KEY.indexOf(e.key.toLowerCase())
      if (index < 0) return
      e.preventDefault()
      openFromKeyboard(index)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      setAltHeld(false)
      if (!bareAlt) return
      bareAlt = false
      e.preventDefault()
      if (openRef.current) setOpen(null)
      else openFromKeyboard(0)
    }
    const cancelBareAlt = () => { bareAlt = false }
    // Alt+Tab away swallows the keyup: never come back with a stale Alt state.
    const onWindowBlur = () => {
      bareAlt = false
      setAltHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('mousedown', cancelBareAlt)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousedown', cancelBareAlt)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [openFromKeyboard])

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return
    const current = TITLES.indexOf(open)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      openFromKeyboard(current + (e.key === 'ArrowRight' ? 1 : -1))
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(dropdownRef.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next].focus()
  }

  const renderEntry = (entry: MenuEntry, i: number) => {
    if (entry.kind === 'separator') return <div key={i} className="menu-sep" role="separator" />
    if (entry.kind === 'predefined') {
      return (
        <button key={i} type="button" role="menuitem" className="menu-item"
          onClick={() => { setOpen(null); void runPredefined(entry.action) }}>
          <span className="menu-item-label">{PREDEFINED_LABEL[entry.action]}</span>
        </button>
      )
    }
    const c = commands.get(entry.commandId)
    if (!c) return null
    const enabled = c.when ? c.when(getActiveContext()) : true
    const accel = currentAcceleratorForCommand(c.id, c.accelerator)
    return (
      <button key={i} type="button" role="menuitem" className="menu-item" disabled={!enabled}
        onClick={() => { setOpen(null); void dispatchCommand(entry.commandId, getActiveContext()) }}>
        <span className="menu-item-label">{c.label}</span>
        {accel && <span className="menu-item-accel">{displayShortcut(accel)}</span>}
      </button>
    )
  }

  return (
    <div
      className={`menu-bar${altHeld || (open && keyboardMode) ? ' show-mnemonics' : ''}`}
      ref={barRef}
      role="menubar"
      onKeyDown={handleMenuKeyDown}
    >
      {MENU_MODEL.map((section, index) => (
        <div key={section.title} className="menu-section">
          {/* Not a Tab stop: native Windows/GTK menu bars are reached with Alt. */}
          <button
            type="button"
            tabIndex={-1}
            className={`menu-top ${open === section.title ? 'active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === section.title}
            onClick={() => {
              setKeyboardMode(false)
              setOpen(o => o === section.title ? null : section.title)
            }}
            onMouseEnter={() => { if (open) setOpen(section.title) }}
          >
            <MenuTitle title={section.title} index={index} />
          </button>
          {open === section.title && (
            <div className="menu-dropdown" role="menu" ref={dropdownRef}>
              {section.entries.map(renderEntry)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
