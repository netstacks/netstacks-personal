/**
 * App-wide "get these hovers out of my way" signal.
 *
 * Tapping Ctrl or ⌘ (on its own or as the start of a chord) dismisses every
 * subscribed hover popup, and while either key is held no new hover may open.
 * Listening on window in the capture phase means it works whether focus is in
 * xterm's textarea, the editor, or nowhere — and it never consumes the key,
 * so Ctrl+C / ⌘C etc. still reach the terminal untouched.
 */

type Listener = () => void

const listeners = new Set<Listener>()
let modifierHeld = false

function isDismissKey(e: KeyboardEvent): boolean {
  return e.key === 'Control' || e.key === 'Meta'
}

const onKeyDown = (e: KeyboardEvent) => {
  if (!isDismissKey(e)) return
  modifierHeld = true
  if (e.repeat) return
  for (const l of [...listeners]) l()
}

const onKeyUp = (e: KeyboardEvent) => {
  if (isDismissKey(e)) modifierHeld = false
}

// Released outside the window (e.g. ⌘-Tab away) never delivers keyup.
const onBlur = () => { modifierHeld = false }

/** Subscribe to dismiss requests; returns the unsubscribe function. */
export function onDismissHovers(listener: Listener): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      modifierHeld = false
    }
  }
}

/** True while Ctrl or ⌘ is held — hovers should not open. */
export function isHoverSuppressed(): boolean {
  return modifierHeld
}
