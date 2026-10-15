// Open-tab restore across relaunches. The open tabs (by stable entity
// reference), their order, the active tab and the popout windows are
// snapshotted to localStorage, then resolved against live data on the next
// launch. Nothing here opens a connection: restored terminals always come back
// disconnected and wait for the user.
import { listSessions, hasConsoleAccess, sessionTerminalSettings, type Session, type SessionTerminalSettings, type TabProtocol } from '../api/sessions'
import { listProfiles } from '../api/profiles'
import { listEnterpriseSessionDefinitions } from '../api/enterpriseSessions'
import { listEnterpriseDevices } from '../api/enterpriseDevices'
import { getDocument, type Document } from '../api/docs'
import { getTopology } from '../api/topology'
import { getScript, type Script } from '../api/scripts'
import { parseApiError } from '../api/errors'
import type { Topology } from '../types/topology'
import type { CliFlavor } from '../types/enrichment'
import type { DeviceSummary } from '../types/enterpriseDevice'

const STORAGE_KEY = 'netstacks-open-tabs'
/** Device-anchored enterprise tabs carry `device-<deviceId>` as their session definition id. */
const DEVICE_DEFINITION_PREFIX = 'device-'

/** A terminal on a saved session (standalone) or a controller session definition / device (enterprise). */
export type TerminalSnapshot =
  | { type: 'terminal'; id: string; sessionId: string; protocol: TabProtocol }
  | { type: 'enterprise-terminal'; id: string; definitionId: string; profileId?: string }

export type SnapshotTab =
  | TerminalSnapshot
  | { type: 'document'; id: string; documentId: string }
  | { type: 'topology'; id: string; topologyId: string }
  | { type: 'script'; id: string; scriptId: string }
  | { type: 'settings'; id: string }

/** Logical (DPI-independent) outer position and inner size of a window. */
export interface PopoutBounds {
  x: number
  y: number
  width: number
  height: number
}

export type SnapshotPopout =
  | { kind: 'terminal'; label: string; tab: TerminalSnapshot; bounds?: PopoutBounds }
  | { kind: 'chat'; label: string; title: string; bounds?: PopoutBounds }

export interface TabSnapshot {
  tabs: SnapshotTab[]
  activeTabId: string | null
  popouts: SnapshotPopout[]
}

/** The tab fields a snapshot is taken from (a structural subset of App's Tab). */
export interface SnapshotSourceTab {
  id: string
  type: string
  sessionId?: string
  protocol?: TabProtocol
  enterpriseSessionDefinitionId?: string
  enterpriseProfileId?: string
  documentId?: string
  topologyId?: string
  isTemporaryTopology?: boolean
  scriptId?: string
}

/** Terminals without a saved session (local shells, jumpboxes, quick connects) have nothing to restore. */
export function snapshotTerminal(tab: SnapshotSourceTab): TerminalSnapshot | null {
  if (tab.type !== 'terminal') return null
  // Enterprise tabs first: once connected, their sessionId is the controller's
  // live SSH session id, not a saved session.
  if (tab.enterpriseSessionDefinitionId) {
    return { type: 'enterprise-terminal', id: tab.id, definitionId: tab.enterpriseSessionDefinitionId, profileId: tab.enterpriseProfileId }
  }
  return tab.sessionId ? { type: 'terminal', id: tab.id, sessionId: tab.sessionId, protocol: tab.protocol ?? 'ssh' } : null
}

export function snapshotTab(tab: SnapshotSourceTab): SnapshotTab | null {
  switch (tab.type) {
    case 'terminal':
      return snapshotTerminal(tab)
    case 'document':
      return tab.documentId ? { type: 'document', id: tab.id, documentId: tab.documentId } : null
    case 'topology':
      return tab.topologyId && !tab.isTemporaryTopology ? { type: 'topology', id: tab.id, topologyId: tab.topologyId } : null
    case 'script':
      return tab.scriptId ? { type: 'script', id: tab.id, scriptId: tab.scriptId } : null
    case 'settings':
      return { type: 'settings', id: tab.id }
    default:
      return null
  }
}

export function createTabSnapshot(
  tabs: readonly SnapshotSourceTab[],
  activeTabId: string | null,
  popouts: SnapshotPopout[],
): TabSnapshot {
  const snapshotTabs = tabs.map(snapshotTab).filter((t): t is SnapshotTab => t !== null)
  return {
    tabs: snapshotTabs,
    activeTabId: snapshotTabs.some(t => t.id === activeTabId) ? activeTabId : null,
    popouts,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const PROTOCOLS: readonly unknown[] = ['ssh', 'telnet', 'console'] satisfies TabProtocol[]

function parseTerminal(v: Record<string, unknown>): TerminalSnapshot | null {
  if (!isId(v.id)) return null
  if (v.type === 'terminal' && isId(v.sessionId) && PROTOCOLS.includes(v.protocol)) {
    return { type: 'terminal', id: v.id, sessionId: v.sessionId, protocol: v.protocol as TabProtocol }
  }
  if (v.type === 'enterprise-terminal' && isId(v.definitionId)) {
    return { type: 'enterprise-terminal', id: v.id, definitionId: v.definitionId, profileId: typeof v.profileId === 'string' ? v.profileId : undefined }
  }
  return null
}

function parseTab(v: unknown): SnapshotTab | null {
  if (!isRecord(v) || !isId(v.id)) return null
  switch (v.type) {
    case 'terminal':
    case 'enterprise-terminal':
      return parseTerminal(v)
    case 'document':
      return isId(v.documentId) ? { type: 'document', id: v.id, documentId: v.documentId } : null
    case 'topology':
      return isId(v.topologyId) ? { type: 'topology', id: v.id, topologyId: v.topologyId } : null
    case 'script':
      return isId(v.scriptId) ? { type: 'script', id: v.id, scriptId: v.scriptId } : null
    case 'settings':
      return { type: 'settings', id: v.id }
    default:
      return null
  }
}

function parseBounds(v: unknown): PopoutBounds | undefined {
  if (!isRecord(v)) return undefined
  const { x, y, width, height } = v
  const finite = [x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n))
  return finite ? { x: x as number, y: y as number, width: width as number, height: height as number } : undefined
}

function parsePopout(v: unknown): SnapshotPopout | null {
  if (!isRecord(v) || !isId(v.label)) return null
  const bounds = parseBounds(v.bounds)
  if (v.kind === 'chat' && typeof v.title === 'string') return { kind: 'chat', label: v.label, title: v.title, bounds }
  if (v.kind === 'terminal' && isRecord(v.tab)) {
    const tab = parseTerminal(v.tab)
    return tab ? { kind: 'terminal', label: v.label, tab, bounds } : null
  }
  return null
}

/** Entries that don't parse are dropped; an unreadable snapshot restores nothing. */
export function parseTabSnapshot(raw: string | null): TabSnapshot | null {
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.error('[tabRestore] Discarding unreadable tab snapshot:', err)
    return null
  }
  if (!isRecord(data) || !Array.isArray(data.tabs) || !Array.isArray(data.popouts)) return null
  return {
    tabs: data.tabs.map(parseTab).filter((t): t is SnapshotTab => t !== null),
    activeTabId: isId(data.activeTabId) ? data.activeTabId : null,
    popouts: data.popouts.map(parsePopout).filter((p): p is SnapshotPopout => p !== null),
  }
}

export function readTabSnapshot(): TabSnapshot | null {
  return parseTabSnapshot(localStorage.getItem(STORAGE_KEY))
}

export function writeTabSnapshot(snapshot: TabSnapshot): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

export type ResolvedTerminal =
  | { type: 'terminal'; id: string; session: Session; console: boolean; settings: SessionTerminalSettings }
  | { type: 'enterprise-terminal'; id: string; definitionId: string; profileId?: string; title: string; cliFlavor: CliFlavor; host: string; port: number }

export type ResolvedTab =
  | ResolvedTerminal
  | { type: 'document'; id: string; document: Document }
  | { type: 'topology'; id: string; topology: Topology }
  | { type: 'script'; id: string; script: Script }
  | { type: 'settings'; id: string }

export type ResolvedPopout =
  | { kind: 'terminal'; label: string; tab: TerminalSnapshot; terminal: ResolvedTerminal; bounds?: PopoutBounds }
  | { kind: 'chat'; label: string; title: string; bounds?: PopoutBounds }

export interface ResolvedSnapshot {
  tabs: ResolvedTab[]
  activeTabId: string | null
  popouts: ResolvedPopout[]
}

export interface RestoreScope {
  isEnterprise: boolean
  canDocs: boolean
  canTopology: boolean
}

/** A lookup that fails restores none of its tabs. A 404 means the entity is
 *  gone, which is expected and stays quiet; anything else is logged. */
async function lookup<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (err) {
    if (parseApiError(err).status !== 404) console.error(`[tabRestore] Could not load ${what}; not restoring it:`, err)
    return null
  }
}

async function listAllEnterpriseDevices(): Promise<DeviceSummary[]> {
  const devices: DeviceSummary[] = []
  for (;;) {
    const page = await listEnterpriseDevices({ limit: 1000, offset: devices.length })
    devices.push(...page.items)
    if (page.items.length === 0 || devices.length >= page.total) return devices
  }
}

/** Loads only the lists the snapshot's terminals reference, then resolves each terminal against them. */
async function terminalResolver(
  terminals: TerminalSnapshot[],
  isEnterprise: boolean,
): Promise<(t: TerminalSnapshot) => ResolvedTerminal | null> {
  if (!isEnterprise) {
    if (!terminals.some(t => t.type === 'terminal')) return () => null
    const loaded = await lookup('sessions', () => Promise.all([listSessions(), listProfiles()]))
    if (!loaded) return () => null
    const [sessions, profiles] = loaded
    return (t) => {
      if (t.type !== 'terminal') return null
      const session = sessions.find(s => s.id === t.sessionId)
      const isConsole = t.protocol === 'console'
      if (!session || (isConsole && !hasConsoleAccess(session))) return null
      const settings = sessionTerminalSettings(session, profiles.find(p => p.id === session.profile_id))
      return { type: 'terminal', id: t.id, session, console: isConsole, settings }
    }
  }

  const definitionIds = terminals.flatMap(t => t.type === 'enterprise-terminal' ? [t.definitionId] : [])
  const needsDevices = definitionIds.some(id => id.startsWith(DEVICE_DEFINITION_PREFIX))
  const needsDefinitions = definitionIds.some(id => !id.startsWith(DEVICE_DEFINITION_PREFIX))
  const [definitions, devices] = await Promise.all([
    needsDefinitions ? lookup('session definitions', async () => (await listEnterpriseSessionDefinitions()).items) : null,
    needsDevices ? lookup('devices', listAllEnterpriseDevices) : null,
  ])
  return (t) => {
    if (t.type !== 'enterprise-terminal') return null
    const target = t.definitionId.startsWith(DEVICE_DEFINITION_PREFIX)
      ? devices?.find(d => `${DEVICE_DEFINITION_PREFIX}${d.id}` === t.definitionId)
      : definitions?.find(d => d.id === t.definitionId)
    if (!target) return null
    return {
      type: 'enterprise-terminal',
      id: t.id,
      definitionId: t.definitionId,
      profileId: t.profileId,
      title: target.name,
      cliFlavor: 'cli_flavor' in target ? target.cli_flavor as CliFlavor : 'auto',
      host: target.host,
      port: target.port,
    }
  }
}

/**
 * Resolves a snapshot against live data. Tabs whose session, document,
 * topology or script no longer exists (or whose feature is unavailable) are
 * dropped silently. The saved active tab wins if it survived, else the last
 * restored tab.
 */
export async function resolveTabSnapshot(snapshot: TabSnapshot, scope: RestoreScope): Promise<ResolvedSnapshot> {
  const terminals = [
    ...snapshot.tabs.filter((t): t is TerminalSnapshot => t.type === 'terminal' || t.type === 'enterprise-terminal'),
    ...snapshot.popouts.flatMap(p => p.kind === 'terminal' ? [p.tab] : []),
  ]
  const resolveTerminal = await terminalResolver(terminals, scope.isEnterprise)

  const resolved = await Promise.all(snapshot.tabs.map(async (t): Promise<ResolvedTab | null> => {
    switch (t.type) {
      case 'terminal':
      case 'enterprise-terminal':
        return resolveTerminal(t)
      case 'document': {
        if (!scope.canDocs) return null
        const document = await lookup(`document ${t.documentId}`, () => getDocument(t.documentId))
        return document && { type: 'document', id: t.id, document }
      }
      case 'topology': {
        if (!scope.canTopology) return null
        const topology = await lookup(`topology ${t.topologyId}`, () => getTopology(t.topologyId))
        return topology && { type: 'topology', id: t.id, topology }
      }
      case 'script': {
        const script = await lookup(`script ${t.scriptId}`, () => getScript(t.scriptId))
        return script && { type: 'script', id: t.id, script }
      }
      case 'settings':
        return t
    }
  }))
  const tabs = resolved.filter((t): t is ResolvedTab => t !== null)

  const popouts = snapshot.popouts.flatMap((p): ResolvedPopout[] => {
    if (p.kind === 'chat') return [p]
    const terminal = resolveTerminal(p.tab)
    return terminal ? [{ ...p, terminal }] : []
  })

  return {
    tabs,
    activeTabId: tabs.some(t => t.id === snapshot.activeTabId) ? snapshot.activeTabId : (tabs.at(-1)?.id ?? null),
    popouts,
  }
}

/** Window options for a restored popout: its saved size, plus its saved
 *  position while that still lands on a connected monitor. */
export async function popoutWindowBounds(bounds: PopoutBounds | undefined): Promise<Partial<PopoutBounds>> {
  if (!bounds) return {}
  const { availableMonitors } = await import('@tauri-apps/api/window')
  const monitors = await availableMonitors()
  const onScreen = monitors.some((m) => {
    const pos = m.position.toLogical(m.scaleFactor)
    const size = m.size.toLogical(m.scaleFactor)
    return bounds.x >= pos.x && bounds.x < pos.x + size.width && bounds.y >= pos.y && bounds.y < pos.y + size.height
  })
  return onScreen ? bounds : { width: bounds.width, height: bounds.height }
}
