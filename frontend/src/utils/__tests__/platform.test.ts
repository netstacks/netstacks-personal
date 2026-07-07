// frontend/src/utils/__tests__/platform.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getPlatform } from '../platform'

function setUA(ua: string) {
  vi.stubGlobal('navigator', { userAgent: ua, platform: '' })
}
afterEach(() => vi.unstubAllGlobals())

describe('getPlatform', () => {
  it('detects macOS', () => { setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'); expect(getPlatform()).toBe('macos') })
  it('detects Windows', () => { setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'); expect(getPlatform()).toBe('windows') })
  it('defaults to linux', () => { setUA('Mozilla/5.0 (X11; Linux x86_64)'); expect(getPlatform()).toBe('linux') })
})
