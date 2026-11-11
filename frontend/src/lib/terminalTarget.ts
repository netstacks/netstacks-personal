// Where a standalone terminal's `/ws/terminal` socket connects.
//
// A local PTY is only opened for a tab that carries no remote target at all.
// A tab that is meant to be remote (saved session or quick connect) either
// builds a remote URL or fails with an error; it never falls back to
// `type=local`, which would put the user on their own workstation while the
// tab claims to be a network device.

import type { TabProtocol } from '../api/sessions'

export interface TerminalWsTarget {
  /** Saved session id (agent resolves host + credentials). */
  sessionId?: string
  protocol?: TabProtocol
  /** Quick connect (no saved session): host to connect to. */
  quickConnectHost?: string
  quickConnectPort?: number
  /** Quick connect: credential profile the agent logs in with. */
  quickConnectProfileId?: string
}

export type TerminalWsParamsResult =
  | { ok: true; kind: 'local' | 'session' | 'quick-connect'; params: URLSearchParams }
  | { ok: false; error: string }

/** True when the target names a remote device (session or quick connect). */
export function isRemoteTerminalTarget(target: TerminalWsTarget): boolean {
  return Boolean(target.sessionId) || target.quickConnectHost !== undefined || target.quickConnectProfileId !== undefined
}

/** Connection params (type + target) for the terminal WebSocket URL. */
export function buildTerminalWsParams(target: TerminalWsTarget): TerminalWsParamsResult {
  const params = new URLSearchParams()
  if (target.sessionId) {
    params.set('type', target.protocol || 'ssh')
    params.set('session_id', target.sessionId)
    return { ok: true, kind: 'session', params }
  }
  if (isRemoteTerminalTarget(target)) {
    const host = target.quickConnectHost?.trim()
    if (!host) return { ok: false, error: 'Quick connect has no host to connect to.' }
    if (!target.quickConnectProfileId) return { ok: false, error: 'Quick connect has no credential profile.' }
    // OOB console needs a saved session's terminal-server fields.
    if (target.protocol === 'console') return { ok: false, error: 'Console access requires a saved session.' }
    params.set('type', target.protocol || 'ssh')
    params.set('host', host)
    if (target.quickConnectPort) params.set('port', String(target.quickConnectPort))
    params.set('profile_id', target.quickConnectProfileId)
    return { ok: true, kind: 'quick-connect', params }
  }
  params.set('type', 'local')
  return { ok: true, kind: 'local', params }
}

/** What Quick Connect hands back for a connection that is not saved. */
export interface QuickConnectInfo {
  host: string
  port: number
  /** Empty in enterprise = the device's assigned profile (device-anchored). */
  profile_id: string
  /** Display only (tab title); absent when the profile has no username. */
  username?: string
}

/** Terminal-tab fields for an unsaved Quick Connect.
 *  Standalone: the agent's `/ws/terminal` connects to host/port with the
 *  credential profile. Enterprise: the Controller's device-anchored `/ws/ssh`
 *  (an empty profile id lets the device's assigned profile apply). */
export function quickConnectTabFields(info: QuickConnectInfo, isEnterprise: boolean, id: string) {
  const host = info.host.trim()
  const base = {
    title: info.username ? `${info.username}@${host}` : host,
    protocol: 'ssh' as const,
    cliFlavor: 'auto' as const,
  }
  if (isEnterprise) {
    return {
      ...base,
      enterpriseProfileId: info.profile_id,
      enterpriseSessionDefinitionId: id,
      enterpriseTargetHost: host,
      enterpriseTargetPort: info.port,
    }
  }
  return {
    ...base,
    profileId: info.profile_id,
    quickConnectHost: host,
    quickConnectPort: info.port,
    quickConnectProfileId: info.profile_id,
  }
}
