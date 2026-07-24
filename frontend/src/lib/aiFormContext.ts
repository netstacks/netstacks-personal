import type { AiContext } from '../api/ai'

/**
 * Global provider for the current workspace's AI context.
 *
 * `AITabInput` (Tab-to-autofill) is a leaf used in ~16 places, so prop-drilling
 * the active session/device down to every call site is impractical. Instead,
 * `App` registers a provider here that returns a compact `AiContext` describing
 * *where the user is* (active tab/session name + device vendor/platform), and
 * `AITabInput` reads it at generate time. Mirrors the module-level
 * `getActiveContext()` pattern used by the command registry.
 */
let provider: (() => AiContext | undefined) | null = null

export function registerFormAiContext(fn: (() => AiContext | undefined) | null): void {
  provider = fn
}

/** Returns the current workspace AiContext, or undefined if none is registered. */
export function getFormAiContext(): AiContext | undefined {
  try {
    return provider?.()
  } catch {
    return undefined
  }
}
