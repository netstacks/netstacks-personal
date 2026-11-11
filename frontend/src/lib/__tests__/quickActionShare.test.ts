import { describe, expect, it } from 'vitest'
import type { ApiResource, QuickAction } from '../../types/quickAction'
import { buildShareFile, parseShareFile, planImport, serializeShareFile, shareFileName, toCreateRequest } from '../quickActionShare'

const netbox: ApiResource = {
  id: 'r1', name: 'NetBox', base_url: 'https://netbox.example/api', auth_type: 'bearer_token',
  auth_header_name: null, auth_header_prefix: 'Token', auth_flow: null,
  default_headers: { Accept: 'application/json', Authorization: 'Token s3cr3t' },
  custom_headers: [{ name: 'X-Api-Key', value: 'literal-secret' }, { name: 'X-Env', value: 'lab' }],
  verify_ssl: true, timeout_secs: 30, has_credentials: true, test_path: '/status/', created_at: '', updated_at: '',
}
const librenms: ApiResource = { ...netbox, id: 'r2', name: 'LibreNMS', base_url: 'https://nms.example/api/v0', default_headers: {}, custom_headers: [] }

const action = (over: Partial<QuickAction>): QuickAction => ({
  id: 'a', name: 'Get devices', description: null, api_resource_id: 'r1', method: 'GET', path: '/dcim/devices/',
  headers: { Authorization: '{{token}}', 'X-Trace': '1' }, body: null, json_extract_path: 'results[0].comments',
  icon: null, color: null, sort_order: 0, category: null, created_at: '', updated_at: '', ...over,
})

describe('buildShareFile', () => {
  it('carries requests and resource shapes but strips secrets', () => {
    const file = buildShareFile([action({}), action({ id: 'b', name: 'Sites', path: '/dcim/sites/', api_resource_id: 'r2' })], [netbox, librenms])
    expect(file.format).toBe('netstacks-api-requests')
    expect(file.resources.map((r) => r.key)).toEqual(['NetBox', 'LibreNMS'])
    const nb = file.resources[0]
    expect(nb.default_headers?.Authorization).toBe('')
    expect(nb.default_headers?.Accept).toBe('application/json')
    expect(nb.custom_headers).toEqual([{ name: 'X-Api-Key', value: '' }, { name: 'X-Env', value: 'lab' }])
    expect(JSON.stringify(file)).not.toContain('s3cr3t')
    expect(JSON.stringify(file)).not.toContain('literal-secret')
    // templated auth headers survive
    expect(file.requests[0].headers.Authorization).toBe('{{token}}')
    expect(file.requests[1].resource).toBe('LibreNMS')
  })

  it('round-trips through serialize/parse', () => {
    const file = buildShareFile([action({})], [netbox])
    const parsed = parseShareFile(serializeShareFile(file))
    expect(parsed.requests).toEqual(file.requests)
    expect(shareFileName([action({})])).toMatch(/^netstacks-api-Get_devices-\d{4}-\d{2}-\d{2}\.json$/)
    expect(shareFileName([action({}), action({ id: 'b' })])).toMatch(/^netstacks-api-2-requests-/)
  })
})

describe('parseShareFile', () => {
  it('rejects junk and other formats with readable errors', () => {
    expect(() => parseShareFile('nope')).toThrow('Not valid JSON')
    expect(() => parseShareFile('{"format":"netstacks-sessions"}')).toThrow('wrong format')
    expect(() => parseShareFile('{"format":"netstacks-api-requests","version":9,"requests":[]}')).toThrow('Unsupported file version')
    expect(() => parseShareFile('{"format":"netstacks-api-requests","version":1,"requests":[]}')).toThrow('no requests')
    expect(() => parseShareFile('{"format":"netstacks-api-requests","version":1,"requests":[{"name":"x"}]}')).toThrow('missing')
  })
})

describe('planImport', () => {
  const file = buildShareFile(
    [action({}), action({ id: 'b', name: 'Get sites', path: '/dcim/sites/' }), action({ id: 'c', name: 'Alerts', api_resource_id: 'r2', path: '/alerts' })],
    [netbox, librenms],
  )

  it('matches resources by name, then base URL, and creates the rest without credentials', () => {
    const renamed: ApiResource = { ...netbox, id: 'x1', name: 'NetBox (prod)' } // same URL, different name
    const plan = planImport(file, [renamed], [])
    expect(plan.matchedResources).toEqual([{ key: 'NetBox', resourceId: 'x1', how: 'base_url' }])
    expect(plan.createResources.map((c) => c.key)).toEqual(['LibreNMS'])
    expect(plan.createResources[0].request).not.toHaveProperty('auth_token')
    expect(plan.requests.map((r) => r.resourceRef)).toEqual(['x1', 'x1', 'create:LibreNMS'])
  })

  it('skips identical requests and renames same-name conflicts', () => {
    const existing = [
      action({ id: 'e1', name: 'Get devices' }),                       // identical → skipped
      action({ id: 'e2', name: 'Get sites', path: '/dcim/sites/?limit=5' }), // same name, different path → renamed
    ]
    const plan = planImport(file, [netbox, librenms], existing)
    expect(plan.requests[0].skipped).toBe('already exists')
    expect(plan.requests[1].name).toBe('Get sites (imported)')
    expect(plan.requests[2].skipped).toBeUndefined()
    const create = toCreateRequest(plan.requests[1], 'r1')
    expect(create).toMatchObject({ name: 'Get sites (imported)', api_resource_id: 'r1', method: 'GET', path: '/dcim/sites/' })
  })

  it('flags requests whose resource is not in the file', () => {
    const broken = { ...file, requests: [{ ...file.requests[0], resource: 'Ghost' }] }
    const plan = planImport(broken, [netbox], [])
    expect(plan.requests[0].skipped).toContain('unknown resource')
  })
})
