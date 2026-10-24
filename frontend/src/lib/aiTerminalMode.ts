/**
 * AI Terminal Mode (standalone) — the `ai.terminal_mode` sidecar setting that
 * enables the remote file tools. Settings → AI writes it; every mounted AI
 * agent (side panel, chat tabs, popups — including other windows) subscribes
 * so a toggle takes effect without remounting.
 */

import { getClient } from '../api/client';
import { shareInFlight } from './inflight';

const EVENT = 'netstacks:ai-terminal-mode-changed';
const CHANNEL = 'netstacks-ai-terminal-mode';

/** The settings endpoint has returned both a bare JSON bool and a `{ value: 'true' }` wrapper. */
export function parseAiTerminalMode(data: unknown): boolean {
  if (data === true) return true;
  return !!data && typeof data === 'object' && (data as { value?: unknown }).value === 'true';
}

export async function fetchAiTerminalMode(): Promise<boolean> {
  const res = await shareInFlight('settings:ai.terminal_mode', () => getClient().http.get('/settings/ai.terminal_mode'));
  return parseAiTerminalMode(res.data);
}

/** Persist the setting, then tell every mounted agent (this window and others). */
export async function saveAiTerminalMode(enabled: boolean): Promise<void> {
  await getClient().http.put('/settings/ai.terminal_mode', { value: enabled ? 'true' : 'false' });
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: enabled }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(enabled);
    channel.close();
  }
}

/** Subscribe to changes made by saveAiTerminalMode in any window. Returns the unsubscribe. */
export function subscribeAiTerminalMode(onChange: (enabled: boolean) => void): () => void {
  const onEvent = (e: Event) => onChange((e as CustomEvent<boolean>).detail === true);
  window.addEventListener(EVENT, onEvent);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  if (channel) channel.onmessage = (e: MessageEvent) => onChange(e.data === true);
  return () => {
    window.removeEventListener(EVENT, onEvent);
    channel?.close();
  };
}
