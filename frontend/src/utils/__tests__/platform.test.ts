// frontend/src/utils/__tests__/platform.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPlatform, __resetPlatformForTests } from '../platform'

function setUA(ua: string) {
  vi.stubGlobal('navigator', { userAgent: ua, platform: '' })
}
function setQuery(search: string) {
  vi.stubGlobal('location', { ...window.location, search })
}
beforeEach(() => __resetPlatformForTests())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  __resetPlatformForTests()
})

describe('getPlatform', () => {
  it('detects macOS', () => { setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'); expect(getPlatform()).toBe('macos') })
  it('detects Windows', () => { setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'); expect(getPlatform()).toBe('windows') })
  it('defaults to linux', () => { setUA('Mozilla/5.0 (X11; Linux x86_64)'); expect(getPlatform()).toBe('linux') })
  it('does not mistake "darwin" for Windows', () => { setUA('Mozilla/5.0 (darwin) AppleWebKit/537.36 jsdom/27'); expect(getPlatform()).toBe('linux') })

  it('query param wins over UA', () => {
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    setQuery('?platform=windows')
    expect(getPlatform()).toBe('windows')
  })

  it('env override wins over UA', () => {
    setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    vi.stubEnv('VITE_PLATFORM_OVERRIDE', 'macos')
    expect(getPlatform()).toBe('macos')
  })

  it('query param wins over env', () => {
    vi.stubEnv('VITE_PLATFORM_OVERRIDE', 'macos')
    setQuery('?platform=linux')
    expect(getPlatform()).toBe('linux')
  })

  it('ignores unknown override values', () => {
    setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    setQuery('?platform=beos')
    expect(getPlatform()).toBe('windows')
  })

  it('caches until reset', () => {
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(getPlatform()).toBe('macos')
    setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(getPlatform()).toBe('macos')
    __resetPlatformForTests()
    expect(getPlatform()).toBe('windows')
  })
})
