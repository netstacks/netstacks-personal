import { useState, useEffect, useCallback } from 'react';

// AI provider type (matches api/ai.ts)
export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom';

export interface AppSettings {
  // Appearance
  fontSize: number;
  fontFamily: string;

  // Terminal
  'terminal.defaultTheme': string;
  'terminal.copyOnSelect': boolean;
  // Middle-click pastes the clipboard (Linux/SecureCRT convention).
  'terminal.middleClickPaste': boolean;
  'terminal.fontWeight': string;
  // Liquid-glass (translucent/blurred) chrome, modals, popovers & AI panels.
  'ui.glassEffects': boolean;
  // Show the native window title bar + controls. Off = borderless (no title
  // bar, no traffic-light controls) so content fills the top; the window stays
  // movable via the tab bar / activity bar.
  'ui.showTitleBar': boolean;
  'terminal.lineNumbers': boolean;
  // Show a small popup with vendor info on hovered MAC addresses and
  // reverse-DNS results on hovered IP addresses. Same lookups the right-
  // click context menu items use.
  'terminal.hoverLookups': boolean;
  // Hover enrichment popover: master toggle, AI digest button, and the list of
  // source names the user has disabled. The popover also respects hoverLookups
  // as a master "hover info" switch.
  'terminal.enrichment.hoverEnabled': boolean;
  'terminal.enrichment.aiDigestEnabled': boolean;
  'terminal.enrichment.disabledSources': string[];

  // AI Features
  'ai.inlineSuggestions': boolean;
  'ai.nextStepSuggestions': boolean;
  'ai.defaultProvider': AiProviderType;
  'ai.enabledProviders': AiProviderType[];

  // AI Overlord provider/model override (null = use default)
  'ai.overlord.provider': AiProviderType | null;
  'ai.overlord.model': string | null;

  // AI Tools - list of disabled tool names (global fallback)
  'ai.disabledTools': string[];
  // Per-agent-type disabled tools (overrides global when set)
  'ai.disabledTools.autopilot': string[];
  'ai.disabledTools.overlord': string[];
  // Bash deny list — extra commands to block (added to built-in deny list)
  'ai.bash.deniedCommands': string[];

  // AI Context Management - limit conversation history to prevent context overflow
  'ai.maxConversationMessages': number;

  // Per-provider model lists - user-configured models for each provider
  'ai.models.anthropic': string[];
  'ai.models.openai': string[];
  'ai.models.openrouter': string[];
  'ai.models.ollama': string[];
  'ai.models.litellm': string[];
  'ai.models.custom': string[];

  // Per-provider max tokens (0 = no limit / use provider default)
  'ai.maxTokens.anthropic': number;
  'ai.maxTokens.openai': number;
  'ai.maxTokens.openrouter': number;
  'ai.maxTokens.ollama': number;
  'ai.maxTokens.litellm': number;
  'ai.maxTokens.custom': number;

  // AI Agent settings
  'ai.agent.provider': AiProviderType | null; // null = use default provider
  'ai.agent.model': string | null; // null = use default model for provider
  'ai.agent.temperature': number; // 0.0 - 1.0
  'ai.agent.maxTokens': number; // Max tokens per response
  'ai.agent.maxIterations': number; // Max ReAct loop iterations
  'ai.agent.systemPrompt': string; // Custom system prompt

  // Topology: allow the AI to structurally edit the active topology (add/remove/
  // move devices & connections). Off by default — the AI can always query,
  // analyze, highlight, and annotate.
  'ai.topology.allowStructuralEdits': boolean;

  // Documents: per-source auto-save targets (category + folder). Empty = use
  // the built-in defaults in lib/docSaveTargets.ts. See DocSaveSource.
  'documents.saveTargets': Partial<Record<string, { category: string; folder?: string }>>;

  // AI: show contextual "Ask AI" help buttons on confusing settings (API
  // Resources, enrichment, token matchers, integrations). Default on.
  'ai.contextualHelp.enabled': boolean;

  // App: first-run onboarding wizard completed/skipped. Default false.
  'app.setupComplete': boolean;

  // AI: user-customizable display names for the two agent modes. Consistent
  // across the UI + the mode-awareness prompt.
  'ai.modes.autopilot.name': string;
  'ai.modes.overlord.name': string;

  // AUDIT FIX (EXEC-002): `ai.allowConfigChanges` was removed in favour of
  // server-side state controlled via `enableAiConfigMode`/`disableAiConfigMode`
  // in `api/ai.ts`. Use the new `useAiConfigMode` hook instead of reading
  // this setting.

  // Detection (Phase 19)
  'detection.highlighting': boolean;

  // Command Safety (Phase 24)
  'commandSafety.enabled': boolean;

  // AUDIT FIX (REMOTE-002): `ssh.hostKeyChecking` removed. Strict host-key
  // checking is always on; per-session opt-in is the only escape hatch.
}

const defaultSettings: AppSettings = {
  // Appearance
  fontSize: 13,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",

  // Terminal
  'terminal.defaultTheme': 'default',
  'terminal.copyOnSelect': false,
  'terminal.middleClickPaste': true,
  'terminal.fontWeight': 'normal',
  'ui.glassEffects': true,
  'ui.showTitleBar': true,
  'terminal.lineNumbers': false,
  'terminal.hoverLookups': true,
  'terminal.enrichment.hoverEnabled': true,
  'terminal.enrichment.aiDigestEnabled': false,
  'terminal.enrichment.disabledSources': [],

  // AI Features
  'ai.inlineSuggestions': true,
  'ai.nextStepSuggestions': true,
  'ai.defaultProvider': 'anthropic',
  'ai.enabledProviders': ['anthropic'],

  // AI Overlord provider/model (null = use default provider)
  'ai.overlord.provider': null,
  'ai.overlord.model': null,

  // AI Tools - all enabled by default (empty array = no disabled tools)
  'ai.disabledTools': [],
  'ai.disabledTools.autopilot': [],
  'ai.disabledTools.overlord': ['run_bash'],
  'ai.bash.deniedCommands': [],

  // AI Context Management - 0 means unlimited
  'ai.maxConversationMessages': 20,

  // Per-provider model lists - start empty, user adds their own
  'ai.models.anthropic': [],
  'ai.models.openai': [],
  'ai.models.openrouter': [],
  'ai.models.ollama': [],
  'ai.models.litellm': [],
  'ai.models.custom': [],

  // Per-provider max tokens (0 = no limit / use provider default)
  'ai.maxTokens.anthropic': 4096,
  'ai.maxTokens.openai': 4096,
  'ai.maxTokens.openrouter': 4096,
  'ai.maxTokens.ollama': 0,
  'ai.maxTokens.litellm': 4096,
  'ai.maxTokens.custom': 4096,

  // AI Agent settings
  'ai.agent.provider': null,
  'ai.agent.model': null,
  'ai.agent.temperature': 0.7,
  'ai.agent.maxTokens': 4096,
  'ai.agent.maxIterations': 15,
  'ai.agent.systemPrompt': 'You are a network automation assistant. You help users gather information from network devices using SSH commands. You have access to tools for querying devices and executing read-only commands. Be concise and focus on the task at hand.',
  'ai.topology.allowStructuralEdits': false,
  'documents.saveTargets': {},
  'ai.contextualHelp.enabled': true,
  'app.setupComplete': false,
  'ai.modes.autopilot.name': 'Auto Pilot',
  'ai.modes.overlord.name': 'Overlord',

  // (AUDIT FIX EXEC-002) ai.allowConfigChanges removed — see above.

  // Detection (Phase 19)
  'detection.highlighting': true,

  // Command Safety (Phase 24)
  'commandSafety.enabled': true,

  // (AUDIT FIX REMOTE-002) ssh.hostKeyChecking removed — see above.
};

const STORAGE_KEY = 'netstacks-settings';

// Custom event for cross-component settings sync
export const SETTINGS_CHANGED_EVENT = 'netstacks:settingsChanged';

/** Migrate old settings keys to their renamed equivalents (Copilot -> Overlord). */
function migrateSettings(stored: Record<string, unknown>): Record<string, unknown> {
  const renames: [string, string][] = [
    ['ai.copilot.provider', 'ai.overlord.provider'],
    ['ai.copilot.model', 'ai.overlord.model'],
    ['ai.disabledTools.copilot', 'ai.disabledTools.overlord'],
  ];
  for (const [oldKey, newKey] of renames) {
    if (oldKey in stored && !(newKey in stored)) {
      stored[newKey] = stored[oldKey];
      delete stored[oldKey];
    }
  }
  // The per-toolset PROVIDER override was removed — there is one provider (the
  // default). Drop any legacy agent provider pin (and its provider-scoped model)
  // so the agent inherits the default instead of a possibly keyless provider.
  if ('ai.agent.provider' in stored && stored['ai.agent.provider']) {
    delete stored['ai.agent.provider'];
    delete stored['ai.agent.model'];
  }
  return stored;
}

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = migrateSettings(JSON.parse(stored));
      return { ...defaultSettings, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
  return defaultSettings;
}

function saveSettings(settings: AppSettings): void {
  try {
    globalSettings = settings; // Keep singleton in sync for getSettings() callers
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // Notify other hook instances. Deferred to a microtask because saveSettings
    // is called from inside a setState updater — dispatching synchronously makes
    // listeners setState during another component's render (React warns and the
    // render can break, e.g. "rendered fewer hooks").
    queueMicrotask(() =>
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }))
    );
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  // Listen for settings changes from other hook instances (same window).
  useEffect(() => {
    const handleSettingsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<AppSettings>;
      setSettings(customEvent.detail);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
  }, []);

  // Listen for storage events from OTHER windows (popouts share the
  // same WebView origin → same localStorage). Without this, editing a
  // setting in a popout left the main window showing stale state until
  // reload. The custom event above only fires within the window that
  // wrote — the browser storage event fires in every OTHER window.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      if (e.newValue === null) {
        setSettings(defaultSettings);
        globalSettings = defaultSettings;
        return;
      }
      try {
        const merged = { ...defaultSettings, ...JSON.parse(e.newValue) };
        setSettings(merged);
        // Keep the singleton in sync for non-hook callers in this window.
        globalSettings = merged;
      } catch {
        // Corrupt incoming value — leave state alone.
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Save to localStorage when settings change (but don't trigger event recursively)
  const updateSetting = useCallback(<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    setSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      saveSettings(newSettings);
      return newSettings;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(defaultSettings);
    saveSettings(defaultSettings);
  }, []);

  return {
    settings,
    updateSetting,
    resetSettings,
  };
}

// Singleton for non-hook access
let globalSettings: AppSettings = loadSettings();

export function getSettings(): AppSettings {
  return globalSettings;
}

export function setGlobalSettings(settings: AppSettings): void {
  globalSettings = settings;
  saveSettings(settings);
}
