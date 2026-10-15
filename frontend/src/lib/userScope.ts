// Whose per-user browser state is in play. Standalone has one user, so its
// localStorage keys are used as-is. In enterprise several users can share one
// browser profile (the Controller's /terminal/ web client) or one desktop
// install, so per-user state (settings cache, open tabs) is keyed by the
// Controller URL and the signed-in user — and there is none until the user
// is known (lib/userPreferences sets the scope after login).
import { create } from 'zustand'
import { getCurrentMode } from '../api/client'

interface UserScopeState {
  /** `<controllerUrl>|<userId>` while an enterprise user is signed in */
  scope: string | null
}

export const useUserScopeStore = create<UserScopeState>(() => ({ scope: null }))

export function setUserScope(controllerUrl: string, userId: string): void {
  useUserScopeStore.setState({ scope: `${controllerUrl}|${userId}` })
}

export function clearUserScope(): void {
  useUserScopeStore.setState({ scope: null })
}

/**
 * localStorage key for per-user state: `base` in standalone; in enterprise
 * `base` scoped to the Controller and user, or null while no user is signed
 * in (nothing per-user may be read or written then).
 */
export function userScopedKey(base: string): string | null {
  if (getCurrentMode() !== 'enterprise') return base
  const { scope } = useUserScopeStore.getState()
  return scope ? `${base}@${scope}` : null
}
