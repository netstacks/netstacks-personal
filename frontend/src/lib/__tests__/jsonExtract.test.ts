import { describe, expect, it } from 'vitest'
import { jsonExtract, parsePathSegments } from '../jsonExtract'

const netbox = {
  count: 14944,
  results: [
    { comments: 'OS Version: 12.3R8.7', config_context: { FLIGHT: 'NA' }, tags: [{ name: 'core' }, { name: 'edge' }] },
    { comments: null, config_context: { FLIGHT: 'EU' }, tags: [] },
  ],
}

describe('jsonExtract', () => {
  it('resolves index then key on a paginated response', () => {
    expect(jsonExtract(netbox, 'results[0].comments')).toBe('OS Version: 12.3R8.7')
    expect(jsonExtract(netbox, 'results[0].config_context.FLIGHT')).toBe('NA')
  })

  it('ignores whitespace around the path and keys, and a trailing dot', () => {
    expect(jsonExtract(netbox, ' results[0].comments ')).toBe('OS Version: 12.3R8.7')
    expect(jsonExtract(netbox, 'results[0]. comments\t')).toBe('OS Version: 12.3R8.7')
    expect(jsonExtract(netbox, 'results[0].comments.')).toBe('OS Version: 12.3R8.7')
  })

  it('distinguishes a JSON null hit from a miss', () => {
    expect(jsonExtract(netbox, 'results[1].comments')).toBeNull()
    expect(jsonExtract(netbox, 'results[9].comments')).toBeUndefined()
    expect(jsonExtract(netbox, 'nope')).toBeUndefined()
    expect(jsonExtract(netbox, '')).toBeUndefined()
  })

  it('fans out with [*] and drops misses', () => {
    expect(jsonExtract(netbox, 'results[*].config_context.FLIGHT')).toEqual(['NA', 'EU'])
    expect(jsonExtract(netbox, 'results[*].tags[*].name')).toEqual([['core', 'edge'], []])
  })

  it('accepts quoted keys in brackets', () => {
    expect(jsonExtract({ 'a b': { c: 1 } }, '["a b"].c')).toBe(1)
    expect(parsePathSegments("x['y'][2]")).toEqual([
      { kind: 'key', key: 'x' },
      { kind: 'key', key: 'y' },
      { kind: 'index', index: 2 },
    ])
  })
})
