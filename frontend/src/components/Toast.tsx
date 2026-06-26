/**
 * Toast notification system
 * Simple toast notifications for user feedback
 */
import { useState, useEffect, useCallback } from 'react'
import './Toast.css'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

// Toast icons by type
const TOAST_ICONS: Record<ToastType, React.ReactElement> = {
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20,6 9,17 4,12" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
}

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastMessage {
  id: string
  message: string | React.ReactNode
  type: ToastType
  duration?: number
  /** Single action — kept for backward compat. Prefer `actions`. */
  action?: ToastAction
  /** Up to 3 compact action buttons rendered alongside the dismiss "×". */
  actions?: ToastAction[]
}

// Global toast state management
type ToastListener = (toasts: ToastMessage[]) => void
let listeners: ToastListener[] = []
let toasts: ToastMessage[] = []

// Cap on concurrent toasts. A burst (e.g. 50 failed SNMP probes) shouldn't
// stack 50 deep — drop oldest so only the most recent N are visible.
const MAX_TOASTS = 5

function notifyListeners() {
  listeners.forEach(listener => listener([...toasts]))
}

/**
 * Show a toast notification.
 *
 * Default durations differ by type. Errors are persistent (duration=0,
 * manual dismiss) because users routinely need more than 3 seconds to
 * read a multi-line error like `Import failed: invalid YAML at line 47`.
 * Pass an explicit `duration` to override.
 *
 * Optional `action` adds a clickable button inside the toast — useful
 * for "Retry" on error toasts.
 */
export function showToast(
  message: string | React.ReactNode,
  type: ToastType = 'info',
  duration?: number,
  action?: ToastAction | ToastAction[],
): string {
  const effectiveDuration = duration ?? (type === 'error' ? 0 : 3000)
  const id = `toast-${crypto.randomUUID()}`
  // Accept either a single action (legacy) or an array of up to 3.
  const newToast: ToastMessage = Array.isArray(action)
    ? { id, message, type, duration: effectiveDuration, actions: action.slice(0, 3) }
    : { id, message, type, duration: effectiveDuration, action }
  toasts = [...toasts, newToast].slice(-MAX_TOASTS)
  notifyListeners()

  // Auto-remove after duration (0 = persistent, manual dismiss only)
  if (effectiveDuration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, effectiveDuration)
  }

  return id
}

/**
 * Remove a toast by ID
 */
export function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id)
  notifyListeners()
}

/**
 * Hook to subscribe to toast state
 */
function useToasts(): ToastMessage[] {
  const [localToasts, setLocalToasts] = useState<ToastMessage[]>(toasts)

  useEffect(() => {
    const listener: ToastListener = (newToasts) => {
      setLocalToasts(newToasts)
    }
    listeners.push(listener)
    return () => {
      listeners = listeners.filter(l => l !== listener)
    }
  }, [])

  return localToasts
}

/**
 * Toast container component - renders all active toasts
 * Add this to your app root
 */
export function ToastContainer() {
  const toasts = useToasts()

  const handleDismiss = useCallback((id: string) => {
    removeToast(id)
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}`}
          onClick={() => handleDismiss(toast.id)}
          role="alert"
        >
          <span className="toast-icon">{TOAST_ICONS[toast.type]}</span>
          <span className="toast-message">
            {toast.message}
          </span>
          {(toast.actions?.length || toast.action) && (
            <span className="toast-actions">
              {(toast.actions ?? (toast.action ? [toast.action] : [])).map((a, i) => (
                <button
                  key={i}
                  className="toast-action-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    a.onClick()
                    handleDismiss(toast.id)
                  }}
                >
                  {a.label}
                </button>
              ))}
            </span>
          )}
          <button
            className="toast-close"
            onClick={(e) => { e.stopPropagation(); handleDismiss(toast.id) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

export default ToastContainer
