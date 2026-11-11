import { describe, it, expect, vi, beforeEach } from 'vitest'

// Enterprise client with a per-user /user-settings store.
const store = new Map<string, unknown>()
let currentUser = 'alice'
const http = {
  get: vi.fn(async (url: string) => ({ data: store.get(`${currentUser}:${url}`) ?? null })),
  put: vi.fn(async (url: string, body: unknown) => { store.set(`${currentUser}:${url}`, body); return { data: body } }),
}
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'enterprise', http, baseUrl: 'https://controller.test' }),
  getCurrentMode: () => 'enterprise',
}))

import { getKeybindings, DEFAULT_KEYBINDINGS } from '../useKeyboard'
import { setUserScope, clearUserScope } from '../../lib/userScope'

const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  clearUserScope()
  localStorage.clear()
  http.get.mockClear()
})

describe('keybindings in enterprise', () => {
  it('does not ask the Controller before anyone signs in', () => {
    expect(http.get).not.toHaveBeenCalled()
    expect(getKeybindings()).toEqual(DEFAULT_KEYBINDINGS)
  })

  it('loads the signed-in user\'s bindings, and drops them on sign-out', async () => {
    store.set('alice:/user-settings/keybindings', { commandPalette: { mac: 'Cmd+K', windows: 'Ctrl+K' } })
    currentUser = 'alice'
    setUserScope('https://controller.test', 'alice')
    await flush()
    expect(http.get).toHaveBeenCalledWith('/user-settings/keybindings')
    expect(getKeybindings().commandPalette).toEqual({ mac: 'Cmd+K', windows: 'Ctrl+K' })

    clearUserScope()
    expect(getKeybindings()).toEqual(DEFAULT_KEYBINDINGS)
  })

  it('keeps each user\'s cache separate', async () => {
    store.set('alice:/user-settings/keybindings', { commandPalette: { mac: 'Cmd+K', windows: 'Ctrl+K' } })
    store.delete('bob:/user-settings/keybindings')
    currentUser = 'alice'
    setUserScope('https://controller.test', 'alice')
    await flush()
    clearUserScope()

    currentUser = 'bob'
    setUserScope('https://controller.test', 'bob')
    await flush()
    expect(getKeybindings().commandPalette).toEqual(DEFAULT_KEYBINDINGS.commandPalette)
  })
})
