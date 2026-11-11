/**
 * KeyboardSettings - UI for customizing keyboard shortcuts
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  KEYBOARD_ACTIONS,
  KEYBOARD_CATEGORIES,
  type KeyboardAction,
  type KeybindingConflict,
  type UseKeyboardReturn,
  eventToBinding,
  formatShortcut,
  isMac,
} from '../hooks/useKeyboard'
import SearchField from './SearchField'
import { useMode } from '../hooks/useMode'
import './KeyboardSettings.css'

import DialogFooter from './DialogFooter'
import Tooltip from './Tooltip'
import SettingsSection from './settings/SettingsSection'
import SettingsItem from './settings/SettingsItem'
interface KeyboardSettingsProps {
  keyboard: UseKeyboardReturn
}

export default function KeyboardSettings({ keyboard }: KeyboardSettingsProps) {
  const { isEnterprise } = useMode()
  const [search, setSearch] = useState('')
  const [editingAction, setEditingAction] = useState<KeyboardAction | null>(null)
  const [pendingBinding, setPendingBinding] = useState<string>('')
  const [conflict, setConflict] = useState<KeybindingConflict | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Filter actions by search (label, category, or the current chord)
  const filteredActions = useMemo(() => {
    const modeActions = isEnterprise ? KEYBOARD_ACTIONS.filter(a => !a.standaloneOnly) : KEYBOARD_ACTIONS
    if (!search.trim()) return modeActions

    const searchLower = search.toLowerCase()
    return modeActions.filter(
      a =>
        a.label.toLowerCase().includes(searchLower) ||
        a.category.toLowerCase().includes(searchLower) ||
        keyboard.getBinding(a.id).toLowerCase().includes(searchLower) ||
        formatShortcut(keyboard.getBinding(a.id)).toLowerCase().includes(searchLower)
    )
  }, [search, keyboard, isEnterprise])

  // Every category is listed, so no action can be hidden by the grouping.
  const groupedActions = useMemo(() => {
    return KEYBOARD_CATEGORIES
      .map(category => ({ category, actions: filteredActions.filter(a => a.category === category) }))
      .filter(g => g.actions.length > 0)
  }, [filteredActions])

  const stopEditing = useCallback(() => {
    setEditingAction(null)
    setPendingBinding('')
    setConflict(null)
  }, [])

  // Handle clicking edit on an action
  const handleEdit = useCallback((actionId: KeyboardAction) => {
    setEditingAction(actionId)
    setPendingBinding('')
    setConflict(null)
  }, [])

  // Handle key capture while editing
  useEffect(() => {
    if (!editingAction) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // Escape cancels editing
      if (e.key === 'Escape') {
        stopEditing()
        return
      }

      // Convert event to binding string
      const binding = eventToBinding(e)
      if (!binding) return

      setPendingBinding(binding)
      setConflict(keyboard.findConflict(editingAction, binding))
    }

    // Add listener in capture phase
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [editingAction, keyboard, stopEditing])

  // Focus input when editing
  useEffect(() => {
    if (editingAction && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editingAction])

  // Save binding — a conflicting chord is refused: only one of the two
  // actions would ever fire, silently.
  const handleSave = useCallback(() => {
    if (editingAction && pendingBinding && !conflict) {
      keyboard.setBinding(editingAction, pendingBinding)
    }
    stopEditing()
  }, [editingAction, pendingBinding, conflict, keyboard, stopEditing])

  const handleReset = useCallback((actionId: KeyboardAction) => {
    keyboard.resetBinding(actionId)
  }, [keyboard])

  const handleResetAll = useCallback(() => {
    keyboard.resetAllToDefaults()
  }, [keyboard])

  const modifierTip = isMac()
    ? <span>Tip: combine <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>⌃</kbd> with a key. Changes apply immediately and update the menu bar.</span>
    : <span>Tip: combine Ctrl, Shift, Alt with a key. Changes apply immediately.</span>

  return (
    <>
      <SettingsSection
        title="Keyboard Shortcuts"
        description={modifierTip}
        actions={<button className="ns-btn ns-btn--small" onClick={handleResetAll}>Reset All</button>}
      >
        <SearchField
          placeholder="Search shortcuts..."
          value={search}
          onChange={setSearch}
        />
        {groupedActions.length === 0 && <p className="form-hint">No shortcuts match your search.</p>}
      </SettingsSection>

      {groupedActions.map(({ category, actions }) => (
        <SettingsSection key={category} title={category}>
          <div className="settings-group">
            {actions.map(a => (
              <SettingsItem
                key={a.id}
                title={a.label}
                actions={editingAction !== a.id && (
                  <>
                    <kbd className={`keyboard-kbd ${keyboard.isCustomized(a.id) ? 'customized' : ''}`}>
                      {formatShortcut(keyboard.getBinding(a.id))}
                    </kbd>
                    <button className="ns-btn ns-btn--small ns-btn--ghost" onClick={() => handleEdit(a.id)}>
                      Edit
                    </button>
                    {keyboard.isCustomized(a.id) && (
                      <Tooltip label={`Reset to default (${formatShortcut(isMac() ? a.defaultBinding.mac : a.defaultBinding.windows)})`}><button
                        className="ns-btn ns-btn--small ns-btn--ghost"
                        onClick={() => handleReset(a.id)}
                      >
                        Reset
                      </button></Tooltip>
                    )}
                  </>
                )}
              >
                {editingAction === a.id && (
                  <div className="keyboard-edit-mode">
                    <input aria-label="Key binding"
                      ref={inputRef}
                      type="text"
                      className="ns-input keyboard-binding-input"
                      value={pendingBinding ? formatShortcut(pendingBinding) : 'Press keys...'}
                      readOnly
                      onKeyDown={(e) => e.preventDefault()}
                    />
                    {conflict && (
                      <p className="settings-error">
                        {conflict.action
                          ? `Already used by "${conflict.label}" — change that shortcut first.`
                          : `Reserved for "${conflict.label}".`}
                      </p>
                    )}
                    <DialogFooter
                      primary={{ label: 'Save', onClick: handleSave, disabled: !pendingBinding || !!conflict }}
                      onCancel={stopEditing}
                      inline
                      small
                    />
                  </div>
                )}
              </SettingsItem>
            ))}
          </div>
        </SettingsSection>
      ))}
    </>
  )
}
