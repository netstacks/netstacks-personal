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
import './KeyboardSettings.css'

interface KeyboardSettingsProps {
  keyboard: UseKeyboardReturn
}

export default function KeyboardSettings({ keyboard }: KeyboardSettingsProps) {
  const [search, setSearch] = useState('')
  const [editingAction, setEditingAction] = useState<KeyboardAction | null>(null)
  const [pendingBinding, setPendingBinding] = useState<string>('')
  const [conflict, setConflict] = useState<KeybindingConflict | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Filter actions by search (label, category, or the current chord)
  const filteredActions = useMemo(() => {
    if (!search.trim()) return KEYBOARD_ACTIONS

    const searchLower = search.toLowerCase()
    return KEYBOARD_ACTIONS.filter(
      a =>
        a.label.toLowerCase().includes(searchLower) ||
        a.category.toLowerCase().includes(searchLower) ||
        keyboard.getBinding(a.id).toLowerCase().includes(searchLower) ||
        formatShortcut(keyboard.getBinding(a.id)).toLowerCase().includes(searchLower)
    )
  }, [search, keyboard])

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
    <div className="keyboard-settings">
      <div className="keyboard-settings-header">
        <div className="keyboard-search">
          <input
            type="search"
            placeholder="Search shortcuts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="keyboard-search-input"
          />
        </div>
        <button className="keyboard-reset-all" onClick={handleResetAll}>
          Reset All
        </button>
      </div>

      <div className="keyboard-settings-content">
        {groupedActions.length === 0 ? (
          <div className="keyboard-empty">No shortcuts found</div>
        ) : (
          groupedActions.map(({ category, actions }) => (
            <div key={category} className="keyboard-category">
              <h3 className="keyboard-category-title">{category}</h3>
              <div className="keyboard-action-list">
                {actions.map(a => (
                  <div
                    key={a.id}
                    className={`keyboard-action-item ${editingAction === a.id ? 'editing' : ''}`}
                  >
                    <div className="keyboard-action-label">{a.label}</div>
                    <div className="keyboard-action-binding">
                      {editingAction === a.id ? (
                        <div className="keyboard-edit-mode">
                          <input
                            ref={inputRef}
                            type="text"
                            className="keyboard-binding-input"
                            value={pendingBinding ? formatShortcut(pendingBinding) : 'Press keys...'}
                            readOnly
                            onKeyDown={(e) => e.preventDefault()}
                          />
                          {conflict && (
                            <div className="keyboard-conflict">
                              {conflict.action
                                ? `Already used by "${conflict.label}" — change that shortcut first.`
                                : `Reserved for "${conflict.label}".`}
                            </div>
                          )}
                          <div className="keyboard-edit-actions">
                            <button
                              className="keyboard-btn keyboard-btn-save"
                              onClick={handleSave}
                              disabled={!pendingBinding || !!conflict}
                            >
                              Save
                            </button>
                            <button
                              className="keyboard-btn keyboard-btn-cancel"
                              onClick={stopEditing}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <kbd className={`keyboard-kbd ${keyboard.isCustomized(a.id) ? 'customized' : ''}`}>
                            {formatShortcut(keyboard.getBinding(a.id))}
                          </kbd>
                          <div className="keyboard-action-buttons">
                            <button
                              className="keyboard-btn keyboard-btn-edit"
                              onClick={() => handleEdit(a.id)}
                            >
                              Edit
                            </button>
                            {keyboard.isCustomized(a.id) && (
                              <button
                                className="keyboard-btn keyboard-btn-reset"
                                onClick={() => handleReset(a.id)}
                                title={`Reset to default (${formatShortcut(isMac() ? a.defaultBinding.mac : a.defaultBinding.windows)})`}
                              >
                                Reset
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="keyboard-settings-footer">
        <div className="keyboard-hint">{modifierTip}</div>
      </div>
    </div>
  )
}
