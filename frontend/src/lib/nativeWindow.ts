// Native-window glue that only runs under Tauri (callers check isTauri()),
// except followWindowFocus, which also serves the browser build.
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window'
import { getAppTheme, setNativeTheme } from './appTheme'
import { getPlatform } from '../utils/platform'

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

/**
 * The desktop window chrome is present: the title bar and, on macOS, the app
 * menu (where Settings lives). The browser build has neither. UI-mock runs
 * render the chrome so it can be screenshot-tested in a browser.
 */
export function desktopChrome(): boolean {
  return isTauri() || import.meta.env.VITE_UI_MOCK === '1'
}

/** Let the native window theme drive 'system' resolution (more prompt than WKWebView's media query). */
export async function followNativeTheme(): Promise<void> {
  const win = getCurrentWindow()
  const theme = await win.theme()
  if (theme) setNativeTheme(theme)
  await win.onThemeChanged(({ payload }) => setNativeTheme(payload))
}

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` → RGBA bytes (a transparent body must stay transparent). */
export function parseCssColor(css: string): [number, number, number, number] {
  const [r, g, b, a = 1] = (css.match(/\d+(\.\d+)?/g) ?? []).map(Number)
  return [r, g, b, Math.round(a * 255)]
}

/**
 * Keep the native window in step with the page: its background (seen during
 * resize) matches the body, and its appearance follows the app theme so the
 * title bar and the vibrancy/Mica material match an explicit Light/Dark
 * choice ('system' hands appearance back to the OS).
 */
export function syncNativeWindow(): void {
  const win = getCurrentWindow()
  let appliedTheme: Theme | null | undefined
  const apply = () => {
    void win.setBackgroundColor(parseCssColor(getComputedStyle(document.body).backgroundColor))
    const theme = getAppTheme() === 'system' ? null : (document.documentElement.dataset.theme as Theme)
    if (theme === appliedTheme) return
    appliedTheme = theme
    if (theme) {
      void win.setTheme(theme)
      return
    }
    // While a theme was forced, macOS reports the forced appearance and emits no
    // change when control returns to the OS, so re-read the real OS theme.
    void win.setTheme(null)
      .then(() => win.theme())
      .then(osTheme => { if (osTheme) setNativeTheme(osTheme) })
  }
  apply()
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-variant', 'data-material'],
  })
}

/**
 * Mark <html data-material> when the main window really has a native material
 * behind a transparent page: macOS sidebar vibrancy (tauri.macos.conf), or
 * Windows 11 Mica (applied in Rust; Windows 10 has none).
 */
export async function applyWindowMaterial(): Promise<void> {
  if (getCurrentWindow().label !== 'main') return
  const platform = getPlatform()
  if (platform === 'macos') {
    document.documentElement.dataset.material = 'vibrancy'
  } else if (platform === 'windows' && await invoke<boolean>('window_material_applied')) {
    document.documentElement.dataset.material = 'mica'
  }
}

/**
 * <html data-window-focused> drives the inactive-window look (e.g. neutral
 * selection on macOS). Under Tauri it follows the native window; in the
 * browser (controller /terminal/) it follows the page's window focus.
 */
export async function followWindowFocus(): Promise<void> {
  const setFocused = (focused: boolean) => { document.documentElement.dataset.windowFocused = String(focused) }
  if (!isTauri()) {
    setFocused(document.hasFocus())
    window.addEventListener('focus', () => setFocused(true))
    window.addEventListener('blur', () => setFocused(false))
    return
  }
  const win = getCurrentWindow()
  setFocused(await win.isFocused())
  await win.onFocusChanged(({ payload }) => setFocused(payload))
}

/** The main window starts hidden (tauri.conf `visible: false`) and is shown once the UI has painted. */
export async function revealMainWindow(): Promise<void> {
  const win = getCurrentWindow()
  if (win.label !== 'main') return
  await win.show()
  await win.setFocus()
}
