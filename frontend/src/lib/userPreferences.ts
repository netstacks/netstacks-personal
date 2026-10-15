// Enterprise: the user's preferences — every AppSettings key (AI permission
// modes, zoom, editor font, …) and the app theme — follow them from machine to
// machine via the Controller's per-user store (routes/user_settings.rs; GET
// returns null when unset). Never /settings/:key: on the Controller that is
// one global row and admin-only. Two per-user documents are kept:
//   - `terminal.preferences`: { settings, appTheme } — the terminal's own copy;
//   - `ai.permissions`: the AI permission settings in the Controller's typed
//     shape (netstacks_models::AiPermissionSettings), which its permission
//     resolver reads for the AI work it runs on the user's behalf.
//
// AuthProvider loads them after login, before the app's settings-dependent UI
// renders. localStorage keeps a per-user cache (lib/userScope) so a Controller
// that can't be reached still leaves the user with their last-known settings.
// Standalone never comes here: its settings live in this device's storage as
// before.
//
// Per-dialog sizes (ModalFrame `netstacks-modal-size:*`) deliberately stay
// device-local: a size that suits one screen is wrong on another, and a size
// is not something a user expects to follow them.
import { getClient } from '../api/client'
import { getSettings, normalizeSettings, reloadSettings, setGlobalSettings, SETTINGS_CHANGED_EVENT } from '../hooks/useSettings'
import { DEFAULT_APP_THEME, getAppTheme, isAppTheme, setAppTheme, subscribeAppTheme, type AppTheme } from './appTheme'
import { clearUserScope, setUserScope } from './userScope'
import { parseApiError } from '../api/errors'
import { showToast } from '../components/Toast'
import { toolRegistryFor } from './agentTools'

const PREFERENCES_KEY = 'terminal.preferences'
const PERMISSIONS_KEY = 'ai.permissions'
const PUSH_DEBOUNCE_MS = 500

interface UserPreferences {
  settings: Record<string, unknown>
  appTheme: AppTheme
}

// Tools the AI has in enterprise. A disabled-tools list can also name tools
// that only exist in standalone (the settings default disables run_bash for
// Overlord); the Controller is told only about tools it can actually run.
const ENTERPRISE_TOOLS: ReadonlySet<string> = new Set(toolRegistryFor('enterprise').map((t) => t.name))
const enterpriseTools = (names: string[]) => names.filter((name) => ENTERPRISE_TOOLS.has(name))

/** Each document's current value. */
const DOCUMENTS: Record<string, () => unknown> = {
  [PREFERENCES_KEY]: () => ({ settings: getSettings(), appTheme: getAppTheme() }),
  [PERMISSIONS_KEY]: () => {
    const s = getSettings()
    return {
      permissionMode: { autopilot: s['ai.permissionMode.autopilot'], overlord: s['ai.permissionMode.overlord'] },
      disabledTools: {
        autopilot: enterpriseTools(s['ai.disabledTools.autopilot']),
        overlord: enterpriseTools(s['ai.disabledTools.overlord']),
      },
      allowStructuralTopologyEdits: s['ai.topology.allowStructuralEdits'],
    }
  },
}

/** JSON with every object's keys sorted, so equal values give equal text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/**
 * ai.permissions as the Controller acts on it: a disabled-tools list is a set
 * of the tools enterprise has (its order, and standalone-only names like
 * run_bash, change nothing).
 */
function effectivePermissions(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const { disabledTools } = value as Record<string, unknown>
  if (typeof disabledTools !== 'object' || disabledTools === null) return value
  const lists = Object.fromEntries(Object.entries(disabledTools).map(([agentType, names]) => [
    agentType,
    Array.isArray(names) ? enterpriseTools(names.filter((n): n is string => typeof n === 'string')).sort() : names,
  ]))
  return { ...value, disabledTools: lists }
}

/**
 * What decides whether a document needs saving. The Controller stores each
 * value as JSONB, which hands objects back with their keys reordered, so
 * documents compare by content, not by the order they were written in.
 */
function fingerprint(key: string, value: unknown): string {
  return canonicalJson(key === PERMISSIONS_KEY ? effectivePermissions(value) : value)
}

/** Fingerprint of each document the Controller holds, as far as this window knows. */
const synced = new Map<string, string>()
let pushTimer: number | null = null
let stopSync: (() => void) | null = null

function parsePreferences(value: unknown): UserPreferences | null {
  if (typeof value !== 'object' || value === null) return null
  const { settings, appTheme } = value as Record<string, unknown>
  if (typeof settings !== 'object' || settings === null) return null
  return { settings: settings as Record<string, unknown>, appTheme: isAppTheme(appTheme) ? appTheme : 'system' }
}

/**
 * A save the Controller refused. A 422 means it rejected the value itself (it
 * validates ai.permissions), so the AI would keep running on the old
 * permissions: say so, don't just log it.
 */
function reportSaveFailure(key: string, err: unknown): void {
  console.error(`[userPreferences] Could not save ${key} to the Controller:`, err)
  const { status, error } = parseApiError(err)
  if (status === 422) {
    showToast(`The Controller rejected your ${key === PERMISSIONS_KEY ? 'AI permission settings' : 'settings'}${error ? `: ${error}` : ''}. It keeps using the previous ones.`, 'error')
  }
}

/** Save every document whose value differs from the Controller's copy. */
function push(): void {
  pushTimer = null
  for (const [key, current] of Object.entries(DOCUMENTS)) {
    const value = current()
    const print = fingerprint(key, value)
    if (print === synced.get(key)) continue
    getClient().http.put(`/user-settings/${key}`, value)
      .then(() => { synced.set(key, print) })
      .catch((err: unknown) => reportSaveFailure(key, err))
  }
}

function schedulePush(): void {
  if (pushTimer !== null) window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(push, PUSH_DEBOUNCE_MS)
}

function flushPush(): void {
  if (pushTimer === null) return
  window.clearTimeout(pushTimer)
  push()
}

function startSync(): void {
  window.addEventListener(SETTINGS_CHANGED_EVENT, schedulePush)
  window.addEventListener('pagehide', flushPush)
  const unsubscribeTheme = subscribeAppTheme(schedulePush)
  stopSync = () => {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, schedulePush)
    window.removeEventListener('pagehide', flushPush)
    unsubscribeTheme()
  }
}

/**
 * Make `userId`'s preferences current: their cached copy at once, then the
 * Controller's. A document unset (or stale) on the Controller is saved from
 * this device's copy. If the Controller can't be read the cached copy stays,
 * and later changes still save to the Controller.
 */
export async function loadUserPreferences(controllerUrl: string, userId: string): Promise<void> {
  releaseUserPreferences()
  setUserScope(controllerUrl, userId)
  reloadSettings()
  try {
    const http = getClient().http
    const [preferences, permissions] = await Promise.all([
      http.get(`/user-settings/${PREFERENCES_KEY}`),
      http.get(`/user-settings/${PERMISSIONS_KEY}`),
    ])
    const remote = parsePreferences(preferences.data)
    if (remote) {
      setGlobalSettings(normalizeSettings(remote.settings))
      setAppTheme(remote.appTheme)
      synced.set(PREFERENCES_KEY, fingerprint(PREFERENCES_KEY, DOCUMENTS[PREFERENCES_KEY]()))
    } else {
      // Nothing saved yet: the theme is a device setting, so it still shows the
      // previous user's choice — start this user from the default instead.
      setAppTheme(DEFAULT_APP_THEME)
    }
    // ai.permissions is derived from the preferences and never read back into
    // the UI; what the Controller holds only decides whether to rewrite it
    // (sign-in saves it only when it differs from the derived value).
    if (permissions.data !== null) synced.set(PERMISSIONS_KEY, fingerprint(PERMISSIONS_KEY, permissions.data))
    schedulePush()
  } catch (err) {
    console.error('[userPreferences] Could not load your preferences from the Controller; using this device\'s copy:', err)
    for (const [key, current] of Object.entries(DOCUMENTS)) synced.set(key, fingerprint(key, current()))
  }
  startSync()
}

/** Sign-out: save what is pending, then drop the user's preferences from memory. */
export function releaseUserPreferences(): void {
  flushPush()
  stopSync?.()
  stopSync = null
  synced.clear()
  clearUserScope()
  reloadSettings()
}
