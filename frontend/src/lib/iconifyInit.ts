/**
 * Register iconify icon collections once at app bootstrap.
 *
 * Tauri's CSP blocks the iconify CDN fallback that `@iconify/react` uses
 * when an icon isn't in a registered collection, so anything we want to
 * render must be added here. Import this from `main.tsx` exactly once.
 */
import { addCollection } from '@iconify/react'
import vscodeIcons from '@iconify-json/vscode-icons/icons.json'

let registered = false

export function registerIconifyCollections(): void {
  if (registered) return
  addCollection(vscodeIcons as Parameters<typeof addCollection>[0])
  registered = true
}
