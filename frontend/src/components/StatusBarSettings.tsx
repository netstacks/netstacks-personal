import { useState, useEffect } from 'react'
import './StatusBarSettings.css'
import Switch from './Switch'
import {
  type StatusBarSettings,
  type StatusBarTheme,
  loadStatusBarSettings,
  saveStatusBarSettings,
  applyStatusBarTheme,
  STATUS_BAR_THEMES,
  DEFAULT_STATUS_BAR_SETTINGS,
  STATUS_BAR_SETTINGS_CHANGED,
} from '../api/statusBarSettings'

type FeatureKey = {
  [K in keyof StatusBarSettings]: StatusBarSettings[K] extends boolean ? K : never
}[keyof StatusBarSettings]

// Every boolean the status bar honours gets a row here — StatusBar.tsx reads
// showSnippets/showQuickPrompts too, which had no toggle before (NS-SET-6).
const ELEMENT_TOGGLES: { key: FeatureKey; label: string }[] = [
  { key: 'showConnectionStatus', label: 'Connection Status' },
  { key: 'showActiveSession', label: 'Active Session' },
  { key: 'showQuickLook', label: 'Quick Look Buttons' },
  { key: 'showSnippets', label: 'Snippets' },
  { key: 'showQuickPrompts', label: 'Quick Prompts' },
  { key: 'showAIButton', label: 'AI Button' },
  { key: 'showCommandPalette', label: 'Command Palette' },
  { key: 'showScratchpad', label: 'Scratchpad Button' },
  { key: 'showSettings', label: 'Settings Button' },
  { key: 'showQuickCalls', label: 'Quick Calls' },
]

const STYLE_TOGGLES: { key: FeatureKey; label: string }[] = [
  { key: 'showKeyboardShortcuts', label: 'Show Keyboard Shortcuts' },
  { key: 'compactMode', label: 'Compact Mode' },
]

export default function StatusBarSettingsPanel() {
  const [settings, setSettings] = useState<StatusBarSettings>(() => loadStatusBarSettings())

  // Stay in sync when something else writes the settings — the General
  // tab's "Reset to defaults" (NS-SET-2) or a popout window.
  useEffect(() => {
    const handleChanged = (e: Event) => {
      setSettings((e as CustomEvent<StatusBarSettings>).detail)
    }
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'netstacks:statusBarSettings') setSettings(loadStatusBarSettings())
    }
    window.addEventListener(STATUS_BAR_SETTINGS_CHANGED, handleChanged)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(STATUS_BAR_SETTINGS_CHANGED, handleChanged)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  // Update settings and save
  const updateSettings = (updates: Partial<StatusBarSettings>) => {
    const newSettings = { ...settings, ...updates }
    setSettings(newSettings)
    saveStatusBarSettings(newSettings)
  }

  // Apply a theme
  const handleThemeChange = (theme: StatusBarTheme) => {
    const newSettings = applyStatusBarTheme(settings, theme)
    setSettings(newSettings)
    saveStatusBarSettings(newSettings)
  }

  // Update custom color
  const updateCustomColor = (key: keyof StatusBarSettings['customColors'], value: string) => {
    updateSettings({
      customColors: { ...settings.customColors, [key]: value },
    })
  }

  // Reset to defaults
  const resetToDefaults = () => {
    setSettings(DEFAULT_STATUS_BAR_SETTINGS)
    saveStatusBarSettings(DEFAULT_STATUS_BAR_SETTINGS)
  }

  const renderToggleRow = ({ key, label }: { key: FeatureKey; label: string }) => (
    <div key={key} className="status-bar-settings-row compact">
      <span>{label}</span>
      <Switch
        checked={settings[key]}
        onChange={(checked) => updateSettings({ [key]: checked })}
        disabled={!settings.enabled}
        label={label}
      />
    </div>
  )

  return (
    <div className="status-bar-settings">
      {/* Enable/Disable */}
      <div className="status-bar-settings-row">
        <div className="status-bar-settings-label">
          <span>Show Status Bar</span>
          <span className="status-bar-settings-desc">Display the status bar at the bottom of the window</span>
        </div>
        <Switch
          checked={settings.enabled}
          onChange={(checked) => updateSettings({ enabled: checked })}
          label="Show Status Bar"
        />
      </div>

      {/* Theme Selection */}
      <div className="status-bar-settings-section">
        <div className="status-bar-settings-section-title">Theme</div>
        <div className="status-bar-settings-themes">
          {(Object.entries(STATUS_BAR_THEMES) as [StatusBarTheme, typeof STATUS_BAR_THEMES[StatusBarTheme]][]).map(([key, theme]) => (
            <button
              key={key}
              className={`status-bar-theme-btn ${settings.theme === key ? 'active' : ''}`}
              onClick={() => handleThemeChange(key)}
              disabled={!settings.enabled}
            >
              <span
                className="status-bar-theme-preview"
                style={{
                  background: key === 'minimal' ? 'var(--color-bg-secondary)' :
                             key === 'accent' ? 'var(--color-accent)' : theme.colors.background,
                  border: key === 'minimal' ? '1px solid var(--color-border)' : 'none',
                }}
              />
              <span className="status-bar-theme-name">{theme.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Custom Colors (only when custom theme selected) */}
      {settings.theme === 'custom' && (
        <div className="status-bar-settings-section">
          <div className="status-bar-settings-section-title">Custom Colors</div>
          <div className="status-bar-settings-colors">
            <div className="status-bar-color-row">
              <label>Background</label>
              <input
                type="color"
                value={settings.customColors.background}
                onChange={e => updateCustomColor('background', e.target.value)}
                disabled={!settings.enabled}
              />
            </div>
            <div className="status-bar-color-row">
              <label>Text</label>
              <input
                type="color"
                value={settings.customColors.text}
                onChange={e => updateCustomColor('text', e.target.value)}
                disabled={!settings.enabled}
              />
            </div>
          </div>
        </div>
      )}

      {/* Feature Toggles */}
      <div className="status-bar-settings-section">
        <div className="status-bar-settings-section-title">Elements</div>
        {ELEMENT_TOGGLES.map(renderToggleRow)}
      </div>

      {/* Style Options */}
      <div className="status-bar-settings-section">
        <div className="status-bar-settings-section-title">Style</div>
        {STYLE_TOGGLES.map(renderToggleRow)}
      </div>

      {/* Reset */}
      <button
        className="status-bar-settings-reset"
        onClick={resetToDefaults}
      >
        Reset to Defaults
      </button>
    </div>
  )
}
