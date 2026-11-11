import { describe, it, expect } from 'vitest'
import { compileStripPatterns, stripHostname, resolveFullHostname } from '../hostnameStrip'

const P = ['net\\.example\\.com']

describe('stripHostname', () => {
  it('strips a trailing domain and trims the dangling dot', () => {
    expect(stripHostname('core01-lab.dc1.net.example.com', P, true)).toBe('core01-lab.dc1')
  })
  it('returns the name unchanged when disabled', () => {
    expect(stripHostname('a.net.example.com', P, false)).toBe('a.net.example.com')
  })
  it('is case-insensitive', () => {
    expect(stripHostname('X.NET.EXAMPLE.COM', P, true)).toBe('X')
  })
  it('applies multiple patterns in order', () => {
    expect(stripHostname('h.corp.example.com', ['\\.example\\.com', '\\.corp'], true)).toBe('h')
  })
  it('falls back to the original when the result would be empty', () => {
    expect(stripHostname('net.example.com', P, true)).toBe('net.example.com')
  })
  it('skips invalid regexes without throwing', () => {
    expect(stripHostname('a.b', ['(', '\\.b'], true)).toBe('a')
  })
  it('no-op when nothing matches', () => {
    expect(stripHostname('router1.other.net', P, true)).toBe('router1.other.net')
  })
})

describe('compileStripPatterns', () => {
  it('splits valid and invalid', () => {
    const { valid, invalid } = compileStripPatterns(['\\.io', '('])
    expect(valid.length).toBe(1)
    expect(invalid.length).toBe(1)
    expect(invalid[0].pattern).toBe('(')
  })
})

describe('resolveFullHostname', () => {
  const cands = ['core01-lab.dc1.net.example.com', 'other.host.net']
  it('resolves a stripped reference to the full candidate', () => {
    expect(resolveFullHostname('core01-lab.dc1', cands, P, true)).toBe('core01-lab.dc1.net.example.com')
  })
  it('resolves an exact full reference', () => {
    expect(resolveFullHostname('other.host.net', cands, P, true)).toBe('other.host.net')
  })
  it('returns undefined when nothing matches', () => {
    expect(resolveFullHostname('nope', cands, P, true)).toBeUndefined()
  })
})
