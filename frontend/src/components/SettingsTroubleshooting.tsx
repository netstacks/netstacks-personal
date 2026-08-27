import { useState, useEffect } from 'react';
import {
  getTroubleshootingSettings,
  saveTroubleshootingSettings,
  TROUBLESHOOTING_SETTINGS_CHANGED,
} from '../api/troubleshootingSettings';
import type { TroubleshootingSettings } from '../types/troubleshooting';
import './SettingsTroubleshooting.css';
import { displayShortcut } from '../hooks/useKeyboard'
import Switch from './Switch';

const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 120;

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

  // Raw text of the timeout input while it's being edited. Lets the user
  // clear the field to type a new value instead of snapping back to the
  // default on the first keystroke (NS-SET-8). Committed when it parses
  // in range; clamped on blur.
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null);
  const clampTimeout = (n: number) => Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n));
  const handleTimeoutInput = (raw: string) => {
    setTimeoutDraft(raw);
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n === clampTimeout(n)) handleChange('inactivityTimeout', n);
  };
  const handleTimeoutBlur = () => {
    if (timeoutDraft !== null) {
      const n = parseInt(timeoutDraft, 10);
      if (Number.isFinite(n)) handleChange('inactivityTimeout', clampTimeout(n));
    }
    setTimeoutDraft(null);
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
                    min={TIMEOUT_MIN}
                    max={TIMEOUT_MAX}
                    value={timeoutDraft ?? settings.inactivityTimeout}
                    onChange={(e) => handleTimeoutInput(e.target.value)}
                    onBlur={handleTimeoutBlur}
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
                <Switch
                  checked={settings.autoSaveOnTimeout}
                  onChange={(checked) => handleChange('autoSaveOnTimeout', checked)}
                  label="Auto-save on Timeout"
                />
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
                <Switch
                  checked={settings.captureAIConversations}
                  onChange={(checked) => handleChange('captureAIConversations', checked)}
                  label="Capture AI Conversations"
                />
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
              <kbd>{displayShortcut('Cmd+Shift+T')}</kbd>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
