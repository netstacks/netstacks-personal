import { describe, it, expect } from 'vitest'
import { getToolByName, getAvailableTools, TOOL_REGISTRY } from '../agentTools'

describe('document tools cover all categories', () => {
  const cats = ['outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops']
  for (const tool of ['list_documents', 'search_documents', 'save_document']) {
    it(`${tool} category enum includes all 7 categories`, () => {
      const def = getToolByName(tool)
      expect(def).toBeTruthy()
      const enumValues = def!.parameters.properties.category?.enum ?? []
      for (const c of cats) expect(enumValues).toContain(c)
    })
  }

  it('read_document accepts a name parameter and requires neither id nor name statically', () => {
    const def = getToolByName('read_document')
    expect(def).toBeTruthy()
    expect(Object.keys(def!.parameters.properties)).toContain('name')
    expect(Object.keys(def!.parameters.properties)).toContain('document_id')
    expect(def!.parameters.required).toEqual([])
  })
})

describe('OOB console tools', () => {
  it('are defined, registered as default-off, and removable via disabled list', () => {
    for (const name of ['open_console', 'run_console_command']) {
      expect(getToolByName(name)).toBeTruthy()
      const entry = TOOL_REGISTRY.find((t) => t.name === name)
      expect(entry?.category).toBe('console')
      expect(entry?.defaultDisabled).toBe(true)
    }
    const names = (disabled: string[]) => getAvailableTools({ hasSessions: true, hasExecuteCommand: true }, disabled).map((t) => t.name)
    expect(names([])).toEqual(expect.arrayContaining(['open_console', 'run_console_command']))
    expect(names(['open_console', 'run_console_command'])).not.toEqual(expect.arrayContaining(['open_console']))
  })
})
