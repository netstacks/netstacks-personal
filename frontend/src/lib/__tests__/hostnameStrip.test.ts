import { describe, it, expect } from 'vitest'
import { compileStripPatterns, stripHostname, resolveFullHostname } from '../hostnameStrip'

const P = ['gi-nw\\.viasat\\.io']

describe('stripHostname', () => {
  it('strips a trailing domain and trims the dangling dot', () => {
    expect(stripHostname('dcar01-cdev.nae05.gi-nw.viasat.io', P, true)).toBe('dcar01-cdev.nae05')
  })
  it('returns the name unchanged when disabled', () => {
    expect(stripHostname('a.gi-nw.viasat.io', P, false)).toBe('a.gi-nw.viasat.io')
  })
  it('is case-insensitive', () => {
    expect(stripHostname('X.GI-NW.VIASAT.IO', P, true)).toBe('X')
  })
  it('applies multiple patterns in order', () => {
    expect(stripHostname('h.corp.example.com', ['\\.example\\.com', '\\.corp'], true)).toBe('h')
  })
  it('falls back to the original when the result would be empty', () => {
    expect(stripHostname('gi-nw.viasat.io', P, true)).toBe('gi-nw.viasat.io')
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
  const cands = ['dcar01-cdev.nae05.gi-nw.viasat.io', 'other.host.net']
  it('resolves a stripped reference to the full candidate', () => {
    expect(resolveFullHostname('dcar01-cdev.nae05', cands, P, true)).toBe('dcar01-cdev.nae05.gi-nw.viasat.io')
  })
  it('resolves an exact full reference', () => {
    expect(resolveFullHostname('other.host.net', cands, P, true)).toBe('other.host.net')
  })
  it('returns undefined when nothing matches', () => {
    expect(resolveFullHostname('nope', cands, P, true)).toBeUndefined()
  })
})
