/**
 * TokenUsageContext - Global token usage tracking across the platform
 *
 * Tracks AI token consumption by provider and persists it to localStorage.
 *
 * Coverage: the agent chat loops (side panel, chat tabs, floating chat and
 * inline popup — streaming and non-streaming), including requests on the
 * default-provider path, which are attributed to the default provider
 * (resolveUsageProvider). Simple `/ai/chat` helpers (command suggestions,
 * next-step suggestions, highlighting) and background tasks are NOT counted:
 * those backend endpoints don't return usage.
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { userScopedKey } from '../lib/userScope'
import {
  TokenUsageContext,
  type AiProviderType,
  type GlobalTokenUsage,
  type ProviderUsage,
  type TokenUsage,
} from './tokenUsageStore'

export type { AiProviderType, GlobalTokenUsage, ProviderUsage, TokenUsage, TokenUsageContextValue } from './tokenUsageStore'

// Per user in enterprise (lib/userScope). The provider mounts with the
// signed-in user (see AppShell), so it reads and writes that user's copy.
const STORAGE_KEY = 'netstacks_token_usage'

// Create empty provider usage
const createEmptyProviderUsage = (provider: AiProviderType): ProviderUsage => ({
  provider,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requestCount: 0,
  lastUsed: new Date().toISOString(),
})

// Create initial global usage state
const createInitialUsage = (): GlobalTokenUsage => ({
  providers: {
    anthropic: createEmptyProviderUsage('anthropic'),
    openai: createEmptyProviderUsage('openai'),
    ollama: createEmptyProviderUsage('ollama'),
    openrouter: createEmptyProviderUsage('openrouter'),
    litellm: createEmptyProviderUsage('litellm'),
    custom: createEmptyProviderUsage('custom'),
  },
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  totalRequests: 0,
  sessionStart: new Date().toISOString(),
})

// Load usage from localStorage
const loadUsage = (): GlobalTokenUsage => {
  const key = userScopedKey(STORAGE_KEY)
  if (!key) return createInitialUsage()
  try {
    const stored = localStorage.getItem(key)
    if (stored) {
      const parsed = JSON.parse(stored) as GlobalTokenUsage
      // Ensure all providers exist (in case new providers added)
      const providers = { ...createInitialUsage().providers }
      for (const key of Object.keys(parsed.providers || {})) {
        if (key in providers) {
          providers[key as AiProviderType] = parsed.providers[key as AiProviderType]
        }
      }
      return {
        ...parsed,
        providers,
      }
    }
  } catch (err) {
    console.error('Failed to load token usage from localStorage:', err)
  }
  return createInitialUsage()
}

// Save usage to localStorage
const saveUsage = (usage: GlobalTokenUsage): void => {
  const key = userScopedKey(STORAGE_KEY)
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(usage))
  } catch (err) {
    console.error('Failed to save token usage to localStorage:', err)
  }
}

// Provider component
export function TokenUsageProvider({ children }: { children: ReactNode }) {
  const [usage, setUsage] = useState<GlobalTokenUsage>(loadUsage)

  // Save to localStorage whenever usage changes. A short-lived ref
  // suppresses the next storage-event echo from THIS window (we don't
  // want to clobber the same value we just wrote).
  const suppressNextStorageEvent = useRef(false)
  useEffect(() => {
    suppressNextStorageEvent.current = true
    saveUsage(usage)
  }, [usage])

  // Cross-window sync — popouts share the same WebView origin so they
  // also share localStorage. Without this, two windows could each
  // track tokens, race on save, and double-count or lose increments.
  // Storage event fires in every OTHER window when one writes.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === null || e.key !== userScopedKey(STORAGE_KEY) || e.newValue === null) return
      try {
        const parsed = JSON.parse(e.newValue) as GlobalTokenUsage
        suppressNextStorageEvent.current = true
        setUsage(parsed)
      } catch {
        /* corrupt incoming value — ignore */
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // Track new token usage
  const trackUsage = useCallback((provider: AiProviderType, tokens: TokenUsage) => {
    setUsage(prev => {
      const providerUsage = prev.providers[provider]
      const updatedProvider: ProviderUsage = {
        ...providerUsage,
        inputTokens: providerUsage.inputTokens + tokens.inputTokens,
        outputTokens: providerUsage.outputTokens + tokens.outputTokens,
        totalTokens: providerUsage.totalTokens + tokens.totalTokens,
        requestCount: providerUsage.requestCount + 1,
        lastUsed: new Date().toISOString(),
      }

      return {
        ...prev,
        providers: {
          ...prev.providers,
          [provider]: updatedProvider,
        },
        totalInputTokens: prev.totalInputTokens + tokens.inputTokens,
        totalOutputTokens: prev.totalOutputTokens + tokens.outputTokens,
        totalTokens: prev.totalTokens + tokens.totalTokens,
        totalRequests: prev.totalRequests + 1,
      }
    })
  }, [])

  // Reset a specific provider's usage
  const resetProvider = useCallback((provider: AiProviderType) => {
    setUsage(prev => {
      const providerUsage = prev.providers[provider]
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [provider]: createEmptyProviderUsage(provider),
        },
        totalInputTokens: prev.totalInputTokens - providerUsage.inputTokens,
        totalOutputTokens: prev.totalOutputTokens - providerUsage.outputTokens,
        totalTokens: prev.totalTokens - providerUsage.totalTokens,
        totalRequests: prev.totalRequests - providerUsage.requestCount,
      }
    })
  }, [])

  // Reset all usage
  const resetAll = useCallback(() => {
    setUsage(createInitialUsage())
  }, [])

  // Get usage for a specific provider
  const getProviderUsage = useCallback((provider: AiProviderType): ProviderUsage => {
    return usage.providers[provider]
  }, [usage])

  return (
    <TokenUsageContext.Provider value={{ usage, trackUsage, resetProvider, resetAll, getProviderUsage }}>
      {children}
    </TokenUsageContext.Provider>
  )
}
