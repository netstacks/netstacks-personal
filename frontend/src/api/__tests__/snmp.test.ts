import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = {
  get: vi.fn(),
  post: vi.fn(),
}

vi.mock('../client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => 'standalone',
}))

import { snmpTryInterfaceStats } from '../snmp'

describe('snmpTryInterfaceStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses a client timeout above the agent worst case (~20 s)', async () => {
    http.post.mockResolvedValueOnce({ data: {} })

    await snmpTryInterfaceStats({ host: '10.0.0.1', profileId: 'p1', interfaceName: 'Gi0/1' })

    const config = http.post.mock.calls[0][2] as { timeout: number }
    expect(config.timeout).toBeGreaterThan(20000)
  })

  it('does not append "(undefined)" when the request times out with no response', async () => {
    http.post.mockRejectedValueOnce(Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' }))

    const err = await snmpTryInterfaceStats({ host: '10.0.0.1', profileId: 'p1', interfaceName: 'Gi0/1' })
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('undefined')
    expect((err as Error).message).toContain('timeout of 25000ms exceeded')
  })

  it('keeps the status suffix when the agent answered with an HTTP error', async () => {
    http.post.mockRejectedValueOnce({ response: { status: 502, data: {} } })

    await expect(snmpTryInterfaceStats({ host: '10.0.0.1', profileId: 'p1', interfaceName: 'Gi0/1' }))
      .rejects.toThrow('SNMP try-interface-stats failed (502)')
  })

  it('prefers the agent error body', async () => {
    http.post.mockRejectedValueOnce({ response: { status: 400, data: { error: 'No SNMP communities in vault' } } })

    await expect(snmpTryInterfaceStats({ host: '10.0.0.1', profileId: 'p1', interfaceName: 'Gi0/1' }))
      .rejects.toThrow('No SNMP communities in vault')
  })
})
