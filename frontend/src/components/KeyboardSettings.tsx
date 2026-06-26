/**
 * KeyboardSettings - UI for customizing keyboard shortcuts
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  KEYBOARD_ACTIONS,
  type KeyboardAction,
  type UseKeyboardReturn,
  eventToBinding,
  getPlatformBinding,
  isMac,
} from '../hooks/useKeyboard'
import './KeyboardSettings.css'

interface KeyboardSettingsProps {
  keyboard: UseKeyboardReturn
}

// Group actions by category
function groupByCategory(actions: typeof KEYBOARD_ACTIONS) {
  const groups: Record<string, typeof KEYBOARD_ACTIONS> = {}

  for (const action of actions) {
    if (!groups[action.category]) {
      groups[action.category] = []
    }
    groups[action.category].push(action)
  }

  return groups
}

// Category display order
const CATEGORY_ORDER = ['Terminal', 'Navigation', 'View', 'AI', 'Scripts']

export default function KeyboardSettings({ keyboard }: KeyboardSettingsProps) {
  const [search, setSearch] = useState('')
  const [editingAction, setEditingAction] = useState<KeyboardAction | null>(null)
  const [pendingBinding, setPendingBinding] = useState<string>('')
  const [conflict, setConflict] = useState<KeyboardAction | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Filter actions by search
  const filteredActions = useMemo(() => {
    if (!search.trim()) return KEYBOARD_ACTIONS

    const searchLower = search.toLowerCase()
    return KEYBOARD_ACTIONS.filter(
      action =>
        action.label.toLowerCase().includes(searchLower) ||
        action.category.toLowerCase().includes(searchLower) ||
        keyboard.getBinding(action.id).toLowerCase().includes(searchLower)
    )
  }, [search, keyboard])

  // Group filtered actions
  const groupedActions = useMemo(() => {
    return groupByCategory(filteredActions)
  }, [filteredActions])

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
        setEditingAction(null)
        setPendingBinding('')
        setConflict(null)
        return
      }

      // Convert event to binding string
      const binding = eventToBinding(e)
      if (!binding) return

      setPendingBinding(binding)

      // Check for conflicts
      const conflictAction = keyboard.findConflict(editingAction, binding)
      setConflict(conflictAction)
    }

    // Add listener in capture phase
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [editingAction, keyboard])

  // Focus input when editing
  useEffect(() => {
    if (editingAction && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editingAction])

  // Save binding
  const handleSave = useCallback(() => {
    if (editingAction && pendingBinding) {
      keyboard.setBinding(editingAction, pendingBinding)
      keyboard.saveToBackend().catch(console.error)
    }
    setEditingAction(null)
    setPendingBinding('')
    setConflict(null)
  }, [editingAction, pendingBinding, keyboard])

  // Cancel editing
  const handleCancel = useCallback(() => {
    setEditingAction(null)
    setPendingBinding('')
    setConflict(null)
  }, [])

  // Reset single binding
  const handleReset = useCallback((actionId: KeyboardAction) => {
    keyboard.resetBinding(actionId)
    keyboard.saveToBackend().catch(console.error)
  }, [keyboard])

  // Reset all bindings
  const handleResetAll = useCallback(() => {
    keyboard.resetAllToDefaults()
    keyboard.saveToBackend().catch(console.error)
  }, [keyboard])

  // Get display binding for an action
  const getDisplayBinding = useCallback((actionId: KeyboardAction) => {
    const binding = keyboard.getBinding(actionId)
    // Format for display (replace Cmd with symbol on Mac)
    if (isMac()) {
      return binding
        .replace(/Cmd\+/g, '\u2318')
        .replace(/Shift\+/g, '\u21E7')
        .replace(/Alt\+/g, '\u2325')
        .replace(/Ctrl\+/g, '\u2303')
    }
    return binding
  }, [keyboard])

  // Check if binding is customized
  const isCustomized = useCallback((actionId: KeyboardAction) => {
    const actionInfo = KEYBOARD_ACTIONS.find(a => a.id === actionId)
    if (!actionInfo) return false

    const current = keyboard.getBinding(actionId)
    const defaultBinding = getPlatformBinding(actionInfo.defaultBinding)

    return current !== defaultBinding
  }, [keyboard])

  // Get conflict action label
  const getConflictLabel = useCallback((actionId: KeyboardAction | null) => {
    if (!actionId) return ''
    const action = KEYBOARD_ACTIONS.find(a => a.id === actionId)
    return action?.label || actionId
  }, [])

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
        {Object.keys(groupedActions).length === 0 ? (
          <div className="keyboard-empty">No shortcuts found</div>
        ) : (
          CATEGORY_ORDER.filter(cat => groupedActions[cat]?.length > 0).map(category => (
            <div key={category} className="keyboard-category">
              <h3 className="keyboard-category-title">{category}</h3>
              <div className="keyboard-action-list">
                {groupedActions[category].map(action => (
                  <div
                    key={action.id}
                    className={`keyboard-action-item ${editingAction === action.id ? 'editing' : ''}`}
                  >
                    <div className="keyboard-action-label">{action.label}</div>
                    <div className="keyboard-action-binding">
                      {editingAction === action.id ? (
                        <div className="keyboard-edit-mode">
                          <input
                            ref={inputRef}
                            type="text"
                            className="keyboard-binding-input"
                            value={pendingBinding || 'Press keys...'}
                            readOnly
                            onKeyDown={(e) => e.preventDefault()}
                          />
                          {conflict && (
                            <div className="keyboard-conflict">
                              Conflicts with: {getConflictLabel(conflict)}
                            </div>
                          )}
                          <div className="keyboard-edit-actions">
                            <button
                              className="keyboard-btn keyboard-btn-save"
                              onClick={handleSave}
                              disabled={!pendingBinding}
                            >
                              Save
                            </button>
                            <button
                              className="keyboard-btn keyboard-btn-cancel"
                              onClick={handleCancel}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <kbd className={`keyboard-kbd ${isCustomized(action.id) ? 'customized' : ''}`}>
                            {getDisplayBinding(action.id)}
                          </kbd>
                          <div className="keyboard-action-buttons">
                            <button
                              className="keyboard-btn keyboard-btn-edit"
                              onClick={() => handleEdit(action.id)}
                            >
                              Edit
                            </button>
                            {isCustomized(action.id) && (
                              <button
                                className="keyboard-btn keyboard-btn-reset"
                                onClick={() => handleReset(action.id)}
                                title="Reset to default"
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
        <div className="keyboard-hint">
          {isMac() ? (
            <span>Tip: Use <kbd>\u2318</kbd> <kbd>\u21E7</kbd> <kbd>\u2325</kbd> modifier keys</span>
          ) : (
            <span>Tip: Use Ctrl, Shift, Alt modifier keys</span>
          )}
        </div>
      </div>
    </div>
  )
}
