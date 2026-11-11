import { useCallback, useRef, useState } from 'react'

/**
 * Tiny hook to guard async submit handlers against double-clicks.
 *
 * Pattern:
 *   const { submitting, run } = useSubmitting()
 *   const onSave = () => run(async () => { await save(...) })
 *   <button disabled={submitting} onClick={onSave}>
 *     {submitting ? 'Saving…' : 'Save'}
 *   </button>
 *
 * Why a ref + state: the `submitting` value captured in the closure of
 * `run` is stale across React batches, so a quick double-click can pass
 * both checks. The ref reads/writes are synchronous, so the second call
 * sees `true` immediately and bails.
 *
 * `run` returns the wrapped function's return value, or `undefined` if a
 * concurrent submit dropped the call.
 */
export function useSubmitting() {
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (submittingRef.current) return undefined
      submittingRef.current = true
      setSubmitting(true)
      try {
        return await fn()
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [],
  )

  return { submitting, run }
}
