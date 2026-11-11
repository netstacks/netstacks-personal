import { useCallback, useEffect, useRef } from 'react'

/**
 * Standard modal/overlay dismiss behaviour — Escape key + backdrop click.
 *
 * Each dialog in the app had been re-implementing this pattern with subtle
 * differences (mousedown vs click, window vs document, missing Escape in 12+
 * places per the modal-close audit). This hook centralizes the contract:
 *
 *   const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose })
 *
 *   <div className="my-overlay" {...backdropProps}>
 *     <div className="my-dialog" {...contentProps}>
 *       ...content...
 *     </div>
 *   </div>
 *
 * `backdropProps.onClick` fires `onDismiss` only when the click target *is*
 * the backdrop itself (avoids re-firing when content bubbles), so the
 * `e.stopPropagation()` on `contentProps` is belt-and-suspenders.
 *
 * Escape is bound on `window` (capture phase) for the lifetime of the hook
 * when `enabled`. Nested overlays (confirm over a dialog, profile editor
 * over the session dialog) each register here; only the *topmost* — the
 * most recently enabled — handles Escape, and it stops the event dead so
 * neither the parent overlay nor any app-level shortcut sees it.
 *
 * Set `enabled: false` to suppress (e.g. while an import is mid-flight and
 * the dialog explicitly wants to disable dismissal).
 */
export interface UseOverlayDismissOptions {
  onDismiss: () => void
  /** Master switch — when false, neither Escape nor backdrop click fires. */
  enabled?: boolean
  /** Disable just the Escape handler (default true). */
  escape?: boolean
  /** Disable just the click-outside handler (default true). */
  clickOutside?: boolean
}

/**
 * Module-level stack of the overlays currently listening for Escape, in
 * enable order. The last entry is the topmost overlay. Ordering is fixed
 * at enable time — a parent re-rendering with a new `onDismiss` must NOT
 * hop back above a child that mounted after it, which is why `onDismiss`
 * lives in a ref rather than in the effect deps.
 */
const escapeStack: symbol[] = []

export function useOverlayDismiss({
  onDismiss,
  enabled = true,
  escape = true,
  clickOutside = true,
}: UseOverlayDismissOptions) {
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!enabled || !escape) return
    const token = Symbol('overlay')
    escapeStack.push(token)
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only the topmost overlay dismisses. Every registered overlay sees
      // the event (all are capture listeners on window, fired in
      // registration order); the ones underneath simply yield.
      if (escapeStack[escapeStack.length - 1] !== token) return
      e.stopImmediatePropagation()
      onDismissRef.current()
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      const i = escapeStack.indexOf(token)
      if (i !== -1) escapeStack.splice(i, 1)
    }
  }, [enabled, escape])

  // A press that STARTS inside the content (text selection, dragging a popup
  // by its title bar, resizing from a corner) may end over the backdrop; the
  // browser then dispatches `click` to their common ancestor — the backdrop —
  // which used to dismiss the dialog mid-gesture. Remember where the press
  // began and only dismiss when it began on the backdrop itself.
  const pressStartedInside = useRef(false)

  const backdropOnMouseDown = useCallback((e: React.MouseEvent) => {
    pressStartedInside.current = e.target !== e.currentTarget
  }, [])

  const backdropOnClick = useCallback(
    (e: React.MouseEvent) => {
      const startedInside = pressStartedInside.current
      pressStartedInside.current = false
      if (!enabled || !clickOutside) return
      if (e.target === e.currentTarget && !startedInside) onDismiss()
    },
    [enabled, clickOutside, onDismiss],
  )

  // Stop content clicks from bubbling to the backdrop — defense-in-depth
  // even though the `e.target === e.currentTarget` guard above already
  // handles the simple case.
  const contentOnClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  return {
    backdropProps: { onMouseDown: backdropOnMouseDown, onClick: backdropOnClick },
    contentProps: { onClick: contentOnClick },
  }
}
