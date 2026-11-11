import { describe, it, expect } from 'vitest'
import { getAvailableTools, toolRegistryFor, TOOL_CATEGORIES, type AgentTool } from '../agentTools'
import { resolveToolPermission, toolEffect } from '../aiPermissions'
import { aiNavigableSettingsTabs } from '../settingsTabs'

const names = (tools: AgentTool[]) => tools.map(t => t.name)
const settingsTabsOf = (tools: AgentTool[]) => {
  const nav = tools.find(t => t.name === 'navigate_to_settings')
  return (nav?.parameters.properties.tab as { enum: string[] }).enum
}

describe('tools per app mode', () => {
  it('offers run_bash only in standalone (the Controller has no /ai/bash-execute)', () => {
    expect(names(getAvailableTools({}))).toContain('run_bash')
    expect(names(getAvailableTools({ isEnterprise: true }))).not.toContain('run_bash')
  })

  it('navigate_to_settings lists the tabs it is given, and only then is offered', () => {
    expect(names(getAvailableTools({}))).not.toContain('navigate_to_settings')
    const enterpriseTabs = aiNavigableSettingsTabs({ isEnterprise: true, hasFeature: () => false })
    const tools = getAvailableTools({ isEnterprise: true, settingsTabs: enterpriseTabs })
    expect(settingsTabsOf(tools)).toEqual(enterpriseTabs)
    expect(settingsTabsOf(tools)).not.toContain('tunnels')
    expect(tools.find(t => t.name === 'navigate_to_settings')?.description).toContain(`Available tabs: ${enterpriseTabs.join(', ')}.`)
  })

  it('AI Tools rows: run_bash is standalone-only, the Controller server tools enterprise-only', () => {
    const standalone = toolRegistryFor('standalone').map(t => t.name)
    const enterprise = toolRegistryFor('enterprise').map(t => t.name)
    expect(standalone).toContain('run_bash')
    expect(enterprise).not.toContain('run_bash')
    for (const name of ['search_knowledge', 'graph_node', 'graph_neighbors', 'graph_impact', 'graph_path']) {
      expect(enterprise).toContain(name)
      expect(standalone).not.toContain(name)
      expect(toolEffect(name)).toBe('read')
    }
    expect(TOOL_CATEGORIES.controller.label).toMatch(/Controller/)
  })

  it('a disabled Controller server tool is denied', () => {
    const v = resolveToolPermission('graph_impact', { node: 'r1' }, {
      agentType: 'autopilot', mode: 'yolo', disabledTools: ['graph_impact'], bashDeniedCommands: [],
      allowStructuralTopologyEdits: false, terminalMode: false, configMode: false, enterprise: true, enabledMcpTools: new Set(),
    })
    expect(v.decision).toBe('deny')
  })
})
