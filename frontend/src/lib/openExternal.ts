/**
 * openExternalUrl — open a URL in the user's default browser from any
 * build of the app.
 *
 * Order:
 *   1. @tauri-apps/plugin-opener — successor to shell open. On Linux it
 *      sanitizes the AppImage-polluted environment (LD_LIBRARY_PATH,
 *      APPDIR, ...) before spawning xdg-open, which is what makes links
 *      work from the bundled AppImage at all.
 *   2. @tauri-apps/plugin-shell open — older Tauri WebViews / builds
 *      that predate the opener plugin.
 *   3. window.open — non-Tauri (browser/dev) context. Note this is a
 *      silent no-op inside WebKitGTK, which is why it is last.
 *
 * Returns true when a handler accepted the URL.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
    return true
  } catch {
    // Opener plugin unavailable or denied — try shell open.
  }

  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return true
  } catch {
    // Shell plugin unavailable or denied — fall back to the browser API.
  }

  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    return win !== null
  } catch {
    return false
  }
}
