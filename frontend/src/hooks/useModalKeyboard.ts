/**
 * useModalKeyboard — shared keyboard contract for modals.
 *
 * Audit P1-16 flagged 9 dialogs that each lacked some subset of:
 *   - Escape closes the modal
 *   - Focus trap (Tab cycles within the modal instead of leaking
 *     behind it to the underlying app)
 *   - Autofocus on a chosen field
 *   - Enter submits the primary action (when there's a single
 *     primary action that doesn't conflict with form internals)
 *
 * Worst on CommandWarningDialog: focus stayed wherever it was before
 * the modal opened, and a stray Enter triggered the destructive
 * "Proceed Anyway" path. This hook centralises the pattern so every
 * modal can adopt all four without re-implementing.
 *
 * Usage
 * -----
 *   const containerRef = useRef<HTMLDivElement>(null)
 *   useModalKeyboard({
 *     isOpen,
 *     onEscape: onClose,
 *     onEnter: handleSubmit,
 *     containerRef,
 *     autoFocusSelector: 'input[autofocus], input[type="text"]',
 *   })
 *   return isOpen ? <div ref={containerRef}>…</div> : null
 *
 * Skipping behaviors:
 *   - Pass `onEscape: undefined` to disable Escape handling.
 *   - Pass `onEnter: undefined` to disable Enter-to-submit (or pass
 *     a function that no-ops for forms that shouldn't auto-submit on
 *     Enter).
 *   - Pass `autoFocusSelector: undefined` to skip autofocus.
 *
 * Why a hook instead of a wrapper component
 * -----------------------------------------
 * Each modal has its own layout (overlay, header, body, footer). A
 * wrapper would either force a structure or expose so many slots it
 * becomes config noise. The hook composes into existing components
 * without disturbing their JSX.
 */

import { useEffect, useRef } from 'react'

interface UseModalKeyboardOptions {
  /** True when the modal is visible. The hook is a no-op when false. */
  isOpen: boolean
  /** Container element to focus-trap inside. Required for Tab cycling. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Called on Escape. Pass undefined to disable. */
  onEscape?: () => void
  /**
   * Called on Enter when focus is NOT inside a textarea, contenteditable,
   * or select. Skips Enter when modifier keys are held so Shift+Enter,
   * Cmd+Enter etc. stay available for their normal meanings.
   * Pass undefined to disable.
   */
  onEnter?: () => void
  /**
   * CSS selector for the element to focus on open. The first match
   * inside containerRef is used. Pass undefined to skip autofocus.
   * Common values:
   *   • `'input[autofocus]'` — element with autoFocus prop
   *   • `'input:not([type="hidden"]), textarea, select'` — first form field
   *   • `'button[type="submit"]'` — primary action button
   */
  autoFocusSelector?: string
}

// Elements that can receive keyboard focus. Used by the focus trap.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalKeyboard(opts: UseModalKeyboardOptions): void {
  const { isOpen, containerRef, onEscape, onEnter, autoFocusSelector } = opts

  // Latest-ref pattern for callbacks so re-renders don't force the
  // effect to re-subscribe.
  const onEscapeRef = useRef(onEscape)
  const onEnterRef = useRef(onEnter)
  onEscapeRef.current = onEscape
  onEnterRef.current = onEnter

  // Autofocus on open.
  useEffect(() => {
    if (!isOpen || !autoFocusSelector) return
    // One tick delay so the modal has actually rendered into the DOM
    // (some callers conditionally mount).
    const t = setTimeout(() => {
      const root = containerRef.current
      if (!root) return
      const target = root.querySelector<HTMLElement>(autoFocusSelector)
      target?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [isOpen, autoFocusSelector, containerRef])

  // Escape + Enter + Tab focus trap.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      const root = containerRef.current
      if (!root) return

      // Escape — pass-through. The caller decides what "close" means.
      if (e.key === 'Escape' && onEscapeRef.current) {
        e.preventDefault()
        e.stopPropagation()
        onEscapeRef.current()
        return
      }

      // Enter — submit, BUT only when:
      //   • a primary action is registered, AND
      //   • focus isn't inside a multiline editor or select where
      //     Enter has its own meaning, AND
      //   • no modifier keys are held (so Cmd+Enter / Shift+Enter
      //     stay available for power-user shortcuts).
      if (
        e.key === 'Enter' &&
        onEnterRef.current &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const t = e.target as HTMLElement | null
        const tag = t?.tagName
        const isMultiline =
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (t instanceof HTMLElement && t.isContentEditable)
        if (!isMultiline) {
          e.preventDefault()
          onEnterRef.current()
          return
        }
      }

      // Tab — focus trap. Cycle within the modal's focusable elements
      // so Shift+Tab from the first field wraps to the last, and Tab
      // from the last wraps to the first. Without this, Tab leaks
      // behind the modal into the app — including action buttons that
      // shouldn't be reachable while a destructive confirm is up.
      if (e.key === 'Tab') {
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null) // visible only
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    // Capture phase so we run BEFORE bubbling handlers in components
    // (some modals have their own Enter handlers on inputs that we
    // don't want to interfere with the wider modal-level Enter).
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isOpen, containerRef])
}
