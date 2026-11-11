import { describe, it, expect, afterEach } from 'vitest'
import { resolveDocSaveTarget, DEFAULT_SAVE_TARGETS } from '../docSaveTargets'
import { getSettings, setGlobalSettings } from '../../hooks/useSettings'

const base = getSettings()

afterEach(() => setGlobalSettings({ ...base, 'documents.saveTargets': {} }))

describe('resolveDocSaveTarget', () => {
  it('returns defaults when unconfigured', () => {
    setGlobalSettings({ ...base, 'documents.saveTargets': {} })
    expect(resolveDocSaveTarget('deviceEnrichment')).toEqual({ category: 'notes', folder: 'snapshots' })
    expect(resolveDocSaveTarget('topologySnapshot')).toEqual({ category: 'backups', folder: undefined })
    expect(resolveDocSaveTarget('mop').category).toBe('mops')
  })

  it('applies a user override (category + folder)', () => {
    setGlobalSettings({ ...base, 'documents.saveTargets': { deviceEnrichment: { category: 'outputs', folder: 'devices' } } })
    expect(resolveDocSaveTarget('deviceEnrichment')).toEqual({ category: 'outputs', folder: 'devices' })
  })

  it('treats a blank folder as no folder and falls back to default category', () => {
    setGlobalSettings({ ...base, 'documents.saveTargets': { troubleshooting: { category: '', folder: '   ' } } })
    expect(resolveDocSaveTarget('troubleshooting')).toEqual({ category: 'troubleshooting', folder: undefined })
  })

  it('every source has a default', () => {
    for (const key of Object.keys(DEFAULT_SAVE_TARGETS)) {
      expect(DEFAULT_SAVE_TARGETS[key as keyof typeof DEFAULT_SAVE_TARGETS].category).toBeTruthy()
    }
  })
})
