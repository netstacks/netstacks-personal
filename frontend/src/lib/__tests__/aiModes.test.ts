import { describe, it, expect, afterEach } from 'vitest'
import { getSystemPrompt, getPermissionMode, AGENT_TYPES, AGENT_PROMPT, type AgentType } from '../aiModes'
import { defaultSettings, setGlobalSettings } from '../../hooks/useSettings'

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
    }
  })
})

describe('permission mode', () => {
  afterEach(() => setGlobalSettings(defaultSettings))

  it('defaults to auto for autopilot and ask for overlord', () => {
    expect(getPermissionMode('autopilot')).toBe('auto')
    expect(getPermissionMode('overlord')).toBe('ask')
  })

  it('reads the per-agent-type setting and states it in the mode block', () => {
    setGlobalSettings({ ...defaultSettings, 'ai.permissionMode.overlord': 'yolo' })
    expect(getPermissionMode('overlord')).toBe('yolo')
    expect(getSystemPrompt('overlord', false)).toContain('permission mode: Go Nuts')
    expect(getSystemPrompt('autopilot', false)).toContain('permission mode: Auto')
  })

  it('reports run_bash per mode from the disabled-tools setting', () => {
    expect(getSystemPrompt('autopilot', false)).toContain('You HAVE the local shell')
    expect(getSystemPrompt('overlord', false)).toContain('You do NOT have the local shell')
    setGlobalSettings({ ...defaultSettings, 'ai.disabledTools.overlord': [] })
    expect(getSystemPrompt('overlord', false)).toContain('You HAVE the local shell')
  })

  it('never offers the local shell in enterprise (run_bash runs on the local agent)', () => {
    setGlobalSettings({ ...defaultSettings, 'ai.disabledTools.overlord': [] })
    for (const agentType of ['autopilot', 'overlord'] as const) {
      const prompt = getSystemPrompt(agentType, true)
      expect(prompt).toContain('You do NOT have the local shell')
      expect(prompt).toContain('connected to a Controller')
      expect(prompt).not.toContain('switch to the')
    }
  })
})

describe('AGENT_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof AGENT_PROMPT).toBe('string')
    expect(AGENT_PROMPT.length).toBeGreaterThan(0)
  })
})

describe('LIVE_CONTEXT_RULES', () => {
  it('includes live-context safe-action rules', () => {
    const out = getSystemPrompt('autopilot', false)
    expect(out).toContain('LIVE WORKSPACE STATE')
    expect(out).toContain('uncommitted changes')
    expect(out).toMatch(/do not (run|answer)/i)
  })
})
