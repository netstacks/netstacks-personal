import axios from 'axios';
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { NetStacksClient } from '../types/api';
import { appendTokenToWsUrl } from './wsHelpers';
import { injectOrgIdForPlugins } from './requestHelpers';

// JWT refresh queue — handles concurrent 401s with a single refresh.
//
// Sibling implementation: controller/admin-ui/src/api/client.ts
// Both use the same queue pattern. Intentional differences:
//   - Token storage: terminal uses injected callback; admin-ui reads useAuthStore directly
//   - Logout on failure: terminal clears tokens and lets UI (AuthProvider) handle it; admin-ui calls logout()
//   - TLS error handling: terminal only (Tauri webview connects to external controller URL)
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

// Auth store getter - set after auth store is created
let getAuthState: (() => {
  accessToken: string | null;
  doRefreshToken: () => Promise<void>;
  logout: () => void;
  user?: { id?: string; org_id?: string } | null;
}) | null = null;

/**
 * Set the auth state getter for JWT handling.
 * Must be called after auth store is initialized.
 */
export function setAuthStateGetter(getter: typeof getAuthState): void {
  getAuthState = getter;
}

/**
 * Get the current refresh state.
 * Used by proactive refresh hook to avoid race conditions with reactive interceptor.
 */
export function getIsRefreshing(): boolean {
  return isRefreshing;
}

// TLS-related error codes from Chromium/webview
const TLS_ERROR_CODES = new Set([
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_SSL_PROTOCOL_ERROR',
]);

/**
 * Check if an axios error is a TLS/network-level failure (no response received).
 * Returns a descriptive message if TLS-related, or null otherwise.
 */
function detectTlsError(error: AxiosError): string | null {
  // Only check errors without a response (network-level failures)
  if (error.response) return null;

  const code = error.code || '';
  const message = error.message || '';

  if (TLS_ERROR_CODES.has(code)) {
    return `TLS certificate error (${code}) — Ensure the Controller certificate is trusted by your operating system`;
  }

  if (code === 'ECONNREFUSED') {
    return 'Connection refused — Ensure the Controller is running and accessible';
  }

  if (code === 'ERR_NETWORK' || message.includes('Network Error')) {
    return 'Network error (possibly TLS-related) — Check URL, certificate, and network configuration';
  }

  return null;
}

/**
 * Create API client for Enterprise mode (Controller).
 * Includes JWT interceptors for automatic token handling.
 */
export function createControllerClient(controllerUrl: string): NetStacksClient {
  const http = axios.create({
    baseURL: `${controllerUrl}/api`,
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  // Request interceptor: attach access token + inject org_id for plugin requests
  http.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (getAuthState) {
        const { accessToken, user } = getAuthState();
        if (accessToken) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }
        injectOrgIdForPlugins(config, user?.org_id);
        // Plugin write endpoints attribute the actor (e.g. incidents
        // linked_by / comment author) via an X-User-Id header. The controller
        // proxy injects X-Org-Id but NOT X-User-Id, so without this those
        // calls 422. Mirror injectOrgIdForPlugins for every plugin request;
        // an explicit per-call header still wins.
        if (config.url?.startsWith('/plugins/') && user?.id && !config.headers['X-User-Id']) {
          config.headers['X-User-Id'] = user.id;
        }
      }
      return config;
    },
    (error) => Promise.reject(error)
  );

  // Response interceptor: handle TLS errors and 401 with token refresh
  http.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      // Detect TLS/network-level failures (no response received)
      const tlsMessage = detectTlsError(error);
      if (tlsMessage) {
        console.error(
          `[ControllerClient] TLS connection failed to ${controllerUrl}:`,
          error.code,
          `— ${tlsMessage}`
        );
        return Promise.reject(error);
      }

      const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

      // Only handle 401 errors
      if (error.response?.status !== 401 || originalRequest._retry) {
        return Promise.reject(error);
      }

      // Don't try to refresh for auth endpoints — a 401 on login/refresh
      // means bad credentials, not an expired token
      const requestUrl = originalRequest.url || '';
      if (requestUrl.includes('/auth/login') || requestUrl.includes('/auth/refresh')) {
        return Promise.reject(error);
      }

      // If no auth state getter, can't refresh
      if (!getAuthState) {
        console.error('[ControllerClient] Auth state not initialized');
        return Promise.reject(error);
      }

      // If already refreshing, queue this request
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(http(originalRequest));
            },
            reject,
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        await getAuthState().doRefreshToken();
        const { accessToken } = getAuthState();

        // Process queued requests
        failedQueue.forEach((prom) => {
          if (accessToken) {
            prom.resolve(accessToken);
          } else {
            prom.reject(new Error('No token after refresh'));
          }
        });
        failedQueue = [];

        // Retry original request
        if (accessToken) {
          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        }
        return http(originalRequest);
      } catch (refreshError) {
        // Refresh failed - reject all queued requests
        failedQueue.forEach((prom) => prom.reject(refreshError));
        failedQueue = [];

        // Don't call logout here - it can cause loops.
        // The UI (AuthProvider) will detect !isAuthenticated and show login.
        // Just clear tokens locally without making API calls.
        console.warn('[ControllerClient] Token refresh failed, clearing auth state');
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }
  );

  return {
    http,
    mode: 'enterprise',
    hasEnterpriseFeatures: true,
    baseUrl: controllerUrl,

    wsUrl(path: string): string {
      // Convert http(s) to ws(s)
      const wsProtocol = controllerUrl.startsWith('https') ? 'wss' : 'ws';
      const wsBase = controllerUrl.replace(/^https?/, wsProtocol);
      return `${wsBase}${path}`;
    },

    wsUrlWithAuth(path: string): string {
      if (!getAuthState) {
        console.warn('[ControllerClient] Auth state not initialized for WebSocket');
        return this.wsUrl(path);
      }

      const { accessToken } = getAuthState();
      if (!accessToken) {
        console.warn('[ControllerClient] No access token for WebSocket');
        return this.wsUrl(path);
      }

      // Append token as query parameter (WebSocket API doesn't support headers)
      return appendTokenToWsUrl(this.wsUrl(path), accessToken);
    },
  };
}
