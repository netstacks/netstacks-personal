import { useState, useEffect } from 'react';
import {
  getTroubleshootingSettings,
  saveTroubleshootingSettings,
  TROUBLESHOOTING_SETTINGS_CHANGED,
} from '../api/troubleshootingSettings';
import type { TroubleshootingSettings } from '../types/troubleshooting';
import './SettingsTroubleshooting.css';
import { useShortcut } from '../hooks/useKeyboard'
import Switch from './Switch';
import SettingsSection from './settings/SettingsSection';
import SettingRow from './settings/SettingRow';

const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 120;

/**
 * SettingsTroubleshooting Component
 *
 * Settings panel for configuring troubleshooting session behavior including
 * inactivity timeout, auto-save, and AI conversation capture.
 */
export default function SettingsTroubleshooting() {
  const troubleshootShortcut = useShortcut('startTroubleshooting')
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
    <SettingsSection
      title="Troubleshooting Sessions"
      description={
        <>
          Capture terminal commands, outputs and optionally AI conversations while you investigate; ending a session
          generates a document you can save to Docs. Start one from the status bar or with <kbd>{troubleshootShortcut}</kbd>.
        </>
      }
    >
      <div className="settings-group">
        <SettingRow label="Inactivity Timeout" description="Automatically end the session after this many minutes of inactivity">
          <span className="settings-troubleshooting-timeout">
            <input aria-label="Inactivity Timeout"
              type="number"
              className="ns-input setting-input-number"
              min={TIMEOUT_MIN}
              max={TIMEOUT_MAX}
              value={timeoutDraft ?? settings.inactivityTimeout}
              onChange={(e) => handleTimeoutInput(e.target.value)}
              onBlur={handleTimeoutBlur}
            />
            min
          </span>
        </SettingRow>
        <SettingRow label="Auto-save on Timeout" description="Automatically generate and save documentation when the session times out">
          <Switch
            checked={settings.autoSaveOnTimeout}
            onChange={(checked) => handleChange('autoSaveOnTimeout', checked)}
            label="Auto-save on Timeout"
          />
        </SettingRow>
        <SettingRow label="Capture AI Conversations" description="Include AI chat messages in the session log for context">
          <Switch
            checked={settings.captureAIConversations}
            onChange={(checked) => handleChange('captureAIConversations', checked)}
            label="Capture AI Conversations"
          />
        </SettingRow>
      </div>
    </SettingsSection>
  );
}
