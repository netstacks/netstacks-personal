import { describe, it, expect } from 'vitest'
import { getSystemPrompt, AGENT_TYPES, AGENT_PROMPT, type AgentType } from '../aiModes'

const AGENT_TYPE_KEYS: AgentType[] = ['autopilot', 'overlord']
const SENTINEL = '## Mode: SENTINEL\n\nThis is a test override.'

describe('getSystemPrompt', () => {
  for (const agentType of AGENT_TYPE_KEYS) {
    it(`uses default prompt for ${agentType} when no overrides passed`, () => {
      const out = getSystemPrompt(agentType, true)
      expect(out).toContain('## Agent Tools')
    })

    it(`uses default prompt for ${agentType} when override is empty string`, () => {
      const out = getSystemPrompt(agentType, true, { [agentType]: '' })
      expect(out).toContain('## Agent Tools')
    })

    it(`substitutes override for ${agentType} when override is non-empty`, () => {
      const out = getSystemPrompt(agentType, true, { [agentType]: SENTINEL })
      expect(out).toContain(SENTINEL)
      expect(out).not.toContain('## Agent Tools')
    })
  }

  it('always includes NETSTACKS_IDENTITY', () => {
    const withDefault = getSystemPrompt('autopilot', false)
    const withOverride = getSystemPrompt('autopilot', false, { autopilot: SENTINEL })
    expect(withDefault).toContain('NetStacks Platform Knowledge')
    expect(withOverride).toContain('NetStacks Platform Knowledge')
  })

  it('appends enterprise addendum when isEnterprise=true', () => {
    const out = getSystemPrompt('autopilot', true)
    expect(out).toContain('Enterprise Features Available')
  })

  it('appends standalone addendum when isEnterprise=false', () => {
    const out = getSystemPrompt('autopilot', false)
    expect(out).toContain('enterprise-only features')
  })

  it('override for one agent type does not affect another', () => {
    const out = getSystemPrompt('overlord', true, { autopilot: SENTINEL })
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('## Agent Tools')
  })
})

describe('AGENT_TYPES', () => {
  it('exports autopilot and overlord configs', () => {
    for (const agentType of AGENT_TYPE_KEYS) {
      expect(AGENT_TYPES[agentType]).toBeDefined()
      expect(AGENT_TYPES[agentType].label).toBeTruthy()
      expect(AGENT_TYPES[agentType].enabledFlags.length).toBeGreaterThan(0)
    }
  })

  it('both modes are bash-capable (bash is allocated per-mode via disabledTools)', () => {
    // run_bash can be allocated to either mode now; it is disabled by default
    // for Overlord via ai.disabledTools.overlord = ['run_bash'].
    expect(AGENT_TYPES.autopilot.allowsBash).toBe(true)
    expect(AGENT_TYPES.overlord.allowsBash).toBe(true)
    expect(AGENT_TYPES.overlord.enabledFlags).toContain('hasBash')
  })

  it('autopilot defaults to auto, overlord defaults to ask', () => {
    expect(AGENT_TYPES.autopilot.defaultPermissionMode).toBe('auto')
    expect(AGENT_TYPES.overlord.defaultPermissionMode).toBe('ask')
  })
})

describe('AGENT_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof AGENT_PROMPT).toBe('string')
    expect(AGENT_PROMPT.length).toBeGreaterThan(0)
  })
})
