import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Session } from '../api/sessions'

vi.mock('../api/sessions', async () => {
  const actual = await vi.importActual<typeof import('../api/sessions')>('../api/sessions')
  return { ...actual, listSessions: vi.fn() }
})
vi.mock('../api/profiles', () => ({ listProfiles: vi.fn() }))
vi.mock('../api/enterpriseSessions', () => ({ getSessionDefinition: vi.fn() }))
vi.mock('../api/enterpriseDevices', () => ({ getEnterpriseDevice: vi.fn() }))
vi.mock('../api/docs', () => ({ getDocument: vi.fn() }))
vi.mock('../api/topology', () => ({ getTopology: vi.fn() }))
vi.mock('../api/scripts', () => ({ getScript: vi.fn() }))

import { listSessions } from '../api/sessions'
import { listProfiles } from '../api/profiles'
import { getSessionDefinition } from '../api/enterpriseSessions'
import { getEnterpriseDevice } from '../api/enterpriseDevices'
import { getDocument } from '../api/docs'
import { getTopology } from '../api/topology'
import { getScript } from '../api/scripts'
import {
  createTabSnapshot,
  parseTabSnapshot,
  readTabSnapshot,
  resolveTabSnapshot,
  writeTabSnapshot,
  type TabSnapshot,
} from './tabRestore'

const STANDALONE = { isEnterprise: false, canDocs: true, canTopology: true }

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    name: 'core-sw1',
    profile_id: 'p1',
    protocol: 'ssh',
    cli_flavor: 'auto',
    color: null,
    font_size_override: null,
    font_family: null,
    terminal_theme: null,
    scrollback_lines: 5000,
    auto_reconnect: true,
    reconnect_delay: 5,
    console_host: null,
    console_port: null,
    console_profile_id: null,
    ...overrides,
  } as Session
}

function notFound() {
  return Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404, data: {} },
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(listSessions).mockResolvedValue([])
  vi.mocked(listProfiles).mockResolvedValue([])
  vi.mocked(getDocument).mockRejectedValue(notFound())
  vi.mocked(getTopology).mockRejectedValue(notFound())
  vi.mocked(getScript).mockRejectedValue(notFound())
})

describe('createTabSnapshot', () => {
  it('keeps order and stable references only, never connection state or content', () => {
    const snapshot = createTabSnapshot([
      { id: 'ssh-1', type: 'terminal', sessionId: 's1', protocol: 'ssh' },
      { id: 'local-1', type: 'terminal' },
      { id: 'doc-1', type: 'document', documentId: 'd1' },
      { id: 'unsaved-1', type: 'document' },
      { id: 'topo-1', type: 'topology', topologyId: 't1' },
      { id: 'trace-1', type: 'topology', topologyId: 'tmp', isTemporaryTopology: true },
      { id: 'settings', type: 'settings' },
      { id: 'device-1', type: 'device-detail' },
    ], 'doc-1', [])

    expect(snapshot).toEqual({
      tabs: [
        { type: 'terminal', id: 'ssh-1', sessionId: 's1', protocol: 'ssh' },
        { type: 'document', id: 'doc-1', documentId: 'd1' },
        { type: 'topology', id: 'topo-1', topologyId: 't1' },
        { type: 'settings', id: 'settings' },
      ],
      activeTabId: 'doc-1',
      popouts: [],
    })
  })

  it('snapshots enterprise terminals by session definition, not the live controller session id', () => {
    const snapshot = createTabSnapshot([
      { id: 'ent-1', type: 'terminal', sessionId: 'live-ssh-123', enterpriseSessionDefinitionId: 'def-1', enterpriseProfileId: 'prof-1' },
    ], null, [])
    expect(snapshot.tabs).toEqual([{ type: 'enterprise-terminal', id: 'ent-1', definitionId: 'def-1', profileId: 'prof-1' }])
  })

  it('drops the active tab when it is not restorable', () => {
    const snapshot = createTabSnapshot([
      { id: 'ssh-1', type: 'terminal', sessionId: 's1' },
      { id: 'device-1', type: 'device-detail' },
    ], 'device-1', [])
    expect(snapshot.activeTabId).toBeNull()
  })
})

describe('parseTabSnapshot', () => {
  it('round-trips through storage', () => {
    const snapshot: TabSnapshot = {
      tabs: [
        { type: 'terminal', id: 'console-1', sessionId: 's1', protocol: 'console' },
        { type: 'script', id: 'script-1', scriptId: 'sc1' },
      ],
      activeTabId: 'script-1',
      popouts: [
        { kind: 'terminal', label: 'popout-ssh-2', tab: { type: 'terminal', id: 'ssh-2', sessionId: 's2', protocol: 'ssh' }, bounds: { x: 10, y: 20, width: 800, height: 600 } },
        { kind: 'chat', label: 'popout-chat-1', title: 'Assistant' },
      ],
    }
    writeTabSnapshot(snapshot)
    expect(readTabSnapshot()).toEqual(snapshot)
  })

  it('drops malformed entries and ignores unreadable data', () => {
    const parsed = parseTabSnapshot(JSON.stringify({
      tabs: [
        { type: 'terminal', id: 'ok', sessionId: 's1', protocol: 'ssh' },
        { type: 'terminal', id: 'bad-protocol', sessionId: 's1', protocol: 'rdp' },
        { type: 'document', id: 'no-ref' },
        { type: 'mystery', id: 'x' },
        'garbage',
      ],
      activeTabId: 'ok',
      popouts: [{ kind: 'chat', label: 'popout-1', title: 'Chat', bounds: { x: 'left' } }],
    }))
    expect(parsed).toEqual({
      tabs: [{ type: 'terminal', id: 'ok', sessionId: 's1', protocol: 'ssh' }],
      activeTabId: 'ok',
      popouts: [{ kind: 'chat', label: 'popout-1', title: 'Chat', bounds: undefined }],
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseTabSnapshot('{not json')).toBeNull()
    errorSpy.mockRestore()
    expect(parseTabSnapshot(JSON.stringify({ tabs: 'nope' }))).toBeNull()
    expect(parseTabSnapshot(null)).toBeNull()
  })
})

describe('resolveTabSnapshot', () => {
  it('drops tabs whose session, document, topology or script no longer exists', async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ id: 's1' })])
    vi.mocked(getDocument).mockImplementation(async (id) => {
      if (id === 'd1') return { id: 'd1', name: 'Runbook', category: 'notes' } as never
      throw notFound()
    })

    const resolved = await resolveTabSnapshot({
      tabs: [
        { type: 'terminal', id: 'ssh-1', sessionId: 's1', protocol: 'ssh' },
        { type: 'terminal', id: 'ssh-gone', sessionId: 'deleted', protocol: 'ssh' },
        { type: 'document', id: 'doc-1', documentId: 'd1' },
        { type: 'document', id: 'doc-gone', documentId: 'd-deleted' },
        { type: 'topology', id: 'topo-gone', topologyId: 't-deleted' },
        { type: 'script', id: 'script-gone', scriptId: 'sc-deleted' },
        { type: 'settings', id: 'settings' },
      ],
      activeTabId: 'doc-1',
      popouts: [
        { kind: 'terminal', label: 'popout-ssh-gone', tab: { type: 'terminal', id: 'ssh-gone-2', sessionId: 'deleted', protocol: 'ssh' } },
      ],
    }, STANDALONE)

    expect(resolved.tabs.map(t => t.id)).toEqual(['ssh-1', 'doc-1', 'settings'])
    expect(resolved.activeTabId).toBe('doc-1')
    expect(resolved.popouts).toEqual([])
  })

  it('restores the saved active tab, else falls back to the last restored tab', async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ id: 's1' }), session({ id: 's2', name: 'edge-r1' })])
    const tabs: TabSnapshot['tabs'] = [
      { type: 'terminal', id: 'ssh-1', sessionId: 's1', protocol: 'ssh' },
      { type: 'terminal', id: 'ssh-2', sessionId: 's2', protocol: 'ssh' },
    ]

    expect((await resolveTabSnapshot({ tabs, activeTabId: 'ssh-1', popouts: [] }, STANDALONE)).activeTabId).toBe('ssh-1')
    expect((await resolveTabSnapshot({ tabs, activeTabId: 'gone', popouts: [] }, STANDALONE)).activeTabId).toBe('ssh-2')
    expect((await resolveTabSnapshot({ tabs: [], activeTabId: 'gone', popouts: [] }, STANDALONE)).activeTabId).toBeNull()
  })

  it('resolves terminals with the session and its profile defaults', async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ id: 's1', profile_id: 'p1', font_size_override: null })])
    vi.mocked(listProfiles).mockResolvedValue([{ id: 'p1', default_font_size: 16, default_font_family: null, terminal_theme: 'nord' } as never])

    const resolved = await resolveTabSnapshot({
      tabs: [{ type: 'terminal', id: 'ssh-1', sessionId: 's1', protocol: 'ssh' }],
      activeTabId: null,
      popouts: [],
    }, STANDALONE)

    expect(resolved.tabs[0]).toMatchObject({
      type: 'terminal',
      console: false,
      session: { id: 's1' },
      settings: { fontSize: 16, terminalTheme: 'nord', autoReconnect: true },
    })
  })

  it('drops console tabs whose session lost console access', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session({ id: 's1' }),
      session({ id: 's2', console_host: 'ts1', console_port: 2001 }),
    ])
    const resolved = await resolveTabSnapshot({
      tabs: [
        { type: 'terminal', id: 'console-1', sessionId: 's1', protocol: 'console' },
        { type: 'terminal', id: 'console-2', sessionId: 's2', protocol: 'console' },
      ],
      activeTabId: null,
      popouts: [],
    }, STANDALONE)
    expect(resolved.tabs).toEqual([expect.objectContaining({ id: 'console-2', console: true })])
  })

  it('skips document and topology lookups when those features are unavailable', async () => {
    const resolved = await resolveTabSnapshot({
      tabs: [
        { type: 'document', id: 'doc-1', documentId: 'd1' },
        { type: 'topology', id: 'topo-1', topologyId: 't1' },
      ],
      activeTabId: null,
      popouts: [],
    }, { isEnterprise: false, canDocs: false, canTopology: false })
    expect(resolved.tabs).toEqual([])
    expect(getDocument).not.toHaveBeenCalled()
    expect(getTopology).not.toHaveBeenCalled()
  })

  it('resolves enterprise terminals by fetching each session definition / device by id, never local sessions', async () => {
    vi.mocked(getSessionDefinition).mockImplementation(async (id) => {
      if (id === 'def-1') return { id: 'def-1', name: 'core-sw1', host: '10.0.0.1', port: 22, cli_flavor: 'cisco-ios' } as never
      throw notFound()
    })
    vi.mocked(getEnterpriseDevice).mockImplementation(async (id) => {
      if (id === 'dev-1') return { id: 'dev-1', name: 'edge-r1', host: '10.0.0.2', port: 2222 } as never
      throw notFound()
    })

    const resolved = await resolveTabSnapshot({
      tabs: [
        { type: 'enterprise-terminal', id: 'ent-1', definitionId: 'def-1', profileId: 'prof-1' },
        { type: 'enterprise-terminal', id: 'ent-2', definitionId: 'device-dev-1', profileId: '' },
        { type: 'enterprise-terminal', id: 'ent-gone', definitionId: 'def-deleted' },
        { type: 'terminal', id: 'ssh-1', sessionId: 's1', protocol: 'ssh' },
      ],
      activeTabId: 'ent-1',
      popouts: [],
    }, { isEnterprise: true, canDocs: true, canTopology: true })

    expect(listSessions).not.toHaveBeenCalled()
    // One request per referenced definition / device (GET /devices/browse/:id), no inventory walk.
    expect(vi.mocked(getEnterpriseDevice).mock.calls).toEqual([['dev-1']])
    expect(vi.mocked(getSessionDefinition).mock.calls.map(([id]) => id).sort()).toEqual(['def-1', 'def-deleted'])
    expect(resolved.tabs).toEqual([
      { type: 'enterprise-terminal', id: 'ent-1', definitionId: 'def-1', profileId: 'prof-1', title: 'core-sw1', cliFlavor: 'cisco-ios', host: '10.0.0.1', port: 22 },
      { type: 'enterprise-terminal', id: 'ent-2', definitionId: 'device-dev-1', profileId: '', title: 'edge-r1', cliFlavor: 'auto', host: '10.0.0.2', port: 2222 },
    ])
  })

  it('keeps popouts whose session still exists, with their saved geometry', async () => {
    vi.mocked(listSessions).mockResolvedValue([session({ id: 's2' })])
    const bounds = { x: 100, y: 80, width: 900, height: 640 }
    const tab = { type: 'terminal' as const, id: 'ssh-2', sessionId: 's2', protocol: 'ssh' as const }

    const resolved = await resolveTabSnapshot({
      tabs: [],
      activeTabId: null,
      popouts: [
        { kind: 'terminal', label: 'popout-ssh-2', tab, bounds },
        { kind: 'chat', label: 'popout-chat-1', title: 'Assistant' },
      ],
    }, STANDALONE)

    expect(resolved.popouts).toEqual([
      expect.objectContaining({ kind: 'terminal', label: 'popout-ssh-2', tab, bounds, terminal: expect.objectContaining({ id: 'ssh-2' }) }),
      { kind: 'chat', label: 'popout-chat-1', title: 'Assistant' },
    ])
  })
})
