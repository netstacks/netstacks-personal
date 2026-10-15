import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyAppTheme, getAppTheme, isAppTheme, resolveTheme, setAppTheme, setNativeTheme } from './appTheme'

type ChangeListener = () => void

function mockColorScheme(initialDark: boolean) {
  const listeners = new Set<ChangeListener>()
  const query = {
    matches: initialDark,
    addEventListener: (_: string, l: ChangeListener) => listeners.add(l),
    removeEventListener: (_: string, l: ChangeListener) => listeners.delete(l),
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    listeners,
    setDark(dark: boolean) {
      query.matches = dark
      listeners.forEach(l => l())
    },
  }
}

const root = document.documentElement

beforeEach(() => {
  localStorage.clear()
  delete root.dataset.theme
  delete root.dataset.themeVariant
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveTheme', () => {
  it('system follows the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('explicit choices ignore the OS preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light-deep', true)).toBe('light')
  })
})

describe('getAppTheme', () => {
  it('defaults to system when nothing is stored', () => {
    expect(getAppTheme()).toBe('system')
  })

  it('returns a stored choice and ignores unknown values', () => {
    localStorage.setItem('netstacks.appTheme', 'light-deep')
    expect(getAppTheme()).toBe('light-deep')
    localStorage.setItem('netstacks.appTheme', 'solarized')
    expect(getAppTheme()).toBe('system')
  })

  it('isAppTheme accepts exactly the four themes', () => {
    expect(['system', 'light', 'light-deep', 'dark'].every(isAppTheme)).toBe(true)
    expect(isAppTheme('Dark')).toBe(false)
    expect(isAppTheme(null)).toBe(false)
  })
})

describe('applyAppTheme', () => {
  it('system reacts to OS color-scheme changes', () => {
    const scheme = mockColorScheme(true)
    applyAppTheme('system')
    expect(root.dataset.theme).toBe('dark')
    scheme.setDark(false)
    expect(root.dataset.theme).toBe('light')
  })

  it('stops following the OS when an explicit theme is chosen', () => {
    const scheme = mockColorScheme(true)
    applyAppTheme('system')
    applyAppTheme('dark')
    expect(scheme.listeners.size).toBe(0)
    scheme.setDark(false)
    expect(root.dataset.theme).toBe('dark')
  })

  it('light-deep resolves to light with the deep variant attribute', () => {
    mockColorScheme(true)
    applyAppTheme('light-deep')
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.themeVariant).toBe('deep')
    applyAppTheme('light')
    expect(root.dataset.themeVariant).toBeUndefined()
  })

  it('the native window theme wins over the media query for system', () => {
    mockColorScheme(true)
    applyAppTheme('system')
    setNativeTheme('light')
    expect(root.dataset.theme).toBe('light')
    setNativeTheme('dark')
    expect(root.dataset.theme).toBe('dark')
  })
})

describe('setAppTheme', () => {
  it('persists and applies', () => {
    mockColorScheme(false)
    setAppTheme('dark')
    expect(localStorage.getItem('netstacks.appTheme')).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })
})
