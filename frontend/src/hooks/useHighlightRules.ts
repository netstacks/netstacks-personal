import { getErrorMessage } from '../api/errors'
/**
 * Hook for managing highlight rules with caching and live updates
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { HighlightRule } from '../api/highlightRules'
import { getEffectiveHighlightRules, listHighlightRules } from '../api/highlightRules'

interface UseHighlightRulesOptions {
  /** Session ID for session-specific rules (undefined = global only) */
  sessionId?: string
  /** Auto-fetch rules on mount (default: true) */
  autoFetch?: boolean
  /** Cache duration in milliseconds (default: 30000) */
  cacheDurationMs?: number
}

interface UseHighlightRulesResult {
  /** Current highlight rules */
  rules: HighlightRule[]
  /** Loading state */
  isLoading: boolean
  /** Error message if fetch failed */
  error: string | null
  /** Manually refetch rules */
  refetch: () => Promise<void>
  /** Clear cached rules */
  clearCache: () => void
}

// Simple in-memory cache for rules
interface RulesCache {
  rules: HighlightRule[]
  timestamp: number
  sessionId: string | undefined
}

const rulesCache = new Map<string, RulesCache>()

function getCacheKey(sessionId: string | undefined): string {
  return sessionId || '__global__'
}

/**
 * Hook to fetch and cache highlight rules
 * Supports session-specific rules with automatic caching
 */
export function useHighlightRules(
  options: UseHighlightRulesOptions = {}
): UseHighlightRulesResult {
  const {
    sessionId,
    autoFetch = true,
    cacheDurationMs = 30000,
  } = options

  const [rules, setRules] = useState<HighlightRule[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track current sessionId to detect changes
  const sessionIdRef = useRef(sessionId)

  const fetchRules = useCallback(async () => {
    const cacheKey = getCacheKey(sessionId)

    // Check cache first
    const cached = rulesCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < cacheDurationMs) {
      setRules(cached.rules)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      let fetchedRules: HighlightRule[]

      if (sessionId) {
        // Get effective rules for session (merged global + session-specific)
        fetchedRules = await getEffectiveHighlightRules(sessionId)
      } else {
        // Get global rules only
        const allRules = await listHighlightRules()
        fetchedRules = allRules.filter(r => r.session_id === null)
      }

      // Filter to enabled rules and sort by priority
      fetchedRules = fetchedRules
        .filter(r => r.enabled)
        .sort((a, b) => a.priority - b.priority)

      // Update cache
      rulesCache.set(cacheKey, {
        rules: fetchedRules,
        timestamp: Date.now(),
        sessionId,
      })

      setRules(fetchedRules)
    } catch (err) {
      console.error('Failed to fetch highlight rules:', err)
      setError(getErrorMessage(err, 'Failed to fetch rules'))
    } finally {
      setIsLoading(false)
    }
  }, [sessionId, cacheDurationMs])

  const clearCache = useCallback(() => {
    const cacheKey = getCacheKey(sessionId)
    rulesCache.delete(cacheKey)
  }, [sessionId])

  // Fetch on mount and when sessionId changes
  useEffect(() => {
    if (autoFetch) {
      // If sessionId changed, clear old cache first
      if (sessionIdRef.current !== sessionId) {
        clearCache()
        sessionIdRef.current = sessionId
      }
      fetchRules()
    }
  }, [autoFetch, sessionId, fetchRules, clearCache])

  return {
    rules,
    isLoading,
    error,
    refetch: fetchRules,
    clearCache,
  }
}

/**
 * Invalidate all cached rules (call after rule changes)
 */
export function invalidateRulesCache(): void {
  rulesCache.clear()
}

/**
 * Invalidate cache for a specific session
 */
export function invalidateSessionRulesCache(sessionId: string | undefined): void {
  const cacheKey = getCacheKey(sessionId)
  rulesCache.delete(cacheKey)
  // Also invalidate global cache since it might affect effective rules
  if (sessionId) {
    rulesCache.delete('__global__')
  }
}
