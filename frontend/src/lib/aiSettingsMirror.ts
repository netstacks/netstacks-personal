/**
 * Mirror of the AI permission settings the sidecar enforces on its own:
 * background tasks run as Auto Pilot and resolve tool permissions from
 * `ai.permissionMode.autopilot` + `ai.disabledTools.autopilot`
 * (agent/src/tasks/permissions.rs), and /ai/bash-execute applies
 * `ai.bash.deniedCommands`, and background tasks only record model reasoning
 * when `ai.showThinking` is on (agent/src/tasks/react.rs). The settings in localStorage stay the source of
 * truth; the sidecar copy is written at startup and whenever one changes.
 * Standalone only — enterprise has no local sidecar.
 */

import { getClient } from '../api/client'
import { defaultSettings, getSettings, SETTINGS_CHANGED_EVENT, STORAGE_KEY, type AppSettings } from '../hooks/useSettings'
import { logger } from './logger'

export const MIRRORED_AI_SETTINGS = [
  'ai.permissionMode.autopilot',
  'ai.disabledTools.autopilot',
  'ai.bash.deniedCommands',
  'ai.showThinking',
] as const satisfies readonly (keyof AppSettings)[]

export function startAiSettingsMirror(): void {
  // Last value written per key, so unrelated settings changes send nothing.
  const written = new Map<string, string>()
  const write = (settings: AppSettings) => {
    for (const key of MIRRORED_AI_SETTINGS) {
      const body = JSON.stringify(settings[key])
      if (written.get(key) === body) continue
      written.set(key, body)
      // The sidecar stores the raw JSON value it is sent.
      getClient().http.put(`/settings/${key}`, body, { headers: { 'Content-Type': 'application/json' } })
        .catch((err: unknown) => {
          written.delete(key)
          logger.warn(`[aiSettingsMirror] could not mirror ${key} to the sidecar`, err)
        })
    }
  }

  write(getSettings())
  window.addEventListener(SETTINGS_CHANGED_EVENT, (e) => write((e as CustomEvent<AppSettings>).detail))
  // Settings edited in another window (popouts share localStorage).
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || e.newValue === null) return
    try {
      write({ ...defaultSettings, ...JSON.parse(e.newValue) })
    } catch {
      // Corrupt incoming value — useSettings ignores it too.
    }
  })
}
