// The snapshot a terminal tab hands to its popout window (as URL params) and
// the popout hands back on "pop back in" (as an event/postMessage payload).
// Everything that changes how the terminal connects or behaves must survive
// the round trip — a disabled auto-reconnect must stay disabled, and a quick
// connect must stay a connection to its host.

import type { TabProtocol } from '../api/sessions'

export interface PopoutTerminalSnapshot {
  sessionId?: string
  sessionName: string
  protocol: TabProtocol
  cliFlavor: string
  terminalTheme?: string
  fontSize?: number
  fontFamily?: string
  /** xterm scrollback in lines (absent = xterm default). */
  scrollbackLines?: number
  autoReconnect?: boolean
  /** Seconds between automatic reconnect attempts. */
  reconnectDelay?: number
  quickConnectHost?: string
  quickConnectPort?: number
  quickConnectProfileId?: string
  enterpriseProfileId?: string
  enterpriseSessionDefinitionId?: string
  enterpriseTargetHost?: string
  enterpriseTargetPort?: number
  isJumpbox?: boolean
  awaitingConnect?: boolean
}

/** Tab fields the snapshot is taken from (nullable where the tab allows it). */
export interface PopoutTerminalSource {
  title: string
  sessionId?: string
  protocol?: TabProtocol
  cliFlavor?: string
  terminalTheme?: string | null
  fontSize?: number | null
  fontFamily?: string | null
  scrollbackLines?: number | null
  autoReconnect?: boolean
  reconnectDelay?: number
  quickConnectHost?: string
  quickConnectPort?: number
  quickConnectProfileId?: string
  enterpriseProfileId?: string
  enterpriseSessionDefinitionId?: string
  enterpriseTargetHost?: string
  enterpriseTargetPort?: number
  isJumpbox?: boolean
  awaitingConnect?: boolean
}

const PROTOCOLS: readonly TabProtocol[] = ['ssh', 'telnet', 'console']

function setIf(params: URLSearchParams, key: string, value: string | number | null | undefined): void {
  if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
}

/** URL params a popout terminal window opens with (read by PopoutTerminal). */
export function popoutTerminalParams(tab: PopoutTerminalSource): URLSearchParams {
  const params = new URLSearchParams({
    popout: 'true',
    protocol: tab.protocol || 'ssh',
    sessionName: tab.title,
    cliFlavor: tab.cliFlavor || 'auto',
  })
  setIf(params, 'sessionId', tab.sessionId)
  setIf(params, 'terminalTheme', tab.terminalTheme)
  if (tab.fontSize) params.set('fontSize', String(tab.fontSize))
  setIf(params, 'fontFamily', tab.fontFamily)
  setIf(params, 'scrollbackLines', tab.scrollbackLines)
  if (tab.autoReconnect !== undefined) params.set('autoReconnect', String(tab.autoReconnect))
  setIf(params, 'reconnectDelay', tab.reconnectDelay)
  setIf(params, 'quickConnectHost', tab.quickConnectHost)
  setIf(params, 'quickConnectPort', tab.quickConnectPort)
  setIf(params, 'quickConnectProfileId', tab.quickConnectProfileId)
  // An empty enterprise profile id means "device-anchored" — keep it.
  if (tab.enterpriseProfileId !== undefined) params.set('enterpriseProfileId', tab.enterpriseProfileId)
  setIf(params, 'enterpriseSessionDefinitionId', tab.enterpriseSessionDefinitionId)
  setIf(params, 'enterpriseTargetHost', tab.enterpriseTargetHost)
  setIf(params, 'enterpriseTargetPort', tab.enterpriseTargetPort)
  if (tab.isJumpbox) params.set('isJumpbox', 'true')
  if (tab.awaitingConnect) params.set('awaitingConnect', 'true')
  return params
}

function num(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function str(params: URLSearchParams, key: string): string | undefined {
  return params.get(key) || undefined
}

/** Reads the snapshot back out of a popout window's URL params. */
export function parsePopoutTerminalParams(params: URLSearchParams): PopoutTerminalSnapshot {
  const protocol = params.get('protocol') as TabProtocol | null
  const autoReconnect = params.get('autoReconnect')
  return {
    sessionId: str(params, 'sessionId'),
    sessionName: params.get('sessionName') || 'Terminal',
    protocol: protocol && PROTOCOLS.includes(protocol) ? protocol : 'ssh',
    cliFlavor: params.get('cliFlavor') || 'auto',
    terminalTheme: str(params, 'terminalTheme'),
    fontSize: num(params, 'fontSize'),
    fontFamily: str(params, 'fontFamily'),
    scrollbackLines: num(params, 'scrollbackLines'),
    autoReconnect: autoReconnect === null ? undefined : autoReconnect === 'true',
    reconnectDelay: num(params, 'reconnectDelay'),
    quickConnectHost: str(params, 'quickConnectHost'),
    quickConnectPort: num(params, 'quickConnectPort'),
    quickConnectProfileId: str(params, 'quickConnectProfileId'),
    enterpriseProfileId: params.get('enterpriseProfileId') ?? undefined,
    enterpriseSessionDefinitionId: str(params, 'enterpriseSessionDefinitionId'),
    enterpriseTargetHost: str(params, 'enterpriseTargetHost'),
    enterpriseTargetPort: num(params, 'enterpriseTargetPort'),
    isJumpbox: params.get('isJumpbox') === 'true',
    awaitingConnect: params.get('awaitingConnect') === 'true',
  }
}

/** Terminal-tab fields for a terminal popped back in from its popout. */
export function popoutSnapshotTabFields(p: PopoutTerminalSnapshot) {
  return {
    title: p.sessionName || 'Terminal',
    sessionId: p.sessionId,
    protocol: p.protocol || 'ssh',
    cliFlavor: p.cliFlavor || 'auto',
    terminalTheme: p.terminalTheme,
    fontSize: p.fontSize,
    fontFamily: p.fontFamily,
    scrollbackLines: p.scrollbackLines,
    autoReconnect: p.autoReconnect,
    reconnectDelay: p.reconnectDelay,
    quickConnectHost: p.quickConnectHost,
    quickConnectPort: p.quickConnectPort,
    quickConnectProfileId: p.quickConnectProfileId,
    profileId: p.quickConnectProfileId,
    enterpriseProfileId: p.enterpriseProfileId,
    enterpriseSessionDefinitionId: p.enterpriseSessionDefinitionId,
    enterpriseTargetHost: p.enterpriseTargetHost,
    enterpriseTargetPort: p.enterpriseTargetPort,
    isJumpbox: p.isJumpbox,
    awaitingConnect: p.awaitingConnect,
  }
}
