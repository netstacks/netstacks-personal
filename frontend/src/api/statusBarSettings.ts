/**
 * Status Bar Settings API
 * Customization options for the main application status bar
 */

// Theme presets for quick selection
export type StatusBarTheme = 'vscode-blue' | 'dark' | 'minimal' | 'accent' | 'custom';

export interface StatusBarSettings {
  // Visibility
  enabled: boolean;

  // Feature toggles - what to show
  showConnectionStatus: boolean;
  showActiveSession: boolean;
  showQuickLook: boolean;
  showSnippets: boolean;
  showQuickPrompts: boolean;
  showQuickCalls: boolean;
  showAIButton: boolean;
  showCommandPalette: boolean;
  showSettings: boolean;
  showScratchpad: boolean;

  // Theme
  theme: StatusBarTheme;

  // Custom colors (used when theme is 'custom')
  customColors: {
    background: string;
    text: string;
    hoverBackground: string;
    accentBackground: string;
  };

  // Style options
  showKeyboardShortcuts: boolean;
  compactMode: boolean;
}

// Default settings
export const DEFAULT_STATUS_BAR_SETTINGS: StatusBarSettings = {
  enabled: true,
  showConnectionStatus: true,
  showActiveSession: true,
  showQuickLook: true,
  showSnippets: true,
  showQuickPrompts: true,
  showQuickCalls: true,
  showAIButton: true,
  showCommandPalette: true,
  showSettings: true,
  showScratchpad: true,
  theme: 'vscode-blue',
  customColors: {
    background: '#007acc',
    text: '#ffffff',
    hoverBackground: 'rgba(255, 255, 255, 0.12)',
    accentBackground: 'rgba(255, 255, 255, 0.08)',
  },
  showKeyboardShortcuts: true,
  compactMode: false,
};

// Theme presets
export const STATUS_BAR_THEMES: Record<StatusBarTheme, {
  label: string;
  colors: StatusBarSettings['customColors'];
}> = {
  'vscode-blue': {
    label: 'VS Code Blue',
    colors: {
      background: '#007acc',
      text: '#ffffff',
      hoverBackground: 'rgba(255, 255, 255, 0.12)',
      accentBackground: 'rgba(255, 255, 255, 0.08)',
    },
  },
  'dark': {
    label: 'Dark',
    colors: {
      background: '#1e1e1e',
      text: 'rgba(255, 255, 255, 0.8)',
      hoverBackground: 'rgba(255, 255, 255, 0.1)',
      accentBackground: 'rgba(255, 255, 255, 0.05)',
    },
  },
  'minimal': {
    label: 'Minimal',
    colors: {
      background: 'transparent',
      text: 'var(--color-text-secondary)',
      hoverBackground: 'var(--color-bg-hover)',
      accentBackground: 'transparent',
    },
  },
  'accent': {
    label: 'Accent',
    colors: {
      background: 'var(--color-accent)',
      text: '#ffffff',
      hoverBackground: 'rgba(255, 255, 255, 0.15)',
      accentBackground: 'rgba(255, 255, 255, 0.1)',
    },
  },
  'custom': {
    label: 'Custom',
    colors: DEFAULT_STATUS_BAR_SETTINGS.customColors,
  },
};

const STORAGE_KEY = 'netstacks:statusBarSettings';

// Custom event name for settings changes
export const STATUS_BAR_SETTINGS_CHANGED = 'statusBarSettingsChanged';

/**
 * Load status bar settings from local storage
 */
export function loadStatusBarSettings(): StatusBarSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_STATUS_BAR_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to load status bar settings:', e);
  }
  return DEFAULT_STATUS_BAR_SETTINGS;
}

/**
 * Save status bar settings to local storage
 */
export function saveStatusBarSettings(settings: StatusBarSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // Dispatch custom event for same-window updates
    window.dispatchEvent(new CustomEvent(STATUS_BAR_SETTINGS_CHANGED, { detail: settings }));
  } catch (e) {
    console.warn('Failed to save status bar settings:', e);
  }
}

/**
 * Apply a theme preset to settings
 */
export function applyStatusBarTheme(settings: StatusBarSettings, theme: StatusBarTheme): StatusBarSettings {
  const preset = STATUS_BAR_THEMES[theme];
  return {
    ...settings,
    theme,
    customColors: theme === 'custom' ? settings.customColors : preset.colors,
  };
}

/**
 * Get colors for the current theme
 */
export function getStatusBarColors(settings: StatusBarSettings): StatusBarSettings['customColors'] {
  if (settings.theme === 'custom') {
    return settings.customColors;
  }
  return STATUS_BAR_THEMES[settings.theme]?.colors || DEFAULT_STATUS_BAR_SETTINGS.customColors;
}
