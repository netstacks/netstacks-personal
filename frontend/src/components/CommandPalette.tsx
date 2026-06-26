import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  dispatchCommand,
  getActiveContext,
  useActiveContextStore,
  useCommandStore,
  type Command as RegistryCommand,
} from '../commands'
import './CommandPalette.css'

/**
 * Legacy prop shape for ad-hoc commands. The palette now also reads
 * the global CommandRegistry — adding new commands should go through
 * useCommand(), not this prop. Kept for backward compatibility with
 * a handful of view-switch entries in App.tsx that haven't migrated.
 */
export interface Command {
  id: string
  label: string
  category?: string
  shortcut?: string
  action: () => void
}

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  commands: Command[]
}

/** Internal row shape unifying legacy and registry-sourced commands. */
interface Row {
  id: string
  label: string
  category: string
  shortcut: string | undefined
  description: string | undefined
  enabled: boolean
  run: () => void
}

/** Convert a registry Command into a palette row, gated by ActiveContext. */
function rowFromRegistry(cmd: RegistryCommand, onClose: () => void): Row {
  const enabled = cmd.when ? cmd.when(getActiveContext()) : true
  return {
    id: `cmd:${cmd.id}`,
    label: cmd.label,
    category: cmd.category,
    shortcut: cmd.accelerator,
    description: cmd.description,
    enabled,
    run: () => {
      onClose()
      void dispatchCommand(cmd.id, getActiveContext())
    },
  }
}

function rowFromLegacy(cmd: Command, onClose: () => void): Row {
  return {
    id: `legacy:${cmd.id}`,
    label: cmd.label,
    category: cmd.category ?? 'Other',
    shortcut: cmd.shortcut,
    description: undefined,
    enabled: true,
    run: () => {
      cmd.action()
      onClose()
    },
  }
}

/** Pretty-printer for Tauri accelerator strings (CmdOrCtrl+Shift+P → ⌘⇧P). */
function fmtShortcut(acc: string | undefined): string | undefined {
  if (!acc) return undefined
  return acc
    .replace(/CmdOrCtrl/g, '⌘')
    .replace(/Cmd/g, '⌘')
    .replace(/Ctrl/g, '⌃')
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g, '⌥')
    .replace(/Return/g, '⏎')
    .replace(/\+/g, '')
}

export default function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Subscribe to both stores so a tab switch / new command registration
  // refreshes the filtered list while the palette is open.
  const registryCommands = useCommandStore((s) => s.commands)
  useActiveContextStore((s) => s)

  // Merge registry-sourced rows with legacy prop-sourced rows. Legacy
  // entries with a matching label get dropped to avoid duplicates
  // while App.tsx still hands a partial list through the prop.
  const allRows = useMemo<Row[]>(() => {
    const fromRegistry = Array.from(registryCommands.values())
      .map((c) => rowFromRegistry(c, onClose))
    const registryLabels = new Set(fromRegistry.map((r) => r.label.toLowerCase()))
    const fromLegacy = commands
      .filter((c) => !registryLabels.has(c.label.toLowerCase()))
      .map((c) => rowFromLegacy(c, onClose))
    return [...fromRegistry, ...fromLegacy]
  }, [registryCommands, commands, onClose])

  // Filter + sort. Enabled rows first, then alphabetical inside each
  // enabled/disabled group. Match against label + category for a forgiving
  // search experience.
  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matched = allRows.filter((r) =>
      !q ||
      r.label.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q) ||
      (r.description?.toLowerCase().includes(q) ?? false),
    )
    return matched.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return a.label.localeCompare(b.label)
    })
  }, [allRows, search])

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setSearch('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isOpen])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && filteredCommands.length > 0) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex, filteredCommands.length])

  // Handle keyboard navigation. Disabled rows are skipped on
  // arrow navigation so the user can't accidentally land on
  // (and try to run) an inert entry.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'Tab': {
        if (e.key === 'Tab' && e.shiftKey) {
          e.preventDefault()
          setSelectedIndex(i => Math.max(i - 1, 0))
          return
        }
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1))
        break
      }
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter': {
        e.preventDefault()
        const target = filteredCommands[selectedIndex]
        if (target?.enabled) target.run()
        break
      }
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }, [filteredCommands, selectedIndex, onClose])

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [search])

  if (!isOpen) return null

  return (
    <div className="command-palette-overlay" data-testid="command-palette" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <div className="command-palette-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input" data-testid="command-palette-input"
            placeholder="Type a command..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="command-palette-list" ref={listRef}>
          {filteredCommands.length === 0 ? (
            <div className="command-palette-empty">No commands found</div>
          ) : (
            filteredCommands.map((cmd, index) => (
              <div
                key={cmd.id}
                className={`command-palette-item ${index === selectedIndex ? 'selected' : ''} ${cmd.enabled ? '' : 'disabled'}`}
                onClick={() => {
                  if (cmd.enabled) cmd.run()
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                title={cmd.enabled
                  ? cmd.description ?? cmd.label
                  : 'Not available in the current context'}
              >
                <span className="command-palette-category">{cmd.category}</span>
                <span className="command-label">{cmd.label}</span>
                {cmd.shortcut && (
                  <span className="command-shortcut">{fmtShortcut(cmd.shortcut)}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
