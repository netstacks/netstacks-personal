export type Platform = 'macos' | 'windows' | 'linux'

let cached: Platform | null = null

function isPlatform(v: unknown): v is Platform {
  return v === 'macos' || v === 'windows' || v === 'linux'
}

/** Single source of truth for platform. `?platform=` and VITE_PLATFORM_OVERRIDE win over the UA. */
export function getPlatform(): Platform {
  if (cached) return cached
  const q = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('platform') : null
  const forced = q ?? import.meta.env.VITE_PLATFORM_OVERRIDE
  if (isPlatform(forced)) return (cached = forced)
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || ''
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return (cached = 'macos')
  if (/Windows/i.test(ua)) return (cached = 'windows')
  return (cached = 'linux')
}

/** Test-only: clear the cache. */
export function __resetPlatformForTests(): void { cached = null }
