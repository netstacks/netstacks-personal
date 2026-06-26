import { useState } from 'react'
import './StatusBarSettings.css'
import {
  type StatusBarSettings,
  type StatusBarTheme,
  loadStatusBarSettings,
  saveStatusBarSettings,
  applyStatusBarTheme,
  STATUS_BAR_THEMES,
  DEFAULT_STATUS_BAR_SETTINGS,
} from '../api/statusBarSettings'

export default function StatusBarSettingsPanel() {
  const [settings, setSettings] = useState<StatusBarSettings>(() => loadStatusBarSettings())

  // Update settings and save
  const updateSettings = (updates: Partial<StatusBarSettings>) => {
    const newSettings = { ...settings, ...updates }
    setSettings(newSettings)
    saveStatusBarSettings(newSettings)
  }

  // Toggle a feature
  const toggleFeature = (key: keyof StatusBarSettings) => {
    updateSettings({ [key]: !settings[key] })
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

  return (
    <div className="status-bar-settings">
      {/* Enable/Disable */}
      <div className="status-bar-settings-row">
        <div className="status-bar-settings-label">
          <span>Show Status Bar</span>
          <span className="status-bar-settings-desc">Display the status bar at the bottom of the window</span>
        </div>
        <label className="status-bar-settings-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={() => toggleFeature('enabled')}
          />
          <span className="toggle-slider" />
        </label>
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

        <div className="status-bar-settings-row compact">
          <span>Connection Status</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showConnectionStatus}
              onChange={() => toggleFeature('showConnectionStatus')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Active Session</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showActiveSession}
              onChange={() => toggleFeature('showActiveSession')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Quick Look Buttons</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showQuickLook}
              onChange={() => toggleFeature('showQuickLook')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>AI Button</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showAIButton}
              onChange={() => toggleFeature('showAIButton')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Command Palette</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showCommandPalette}
              onChange={() => toggleFeature('showCommandPalette')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Scratchpad Button</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showScratchpad}
              onChange={() => toggleFeature('showScratchpad')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Settings Button</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showSettings}
              onChange={() => toggleFeature('showSettings')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Quick Calls</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showQuickCalls}
              onChange={() => toggleFeature('showQuickCalls')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

      </div>

      {/* Style Options */}
      <div className="status-bar-settings-section">
        <div className="status-bar-settings-section-title">Style</div>

        <div className="status-bar-settings-row compact">
          <span>Show Keyboard Shortcuts</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.showKeyboardShortcuts}
              onChange={() => toggleFeature('showKeyboardShortcuts')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row compact">
          <span>Compact Mode</span>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.compactMode}
              onChange={() => toggleFeature('compactMode')}
              disabled={!settings.enabled}
            />
            <span className="toggle-slider" />
          </label>
        </div>
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
