import { describe, it, expect } from 'vitest'
import { decodeOsc52Payload } from '../osc52'

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('decodeOsc52Payload', () => {
  it('round-trips non-ASCII text exactly (no Latin-1 mojibake)', () => {
    const text = '⏺ Sautéed for 36s · done 8:31 PM — ✻ ok'
    expect(decodeOsc52Payload(b64(text))).toBe(text)
  })

  it('handles plain ASCII', () => {
    expect(decodeOsc52Payload(btoa('git log -1'))).toBe('git log -1')
  })

  it('rejects malformed input', () => {
    expect(() => decodeOsc52Payload('***')).toThrow()
    expect(() => decodeOsc52Payload(btoa('\xff\xfe'))).toThrow()
  })
})
