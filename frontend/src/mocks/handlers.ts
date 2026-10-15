import { http, HttpResponse, ws } from 'msw'
import type { ConnectionHistory, Folder, JumpDependents, JumpHost, Session, VaultStatus } from '../api/sessions'
import type { ActiveMatchersResult, EnrichmentMatcher, EnrichmentSource } from '../api/enrichment'
import type { Document, NewDocument } from '../api/docs'
import type { AiEngineerProfile } from '../api/aiEngineerProfile'
import type { AiMemory, ConfigModeStatus, ProviderModel, ProviderModelsResult } from '../api/ai'
import type { SearchHit } from '../api/search'
import type { CredentialProfile, ProfileCredentialMeta } from '../api/profiles'
import type { CustomCommand } from '../api/customCommands'
import type { GroupDTO } from '../api/groups'
import type { HighlightRule } from '../api/highlightRules'
import type { HostKeyPrompt, TrustedHostKey } from '../api/hostKeys'
import type { SessionContext } from '../types/sessionContext'
import type { DeviceMemoryWithEntries } from '../types/deviceMemory'
import type { GlobalSnippet } from '../api/snippets'
import type { BiometricStatus } from '../api/vault'
import type { Recording } from '../api/recordings'
import type { DbInfo } from '../api/db'
import type { SmtpConfig } from '../api/smtp'
import type { LspPluginListItem } from '../lsp/types'
import type { UserPluginInput } from '../lsp/installationApi'
import type { LibreNmsSource } from '../api/librenms'
import type { MappedKey } from '../api/mappedKeys'
import type { McpServer } from '../api/mcp'
import type { NetStacksCrawlerSource } from '../api/netstacksCrawler'
import type { PendingInteraction } from '../api/taskApprovals'
import type { QuickPrompt } from '../api/quickPrompts'
import type { TunnelRuntimeState, TunnelWithState } from '../api/tunnels'
import type { Folder as TopologyFolder, SavedTopologyListItem } from '../api/topology'
import type { Change } from '../types/change'
import type { AgentDefinition } from '../api/agentDefinitions'
import type { Script } from '../api/scripts'
import type { ApiResource, QuickAction } from '../types/quickAction'
import type { NetBoxSource } from '../api/netboxSources'

const API = '*/api'
const STAMP = '2026-01-01T00:00:00Z'

let nextId = 1000
const notFound = () => new HttpResponse(null, { status: 404 })

/**
 * Stateful REST collection: list, get, create (body merged over `defaults`),
 * update (PUT/PATCH merge) and delete — so dialogs can save in the mock.
 */
function collection<T extends { id: string }>(path: string, items: T[], defaults: () => Partial<T> = () => ({})) {
  const at = (id: string) => items.findIndex(item => item.id === id)
  const update = async ({ params, request }: { params: { id: string }; request: Request }) => {
    const index = at(params.id)
    if (index < 0) return notFound()
    items[index] = { ...items[index], ...(await request.json() as Partial<T>), id: params.id, updated_at: STAMP }
    return HttpResponse.json(items[index])
  }
  return [
    http.get(`${API}/${path}`, () => HttpResponse.json(items)),
    http.get<{ id: string }>(`${API}/${path}/:id`, ({ params }) => {
      const index = at(params.id)
      return index < 0 ? notFound() : HttpResponse.json(items[index])
    }),
    http.post(`${API}/${path}`, async ({ request }) => {
      const item = { created_at: STAMP, updated_at: STAMP, ...defaults(), ...(await request.json() as Partial<T>), id: `${path.split('/').pop()}-${nextId++}` } as unknown as T
      items.push(item)
      return HttpResponse.json(item)
    }),
    http.put<{ id: string }>(`${API}/${path}/:id`, update),
    http.patch<{ id: string }>(`${API}/${path}/:id`, update),
    http.delete<{ id: string }>(`${API}/${path}/:id`, ({ params }) => {
      const index = at(params.id)
      if (index >= 0) items.splice(index, 1)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

const folders: Folder[] = [
  { id: 'folder-core', name: 'Core', parent_id: null, sort_order: 0, created_at: STAMP, updated_at: STAMP },
]

function session(id: string, name: string, host: string, folderId: string | null, sortOrder: number): Session {
  return {
    id, name, host, folder_id: folderId, port: 22, color: null, icon: null, sort_order: sortOrder,
    last_connected_at: null, created_at: STAMP, updated_at: STAMP,
    auto_reconnect: false, reconnect_delay: 5, scrollback_lines: 10000, local_echo: false,
    font_size_override: null, font_family: null, profile_id: 'profile-default',
    netbox_device_id: null, netbox_source_id: null, cli_flavor: 'auto', terminal_theme: null,
    jump_host_id: null, jump_session_id: null, legacy_ssh: false, protocol: 'ssh',
    port_forwards: [], auto_commands: [], sftp_start_path: null,
    console_host: null, console_port: null, console_protocol: 'ssh', console_profile_id: null, console_legacy_ssh: false,
  }
}

const groups: GroupDTO[] = []

const documents: Document[] = [
  {
    id: 'doc-1', name: 'core-rtr-01 bgp summary', category: 'outputs', content_type: 'text',
    content: 'BGP router identifier 10.0.0.1, local AS number 65001\n\nNeighbor        V    AS MsgRcvd MsgSent  Up/Down State/PfxRcd\n192.0.2.2       4 65002    1204    1198 2d03h           842\n',
    parent_folder: null, session_id: 'session-core-1', created_at: STAMP, updated_at: STAMP,
  },
]

const sessions: Session[] = [
  session('session-core-1', 'core-rtr-01', '192.0.2.1', 'folder-core', 0),
  session('session-core-2', 'core-rtr-02', '192.0.2.2', 'folder-core', 1),
  session('session-edge-1', 'edge-sw-01', '198.51.100.10', null, 2),
]

// `?vault=locked` starts the mock on the unlock screen; any password unlocks it.
const vaultStatus: VaultStatus = {
  unlocked: new URLSearchParams(window.location.search).get('vault') !== 'locked',
  has_master_password: true,
}
const activeMatchers: ActiveMatchersResult = { matchers: [], crawler_available: false, netbox_available: false }
const biometricStatus: BiometricStatus = { supported: true, enrolled: false, enabled: false }
const configModeStatus: ConfigModeStatus = { enabled: false, expires_at: null, seconds_remaining: null }
const noJumpDependents: JumpDependents = { sessions: [], tunnels: [], profiles: [] }

const profiles: CredentialProfile[] = [{
  id: 'profile-default', name: 'NOC Default', username: 'netops', auth_type: 'key', key_path: '~/.ssh/id_ed25519',
  port: 22, keepalive_interval: 30, connection_timeout: 10, terminal_theme: null, default_font_size: null,
  default_font_family: null, scrollback_lines: 10000, local_echo: false, auto_reconnect: false, reconnect_delay: 5,
  cli_flavor: 'auto', auto_commands: [], jump_host_id: null, jump_session_id: null, created_at: STAMP, updated_at: STAMP,
}]

const jumpHosts: JumpHost[] = [
  { id: 'jump-bastion-east', name: 'bastion-east', host: 'bastion-east.example.net', port: 22, profile_id: 'profile-default', created_at: STAMP, updated_at: STAMP },
  { id: 'jump-oob', name: 'oob-gw', host: '203.0.113.5', port: 2222, profile_id: 'profile-default', created_at: STAMP, updated_at: STAMP },
]

function sessionContext(sessionId: string): SessionContext[] {
  return [{
    id: 'ctx-2', session_id: sessionId, issue: 'SSH sessions from the jump host time out after 60s idle',
    root_cause: 'exec-timeout 1 0 on vty 0 4 left over from an audit change',
    resolution: 'Set exec-timeout 15 0 on vty 0 15',
    commands: 'show running-config | section line vty',
    ticket_ref: null, author: 'jsmith', created_at: '2026-09-30T14:20:00Z', updated_at: '2026-09-30T14:20:00Z',
  }, {
    id: 'ctx-1', session_id: sessionId, issue: 'Uplink Te1/0/48 flapping during nightly backups',
    root_cause: 'Storm-control broadcast threshold too low for backup bursts',
    resolution: 'Raised storm-control broadcast level to 5.00 on the uplink',
    commands: 'show interfaces Te1/0/48 counters errors\nshow storm-control Te1/0/48',
    ticket_ref: 'NET-4182', author: 'netops', created_at: STAMP, updated_at: STAMP,
  }]
}

function deviceMemory(sessionId: string): DeviceMemoryWithEntries {
  return {
    id: 'mem-1', session_id: sessionId, role: 'Access Switch', criticality: 'medium',
    standing_instructions: 'Do not bounce Po1 during business hours.', notes: 'IDF-2 stack of 2, members swapped 2025-11.',
    created_at: STAMP, updated_at: STAMP,
    entries: [
      { id: 'mem-entry-1', device_memory_id: 'mem-1', date: '2026-01-12', source: 'manual', author: 'netops', content: 'Replaced SFP in Te1/0/48 (CRC errors).', created_at: STAMP, updated_at: STAMP },
      { id: 'mem-entry-2', device_memory_id: 'mem-1', date: '2026-02-03', source: 'troubleshooting', author: 'netops', content: 'Storm-control threshold raised to 5.00 on uplink.', created_at: STAMP, updated_at: STAMP },
    ],
  }
}

const providerModels: Record<string, ProviderModel[]> = {
  anthropic: [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ],
}

const aiProfile: { current: AiEngineerProfile | null } = { current: null }

const aiMemories: AiMemory[] = [
  { id: 'aimem-1', content: 'Core routers run IOS-XR; use "show route ipv4" not "show ip route".', category: 'network', source: 'ai', created_at: STAMP, updated_at: STAMP },
  { id: 'aimem-2', content: 'Prefer change windows Tue/Thu 22:00-02:00 UTC.', category: 'procedure', source: 'user', created_at: STAMP, updated_at: STAMP },
]

const knowledgePackSizes = {
  total_budget: 5000, core_size: 1200, available_budget: 3800,
  packs: [
    { category: 'core', name: 'core', size: 1200 },
    { category: 'domain', name: 'routing', size: 950 },
    { category: 'domain', name: 'datacenter', size: 820 },
    { category: 'vendor', name: 'cisco', size: 1100 },
    { category: 'vendor', name: 'juniper', size: 900 },
  ],
}

const snippets: GlobalSnippet[] = [
  { id: 'snip-1', session_id: null, name: 'BGP summary', command: 'show bgp ipv4 unicast summary', sort_order: 0, created_at: STAMP },
  { id: 'snip-2', session_id: null, name: 'Interface errors', command: 'show interfaces | include (line protocol|CRC)', sort_order: 1, created_at: STAMP },
  { id: 'snip-3', session_id: null, name: 'Save config', command: 'copy running-config startup-config', sort_order: 2, created_at: STAMP },
]

const enrichmentMatchers: EnrichmentMatcher[] = [
  {
    id: 'builtin-ipv4', name: 'ipv4', description: 'IPv4 addresses anywhere in terminal output',
    patterns: ['\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b'], cli_flavors: [], priority: 10, is_builtin: true,
    source_ids: ['builtin-dns-ptr', 'builtin-netbox-ip'], created_at: STAMP, updated_at: STAMP,
  },
  {
    id: 'builtin-junos-interface', name: 'junos_interface', description: 'Juniper interface names (ge-0/0/0, xe-0/1/0, etc.)',
    patterns: ['\\b(?:ge|xe|et|ae|lo|irb|em|fxp|vme)-\\d+/\\d+/\\d+(?:\\.\\d+)?\\b'], cli_flavors: ['juniper'], priority: 10, is_builtin: true,
    source_ids: [], created_at: STAMP, updated_at: STAMP,
  },
]

const enrichmentSources: EnrichmentSource[] = [
  {
    id: 'builtin-dns-ptr', name: 'dns_ptr', description: 'Reverse DNS lookup (PTR) for an IP', kind: 'builtin',
    api_resource_id: null, method: 'GET', path_template: '', response_unwrap: '',
    picked_fields: [{ key: 'ptr', label: 'PTR', format: 'string' }], is_builtin: true, created_at: STAMP, updated_at: STAMP,
  },
  {
    id: 'builtin-netbox-ip', name: 'netbox_ip', description: 'NetBox IP address assignment (device / VRF / status)', kind: 'api_resource',
    api_resource_id: null, method: 'GET', path_template: '/api/ipam/ip-addresses/?address={token_url}', response_unwrap: 'results.0',
    picked_fields: [
      { key: 'assigned_object.device.name', label: 'Device', format: 'string' },
      { key: 'status.label', label: 'Status', format: 'status_pill' },
    ],
    is_builtin: true, created_at: STAMP, updated_at: STAMP,
  },
]

const trustedHostKeys: TrustedHostKey[] = [
  { host: '192.0.2.1', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:4f9Qm1yXbT0cZp8sVt2LwKjR7eN3uH6aDgYiBoC5xMk' },
  { host: '192.0.2.2', port: 22, key_type: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:Zt7Hn2KqP0wLs9VbX4cR1mJy8gFe6UaD3iTo5NkQhWs' },
  { host: 'bastion-east.example.net', port: 22, key_type: 'ssh-rsa', fingerprint: 'SHA256:b8Lr3XoV1nYq6TfK0sWd9JzC2mPg7HaE4uRi5NcMxQe' },
]

const recordings: Recording[] = [
  { id: 'rec-1', session_id: 'session-core-1', name: 'core-rtr-01 IOS-XR upgrade', terminal_cols: 160, terminal_rows: 48, duration_ms: 1_284_000, file_path: 'recordings/rec-1.cast', created_at: STAMP, updated_at: STAMP },
  { id: 'rec-2', session_id: 'session-edge-1', name: 'edge-sw-01 uplink troubleshooting', terminal_cols: 120, terminal_rows: 40, duration_ms: 312_500, file_path: 'recordings/rec-2.cast', created_at: STAMP, updated_at: STAMP },
]

const layouts = [
  { id: 'layout-core', name: 'Core pair', session_ids: ['session-core-1', 'session-core-2'], orientation: 'horizontal', sizes: [50, 50], created_at: STAMP, updated_at: STAMP },
]

interface GitAccount {
  id: string; name: string; provider: string; host: string; auth_method: string
  has_credential: boolean; is_default: boolean; created_at: string; updated_at: string
}

const gitAccounts: { accounts: GitAccount[] } = {
  accounts: [
    { id: 'git-1', name: 'Network configs', provider: 'gitlab-selfhosted', host: 'gitlab.example.net', auth_method: 'pat', has_credential: true, is_default: true, created_at: STAMP, updated_at: STAMP },
  ],
}

const dbInfo: DbInfo = {
  path: '/Users/netops/Library/Application Support/netstacks/netstacks.db',
  dir: '/Users/netops/Library/Application Support/netstacks',
  size_bytes: 4_718_592,
}

const lspPlugins: LspPluginListItem[] = [{
  id: 'pyrefly', displayName: 'Pyrefly', language: 'python', fileExtensions: ['.py', '.pyi'], defaultEnabled: true,
  unavailableInEnterprise: true, source: 'built-in', installation: { kind: 'on-demand-download', version: '1.0.0', sources: {} },
  runtime: { command: 'pyrefly', args: ['lsp'] }, installStatus: 'installed',
}]

const smtpConfig: SmtpConfig = {
  host: 'smtp.example.net', port: 587, username: 'netstacks-alerts', use_tls: true,
  from_email: 'netstacks@example.net', from_name: 'NetStacks', has_password: true,
}

const terminalSocket = ws.link('*/ws/terminal')
const tasksSocket = ws.link('*/ws/tasks')

export const handlers = [
  // Vault + agent settings (an unset agent setting is JSON null)
  http.get(`${API}/vault/status`, () => HttpResponse.json(vaultStatus)),
  http.post(`${API}/vault/unlock`, () => {
    vaultStatus.unlocked = true
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API}/vault/api-keys/:keyType/exists`, () => HttpResponse.json({ exists: false })),
  http.get(`${API}/settings/:key`, () => HttpResponse.json(null)),
  http.put(`${API}/settings/:key`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API}/vault/biometric/status`, () => HttpResponse.json(biometricStatus)),
  http.get(`${API}/db/info`, () => HttpResponse.json(dbInfo)),
  http.get(`${API}/smtp/config`, () => HttpResponse.json(smtpConfig)),

  // Sessions sidebar + session settings dialog
  ...collection('folders', folders, () => ({ parent_id: null, sort_order: folders.length })),
  http.get(`${API}/search`, ({ request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase()
    const results: SearchHit[] = sessions
      .filter(s => s.name.toLowerCase().includes(q) || s.host.includes(q))
      .map(s => ({ type: 'session', id: s.id, title: s.name, subtitle: s.host, score: 1 }))
    return HttpResponse.json({ results })
  }),
  ...collection('sessions', sessions, () => session('', '', '', null, sessions.length)),
  http.post(`${API}/sessions/bulk-delete`, async ({ request }) => {
    const { ids } = await request.json() as { ids: string[] }
    for (const id of ids) {
      const index = sessions.findIndex(s => s.id === id)
      if (index >= 0) sessions.splice(index, 1)
    }
    return HttpResponse.json({ deleted: ids.length, failed: 0 })
  }),
  http.get<{ id: string }>(`${API}/sessions/:id/highlight-rules/effective`, () => HttpResponse.json<HighlightRule[]>([])),
  http.get<{ id: string }>(`${API}/sessions/:id/jump-dependents`, () => HttpResponse.json(noJumpDependents)),
  http.get<{ id: string }>(`${API}/sessions/:id/context`, ({ params }) => HttpResponse.json(sessionContext(params.id))),
  http.get<{ id: string }>(`${API}/sessions/:id/device-memory`, ({ params }) => HttpResponse.json(deviceMemory(params.id))),
  ...collection('groups', groups),
  ...collection('history', [] as ConnectionHistory[]),
  ...collection('profiles', profiles),
  http.put(`${API}/profiles/:id/credential`, () => new HttpResponse(null, { status: 204 })),
  http.delete(`${API}/profiles/:id/credential`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API}/profiles/:id/credential`, () => HttpResponse.json<ProfileCredentialMeta>({ has_password: true, has_key_passphrase: false, snmp_community_count: 1 })),
  ...collection('jump-hosts', jumpHosts),
  http.get(`${API}/host-keys`, () => HttpResponse.json(trustedHostKeys)),
  http.get(`${API}/host-keys/prompts`, () => HttpResponse.json<HostKeyPrompt[]>([])),
  ...collection('snippets', snippets),
  ...collection('recordings', recordings),
  ...collection('layouts', layouts),

  // Tunnels (auto-start on boot)
  http.post(`${API}/tunnels/start-all`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API}/tunnels/status`, () => HttpResponse.json<TunnelRuntimeState[]>([])),
  ...collection('tunnels', [] as TunnelWithState[]),

  // Terminal features
  http.get(`${API}/enrich/active-matchers`, () => HttpResponse.json(activeMatchers)),
  ...collection('enrichment-matchers', enrichmentMatchers, () => ({ description: '', patterns: [], cli_flavors: [], priority: 10, is_builtin: false, source_ids: [] })),
  ...collection('enrichment-sources', enrichmentSources),
  http.post(`${API}/enrichment/reload`, () => new HttpResponse(null, { status: 204 })),
  ...collection('highlight-rules', [] as HighlightRule[]),
  ...collection('mapped-keys', [] as MappedKey[]),
  ...collection('custom-commands', [] as CustomCommand[]),

  // AI + integrations
  http.get(`${API}/ai/profile`, () => HttpResponse.json<{ profile: AiEngineerProfile | null }>({ profile: aiProfile.current })),
  http.put(`${API}/ai/profile`, async ({ request }) => {
    aiProfile.current = await request.json() as AiEngineerProfile
    return new HttpResponse(null, { status: 204 })
  }),
  http.delete(`${API}/ai/profile`, () => {
    aiProfile.current = null
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API}/ai/profile/status`, () => HttpResponse.json({ onboarded: aiProfile.current?.onboarding_completed ?? false })),
  // The mock has no AI provider: chat answers like the agent does without a key.
  http.post(`${API}/ai/chat`, () => HttpResponse.json(
    { code: 'NOT_CONFIGURED', error: 'AI not configured. Add your API key in Settings > AI.' },
    { status: 503 },
  )),
  http.get(`${API}/ai/config-mode/status`, () => HttpResponse.json(configModeStatus)),
  http.get<{ provider: string }>(`${API}/ai/providers/:provider/models`, ({ params }) =>
    HttpResponse.json<ProviderModelsResult>({ models: providerModels[params.provider] ?? [], source: 'live' })),
  http.get(`${API}/ai/memory`, () => HttpResponse.json({ memories: aiMemories })),
  http.post(`${API}/ai/memory`, async ({ request }) => {
    const memory: AiMemory = { ...(await request.json() as Pick<AiMemory, 'content' | 'category' | 'source'>), id: `aimem-${nextId++}`, created_at: STAMP, updated_at: STAMP }
    aiMemories.push(memory)
    return HttpResponse.json(memory)
  }),
  http.put<{ id: string }>(`${API}/ai/memory/:id`, async ({ params, request }) => {
    const index = aiMemories.findIndex(m => m.id === params.id)
    if (index < 0) return notFound()
    aiMemories[index] = { ...aiMemories[index], ...(await request.json() as Partial<AiMemory>), updated_at: STAMP }
    return new HttpResponse(null, { status: 204 })
  }),
  http.delete<{ id: string }>(`${API}/ai/memory/:id`, ({ params }) => {
    const index = aiMemories.findIndex(m => m.id === params.id)
    if (index >= 0) aiMemories.splice(index, 1)
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API}/ai/knowledge-pack-sizes`, () => HttpResponse.json(knowledgePackSizes)),
  ...collection('quick-prompts', [] as QuickPrompt[]),
  ...collection('mcp/servers', [] as McpServer[], () => ({ args: [], url: null, enabled: true, connected: false, tools: [] })),
  http.get(`${API}/task-approvals`, () => HttpResponse.json<PendingInteraction[]>([])),
  ...collection('librenms-sources', [] as LibreNmsSource[]),
  ...collection('netstacks-crawler-sources', [] as NetStacksCrawlerSource[]),

  // Sidebar panels (topology, changes, agents, workspaces)
  http.get(`${API}/topologies`, () => HttpResponse.json<SavedTopologyListItem[]>([])),
  http.get(`${API}/topologies/folders`, () => HttpResponse.json<TopologyFolder[]>([])),
  http.get(`${API}/changes`, () => HttpResponse.json<Change[]>([])),
  ...collection('agent-definitions', [] as AgentDefinition[]),
  ...collection('scripts', [] as Script[]),
  ...collection('api-resources', [] as ApiResource[]),
  ...collection('quick-actions', [] as QuickAction[]),
  ...collection('netbox-sources', [] as NetBoxSource[]),
  http.get(`${API}/workspace/git/accounts`, () => HttpResponse.json(gitAccounts)),
  http.post(`${API}/workspace/git/accounts/create`, async ({ request }) => {
    const { credential, ...fields } = await request.json() as Omit<GitAccount, 'id' | 'has_credential' | 'created_at' | 'updated_at'> & { credential?: string }
    const account: GitAccount = { ...fields, id: `git-${nextId++}`, has_credential: Boolean(credential), created_at: STAMP, updated_at: STAMP }
    gitAccounts.accounts.push(account)
    return HttpResponse.json(account)
  }),
  http.post(`${API}/workspace/git/accounts/update`, async ({ request }) => {
    const { id, credential, ...fields } = await request.json() as Partial<GitAccount> & { id: string; credential?: string }
    const index = gitAccounts.accounts.findIndex(a => a.id === id)
    if (index < 0) return notFound()
    gitAccounts.accounts[index] = { ...gitAccounts.accounts[index], ...fields, has_credential: gitAccounts.accounts[index].has_credential || Boolean(credential), updated_at: STAMP }
    return HttpResponse.json(gitAccounts.accounts[index])
  }),
  http.post(`${API}/workspace/git/accounts/delete`, async ({ request }) => {
    const { id } = await request.json() as { id: string }
    gitAccounts.accounts = gitAccounts.accounts.filter(a => a.id !== id)
    return new HttpResponse(null, { status: 204 })
  }),
  http.post(`${API}/workspace/git/accounts/test`, () => HttpResponse.json({ connected: true, username: 'netops' })),
  http.get('*/lsp/plugins', () => HttpResponse.json(lspPlugins)),
  http.post('*/lsp/plugins/test', () => HttpResponse.json({ success: true })),
  http.post('*/lsp/plugins', async ({ request }) => {
    const input = await request.json() as UserPluginInput
    const plugin: LspPluginListItem = {
      id: input.id, displayName: input.displayName, language: input.language, fileExtensions: input.fileExtensions,
      defaultEnabled: true, unavailableInEnterprise: true, source: 'user-added', installation: { kind: 'system-path', defaultCommand: input.command },
      runtime: { command: input.command, args: input.args }, installStatus: 'installed',
    }
    lspPlugins.push(plugin)
    return HttpResponse.json(plugin, { status: 201 })
  }),

  // Documents
  // A fixed name keeps the visual baselines deterministic (the app names new docs by time).
  http.post<never, NewDocument>(`${API}/docs`, async ({ request }) => {
    const body = await request.json()
    const doc: Document = {
      id: `doc-${nextId++}`, name: 'Untitled', category: body.category, content_type: body.content_type,
      content: body.content, parent_folder: null, session_id: null, created_at: STAMP, updated_at: STAMP,
    }
    documents.push(doc)
    return HttpResponse.json(doc)
  }),
  ...collection('docs', documents),

  // WebSockets
  terminalSocket.addEventListener('connection', ({ client }) => {
    client.send(JSON.stringify({ type: 'Connected' }))
    client.send(JSON.stringify({ type: 'Output', data: 'NetStacks mock terminal\r\n\r\ncore-rtr-01# ' }))
  }),
  tasksSocket.addEventListener('connection', () => {}),
]
