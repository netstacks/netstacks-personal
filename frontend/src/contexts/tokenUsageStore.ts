/**
 * Token usage — the context object, hooks and pure helpers behind
 * TokenUsageProvider (contexts/TokenUsageContext.tsx). Kept in a non-component
 * module so the provider file only exports a component (fast refresh).
 */

import { createContext, useContext } from 'react'
import { getSettings } from '../hooks/useSettings'

// Provider types (matches backend)
export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'litellm' | 'custom'

const PROVIDER_TYPES: readonly AiProviderType[] = ['anthropic', 'openai', 'ollama', 'openrouter', 'litellm', 'custom']

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
export interface TokenUsageContextValue {
  usage: GlobalTokenUsage
  trackUsage: (provider: AiProviderType, tokens: TokenUsage) => void
  resetProvider: (provider: AiProviderType) => void
  resetAll: () => void
  getProviderUsage: (provider: AiProviderType) => ProviderUsage
}

export const TokenUsageContext = createContext<TokenUsageContextValue | null>(null)

function isProviderType(value: unknown): value is AiProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value)
}

/**
 * The provider a request's tokens are billed to. Callers on the default AI
 * path send no provider (lib/aiProviderResolver), so the backend uses the saved
 * default — attribute those to the default provider instead of dropping them.
 */
export function resolveUsageProvider(provider?: string | null): AiProviderType {
  if (isProviderType(provider)) return provider
  const fallback = getSettings()['ai.defaultProvider']
  return isProviderType(fallback) ? fallback : 'anthropic'
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
