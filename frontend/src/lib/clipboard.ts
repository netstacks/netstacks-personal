/**
 * copyToClipboard — three-tier copy that works everywhere we ship.
 *
 * Order:
 *   1. @tauri-apps/plugin-clipboard-manager — preferred inside the
 *      Tauri WebView. Avoids the WebView's permission gating around
 *      navigator.clipboard (especially on first focus / unfocused).
 *   2. navigator.clipboard.writeText — for the (rare) non-Tauri build
 *      and for older Tauri WebViews that haven't loaded the plugin yet.
 *   3. document.execCommand('copy') textarea trick — last-ditch
 *      fallback. Deprecated, Chromium has flagged it for removal, but
 *      still works today as a hard backstop.
 *
 * Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Tauri plugin (works inside the bundled app even when
  //    navigator.clipboard is locked down by the WebView).
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return true
  } catch {
    // Plugin unavailable (non-Tauri context) or rejected — try the
    // standard browser API next.
  }

  // 2. Browser clipboard API.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the deprecated fallback.
  }

  // 3. Last-ditch textarea + execCommand fallback.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Extract the first image blob from a paste event's clipboard data.
 * Returns null if no image is present (let xterm handle text paste).
 */
export function getImageFromClipboard(data: DataTransfer | null): Blob | null {
  if (!data) return null
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]
    if (item.type.startsWith('image/')) {
      return item.getAsFile()
    }
  }
  return null
}

/**
 * Normalize any image blob to PNG via an off-screen canvas.
 * Returns the PNG as a Uint8Array.
 */
export function convertToPng(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to get canvas context'))
        return
      }
      ctx.drawImage(img, 0, 0)
      canvas.toBlob((pngBlob) => {
        URL.revokeObjectURL(url)
        if (!pngBlob) {
          reject(new Error('Failed to convert to PNG'))
          return
        }
        pngBlob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          reject,
        )
      }, 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}
