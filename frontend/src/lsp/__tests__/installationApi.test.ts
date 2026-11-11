import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({ getClient: () => ({ http: {}, baseUrl: '', mode: 'standalone' }) }))
vi.mock('../../api/localClient', () => ({ getSidecarAuthToken: () => null }))
vi.mock('../../stores/authStore', () => ({ useAuthStore: { getState: () => ({ accessToken: null }) } }))

import { normalizeTestCommandResult, subscribeToInstallProgress } from '../installationApi'

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static last: FakeEventSource | null = null
  readyState = FakeEventSource.CONNECTING
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener() { /* progress events not exercised here */ }
  close() { this.readyState = FakeEventSource.CLOSED }
}

describe('subscribeToInstallProgress — onerror is only fatal once CLOSED (NS-API-27)', () => {
  it('ignores transient errors while the browser is reconnecting', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const onError = vi.fn()
    subscribeToInstallProgress('pyrefly', () => {}, onError)
    const es = FakeEventSource.last!
    es.readyState = FakeEventSource.CONNECTING
    es.onerror?.()
    expect(onError).not.toHaveBeenCalled()
    es.readyState = FakeEventSource.CLOSED
    es.onerror?.()
    expect(onError).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})

describe('normalizeTestCommandResult', () => {
  it('passes camelCase errorMessage through', () => {
    expect(normalizeTestCommandResult({ success: false, errorMessage: 'spawn failed' }))
      .toEqual({ success: false, errorMessage: 'spawn failed' })
  })

  it('lifts snake_case error_message from older agents', () => {
    const out = normalizeTestCommandResult({ success: false, error_message: 'spawn failed', stderr: 'x' })
    expect(out.errorMessage).toBe('spawn failed')
    expect(out.stderr).toBe('x')
    expect('error_message' in out).toBe(false)
  })

  it('leaves errorMessage undefined on success', () => {
    expect(normalizeTestCommandResult({ success: true }).errorMessage).toBeUndefined()
  })
})
