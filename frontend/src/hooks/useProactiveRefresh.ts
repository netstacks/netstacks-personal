import { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { getIsRefreshing } from '../api/controllerClient';

import { logger } from '../lib/logger'
/**
 * Proactive JWT refresh hook.
 *
 * Decodes the JWT access token's exp claim and schedules a refresh
 * 5 minutes before expiration. Cooperates with the reactive interceptor
 * by checking the shared isRefreshing flag to prevent race conditions.
 *
 * Per RESEARCH.md Pitfall 3: "Proactive refresh shares isRefreshing flag
 * with reactive interceptor to prevent race conditions."
 */
export function useProactiveRefresh(): void {
  const accessToken = useAuthStore(state => state.accessToken);
  const doRefreshToken = useAuthStore(state => state.doRefreshToken);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // Clear any existing timer
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // No token means not authenticated - skip
    if (!accessToken) {
      return;
    }

    try {
      // Decode JWT payload (base64 decode of second segment)
      // Format: header.payload.signature
      const parts = accessToken.split('.');
      if (parts.length !== 3) {
        console.warn('[useProactiveRefresh] Invalid JWT format');
        return;
      }

      // Decode payload (second segment)
      const payload = JSON.parse(atob(parts[1]));
      const exp = payload.exp;

      if (typeof exp !== 'number') {
        console.warn('[useProactiveRefresh] No exp claim in JWT');
        return;
      }

      // Calculate time until expiry
      const expiryMs = exp * 1000; // Convert seconds to milliseconds
      const nowMs = Date.now();
      const timeUntilExpiryMs = expiryMs - nowMs;

      // Schedule refresh 5 minutes (300000ms) before expiry
      const REFRESH_BUFFER_MS = 5 * 60 * 1000;
      const timeUntilRefreshMs = Math.max(0, timeUntilExpiryMs - REFRESH_BUFFER_MS);

      logger.log(
        `[useProactiveRefresh] Token expires in ${Math.floor(timeUntilExpiryMs / 1000)}s, scheduling refresh in ${Math.floor(timeUntilRefreshMs / 1000)}s`
      );

      timerRef.current = window.setTimeout(async () => {
        // Check if reactive interceptor is already refreshing
        if (getIsRefreshing()) {
          logger.log('[useProactiveRefresh] Reactive interceptor already refreshing, skipping');
          return;
        }

        try {
          logger.log('[useProactiveRefresh] Initiating proactive token refresh');
          await doRefreshToken();
          logger.log('[useProactiveRefresh] Proactive refresh successful');
          // New accessToken in store will trigger re-scheduling via useEffect
        } catch (error) {
          console.warn('[useProactiveRefresh] Proactive refresh failed:', error);
          // Reactive interceptor will catch on next API call
        }
      }, timeUntilRefreshMs);
    } catch (error) {
      console.warn('[useProactiveRefresh] Failed to decode JWT:', error);
    }

    // Cleanup: clear timer on unmount or when accessToken changes
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [accessToken, doRefreshToken]);
}
