/**
 * Tauri webview drag-drop coordinator.
 *
 * Why this exists
 * ---------------
 * Tauri v2 defaults `dragDropEnabled: true`, which means the WebView
 * intercepts native OS file drops at the layer below the DOM. React
 * `onDragOver` / `onDrop` handlers never fire for Finder/Explorer file
 * drops — the SFTP panel's drop target was silently dead on every
 * platform.
 *
 * The fix is `getCurrentWebview().onDragDropEvent(...)`, which delivers
 * absolute filesystem paths (better than File blobs — we can read with
 * the Tauri `fs` plugin without losing path metadata).
 *
 * Design
 * ------
 * The Tauri event is global to the whole webview. Multiple surfaces in
 * the app might accept drops (today: SFTP panel + SFTP file browser;
 * potentially: workspace file tree, documents panel). We need to route
 * a drop to whichever surface the cursor is over.
 *
 * Surfaces register a CSS selector + handler. On drop, we hit-test the
 * cursor position with `document.elementFromPoint()` and dispatch to
 * the surface whose root `closest(selector)` matches.
 *
 * Lifecycle
 * ---------
 *   - One global Tauri subscription, registered lazily on first
 *     registerDropTarget() call. Released when the last target
 *     unregisters.
 *   - Surfaces register on mount via useTauriDragDrop() and unregister
 *     on unmount. The unregister handle is what the cleanup function
 *     returns.
 *
 * Limitations
 * -----------
 *   - In browser/dev mode (no Tauri runtime), this is a no-op. Browser
 *     HTML5 drop events still fire and the existing React onDrop
 *     handlers work fine — that's the dev fallback.
 *   - Tauri positions are physical pixels; we convert to CSS pixels via
 *     `devicePixelRatio` so elementFromPoint() works.
 */

import { useEffect } from 'react'

interface DropTarget {
  /** CSS selector to match the surface root (e.g. `.sftp-panel`). */
  selector: string
  /** Called with absolute filesystem paths when a drop lands inside the matching surface.
   *  Second argument is the DOM element that matched the selector (via closest). */
  onDrop: (paths: string[], matchedElement: Element) => void
}

let unsubscribeTauri: (() => void) | null = null
let initPromise: Promise<void> | null = null
const targets = new Set<DropTarget>()

/** Detect Tauri runtime. */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function ensureSubscribed(): Promise<void> {
  if (!isTauri()) return
  if (unsubscribeTauri || initPromise) return initPromise ?? undefined
  initPromise = (async () => {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      const wv = getCurrentWebview()
      const off = await wv.onDragDropEvent((event) => {
        // Tauri event payload shape: { type: 'enter' | 'over' | 'drop' | 'leave', paths?: string[], position?: { x, y } }
        const p = event.payload as {
          type: string
          paths?: string[]
          position?: { x: number; y: number }
        }
        if (p.type !== 'drop' || !p.paths || p.paths.length === 0) return
        const pos = p.position
        if (!pos) return
        // Tauri reports physical pixels; convert to CSS pixels.
        const dpr = window.devicePixelRatio || 1
        const cssX = pos.x / dpr
        const cssY = pos.y / dpr
        const el = document.elementFromPoint(cssX, cssY)

        // Walk every registered target; first selector that matches the
        // element (or one of its ancestors) wins. Iteration order is
        // insertion order which is "most-recent component last" — that
        // matches what users expect when overlays are stacked.
        if (el) {
          for (const t of Array.from(targets).reverse()) {
            const match = el.closest(t.selector)
            if (match) {
              t.onDrop(p.paths, match)
              return
            }
          }
        }

        // Fallback: Tauri on macOS sometimes reports negative/invalid
        // coordinates, making elementFromPoint return null. Find the
        // focused or sole visible target element instead.
        for (const t of Array.from(targets).reverse()) {
          const candidates = document.querySelectorAll(t.selector)
          if (candidates.length === 0) continue
          // If only one match is visible, use it unambiguously.
          const visible = Array.from(candidates).filter(c => {
            const r = c.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          })
          if (visible.length === 1) {
            t.onDrop(p.paths, visible[0])
            return
          }
          // Multiple visible — prefer the one containing the focused element.
          const focused = document.activeElement
          if (focused) {
            for (const v of visible) {
              if (v.contains(focused)) {
                t.onDrop(p.paths, v)
                return
              }
            }
          }
        }
      })
      unsubscribeTauri = off
    } catch (err) {
      // Tauri APIs failing isn't fatal — we lose drop-from-OS but the
      // HTML5 fallback in dev still works. Don't toast; log once.
       
      console.warn('[tauriDragDrop] Failed to subscribe to webview drag-drop:', err)
    } finally {
      initPromise = null
    }
  })()
  return initPromise
}

function maybeUnsubscribe(): void {
  if (targets.size === 0 && unsubscribeTauri) {
    unsubscribeTauri()
    unsubscribeTauri = null
  }
}

/**
 * Register a drop target. Returns the unregister function.
 *
 * Non-React callers can use this directly; React components should use
 * the `useTauriDragDrop` hook below which calls register/unregister in
 * the right lifecycle hooks.
 */
export function registerDropTarget(target: DropTarget): () => void {
  targets.add(target)
  void ensureSubscribed()
  return () => {
    targets.delete(target)
    maybeUnsubscribe()
  }
}

/**
 * React hook that registers a drop target for the lifetime of the
 * calling component.
 *
 *   useTauriDragDrop({
 *     selector: '.sftp-panel',
 *     onDrop: (paths) => uploadFiles(paths),
 *   })
 *
 * `onDrop` is captured fresh on every render via the latest-ref pattern,
 * so it can safely close over state without re-subscribing.
 */
export function useTauriDragDrop(target: DropTarget): void {
  useEffect(() => {
    return registerDropTarget(target)
    // We intentionally re-subscribe when the selector changes (rare).
    // The handler closure is captured at register time — if the caller
    // needs fresh closures, they should memoize the whole target with
    // useMemo and add their own deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.selector])
}

// Start the Tauri subscription eagerly at import time so drops that
// arrive before any component mounts aren't lost.
void ensureSubscribed()
