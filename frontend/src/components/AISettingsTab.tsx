import React, { useState, useEffect } from 'react';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { getClient, isClientInitialized } from '../api/client';
import {
  getAiConfig,
  setAiConfig,
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
  type AiAgentConfig,
  type SanitizationConfig,
  type CustomPattern,
  type SanitizationTestResult,
  getAiStatus,
  enableAiConfigMode,
  disableAiConfigMode,
  getAiConfigModeStatus,
  type ConfigModeStatus,
} from '../api/ai';
import { useSettings, type AiProviderType as SettingsProviderType } from '../hooks/useSettings';
import { useMode } from '../hooks/useMode';
import { useTokenUsage, type AiProviderType as TokenProviderType } from '../contexts/TokenUsageContext';
import { TOOL_REGISTRY, TOOL_CATEGORIES, type ToolCategory } from '../lib/agentTools';
import McpServersSection from './McpServersSection';
import AIMemoryTab from './AIMemoryTab';
import { PasswordInput } from './PasswordInput';
import './AISettingsTab.css';

// Icons
import { getErrorMessage } from '../api/errors'
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
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
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
  sparkles: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
      <path d="M19 14l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" />
      <path d="M5 17l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L3 19l1.5-.5.5-1.5z" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  brain: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
      <line x1="10" y1="21" x2="14" y2="21" />
      <line x1="9" y1="10" x2="15" y2="10" />
      <line x1="12" y1="7" x2="12" y2="13" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  tokens: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  tool: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
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

  // New model input per provider (for adding models to the list)
  const [newModelInputs, setNewModelInputs] = useState<Record<AiProviderType, string>>({
    anthropic: '',
    openai: '',
    openrouter: '',
    ollama: '',
    litellm: '',
    custom: '',
  });

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
    loadSanitizationConfig();
  }, []);

  // Sync agent settings to backend when they change
  useEffect(() => {
    const syncAgentConfig = async () => {
      const agentConfig: AiAgentConfig = {
        provider: settings['ai.agent.provider'],
        model: settings['ai.agent.model'],
        temperature: settings['ai.agent.temperature'],
        max_tokens: settings['ai.agent.maxTokens'],
        max_iterations: settings['ai.agent.maxIterations'],
        system_prompt: settings['ai.agent.systemPrompt'],
      };
      try {
        await setAiAgentConfig(agentConfig);
      } catch (err) {
        console.error('Failed to sync agent config to backend:', err);
      }
    };
    // Only sync after initial load
    if (!loading) {
      syncAgentConfig();
    }
  }, [
    loading,
    settings['ai.agent.provider'],
    settings['ai.agent.model'],
    settings['ai.agent.temperature'],
    settings['ai.agent.maxTokens'],
    settings['ai.agent.maxIterations'],
    settings['ai.agent.systemPrompt'],
  ]);

  const loadSanitizationConfig = async () => {
    try {
      setSanitizationLoading(true);
      const config = await getSanitizationConfig();
      // Ensure custom_patterns and allowlist always have arrays (controller may omit them)
      setSanitizationConfigState({
        ...DEFAULT_SANITIZATION_CONFIG,
        ...config,
        custom_patterns: config.custom_patterns || [],
        allowlist: config.allowlist || [],
      });
    } catch {
      // Silently use defaults — getSanitizationConfig already handles 404s
      setSanitizationConfigState({ ...DEFAULT_SANITIZATION_CONFIG });
    } finally {
      setSanitizationLoading(false);
    }
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
    }
  };

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

  // Ensure Overlord always has run_bash in its disabled list by default
  useEffect(() => {
    const overlordKey = 'ai.disabledTools.overlord' as keyof typeof settings;
    const overlordDisabled = (settings[overlordKey] as string[]) || [];
    if (!overlordDisabled.includes('run_bash')) {
      updateSetting(overlordKey, [...overlordDisabled, 'run_bash']);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const disabledToolsKeyFor = (at: 'autopilot' | 'overlord') =>
    `ai.disabledTools.${at}` as keyof typeof settings;

  const getDisabledForAgent = (at: 'autopilot' | 'overlord'): string[] =>
    (settings[disabledToolsKeyFor(at)] as string[]) || [];

  const disabledTools = getDisabledForAgent(toolsAgentType);
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
    const categoryTools = TOOL_REGISTRY.filter(t => t.category === category).map(t => t.name);
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
    const categoryTools = TOOL_REGISTRY.filter(t => t.category === category);
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

  const handleSaveKey = async (providerType: AiProviderType) => {
    const key = apiKeys[providerType];
    if (!key && providerType !== 'ollama' && providerType !== 'litellm') return;

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
      if (key && providerType !== 'ollama' && providerType !== 'litellm') {
        await storeAiApiKey(providerType, key);
        vaultWriteSucceeded = true;
      }

      // Build and save config - use first model from configured models list
      const configuredModels = getProviderModels(providerType);
      const config: AiConfig = {
        provider: providerType,
        model: providerType === 'custom' ? customModel : configuredModels[0] || '',
        base_url: baseUrls[providerType] || undefined,
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
        await setAiConfig(config);
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

      setSuccess(`${PROVIDERS.find(p => p.type === providerType)?.name} configured successfully`);
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

        // Save config (including base_url) before testing so the backend has it
        const configuredModels = getProviderModels(providerType);
        const testModel = providerType === 'custom' ? customModel : configuredModels[0] || '';
        const testConfig: AiConfig = {
          provider: providerType,
          model: testModel,
          base_url: baseUrls[providerType] || undefined,
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
        await setAiConfig(testConfig);

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
        base_url: baseUrls[providerType] || undefined,
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
  const getModelPlaceholder = (providerType: AiProviderType): string => {
    switch (providerType) {
      case 'anthropic': return 'claude-sonnet-4-20250514';
      case 'openai': return 'gpt-4o';
      case 'openrouter': return 'anthropic/claude-sonnet-4';
      case 'ollama': return 'llama3.2';
      case 'litellm': return 'gpt-4o';
      default: return 'model-name';
    }
  };

  // Get hint text for model input based on provider
  const getModelHint = (providerType: AiProviderType): string => {
    switch (providerType) {
      case 'anthropic': return 'e.g., claude-sonnet-4-20250514, claude-haiku-4-5-20251001';
      case 'openai': return 'e.g., gpt-4o, gpt-4o-mini, o1-preview';
      case 'openrouter': return 'e.g., anthropic/claude-sonnet-4, openai/gpt-4o';
      case 'ollama': return 'Run "ollama list" to see available models';
      case 'litellm': return 'Model name configured in your LiteLLM proxy';
      default: return '';
    }
  };

  // Get the default provider label for "Use Default" dropdown option
  const defaultProviderLabel = isEnterprise
    ? (enterpriseProviders.find(p => p.is_default)?.name || 'Controller Default')
    : (settings['ai.defaultProvider'] || 'anthropic');

  // Get available providers for per-feature dropdowns
  const availableProviderOptions = isEnterprise
    ? enterpriseProviders.map(p => ({ type: p.type as AiProviderType, name: p.name }))
    : PROVIDERS.filter(p => providerStatus[p.type]?.hasKey || p.type === 'ollama' || p.type === 'litellm');

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
      <div className="ai-settings-tab">
        <div className="ai-loading">Loading AI settings...</div>
      </div>
    );
  }

  const defaultProvider = settings['ai.defaultProvider'] || 'anthropic';

  return (
    <div className="ai-settings-tab">
      {/* Header */}
      <div className="ai-header">
        <p className="ai-description">
          {isEnterprise
            ? 'AI features are available through your NetStacks Controller. Local preferences for automation and tools are configured below.'
            : 'Configure multiple AI providers. Each provider can be configured with its own API key. Select a default provider or switch providers in the AI chat panel.'}
        </p>
      </div>

      {error && <div className="ai-error">{error}</div>}
      {success && <div className="ai-success">{success}</div>}

      {/* Provider Sections — hidden in enterprise mode (managed centrally) */}
      {isEnterprise ? (
        <section className="ai-section">
          <div className="section-header">
            <h3>PROVIDERS</h3>
          </div>
          <div style={{ padding: '16px 20px', color: 'var(--text-secondary)', fontSize: '13px', lineHeight: '1.5' }}>
            AI providers are managed by your NetStacks Controller administrator.
          </div>
          {enterpriseProviders.length > 0 ? (
            <div className="ai-provider-list" style={{ padding: '0 20px 16px' }}>
              {enterpriseProviders.map((p) => (
                <div
                  key={p.type}
                  className="ai-provider-section configured"
                  style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}
                >
                  <span className="ai-provider-name" style={{ flex: 1 }}>{p.name}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{p.type}</span>
                  {p.is_default && (
                    <span className="ai-provider-default-badge">
                      {Icons.star}
                      Default
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '0 20px 16px', color: 'var(--text-tertiary)', fontSize: '12px' }}>
              No providers configured on the Controller. Contact your administrator.
            </div>
          )}
        </section>
      ) : (
      <section className="ai-section">
        <div className="section-header">
          <h3>PROVIDERS</h3>
        </div>

        <div className="ai-provider-list">
          {PROVIDERS.map((p) => {
            const status = providerStatus[p.type];
            const providerEnabled = isProviderEnabled(p.type);
            const isExpanded = providerEnabled && expandedProviders.has(p.type);
            const isDefault = defaultProvider === p.type;

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
                  <label className="ai-provider-enable-toggle" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={providerEnabled}
                      onChange={() => toggleProviderEnabled(p.type)}
                    />
                    <span className="toggle-slider small" />
                  </label>
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
                            className="form-input"
                            value={apiKeys[p.type]}
                            onChange={(e) => setApiKeys(prev => ({ ...prev, [p.type]: e.target.value }))}
                            placeholder={status.hasKey ? '********** (key saved)' : 'Enter your API key'}
                          />
                          {status.hasKey && (
                            <button
                              className="btn-delete-key"
                              onClick={() => handleDeleteKey(p.type)}
                              title="Remove API key"
                            >
                              {Icons.trash}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Base URL (all providers — override for proxies/gateways) */}
                    <div className="form-group">
                      <label>Base URL</label>
                      <input
                        type="text"
                        className="form-input"
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
                         'Leave empty to use the default API endpoint. Set to use a proxy or gateway.'}
                      </span>
                    </div>

                    {/* TLS verification — shown for all providers that may use custom/self-signed endpoints */}
                    {p.type !== 'openrouter' && (
                      <div className="form-group">
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
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
                    )}

                    {/* API Format (for Custom provider) */}
                    {p.type === 'custom' && (
                      <div className="form-group">
                        <label>API Format</label>
                        <select
                          className="form-input"
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
                        <input
                          type="text"
                          className="form-input"
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
                        <select
                          className="form-input"
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
                          <input
                            type="text"
                            className="form-input"
                            value={oauth2TokenUrl}
                            onChange={(e) => setOauth2TokenUrl(e.target.value)}
                            placeholder="https://api.example.com/oauth/token"
                          />
                        </div>
                        <div className="form-group">
                          <label>Client ID</label>
                          <input
                            type="text"
                            className="form-input"
                            value={oauth2ClientId}
                            onChange={(e) => setOauth2ClientId(e.target.value)}
                            placeholder="your-client-id"
                          />
                          <span className="form-hint">Client Secret is stored in the API Key field above (encrypted in vault)</span>
                        </div>
                        <div className="form-group">
                          <label>Custom Headers</label>
                          <textarea
                            className="form-input"
                            rows={3}
                            value={customHeaders}
                            onChange={(e) => setCustomHeaders(e.target.value)}
                            placeholder={"user_email: name@example.com\nX-Custom-Header: value"}
                            style={{ fontFamily: 'monospace', fontSize: '12px' }}
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
                                  <button
                                    className="btn-move-model"
                                    onClick={() => moveProviderModel(p.type, index, 'up')}
                                    disabled={isFirst}
                                    title="Move up (make default)"
                                  >
                                    {Icons.arrowUp}
                                  </button>
                                  <button
                                    className="btn-move-model"
                                    onClick={() => moveProviderModel(p.type, index, 'down')}
                                    disabled={isLast}
                                    title="Move down"
                                  >
                                    {Icons.arrowDown}
                                  </button>
                                  <button
                                    className="btn-remove-model"
                                    onClick={() => removeProviderModel(p.type, model)}
                                    title="Remove model"
                                  >
                                    {Icons.trash}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                          {getProviderModels(p.type).length === 0 && (
                            <span className="no-models-hint">No models configured. Add a model below.</span>
                          )}
                        </div>
                        <div className="add-model-row">
                          <input
                            type="text"
                            className="form-input"
                            value={newModelInputs[p.type]}
                            onChange={(e) => setNewModelInputs(prev => ({ ...prev, [p.type]: e.target.value }))}
                            placeholder={getModelPlaceholder(p.type)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addProviderModel(p.type, newModelInputs[p.type]);
                              }
                            }}
                          />
                          <button
                            className="btn-add-model"
                            onClick={() => addProviderModel(p.type, newModelInputs[p.type])}
                            disabled={!newModelInputs[p.type].trim()}
                          >
                            Add
                          </button>
                        </div>
                        <span className="form-hint">{getModelHint(p.type)}</span>

                        {/* Max Tokens */}
                        <div className="max-tokens-row">
                          <label>Max Tokens:</label>
                          <input
                            type="number"
                            min="0"
                            max="200000"
                            step="256"
                            value={settings[`ai.maxTokens.${p.type}` as keyof typeof settings] as number || 0}
                            onChange={(e) => updateSetting(`ai.maxTokens.${p.type}` as keyof typeof settings, parseInt(e.target.value) || 0)}
                            className="form-input max-tokens-input"
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

                    {/* Actions */}
                    <div className="ai-provider-actions">
                      <button
                        className="btn-set-default"
                        onClick={() => handleSetDefault(p.type)}
                        disabled={isDefault || (!status.hasKey && p.type !== 'ollama' && p.type !== 'litellm')}
                      >
                        {isDefault ? 'Default Provider' : 'Set as Default'}
                      </button>

                      {p.requiresKey && (
                        <button
                          className="btn-save-key"
                          onClick={() => handleSaveKey(p.type)}
                          disabled={!apiKeys[p.type] || saving === p.type}
                        >
                          {Icons.save}
                          {saving === p.type ? 'Saving...' : 'Save Key'}
                        </button>
                      )}

                      <button
                        className="btn-test-connection"
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
      </section>
      )}

      {/* AI Automation Section */}
      <section className="ai-section">
        <div className="section-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" style={{ marginRight: '6px' }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            AI AUTOMATION
          </h3>
        </div>

        <p className="ai-description">
          Enable or disable automatic AI features. Disabling reduces API usage and costs.
        </p>

        <div className="ai-automation-toggles">
          {/* Command Autocomplete Toggle */}
          <div className="ai-automation-feature">
            <label className="ai-automation-item">
              <div className="ai-automation-info">
                <span className="ai-automation-label">Command Autocomplete</span>
                <span className="ai-automation-description">
                  AI suggests commands as you type in terminals (uses API after 300ms debounce)
                </span>
              </div>
              <div className="toggle-wrapper">
                <input
                  type="checkbox"
                  checked={settings['ai.inlineSuggestions']}
                  onChange={(e) => updateSetting('ai.inlineSuggestions', e.target.checked)}
                />
                <span className="toggle-slider" />
              </div>
            </label>
          </div>

          {/* Next Step Suggestions Toggle */}
          <div className="ai-automation-feature">
            <label className="ai-automation-item">
              <div className="ai-automation-info">
                <span className="ai-automation-label">Next Step Suggestions</span>
                <span className="ai-automation-description">
                  AI suggests follow-up commands after you execute commands
                </span>
              </div>
              <div className="toggle-wrapper">
                <input
                  type="checkbox"
                  checked={settings['ai.nextStepSuggestions']}
                  onChange={(e) => updateSetting('ai.nextStepSuggestions', e.target.checked)}
                />
                <span className="toggle-slider" />
              </div>
            </label>
          </div>

          {/* Topology structural edits toggle */}
          <div className="ai-automation-feature">
            <label className="ai-automation-item">
              <div className="ai-automation-info">
                <span className="ai-automation-label">Allow AI to edit topologies</span>
                <span className="ai-automation-description">
                  Let the AI structurally change the active topology (add, remove, and
                  move devices &amp; connections). When off, the AI can still read,
                  analyze, highlight, and annotate the map. All AI edits are tracked in
                  undo history.
                </span>
              </div>
              <div className="toggle-wrapper">
                <input
                  type="checkbox"
                  checked={settings['ai.topology.allowStructuralEdits']}
                  onChange={(e) => updateSetting('ai.topology.allowStructuralEdits', e.target.checked)}
                />
                <span className="toggle-slider" />
              </div>
            </label>
          </div>

          {/* AUDIT FIX (EXEC-002): server-side AI config-mode panel.
              Replaces the old persistent client-side toggle. Enabling
              requires the user to re-supply the master password and the
              override auto-expires after ~5 min. */}
          <div className="ai-automation-feature ai-config-changes-feature">
            <div className="ai-automation-item">
              <div className="ai-automation-info">
                <span className="ai-automation-label">AI Configuration Mode</span>
                <span className="ai-automation-description">
                  {isEnterprise && !controllerAiConfigEnabled
                    ? 'This feature is disabled by your administrator. Contact your admin to enable AI configuration changes on the controller.'
                    : isEnterprise
                      ? 'Temporarily allows the AI assistant to execute configuration commands on network devices. Auto-disables after 5 minutes.'
                      : 'Temporarily allows the AI assistant to execute configuration commands on network devices. Requires your master password to enable, auto-disables after 5 minutes.'
                  }
                </span>
              </div>
              {!(isEnterprise && !controllerAiConfigEnabled) && (
                configModeStatus.enabled ? (
                  <button
                    type="button"
                    className="form-button"
                    onClick={handleDisableConfigMode}
                    disabled={configModeBusy}
                    style={{ background: '#7c2d12', color: '#fed7aa', minWidth: '160px' }}
                  >
                    {configModeBusy
                      ? 'Disabling…'
                      : `Disable (${Math.max(0, configModeStatus.seconds_remaining ?? 0)}s left)`}
                  </button>
                ) : (
                  <span style={{ fontSize: '12px', opacity: 0.7 }}>Disabled</span>
                )
              )}
            </div>

            {!configModeStatus.enabled && !(isEnterprise && !controllerAiConfigEnabled) && (
              isEnterprise ? (
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    className="form-button"
                    onClick={() => { void handleEnableConfigMode(); }}
                    disabled={configModeBusy}
                    style={{ background: '#b45309', color: '#fed7aa', minWidth: '160px', padding: '8px 16px', borderRadius: '4px', border: 'none', cursor: configModeBusy ? 'not-allowed' : 'pointer', opacity: configModeBusy ? 0.6 : 1 }}
                  >
                    {configModeBusy ? 'Enabling…' : 'Enable for 5 min'}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleEnableConfigMode} style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <PasswordInput
                    className="form-input"
                    placeholder="Master password to enable…"
                    value={configModePassword}
                    onChange={(e) => setConfigModePassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={configModeBusy}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="submit"
                    className="form-button"
                    disabled={configModeBusy || configModePassword.length < 12}
                    style={{ background: '#b45309', color: '#fed7aa' }}
                  >
                    {configModeBusy ? 'Enabling…' : 'Enable for 5 min'}
                  </button>
                </form>
              )
            )}

            {configModeError && (
              <div style={{ marginTop: '8px', color: '#fca5a5', fontSize: '12px' }}>
                {configModeError}
              </div>
            )}

            {configModeStatus.enabled && (
              <div className="ai-config-changes-warning" style={{ marginTop: '8px' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>AI is currently allowed to send configuration commands. The override expires automatically; click Disable to revoke immediately.</span>
              </div>
            )}
          </div>
        </div>

        {/* Context Management */}
        <div className="ai-automation-feature" style={{ marginTop: '16px' }}>
          <div className="ai-automation-item">
            <div className="ai-automation-info">
              <span className="ai-automation-label">Max Conversation Messages</span>
              <span className="ai-automation-description">
                Limit conversation history to prevent context overflow errors. Set to 0 for unlimited.
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="number"
                min="0"
                max="100"
                value={settings['ai.maxConversationMessages']}
                onChange={(e) => updateSetting('ai.maxConversationMessages', parseInt(e.target.value) || 0)}
                style={{ width: '60px', textAlign: 'center' }}
                className="form-input"
              />
              <span style={{ fontSize: '11px', opacity: 0.7 }}>messages</span>
            </div>
          </div>
        </div>
      </section>

      {/* AI Agents Section */}
      <section className="ai-section">
        <div className="section-header">
          <h3>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" style={{ marginRight: '6px' }}>
              <path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
              <path d="M12 11v2" />
              <path d="M8 15h8" />
              <rect x="6" y="15" width="12" height="7" rx="2" />
            </svg>
            AI AGENTS
          </h3>
        </div>

        <p className="ai-description">
          Configure how AI agents execute background tasks. Agents use the ReAct (Reasoning + Acting) loop to
          autonomously complete network automation tasks.
        </p>

        <div className="ai-agent-settings">
          {/* Provider Selection */}
          <div className="ai-agent-setting-row">
            <div className="ai-agent-setting-info">
              <span className="ai-agent-setting-label">Provider</span>
              <span className="ai-agent-setting-description">
                AI provider for agent tasks
              </span>
            </div>
            <select
              value={settings['ai.agent.provider'] || ''}
              onChange={(e) => {
                const value = e.target.value || null;
                updateSetting('ai.agent.provider', value as AiProviderType | null);
                if (value) {
                  // Set default model for new provider
                  const models = getProviderModels(value as AiProviderType);
                  if (models.length) {
                    updateSetting('ai.agent.model', models[0]);
                  }
                } else {
                  updateSetting('ai.agent.model', null);
                }
              }}
              className="ai-agent-select"
            >
              <option value="">Use Default ({defaultProviderLabel})</option>
              {availableProviderOptions.map(p => (
                <option key={p.type} value={p.type}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Model Selection (only show if provider is selected) */}
          {settings['ai.agent.provider'] && (
            <div className="ai-agent-setting-row">
              <div className="ai-agent-setting-info">
                <span className="ai-agent-setting-label">Model</span>
                <span className="ai-agent-setting-description">
                  Model for agent reasoning
                </span>
              </div>
              <select
                value={settings['ai.agent.model'] || ''}
                onChange={(e) => updateSetting('ai.agent.model', e.target.value || null)}
                className="ai-agent-select"
              >
                <option value="">Default Model</option>
                {(settings['ai.agent.provider'] === 'ollama'
                  ? ollamaModels
                  : getProviderModels(settings['ai.agent.provider']!).map(m => ({ value: m, label: m }))
                ).map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Temperature */}
          <div className="ai-agent-setting-row">
            <div className="ai-agent-setting-info">
              <span className="ai-agent-setting-label">Temperature</span>
              <span className="ai-agent-setting-description">
                Controls randomness (0 = deterministic, 1 = creative)
              </span>
            </div>
            <div className="ai-agent-slider-container">
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={settings['ai.agent.temperature']}
                onChange={(e) => updateSetting('ai.agent.temperature', parseFloat(e.target.value))}
                className="ai-agent-slider"
              />
              <span className="ai-agent-slider-value">{settings['ai.agent.temperature'].toFixed(1)}</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div className="ai-agent-setting-row">
            <div className="ai-agent-setting-info">
              <span className="ai-agent-setting-label">Max Tokens</span>
              <span className="ai-agent-setting-description">
                Maximum tokens per AI response
              </span>
            </div>
            <input
              type="number"
              min="256"
              max="32000"
              step="256"
              value={settings['ai.agent.maxTokens']}
              onChange={(e) => updateSetting('ai.agent.maxTokens', parseInt(e.target.value) || 4096)}
              className="form-input ai-agent-number-input"
            />
          </div>

          {/* Max Iterations */}
          <div className="ai-agent-setting-row">
            <div className="ai-agent-setting-info">
              <span className="ai-agent-setting-label">Max Iterations</span>
              <span className="ai-agent-setting-description">
                Maximum ReAct loop iterations before timeout
              </span>
            </div>
            <input
              type="number"
              min="1"
              max="50"
              value={settings['ai.agent.maxIterations']}
              onChange={(e) => updateSetting('ai.agent.maxIterations', parseInt(e.target.value) || 15)}
              className="form-input ai-agent-number-input"
            />
          </div>

          {/* System Prompt - now managed in Settings > Prompts */}
          <div className="ai-agent-setting-row">
            <div className="ai-agent-setting-info">
              <span className="ai-agent-setting-label">System Prompt</span>
              <span className="ai-agent-setting-description">
                Agent system prompt can be configured in Settings &gt; Prompts.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Token Usage Section */}
      <section className="ai-section">
        <div className="section-header">
          <h3>
            {Icons.tokens}
            <span style={{ marginLeft: '6px' }}>TOKEN USAGE</span>
          </h3>
          <button
            className="btn-reset-tokens"
            onClick={resetAllTokens}
            title="Reset all token counters"
            disabled={tokenUsage.totalRequests === 0}
          >
            {Icons.refresh}
            Reset All
          </button>
        </div>

        <p className="ai-description" style={{ marginBottom: '16px' }}>
          Track AI token consumption across all sessions. Data persists until manually reset.
          Since {new Date(tokenUsage.sessionStart).toLocaleDateString()}.
        </p>

        {/* Total Usage Summary */}
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

        {/* Per-Provider Usage */}
        <div className="token-usage-providers">
          {(Object.keys(tokenUsage.providers) as TokenProviderType[]).map((providerKey) => {
            const provider = tokenUsage.providers[providerKey];
            const providerInfo = PROVIDERS.find(p => p.type === providerKey);
            if (provider.requestCount === 0) return null;

            return (
              <div key={providerKey} className="token-provider-row">
                <div className="token-provider-info">
                  <span className="token-provider-icon">{providerInfo?.icon}</span>
                  <span className="token-provider-name">{providerInfo?.name || providerKey}</span>
                </div>
                <div className="token-provider-stats">
                  <span className="token-stat" title="Total tokens">
                    {provider.totalTokens.toLocaleString()}
                  </span>
                  <span className="token-stat-detail" title="Input / Output">
                    ({provider.inputTokens.toLocaleString()} / {provider.outputTokens.toLocaleString()})
                  </span>
                  <span className="token-requests" title="Requests">
                    {provider.requestCount} req
                  </span>
                  <button
                    className="btn-reset-provider"
                    onClick={() => resetProviderTokens(providerKey)}
                    title={`Reset ${providerInfo?.name || providerKey} tokens`}
                  >
                    {Icons.refresh}
                  </button>
                </div>
              </div>
            );
          })}
          {tokenUsage.totalRequests === 0 && (
            <div className="token-no-usage">No token usage recorded yet</div>
          )}
        </div>
      </section>

      {/* AI Tools Section — shown when local_ai_tools feature is enabled */}
      {hasAiTools && (
      <section className="ai-section">
        <div className="section-header">
          <h3>
            {Icons.tool}
            <span style={{ marginLeft: '6px' }}>AI TOOLS</span>
          </h3>
          <span className="ai-tools-count">
            {TOOL_REGISTRY.length - disabledTools.length} / {TOOL_REGISTRY.length} enabled
          </span>
        </div>

        <p className="ai-description">
          Enable or disable AI tools per agent type. Each agent type can have its own tool configuration.
        </p>

        {/* Agent type tabs */}
        <div className="ai-tools-agent-tabs" style={{ display: 'flex', gap: '0', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          {(['autopilot', 'overlord'] as const).map(at => (
            <button
              key={at}
              className={`ai-tools-agent-tab${toolsAgentType === at ? ' active' : ''}`}
              onClick={() => setToolsAgentType(at)}
              style={{
                padding: '6px 16px',
                border: 'none',
                background: toolsAgentType === at ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: toolsAgentType === at ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: toolsAgentType === at ? 600 : 400,
                borderBottom: toolsAgentType === at ? '2px solid var(--color-accent, #3b82f6)' : '2px solid transparent',
                transition: 'all 0.15s',
              }}
            >
              {at === 'autopilot' ? 'Auto Pilot' : 'Overlord'}
            </button>
          ))}
        </div>

        <div className="ai-tools-categories">
          {(Object.keys(TOOL_CATEGORIES) as ToolCategory[]).map((category) => {
            const categoryInfo = TOOL_CATEGORIES[category];
            const categoryTools = TOOL_REGISTRY.filter(t => t.category === category);
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
                  <label className="ai-tools-category-master-toggle">
                    <input
                      type="checkbox"
                      checked={allEnabled}
                      onChange={(e) => toggleCategoryTools(category, e.target.checked)}
                    />
                    <span className="toggle-slider small" />
                  </label>
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
                          <span className="ai-tool-name">{tool.name}</span>
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

        {/* Bash Deny List Configuration */}
        <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
            Bash Command Deny List
          </h4>
          <p className="ai-description" style={{ margin: '0 0 8px' }}>
            Commands blocked from AI bash execution. Built-in deny list includes rm, sudo, kill, shutdown, chmod, etc.
            Add extra commands here to extend the deny list.
          </p>

          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
            <input
              type="text"
              value={bashDenyInput}
              onChange={e => setBashDenyInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addBashDenyEntry(); }}
              placeholder="e.g. wget, nc, ncat"
              style={{
                flex: 1,
                padding: '4px 8px',
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '4px',
                color: 'var(--color-text-primary)',
                fontSize: '12px',
              }}
            />
            <button
              onClick={addBashDenyEntry}
              disabled={!bashDenyInput.trim()}
              style={{
                padding: '4px 12px',
                background: 'var(--color-accent, #3b82f6)',
                border: 'none',
                borderRadius: '4px',
                color: '#fff',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: bashDenyInput.trim() ? 1 : 0.5,
              }}
            >
              Add
            </button>
          </div>

          {bashDeniedCommands.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {bashDeniedCommands.map(cmd => (
                <span
                  key={cmd}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    background: 'rgba(239,68,68,0.15)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: '3px',
                    fontSize: '11px',
                    color: 'var(--color-text-secondary)',
                    fontFamily: 'monospace',
                  }}
                >
                  {cmd}
                  <button
                    onClick={() => removeBashDenyEntry(cmd)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'rgba(239,68,68,0.7)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '14px',
                      lineHeight: 1,
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {bashDeniedCommands.length === 0 && (
            <p style={{ margin: 0, fontSize: '11px', color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
              No custom deny entries — using built-in deny list only
            </p>
          )}
        </div>
      </section>
      )}

      {/* AI Overlord Settings */}
      <section className="ai-section">
        <div className="ai-section-header">
          <div className="ai-section-icon">{Icons.activity}</div>
          <h3>AI Overlord</h3>
        </div>
        <p className="ai-description">
          Configure which AI provider and model to use for Overlord terminal analysis.
          Overlord watches your terminal output and flags issues like BGP state problems, interface errors, and security concerns.
        </p>
        <div className="ai-automation-feature" style={{ marginTop: '8px' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '4px', display: 'block' }}>Provider</label>
              <select
                className="form-input"
                value={settings['ai.overlord.provider'] || ''}
                onChange={(e) => updateSetting('ai.overlord.provider', (e.target.value || null) as AiProviderType | null)}
              >
                <option value="">Use Default Provider</option>
                {PROVIDERS.filter(p => settings['ai.enabledProviders']?.includes(p.type as AiProviderType)).map(p => (
                  <option key={p.type} value={p.type}>{p.name}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '4px', display: 'block' }}>Model</label>
              <input
                type="text"
                className="form-input"
                value={settings['ai.overlord.model'] || ''}
                onChange={(e) => updateSetting('ai.overlord.model', e.target.value || null)}
                placeholder="Use default model"
              />
              <span className="form-hint">e.g., claude-sonnet-4-20250514 for better analysis quality</span>
            </div>
          </div>
        </div>
      </section>

      {/* MCP Servers Section — Personal Mode only; admin-managed in Enterprise mode */}
      {hasAiTools && !isEnterprise && <McpServersSection />}

      {/* AI Memory Section */}
      <section className="ai-section">
        <div className="ai-section-header">
          <div className="ai-section-icon">{Icons.brain}</div>
          <h3>AI Memory</h3>
        </div>
        <AIMemoryTab />
      </section>

      {/* AI Data Security Section */}
      <section className="ai-section">
        <div className="ai-section-header">
          <div className="ai-section-icon">{Icons.shield}</div>
          <h3>AI Data Security</h3>
        </div>
        <p className="ai-description">
          Automatically scrub credentials, secrets, and network identifiers from data before it reaches external AI providers.
          19 mandatory credential patterns are always active.
        </p>

        {sanitizationLoading ? (
          <div className="ai-loading">Loading sanitization settings...</div>
        ) : (
          <div className="sanitization-settings">
            {/* Mandatory Patterns (collapsible info) */}
            <div className="sanitization-group">
              <button
                className="sanitization-group-header"
                onClick={() => setMandatoryPatternsExpanded(!mandatoryPatternsExpanded)}
              >
                <span className={`chevron ${mandatoryPatternsExpanded ? 'expanded' : ''}`}>
                  {Icons.arrowDown}
                </span>
                <span>Mandatory Patterns (19 always active)</span>
              </button>
              {mandatoryPatternsExpanded && (
                <div className="sanitization-mandatory-list">
                  {[
                    'Cisco enable secret/password', 'Cisco password 7', 'Cisco password 0',
                    'SNMP community strings', 'SNMPv3 auth/priv keys', 'TACACS keys', 'RADIUS keys',
                    'Juniper secrets ($9$)', 'Juniper encrypted passwords', 'Arista secrets',
                    'Palo Alto passwords', 'Palo Alto keys', 'Private key blocks', 'Certificate blocks',
                    'Generic API keys/tokens', 'AWS access keys', 'AWS secret keys',
                    'Generic passwords', 'Generic secrets/shared keys',
                  ].map((name, i) => (
                    <div key={i} className="sanitization-mandatory-item">
                      <span className="sanitization-mandatory-badge">{i + 1}</span>
                      <span>{name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Optional Redaction Toggles */}
            <div className="sanitization-group">
              <div className="sanitization-group-label">Optional Redaction</div>
              {([
                { key: 'redact_ip_addresses' as const, label: 'IPv4 Addresses', desc: '10.0.0.1, 192.168.1.0/24' },
                { key: 'redact_ipv6_addresses' as const, label: 'IPv6 Addresses', desc: 'fe80::1, 2001:db8::1' },
                { key: 'redact_mac_addresses' as const, label: 'MAC Addresses', desc: '00:1a:2b:3c:4d:5e' },
                { key: 'redact_hostnames' as const, label: 'Hostnames/FQDNs', desc: 'router1.corp.example.com' },
                { key: 'redact_usernames' as const, label: 'Usernames', desc: 'username admin' },
              ]).map(({ key, label, desc }) => (
                <label key={key} className="sanitization-toggle-row">
                  <div className="sanitization-toggle-info">
                    <span className="sanitization-toggle-label">{label}</span>
                    <span className="sanitization-toggle-desc">{desc}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={sanitizationConfig[key] as boolean}
                    onChange={(e) => handleToggleSanitization(key, e.target.checked)}
                  />
                  <span className="toggle-slider small" />
                </label>
              ))}
            </div>

            {/* Custom Patterns */}
            <div className="sanitization-group">
              <div className="sanitization-group-label">Custom Patterns</div>
              {sanitizationConfig.custom_patterns.length > 0 && (
                <div className="sanitization-custom-list">
                  {sanitizationConfig.custom_patterns.map((p, i) => (
                    <div key={i} className="sanitization-custom-item">
                      <div className="sanitization-custom-info">
                        <span className="sanitization-custom-name">{p.name}</span>
                        <code className="sanitization-custom-regex">{p.regex}</code>
                        <span className="sanitization-custom-arrow">&rarr;</span>
                        <code className="sanitization-custom-replacement">{p.replacement}</code>
                      </div>
                      <button
                        className="sanitization-remove-btn"
                        onClick={() => handleRemoveCustomPattern(i)}
                        title="Remove pattern"
                      >
                        {Icons.trash}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="sanitization-add-pattern">
                <input
                  type="text"
                  placeholder="Name"
                  value={newPattern.name}
                  onChange={(e) => setNewPattern(p => ({ ...p, name: e.target.value }))}
                  className="sanitization-input sanitization-input-name"
                />
                <input
                  type="text"
                  placeholder="Regex"
                  value={newPattern.regex}
                  onChange={(e) => setNewPattern(p => ({ ...p, regex: e.target.value }))}
                  className="sanitization-input sanitization-input-regex"
                />
                <input
                  type="text"
                  placeholder="Replacement"
                  value={newPattern.replacement}
                  onChange={(e) => setNewPattern(p => ({ ...p, replacement: e.target.value }))}
                  className="sanitization-input sanitization-input-replacement"
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleAddCustomPattern}
                  disabled={!newPattern.name || !newPattern.regex || !newPattern.replacement}
                >
                  Add
                </button>
              </div>
            </div>

            {/* Allowlist */}
            <div className="sanitization-group">
              <div className="sanitization-group-label">Allowlist</div>
              <p className="sanitization-group-desc">Strings that should never be redacted (case-insensitive match).</p>
              {sanitizationConfig.allowlist.length > 0 && (
                <div className="sanitization-allowlist">
                  {sanitizationConfig.allowlist.map((item, i) => (
                    <span key={i} className="sanitization-allowlist-tag">
                      {item}
                      <button onClick={() => handleRemoveAllowlistItem(i)} title="Remove">&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="sanitization-add-allowlist">
                <input
                  type="text"
                  placeholder="Add allowlist entry..."
                  value={newAllowlistItem}
                  onChange={(e) => setNewAllowlistItem(e.target.value)}
                  className="sanitization-input"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddAllowlistItem();
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleAddAllowlistItem}
                  disabled={!newAllowlistItem.trim()}
                >
                  Add
                </button>
              </div>
            </div>

            {/* Test Panel */}
            <div className="sanitization-group">
              <div className="sanitization-group-label">Test Sanitization</div>
              <textarea
                className="sanitization-test-input"
                placeholder="Paste text to test sanitization (e.g. enable secret 5 $1$abc$xyz)"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                rows={4}
              />
              <button
                className="btn btn-sm btn-primary sanitization-test-btn"
                onClick={handleTestSanitization}
                disabled={testRunning || !testInput.trim()}
              >
                {testRunning ? 'Testing...' : 'Test'}
              </button>
              {testResult && (
                <div className="sanitization-test-result">
                  <div className="sanitization-test-stats">
                    <span className="sanitization-test-count">{testResult.redaction_count} redaction{testResult.redaction_count !== 1 ? 's' : ''}</span>
                    {testResult.pattern_names.length > 0 && (
                      <span className="sanitization-test-patterns">
                        Matched: {testResult.pattern_names.join(', ')}
                      </span>
                    )}
                  </div>
                  <pre className="sanitization-test-output">{testResult.sanitized}</pre>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
