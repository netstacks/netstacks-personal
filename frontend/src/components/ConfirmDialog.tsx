/**
 * Imperative confirmation dialog.
 *
 * Replaces `window.confirm` (broken in Tauri WebView) with a real React
 * modal. Call `confirmDialog({...})` from anywhere — anywhere — and await
 * a boolean. Mount `<ConfirmDialogHost />` once at the app root.
 *
 * Example:
 *   if (await confirmDialog({
 *     title: 'Delete profile?',
 *     body: <>Delete <strong>{name}</strong>? This cannot be undone.</>,
 *     confirmLabel: 'Delete',
 *     destructive: true,
 *   })) {
 *     await deleteProfile(id);
 *   }
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import './ConfirmDialog.css'

export interface ConfirmOptions {
  title: string
  /** Body text or JSX. Strings render in a `<p>`. */
  body?: string | React.ReactNode
  /** Confirm button label. Default "Confirm". */
  confirmLabel?: string
  /** Cancel button label. Default "Cancel". */
  cancelLabel?: string
  /** Style the confirm button in red and add a subtle warning hint. */
  destructive?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  id: string
  resolve: (value: boolean) => void
}

// Module-level queue + listener (same pattern as Toast.tsx)
type ConfirmListener = (pending: PendingConfirm | null) => void
let listeners: ConfirmListener[] = []
let current: PendingConfirm | null = null
// FIFO of confirms waiting behind `current`. A plain array — the old
// "wrap the current resolver" trick only remembered ONE follower, so a
// third concurrent call replaced the second and its promise never settled.
let queue: PendingConfirm[] = []

function notifyListeners() {
  listeners.forEach((l) => l(current))
}

/**
 * Show a confirmation dialog and await the user's choice.
 *
 * Returns true if confirmed, false if cancelled / dismissed via Escape /
 * backdrop click. Only one confirm is shown at a time — concurrent calls
 * queue and resolve in order.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `confirm-${crypto.randomUUID()}`
    const pending: PendingConfirm = { ...opts, id, resolve }
    if (current) {
      queue.push(pending)
    } else {
      current = pending
      notifyListeners()
    }
  })
}

function resolveCurrent(value: boolean) {
  if (!current) return
  const pending = current
  current = queue.shift() ?? null
  notifyListeners()
  pending.resolve(value)
}

/** Test seam: drop every pending confirm without resolving. */
export function resetConfirmQueueForTests() {
  current = null
  queue = []
  notifyListeners()
}

/**
 * Mount once at the app root. Renders the active confirm dialog (if any).
 */
export function ConfirmDialogHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(current)
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    listeners.push(setPending)
    return () => {
      listeners = listeners.filter((l) => l !== setPending)
    }
  }, [])

  // Autofocus the confirm button (or cancel for destructive — but the
  // Escape key handler covers the safety case already).
  useEffect(() => {
    if (pending) {
      confirmBtnRef.current?.focus()
    }
  }, [pending])

  const handleCancel = useCallback(() => resolveCurrent(false), [])
  const handleConfirm = useCallback(() => resolveCurrent(true), [])

  // Escape / backdrop dismiss (resolves false). Goes through the shared
  // hook so the confirm — always the topmost overlay — is the ONLY thing
  // that handles Escape while it's up; the dialog underneath stays open.
  const { backdropProps, contentProps } = useOverlayDismiss({
    onDismiss: handleCancel,
    enabled: pending !== null,
  })

  if (!pending) return null

  const {
    title,
    body,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  } = pending

  return (
    <div className="confirm-dialog-overlay" {...backdropProps} role="presentation">
      <div
        ref={dialogRef}
        className="confirm-dialog"
        {...contentProps}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${pending.id}-title`}
      >
        <h3 id={`${pending.id}-title`}>{title}</h3>
        {body !== undefined &&
          (typeof body === 'string' ? <p>{body}</p> : <div className="confirm-dialog-body">{body}</div>)}
        {destructive && (
          <p className="confirm-dialog-warning">This action cannot be undone.</p>
        )}
        <div className="confirm-dialog-actions">
          <button className="btn-secondary" onClick={handleCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            className={destructive ? 'btn-danger' : 'btn-primary'}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialogHost
