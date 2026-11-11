import { invoke } from '@tauri-apps/api/core'

/**
 * Relaunch the desktop app through the shell's `relaunch_app` command, never
 * plugin-process `relaunch()`. On macOS that restart spawns the new app as a
 * child of the old one, and Local Network privacy then blocks the new app's
 * (and its agent's) LAN access until the user relaunches by hand — see
 * `relaunch` in src-tauri/src/main.rs. Null outside Tauri (web dev shell).
 */
export function getAppRelaunch(): (() => Promise<void>) | null {
  if (!('__TAURI_INTERNALS__' in window)) return null
  return () => invoke('relaunch_app')
}

/**
 * Stop the local agent sidecar just before an update installs. The Windows
 * updater exits without running the app's exit hook, so the old agent kept
 * netstacks-agent.exe locked and the installer stopped on a Retry prompt.
 */
export async function stopSidecarForUpdate(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return
  await invoke('stop_sidecar')
}
