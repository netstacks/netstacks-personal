/**
 * Local iconify registration for the vscode-icons file-type collection.
 *
 * Tauri's CSP blocks the iconify CDN fallback that `@iconify/react` uses
 * when an icon isn't in a registered collection, so anything we want to
 * render must be registered locally.
 *
 * The full collection is ~3.7 MB of JSON, so it is NOT loaded at startup.
 * Only the default file/folder glyphs are registered eagerly (they are
 * inlined below); the full set is pulled in via dynamic `import()` the
 * first time a file-icon consumer (Docs / Workspace) mounts. Consumers use
 * `useFileIconsReady()` and render the default glyphs until it flips true.
 */
import { useEffect, useState } from 'react'
import { addCollection } from '@iconify/react'

type IconifyCollection = Parameters<typeof addCollection>[0]

export const FILE_ICON_PREFIX = 'vscode-icons'
export const DEFAULT_FILE_ICON = `${FILE_ICON_PREFIX}:default-file`
export const DEFAULT_FOLDER_ICON = `${FILE_ICON_PREFIX}:default-folder`
export const DEFAULT_FOLDER_OPENED_ICON = `${FILE_ICON_PREFIX}:default-folder-opened`

/**
 * Default glyphs copied from @iconify-json/vscode-icons so placeholders
 * render (without a CDN request) before the full collection is loaded.
 */
const defaultFileIcons: IconifyCollection = {
  prefix: FILE_ICON_PREFIX,
  width: 32,
  height: 32,
  icons: {
    'default-file': {
      body: '<path fill="#c5c5c5" d="M20.414 2H5v28h22V8.586ZM7 28V4h12v6h6v18Z"/>',
    },
    'default-folder': {
      body: '<path fill="#c09553" d="M27.5 5.5h-9.3l-2.1 4.2H4.4v16.8h25.2v-21Zm0 4.2h-8.2l1.1-2.1h7.1Z"/>',
    },
    'default-folder-opened': {
      body: '<path fill="#dcb67a" d="M27.4 5.5h-9.2l-2.1 4.2H4.3v16.8h25.2v-21Zm0 18.7H6.6V11.8h20.8Zm0-14.5h-8.2l1-2.1h7.1v2.1Z"/><path fill="#dcb67a" d="M25.7 13.7H.5l3.8 12.8h25.2z"/>',
    },
  },
}

// Tiny and needed by every consumer, so register on module load.
addCollection(defaultFileIcons)

let fileIconsReady = false
let fileIconsPromise: Promise<void> | null = null

/**
 * Load and register the full vscode-icons collection once. Safe to call
 * repeatedly; concurrent callers share one promise. A failed load is not
 * cached so a later mount can retry; until then the defaults keep rendering.
 */
export function ensureFileIcons(): Promise<void> {
  if (!fileIconsPromise) {
    fileIconsPromise = import('@iconify-json/vscode-icons/icons.json')
      .then((mod) => {
        addCollection(mod.default as IconifyCollection)
        fileIconsReady = true
      })
      .catch((err: unknown) => {
        fileIconsPromise = null
        throw err
      })
  }
  return fileIconsPromise
}

/**
 * Returns true once the full file-icon collection is registered, kicking
 * off the load on first use. While false, render the DEFAULT_* icons.
 */
export function useFileIconsReady(): boolean {
  const [ready, setReady] = useState(fileIconsReady)
  useEffect(() => {
    if (ready) return
    let cancelled = false
    ensureFileIcons().then(
      () => {
        if (!cancelled) setReady(true)
      },
      () => {
        // Keep showing the default glyphs; the next mount retries.
      },
    )
    return () => {
      cancelled = true
    }
  }, [ready])
  return ready
}
