/**
 * Panel Settings API
 *
 * Manages default behavior settings for sidebars and panels:
 * - Left sidebar (sessions/docs/topology panel)
 * - AI side panel
 */

export interface PanelSettings {
  /** If true, left sidebar starts pinned (won't auto-collapse) */
  leftSidebarPinned: boolean
  /** If true, AI panel starts pinned (won't auto-collapse) */
  aiPanelPinned: boolean
  /** If true, left sidebar overlays the terminal area instead of pushing it */
  sidebarOverlay: boolean
  /** If true, moving mouse to screen edges reveals hidden panels */
  hotEdgesEnabled: boolean
}

const STORAGE_KEY = 'netstacks:panelSettings'

// Custom event for same-window updates
export const PANEL_SETTINGS_CHANGED = 'netstacks:panelSettingsChanged'

const DEFAULT_SETTINGS: PanelSettings = {
  leftSidebarPinned: true,
  aiPanelPinned: true,
  sidebarOverlay: false,
  hotEdgesEnabled: true,
}

/**
 * Load panel settings from localStorage
 */
export function loadPanelSettings(): PanelSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
    }
  } catch (e) {
    console.warn('Failed to load panel settings:', e)
  }
  return DEFAULT_SETTINGS
}

/**
 * Save panel settings to localStorage
 */
export function savePanelSettings(settings: PanelSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    // Dispatch custom event for same-window updates
    window.dispatchEvent(new CustomEvent(PANEL_SETTINGS_CHANGED, { detail: settings }))
  } catch (e) {
    console.warn('Failed to save panel settings:', e)
  }
}

/**
 * Reset panel settings to defaults
 */
export function resetPanelSettings(): PanelSettings {
  savePanelSettings(DEFAULT_SETTINGS)
  return DEFAULT_SETTINGS
}
