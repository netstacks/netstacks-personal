import { create } from 'zustand';
import type { AuthState, User } from '../types/auth';
import * as authApi from '../api/auth';
import { setAuthStateGetter } from '../api/controllerClient';
import { getCurrentMode } from '../api/client';
import { useCapabilitiesStore } from './capabilitiesStore';

import { logger } from '../lib/logger'
import { getErrorMessage } from '../api/errors'
/**
 * Auth store for Enterprise mode authentication.
 * Manages JWT tokens, user info, and auth state.
 *
 * All tokens are kept in memory only — user must re-authenticate
 * when the application stops or reloads.
 */
export const useAuthStore = create<AuthState>()(
    (set, get) => ({
      // Initial state
      accessToken: null,
      refreshToken: null,
      user: null,
      certInfo: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      sessionEpoch: 0,

      /**
       * Log in with username/email and password.
       * The 'email' parameter is sent as 'username' to match Controller API.
       */
      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });

        try {
          // Get agent's public key for cert auto-signing
          // Only attempt in Tauri (sidecar managed by Tauri); in Vite dev the
          // proxy targets the sidecar which isn't running in enterprise mode.
          let publicKey: string | undefined;
          const mode = getCurrentMode();
          if (mode === 'enterprise' && window.__TAURI_INTERNALS__) {
            try {
              publicKey = await import('../api/cert').then(m => m.getCertPublicKey());
            } catch {
              // Agent not running or cert manager not initialized
            }
          }

          const response = await authApi.login({
            username: email,
            password,
            public_key: publicKey,
            client_type: 'terminal',
          });

          // Set tokens first so the interceptor can use them for /auth/me
          set({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            isAuthenticated: true,
          });

          // Controller login returns tokens only (no user object).
          // Fetch full user info from /auth/me to get org_id, roles, etc.
          const user = response.user ?? await authApi.getCurrentUser();

          set({
            user,
            isLoading: false,
            error: null,
          });

          // Store SSH certificate if returned (enterprise mode).
          //
          // Cert lifecycle note: certs are provisioned ONCE here at login
          // and not refreshed afterwards. The sidecar exits in enterprise
          // mode (the controller is the replacement, not a partner), so
          // post-login renewal would have to be a controller-side flow —
          // not the sidecar-routed /cert/* calls that the now-removed
          // `useCertRenewal` hook previously attempted. If post-login
          // renewal is ever needed, design it against the controller API.
          if (mode === 'enterprise' && response.ssh_certificate) {
            // Store cert info in auth store for StatusBar display
            set({ certInfo: response.ssh_certificate });

            // Also try to store on sidecar if available (Tauri only)
            if (window.__TAURI_INTERNALS__) {
              try {
                await import('../api/cert').then(m => m.storeCertificate(response.ssh_certificate!));
              } catch (err) {
                logger.debug('[authStore] Sidecar cert storage skipped:', err);
              }
            }
          }

          // Fetch capabilities after successful login (enterprise mode)
          // Per CONTEXT.md: capabilities fetched once at login, not refreshed mid-session
          if (mode === 'enterprise') {
            useCapabilitiesStore.getState().fetchCapabilities().catch((err) => {
              console.warn('[authStore] Failed to fetch capabilities after login:', err);
              // Don't fail login if capabilities fetch fails - graceful degradation
            });
          }

          // Deep link: /terminal/?org=<id> opens a platform admin straight into
          // that organization (the Admin UI's org switcher can link here).
          const requestedOrg = requestedOrgFromLocation();
          if (requestedOrg && user.is_platform_admin && requestedOrg !== user.org_id) {
            get().switchOrg(requestedOrg).catch((err) => {
              console.warn('[authStore] Could not open requested organization:', err);
            });
          }
        } catch (error: unknown) {
          const message = getErrorMessage(error, 'Login failed. Please check your credentials.');

          // Extract error message from API response if available
          const apiMessage = (error as { response?: { data?: { error?: string } } })
            ?.response?.data?.error;

          // Detect TLS/network errors and provide an actionable message
          const code = (error as { code?: string })?.code || '';
          const isTlsNetworkError = !apiMessage && (
            code === 'ERR_NETWORK' || code === 'ERR_CERT_AUTHORITY_INVALID' ||
            code === 'ERR_CERT_COMMON_NAME_INVALID' || code === 'ECONNREFUSED' ||
            message.includes('Network Error')
          );

          const displayError = isTlsNetworkError
            ? 'Cannot connect — the Controller has an untrusted TLS certificate. Go to Settings → Enterprise to trust it.'
            : (apiMessage || message);

          set({
            isLoading: false,
            error: displayError,
          });

          throw error;
        }
      },

      /**
       * Log out and clear all auth state.
       * Calls Controller to revoke tokens and free license seat.
       */
      logout: async () => {
        const mode = getCurrentMode();

        // Only call server logout for Enterprise mode
        // Controller logout handler:
        // 1. Deletes active_session record (frees license seat)
        // 2. Revokes all refresh tokens for the user
        if (mode === 'enterprise') {
          try {
            await authApi.logout();
          } catch (error) {
            // Logout should succeed locally even if server call fails
            console.warn('[authStore] Server logout failed, continuing local logout:', error);
          }
        }

        // Clear all local state regardless of server response
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          certInfo: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      },

      /**
       * Clear all auth state explicitly.
       * Used for mode isolation cleanup and testing.
       */
      clearAllState: () => {
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          certInfo: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      },

      /**
       * Refresh access token using stored refresh token.
       * Called automatically by axios interceptor on 401.
       */
      doRefreshToken: async () => {
        const { refreshToken } = get();

        if (!refreshToken) {
          throw new Error('No refresh token available');
        }

        try {
          const response = await authApi.refreshToken({
            refresh_token: refreshToken,
          });

          set({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
          });

          // A refreshed token is always minted for the home org; re-apply the
          // active org so a platform admin's switched session survives refresh.
          const { user } = get();
          if (user?.is_platform_admin && user.org_id && user.home_org_id && user.org_id !== user.home_org_id) {
            const switched = await authApi.switchOrg(user.org_id);
            set({ accessToken: switched.access_token });
          }
        } catch (error) {
          // Refresh failed - clear auth state completely
          set({
            accessToken: null,
            refreshToken: null,
            user: null,
            certInfo: null,
            isAuthenticated: false,
            isLoading: false,
          });
          throw error;
        }
      },

      /**
       * Check if current auth state is valid.
       * Attempts to fetch current user to verify token.
       */
      checkAuth: async () => {
        const { refreshToken } = get();

        // No refresh token means not authenticated
        if (!refreshToken) {
          set({ isAuthenticated: false, isLoading: false });
          return;
        }

        set({ isLoading: true });

        try {
          // Try to get current user - this will trigger token refresh if needed
          const user = await authApi.getCurrentUser();

          set({
            user,
            isAuthenticated: true,
            isLoading: false,
          });

          // Fetch capabilities after successful auth check (enterprise mode)
          // Per CONTEXT.md: capabilities fetched once at login, not refreshed mid-session
          const mode = getCurrentMode();
          if (mode === 'enterprise') {
            useCapabilitiesStore.getState().fetchCapabilities().catch((err) => {
              console.warn('[authStore] Failed to fetch capabilities after auth check:', err);
              // Don't fail auth check if capabilities fetch fails - graceful degradation
            });
          }
        } catch (error) {
          console.warn('[authStore] Auth check failed:', error);
          set({
            accessToken: null,
            refreshToken: null,
            user: null,
            certInfo: null,
            isAuthenticated: false,
            isLoading: false,
            error: null,
          });
          // Rethrow network/TLS errors so AuthProvider can show the
          // "Cannot Connect" page with the cert trust dialog instead
          // of silently falling through to the login screen.
          const isNetworkError = error instanceof Error &&
            (error.message.includes('Network Error') ||
             error.message.includes('ECONNREFUSED') ||
             (error as { code?: string }).code?.startsWith('ERR_'));
          if (isNetworkError) {
            throw error;
          }
        }
      },

      /**
       * Clear error message.
       */
      clearError: () => {
        set({ error: null });
      },

      /**
       * Update user info (e.g., after profile edit).
       */
      setUser: (user: User) => {
        set({ user });
      },

      setCertInfo: (certInfo) => {
        set({ certInfo });
      },

      switchOrg: async (orgId: string, beforeRemount?: () => void) => {
        const { user } = get();
        if (!user?.is_platform_admin) {
          throw new Error('Only platform administrators can switch organizations');
        }
        if (orgId === user.org_id) return;

        const switched = await authApi.switchOrg(orgId);
        // The new token is scoped to the target org; /auth/me reflects it.
        set({ accessToken: switched.access_token });
        const refreshed = await authApi.getCurrentUser();
        set({ user: refreshed });

        // Capabilities carry org-scoped plugin panels and permissions.
        try {
          await useCapabilitiesStore.getState().fetchCapabilities();
        } catch (err) {
          console.warn('[authStore] Failed to refetch capabilities after org switch:', err);
        }

        beforeRemount?.();
        set((state) => ({ sessionEpoch: state.sessionEpoch + 1 }));
      },
    })
);

/** `?org=<id>` from the page URL (web build deep link); null when absent. */
function requestedOrgFromLocation(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('org');
  } catch {
    return null;
  }
}

/**
 * Connect auth store to Controller client for JWT interceptors.
 * Must be called after both are initialized.
 */
export function connectAuthStoreToClient(): void {
  setAuthStateGetter(() => ({
    accessToken: useAuthStore.getState().accessToken,
    doRefreshToken: useAuthStore.getState().doRefreshToken,
    logout: useAuthStore.getState().logout,
    user: useAuthStore.getState().user,
  }));
}
