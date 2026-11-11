import { useCallback, useEffect, useRef, useState } from 'react'
import { confirmDialog } from '../components/ConfirmDialog'

/**
 * Track whether a form has unsaved changes and gate close paths on a
 * confirmation when it does.
 *
 * Six of the largest multi-tab editor dialogs (Profile, Session, NetBox
 * Source, ScheduleTask, AgentDefinition, DeviceEdit) silently discarded
 * typed credentials and JSON on a stray Escape / X / overlay click. This
 * hook centralizes the "are you sure?" prompt so each dialog only has to
 * wire one call.
 *
 * Usage:
 *   const initial = useMemo(() => ({ name, host, port, ... }), [openedFor])
 *   const current = { name, host, port, ... }
 *   const { isDirty, confirmDiscard } = useDirtyGuard(current, { initial })
 *
 *   const handleClose = async () => {
 *     if (await confirmDiscard()) onClose()
 *   }
 *
 * `resetKey` causes the hook to re-snapshot the initial value — e.g. when
 * the dialog opens for a different record. Pass the record's id (or null
 * when not editing) so re-opens compare against the freshly-loaded data.
 */
export interface UseDirtyGuardOptions<T> {
  /** The initial value to compare against. If omitted, the first
   *  `current` the hook sees is captured. */
  initial?: T
  /** Re-snapshot the initial value when this changes. Typical use: pass
   *  the edited record's id, or a bumped counter on "open". */
  resetKey?: string | number | null
  /** Override the default confirm prompt text. */
  promptTitle?: string
  promptBody?: string
}

export interface UseDirtyGuardReturn {
  /** True when the current value differs from the captured initial. */
  isDirty: boolean
  /** Resolves true if the caller may proceed with close, false otherwise.
   *  Skips the prompt when not dirty. */
  confirmDiscard: () => Promise<boolean>
  /** Force-reset the initial snapshot to the current value. Useful right
   *  after a successful save so a follow-up close doesn't re-prompt. */
  reset: () => void
}

function stableStringify(value: unknown): string {
  // JSON.stringify with sorted keys so { a:1, b:2 } and { b:2, a:1 }
  // hash the same. Form shapes are flat enough that this is plenty.
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) {
        out[k] = (v as Record<string, unknown>)[k]
      }
      return out
    }
    return v
  })
}

export function useDirtyGuard<T>(
  current: T,
  options: UseDirtyGuardOptions<T> = {},
): UseDirtyGuardReturn {
  const { initial, resetKey, promptTitle, promptBody } = options

  // Snapshot of the initial value (frozen, not React state, so it
  // doesn't trigger re-renders by itself).
  const initialRef = useRef<string | null>(null)
  if (initialRef.current === null) {
    initialRef.current = stableStringify(initial ?? current)
  }

  // Re-snapshot when resetKey changes. Capture by value so a parent
  // dialog opening for a different record gets a fresh baseline.
  useEffect(() => {
    initialRef.current = stableStringify(initial ?? current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const [, force] = useState(0)
  const currentHash = stableStringify(current)
  const isDirty = currentHash !== initialRef.current

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true
    return confirmDialog({
      title: promptTitle ?? 'Discard unsaved changes?',
      body:
        promptBody ??
        'You have unsaved edits in this dialog. Close anyway and lose them?',
      confirmLabel: 'Discard',
      destructive: true,
    })
  }, [isDirty, promptTitle, promptBody])

  const reset = useCallback(() => {
    initialRef.current = currentHash
    force((n) => n + 1)
  }, [currentHash])

  return { isDirty, confirmDiscard, reset }
}
