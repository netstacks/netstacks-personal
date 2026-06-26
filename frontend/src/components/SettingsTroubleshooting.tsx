import { useState, useEffect } from 'react';
import {
  getTroubleshootingSettings,
  saveTroubleshootingSettings,
  TROUBLESHOOTING_SETTINGS_CHANGED,
} from '../api/troubleshootingSettings';
import type { TroubleshootingSettings } from '../types/troubleshooting';
import './SettingsTroubleshooting.css';

/**
 * SettingsTroubleshooting Component
 *
 * Settings panel for configuring troubleshooting session behavior including
 * inactivity timeout, auto-save, and AI conversation capture.
 */
export default function SettingsTroubleshooting() {
  const [settings, setSettings] = useState<TroubleshootingSettings>(
    getTroubleshootingSettings()
  );

  // Listen for settings changes from other sources
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'netstacks:troubleshootingSettings') {
        setSettings(getTroubleshootingSettings());
      }
    };
    const handleSettingsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<TroubleshootingSettings>;
      setSettings(customEvent.detail);
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(TROUBLESHOOTING_SETTINGS_CHANGED, handleSettingsChanged);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(TROUBLESHOOTING_SETTINGS_CHANGED, handleSettingsChanged);
    };
  }, []);

  const handleChange = <K extends keyof TroubleshootingSettings>(
    key: K,
    value: TroubleshootingSettings[K]
  ) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    saveTroubleshootingSettings(newSettings);
  };

  return (
    <div className="settings-troubleshooting">
      <div className="settings-content">
        <div className="settings-category">
          <h3 className="settings-category-title">Troubleshooting Sessions</h3>

          <div className="setting-item">
            <div className="setting-header">
              <span className="setting-label">Inactivity Timeout</span>
              <div className="setting-control">
                <div className="settings-input-group">
                  <input
                    type="number"
                    className="setting-input setting-input-number"
                    min="1"
                    max="120"
                    value={settings.inactivityTimeout}
                    onChange={(e) =>
                      handleChange('inactivityTimeout', parseInt(e.target.value) || 15)
                    }
                  />
                  <span className="settings-input-suffix">min</span>
                </div>
              </div>
            </div>
            <div className="setting-description">
              Automatically end session after this many minutes of inactivity
            </div>
          </div>

          <div className="setting-item">
            <div className="setting-header">
              <span className="setting-label">Auto-save on Timeout</span>
              <div className="setting-control">
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={settings.autoSaveOnTimeout}
                    onChange={(e) => handleChange('autoSaveOnTimeout', e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            <div className="setting-description">
              Automatically generate and save documentation when session times out
            </div>
          </div>

          <div className="setting-item">
            <div className="setting-header">
              <span className="setting-label">Capture AI Conversations</span>
              <div className="setting-control">
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={settings.captureAIConversations}
                    onChange={(e) => handleChange('captureAIConversations', e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            <div className="setting-description">
              Include AI chat messages in the session log for context
            </div>
          </div>
        </div>

        <div className="settings-category">
          <h3 className="settings-category-title">About Troubleshooting Sessions</h3>
          <div className="settings-info-box">
            <p>
              Troubleshooting sessions capture terminal commands, outputs, and optionally
              AI conversations during a debugging or investigation workflow.
            </p>
            <p>
              When you end a session, a structured document is generated that can be
              saved to the Docs panel for future reference.
            </p>
            <p>
              Start a session from the status bar or use the keyboard shortcut{' '}
              <kbd>Cmd+Shift+T</kbd>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
