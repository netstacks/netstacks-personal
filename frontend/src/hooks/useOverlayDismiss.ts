import { useCallback, useEffect } from 'react'

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
 * Escape is bound on `window` for the lifetime of the hook when `enabled`.
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

export function useOverlayDismiss({
  onDismiss,
  enabled = true,
  escape = true,
  clickOutside = true,
}: UseOverlayDismissOptions) {
  useEffect(() => {
    if (!enabled || !escape) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop propagation so a nested overlay doesn't also close — Escape
        // should dismiss the topmost overlay only. Multiple overlays each
        // call this hook; the most-recently-mounted listener fires last
        // and wins.
        e.stopPropagation()
        onDismiss()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled, escape, onDismiss])

  const backdropOnClick = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled || !clickOutside) return
      if (e.target === e.currentTarget) onDismiss()
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
    backdropProps: { onClick: backdropOnClick },
    contentProps: { onClick: contentOnClick },
  }
}
