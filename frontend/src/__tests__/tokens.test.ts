import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Rule } from 'postcss'

const css = postcss.parse(readFileSync(join(__dirname, '..', 'index.css'), 'utf8'))

const REQUIRED = [
  '--font-family', '--font-family-mono', '--font-size-base', '--font-size-small',
  '--radius-control', '--radius-panel', '--row-height', '--control-height',
  '--size-header', '--size-tab-bar', '--focus-ring', '--transition-fast', '--transition-normal',
]

function declsOf(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== 'root' || rule.selector !== selector) return
    rule.walkDecls(d => { out.set(d.prop, d.value) })
  })
  return out
}

/** Tokens a platform resolves: the base :root block overridden by its data-platform block. */
function platformTokens(platform: string): Map<string, string> {
  return new Map([...declsOf(':root'), ...declsOf(`:root[data-platform='${platform}']`)])
}

describe('platform design tokens', () => {
  it.each(['macos', 'windows', 'linux'])('%s defines every required token', (platform) => {
    const tokens = platformTokens(platform)
    expect(REQUIRED.filter(t => !tokens.has(t))).toEqual([])
  })

  it('uses platform-native fonts and metrics', () => {
    expect(platformTokens('macos').get('--font-family')).toMatch(/^-apple-system/)
    expect(platformTokens('windows').get('--font-family')).toMatch(/^'Segoe UI Variable Text'/)
    expect(platformTokens('windows').get('--font-size-base')).toBe('14px')
    expect(platformTokens('macos').get('--font-size-base')).toBe('13px')
  })

  it('declares color-scheme per theme, never on bare :root', () => {
    expect(declsOf(':root').has('color-scheme')).toBe(false)
    expect(declsOf(":root[data-theme='dark']").get('color-scheme')).toBe('dark')
    expect(declsOf(":root[data-theme='light']").get('color-scheme')).toBe('light')
  })
})

describe('global interaction rules', () => {
  const selectorsWith = (needle: string) => {
    const out: string[] = []
    css.walkRules((rule: Rule) => { if (rule.selector.includes(needle)) out.push(rule.selector) })
    return out
  }

  it('styles scrollbars only on Windows and Linux (macOS keeps overlay scrollbars)', () => {
    const scrollbar = selectorsWith('::-webkit-scrollbar')
    expect(scrollbar.length).toBeGreaterThan(0)
    for (const selector of scrollbar) {
      for (const part of selector.split(',')) expect(part.trim()).toMatch(/^:root\[data-platform='(windows|linux)'\]/)
    }
  })

  it('rings keyboard focus with the focus token and never strips other box-shadows on focus', () => {
    expect(declsOf(':focus-visible').get('box-shadow')).toBe('var(--focus-ring)')
    expect(selectorsWith(':focus:not(:focus-visible)')).toEqual([])
  })
})
