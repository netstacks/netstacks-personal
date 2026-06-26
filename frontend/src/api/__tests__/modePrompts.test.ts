import { describe, it, expect } from 'vitest'
import { decideModePromptMigration, type ModePromptMigrationDecision } from '../ai'

const baseCfg = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-20250514',
}

describe('decideModePromptMigration', () => {
  it('does not migrate when troubleshoot already has a value', () => {
    const decision = decideModePromptMigration('Be terse.', { ...baseCfg, systemPrompt: 'Be verbose.' })
    expect(decision).toEqual({ migrate: false })
  })

  it('migrates when troubleshoot value is whitespace-only (treated as empty)', () => {
    // (Defensive — the loader normalizes whitespace to null upstream, but we
    // still want this branch covered in case future callers pass through raw.)
    const decision = decideModePromptMigration('   ', { ...baseCfg, systemPrompt: 'X' })
    expect(decision.migrate).toBe(true)
  })

  it('does not migrate when legacy config is null', () => {
    const decision = decideModePromptMigration(null, null)
    expect(decision).toEqual({ migrate: false })
  })

  it('does not migrate when legacy systemPrompt field is missing', () => {
    const decision = decideModePromptMigration(null, baseCfg)
    expect(decision).toEqual({ migrate: false })
  })

  it('does not migrate when legacy systemPrompt is empty string', () => {
    const decision = decideModePromptMigration(null, { ...baseCfg, systemPrompt: '' })
    expect(decision).toEqual({ migrate: false })
  })

  it('does not migrate when legacy systemPrompt is whitespace only', () => {
    const decision = decideModePromptMigration(null, { ...baseCfg, systemPrompt: '   ' })
    expect(decision).toEqual({ migrate: false })
  })

  it('migrates when troubleshoot empty and legacy non-empty', () => {
    const cfg = { ...baseCfg, systemPrompt: 'Always answer as a haiku.' }
    const decision = decideModePromptMigration(null, cfg) as Extract<ModePromptMigrationDecision, { migrate: true }>
    expect(decision.migrate).toBe(true)
    expect(decision.value).toBe('Always answer as a haiku.')
    expect(decision.clearedConfig).toEqual({ ...baseCfg, systemPrompt: undefined })
  })

  it('preserves all other config fields when clearing systemPrompt', () => {
    const cfg = {
      ...baseCfg,
      systemPrompt: 'X',
      base_url: 'https://example.com',
      auth_mode: 'oauth2' as const,
    }
    const decision = decideModePromptMigration(null, cfg) as Extract<ModePromptMigrationDecision, { migrate: true }>
    expect(decision.clearedConfig).toEqual({
      ...baseCfg,
      base_url: 'https://example.com',
      auth_mode: 'oauth2',
      systemPrompt: undefined,
    })
  })
})
