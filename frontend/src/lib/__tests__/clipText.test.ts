import { describe, it, expect } from 'vitest'
import { byteLength, countLines, detectLineEnding, firstLine, formatClipSize } from '../clipText'

describe('clipText', () => {
  it('classifies line endings', () => {
    expect(detectLineEnding('one line')).toBe('none')
    expect(detectLineEnding('a\nb\n')).toBe('lf')
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf')
    expect(detectLineEnding('a\rb\r')).toBe('cr')
    expect(detectLineEnding('a\r\nb\nc')).toBe('mixed')
  })

  it('counts lines like a terminal paste', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('x')).toBe(1)
    expect(countLines('x\n')).toBe(1)
    expect(countLines('x\ny')).toBe(2)
    expect(countLines('x\r\ny\r\n')).toBe(2)
    expect(countLines('x\ry')).toBe(2)
  })

  it('first line skips leading blank lines and truncates', () => {
    expect(firstLine('\n\n  interface Gi0/1\n shutdown')).toBe('interface Gi0/1')
    expect(firstLine('a'.repeat(200), 20)).toHaveLength(20)
    expect(firstLine('   ')).toBe('')
  })

  it('formats sizes', () => {
    expect(byteLength('é')).toBe(2)
    expect(formatClipSize(11, 1)).toBe('1 line · 11 B')
    expect(formatClipSize(2048, 40)).toBe('40 lines · 2.00 KB')
  })
})
