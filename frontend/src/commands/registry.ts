import { getErrorMessage } from '../api/errors'
/**
 * CommandRegistry — central, observable store of every registered
 * Command. Designed to live for the entire app lifetime.
 *
 * Architecture
 * ------------
 * Why Zustand instead of a plain Map + EventEmitter:
 *   - React surfaces (menu, palette, context menus) need to re-render
 *     when commands register/unregister; Zustand gives us that for
 *     free with useStore selectors.
 *   - Non-React callers (the Tauri menu-event listener, future RPC)
 *     can read via getState() without becoming a hook.
 *   - subscribeWithSelector lets the native-menu enabled-state bridge
 *     watch the ActiveContext slice only, so re-evaluating `when`
 *     predicates doesn't trigger React re-renders for unaffected
 *     surfaces.
 *
 * Stability contract
 * ------------------
 *   - register() with a duplicate id is a programming error in dev
 *     (logs a warning) and a silent override in prod — the new entry
 *     wins. This favours not crashing the app over strict purity.
 *   - dispatch() of an unknown id is a no-op + warn. Useful when a
 *     surface was built against an older registry snapshot.
 *   - `when` is evaluated lazily on dispatch + on every menu rebuild.
 *     A registered command with a failing `when` predicate at dispatch
 *     time is silently no-op'd; the surface that requested it should
 *     have disabled itself first.
 *
 * Lifecycle
 * ---------
 * Surfaces register on mount via useCommand() and unregister on
 * unmount. The registry never garbage-collects on its own.
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ActiveContext, Command } from './types'

interface CommandStore {
  /** Map of id → Command. Source of truth for everything below. */
  commands: Map<string, Command>

  /** Register a command. Returns the unregister function for symmetry
   *  with addEventListener. Calling register again with the same id
   *  replaces the existing entry. */
  register: (cmd: Command) => () => void

  /** Remove a command by id. Safe to call with an unknown id. */
  unregister: (id: string) => void

  /** Look up a command by id. Returns undefined if not registered. */
  get: (id: string) => Command | undefined

  /** All registered commands as a flat array (snapshot — don't mutate). */
  list: () => Command[]

  /** Commands whose `when` predicate passes against the given context.
   *  Commands without a `when` always pass. Returns a new array. */
  listAvailable: (ctx: ActiveContext) => Command[]
}

const debug = (...args: unknown[]) => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn('[CommandRegistry]', ...args)
  }
}

// Token-scoped registration: each register() generates a unique symbol
// for the {id, cmd} pair. The unregister returned to the caller closes
// over that token and ONLY removes if the current registered entry is
// still owned by it. Without this, dev-time duplicate-id sequences
// (A registers → B overrides → A unmounts) had A's cleanup delete B's
// active registration and silently leave the registry empty.
const activeTokens = new Map<string, symbol>()

export const useCommandStore = create<CommandStore>()(
  subscribeWithSelector((set, get) => ({
    commands: new Map<string, Command>(),

    register: (cmd) => {
      // Treat dev-time duplicates as warnings; in prod just overwrite
      // silently (favour not crashing on hot-reload edge cases).
      const existing = get().commands.get(cmd.id)
      if (existing) {
        debug(`Duplicate command id '${cmd.id}' — overriding previous registration.`)
      }
      const token = Symbol(cmd.id)
      activeTokens.set(cmd.id, token)
      // Map mutation needs a fresh Map instance so Zustand notifies subscribers.
      set((state) => {
        const next = new Map(state.commands)
        next.set(cmd.id, cmd)
        return { commands: next }
      })
      // Token-scoped unregister: only delete if the current active
      // token still matches ours. If a later register() under the
      // same id replaced our entry, this is a no-op.
      return () => {
        if (activeTokens.get(cmd.id) !== token) return
        activeTokens.delete(cmd.id)
        set((state) => {
          if (!state.commands.has(cmd.id)) return state
          const next = new Map(state.commands)
          next.delete(cmd.id)
          return { commands: next }
        })
      }
    },

    unregister: (id) => {
      // Explicit, non-token-scoped removal — used by callers who
      // genuinely want the entry gone regardless of who owns it.
      activeTokens.delete(id)
      set((state) => {
        if (!state.commands.has(id)) return state
        const next = new Map(state.commands)
        next.delete(id)
        return { commands: next }
      })
    },

    get: (id) => get().commands.get(id),

    list: () => Array.from(get().commands.values()),

    listAvailable: (ctx) =>
      Array.from(get().commands.values()).filter(
        (c) => !c.when || c.when(ctx),
      ),
  })),
)

/**
 * Run a command by id. Resolves the registry entry, checks its `when`
 * gate against the supplied context, and invokes `run`. Errors thrown
 * from `run` are caught and forwarded to the toast surface — surfaces
 * that need bespoke error handling should call the Command's `run`
 * directly instead of going through dispatch.
 *
 * Non-React callers (Tauri menu-event listener) use this; React
 * components typically use the useCommand hook's returned `run`
 * function which calls through here.
 */
export async function dispatchCommand(
  id: string,
  ctx: ActiveContext,
): Promise<void> {
  const cmd = useCommandStore.getState().get(id)
  if (!cmd) {
    debug(`dispatch('${id}'): unknown command. Was it registered?`)
    return
  }
  if (cmd.when && !cmd.when(ctx)) {
    debug(`dispatch('${id}'): when-gate failed; ignoring.`)
    return
  }
  try {
    await cmd.run()
  } catch (err) {
    // Lazy import to break the dep cycle with the toast module — the
    // registry is intentionally framework-agnostic except for this one
    // user-facing failure path.
    import('../components/Toast').then(({ showToast }) => {
      showToast(
        `Command "${cmd.label}" failed: ${getErrorMessage(err, 'unknown error')}`,
        'error',
      )
    })
    debug(`dispatch('${id}') threw:`, err)
  }
}
