import { useState, useRef, useEffect } from 'react'
import { MENU_MODEL, type MenuEntry } from '../commands/menuModel'
import { useCommandStore, dispatchCommand, getActiveContext } from '../commands'
import { displayShortcut } from '../hooks/useKeyboard'
import './MenuBar.css'

const PREDEFINED_LABEL: Record<string, string> = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
  selectAll: 'Select All', fullscreen: 'Toggle Full Screen', minimize: 'Minimize', maximize: 'Zoom',
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
  }
}

export default function MenuBar() {
  const [open, setOpen] = useState<string | null>(null)
  const commands = useCommandStore(s => s.commands)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const renderEntry = (entry: MenuEntry, i: number) => {
    if (entry.kind === 'separator') return <div key={i} className="menu-sep" role="separator" />
    if (entry.kind === 'predefined') {
      return (
        <button key={i} type="button" className="menu-item"
          onClick={() => { setOpen(null); void runPredefined(entry.action) }}>
          <span className="menu-item-label">{PREDEFINED_LABEL[entry.action]}</span>
        </button>
      )
    }
    const c = commands.get(entry.commandId)
    if (!c) return null
    const enabled = c.when ? c.when(getActiveContext()) : true
    return (
      <button key={i} type="button" className="menu-item" disabled={!enabled}
        onClick={() => { setOpen(null); void dispatchCommand(entry.commandId, getActiveContext()) }}>
        <span className="menu-item-label">{c.label}</span>
        {c.accelerator && <span className="menu-item-accel">{displayShortcut(c.accelerator)}</span>}
      </button>
    )
  }

  return (
    <div className="menu-bar" ref={barRef} role="menubar">
      {MENU_MODEL.map(section => (
        <div key={section.title} className="menu-section">
          <button
            type="button"
            className={`menu-top ${open === section.title ? 'active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === section.title}
            onClick={() => setOpen(o => o === section.title ? null : section.title)}
            onMouseEnter={() => { if (open) setOpen(section.title) }}
          >
            {section.title}
          </button>
          {open === section.title && (
            <div className="menu-dropdown" role="menu">
              {section.entries.map(renderEntry)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
