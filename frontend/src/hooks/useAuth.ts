import { useAuthStore } from '../stores/authStore';
import { useMode } from './useMode';
import type { User } from '../types/auth';

interface AuthInfo {
  /** Current user (null if not authenticated) */
  user: User | null;
  /** True if user is authenticated */
  isAuthenticated: boolean;
  /** True if auth check/login is in progress */
  isLoading: boolean;
  /** Error message from last auth operation */
  error: string | null;
  /** True if auth is required (Enterprise mode) */
  requiresAuth: boolean;
  /** Log in with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Log out */
  logout: () => Promise<void>;
  /** Clear error message */
  clearError: () => void;
}

/**
 * Hook for accessing auth state and actions.
 * Combines auth store with mode detection.
 *
 * @example
 * const { isAuthenticated, user, login, logout } = useAuth();
 */
export function useAuth(): AuthInfo {
  const { isEnterprise } = useMode();
  const user = useAuthStore(state => state.user);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const isLoading = useAuthStore(state => state.isLoading);
  const error = useAuthStore(state => state.error);
  const login = useAuthStore(state => state.login);
  const logout = useAuthStore(state => state.logout);
  const clearError = useAuthStore(state => state.clearError);

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    requiresAuth: isEnterprise,
    login,
    logout,
    clearError,
  };
}
