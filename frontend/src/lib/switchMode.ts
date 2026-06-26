/**
 * Shared mode-switch helpers used by the auth gates.
 *
 * Both gates need to flip `app-config.json`'s `controllerUrl` and then
 * restart the app so the sidecar agent picks up the new mode at the
 * next startup. Keeping the flow in one place means the Vault Gate
 * (standalone → enterprise) and the Login Screen (enterprise →
 * standalone) can't drift from each other or from the Settings panel.
 */

import { saveAppConfig, validateControllerUrl } from './appConfig';
import { ControllerUrlError } from '../types/config';
import { getErrorMessage } from '../api/errors';

/**
 * Dynamic import of @tauri-apps/plugin-process. Mirrors the pattern in
 * UpdateChecker — returns null relaunch when running outside Tauri (the
 * web-served dev shell) so the helper degrades gracefully.
 */
async function getRelaunch(): Promise<(() => Promise<void>) | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const proc = await import('@tauri-apps/plugin-process');
  return proc.relaunch;
}

/**
 * Save the new controller URL and relaunch the app. Returns a friendly
 * message on success (when relaunch isn't available — e.g. browser dev
 * shell — the caller can show it as a "restart the app" instruction).
 *
 * Throws on validation failure or save failure; the caller surfaces it.
 */
export async function switchToEnterprise(controllerUrl: string): Promise<string> {
  const trimmed = controllerUrl.trim();
  if (!trimmed) {
    throw new ControllerUrlError('Controller URL is required.');
  }
  // Re-validate here even though saveAppConfig also validates — gives the
  // gate UX a clean error before we touch disk.
  const normalised = validateControllerUrl(trimmed);
  try {
    await saveAppConfig({ controllerUrl: normalised });
  } catch (err) {
    throw new Error(getErrorMessage(err, 'Failed to save controller URL'));
  }
  const relaunch = await getRelaunch();
  if (relaunch) {
    await relaunch();
    // relaunch() returns before exit but the process is dying — give the
    // caller a string anyway in case it renders one before unmount.
    return 'Restarting…';
  }
  return 'Controller URL saved. Restart the app to apply changes.';
}

/**
 * Clear the controller URL and relaunch into standalone mode.
 * Mirrors handleDeenroll in SettingsConnection but without the in-line
 * confirm — callers are expected to confirm at their own UX level.
 */
export async function switchToStandalone(): Promise<string> {
  try {
    await saveAppConfig({ controllerUrl: null });
  } catch (err) {
    throw new Error(getErrorMessage(err, 'Failed to switch to standalone mode'));
  }
  const relaunch = await getRelaunch();
  if (relaunch) {
    await relaunch();
    return 'Restarting…';
  }
  return 'Switched to standalone mode. Restart the app to apply.';
}
