import { useState, useEffect } from 'react'
import Switch from './Switch'
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
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
    <SettingsSection
      title="Panels"
      description="How the sidebar and AI panel open, close and float."
      actions={<button className="ns-btn ns-btn--small" onClick={handleReset}>Reset to Defaults</button>}
    >
      <div className="settings-group">
        <SettingRow
          label="Left Sidebar Pinned"
          description="When pinned, the sidebar stays open. When unpinned, it auto-hides when focus moves away."
        >
          <Switch
            checked={settings.leftSidebarPinned}
            onChange={(v) => updateSetting('leftSidebarPinned', v)}
            label="Left Sidebar Pinned"
          />
        </SettingRow>
        <SettingRow
          label="AI Panel Pinned"
          description="When pinned, the AI panel stays open. When unpinned, it auto-hides when focus moves away."
        >
          <Switch
            checked={settings.aiPanelPinned}
            onChange={(v) => updateSetting('aiPanelPinned', v)}
            label="AI Panel Pinned"
          />
        </SettingRow>
        <SettingRow
          label="Sidebar Overlay"
          description="When enabled, the left sidebar floats over the terminal area. When disabled, opening the sidebar pushes the tabs and terminal to make room."
        >
          <Switch
            checked={settings.sidebarOverlay}
            onChange={(v) => updateSetting('sidebarOverlay', v)}
            label="Sidebar Overlay"
          />
        </SettingRow>
        <SettingRow
          label="Hot Edges"
          description="Moving the mouse to the left or right edge of the window reveals hidden panels."
        >
          <Switch
            checked={settings.hotEdgesEnabled}
            onChange={(v) => updateSetting('hotEdgesEnabled', v)}
            label="Enable Hot Edges"
          />
        </SettingRow>
      </div>
    </SettingsSection>
  )
}
