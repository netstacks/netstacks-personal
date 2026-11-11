import { describe, it, expect, afterEach } from 'vitest'
import { platformMonoFont } from './fonts'

afterEach(() => { document.documentElement.style.removeProperty('--font-family-mono') })

describe('platformMonoFont', () => {
  it('resolves the --font-family-mono token', () => {
    document.documentElement.style.setProperty('--font-family-mono', " ui-monospace, 'SF Mono', Menlo, monospace ")
    expect(platformMonoFont()).toBe("ui-monospace, 'SF Mono', Menlo, monospace")
  })
})
