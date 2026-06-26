// App-wide theme (dark default / "Anchored Deep" light).
//
// The light palette lives in index.css under :root[data-theme='light'];
// dark needs no attribute — it is the :root default. Persisted via
// localStorage so every window (main app, popouts, shared views) picks
// the same theme up in main.tsx's pre-paint bootstrap.

export type AppTheme = 'dark' | 'light'

const STORAGE_KEY = 'netstacks.appTheme'

/** Read the persisted app theme (defaults to 'dark'). */
export function getAppTheme(): AppTheme {
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
}

/** Apply a theme to the document live (no reload). */
export function applyAppTheme(theme: AppTheme): void {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light'
  } else {
    delete document.documentElement.dataset.theme
  }
}

/** Persist + apply a theme in one step. */
export function setAppTheme(theme: AppTheme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  applyAppTheme(theme)
}
