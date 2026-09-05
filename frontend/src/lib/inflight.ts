/**
 * Share one in-flight request between concurrent callers.
 *
 * Several components mount the same hooks at startup (the AI side panel,
 * floating chat and inline popup each run `useAIAgent`), so the same GET was
 * issued three or four times per app start. `shareInFlight(key, fn)` returns
 * the pending promise to every caller that asks while the first call is still
 * running; once it settles the next call starts a fresh request, so nothing
 * is ever served stale.
 */
const pending = new Map<string, Promise<unknown>>()

/** Wrap a zero-arg async function so concurrent callers share one in-flight request. */
export function sharedAsync<T>(key: string, fn: () => Promise<T>): () => Promise<T> {
  return () => shareInFlight(key, fn)
}

export function shareInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = pending.get(key)
  if (existing) return existing as Promise<T>
  const p = fn().finally(() => {
    if (pending.get(key) === p) pending.delete(key)
  })
  pending.set(key, p)
  return p
}
