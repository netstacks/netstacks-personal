// Client startup shared by every entry path that talks to a backend (full app,
// popout terminal, popout chat). The app mode is decided first: only a
// standalone window on the bundled local agent waits for that agent's auth
// token and port. Enterprise is a thin client to the Controller — the Tauri
// shell spawns no local agent there (docs/TERMINAL-PARITY-PLAN.md §2), so
// nothing may wait on one — and a remote-agent window already carries its own
// agent's URL and token.

import { getRemoteAgentHost, initializeClient, type ClientInitResult } from '../api/client';
import { setSidecarAuthToken, setSidecarPort } from '../api/localClient';
import type { AppMode } from '../types/config';
import { logger } from './logger';

/** True when this window's backend is the bundled local agent (sidecar). */
export function usesLocalAgent(mode: AppMode): boolean {
  return mode === 'standalone' && getRemoteAgentHost() === null;
}

/** Initialize the API client, then fetch the local agent's token + port if this window uses it. */
export async function startClient(): Promise<ClientInitResult> {
  const result = await initializeClient();
  if (usesLocalAgent(result.mode)) {
    await bootstrapSidecarToken();
  }
  return result;
}

// Poll Tauri for the sidecar auth token and port (the agent may still be
// booting), then keep listening for re-emits.
async function bootstrapSidecarToken(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const MAX_ATTEMPTS = 50;
    const POLL_INTERVAL_MS = 100;
    let gotToken = false;
    let gotPort = false;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (!gotToken) {
        const token = await invoke<string | null>('get_sidecar_token');
        if (token) {
          setSidecarAuthToken(token);
          logger.log('[main] Sidecar auth token retrieved via IPC');
          gotToken = true;
        }
      }
      if (!gotPort) {
        const port = await invoke<number | null>('get_sidecar_port');
        if (port) {
          setSidecarPort(port);
          logger.log(`[main] Sidecar port retrieved via IPC: ${port}`);
          gotPort = true;
        }
      }
      if (gotToken && gotPort) break;
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      } else {
        if (!gotToken) console.warn('[main] Sidecar auth token not available after polling, continuing without');
        if (!gotPort) console.warn('[main] Sidecar port not available after polling, continuing without');
      }
    }

    await listen<string>('sidecar-auth-token', (event) => {
      setSidecarAuthToken(event.payload);
    });
    await listen<number>('sidecar-port', (event) => {
      setSidecarPort(event.payload);
    });
  } catch {
    // Not in Tauri — check URL params for testing (e.g. ?token=xxx&port=8080)
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      setSidecarAuthToken(urlToken);
      logger.log('[main] Auth token loaded from URL parameter (test mode)');
    }
    const urlPort = params.get('port');
    if (urlPort) {
      setSidecarPort(parseInt(urlPort, 10));
      logger.log(`[main] Port loaded from URL parameter (test mode): ${urlPort}`);
    } else {
      logger.log('[main] Not in Tauri environment, skipping sidecar bootstrap');
    }
  }
}
