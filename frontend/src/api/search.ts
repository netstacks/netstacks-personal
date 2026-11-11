import { getClient } from './client'

export type SearchHitType =
  | 'session' | 'topology' | 'device' | 'mop'
  | 'quick-action' | 'snippet' | 'doc' | 'script' | 'workspace'

export interface SearchHit {
  type: SearchHitType
  id: string
  title: string
  subtitle?: string
  score: number
}

/**
 * Global entity search. Returns [] for empty queries and degrades to []
 * on 404 (older agent/controller) or any error, so the Command Center
 * still shows commands.
 */
export async function searchEntities(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  if (!q.trim()) return []
  try {
    const { data } = await getClient().http.get('/search', {
      params: { q, limit: 30 },
      signal,
    })
    const results = (data?.results ?? []) as SearchHit[]
    return Array.isArray(results) ? results : []
  } catch {
    return []
  }
}
