import { getClient, getCurrentMode } from './client'

import { logger } from '../lib/logger'
export interface RemoteAgentDeployResult {
  agent_id: string
  host: string
  port: number
  auth_token: string
  tls_cert_b64: string
}

export interface RemoteAgentStatus {
  alive: boolean
  host: string
  port: number
}

export async function deployRemoteAgent(
  sessionId: string,
): Promise<RemoteAgentDeployResult> {
  // Hard rule: enterprise mode is a thin shell that talks only to the
  // Controller. It must never deploy or run a local/remote agent. This
  // is the single chokepoint for every remote-agent deploy path, so the
  // guard lives here in addition to the command-level `when` gates.
  if (getCurrentMode() === 'enterprise') {
    throw new Error('Remote agent deployment is not available in enterprise mode')
  }
  const { data } = await getClient().http.post('/remote-agents/deploy', {
    session_id: sessionId,
  }, { timeout: 300000 })
  return data
}

export async function getRemoteAgentStatus(agentId: string): Promise<RemoteAgentStatus> {
  const { data } = await getClient().http.get(`/remote-agents/${agentId}/status`)
  return data
}

export async function stopRemoteAgent(agentId: string): Promise<void> {
  await getClient().http.post(`/remote-agents/${agentId}/stop`)
}

/**
 * Ensure the remote agent's TLS cert is trusted by the OS.
 * Tries a fetch first — if it succeeds, the cert is already trusted.
 * Only calls install_ca_certificate (which triggers macOS approval dialog)
 * when the cert isn't recognized.
 */
export async function ensureRemoteCertTrusted(result: RemoteAgentDeployResult): Promise<void> {
  if (!result.tls_cert_b64) return
  const url = `https://${result.host}:${result.port}/api/health`
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    return
  } catch {
    // Cert not trusted yet — install it
  }
  try {
    const pem = atob(result.tls_cert_b64)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('install_ca_certificate', {
      pemContent: pem,
      filename: `netstacks-remote-${result.host}.crt`,
    })
    logger.log('[remoteAgent] TLS cert installed for', result.host)
  } catch (err) {
    console.warn('[remoteAgent] Failed to install cert:', err)
  }
}
