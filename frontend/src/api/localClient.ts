import axios from 'axios';
import type { AxiosInstance } from 'axios';
import type { NetStacksClient } from '../types/api';
import { appendTokenToWsUrl } from './wsHelpers';

// Must use the IPv4 literal — the agent binds 127.0.0.1 only, and on Windows
// "localhost" resolves to ::1 first; WebView2/Chromium does not fall back to
// IPv4 reliably, causing ERR_CONNECTION_REFUSED in the packaged app.
import { logger } from '../lib/logger'
const LOCAL_AGENT_HOST = '127.0.0.1';

// Auth token for standalone mode - set by Tauri event, never persisted
let sidecarAuthToken: string | null = null;

// Agent port — set by Tauri event at startup (agent binds ephemeral port)
let sidecarPort: number | null = null;

export function setSidecarAuthToken(token: string): void {
  sidecarAuthToken = token;
  logger.log('[LocalClient] Auth token set');
}

export function getSidecarAuthToken(): string | null {
  return sidecarAuthToken;
}

export function setSidecarPort(port: number): void {
  sidecarPort = port;
  logger.log(`[LocalClient] Agent port set to ${port}`);
}

export function getSidecarPort(): number | null {
  return sidecarPort;
}

function getLocalAgentUrl(): string {
  const port = sidecarPort || 8080;
  return `https://${LOCAL_AGENT_HOST}:${port}`;
}

/**
 * Create an axios instance configured for a specific agent (local or remote).
 * Shared between local client and remote workspace clients.
 */
export function createAgentHttpClient(baseUrl: string, authToken: string): AxiosInstance {
  const http = axios.create({
    baseURL: `${baseUrl}/api`,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  http.interceptors.request.use((config) => {
    config.headers.Authorization = `Bearer ${authToken}`;
    return config;
  });

  http.interceptors.response.use(
    (response) => response,
    (error) => {
      console.error('[AgentClient] API error:', error.message);
      return Promise.reject(error);
    }
  );

  return http;
}

/**
 * Create API client for standalone Personal Mode (local agent).
 * Auth token and port set by Tauri events at startup.
 * Personal Mode is open-source and full-featured — no tier gating.
 */
export function createLocalClient(): NetStacksClient {
  const http = axios.create({
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  // Resolve baseURL and auth token lazily per-request so a late sidecar
  // port arrival (common on Windows where startup is slower) still works.
  //
  // Subtlety: axios merges instance defaults into the per-request config
  // before interceptors run, so `config.baseURL` is always truthy here —
  // either the instance default (set at create() time, possibly with a
  // stale 8080 fallback port) or a per-request override the caller set.
  // We need to refresh ONLY the inherited default; per-request overrides
  // (e.g. installationApi passes the un-prefixed agent URL to reach
  // /lsp/plugins instead of /api/lsp/plugins) must be preserved.
  //
  // Comparing against http.defaults.baseURL is how we tell them apart —
  // anything that doesn't match the instance default is an explicit
  // override and we leave it alone.
  http.interceptors.request.use((config) => {
    if (config.baseURL === http.defaults.baseURL) {
      config.baseURL = `${getLocalAgentUrl()}/api`;
    }
    const token = getSidecarAuthToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  http.interceptors.response.use(
    (response) => response,
    (error) => {
      console.error('[LocalClient] API error:', error.message);
      return Promise.reject(error);
    }
  );

  return {
    http,
    mode: 'standalone',
    hasEnterpriseFeatures: false,
    get baseUrl() { return getLocalAgentUrl(); },

    wsUrl(path: string): string {
      const port = sidecarPort || 8080;
      const base = `wss://${LOCAL_AGENT_HOST}:${port}${path}`;
      const token = getSidecarAuthToken();
      return token ? appendTokenToWsUrl(base, token) : base;
    },

    wsUrlWithAuth(path: string): string {
      return this.wsUrl(path);
    },
  };
}

/**
 * Create API client for a remote agent window.
 * The entire window connects to a remote agent — same API, different host.
 */
export function createRemoteAgentClient(baseUrl: string, authToken: string): NetStacksClient {
  const http = createAgentHttpClient(baseUrl, authToken);

  // Several standalone features (script run streaming, LSP install progress,
  // workspace output, AI agent chat) authenticate via getSidecarAuthToken()
  // rather than the axios instance. In a remote-agent window no Tauri event
  // ever sets it, so those calls would 401 — seed it with this window's token.
  setSidecarAuthToken(authToken);

  return {
    http,
    mode: 'standalone',
    hasEnterpriseFeatures: false,
    baseUrl,

    wsUrl(path: string): string {
      const normalized = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`
      const wsBase = normalized.replace(/^https?:/, 'wss:')
      return appendTokenToWsUrl(`${wsBase}${path}`, authToken)
    },

    wsUrlWithAuth(path: string): string {
      return this.wsUrl(path);
    },
  };
}
