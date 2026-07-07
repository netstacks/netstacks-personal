export type Platform = 'macos' | 'windows' | 'linux'

/** Best-effort synchronous platform detection for layout decisions. */
export function getPlatform(): Platform {
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || ''
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'macos'
  if (/Win/i.test(ua)) return 'windows'
  return 'linux'
}
