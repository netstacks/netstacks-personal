/**
 * TokenUsageContext - Global token usage tracking across the platform
 *
 * Tracks AI token consumption by provider, persists to localStorage,
 * and provides a centralized way to monitor usage across all AI features.
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'

// Provider types (matches backend)
export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom'

// Token usage for a single request
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

// Cumulative usage per provider
export interface ProviderUsage {
  provider: AiProviderType
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requestCount: number
  lastUsed: string // ISO date
}

// Global usage state
export interface GlobalTokenUsage {
  providers: Record<AiProviderType, ProviderUsage>
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalRequests: number
  sessionStart: string // ISO date - when tracking started
}

// Context value type
interface TokenUsageContextValue {
  usage: GlobalTokenUsage
  trackUsage: (provider: AiProviderType, tokens: TokenUsage) => void
  resetProvider: (provider: AiProviderType) => void
  resetAll: () => void
  getProviderUsage: (provider: AiProviderType) => ProviderUsage
}

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
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(usage))
  } catch (err) {
    console.error('Failed to save token usage to localStorage:', err)
  }
}

// Create context
const TokenUsageContext = createContext<TokenUsageContextValue | null>(null)

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
      if (e.key !== STORAGE_KEY || e.newValue === null) return
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

// Hook to use token usage context
export function useTokenUsage(): TokenUsageContextValue {
  const context = useContext(TokenUsageContext)
  if (!context) {
    throw new Error('useTokenUsage must be used within a TokenUsageProvider')
  }
  return context
}

// Optional hook that returns null if not in provider (for optional tracking)
export function useTokenUsageOptional(): TokenUsageContextValue | null {
  return useContext(TokenUsageContext)
}
