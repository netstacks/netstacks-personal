// App-wide theme. Persisted in localStorage so every window (main app,
// popouts, shared views) applies it in main.tsx before first paint.
// <html data-theme> always carries the resolved value ('dark' | 'light');
// 'light-deep' adds data-theme-variant="deep" (the anchored "Slate Mist" palette).

export type AppTheme = 'system' | 'light' | 'light-deep' | 'dark'
type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'netstacks.appTheme'
const APP_THEMES: readonly AppTheme[] = ['system', 'light', 'light-deep', 'dark']

export function isAppTheme(value: unknown): value is AppTheme {
  return APP_THEMES.includes(value as AppTheme)
}

/** Read the persisted app theme (defaults to following the OS). */
export function getAppTheme(): AppTheme {
  const stored = localStorage.getItem(STORAGE_KEY)
  return isAppTheme(stored) ? stored : 'system'
}

export function resolveTheme(theme: AppTheme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return theme === 'dark' ? 'dark' : 'light'
}

let current: AppTheme = 'system'
// The native window's theme, when the host reports it. WKWebView's
// prefers-color-scheme can lag the OS, so this signal wins over matchMedia.
let nativeTheme: ResolvedTheme | null = null
let stopFollowingMedia: (() => void) | null = null

function darkQuery(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)')
}

function render(): void {
  const root = document.documentElement
  const systemPrefersDark = nativeTheme ? nativeTheme === 'dark' : darkQuery().matches
  root.dataset.theme = resolveTheme(current, systemPrefersDark)
  if (current === 'light-deep') root.dataset.themeVariant = 'deep'
  else delete root.dataset.themeVariant
}

/** Apply a theme to the document live; 'system' keeps following OS changes. */
export function applyAppTheme(theme: AppTheme): void {
  current = theme
  stopFollowingMedia?.()
  stopFollowingMedia = null
  if (theme === 'system') {
    const query = darkQuery()
    query.addEventListener('change', render)
    stopFollowingMedia = () => query.removeEventListener('change', render)
  }
  render()
}

/** Feed the native window theme (Tauri `onThemeChanged`) into 'system' resolution. */
export function setNativeTheme(theme: ResolvedTheme): void {
  nativeTheme = theme
  render()
}

/** Persist + apply a theme in one step. */
export function setAppTheme(theme: AppTheme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  applyAppTheme(theme)
}
