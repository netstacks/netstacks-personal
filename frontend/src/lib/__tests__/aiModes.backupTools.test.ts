import { describe, it, expect } from 'vitest'
import { getSystemPrompt, BACKUP_TOOLS_PROMPT } from '../aiModes'
import { getAvailableTools } from '../agentTools'

// NS-AI-36: the prompt must only describe the config-backup tools when the
// backend actually offers them; nothing local can execute them.
describe('config-backup tool guidance', () => {
  it('is absent from the default prompt in both tiers', () => {
    for (const enterprise of [false, true]) {
      const out = getSystemPrompt('autopilot', enterprise)
      expect(out).not.toContain('search_config_backups')
      expect(out).not.toContain('### Config Backup Tools')
      expect(out).not.toContain('check config backups first')
    }
  })

  it('is injected under "## Agent Tools" when hasBackupTools is set', () => {
    const out = getSystemPrompt('autopilot', true, undefined, { hasBackupTools: true })
    expect(out).toContain(BACKUP_TOOLS_PROMPT)
    expect(out.indexOf('## Agent Tools')).toBeLessThan(out.indexOf('### Config Backup Tools'))
  })

  it('does not alter a user override', () => {
    const out = getSystemPrompt('autopilot', true, { autopilot: 'CUSTOM' }, { hasBackupTools: true })
    expect(out).toContain('CUSTOM')
    expect(out).not.toContain('search_config_backups')
  })

  it('never offers backup tools from the local tool set, even in enterprise', () => {
    const names = getAvailableTools({ hasBackupAnalysis: true, isEnterprise: true }).map(t => t.name)
    for (const n of ['search_config_backups', 'get_device_config', 'collect_device_backup', 'investigate_config_change']) {
      expect(names).not.toContain(n)
    }
  })
})
