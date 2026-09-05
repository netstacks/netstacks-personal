import { describe, it, expect, vi } from 'vitest'

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../../hooks/useSettings', () => ({ getSettings: () => settings.current }))

import { shouldConfirmPaste } from '../clipTransforms'

describe('shouldConfirmPaste', () => {
  it('defaults to confirming any multi-line paste', () => {
    settings.current = {}
    expect(shouldConfirmPaste('show version')).toBe(false)
    expect(shouldConfirmPaste('show version\n')).toBe(false)
    expect(shouldConfirmPaste('conf t\ninterface Gi0/1\n')).toBe(true)
    expect(shouldConfirmPaste('a\r\nb')).toBe(true)
  })

  it('honours the threshold and the off switch', () => {
    settings.current = { 'clipboard.confirmPasteLines': 5 }
    expect(shouldConfirmPaste('1\n2\n3\n4')).toBe(false)
    expect(shouldConfirmPaste('1\n2\n3\n4\n5')).toBe(true)
    settings.current = { 'clipboard.confirmPasteLines': 1 }
    expect(shouldConfirmPaste('single')).toBe(true)
    settings.current = { 'clipboard.confirmMultilinePaste': false }
    expect(shouldConfirmPaste('1\n2\n3')).toBe(false)
    settings.current = { 'clipboard.confirmPasteLines': 'garbage' }
    expect(shouldConfirmPaste('1\n2')).toBe(true)
  })

  it('the advanced-paste master switch disables confirm and transforms', async () => {
    const { preparePasteText } = await import('../clipTransforms')
    settings.current = { 'clipboard.advancedPaste': false }
    expect(shouldConfirmPaste('1\n2\n3')).toBe(false)
    expect(preparePasteText('! c\r\nx\r\n', 'cisco-ios')).toBe('! c\r\nx\r\n')
    settings.current = {}
    expect(preparePasteText('! c\r\nx\r\n', 'cisco-ios')).toBe('x')
  })
})
