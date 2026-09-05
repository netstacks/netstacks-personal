import { describe, it, expect } from 'vitest'
import { indexClip, matchesQuery } from '../clipHistoryHelpers'
import type { Clip } from '../../../types/clip'

const clip: Clip = {
  id: '1', text: '\ninterface Gi0/1\n description uplink', createdAt: new Date().toISOString(),
  provenance: { source: 'terminal-selection', sessionName: 'core-sw1', deviceHost: '10.0.0.1', cliFlavor: 'cisco-ios' },
  pinned: false, lineEnding: 'lf', bytes: 34, lines: 2, redacted: false,
}

describe('ClipHistoryPalette helpers', () => {
  it('indexes a clip once and matches every query word against text and provenance', () => {
    const ix = indexClip(clip)
    expect(ix.title).toBe('interface Gi0/1')
    expect(matchesQuery(ix.haystack, '')).toBe(true)
    expect(matchesQuery(ix.haystack, 'uplink')).toBe(true)
    expect(matchesQuery(ix.haystack, 'core-sw1 gi0/1')).toBe(true)
    expect(matchesQuery(ix.haystack, 'cisco terminal')).toBe(true)
    expect(matchesQuery(ix.haystack, '10.0.0.1')).toBe(true)
    expect(matchesQuery(ix.haystack, 'juniper')).toBe(false)
  })
})
