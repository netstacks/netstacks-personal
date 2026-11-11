/**
 * Troubleshooting Settings API
 *
 * Manages user preferences for the troubleshooting session recorder.
 * Settings are persisted to localStorage for persistence across sessions.
 */

import type { TroubleshootingSettings } from '../types/troubleshooting';

/** localStorage key for settings persistence */
const STORAGE_KEY = 'netstacks:troubleshootingSettings';

/** Custom event name for settings change notifications */
export const TROUBLESHOOTING_SETTINGS_CHANGED = 'troubleshootingSettingsChanged';

/** Default settings for troubleshooting sessions */
export const DEFAULT_TROUBLESHOOTING_SETTINGS: TroubleshootingSettings = {
  inactivityTimeout: 15,
  autoSaveOnTimeout: true,
  captureAIConversations: true,
  defaultCategory: 'troubleshooting',
};

/**
 * Load troubleshooting settings from localStorage
 * @returns Current settings merged with defaults
 */
export function getTroubleshootingSettings(): TroubleshootingSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_TROUBLESHOOTING_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.error('Failed to load troubleshooting settings:', e);
  }
  return { ...DEFAULT_TROUBLESHOOTING_SETTINGS };
}

/**
 * Save troubleshooting settings to localStorage
 * Dispatches a custom event for same-window listeners
 * @param settings - Settings to save
 */
export function saveTroubleshootingSettings(
  settings: TroubleshootingSettings
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // Dispatch custom event for reactive updates
    window.dispatchEvent(
      new CustomEvent(TROUBLESHOOTING_SETTINGS_CHANGED, { detail: settings })
    );
  } catch (e) {
    console.error('Failed to save troubleshooting settings:', e);
  }
}

/**
 * Update specific troubleshooting settings
 * @param updates - Partial settings to update
 * @returns Updated settings
 */
export function updateTroubleshootingSettings(
  updates: Partial<TroubleshootingSettings>
): TroubleshootingSettings {
  const current = getTroubleshootingSettings();
  const updated = { ...current, ...updates };
  saveTroubleshootingSettings(updated);
  return updated;
}

/**
 * Reset troubleshooting settings to defaults
 * @returns Default settings
 */
export function resetTroubleshootingSettings(): TroubleshootingSettings {
  saveTroubleshootingSettings(DEFAULT_TROUBLESHOOTING_SETTINGS);
  return { ...DEFAULT_TROUBLESHOOTING_SETTINGS };
}
