import { describe, it, expect } from 'vitest'
import { getSystemPrompt, NETSTACKS_CONCEPTS_PRIMER } from '../aiModes'

describe('NetStacks concept knowledge in the AI prompt', () => {
  it('system prompt teaches the core concepts', () => {
    const prompt = getSystemPrompt('autopilot', false)
    expect(prompt).toContain('API Resource')
    expect(prompt).toContain('Integrations')
    expect(prompt).toContain('Crawler = Netdisco')
    expect(prompt).toContain('Token matchers')
    expect(prompt).toContain('Enrichment')
  })

  it('compact primer covers API Resource, Crawler=Netdisco, token matchers', () => {
    expect(NETSTACKS_CONCEPTS_PRIMER).toContain('API Resource')
    expect(NETSTACKS_CONCEPTS_PRIMER.toLowerCase()).toContain('netdisco')
    expect(NETSTACKS_CONCEPTS_PRIMER).toContain('token matchers')
  })
})
