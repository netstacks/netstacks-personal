import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

type Pending = { resolve: (v: string) => void; reject: (e: unknown) => void; signal?: AbortSignal }
const pending: Pending[] = []
const sendChatMessage = vi.fn((_messages: unknown, opts?: { signal?: AbortSignal }) =>
  new Promise<string>((resolve, reject) => { pending.push({ resolve, reject, signal: opts?.signal }) }))

vi.mock('../../api/ai', () => ({
  sendChatMessage: (...args: [unknown, { signal?: AbortSignal }?]) => sendChatMessage(...args),
  AiNotConfiguredError: class AiNotConfiguredError extends Error {},
}))
vi.mock('../../lib/aiProviderResolver', () => ({
  resolveProvider: () => ({ provider: undefined, model: undefined }),
}))

import { useCommandSuggestions } from '../useCommandSuggestions'
import { useNextStepSuggestions } from '../useNextStepSuggestions'

const ctx = { cliFlavor: 'linux' }

async function flushTimers(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms) })
}
async function settle(fn: () => void) {
  await act(async () => { fn(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  sendChatMessage.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('useCommandSuggestions races', () => {
  it('ignores an older response that resolves after a newer one', async () => {
    const { result } = renderHook(() => useCommandSuggestions({ debounceMs: 10 }))
    act(() => { void result.current.fetchSuggestions('sh', ctx) })
    await flushTimers(10)
    act(() => { void result.current.fetchSuggestions('sho', ctx) })
    await flushTimers(10)
    expect(pending).toHaveLength(2)
    // The superseded request was aborted.
    expect(pending[0].signal?.aborted).toBe(true)

    await settle(() => pending[1].resolve('[{"command":"show ip route"}]'))
    expect(result.current.suggestions.map((s) => s.command)).toEqual(['show ip route'])

    await settle(() => pending[0].resolve('[{"command":"shutdown"}]'))
    expect(result.current.suggestions.map((s) => s.command)).toEqual(['show ip route'])
  })

  it('clear() invalidates an in-flight request', async () => {
    const { result } = renderHook(() => useCommandSuggestions({ debounceMs: 10 }))
    act(() => { void result.current.fetchSuggestions('sh', ctx) })
    await flushTimers(10)
    act(() => result.current.clear())
    expect(pending[0].signal?.aborted).toBe(true)
    await settle(() => pending[0].resolve('[{"command":"show version"}]'))
    expect(result.current.suggestions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('drops completions that no longer match the current input', async () => {
    const { result } = renderHook(() => useCommandSuggestions({ debounceMs: 10, minChars: 2 }))
    act(() => { void result.current.fetchSuggestions('sh', ctx) })
    await flushTimers(10)
    // Input changed to a different prefix (below minChars => no new request).
    act(() => { void result.current.fetchSuggestions('p', ctx) })
    await settle(() => pending[0].resolve('[{"command":"show run"}]'))
    expect(result.current.suggestions).toEqual([])
  })

  it('accepts a response whose prefix still matches and keeps only matching commands', async () => {
    const { result } = renderHook(() => useCommandSuggestions({ debounceMs: 10 }))
    act(() => { void result.current.fetchSuggestions('sh', ctx) })
    await flushTimers(10)
    await settle(() => pending[0].resolve('[{"command":"show run"},{"command":"shutdown"}]'))
    expect(result.current.suggestions.map((s) => s.command)).toEqual(['show run', 'shutdown'])
  })
})

describe('useNextStepSuggestions races', () => {
  const reply = (cmd: string) => JSON.stringify([{ command: cmd, description: 'd', confidence: 'high', category: 'related' }])

  it('ignores an older response that resolves after a newer one', async () => {
    const { result } = renderHook(() => useNextStepSuggestions({ debounceMs: 10 }))
    act(() => result.current.generateSuggestions('show ip int brief'))
    await flushTimers(10)
    act(() => result.current.generateSuggestions('show version'))
    await flushTimers(10)
    expect(pending).toHaveLength(2)
    expect(pending[0].signal?.aborted).toBe(true)

    await settle(() => pending[1].resolve(reply('show inventory')))
    await settle(() => pending[0].resolve(reply('show interfaces')))
    expect(result.current.suggestions.map((s) => s.command)).toEqual(['show inventory'])
    expect(result.current.loading).toBe(false)
  })

  it('clearSuggestions invalidates an in-flight request', async () => {
    const { result } = renderHook(() => useNextStepSuggestions({ debounceMs: 10 }))
    act(() => result.current.generateSuggestions('show version'))
    await flushTimers(10)
    expect(result.current.loading).toBe(true)
    act(() => result.current.clearSuggestions())
    expect(result.current.loading).toBe(false)
    await settle(() => pending[0].resolve(reply('show inventory')))
    expect(result.current.suggestions).toEqual([])
  })
})
