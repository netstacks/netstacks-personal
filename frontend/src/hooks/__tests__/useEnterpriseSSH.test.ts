import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/client', () => ({
  getClient: () => ({ wsUrlWithAuth: (path: string) => `wss://controller.test${path}&token=t` }),
}))

import { useEnterpriseSSH, isPermanentRefusal } from '../useEnterpriseSSH'
import { WsMessageType } from '../../lib/wsProtocol'

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  constructor(public url: string) { FakeWebSocket.instances.push(this) }
  send() {}
  close() { this.readyState = 3 }
  /** What the Controller's send_error does: an Error frame, then Close(None). */
  refuse(message: string) {
    const text = new TextEncoder().encode(message)
    const frame = new Uint8Array(1 + text.byteLength)
    frame[0] = WsMessageType.Error
    frame.set(text, 1)
    this.onmessage?.({ data: frame.buffer } as MessageEvent)
    this.drop()
  }
  drop() {
    this.readyState = 3
    this.onclose?.({ code: 1005, reason: '' } as CloseEvent)
  }
}

function setup() {
  const callbacks = {
    onData: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onReconnecting: vi.fn(),
    onError: vi.fn(),
    onRefused: vi.fn(),
  }
  const hook = renderHook(() => useEnterpriseSSH({ profileId: 'p1', host: '172.18.0.8', ...callbacks }))
  return { ...callbacks, hook }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useEnterpriseSSH refusals', () => {
  it('stops at the first permanent refusal with one message and no retry', async () => {
    const cb = setup()
    act(() => FakeWebSocket.instances[0].refuse('Access denied to device profile'))
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(cb.onRefused).toHaveBeenCalledTimes(1)
    expect(cb.onRefused).toHaveBeenCalledWith('Access denied to device profile')
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onReconnecting).not.toHaveBeenCalled()
    expect(cb.onDisconnected).not.toHaveBeenCalled()
    expect(cb.hook.result.current.status).toBe('error')
  })

  it('a manual reconnect after a refusal tries again', async () => {
    const cb = setup()
    act(() => FakeWebSocket.instances[0].refuse('Authentication failed'))
    act(() => cb.hook.result.current.reconnect())
    expect(FakeWebSocket.instances).toHaveLength(2)
    act(() => FakeWebSocket.instances[1].drop())
    expect(cb.onReconnecting).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying a dropped socket and a transient server error', async () => {
    const cb = setup()
    act(() => FakeWebSocket.instances[0].drop())
    expect(cb.onReconnecting).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(FakeWebSocket.instances).toHaveLength(2)

    act(() => FakeWebSocket.instances[1].refuse('Connection failed: Connection failed: 172.18.0.8:22 - timed out'))
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onRefused).not.toHaveBeenCalled()
    expect(cb.onReconnecting).toHaveBeenCalledTimes(2)
  })

  it('a failed resume connects afresh without the reconnect token', async () => {
    setup()
    const first = FakeWebSocket.instances[0]
    const frame = new Uint8Array(17)
    frame[0] = WsMessageType.Reconnect
    frame.fill(0xab, 1)
    act(() => first.onmessage?.({ data: frame.buffer } as MessageEvent))
    act(() => first.drop())
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(FakeWebSocket.instances[1].url).toContain('reconnect_token=abababab-abab-abab-abab-abababababab')

    act(() => FakeWebSocket.instances[1].refuse('Resume failed: Unauthorized - user does not own this session'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(FakeWebSocket.instances).toHaveLength(3)
    expect(FakeWebSocket.instances[2].url).not.toContain('reconnect_token')
  })
})

describe('isPermanentRefusal', () => {
  it.each([
    'Missing authentication token',
    'Authentication failed',
    'Access denied to device profile',
    'No device matches host; connect is device-anchored',
    'Missing target host',
    'Device has no profile assigned and you have no default connection profile set',
    'No SSH credential in device profile',
    'Credential decryption failed',
    'Maximum concurrent sessions reached',
    'Connection failed: Authentication failed: password rejected',
    'Connection failed: Key error: decode key: bad base64',
  ])('refuses for good: %s', (message) => {
    expect(isPermanentRefusal(message)).toBe(true)
  })

  it.each([
    'Device lookup failed',
    'Access check failed',
    'Vault error',
    'Credential resolution failed',
    'Connection failed: Connection failed: 10.0.0.1:22 - Connection refused (os error 111)',
    'Connection failed: Connection timeout',
  ])('may pass, so retried: %s', (message) => {
    expect(isPermanentRefusal(message)).toBe(false)
  })
})
