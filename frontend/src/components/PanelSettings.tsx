import { useState, useEffect } from 'react'
import './StatusBarSettings.css' // Reuse existing settings styles
import Switch from './Switch'
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
          <Switch
            checked={settings.leftSidebarPinned}
            onChange={(v) => updateSetting('leftSidebarPinned', v)}
            label="Left Sidebar Pinned"
          />
        </div>

        <div className="status-bar-settings-row">
          <div className="status-bar-settings-label">
            <span>AI Panel Pinned</span>
            <span className="status-bar-settings-desc">
              When pinned, the AI panel stays open. When unpinned, it auto-hides when focus moves away.
            </span>
          </div>
          <Switch
            checked={settings.aiPanelPinned}
            onChange={(v) => updateSetting('aiPanelPinned', v)}
            label="AI Panel Pinned"
          />
        </div>

        <div className="status-bar-settings-row">
          <div className="status-bar-settings-label">
            <span>Sidebar Overlay</span>
            <span className="status-bar-settings-desc">
              When enabled, the left sidebar floats over the terminal area. When disabled, opening the sidebar pushes the tabs and terminal to make room.
            </span>
          </div>
          <Switch
            checked={settings.sidebarOverlay}
            onChange={(v) => updateSetting('sidebarOverlay', v)}
            label="Sidebar Overlay"
          />
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
          <Switch
            checked={settings.hotEdgesEnabled}
            onChange={(v) => updateSetting('hotEdgesEnabled', v)}
            label="Enable Hot Edges"
          />
        </div>
      </div>

      {/* Reset Button */}
      <button className="status-bar-settings-reset" onClick={handleReset}>
        Reset to Defaults
      </button>
    </div>
  )
}
