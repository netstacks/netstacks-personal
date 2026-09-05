import { describe, it, expect } from 'vitest'
import { addedLines, visualize } from '../pastePreviewHelpers'

describe('PastePreview helpers', () => {
  it('makes control characters visible', () => {
    expect(visualize('a\tb\r')).toBe('a→b␍')
    expect(visualize('trail  ')).toBe('trail··')
    expect(visualize('plain')).toBe('plain')
  })

  it('marks lines the preset changed without pairing duplicates twice', () => {
    const original = ['! c', 'interface Gi0/1', '', '', 'shutdown  ']
    const result = ['interface Gi0/1', '', 'shutdown']
    expect([...addedLines(original, result)]).toEqual([2])
    expect(addedLines(['a', 'a'], ['a', 'a', 'a']).size).toBe(1)
  })
})
