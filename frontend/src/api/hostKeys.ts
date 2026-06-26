// Host-key fingerprint approval API (AUDIT FIX REMOTE-001).
//
// The backend's SSH connect path now blocks on a UI prompt when it sees
// an unknown or changed host key. The frontend polls this surface while a
// connection is in flight and shows a modal so the user can compare the
// fingerprint against an out-of-band source (the device's `show ssh server
// host-key` output, the inventory record, etc.) before accepting.

import { getClient } from './client';

export interface HostKeyPrompt {
  /** UUID — pass back to approve/reject. */
  id: string;
  host: string;
  port: number;
  /** True when the host:port already has a stored key that doesn't match
   *  what the server presented. Strong "MITM possible" signal — UI should
   *  show this very prominently. */
  is_changed_key: boolean;
  /** SHA-256 fingerprint of the key the server just presented. */
  fingerprint: string;
  /** SHA-256 of the previously-trusted key, if any. Show side-by-side. */
  previous_fingerprint: string | null;
  /** RFC3339 instant when the prompt was created — used to compute the
   *  ~120 s countdown shown in the modal. */
  created_at: string;
}

/** GET /api/host-keys/prompts — list currently-pending prompts. */
export async function listHostKeyPrompts(): Promise<HostKeyPrompt[]> {
  const { data } = await getClient().http.get('/host-keys/prompts');
  // Controller wraps in { prompts: [...] }, sidecar returns raw array
  const list = data?.prompts ?? data;
  return Array.isArray(list) ? list : [];
}

/** Approve a prompt — the SSH handshake will proceed and the key is
 *  persisted to known_hosts. */
export async function approveHostKeyPrompt(id: string): Promise<void> {
  await getClient().http.post(`/host-keys/prompts/${id}/approve`);
}

/** Reject a prompt — the SSH handshake aborts with KeyError. */
export async function rejectHostKeyPrompt(id: string): Promise<void> {
  await getClient().http.post(`/host-keys/prompts/${id}/reject`);
}

/** One entry in the trusted-hosts list returned by GET /api/host-keys. */
export interface TrustedHostKey {
  host: string;
  port: number;
  /** "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", etc. */
  key_type: string;
  /** SHA-256 fingerprint, e.g. "SHA256:abc..." */
  fingerprint: string;
}

/** GET /api/host-keys — list every TOFU-trusted host key. */
export async function listTrustedHostKeys(): Promise<TrustedHostKey[]> {
  const { data } = await getClient().http.get('/host-keys');
  return Array.isArray(data) ? data : [];
}

/** DELETE /api/host-keys/:host/:port — revoke a previously-trusted key.
 *  Next connection to that host:port triggers a fresh TOFU prompt. */
export async function deleteTrustedHostKey(host: string, port: number): Promise<void> {
  await getClient().http.delete(`/host-keys/${encodeURIComponent(host)}/${port}`);
}
