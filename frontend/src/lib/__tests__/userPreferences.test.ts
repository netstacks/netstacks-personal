import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A fake Controller /user-settings store, per user, behind an enterprise client.
const CONTROLLER = 'https://controller.test'
const store = new Map<string, unknown>()
let currentUser = 'alice'
let controllerDown = false
/** Validation error the fake Controller answers a PUT of ai.permissions with. */
let permissionsRejection: string | null = null
const http = {
  get: vi.fn(async (url: string) => {
    if (controllerDown) throw new Error('Network Error')
    return { data: store.get(`${currentUser}:${url}`) ?? null }
  }),
  put: vi.fn(async (url: string, body: unknown) => {
    if (permissionsRejection && url.endsWith('/ai.permissions')) {
      throw Object.assign(new Error('Request failed with status code 422'), {
        isAxiosError: true,
        response: { status: 422, data: { error: permissionsRejection } },
      })
    }
    store.set(`${currentUser}:${url}`, body)
    return { data: body }
  }),
}
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'enterprise', http, baseUrl: CONTROLLER }),
  getCurrentMode: () => 'enterprise',
}))

vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }))

import { loadUserPreferences, releaseUserPreferences } from '../userPreferences'
import { showToast } from '../../components/Toast'
import { defaultSettings, getSettings, setGlobalSettings, STORAGE_KEY } from '../../hooks/useSettings'
import { getAppTheme, setAppTheme } from '../appTheme'
import { readTabSnapshot, writeTabSnapshot } from '../tabRestore'

const REMOTE = '/user-settings/terminal.preferences'
const PERMISSIONS = '/user-settings/ai.permissions'
/** The Controller's typed ai.permissions value (netstacks_models::AiPermissionSettings) for these settings. */
function permissionsFor(over: { autopilot?: string; overlord?: string; disabled?: string[] } = {}) {
  return {
    permissionMode: { autopilot: over.autopilot ?? 'auto', overlord: over.overlord ?? 'ask' },
    // run_bash is standalone-only: the default Overlord list names it, the Controller never sees it.
    disabledTools: { autopilot: over.disabled ?? defaultSettings['ai.disabledTools.autopilot'], overlord: defaultSettings['ai.disabledTools.overlord'].filter((t) => t !== 'run_bash') },
    allowStructuralTopologyEdits: false,
  }
}

async function signIn(user: string) {
  currentUser = user
  await loadUserPreferences(CONTROLLER, user)
}

/** Let the debounced save run. */
async function flushSave() {
  await vi.advanceTimersByTimeAsync(600)
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  store.clear()
  controllerDown = false
  permissionsRejection = null
  http.get.mockClear()
  http.put.mockClear()
})

afterEach(() => {
  releaseUserPreferences()
  vi.useRealTimers()
})

describe('enterprise user preferences', () => {
  it('loads the user\'s settings and theme from the Controller', async () => {
    store.set(`alice:${REMOTE}`, { settings: { 'view.zoomStep': 2, 'ai.permissionMode.overlord': 'yolo' }, appTheme: 'dark' })
    store.set(`alice:${PERMISSIONS}`, permissionsFor({ overlord: 'yolo' }))
    await signIn('alice')

    expect(http.get).toHaveBeenCalledWith(REMOTE)
    expect(getSettings()['view.zoomStep']).toBe(2)
    expect(getSettings()['ai.permissionMode.overlord']).toBe('yolo')
    expect(getSettings()['editor.fontSize']).toBeGreaterThan(0) // missing keys take defaults
    expect(getAppTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    // Loading what the Controller already has writes nothing back.
    await flushSave()
    expect(http.put).not.toHaveBeenCalled()
  })

  it('saves changes to the user\'s Controller copy, debounced', async () => {
    store.set(`alice:${REMOTE}`, { settings: {}, appTheme: 'system' })
    await signIn('alice')

    setGlobalSettings({ ...getSettings(), 'editor.fontSize': 18 })
    setGlobalSettings({ ...getSettings(), 'editor.fontSize': 19 })
    setAppTheme('light')
    await flushSave()

    expect(http.put.mock.calls.filter(([url]) => url === REMOTE)).toHaveLength(1)
    const saved = store.get(`alice:${REMOTE}`) as { settings: Record<string, unknown>; appTheme: string }
    expect(saved.settings['editor.fontSize']).toBe(19)
    expect(saved.appTheme).toBe('light')
  })

  it('keeps the Controller\'s ai.permissions in step with the AI permission settings', async () => {
    store.set(`alice:${REMOTE}`, { settings: {}, appTheme: 'system' })
    store.set(`alice:${PERMISSIONS}`, permissionsFor())
    await signIn('alice')
    await flushSave()
    expect(http.put).not.toHaveBeenCalled()

    setGlobalSettings({ ...getSettings(), 'ai.permissionMode.autopilot': 'yolo', 'ai.disabledTools.autopilot': ['save_memory'] })
    await flushSave()
    expect(store.get(`alice:${PERMISSIONS}`)).toEqual(permissionsFor({ autopilot: 'yolo', disabled: ['save_memory'] }))

    // A change that isn't an AI permission leaves ai.permissions alone.
    http.put.mockClear()
    setGlobalSettings({ ...getSettings(), 'editor.fontSize': 20 })
    await flushSave()
    expect(http.put.mock.calls.map(([url]) => url)).toEqual([REMOTE])
  })

  it('tells the Controller only about tools that exist in enterprise', async () => {
    store.set(`alice:${REMOTE}`, { settings: {}, appTheme: 'system' })
    await signIn('alice')
    expect(defaultSettings['ai.disabledTools.overlord']).toContain('run_bash')
    setGlobalSettings({ ...getSettings(), 'ai.disabledTools.autopilot': ['run_bash', 'save_memory', 'no_such_tool'] })
    await flushSave()
    const saved = store.get(`alice:${PERMISSIONS}`) as ReturnType<typeof permissionsFor>
    expect(saved.disabledTools.autopilot).toEqual(['save_memory'])
    expect(saved.disabledTools.overlord).not.toContain('run_bash')
  })

  it('rewrites ai.permissions after login when the Controller\'s copy is missing or stale', async () => {
    store.set(`alice:${REMOTE}`, { settings: { 'ai.permissionMode.autopilot': 'yolo' }, appTheme: 'system' })
    store.set(`alice:${PERMISSIONS}`, permissionsFor({ autopilot: 'ask' }))
    await signIn('alice')
    await flushSave()
    expect(store.get(`alice:${PERMISSIONS}`)).toEqual(permissionsFor({ autopilot: 'yolo' }))
    // The stale copy is never read back into the settings.
    expect(getSettings()['ai.permissionMode.autopilot']).toBe('yolo')

    releaseUserPreferences()
    store.set(`bob:${REMOTE}`, { settings: {}, appTheme: 'system' })
    await signIn('bob')
    await flushSave()
    expect(store.get(`bob:${PERMISSIONS}`)).toEqual(permissionsFor())
  })

  it('signing in saves nothing when the Controller holds the same ai.permissions in another order', async () => {
    const settings = { 'ai.disabledTools.autopilot': ['save_memory', 'ai_ssh_execute'] }
    store.set(`alice:${REMOTE}`, { settings, appTheme: 'system' })
    const same = permissionsFor({ disabled: settings['ai.disabledTools.autopilot'] })
    // As Postgres JSONB hands it back: keys by length then bytes, lists as
    // stored (here reversed), and a standalone-only run_bash left in a list.
    store.set(`alice:${PERMISSIONS}`, {
      disabledTools: { overlord: [...same.disabledTools.overlord, 'run_bash'].reverse(), autopilot: [...same.disabledTools.autopilot].reverse() },
      permissionMode: { overlord: same.permissionMode.overlord, autopilot: same.permissionMode.autopilot },
      allowStructuralTopologyEdits: same.allowStructuralTopologyEdits,
    })
    await signIn('alice')
    await flushSave()
    expect(http.put).not.toHaveBeenCalled()
  })

  it('signing in saves ai.permissions when a disabled-tools list differs', async () => {
    store.set(`alice:${REMOTE}`, { settings: { 'ai.disabledTools.autopilot': ['save_memory'] }, appTheme: 'system' })
    store.set(`alice:${PERMISSIONS}`, permissionsFor({ disabled: ['save_memory', 'ai_ssh_execute'] }))
    await signIn('alice')
    await flushSave()
    expect(http.put.mock.calls.map(([url]) => url)).toEqual([PERMISSIONS])
    expect(store.get(`alice:${PERMISSIONS}`)).toEqual(permissionsFor({ disabled: ['save_memory'] }))
  })

  it('says so when the Controller rejects ai.permissions (422)', async () => {
    store.set(`alice:${REMOTE}`, { settings: {}, appTheme: 'system' })
    store.set(`alice:${PERMISSIONS}`, permissionsFor())
    await signIn('alice')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    permissionsRejection = 'Invalid ai.permissions: unknown variant `maybe`'
    setGlobalSettings({ ...getSettings(), 'ai.permissionMode.overlord': 'yolo' })
    await flushSave()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/rejected your AI permission settings: Invalid ai\.permissions/), 'error')
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('keeps users apart in one browser: cache, Controller copy and open tabs', async () => {
    store.set(`alice:${REMOTE}`, { settings: { 'view.zoomStep': 3 }, appTheme: 'system' })
    await signIn('alice')
    writeTabSnapshot({ tabs: [{ type: 'settings', id: 'settings' }], activeTabId: 'settings', popouts: [] })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    releaseUserPreferences()
    expect(getSettings()['view.zoomStep']).toBe(0)
    expect(readTabSnapshot()).toBeNull()

    await signIn('bob')
    expect(getSettings()['view.zoomStep']).toBe(0)
    expect(readTabSnapshot()).toBeNull()
    // Bob had nothing on the Controller: his (default) preferences seed it.
    await flushSave()
    expect(store.get(`bob:${REMOTE}`)).toMatchObject({ settings: expect.objectContaining({ 'view.zoomStep': 0 }) })

    releaseUserPreferences()
    await signIn('alice')
    expect(getSettings()['view.zoomStep']).toBe(3)
    expect(readTabSnapshot()?.activeTabId).toBe('settings')
  })

  it('falls back to the user\'s cached copy when the Controller cannot be read', async () => {
    store.set(`alice:${REMOTE}`, { settings: { 'view.zoomStep': 4 }, appTheme: 'system' })
    await signIn('alice')
    releaseUserPreferences()

    controllerDown = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await signIn('alice')
    expect(getSettings()['view.zoomStep']).toBe(4)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('has no per-user state before anyone signs in', () => {
    expect(getSettings()['view.zoomStep']).toBe(0)
    writeTabSnapshot({ tabs: [], activeTabId: null, popouts: [] })
    expect(localStorage.length).toBe(0)
  })
})
