import { describe, it, expect, vi, beforeEach } from 'vitest'

const client = vi.hoisted(() => ({
  mode: 'standalone' as 'standalone' | 'enterprise',
  remoteAgentHost: null as string | null,
}))
const invoke = vi.hoisted(() => vi.fn())

vi.mock('../../api/client', () => ({
  initializeClient: vi.fn(async () => ({ client: {}, mode: client.mode, requiresAuth: client.mode === 'enterprise' })),
  getRemoteAgentHost: () => client.remoteAgentHost,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

import { startClient, usesLocalAgent } from '../clientBootstrap'
import { getSidecarAuthToken, getSidecarPort } from '../../api/localClient'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (cmd: string) => (cmd === 'get_sidecar_token' ? 'tok-123' : 4321))
  client.mode = 'standalone'
  client.remoteAgentHost = null
})

describe('usesLocalAgent', () => {
  it('is true only for a standalone window on the bundled agent', () => {
    expect(usesLocalAgent('standalone')).toBe(true)
    expect(usesLocalAgent('enterprise')).toBe(false)
    client.remoteAgentHost = 'jump.example.net'
    expect(usesLocalAgent('standalone')).toBe(false)
  })
})

describe('startClient', () => {
  it('standalone: fetches the sidecar token and port after the client is up', async () => {
    const result = await startClient()
    expect(result.mode).toBe('standalone')
    expect(invoke).toHaveBeenCalledWith('get_sidecar_token')
    expect(invoke).toHaveBeenCalledWith('get_sidecar_port')
    expect(getSidecarAuthToken()).toBe('tok-123')
    expect(getSidecarPort()).toBe(4321)
  })

  it('enterprise: never asks Tauri for a sidecar (no local agent runs)', async () => {
    client.mode = 'enterprise'
    const result = await startClient()
    expect(result.mode).toBe('enterprise')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('remote-agent window: keeps its own agent token, no sidecar poll', async () => {
    client.remoteAgentHost = 'jump.example.net'
    await startClient()
    expect(invoke).not.toHaveBeenCalled()
  })
})
