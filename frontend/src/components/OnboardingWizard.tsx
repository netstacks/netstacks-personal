/**
 * OnboardingWizard — first-run setup walkthrough.
 *
 * Steps: Welcome → AI setup (provider + key + test) → NetBox (optional) →
 * Concepts primer → Done. Each step has a contextual Ask-AI button (SP1). The
 * wizard is skippable and re-openable from the command palette. Finishing or
 * skipping sets `app.setupComplete`.
 */
import { useRef, useState } from 'react'
import { useModalKeyboard } from '../hooks/useModalKeyboard'
import { useSettings, type AiProviderType } from '../hooks/useSettings'
import { storeAiApiKey, setAiConfig, testAiConnection, listProviderModels, getAiProviderOverrides, setAiProviderOverrides } from '../api/ai'
import { MODEL_PLACEHOLDER } from '../lib/aiModelDefaults'
import { getErrorMessage } from '../api/errors'
import AskAiHelp from './AskAiHelp'
import './OnboardingWizard.css'

interface OnboardingWizardProps {
  isOpen: boolean
  /** Marks setup complete and closes. */
  onClose: () => void
  /** Open Settings → Integrations (for guided NetBox setup). */
  onOpenIntegrations: () => void
}

type StepId = 'welcome' | 'ai' | 'netbox' | 'concepts' | 'done'
const STEPS: StepId[] = ['welcome', 'ai', 'netbox', 'concepts', 'done']

const PROVIDER_KEY_URLS: Partial<Record<AiProviderType, string>> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
}

/** Providers that take an API key; for KEY_OPTIONAL ones it may be blank. */
const KEYED_PROVIDERS: AiProviderType[] = ['anthropic', 'openai', 'openrouter', 'litellm', 'custom']
const KEY_OPTIONAL: AiProviderType[] = ['litellm', 'custom']
/** Providers that talk to a self-hosted / arbitrary endpoint (NS-AI-35). */
const ENDPOINT_PROVIDERS: AiProviderType[] = ['ollama', 'litellm', 'custom']
const DEFAULT_BASE_URL: Partial<Record<AiProviderType, string>> = {
  ollama: 'http://localhost:11434',
  litellm: 'http://localhost:4000',
}

export default function OnboardingWizard({ isOpen, onClose, onOpenIntegrations }: OnboardingWizardProps) {
  const { settings, updateSetting } = useSettings()
  const containerRef = useRef<HTMLDivElement>(null)
  const [stepIdx, setStepIdx] = useState(0)
  const step = STEPS[stepIdx]

  // AI step state
  const [provider, setProvider] = useState<AiProviderType>((settings['ai.defaultProvider'] as AiProviderType) || 'anthropic')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState<string>((settings['ai.models.anthropic']?.[0]) || '')
  const [baseUrl, setBaseUrl] = useState('')
  const [liveModels, setLiveModels] = useState<string[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiResult, setAiResult] = useState<{ ok: boolean; msg: string } | null>(null)

  useModalKeyboard({
    isOpen,
    containerRef,
    onEscape: onClose, // Escape = skip; sets setupComplete so it won't nag, but is reopenable.
  })

  if (!isOpen) return null

  const next = () => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  const back = () => setStepIdx((i) => Math.max(i - 1, 0))

  const onProviderChange = (p: AiProviderType) => {
    setProvider(p)
    setAiResult(null)
    setBaseUrl('')
    setLiveModels([])
    setModel(settings[`ai.models.${p}` as keyof typeof settings] as string[] | undefined ? (settings[`ai.models.${p}` as keyof typeof settings] as string[])[0] || '' : '')
  }

  const saveAndTestAi = async () => {
    setAiBusy(true)
    setAiResult(null)
    try {
      const needsKey = KEYED_PROVIDERS.includes(provider)
      const url = baseUrl.trim() || DEFAULT_BASE_URL[provider] || ''
      if (provider === 'custom' && !url) {
        setAiResult({ ok: false, msg: 'A Custom provider needs a Base URL (the OpenAI-compatible endpoint).' })
        return
      }
      if (needsKey && apiKey.trim()) {
        await storeAiApiKey(provider, apiKey.trim())
        setApiKey('')
      }
      // Remember the endpoint for this provider so Settings → AI and the side
      // panel see the same URL (RC-8 overrides map).
      if (url) {
        const overrides = (await getAiProviderOverrides()) || {}
        await setAiProviderOverrides({ ...overrides, base_urls: { ...(overrides.base_urls || {}), [provider]: url } })
      }
      // A model is required for every provider. If the user left it blank,
      // ask the provider for its model list and take the first one (NS-SET-9).
      let chosen = model.trim()
      if (!chosen) {
        const res = await listProviderModels(provider, url ? { baseUrl: url, apiFormat: provider === 'custom' ? 'openai' : undefined } : undefined)
        const ids = res.models.map(m => m.id)
        setLiveModels(ids)
        chosen = ids[0] || ''
        if (!chosen) {
          setAiResult({ ok: false, msg: res.error ? `Enter a model name — could not list models: ${res.error}` : 'Enter a model name — this provider did not list any.' })
          return
        }
        setModel(chosen)
      }
      // Remember the model in the provider's model list so it's the default.
      const key = `ai.models.${provider}` as keyof typeof settings
      const existing = (settings[key] as string[] | undefined) || []
      if (!existing.includes(chosen)) updateSetting(key, [...existing, chosen])

      await setAiConfig({
        provider,
        model: chosen,
        ...(url ? { base_url: url } : {}),
        ...(provider === 'custom' ? { api_format: 'openai', auth_mode: 'api_key' } : {}),
      })
      // Make the side panel agree with the agent: enable the provider and make
      // it the default (NS-AI-34) — otherwise the panel keeps asking Anthropic.
      const enabled = settings['ai.enabledProviders'] || ['anthropic']
      if (!enabled.includes(provider)) updateSetting('ai.enabledProviders', [...enabled, provider])
      updateSetting('ai.defaultProvider', provider)

      const result = await testAiConnection(provider, chosen)
      setAiResult({ ok: result.success, msg: result.message || (result.success ? 'Connected!' : 'Connection failed') })
    } catch (err) {
      setAiResult({ ok: false, msg: getErrorMessage(err, 'Failed to save AI settings') })
    } finally {
      setAiBusy(false)
    }
  }

  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return (
          <div className="ow-body">
            <h2>Welcome to NetStacks 👋</h2>
            <p>Let's get you set up in a couple of minutes. We'll configure the AI assistant,
              optionally connect NetBox, and cover a few core concepts.</p>
            <p className="ow-muted">You can skip any step and change everything later in Settings.
              The ✨ Ask AI buttons throughout Settings can help whenever you're stuck.</p>
          </div>
        )
      case 'ai': {
        const keyUrl = PROVIDER_KEY_URLS[provider]
        const needsKey = KEYED_PROVIDERS.includes(provider)
        return (
          <div className="ow-body">
            <div className="ow-step-head">
              <h2>Set up the AI assistant</h2>
              <AskAiHelp prompt={`How do I get an API key for the ${provider} provider and set it up in NetStacks?`} />
            </div>
            <label className="ow-field">
              <span>Provider</span>
              <select value={provider} onChange={(e) => onProviderChange(e.target.value as AiProviderType)}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama (local)</option>
                <option value="litellm">LiteLLM</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {keyUrl && (
              <p className="ow-muted">
                Need a key? <a href={keyUrl} target="_blank" rel="noreferrer">Get one from {provider} ↗</a>
              </p>
            )}
            {provider === 'ollama' && (
              <p className="ow-muted">
                No key needed. Don't have Ollama yet? <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Download it ↗</a>
              </p>
            )}
            {needsKey && (
              <label className="ow-field">
                <span>API key{KEY_OPTIONAL.includes(provider) ? ' (optional)' : ''}</span>
                <input type="password" value={apiKey} placeholder="Paste your API key" onChange={(e) => setApiKey(e.target.value)} />
              </label>
            )}
            {ENDPOINT_PROVIDERS.includes(provider) && (
              <label className="ow-field">
                <span>Base URL{provider === 'custom' ? '' : ' (optional)'}</span>
                <input
                  type="text"
                  value={baseUrl}
                  placeholder={DEFAULT_BASE_URL[provider] || 'https://llm.example.com/v1 (OpenAI-compatible)'}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </label>
            )}
            <label className="ow-field">
              <span>Model</span>
              <input
                type="text"
                value={model}
                list="ow-model-list"
                placeholder={MODEL_PLACEHOLDER[provider]}
                onChange={(e) => setModel(e.target.value)}
              />
              {liveModels.length > 0 && (
                <datalist id="ow-model-list">
                  {liveModels.map(m => <option key={m} value={m} />)}
                </datalist>
              )}
            </label>
            <p className="ow-muted">Leave the model blank to use the first one the provider lists.</p>
            <div className="ow-inline">
              <button className="ow-btn" onClick={saveAndTestAi} disabled={aiBusy}>
                {aiBusy ? 'Testing…' : 'Save & test'}
              </button>
              {aiResult && (
                <span className={aiResult.ok ? 'ow-ok' : 'ow-err'}>{aiResult.ok ? '✓ ' : '✕ '}{aiResult.msg}</span>
              )}
            </div>
            <p className="ow-muted">You can also configure this anytime in Settings → AI.</p>
          </div>
        )
      }
      case 'netbox':
        return (
          <div className="ow-body">
            <div className="ow-step-head">
              <h2>Connect NetBox (optional)</h2>
              <AskAiHelp prompt="Walk me through connecting NetBox to NetStacks: creating the API Resource (NetBox URL + API token), then a NetBox source, and what it gives me." />
            </div>
            <p>NetBox is your source of truth for device inventory. Connecting it imports your
              devices as ready-to-connect sessions. It's set up as an <strong>API Resource</strong>
              (NetBox URL + API token) wrapped by a NetBox <strong>integration</strong>.</p>
            <button className="ow-btn" onClick={onOpenIntegrations}>Open NetBox setup →</button>
            <p className="ow-muted">No NetBox? Skip this — you can add devices manually or import sessions later.</p>
          </div>
        )
      case 'concepts':
        return (
          <div className="ow-body">
            <div className="ow-step-head">
              <h2>A few concepts</h2>
              <AskAiHelp prompt="Explain how API Resources, Integrations, and Enrichment relate in NetStacks, and how I'd integrate an app that isn't a built-in integration." />
            </div>
            <ul className="ow-concepts">
              <li><strong>API Resource</strong> — a reusable external endpoint (URL + auth), credentials kept in the vault. The building block for everything external.</li>
              <li><strong>Integrations</strong> — NetBox, LibreNMS, and Crawler wrap an API Resource with extra smarts (import, typed lookups).</li>
              <li><strong>Crawler = Netdisco</strong> — the Crawler integration is just NetStacks' UI over a Netdisco instance.</li>
              <li><strong>Enrichment</strong> — hover lookups on terminal tokens; <em>token matchers</em> decide which lookups run. Any API Resource can power one.</li>
              <li><strong>Not a built-in integration?</strong> Create an API Resource for any REST app and use it via Quick Calls, Enrichment, or MOP steps.</li>
            </ul>
            <p className="ow-muted">Full how-tos live in the docs. Or just ask the AI — it knows these.</p>
          </div>
        )
      case 'done':
        return (
          <div className="ow-body">
            <h2>You're all set 🎉</h2>
            <p>A couple of things to remember:</p>
            <ul className="ow-concepts">
              <li>The ✨ <strong>Ask AI</strong> buttons are throughout Settings for anything confusing.</li>
              <li>Reopen this wizard anytime from the command palette → "Setup Wizard".</li>
            </ul>
          </div>
        )
    }
  }

  const isLast = stepIdx === STEPS.length - 1

  return (
    <div className="ow-overlay">
      <div className="ow-dialog" ref={containerRef} role="dialog" aria-modal="true">
        <div className="ow-progress">
          {STEPS.map((s, i) => (
            <span key={s} className={`ow-dot ${i === stepIdx ? 'active' : ''} ${i < stepIdx ? 'done' : ''}`} />
          ))}
        </div>

        {renderStep()}

        <div className="ow-footer">
          <button className="ow-btn ghost" onClick={onClose}>{isLast ? 'Close' : 'Skip setup'}</button>
          <div className="ow-inline">
            {stepIdx > 0 && !isLast && <button className="ow-btn ghost" onClick={back}>Back</button>}
            {isLast
              ? <button className="ow-btn primary" onClick={onClose}>Finish</button>
              : <button className="ow-btn primary" onClick={next}>Next</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
