/**
 * CommandRegistry public surface — import from here, not from the
 * individual modules. That keeps callers insulated from internal
 * reorganisation.
 *
 *   import { useCommand, dispatchCommand, getActiveContext } from '../commands'
 */

export type {
  ActiveContext,
  Command,
  CommandCategory,
  WhenPredicate,
} from './types'

export { useCommandStore, dispatchCommand } from './registry'
export {
  useActiveContextStore,
  getActiveContext,
} from './activeContext'
export { useCommand } from './useCommand'
