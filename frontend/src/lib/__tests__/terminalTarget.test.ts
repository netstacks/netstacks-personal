import { describe, it, expect } from 'vitest'
import { buildTerminalWsParams, quickConnectTabFields } from '../terminalTarget'

const info = { host: ' r1.lab ', port: 2222, profile_id: 'prof-1', username: 'admin' }

describe('buildTerminalWsParams', () => {
  it('builds a remote URL for a standalone quick-connect tab, never type=local', () => {
    const fields = quickConnectTabFields(info, false, 'quick-1')
    const r = buildTerminalWsParams({ protocol: fields.protocol, ...fields })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('quick-connect')
    expect(r.params.get('type')).toBe('ssh')
    expect(r.params.get('host')).toBe('r1.lab')
    expect(r.params.get('port')).toBe('2222')
    expect(r.params.get('profile_id')).toBe('prof-1')
  })

  it('fails instead of falling back to a local shell when the remote target is incomplete', () => {
    for (const target of [
      { quickConnectHost: '  ', quickConnectProfileId: 'p' },
      { quickConnectHost: 'r1' },
      { quickConnectProfileId: 'p' },
      { quickConnectHost: 'r1', quickConnectProfileId: 'p', protocol: 'console' as const },
    ]) {
      const r = buildTerminalWsParams(target)
      expect(r.ok).toBe(false)
    }
  })

  it('uses the saved session when there is one', () => {
    const r = buildTerminalWsParams({ sessionId: 's1', protocol: 'telnet' })
    expect(r.ok && r.kind).toBe('session')
    expect(r.ok && r.params.get('type')).toBe('telnet')
    expect(r.ok && r.params.get('session_id')).toBe('s1')
  })

  it('opens a local PTY only for a tab with no remote target', () => {
    const r = buildTerminalWsParams({})
    expect(r.ok && r.kind).toBe('local')
    expect(r.ok && r.params.get('type')).toBe('local')
  })
})

describe('quickConnectTabFields', () => {
  it('keeps host/port/profile/username on a standalone tab', () => {
    const f = quickConnectTabFields(info, false, 'quick-1')
    expect(f).toMatchObject({
      title: 'admin@r1.lab', quickConnectHost: 'r1.lab', quickConnectPort: 2222,
      quickConnectProfileId: 'prof-1', profileId: 'prof-1',
    })
  })

  it('routes an enterprise tab through the Controller with host + profile_id', () => {
    const f = quickConnectTabFields({ ...info, profile_id: '' }, true, 'quick-2')
    expect(f).toMatchObject({
      title: 'admin@r1.lab', enterpriseTargetHost: 'r1.lab', enterpriseTargetPort: 2222,
      enterpriseProfileId: '', enterpriseSessionDefinitionId: 'quick-2',
    })
    expect(f).not.toHaveProperty('quickConnectHost')
  })
})
