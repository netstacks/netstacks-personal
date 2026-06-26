import { useState, useEffect } from 'react'
import './StatusBarSettings.css' // Reuse existing settings styles
import {
  type PanelSettings,
  loadPanelSettings,
  savePanelSettings,
  resetPanelSettings,
  PANEL_SETTINGS_CHANGED,
} from '../api/panelSettings'

export default function PanelSettingsPanel() {
  const [settings, setSettings] = useState<PanelSettings>(() => loadPanelSettings())

  // Listen for external changes
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'netstacks:panelSettings') {
        setSettings(loadPanelSettings())
      }
    }
    const handleSettingsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<PanelSettings>
      setSettings(customEvent.detail)
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(PANEL_SETTINGS_CHANGED, handleSettingsChanged)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(PANEL_SETTINGS_CHANGED, handleSettingsChanged)
    }
  }, [])

  const updateSetting = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => {
    const newSettings = { ...settings, [key]: value }
    setSettings(newSettings)
    savePanelSettings(newSettings)
  }

  const handleReset = () => {
    const defaults = resetPanelSettings()
    setSettings(defaults)
  }

  return (
    <div className="status-bar-settings">
      {/* Panel Behavior */}
      <div className="status-bar-settings-section">
        <div className="status-bar-settings-section-title">Default Behavior</div>

        <div className="status-bar-settings-row">
          <div className="status-bar-settings-label">
            <span>Left Sidebar Pinned</span>
            <span className="status-bar-settings-desc">
              When pinned, the sidebar stays open. When unpinned, it auto-hides when focus moves away.
            </span>
          </div>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.leftSidebarPinned}
              onChange={(e) => updateSetting('leftSidebarPinned', e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row">
          <div className="status-bar-settings-label">
            <span>AI Panel Pinned</span>
            <span className="status-bar-settings-desc">
              When pinned, the AI panel stays open. When unpinned, it auto-hides when focus moves away.
            </span>
          </div>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.aiPanelPinned}
              onChange={(e) => updateSetting('aiPanelPinned', e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="status-bar-settings-row">
          <div className="status-bar-settings-label">
            <span>Sidebar Overlay</span>
            <span className="status-bar-settings-desc">
              When enabled, the left sidebar floats over the terminal area. When disabled, opening the sidebar pushes the tabs and terminal to make room.
            </span>
          </div>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.sidebarOverlay}
              onChange={(e) => updateSetting('sidebarOverlay', e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* Hot Edges */}
      <div className="status-bar-settings-section">
        <div className="status-bar-settings-section-title">Hot Edges</div>

        <div className="status-bar-settings-row">
          <div className="status-bar-settings-label">
            <span>Enable Hot Edges</span>
            <span className="status-bar-settings-desc">
              Moving the mouse to the left or right edge of the window reveals hidden panels.
            </span>
          </div>
          <label className="status-bar-settings-toggle">
            <input
              type="checkbox"
              checked={settings.hotEdgesEnabled}
              onChange={(e) => updateSetting('hotEdgesEnabled', e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* Reset Button */}
      <button className="status-bar-settings-reset" onClick={handleReset}>
        Reset to Defaults
      </button>
    </div>
  )
}
