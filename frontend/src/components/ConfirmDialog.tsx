/**
 * Imperative confirmation dialog.
 *
 * Replaces `window.confirm` (broken in Tauri WebView). Call
 * `confirmDialog({...})` from anywhere and await a boolean. Under Tauri a
 * plain-text confirm is a native OS alert; a JSX body (or the browser build)
 * gets the React modal. Mount `<ConfirmDialogHost />` once at the app root.
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
import { useState, useEffect, useCallback } from 'react'
import { ask } from '@tauri-apps/plugin-dialog'
import DialogFooter from './DialogFooter'
import { isTauri } from '../lib/nativeWindow'
import ModalFrame from './ModalFrame'
import { useUserScopeStore } from '../lib/userScope'
import './ConfirmDialog.css'

export interface ConfirmOptions {
  title: string
  /** Body text or JSX. Text is shown in a native alert under Tauri. */
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

const DESTRUCTIVE_HINT = 'This action cannot be undone.'

function notifyListeners() {
  listeners.forEach((l) => l(current))
}

/**
 * Show a confirmation dialog and await the user's choice.
 *
 * Returns true if confirmed, false if cancelled / dismissed via Escape /
 * backdrop click. Only one HTML confirm is shown at a time — concurrent
 * calls queue and resolve in order.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (isTauri() && (opts.body === undefined || typeof opts.body === 'string')) {
    const message = [opts.body, opts.destructive && DESTRUCTIVE_HINT].filter(Boolean).join('\n\n')
    // With no body the title is the alert's message (no duplicate heading).
    return ask(message || opts.title, {
      title: message ? opts.title : undefined,
      kind: opts.destructive ? 'warning' : 'info',
      okLabel: opts.confirmLabel ?? 'Confirm',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
    })
  }
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

// Enterprise: a confirm asked on one user's behalf is never answered by the
// next — signing out (or a change of user) cancels every pending confirm.
useUserScopeStore.subscribe((state, prev) => {
  if (state.scope === prev.scope || !current) return
  const cancelled = [current, ...queue]
  current = null
  queue = []
  notifyListeners()
  for (const pending of cancelled) pending.resolve(false)
})

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

  useEffect(() => {
    listeners.push(setPending)
    return () => {
      listeners = listeners.filter((l) => l !== setPending)
    }
  }, [])

  const handleCancel = useCallback(() => resolveCurrent(false), [])
  const handleConfirm = useCallback(() => resolveCurrent(true), [])

  if (!pending) return null

  const {
    title,
    body,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  } = pending

  return (
    <ModalFrame key={pending.id} id="confirm" role="alertdialog" onDismiss={handleCancel} resizable={false} className="confirm-dialog" labelledBy={`${pending.id}-title`}>
      {/* Escape / backdrop dismiss resolves false; the frame's dismiss handling
          makes the confirm — always the topmost overlay — the only thing that
          handles Escape while it's up. The title is the drag handle. */}
      <h3 id={`${pending.id}-title`} data-drag-handle>{title}</h3>
      {body !== undefined &&
        (typeof body === 'string' ? <p>{body}</p> : <div className="confirm-dialog-body">{body}</div>)}
      {destructive && (
        <p className="confirm-dialog-warning">{DESTRUCTIVE_HINT}</p>
      )}
      {/* Keyed per confirm so the confirm button takes focus for each queued one. */}
      <DialogFooter
        key={pending.id}
        primary={{ label: confirmLabel, onClick: handleConfirm, danger: destructive, autoFocus: true }}
        onCancel={handleCancel}
        cancelLabel={cancelLabel}
        inline
      />
    </ModalFrame>
  )
}

export default ConfirmDialogHost
