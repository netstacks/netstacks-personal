import AITabInput from './AITabInput'
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ANTHROPIC_MODELS, MODEL_PLACEHOLDER, SUGGESTED_MODEL } from '../lib/aiModelDefaults';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { getClient, isClientInitialized } from '../api/client';
import { providerRequirements } from './aiProviderValidation';
import {
  getAiConfig,
  setAiConfig,
  getAiProviderOverrides,
  setAiProviderOverrides,
  setAiAgentConfig,
  hasAiApiKey,
  storeAiApiKey,
  deleteAiApiKey,
  testAiConnection,
  DEFAULT_OLLAMA_URL,
  DEFAULT_LITELLM_URL,
  fetchOllamaModels,
  checkOllamaStatus,
  getSanitizationConfig,
  setSanitizationConfig,
  testSanitization,
  DEFAULT_SANITIZATION_CONFIG,
  type AiConfig,
  type AiProviderType,
  type SanitizationConfig,
  type CustomPattern,
  type SanitizationTestResult,
  getAiStatus,
  enableAiConfigMode,
  disableAiConfigMode,
  getAiConfigModeStatus,
  type ConfigModeStatus,
  listProviderModels,
  type ProviderModel,
  getAiApiKey,
} from '../api/ai';
import { useSettings, type AppSettings, type AiProviderType as SettingsProviderType } from '../hooks/useSettings';
import { useMode } from '../hooks/useMode';
import { useTokenUsage, type AiProviderType as TokenProviderType } from '../contexts/TokenUsageContext';
import { toolRegistryFor, TOOL_CATEGORIES, type ToolCategory } from '../lib/agentTools';
import { PERMISSION_MODES, PERMISSION_MODE_SETTING, type PermissionMode } from '../lib/aiModes';
import McpServersSection from './McpServersSection';
import SettingsSection from './settings/SettingsSection';
import SettingRow from './settings/SettingRow';
import SettingsItem from './settings/SettingsItem';
import AIMemoryTab from './AIMemoryTab';
import { PasswordInput } from './PasswordInput';
import './AISettingsTab.css';

// Icons
import { getErrorMessage } from '../api/errors'
import Switch from './Switch';
import Tooltip from './Tooltip';
const Icons = {
  anthropic: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M17.557 3.5h-4.09L7.1 20.5h4.09l6.367-17zm-9.469 0l-4.06 10.86h4.015l1.918-5.23 1.913 5.23h4.015L10.003 3.5z" />
    </svg>
  ),
  openai: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062l-4.84 2.797a4.504 4.504 0 0 1-6.14-1.652zm-1.07-10.46A4.47 4.47 0 0 1 4.865 5.24l-.001.161v5.52a.78.78 0 0 0 .39.68l5.842 3.369-2.019 1.166a.075.075 0 0 1-.073.003l-4.84-2.793A4.504 4.504 0 0 1 2.53 7.844zm16.11 3.775-5.847-3.375 2.022-1.166a.076.076 0 0 1 .073-.004l4.84 2.795a4.494 4.494 0 0 1-.7 8.112v-5.68a.79.79 0 0 0-.388-.682zm2.007-3.021-.14-.086-4.779-2.759a.779.779 0 0 0-.784 0l-5.842 3.37V6.789a.075.075 0 0 1 .034-.062l4.84-2.793a4.494 4.494 0 0 1 6.671 4.664zm-12.638 4.165-2.02-1.166a.079.079 0 0 1-.038-.058V5.955a4.504 4.504 0 0 1 7.376-3.458l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.501 2.602 1.5v3.003l-2.602 1.5-2.602-1.5z" />
    </svg>
  ),
  ollama: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  openrouter: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  litellm: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  custom: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  arrowUp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  ),
  arrowDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  test: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  save: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
};

// Provider configuration
const PROVIDERS: { type: AiProviderType; name: string; icon: React.ReactNode; description: string; requiresKey: boolean }[] = [
  { type: 'anthropic', name: 'Anthropic', icon: Icons.anthropic, description: 'Claude models - best for complex reasoning', requiresKey: true },
  { type: 'openai', name: 'OpenAI', icon: Icons.openai, description: 'GPT models - versatile and widely used', requiresKey: true },
  { type: 'openrouter', name: 'OpenRouter', icon: Icons.openrouter, description: 'Access 200+ models via unified API', requiresKey: true },
  { type: 'ollama', name: 'Ollama', icon: Icons.ollama, description: 'Run AI models locally - no API key needed', requiresKey: false },
  { type: 'litellm', name: 'LiteLLM', icon: Icons.litellm, description: 'OpenAI-compatible proxy for any model', requiresKey: false },
  { type: 'custom', name: 'Custom', icon: Icons.custom, description: 'Connect to any OpenAI-compatible API', requiresKey: true },
];

type ConnectionStatus = 'unconfigured' | 'configured' | 'testing' | 'connected' | 'error';


export default function AISettingsTab() {
  // Enterprise mode detection
  const { isEnterprise } = useMode();
  const hasAiTools = useCapabilitiesStore((s) => s.hasFeature)('local_ai_tools');
  // Enterprise redaction rules are the org's (/admin/sanitization/config,
  // admin-only): only an org admin reads and edits them here. Standalone
  // edits this machine's own rules.
  const canManageRedaction = useCapabilitiesStore((s) => !isEnterprise || s.hasPermission('system.manage'));

  // App settings for default provider and highlighting toggles
  const { settings, updateSetting } = useSettings();

  // Global token usage
  const { usage: tokenUsage, resetProvider: resetProviderTokens, resetAll: resetAllTokens } = useTokenUsage();

  // Expanded sections state
  const [expandedProviders, setExpandedProviders] = useState<Set<AiProviderType>>(new Set(['anthropic']));
  const [expandedToolCategories, setExpandedToolCategories] = useState<Set<ToolCategory>>(new Set());

  // AUDIT FIX (EXEC-002): server-side AI config-mode state. The user must
  // re-supply the master password to enable; the override expires server-side
  // after ~5 min. We poll status every 15 s while the panel is mounted so
  // the countdown stays roughly accurate.
  const [configModeStatus, setConfigModeStatus] = useState<ConfigModeStatus>({
    enabled: false,
    expires_at: null,
    seconds_remaining: null,
  });
  const [configModePassword, setConfigModePassword] = useState('');
  const [configModeBusy, setConfigModeBusy] = useState(false);
  const [configModeError, setConfigModeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      getAiConfigModeStatus()
        .then((s) => { if (!cancelled) setConfigModeStatus(s); })
        .catch(() => { /* status endpoint is informational */ });
    };
    refresh();
    timer = setInterval(refresh, 15000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, []);

  const handleEnableConfigMode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setConfigModeError(null);
    if (!isEnterprise && configModePassword.length < 12) {
      setConfigModeError('Master password must be at least 12 characters.');
      return;
    }
    setConfigModeBusy(true);
    try {
      const status = isEnterprise
        ? await enableAiConfigMode()
        : await enableAiConfigMode(configModePassword);
      setConfigModeStatus(status);
      setConfigModePassword('');
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
      const status = axiosErr.response?.status;
      const apiError = axiosErr.response?.data?.error;
      const fallback = getErrorMessage(err, 'Failed to enable config mode');
      // 401 from /ai/config-mode/enable means wrong password (standalone path).
      // Session-only path (enterprise) doesn't return 401 — session auth happens earlier.
      const friendly = status === 401
        ? 'Wrong master password.'
        : apiError ?? fallback;
      setConfigModeError(friendly);
    } finally {
      setConfigModeBusy(false);
    }
  };

  const handleDisableConfigMode = async () => {
    setConfigModeBusy(true);
    setConfigModeError(null);
    try {
      const status = await disableAiConfigMode();
      setConfigModeStatus(status);
    } catch (err) {
      setConfigModeError(getErrorMessage(err, 'Failed to disable config mode'));
    } finally {
      setConfigModeBusy(false);
    }
  };

  // Check controller's global AI config changes setting (enterprise mode only)
  const [controllerAiConfigEnabled, setControllerAiConfigEnabled] = useState(true);
  useEffect(() => {
    if (!isEnterprise) {
      setControllerAiConfigEnabled(true); // standalone = always allowed
      return;
    }
    if (!isClientInitialized()) return;
    // Fetch controller setting
    getClient().http.get('/settings/ai.config_changes_enabled')
      .then((res) => {
        // Handle various response formats: raw boolean, string "true", or {value: true/\"true\"}
        const data = res.data;
        const val = typeof data === 'object' && data !== null ? (data.value ?? data) : data;
        const enabled = val === true || val === 'true' || String(val).toLowerCase() === 'true';
        setControllerAiConfigEnabled(enabled);
      })
      .catch(() => {
        setControllerAiConfigEnabled(true); // default to unlocked if setting doesn't exist yet
      });
  }, [isEnterprise]);

  // AI Terminal Mode — lets the write_file / edit_file / patch_file tools run
  // against device and host filesystems. Standalone only (useAIAgent skips
  // the read in enterprise). Stored as `{ value: "true" | "false" }`, which
  // is the shape both agent-side readers accept.
  const [aiTerminalMode, setAiTerminalMode] = useState(false);
  useEffect(() => {
    if (isEnterprise || !isClientInitialized()) return;
    getClient().http.get('/settings/ai.terminal_mode')
      .then((res) => {
        const data = res.data;
        setAiTerminalMode(data === true || data?.value === 'true');
      })
      .catch(() => setAiTerminalMode(false)); // not set = off
  }, [isEnterprise]);

  const handleToggleTerminalMode = async (enabled: boolean) => {
    const previous = aiTerminalMode;
    setAiTerminalMode(enabled);
    try {
      await getClient().http.put('/settings/ai.terminal_mode', { value: enabled ? 'true' : 'false' });
    } catch (err) {
      setAiTerminalMode(previous);
      setError(getErrorMessage(err, 'Failed to update AI Terminal Mode'));
    }
  };

  // Track configuration status for each provider
  const [providerStatus, setProviderStatus] = useState<Record<AiProviderType, {
    hasKey: boolean;
    connectionStatus: ConnectionStatus;
    connectionMessage: string;
  }>>({
    anthropic: { hasKey: false, connectionStatus: 'unconfigured', connectionMessage: '' },
    openai: { hasKey: false, connectionStatus: 'unconfigured', connectionMessage: '' },
    openrouter: { hasKey: false, connectionStatus: 'unconfigured', connectionMessage: '' },
    ollama: { hasKey: false, connectionStatus: 'unconfigured', connectionMessage: '' },
    litellm: { hasKey: false, connectionStatus: 'unconfigured', connectionMessage: '' },
    custom: { hasKey: false, connectionStatus: 'unconfigured', connectionMessage: '' },
  });

  // API keys (input values, not stored)
  const [apiKeys, setApiKeys] = useState<Record<AiProviderType, string>>({
    anthropic: '',
    openai: '',
    openrouter: '',
    ollama: '',
    litellm: '',
    custom: '',
  });

  // Base URLs for providers that need them
  const [baseUrls, setBaseUrls] = useState<Record<AiProviderType, string>>({
    anthropic: '',
    openai: '',
    openrouter: '',
    ollama: DEFAULT_OLLAMA_URL,
    litellm: DEFAULT_LITELLM_URL,
    custom: '',
  });

  // TLS verification per provider (default true = verify certs)
  const [verifySSL, setVerifySSL] = useState<Record<AiProviderType, boolean>>({
    anthropic: true,
    openai: true,
    openrouter: true,
    ollama: true,
    litellm: true,
    custom: true,
  });

  // Custom model name
  const [customModel, setCustomModel] = useState<string>('');

  // OAuth2 configuration for custom provider
  const [authMode, setAuthMode] = useState<'api_key' | 'oauth2'>('api_key');
  const [oauth2TokenUrl, setOauth2TokenUrl] = useState('');
  const [oauth2ClientId, setOauth2ClientId] = useState('');
  const [customHeaders, setCustomHeaders] = useState('');
  const [apiFormat, setApiFormat] = useState<'openai' | 'gemini' | 'vertex-anthropic'>('openai');
  // Guards the debounced persistence of per-provider overrides so the initial
  // hydration doesn't immediately write back to settings.
  const overridesHydratedRef = useRef(false);

  // New model input per provider (for adding models to the list)
  const [newModelInputs, setNewModelInputs] = useState<Record<AiProviderType, string>>({
    anthropic: '',
    openai: '',
    openrouter: '',
    ollama: '',
    litellm: '',
    custom: '',
  });

  // Live model fetching state (Task 5)
  const [liveModels, setLiveModels] = useState<Record<string, ProviderModel[]>>({});
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  const [modelsError, setModelsError] = useState<Record<string, string>>({});
  // Which provider's model combobox suggestion list is currently open.
  const [openModelCombo, setOpenModelCombo] = useState<string | null>(null);

  // Ollama-specific state
  const [ollamaStatus, setOllamaStatus] = useState<{ running: boolean; models: string[] }>({ running: false, models: [] });
  const [ollamaModels, setOllamaModels] = useState<{ value: string; label: string }[]>([]);

  // Enterprise mode: providers from Controller
  const [enterpriseProviders, setEnterpriseProviders] = useState<{ type: string; name: string; is_default: boolean }[]>([]);

  // Sanitization state
  const [sanitizationConfig, setSanitizationConfigState] = useState<SanitizationConfig>({ ...DEFAULT_SANITIZATION_CONFIG });
  const [sanitizationLoading, setSanitizationLoading] = useState(true);
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<SanitizationTestResult | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [newPattern, setNewPattern] = useState<CustomPattern>({ name: '', regex: '', replacement: '' });
  const [newAllowlistItem, setNewAllowlistItem] = useState('');
  const [mandatoryPatternsExpanded, setMandatoryPatternsExpanded] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<AiProviderType | null>(null);
  const [testing, setTesting] = useState<AiProviderType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load initial configuration
  useEffect(() => {
    loadAllProviderStatus();
  }, []);

  useEffect(() => {
    if (!canManageRedaction) return;
    let cancelled = false;
    setSanitizationLoading(true);
    getSanitizationConfig()
      // Ensure custom_patterns and allowlist always have arrays (controller may omit them)
      .then((config) => ({
        ...DEFAULT_SANITIZATION_CONFIG,
        ...config,
        custom_patterns: config.custom_patterns || [],
        allowlist: config.allowlist || [],
      }))
      // getSanitizationConfig already maps "nothing saved yet" (404) to the defaults
      .catch(() => ({ ...DEFAULT_SANITIZATION_CONFIG }))
      .then((config) => {
        if (cancelled) return;
        setSanitizationConfigState(config);
        setSanitizationLoading(false);
      });
    return () => { cancelled = true; };
  }, [canManageRedaction]);

  // Agent settings also live in the backend's ai.agent_config. Written when
  // the user changes one here — never on opening the tab.
  type AgentSettingKey = 'ai.agent.model' | 'ai.agent.temperature' | 'ai.agent.maxTokens' | 'ai.agent.maxIterations';
  const updateAgentSetting = <K extends AgentSettingKey>(key: K, value: AppSettings[K]) => {
    updateSetting(key, value);
    const next = { ...settings, [key]: value };
    setAiAgentConfig({
      // Provider is never a per-toolset override — the agent inherits the
      // single default provider. Only an optional model may differ.
      provider: null,
      model: next['ai.agent.model'],
      temperature: next['ai.agent.temperature'],
      max_tokens: next['ai.agent.maxTokens'],
      max_iterations: next['ai.agent.maxIterations'],
      system_prompt: next['ai.agent.systemPrompt'],
    }).catch((err: unknown) => {
      console.error('Failed to sync agent config to backend:', err);
    });
  };

  const saveSanitizationConfig = async (config: SanitizationConfig) => {
    setSanitizationConfigState(config);
    try {
      await setSanitizationConfig(config);
    } catch (err) {
      console.error('Failed to save sanitization config:', err);
    }
  };

  const handleToggleSanitization = (key: keyof SanitizationConfig, value: boolean) => {
    const updated = { ...sanitizationConfig, [key]: value };
    saveSanitizationConfig(updated);
  };

  const handleAddCustomPattern = () => {
    if (!newPattern.name || !newPattern.regex || !newPattern.replacement) return;
    const updated = {
      ...sanitizationConfig,
      custom_patterns: [...sanitizationConfig.custom_patterns, { ...newPattern }],
    };
    saveSanitizationConfig(updated);
    setNewPattern({ name: '', regex: '', replacement: '' });
  };

  const handleRemoveCustomPattern = (index: number) => {
    const updated = {
      ...sanitizationConfig,
      custom_patterns: sanitizationConfig.custom_patterns.filter((_, i) => i !== index),
    };
    saveSanitizationConfig(updated);
  };

  const handleAddAllowlistItem = () => {
    if (!newAllowlistItem.trim()) return;
    const updated = {
      ...sanitizationConfig,
      allowlist: [...sanitizationConfig.allowlist, newAllowlistItem.trim()],
    };
    saveSanitizationConfig(updated);
    setNewAllowlistItem('');
  };

  const handleRemoveAllowlistItem = (index: number) => {
    const updated = {
      ...sanitizationConfig,
      allowlist: sanitizationConfig.allowlist.filter((_, i) => i !== index),
    };
    saveSanitizationConfig(updated);
  };

  const handleTestSanitization = async () => {
    if (!testInput.trim()) return;
    setTestRunning(true);
    try {
      const result = await testSanitization(testInput);
      setTestResult(result);
    } catch (err) {
      console.error('Sanitization test failed:', err);
    } finally {
      setTestRunning(false);
    }
  };

  // Enabled providers from settings
  const enabledProviders = settings['ai.enabledProviders'] || ['anthropic'];

  const isProviderEnabled = (type: AiProviderType) => enabledProviders.includes(type);

  const toggleProviderEnabled = (type: AiProviderType) => {
    const current = settings['ai.enabledProviders'] || ['anthropic'];
    if (current.includes(type)) {
      // Don't allow disabling the last provider
      if (current.length <= 1) return;
      updateSetting('ai.enabledProviders', current.filter(p => p !== type));
      // If disabling the default provider, switch default to first remaining
      if (settings['ai.defaultProvider'] === type) {
        const remaining = current.filter(p => p !== type);
        updateSetting('ai.defaultProvider', remaining[0] as SettingsProviderType);
      }
      // Collapse disabled provider
      setExpandedProviders(prev => {
        const next = new Set(prev);
        next.delete(type);
        return next;
      });
    } else {
      updateSetting('ai.enabledProviders', [...current, type]);
    }
  };

  const loadAllProviderStatus = async () => {
    try {
      setLoading(true);

      // Enterprise mode: fetch providers from Controller
      if (isEnterprise) {
        const status = await getAiStatus();
        setEnterpriseProviders(status.providers);
        // Set all controller providers as "configured" in providerStatus so dropdowns work
        const newStatus = { ...providerStatus };
        for (const p of status.providers) {
          const pType = p.type as AiProviderType;
          if (newStatus[pType]) {
            newStatus[pType] = {
              hasKey: true,
              connectionStatus: 'connected',
              connectionMessage: p.is_default ? 'Default provider' : 'Available',
            };
          }
        }
        setProviderStatus(newStatus);
        setLoading(false);
        return;
      }

      // Only check API keys for enabled providers. allSettled so one
      // vault-level error doesn't wipe the other three providers'
      // "key saved" indicators — each rejection just falls back to false.
      const [anthropicRes, openaiRes, openrouterRes, customRes] = await Promise.allSettled([
        isProviderEnabled('anthropic') ? hasAiApiKey('anthropic') : Promise.resolve(false),
        isProviderEnabled('openai') ? hasAiApiKey('openai') : Promise.resolve(false),
        isProviderEnabled('openrouter') ? hasAiApiKey('openrouter') : Promise.resolve(false),
        // Custom is always considered "enabled" — check the vault directly so
        // the UI shows "key saved" after a reload (was hardcoded to false).
        hasAiApiKey('custom'),
      ]);
      const hasAnthropic = anthropicRes.status === 'fulfilled' ? anthropicRes.value : false;
      const hasOpenAI = openaiRes.status === 'fulfilled' ? openaiRes.value : false;
      const hasOpenRouter = openrouterRes.status === 'fulfilled' ? openrouterRes.value : false;
      const hasCustom = customRes.status === 'fulfilled' ? customRes.value : false;

      // Check Ollama status only if enabled
      let ollamaRunning = false;
      let ollamaModelsList: string[] = [];
      if (isProviderEnabled('ollama')) {
        try {
          const status = await checkOllamaStatus(baseUrls.ollama || DEFAULT_OLLAMA_URL);
          ollamaRunning = status.running;
          ollamaModelsList = status.models;
          setOllamaStatus(status);
          if (status.running) {
            const models = await fetchOllamaModels(baseUrls.ollama || DEFAULT_OLLAMA_URL);
            const settingsModels = getProviderModels('ollama').map(m => ({ value: m, label: m }));
            setOllamaModels(models.length > 0 ? models : settingsModels);
          }
        } catch {
          // Ollama not running
        }
      }

      // Load saved config for base URLs and custom model
      const config = await getAiConfig();
      if (config) {
        if (config.base_url) {
          setBaseUrls(prev => ({ ...prev, [config.provider]: config.base_url || '' }));
        }
        if (config.verify_ssl !== undefined) {
          setVerifySSL(prev => ({ ...prev, [config.provider]: config.verify_ssl ?? true }));
        }
        // Load custom model name
        if (config.model && config.provider === 'custom') {
          setCustomModel(config.model);
        }
        // Load OAuth2 config and API format for custom provider
        if (config.provider === 'custom') {
          setAuthMode(config.auth_mode || 'api_key');
          setOauth2TokenUrl(config.oauth2_token_url || '');
          setOauth2ClientId(config.oauth2_client_id || '');
          setApiFormat(config.api_format || 'openai');
          if (config.custom_headers) {
            setCustomHeaders(Object.entries(config.custom_headers).map(([k, v]) => `${k}: ${v}`).join('\n'));
          }
        }
      }

      // Per-provider base_url / verify_ssl (source of truth going forward).
      // Merged AFTER the single active-config load so it wins for every provider.
      const overrides = await getAiProviderOverrides();
      if (overrides?.base_urls) {
        setBaseUrls(prev => ({ ...prev, ...overrides.base_urls }));
      }
      if (overrides?.verify_ssl) {
        setVerifySSL(prev => ({ ...prev, ...overrides.verify_ssl }));
      }

      setProviderStatus({
        anthropic: {
          hasKey: hasAnthropic,
          connectionStatus: hasAnthropic ? 'configured' : 'unconfigured',
          connectionMessage: '',
        },
        openai: {
          hasKey: hasOpenAI,
          connectionStatus: hasOpenAI ? 'configured' : 'unconfigured',
          connectionMessage: '',
        },
        openrouter: {
          hasKey: hasOpenRouter,
          connectionStatus: hasOpenRouter ? 'configured' : 'unconfigured',
          connectionMessage: '',
        },
        ollama: {
          hasKey: true, // Ollama doesn't need a key
          connectionStatus: isProviderEnabled('ollama')
            ? (ollamaRunning ? 'connected' : 'error')
            : 'unconfigured',
          connectionMessage: isProviderEnabled('ollama')
            ? (ollamaRunning
              ? `Running with ${ollamaModelsList.length} models`
              : 'Not running. Start with: ollama serve')
            : '',
        },
        litellm: {
          hasKey: true, // LiteLLM doesn't need a key (depends on proxy config)
          connectionStatus: 'unconfigured',
          connectionMessage: isProviderEnabled('litellm') ? 'Configure base URL and test connection' : '',
        },
        custom: {
          hasKey: hasCustom,
          connectionStatus: hasCustom ? 'configured' : 'unconfigured',
          connectionMessage: '',
        },
      });

      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load configuration'));
    } finally {
      setLoading(false);
      overridesHydratedRef.current = true;
    }
  };

  // Persist per-provider base_url / verify_ssl whenever they change, so each
  // provider keeps its OWN endpoint settings (ai.provider_config only tracks the
  // active provider). Skipped during initial hydration.
  useEffect(() => {
    if (!overridesHydratedRef.current) return;
    const t = setTimeout(() => {
      void setAiProviderOverrides({ base_urls: baseUrls, verify_ssl: verifySSL });
    }, 500);
    return () => clearTimeout(t);
  }, [baseUrls, verifySSL]);

  const toggleProvider = (type: AiProviderType) => {
    setExpandedProviders(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const toggleToolCategory = (category: ToolCategory) => {
    setExpandedToolCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Per-agent-type tool management
  const [toolsAgentType, setToolsAgentType] = useState<'autopilot' | 'overlord'>('autopilot');

  const disabledToolsKeyFor = (at: 'autopilot' | 'overlord') =>
    `ai.disabledTools.${at}` as keyof typeof settings;

  const getDisabledForAgent = (at: 'autopilot' | 'overlord'): string[] =>
    (settings[disabledToolsKeyFor(at)] as string[]) || [];

  // The tools that exist in this mode (run_bash is standalone-only; the
  // Controller's server tools are enterprise-only).
  const toolRegistry = toolRegistryFor(isEnterprise ? 'enterprise' : 'standalone');
  const toolCategories = (Object.keys(TOOL_CATEGORIES) as ToolCategory[])
    .filter(category => toolRegistry.some(t => t.category === category));
  const disabledTools = getDisabledForAgent(toolsAgentType).filter(name => toolRegistry.some(t => t.name === name));
  const isToolEnabled = (toolName: string) => !disabledTools.includes(toolName);

  const toggleTool = (toolName: string) => {
    const key = disabledToolsKeyFor(toolsAgentType);
    const current = getDisabledForAgent(toolsAgentType);
    if (current.includes(toolName)) {
      updateSetting(key, current.filter(t => t !== toolName));
    } else {
      updateSetting(key, [...current, toolName]);
    }
  };

  const toggleCategoryTools = (category: ToolCategory, enable: boolean) => {
    const categoryTools = toolRegistry.filter(t => t.category === category).map(t => t.name);
    const key = disabledToolsKeyFor(toolsAgentType);
    const current = getDisabledForAgent(toolsAgentType);
    if (enable) {
      updateSetting(key, current.filter(t => !categoryTools.includes(t)));
    } else {
      const newDisabled = [...current];
      for (const tool of categoryTools) {
        if (!newDisabled.includes(tool)) {
          newDisabled.push(tool);
        }
      }
      updateSetting(key, newDisabled);
    }
  };

  const getCategoryEnabledCount = (category: ToolCategory) => {
    const categoryTools = toolRegistry.filter(t => t.category === category);
    const enabledCount = categoryTools.filter(t => isToolEnabled(t.name)).length;
    return { enabled: enabledCount, total: categoryTools.length };
  };

  // Bash deny list management
  const bashDeniedCommands = (settings['ai.bash.deniedCommands'] || []) as string[];
  const [bashDenyInput, setBashDenyInput] = useState('');

  const addBashDenyEntry = () => {
    const entry = bashDenyInput.trim();
    if (entry && !bashDeniedCommands.includes(entry)) {
      updateSetting('ai.bash.deniedCommands', [...bashDeniedCommands, entry]);
      setBashDenyInput('');
    }
  };

  const removeBashDenyEntry = (entry: string) => {
    updateSetting('ai.bash.deniedCommands', bashDeniedCommands.filter(e => e !== entry));
  };

  // Get models list for a provider from settings
  const getProviderModels = (providerType: AiProviderType): string[] => {
    const key = `ai.models.${providerType}` as keyof typeof settings;
    return (settings[key] as string[]) || [];
  };

  // Add a model to a provider's list
  const addProviderModel = (providerType: AiProviderType, model: string) => {
    if (!model.trim()) return;
    const key = `ai.models.${providerType}` as keyof typeof settings;
    const currentModels = getProviderModels(providerType);
    if (!currentModels.includes(model.trim())) {
      updateSetting(key, [...currentModels, model.trim()]);
    }
    // Clear the input
    setNewModelInputs(prev => ({ ...prev, [providerType]: '' }));
  };

  // Fetch live models from provider API (Task 5)
  const fetchLiveModels = useCallback(async (providerType: AiProviderType, refresh = false) => {
    setModelsLoading(prev => ({ ...prev, [providerType]: true }));
    setModelsError(prev => ({ ...prev, [providerType]: '' }));
    const res = await listProviderModels(providerType, {
      baseUrl: baseUrls[providerType]?.trim() || undefined,
      verifySsl: verifySSL[providerType],
      apiFormat: providerType === 'custom' ? apiFormat : undefined,
      refresh,
    });
    setLiveModels(prev => ({ ...prev, [providerType]: res.models }));
    if (res.source === 'error') {
      setModelsError(prev => ({ ...prev, [providerType]: res.error || 'Could not load models' }));
    }
    setModelsLoading(prev => ({ ...prev, [providerType]: false }));
  }, [baseUrls, verifySSL, apiFormat]);

  // Auto-fetch models when a provider card expands (Task 5). Enterprise has no
  // local provider cards — the Controller manages the providers.
  useEffect(() => {
    if (isEnterprise) return;
    for (const type of expandedProviders) {
      const p = type as AiProviderType;
      if (p === 'custom') continue; // custom uses a single freeform model field, no live picker
      // Only auto-fetch once per expand and skip when we already have a list.
      if (liveModels[p] === undefined && !modelsLoading[p]) {
        fetchLiveModels(p);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedProviders, isEnterprise]);

  // Remove a model from a provider's list
  const removeProviderModel = (providerType: AiProviderType, model: string) => {
    const key = `ai.models.${providerType}` as keyof typeof settings;
    const currentModels = getProviderModels(providerType);
    updateSetting(key, currentModels.filter(m => m !== model));
  };

  // Move a model up or down in the list (to change default)
  const moveProviderModel = (providerType: AiProviderType, index: number, direction: 'up' | 'down') => {
    const key = `ai.models.${providerType}` as keyof typeof settings;
    const currentModels = [...getProviderModels(providerType)];
    const newIndex = direction === 'up' ? index - 1 : index + 1;

    // Bounds check
    if (newIndex < 0 || newIndex >= currentModels.length) return;

    // Swap
    [currentModels[index], currentModels[newIndex]] = [currentModels[newIndex], currentModels[index]];
    updateSetting(key, currentModels);
  };

  /** Persist base_url/verify_ssl for EVERY provider (ai.provider_overrides),
   *  and — only for the default provider — the singleton ai.provider_config
   *  the agent boots from. Test/Save on a non-default card must never clobber
   *  the default provider's config (RC-8). */
  const persistProviderConfig = async (providerType: AiProviderType, config: AiConfig) => {
    await setAiProviderOverrides({ base_urls: baseUrls, verify_ssl: verifySSL });
    if ((settings['ai.defaultProvider'] || 'anthropic') === providerType) {
      await setAiConfig(config);
    }
  };

  const handleSaveKey = async (providerType: AiProviderType) => {
    const key = apiKeys[providerType];
    const requiresKey = PROVIDERS.find(p => p.type === providerType)?.requiresKey ?? true;
    // A key is only mandatory when none is stored yet; with a stored key the
    // user may be saving just base_url / verify_ssl / api_format edits.
    if (!key && requiresKey && !providerStatus[providerType].hasKey) return;

    try {
      setSaving(providerType);
      setError(null);

      // Store API key in vault (not needed for ollama/litellm). Track
      // whether the vault write succeeded so a downstream setAiConfig
      // failure can still mark hasKey=true (audit P1-14: previously
      // the vault could store the key, setAiConfig could fail, the
      // catch would surface the error, but the providerStatus
      // hasKey=true update was unreachable → user saw "unconfigured"
      // even though the key was in the vault).
      let vaultWriteSucceeded = false;
      if (key && requiresKey) {
        await storeAiApiKey(providerType, key);
        vaultWriteSucceeded = true;
      }

      // Build and save config - use first model from configured models list
      const configuredModels = getProviderModels(providerType);
      const config: AiConfig = {
        provider: providerType,
        model: providerType === 'custom' ? customModel : configuredModels[0] || '',
        base_url: baseUrls[providerType]?.trim() || undefined,
        verify_ssl: verifySSL[providerType],
      };
      // Include OAuth2 config and API format for custom provider
      if (providerType === 'custom') {
        config.auth_mode = authMode;
        config.api_format = apiFormat;
        if (authMode === 'oauth2') {
          config.oauth2_token_url = oauth2TokenUrl;
          config.oauth2_client_id = oauth2ClientId;
          // Parse custom headers from "Key: Value" lines
          if (customHeaders.trim()) {
            const headers: Record<string, string> = {};
            for (const line of customHeaders.split('\n')) {
              const colonIdx = line.indexOf(':');
              if (colonIdx > 0) {
                headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
              }
            }
            config.custom_headers = headers;
          }
        }
      }
      try {
        await persistProviderConfig(providerType, config);
      } catch (cfgErr) {
        // Vault succeeded but config save failed. Reflect the
        // partial-success in providerStatus so the UI is honest about
        // what actually persisted, then re-throw so the user sees the
        // error toast.
        if (vaultWriteSucceeded) {
          setProviderStatus(prev => ({
            ...prev,
            [providerType]: {
              ...prev[providerType],
              hasKey: true,
              connectionStatus: 'unconfigured' as ConnectionStatus,
              connectionMessage: 'Key saved to vault, but config save failed',
            },
          }));
          setApiKeys(prev => ({ ...prev, [providerType]: '' }));
        }
        throw cfgErr;
      }

      // Full success — update status, clear input, toast.
      setProviderStatus(prev => ({
        ...prev,
        [providerType]: {
          ...prev[providerType],
          hasKey: true,
          connectionStatus: 'configured' as ConnectionStatus,
        },
      }));

      // Clear key input
      setApiKeys(prev => ({ ...prev, [providerType]: '' }));

      // Re-fetch models after saving key (Task 5 — cloud APIs now have auth)
      fetchLiveModels(providerType, true);

      setSuccess(`${PROVIDERS.find(p => p.type === providerType)?.name} settings saved`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save configuration'));
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteKey = async (providerType: AiProviderType) => {
    try {
      await deleteAiApiKey(providerType);
      setProviderStatus(prev => ({
        ...prev,
        [providerType]: {
          hasKey: false,
          connectionStatus: 'unconfigured',
          connectionMessage: '',
        },
      }));
      setSuccess('API key removed');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete API key'));
    }
  };

  const handleTestConnection = async (providerType: AiProviderType) => {
    try {
      setTesting(providerType);
      setProviderStatus(prev => ({
        ...prev,
        [providerType]: {
          ...prev[providerType],
          connectionStatus: 'testing',
          connectionMessage: 'Testing connection...',
        },
      }));

      if (providerType === 'ollama') {
        // Check Ollama status
        const url = baseUrls.ollama || DEFAULT_OLLAMA_URL;
        const status = await checkOllamaStatus(url);
        setOllamaStatus(status);

        if (status.running) {
          const models = await fetchOllamaModels(url);
          const settingsModels = getProviderModels('ollama').map(m => ({ value: m, label: m }));
          setOllamaModels(models.length > 0 ? models : settingsModels);
        }

        setProviderStatus(prev => ({
          ...prev,
          ollama: {
            hasKey: true,
            connectionStatus: status.running ? 'connected' : 'error',
            connectionMessage: status.running
              ? `Running with ${status.models.length} models`
              : 'Not running. Start with: ollama serve',
          },
        }));
      } else {
        // Save API key if provided (LiteLLM key is optional)
        const key = apiKeys[providerType];
        if (key) {
          await storeAiApiKey(providerType, key);
          setApiKeys(prev => ({ ...prev, [providerType]: '' }));
        }

        // Persist endpoint settings before testing so the backend has them
        // (overrides for every provider; provider_config only if default).
        const configuredModels = getProviderModels(providerType);
        const testModel = providerType === 'custom' ? customModel : configuredModels[0] || '';
        const testConfig: AiConfig = {
          provider: providerType,
          model: testModel,
          base_url: baseUrls[providerType]?.trim() || undefined,
          verify_ssl: verifySSL[providerType],
        };
        if (providerType === 'custom') {
          testConfig.auth_mode = authMode;
          testConfig.api_format = apiFormat;
          if (authMode === 'oauth2') {
            testConfig.oauth2_token_url = oauth2TokenUrl;
            testConfig.oauth2_client_id = oauth2ClientId;
            // IMPORTANT: include custom_headers — Test re-saves the whole
            // config, so omitting this would wipe headers like user_email
            // that the gateway requires.
            if (customHeaders.trim()) {
              const headers: Record<string, string> = {};
              for (const line of customHeaders.split('\n')) {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                  headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
                }
              }
              testConfig.custom_headers = headers;
            }
          }
        }
        await persistProviderConfig(providerType, testConfig);

        const result = await testAiConnection(providerType, testModel);

        setProviderStatus(prev => ({
          ...prev,
          [providerType]: {
            hasKey: prev[providerType].hasKey || !!key,
            connectionStatus: result.success ? 'connected' : 'error',
            connectionMessage: result.message || (result.success ? 'Connected' : 'Failed'),
          },
        }));
      }
    } catch (err) {
      setProviderStatus(prev => ({
        ...prev,
        [providerType]: {
          ...prev[providerType],
          connectionStatus: 'error',
          connectionMessage: getErrorMessage(err, 'Connection failed'),
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const handleSetDefault = async (providerType: AiProviderType) => {
    updateSetting('ai.defaultProvider', providerType as SettingsProviderType);

    // Also sync backend ai.provider_config so the agent sidecar uses the same default
    try {
      const configuredModels = getProviderModels(providerType);
      const model = providerType === 'custom' ? customModel : configuredModels[0] || '';
      const config: AiConfig = {
        provider: providerType,
        model,
        base_url: baseUrls[providerType]?.trim() || undefined,
        verify_ssl: verifySSL[providerType],
      };
      if (providerType === 'custom') {
        config.api_format = apiFormat;
        if (authMode === 'oauth2') {
          config.auth_mode = 'oauth2';
          config.oauth2_token_url = oauth2TokenUrl;
          config.oauth2_client_id = oauth2ClientId;
          // Preserve custom_headers — same reason as the Test handler.
          if (customHeaders.trim()) {
            const headers: Record<string, string> = {};
            for (const line of customHeaders.split('\n')) {
              const colonIdx = line.indexOf(':');
              if (colonIdx > 0) {
                headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
              }
            }
            config.custom_headers = headers;
          }
        }
      }
      await setAiConfig(config);
    } catch (err) {
      console.warn('Failed to sync default provider to backend:', err);
    }

    setSuccess(`${PROVIDERS.find(p => p.type === providerType)?.name} set as default provider`);
    setTimeout(() => setSuccess(null), 3000);
  };

  // Get placeholder text for model input based on provider
  const getModelPlaceholder = (providerType: AiProviderType): string =>
    SUGGESTED_MODEL[providerType] || 'model-name';

  // Get hint text for model input based on provider
  const getModelHint = (providerType: AiProviderType): string => {
    // Local/proxy providers get a how-to instead of example model IDs.
    if (providerType === 'ollama') return 'Run "ollama list" to see available models';
    if (providerType === 'litellm') return 'Model name configured in your LiteLLM proxy';
    return MODEL_PLACEHOLDER[providerType] ?? '';
  };

  // Get the default provider label for "Use Default" dropdown option
  const defaultProviderLabel = isEnterprise
    ? (enterpriseProviders.find(p => p.is_default)?.name || 'Controller Default')
    : (settings['ai.defaultProvider'] || 'anthropic');

  const getStatusBadge = (status: ConnectionStatus) => {
    switch (status) {
      case 'unconfigured':
        return null;
      case 'configured':
        return <span className="ai-provider-status-badge configured">Configured</span>;
      case 'testing':
        return <span className="ai-provider-status-badge testing">Testing...</span>;
      case 'connected':
        return <span className="ai-provider-status-badge connected">Connected</span>;
      case 'error':
        return <span className="ai-provider-status-badge error">Error</span>;
    }
  };

  if (loading) {
    return (
      <p className="form-hint">Loading AI settings…</p>
    );
  }

  const defaultProvider = settings['ai.defaultProvider'] || 'anthropic';

  return (
    <>
      {(error || success) && (
        <div>
          {error && <p className="settings-error">{error}</p>}
          {success && <p className="settings-success">{success}</p>}
        </div>
      )}

      {/* Provider Sections — hidden in enterprise mode (managed centrally) */}
      {isEnterprise ? (
        <SettingsSection
          title="Providers"
          description="AI features are available through your NetStacks Controller; its administrator manages the providers. Local preferences for automation and tools are below."
        >
          {enterpriseProviders.length > 0 ? (
            <div className="settings-group">
              {enterpriseProviders.map((p) => (
                <SettingsItem
                  key={p.type}
                  title={p.name}
                  badges={
                    <>
                      <span className="settings-badge">{p.type}</span>
                      {p.is_default && <span className="settings-badge settings-badge--accent">default</span>}
                    </>
                  }
                />
              ))}
            </div>
          ) : (
            <p className="form-hint">No providers configured on the Controller. Contact your administrator.</p>
          )}
        </SettingsSection>
      ) : (
      <SettingsSection
        title="Providers"
        description="Configure AI providers, each with its own API key. Pick a default provider here, or switch providers in the AI chat panel."
      >
        <div className="settings-group">
          {PROVIDERS.map((p) => {
            const status = providerStatus[p.type];
            const providerEnabled = isProviderEnabled(p.type);
            const isExpanded = providerEnabled && expandedProviders.has(p.type);
            const isDefault = defaultProvider === p.type;

            const needsBaseUrl = p.type === 'ollama' || p.type === 'litellm' || p.type === 'custom';
            const reqs = providerRequirements({
              requiresKey: !!p.requiresKey,
              hasKey: status.hasKey,
              modelCount: (p.type === 'custom' ? (customModel ? 1 : 0) : getProviderModels(p.type).length),
              needsBaseUrl,
              hasBaseUrl: !!baseUrls[p.type],
            });

            // Save may proceed as soon as a key is typed (or for keyless
            // providers), even before it's persisted — otherwise the first
            // key could never be saved. Set-as-Default still requires the
            // key to be persisted (reqs uses status.hasKey).
            const canSaveKey =
              (!p.requiresKey || status.hasKey || !!apiKeys[p.type]) &&
              (!needsBaseUrl || !!baseUrls[p.type]);

            return (
              <div
                key={p.type}
                className={`ai-provider-section ${status.hasKey || p.type === 'ollama' ? 'configured' : ''} ${!providerEnabled ? 'disabled' : ''}`}
              >
                <div className={`ai-provider-header ${isExpanded ? 'expanded' : ''}`}>
                  <button
                    className="ai-provider-header-info"
                    onClick={() => providerEnabled && toggleProvider(p.type)}
                    disabled={!providerEnabled}
                  >
                    <span className={`ai-provider-chevron ${isExpanded ? 'expanded' : ''}`}>
                      {Icons.chevron}
                    </span>
                    <span className="ai-provider-icon">{p.icon}</span>
                    <span className={`ai-provider-name ${!providerEnabled ? 'dimmed' : ''}`}>{p.name}</span>
                    <span className="ai-provider-badges">
                      {isDefault && providerEnabled && (
                        <span className="ai-provider-default-badge">
                          {Icons.star}
                          Default
                        </span>
                      )}
                      {providerEnabled && getStatusBadge(status.connectionStatus)}
                    </span>
                  </button>
                  <span className="ai-provider-enable-toggle" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      size="sm"
                      checked={providerEnabled}
                      onChange={() => toggleProviderEnabled(p.type)}
                      label={`Enable ${p.name}`}
                    />
                  </span>
                </div>

                {isExpanded && (
                  <div className="ai-provider-content">
                    <p className="ai-provider-description">{p.description}</p>

                    {/* API Key Input (not for Ollama) */}
                    {p.requiresKey && (
                      <div className="form-group">
                        <label>API Key</label>
                        <div className="api-key-row">
                          <PasswordInput
                            value={apiKeys[p.type]}
                            onChange={(e) => setApiKeys(prev => ({ ...prev, [p.type]: e.target.value }))}
                            placeholder={status.hasKey ? '********** (key saved)' : 'Enter your API key'}
                            onReveal={() => {
                              // Lazily load the stored key from the vault so the
                              // reveal button can actually show a saved key (the
                              // field is otherwise empty behind the placeholder).
                              if (apiKeys[p.type] || !status.hasKey) return;
                              getAiApiKey(p.type)
                                .then(key => { if (key) setApiKeys(prev => ({ ...prev, [p.type]: key })); })
                                .catch(() => { /* vault locked or fetch failed — leave empty */ });
                            }}
                          />
                          {status.hasKey && (
                            <Tooltip label="Remove API key"><button
                              className="ns-btn ns-btn--ghost ns-btn--danger ns-icon-btn"
                              onClick={() => handleDeleteKey(p.type)}
                              aria-label="Remove API key"
                            >
                              {Icons.trash}
                            </button></Tooltip>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Base URL (all providers — override for proxies/gateways) */}
                    <div className="form-group">
                      <label>Base URL</label>
                      <input data-ai-fill="off"
                        type="text"
                        className="ns-input"
                        value={baseUrls[p.type]}
                        onChange={(e) => setBaseUrls(prev => ({ ...prev, [p.type]: e.target.value }))}
                        placeholder={
                          p.type === 'ollama' ? DEFAULT_OLLAMA_URL :
                          p.type === 'litellm' ? DEFAULT_LITELLM_URL :
                          p.type === 'anthropic' ? 'https://api.anthropic.com' :
                          p.type === 'openai' ? 'https://api.openai.com/v1' :
                          p.type === 'openrouter' ? 'https://openrouter.ai/api/v1' :
                          'https://api.example.com/v1'
                        }
                      />
                      <span className="form-hint">
                        {p.type === 'ollama' ? `Default: ${DEFAULT_OLLAMA_URL}` :
                         p.type === 'litellm' ? `Default: ${DEFAULT_LITELLM_URL}` :
                         p.type === 'openrouter' ? 'Leave empty for https://openrouter.ai/api/v1. A gateway URL must include its API path; https://openrouter.ai on its own is a web page, not the API.' :
                         'Leave empty to use the default API endpoint. Set to use a proxy or gateway.'}
                      </span>
                    </div>

                    {/* TLS verification — shown for all providers, since any can be
                        pointed at a custom/self-signed endpoint via Base URL (incl.
                        OpenRouter, which now honors a custom base_url). */}
                    <div className="form-group">
                      <label>
                        <input
                          type="checkbox"
                          checked={verifySSL[p.type]}
                          onChange={(e) => setVerifySSL(prev => ({ ...prev, [p.type]: e.target.checked }))}
                        />
                        Verify TLS Certificates
                      </label>
                      <span className="form-hint">
                        {verifySSL[p.type]
                          ? 'TLS certificates are verified. Uncheck to accept self-signed certificates.'
                          : 'Self-signed certificates accepted. Only disable if you trust this endpoint.'}
                      </span>
                    </div>

                    {/* API Format (for Custom provider) */}
                    {p.type === 'custom' && (
                      <div className="form-group">
                        <label>API Format</label>
                        <select aria-label="API Format"
                          className="ns-select"
                          value={apiFormat}
                          onChange={(e) => setApiFormat(e.target.value as 'openai' | 'gemini' | 'vertex-anthropic')}
                        >
                          <option value="openai">OpenAI Compatible</option>
                          <option value="gemini">Gemini / Vertex AI</option>
                          <option value="vertex-anthropic">Anthropic on Vertex AI</option>
                        </select>
                        {apiFormat === 'openai' && (
                          <span className="form-hint">POST {'{base_url}'}/chat/completions — standard OpenAI format</span>
                        )}
                        {apiFormat === 'gemini' && (
                          <span className="form-hint">POST {'{base_url}'}/{'{model}'}:generateContent — appended automatically unless your Model Name already contains an action (e.g., <code>gemini-pro:streamGenerateContent</code>).</span>
                        )}
                        {apiFormat === 'vertex-anthropic' && (
                          <span className="form-hint">POST {'{base_url}'}/{'{model}'}:rawPredict — appended automatically unless your Model Name already contains an action (e.g., <code>claude-sonnet-4-6:rawPredict</code>). Body uses Anthropic message schema.</span>
                        )}
                      </div>
                    )}

                    {/* Custom Model Name (for Custom provider) */}
                    {p.type === 'custom' && (
                      <div className="form-group">
                        <label>Model Name</label>
                        <input data-ai-fill="off"
                          type="text"
                          className="ns-input"
                          value={customModel}
                          onChange={(e) => setCustomModel(e.target.value)}
                          placeholder={
                            apiFormat === 'gemini'
                              ? 'e.g., gemini-2.5-flash'
                              : apiFormat === 'vertex-anthropic'
                              ? 'e.g., claude-sonnet-4-6 or claude-sonnet-4-6:rawPredict'
                              : 'e.g., llama-3.1-70b'
                          }
                        />
                      </div>
                    )}

                    {/* Auth Mode selector (Custom provider only) */}
                    {p.type === 'custom' && (
                      <div className="form-group">
                        <label>Authentication</label>
                        <select aria-label="Authentication"
                          className="ns-select"
                          value={authMode}
                          onChange={(e) => setAuthMode(e.target.value as 'api_key' | 'oauth2')}
                        >
                          <option value="api_key">API Key (Bearer Token)</option>
                          <option value="oauth2">OAuth2 Client Credentials</option>
                        </select>
                        {authMode === 'api_key' && (
                          <span className="form-hint">Static API key sent as Bearer token</span>
                        )}
                        {authMode === 'oauth2' && (
                          <span className="form-hint">Tokens fetched automatically via client_credentials grant. The API Key field above is used as the Client Secret.</span>
                        )}
                      </div>
                    )}

                    {/* OAuth2 Config Fields (Custom provider with OAuth2 auth) */}
                    {p.type === 'custom' && authMode === 'oauth2' && (
                      <>
                        <div className="form-group">
                          <label>Token URL</label>
                          <input data-ai-fill="off"
                            type="text"
                            className="ns-input"
                            value={oauth2TokenUrl}
                            onChange={(e) => setOauth2TokenUrl(e.target.value)}
                            placeholder="https://api.example.com/oauth/token"
                          />
                        </div>
                        <div className="form-group">
                          <label>Client ID</label>
                          <input data-ai-fill="off"
                            type="text"
                            className="ns-input"
                            value={oauth2ClientId}
                            onChange={(e) => setOauth2ClientId(e.target.value)}
                            placeholder="your-client-id"
                          />
                          <span className="form-hint">Client Secret is stored in the API Key field above (encrypted in vault)</span>
                        </div>
                        <div className="form-group">
                          <label>Custom Headers</label>
                          <textarea data-ai-fill="off"
                            className="ns-textarea settings-code"
                            rows={3}
                            value={customHeaders}
                            onChange={(e) => setCustomHeaders(e.target.value)}
                            placeholder={"user_email: name@example.com\nX-Custom-Header: value"}
                          />
                          <span className="form-hint">One header per line as &quot;Key: Value&quot;. Added to every API request.</span>
                        </div>
                      </>
                    )}

                    {/* Models List (for all providers except custom which has its own) */}
                    {p.type !== 'custom' && (
                      <div className="form-group">
                        <label>Models</label>
                        <div className="model-list">
                          {getProviderModels(p.type).map((model, index) => {
                            const models = getProviderModels(p.type);
                            const isFirst = index === 0;
                            const isLast = index === models.length - 1;
                            return (
                              <div key={model} className="model-list-item">
                                <span className="model-name">
                                  {isFirst && <span className="model-default-badge">Default</span>}
                                  {model}
                                </span>
                                <div className="model-actions">
                                  <Tooltip label="Move up (make default)"><button
                                    className="ns-btn ns-btn--ghost ns-icon-btn"
                                    onClick={() => moveProviderModel(p.type, index, 'up')}
                                    disabled={isFirst}
                                    aria-label="Move up (make default)"
                                  >
                                    {Icons.arrowUp}
                                  </button></Tooltip>
                                  <Tooltip label="Move down"><button
                                    className="ns-btn ns-btn--ghost ns-icon-btn"
                                    onClick={() => moveProviderModel(p.type, index, 'down')}
                                    disabled={isLast}
                                    aria-label="Move down"
                                  >
                                    {Icons.arrowDown}
                                  </button></Tooltip>
                                  <Tooltip label="Remove model"><button
                                    className="ns-btn ns-btn--ghost ns-btn--danger ns-icon-btn"
                                    onClick={() => removeProviderModel(p.type, model)}
                                    aria-label="Remove model"
                                  >
                                    {Icons.trash}
                                  </button></Tooltip>
                                </div>
                              </div>
                            );
                          })}
                          {getProviderModels(p.type).length === 0 && (
                            <span className="no-models-hint">No models configured. Add a model below.</span>
                          )}
                        </div>
                        <div className="add-model-row">
                          <div className="model-combobox">
                            <input data-ai-fill="off"
                              type="text"
                              className="ns-input"
                              value={newModelInputs[p.type]}
                              onChange={(e) => setNewModelInputs(prev => ({ ...prev, [p.type]: e.target.value }))}
                              onFocus={() => setOpenModelCombo(p.type)}
                              onBlur={() => window.setTimeout(() => setOpenModelCombo(cur => (cur === p.type ? null : cur)), 150)}
                              placeholder={
                                modelsLoading[p.type]
                                  ? 'Loading models…'
                                  : (liveModels[p.type]?.length ? 'Select or type a model' : getModelPlaceholder(p.type))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addProviderModel(p.type, newModelInputs[p.type]);
                                  setOpenModelCombo(null);
                                } else if (e.key === 'Escape') {
                                  setOpenModelCombo(null);
                                }
                              }}
                            />
                            {openModelCombo === p.type && (() => {
                              const q = newModelInputs[p.type].trim().toLowerCase();
                              const already = new Set(getProviderModels(p.type));
                              const suggestions = (liveModels[p.type] || [])
                                .filter(m => !already.has(m.id))
                                .filter(m => !q || m.id.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q))
                                .slice(0, 100);
                              if (suggestions.length === 0) return null;
                              return (
                                <ul className="model-combobox-list">
                                  {suggestions.map(m => (
                                    <li
                                      key={m.id}
                                      className="model-combobox-option"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        addProviderModel(p.type, m.id);
                                        setOpenModelCombo(null);
                                      }}
                                    >
                                      <span className="mco-id">{m.id}</span>
                                      {m.display_name && m.display_name !== m.id && (
                                        <span className="mco-name">{m.display_name}</span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              );
                            })()}
                          </div>
                          <button
                            className="ns-btn"
                            onClick={() => addProviderModel(p.type, newModelInputs[p.type])}
                            disabled={!newModelInputs[p.type].trim()}
                          >
                            Add
                          </button>
                          <Tooltip label="Refresh model list from provider"><button
                            className="ns-btn"
                            onClick={() => fetchLiveModels(p.type, true)}
                            disabled={!!modelsLoading[p.type]}
                          >
                            {modelsLoading[p.type] ? 'Refreshing…' : 'Refresh'}
                          </button></Tooltip>
                        </div>
                        {modelsError[p.type] && (
                          <span className="form-hint model-fetch-error">
                            {modelsError[p.type]} — you can still add a model manually above.
                          </span>
                        )}
                        <span className="form-hint">{getModelHint(p.type)}</span>

                        {/* Max Tokens */}
                        <div className="max-tokens-row">
                          <label>Max Tokens:</label>
                          <input aria-label="Max Tokens"
                            type="number"
                            min="0"
                            max="200000"
                            step="256"
                            value={settings[`ai.maxTokens.${p.type}` as keyof typeof settings] as number || 0}
                            onChange={(e) => updateSetting(`ai.maxTokens.${p.type}` as keyof typeof settings, parseInt(e.target.value) || 0)}
                            className="ns-input max-tokens-input"
                          />
                          <span className="max-tokens-hint">0 = no limit</span>
                        </div>
                      </div>
                    )}

                    {/* Ollama Status */}
                    {p.type === 'ollama' && (
                      <div className="form-group">
                        <label>Available Models</label>
                        {ollamaStatus.running ? (
                          <div className="ollama-models-list">
                            {ollamaModels.map(m => (
                              <span key={m.value} className="ollama-model-tag">{m.label}</span>
                            ))}
                          </div>
                        ) : (
                          <span className="ollama-status not-running">
                            Ollama not detected. Run: <code>ollama serve</code>
                          </span>
                        )}
                      </div>
                    )}

                    {/* Connection Status Message */}
                    {status.connectionMessage && (
                      <div className={`connection-message ${status.connectionStatus}`}>
                        {status.connectionMessage}
                      </div>
                    )}

                    {reqs.missing.length > 0 && (
                      <div className="provider-requirements-hint">
                        To use this provider, add: {reqs.missing.join(', ')}.
                      </div>
                    )}

                    {/* Actions */}
                    <div className="ai-provider-actions">
                      <Tooltip label={reqs.canSetDefault ? '' : `Needs ${reqs.missing.join(', ')}`}><button
                        className="ns-btn"
                        onClick={() => handleSetDefault(p.type)}
                        disabled={isDefault || !reqs.canSetDefault}
                      >
                        {isDefault ? 'Default Provider' : 'Set as Default'}
                      </button></Tooltip>

                      <Tooltip label={p.requiresKey ? 'Save API key and endpoint settings' : 'Save endpoint settings'}><button
                        className="ns-btn ns-btn--primary"
                        onClick={() => handleSaveKey(p.type)}
                        disabled={saving === p.type || !canSaveKey}
                      >
                        {Icons.save}
                        {saving === p.type ? 'Saving...' : (p.requiresKey ? 'Save Key' : 'Save')}
                      </button></Tooltip>

                      <button
                        className="ns-btn btn-test-connection"
                        onClick={() => handleTestConnection(p.type)}
                        disabled={testing === p.type || (p.requiresKey && !status.hasKey && !apiKeys[p.type])}
                      >
                        {Icons.test}
                        {testing === p.type ? 'Testing...' : 'Test'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>
      )}

      {/* AI Automation Section */}
      <SettingsSection
        title="AI Automation"
        description="Automatic AI features and the safety switches for what the AI may change. Disabling features reduces API usage and costs."
        help={{
          topic: 'AI automation and safety modes',
          prompt: `Explain the AI automation switches in NetStacks and help me choose safe settings. Right now AI Terminal Mode is ${aiTerminalMode ? 'on' : 'off'}, AI Config Mode is ${configModeStatus.enabled ? 'on' : 'off'}, and structural topology edits are ${settings['ai.topology.allowStructuralEdits'] ? 'allowed' : 'not allowed'}. `
            + 'Cover what each one lets the AI do (Terminal Mode: write/edit/patch files on devices; Config Mode: configuration commands for a limited time; topology edits), how they combine with the Ask/Auto/Go Nuts permission modes, and what stays blocked regardless.',
        }}
      >
        <div className="settings-group">
          <SettingRow label="Command Autocomplete" description="AI suggests commands as you type in terminals (uses the API after a 300 ms pause)">
            <Switch
              checked={settings['ai.inlineSuggestions']}
              onChange={(v) => updateSetting('ai.inlineSuggestions', v)}
              label="Command Autocomplete"
            />
          </SettingRow>
          <SettingRow label="Next Step Suggestions" description="AI suggests follow-up commands after you execute commands">
            <Switch
              checked={settings['ai.nextStepSuggestions']}
              onChange={(v) => updateSetting('ai.nextStepSuggestions', v)}
              label="Next Step Suggestions"
            />
          </SettingRow>
          <SettingRow
            label={'Contextual "Ask AI" help'}
            description={'Show small "Ask AI" buttons on the complex setup areas (integrations, enrichment, profiles, jump hosts, tunnels, AI permissions, MOPs, …). Opens a pop-over where the AI explains the feature and helps you set it up.'}
          >
            <Switch
              checked={settings['ai.contextualHelp.enabled']}
              onChange={(v) => updateSetting('ai.contextualHelp.enabled', v)}
              label="Contextual 'Ask AI' help"
            />
          </SettingRow>
          <SettingRow
            label="Allow AI to edit topologies"
            description="Let the AI structurally change the active topology (add, remove, and move devices & connections). When off, the AI can still read, analyze, highlight, and annotate the map. All AI edits are tracked in undo history."
          >
            <Switch
              checked={settings['ai.topology.allowStructuralEdits']}
              onChange={(v) => updateSetting('ai.topology.allowStructuralEdits', v)}
              label="Allow AI to edit topologies"
            />
          </SettingRow>
          {!isEnterprise && (
            <SettingRow
              label="AI Terminal Mode"
              description={
                <>
                  Allow the AI's <code>write_file</code>, <code>edit_file</code> and <code>patch_file</code> tools to modify
                  files on connected devices and hosts over the active session.{' '}
                  <span className="ai-warning-text">With this on, the AI can change remote filesystems directly — leave it off unless you need it.</span>
                </>
              }
            >
              <Switch
                checked={aiTerminalMode}
                onChange={(v) => { void handleToggleTerminalMode(v) }}
                label="AI Terminal Mode — allow write_file, edit_file and patch_file on devices"
              />
            </SettingRow>
          )}
          {/* AUDIT FIX (EXEC-002): server-side AI config-mode panel.
              Replaces the old persistent client-side toggle. Enabling
              requires the user to re-supply the master password and the
              override auto-expires after ~5 min. */}
          <SettingRow
            label="AI Configuration Mode"
            description={isEnterprise && !controllerAiConfigEnabled
              ? 'This feature is disabled by your administrator. Contact your admin to enable AI configuration changes on the controller.'
              : isEnterprise
                ? 'Temporarily allows the AI assistant to execute configuration commands on network devices. Auto-disables after 5 minutes.'
                : 'Temporarily allows the AI assistant to execute configuration commands on network devices. Requires your master password to enable, auto-disables after 5 minutes.'}
            stacked
          >
            {!(isEnterprise && !controllerAiConfigEnabled) && (
              configModeStatus.enabled ? (
                <>
                  <p className="ai-warning-text">
                    AI is currently allowed to send configuration commands. The override expires automatically; disable it to revoke immediately.
                  </p>
                  <div>
                    <button
                      type="button"
                      className="ns-btn ns-btn--small"
                      onClick={handleDisableConfigMode}
                      disabled={configModeBusy}
                    >
                      {configModeBusy
                        ? 'Disabling…'
                        : `Disable (${Math.max(0, configModeStatus.seconds_remaining ?? 0)}s left)`}
                    </button>
                  </div>
                </>
              ) : isEnterprise ? (
                <div>
                  <button
                    type="button"
                    className="ns-btn ns-btn--small ns-btn--danger"
                    onClick={() => { void handleEnableConfigMode(); }}
                    disabled={configModeBusy}
                  >
                    {configModeBusy ? 'Enabling…' : 'Enable for 5 min'}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleEnableConfigMode} className="ai-config-mode-form">
                  <PasswordInput
                    aria-label="Master password"
                    placeholder="Master password to enable…"
                    value={configModePassword}
                    onChange={(e) => setConfigModePassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={configModeBusy}
                  />
                  <button
                    type="submit"
                    className="ns-btn ns-btn--danger"
                    disabled={configModeBusy || configModePassword.length < 12}
                  >
                    {configModeBusy ? 'Enabling…' : 'Enable for 5 min'}
                  </button>
                </form>
              )
            )}
            {configModeError && <p className="settings-error">{configModeError}</p>}
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Context" description="How much conversation and workspace state is sent with each AI request.">
        <div className="settings-group">
          <SettingRow label="Max Conversation Messages" description="Limit conversation history to prevent context overflow errors. Set to 0 for unlimited.">
            <span className="ai-number-setting">
              <input aria-label="Max Conversation Messages"
                type="number"
                min="0"
                max="100"
                value={settings['ai.maxConversationMessages']}
                onChange={(e) => updateSetting('ai.maxConversationMessages', parseInt(e.target.value) || 0)}
                className="ns-input setting-input-number"
              />
              messages
            </span>
          </SettingRow>
          <SettingRow label="Live Workspace Context" description="Automatically include current terminal scrollback and editor content with each AI request">
            <Switch
              checked={settings['ai.liveContext.enabled']}
              onChange={(v) => updateSetting('ai.liveContext.enabled', v)}
              label="Live Workspace Context"
            />
          </SettingRow>
          {settings['ai.liveContext.enabled'] && (
            <>
              <SettingRow label="Include Editor Content" description="Send the active editor file (redacted) with each AI request">
                <Switch
                  checked={settings['ai.liveContext.includeEditor']}
                  onChange={(v) => updateSetting('ai.liveContext.includeEditor', v)}
                  label="Include Editor Content"
                />
              </SettingRow>
              <SettingRow label="Terminal Scrollback Lines" description="Number of terminal lines to include (20–1000)">
                <span className="ai-number-setting">
                  <input aria-label="Terminal Scrollback Lines"
                    type="number"
                    min="20"
                    max="1000"
                    value={settings['ai.liveContext.scrollbackLines']}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || settings['ai.liveContext.scrollbackLines'];
                      const clamped = Math.max(20, Math.min(1000, val));
                      updateSetting('ai.liveContext.scrollbackLines', clamped);
                    }}
                    className="ns-input setting-input-number"
                  />
                  lines
                </span>
              </SettingRow>
            </>
          )}
        </div>
      </SettingsSection>

      {/* AI Agents Section */}
      <SettingsSection
        title="AI Agents"
        description="How AI agents run background tasks. Agents use the ReAct (Reasoning + Acting) loop to complete network automation tasks on their own."
      >
        <div className="settings-group">
          {/* Agent uses the single default provider (top of this page). The only
              per-toolset override is an optional model. */}
          <SettingRow
            label="Model override (optional)"
            description={`The agent uses the default provider (${defaultProviderLabel}). Leave blank to use its default model, or enter a specific model name to use instead.`}
          >
            <input data-ai-fill="off"
              type="text"
              aria-label="Agent model override"
              value={settings['ai.agent.model'] || ''}
              placeholder="Use default model"
              onChange={(e) => updateAgentSetting('ai.agent.model', e.target.value || null)}
              className="ns-input ai-agent-select"
            />
          </SettingRow>
          <SettingRow label="Temperature" description="Controls randomness (0 = deterministic, 1 = creative)">
            <span className="ai-agent-slider-container">
              <input aria-label="Temperature"
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={settings['ai.agent.temperature']}
                onChange={(e) => updateAgentSetting('ai.agent.temperature', parseFloat(e.target.value))}
                className="ai-agent-slider"
              />
              <span className="ai-agent-slider-value">{settings['ai.agent.temperature'].toFixed(1)}</span>
            </span>
          </SettingRow>
          <SettingRow label="Max Tokens" description="Maximum tokens per AI response">
            <input aria-label="Max Tokens"
              type="number"
              min="256"
              max="32000"
              step="256"
              value={settings['ai.agent.maxTokens']}
              onChange={(e) => updateAgentSetting('ai.agent.maxTokens', parseInt(e.target.value) || 4096)}
              className="ns-input ai-agent-number-input"
            />
          </SettingRow>
          <SettingRow label="Max Iterations" description="Maximum ReAct loop iterations before timeout">
            <input aria-label="Max Iterations"
              type="number"
              min="1"
              max="50"
              value={settings['ai.agent.maxIterations']}
              onChange={(e) => updateAgentSetting('ai.agent.maxIterations', parseInt(e.target.value) || 15)}
              className="ns-input ai-agent-number-input"
            />
          </SettingRow>
          <SettingRow label="System Prompt" description="The agent system prompt is configured in Settings → Prompts." />
        </div>
      </SettingsSection>

      {/* Token Usage Section */}
      <SettingsSection
        title="Token Usage"
        description={`AI token consumption across all sessions, since ${new Date(tokenUsage.sessionStart).toLocaleDateString()}. Kept until you reset it.`}
        actions={
          <button
            className="ns-btn ns-btn--small"
            onClick={resetAllTokens}
            disabled={tokenUsage.totalRequests === 0}
          >
            Reset All
          </button>
        }
      >
        <div className="token-usage-total">
          <div className="token-usage-stat">
            <span className="stat-value">{tokenUsage.totalTokens.toLocaleString()}</span>
            <span className="stat-label">Total Tokens</span>
          </div>
          <div className="token-usage-stat">
            <span className="stat-value">{tokenUsage.totalInputTokens.toLocaleString()}</span>
            <span className="stat-label">Input</span>
          </div>
          <div className="token-usage-stat">
            <span className="stat-value">{tokenUsage.totalOutputTokens.toLocaleString()}</span>
            <span className="stat-label">Output</span>
          </div>
          <div className="token-usage-stat">
            <span className="stat-value">{tokenUsage.totalRequests.toLocaleString()}</span>
            <span className="stat-label">Requests</span>
          </div>
        </div>

        {tokenUsage.totalRequests === 0 ? (
          <p className="form-hint">No token usage recorded yet.</p>
        ) : (
          <div className="settings-group">
            {(Object.keys(tokenUsage.providers) as TokenProviderType[]).map((providerKey) => {
              const provider = tokenUsage.providers[providerKey];
              const providerInfo = PROVIDERS.find(p => p.type === providerKey);
              if (provider.requestCount === 0) return null;
              const name = providerInfo?.name || providerKey;
              return (
                <SettingsItem
                  key={providerKey}
                  leading={providerInfo?.icon}
                  title={name}
                  meta={
                    <>
                      <span>{provider.totalTokens.toLocaleString()} tokens</span>
                      <span>{provider.inputTokens.toLocaleString()} in / {provider.outputTokens.toLocaleString()} out</span>
                      <span>{provider.requestCount} requests</span>
                    </>
                  }
                  actions={
                    <button
                      className="ns-btn ns-btn--small ns-btn--ghost"
                      onClick={() => resetProviderTokens(providerKey)}
                      aria-label={`Reset ${name} tokens`}
                    >
                      Reset
                    </button>
                  }
                />
              );
            })}
          </div>
        )}
      </SettingsSection>

      {/* AI Tools Section — shown when local_ai_tools feature is enabled */}
      {hasAiTools && (
      <>
      <SettingsSection
        title="AI Tools"
        description="Each agent type has its own permission mode and tool configuration. A disabled tool is never offered to or run by that agent type."
        help={{
          topic: 'AI permissions and tools',
          prompt: `Help me configure AI permissions in NetStacks. Auto Pilot is in ${PERMISSION_MODES[settings[PERMISSION_MODE_SETTING.autopilot]].label} mode and Overlord in ${PERMISSION_MODES[settings[PERMISSION_MODE_SETTING.overlord]].label} mode; ${disabledTools.length} of ${toolRegistry.length} tools are disabled for ${toolsAgentType === 'autopilot' ? 'Auto Pilot' : 'Overlord'}. `
            + `Explain Ask (approve every call), Auto (approve only writes) and Go Nuts (approve nothing), what always stays blocked (disabled tools, ${isEnterprise ? '' : 'the bash deny list, '}config commands without Config Mode, file writes without Terminal Mode), which tools count as writes, and recommend settings for day-to-day troubleshooting vs change windows.`,
        }}
        actions={
          <span className="settings-badge">
            {toolRegistry.length - disabledTools.length} / {toolRegistry.length} enabled
          </span>
        }
      >
        {/* Agent type tabs */}
        <div className="ns-segmented">
          {(['autopilot', 'overlord'] as const).map(at => (
            <button
              key={at}
              className={`ns-segment${toolsAgentType === at ? ' active' : ''}`}
              aria-pressed={toolsAgentType === at}
              onClick={() => setToolsAgentType(at)}
            >
              {at === 'autopilot' ? settings['ai.modes.autopilot.name'] : settings['ai.modes.overlord.name']}
            </button>
          ))}
        </div>

        <div className="settings-group">
          {/* Permission mode — the AI panel's mode picker edits this same setting */}
          <SettingRow
            label="Permission mode"
            description={`${PERMISSION_MODES[settings[PERMISSION_MODE_SETTING[toolsAgentType]]].description}. In every mode, disabled tools, ${isEnterprise ? '' : 'the bash deny list, '}AI Terminal Mode, AI Config Mode and the topology edit switch still apply.`}
          >
            <select
              aria-label="Permission mode"
              className="ns-select"
              value={settings[PERMISSION_MODE_SETTING[toolsAgentType]]}
              onChange={(e) => updateSetting(PERMISSION_MODE_SETTING[toolsAgentType], e.target.value as PermissionMode)}
            >
              {(Object.entries(PERMISSION_MODES) as [PermissionMode, { label: string }][]).map(([key, pm]) => (
                <option key={key} value={key}>{pm.label}</option>
              ))}
            </select>
          </SettingRow>
          {/* Rename the two modes — used everywhere the mode is shown + in the AI's mode-awareness prompt */}
          <SettingRow label="Mode names" description="Shown wherever the agent modes appear, and in the AI's own prompt." stacked>
            <div className="settings-form-row">
              {(['autopilot', 'overlord'] as const).map((m) => (
                <div key={m} className="form-group">
                  <label htmlFor={`ai-mode-name-${m}`}>{m === 'autopilot' ? 'Mode 1 name' : 'Mode 2 name'}</label>
                  <AITabInput
                    id={`ai-mode-name-${m}`}
                    value={settings[`ai.modes.${m}.name` as keyof typeof settings] as string}
                    placeholder={m === 'autopilot' ? 'Auto Pilot' : 'Overlord'}
                    onChange={(e) => updateSetting(`ai.modes.${m}.name` as keyof typeof settings, (e.target.value || (m === 'autopilot' ? 'Auto Pilot' : 'Overlord')) as never)}
                    aiField="AI agent mode name"
                    aiPlaceholder={m === 'autopilot' ? 'Display name for the autonomous agent mode' : 'Display name for the ask-before-acting agent mode'}
                    onAIValue={(v) => updateSetting(`ai.modes.${m}.name` as keyof typeof settings, v as never)}
                  />
                </div>
              ))}
            </div>
          </SettingRow>
        </div>

        <div className="settings-group">
          {toolCategories.map((category) => {
            const categoryInfo = TOOL_CATEGORIES[category];
            const categoryTools = toolRegistry.filter(t => t.category === category);
            const isExpanded = expandedToolCategories.has(category);
            const { enabled, total } = getCategoryEnabledCount(category);
            const allEnabled = enabled === total;
            const noneEnabled = enabled === 0;

            return (
              <div key={category} className="ai-tools-category">
                <div className="ai-tools-category-header">
                  <button
                    className={`ai-tools-category-toggle ${isExpanded ? 'expanded' : ''}`}
                    onClick={() => toggleToolCategory(category)}
                  >
                    <span className={`ai-tools-chevron ${isExpanded ? 'expanded' : ''}`}>
                      {Icons.chevron}
                    </span>
                    <span className="ai-tools-category-name">{categoryInfo.label}</span>
                    <span className={`ai-tools-category-count ${noneEnabled ? 'none' : allEnabled ? 'all' : 'partial'}`}>
                      {enabled}/{total}
                    </span>
                  </button>
                  <span className="ai-tools-category-master-toggle">
                    <Switch
                      size="sm"
                      checked={allEnabled}
                      onChange={(v) => toggleCategoryTools(category, v)}
                      label={`Enable all ${categoryInfo.label} tools`}
                    />
                  </span>
                </div>

                {isExpanded && (
                  <div className="ai-tools-list">
                    <p className="ai-tools-category-description">{categoryInfo.description}</p>
                    {categoryTools.map((tool) => (
                      <label key={tool.name} className="ai-tool-item">
                        <input
                          type="checkbox"
                          checked={isToolEnabled(tool.name)}
                          onChange={() => toggleTool(tool.name)}
                        />
                        <div className="ai-tool-info">
                          <span className="ai-tool-name">
                            {tool.name}
                            {tool.defaultDisabled && (
                              <Tooltip label="Starts disabled; enable it here to let the AI use it"><span className="ai-tool-default-off">off by default</span></Tooltip>
                            )}
                          </span>
                          <span className="ai-tool-description">{tool.shortDescription}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </SettingsSection>

      {/* run_bash is standalone-only (the local agent's /ai/bash-execute). */}
      {!isEnterprise && (
      <SettingsSection
        title="Bash Command Deny List"
        description="Commands blocked from AI bash execution, on top of the built-in deny list (rm, sudo, kill, shutdown, chmod, …)."
      >
        <div className="ai-bash-deny-add">
          <AITabInput
            value={bashDenyInput}
            onChange={e => setBashDenyInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addBashDenyEntry(); }}
            placeholder="e.g. wget, nc, ncat"
            aria-label="Command to deny"
            aiField="bash command to deny"
            aiPlaceholder="One shell command name the AI must never run, beyond the built-in deny list"
            aiContext={{ alreadyDenied: (settings['ai.bash.deniedCommands'] ?? []).join(', ') }}
            onAIValue={setBashDenyInput}
          />
          <button
            className="ns-btn ns-btn--primary"
            onClick={addBashDenyEntry}
            disabled={!bashDenyInput.trim()}
          >
            Add
          </button>
        </div>

        {bashDeniedCommands.length > 0 && (
          <div className="ai-bash-deny-list">
            {bashDeniedCommands.map(cmd => (
              <span key={cmd} className="ai-bash-deny-chip">
                {cmd}
                <button
                  type="button"
                  className="ai-bash-deny-chip-remove"
                  onClick={() => removeBashDenyEntry(cmd)}
                  aria-label={`Remove ${cmd}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {bashDeniedCommands.length === 0 && (
          <p className="form-hint">
            No custom deny entries — using built-in deny list only
          </p>
        )}
      </SettingsSection>
      )}
      </>
      )}

      {/* AI Overlord Settings */}
      <SettingsSection
        title="AI Overlord"
        description="The provider and model Overlord uses to analyze terminal output. Overlord watches your terminals and flags issues like BGP state problems, interface errors and security concerns."
      >
        <div className="settings-group">
          <SettingRow label="Provider">
            <select aria-label="Overlord provider"
              className="ns-select"
              value={settings['ai.overlord.provider'] || ''}
              onChange={(e) => updateSetting('ai.overlord.provider', (e.target.value || null) as AiProviderType | null)}
            >
              <option value="">Use Default Provider</option>
              {PROVIDERS.filter(p => settings['ai.enabledProviders']?.includes(p.type as AiProviderType)).map(p => (
                <option key={p.type} value={p.type}>{p.name}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label="Model" description={`e.g. ${ANTHROPIC_MODELS.opus} for better analysis quality`}>
            <input data-ai-fill="off"
              type="text"
              aria-label="Overlord model"
              className="ns-input ai-agent-select"
              value={settings['ai.overlord.model'] || ''}
              onChange={(e) => updateSetting('ai.overlord.model', e.target.value || null)}
              placeholder="Use default model"
            />
          </SettingRow>
        </div>
      </SettingsSection>

      {/* MCP Servers Section — Personal Mode only; admin-managed in Enterprise mode */}
      {hasAiTools && !isEnterprise && <McpServersSection />}

      {/* AI Memory Section */}
      <AIMemoryTab />

      {/* AI Data Security Section */}
      <SettingsSection
        title="AI Data Security"
        description="Credentials, secrets and network identifiers are scrubbed from data before it reaches external AI providers. 19 mandatory credential patterns are always active."
      >
        {canManageRedaction && sanitizationLoading ? (
          <p className="form-hint">Loading sanitization settings…</p>
        ) : (
          <div className="settings-group">
            <SettingRow
              label="Mandatory patterns"
              description="Always active; they cannot be turned off."
              stacked={mandatoryPatternsExpanded}
            >
              <div>
                <button
                  className="ns-btn ns-btn--small ns-btn--ghost"
                  aria-expanded={mandatoryPatternsExpanded}
                  onClick={() => setMandatoryPatternsExpanded(!mandatoryPatternsExpanded)}
                >
                  {mandatoryPatternsExpanded ? 'Hide the 19 patterns' : 'Show the 19 patterns'}
                </button>
              </div>
              {mandatoryPatternsExpanded && (
                <ol className="sanitization-mandatory-list">
                  {[
                    'Cisco enable secret/password', 'Cisco password 7', 'Cisco password 0',
                    'SNMP community strings', 'SNMPv3 auth/priv keys', 'TACACS keys', 'RADIUS keys',
                    'Juniper secrets ($9$)', 'Juniper encrypted passwords', 'Arista secrets',
                    'Palo Alto passwords', 'Palo Alto keys', 'Private key blocks', 'Certificate blocks',
                    'Generic API keys/tokens', 'AWS access keys', 'AWS secret keys',
                    'Generic passwords', 'Generic secrets/shared keys',
                  ].map((name) => <li key={name}>{name}</li>)}
                </ol>
              )}
            </SettingRow>
            {!canManageRedaction && (
              <SettingRow
                label="Organization redaction rules"
                description="Redaction rules are managed by your administrator."
              />
            )}
          </div>
        )}
      </SettingsSection>

      {canManageRedaction && !sanitizationLoading && (
        <>
          <SettingsSection title="Optional Redaction" description="Extra identifiers to scrub before data leaves this machine.">
            <div className="settings-group">
              {([
                { key: 'redact_ip_addresses' as const, label: 'IPv4 Addresses', desc: '10.0.0.1, 192.168.1.0/24' },
                { key: 'redact_ipv6_addresses' as const, label: 'IPv6 Addresses', desc: 'fe80::1, 2001:db8::1' },
                { key: 'redact_mac_addresses' as const, label: 'MAC Addresses', desc: '00:1a:2b:3c:4d:5e' },
                { key: 'redact_hostnames' as const, label: 'Hostnames/FQDNs', desc: 'router1.corp.example.com' },
                { key: 'redact_usernames' as const, label: 'Usernames', desc: 'username admin' },
              ]).map(({ key, label, desc }) => (
                <SettingRow key={key} label={label} description={desc}>
                  <Switch
                    checked={sanitizationConfig[key] as boolean}
                    onChange={(v) => handleToggleSanitization(key, v)}
                    label={`Redact ${label}`}
                  />
                </SettingRow>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection title="Custom Redaction Patterns" description="Your own regular expressions and what to replace each match with.">
            <div className="settings-group">
              {sanitizationConfig.custom_patterns.map((p, i) => (
                <SettingsItem
                  key={i}
                  title={p.name}
                  meta={<><code>{p.regex}</code><span>→</span><code>{p.replacement}</code></>}
                  actions={
                    <button
                      className="ns-btn ns-btn--small ns-btn--ghost ns-btn--danger"
                      onClick={() => handleRemoveCustomPattern(i)}
                    >
                      Remove
                    </button>
                  }
                />
              ))}
              <div className="sanitization-add-row">
                <AITabInput
                  aria-label="Pattern name"
                  placeholder="Name"
                  value={newPattern.name}
                  onChange={(e) => setNewPattern(p => ({ ...p, name: e.target.value }))}
                  aiField="redaction pattern name"
                  aiPlaceholder="Short name for a secret-redaction rule applied before text reaches the AI"
                  aiContext={{ regex: newPattern.regex, replacement: newPattern.replacement }}
                  onAIValue={(v) => setNewPattern(p => ({ ...p, name: v }))}
                />
                <AITabInput
                  aria-label="Pattern regex"
                  placeholder="Regex"
                  value={newPattern.regex}
                  onChange={(e) => setNewPattern(p => ({ ...p, regex: e.target.value }))}
                  className="settings-code"
                  aiField="redaction regex"
                  aiPlaceholder="Regular expression matching the secret to redact from device output (Rust regex syntax)"
                  aiContext={{ name: newPattern.name, replacement: newPattern.replacement }}
                  onAIValue={(v) => setNewPattern(p => ({ ...p, regex: v }))}
                />
                <AITabInput
                  aria-label="Replacement"
                  placeholder="Replacement"
                  value={newPattern.replacement}
                  onChange={(e) => setNewPattern(p => ({ ...p, replacement: e.target.value }))}
                  className="settings-code"
                  aiField="redaction replacement"
                  aiPlaceholder="Replacement text for the matched secret, e.g. [REDACTED_PASSWORD]"
                  aiContext={{ name: newPattern.name, regex: newPattern.regex }}
                  onAIValue={(v) => setNewPattern(p => ({ ...p, replacement: v }))}
                />
                <button
                  className="ns-btn ns-btn--small"
                  onClick={handleAddCustomPattern}
                  disabled={!newPattern.name || !newPattern.regex || !newPattern.replacement}
                >
                  Add
                </button>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Allowlist" description="Strings that are never redacted (case-insensitive match).">
            <div className="settings-group">
              {sanitizationConfig.allowlist.length > 0 && (
                <div className="sanitization-allowlist">
                  {sanitizationConfig.allowlist.map((item, i) => (
                    <span key={i} className="sanitization-allowlist-tag">
                      {item}
                      <button type="button" aria-label={`Remove ${item}`} onClick={() => handleRemoveAllowlistItem(i)}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="sanitization-add-row">
                <input data-ai-fill="off"
                  type="text"
                  aria-label="Allowlist entry"
                  placeholder="Add allowlist entry..."
                  value={newAllowlistItem}
                  onChange={(e) => setNewAllowlistItem(e.target.value)}
                  className="ns-input"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddAllowlistItem();
                  }}
                />
                <button
                  className="ns-btn ns-btn--small"
                  onClick={handleAddAllowlistItem}
                  disabled={!newAllowlistItem.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </SettingsSection>
        </>
      )}

      {/* Anyone can see what their organization's (or this machine's) rules
          redact; /ai/sanitization/test applies them server-side. */}
      {!(canManageRedaction && sanitizationLoading) && (
        <SettingsSection
          title="Test Sanitization"
          description="Paste text to see exactly what would be sent to the AI provider."
          actions={
            <button
              className="ns-btn ns-btn--small"
              onClick={handleTestSanitization}
              disabled={testRunning || !testInput.trim()}
            >
              {testRunning ? 'Testing...' : 'Test'}
            </button>
          }
        >
          <AITabInput
            as="textarea"
            className="settings-code"
            aria-label="Text to test"
            placeholder="e.g. enable secret 5 $1$abc$xyz"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            rows={4}
            aiField="sample device output to test redaction"
            aiPlaceholder="A few lines of realistic network-device config containing fake secrets (passwords, SNMP communities, keys) to test the redaction rules"
            onAIValue={setTestInput}
          />
          {testResult && (
            <div className="sanitization-test-result">
              <p className="form-hint">
                {testResult.redaction_count} redaction{testResult.redaction_count !== 1 ? 's' : ''}
                {testResult.pattern_names.length > 0 && ` · Matched: ${testResult.pattern_names.join(', ')}`}
              </p>
              <pre className="sanitization-test-output">{testResult.sanitized}</pre>
            </div>
          )}
        </SettingsSection>
      )}
    </>
  );
}
