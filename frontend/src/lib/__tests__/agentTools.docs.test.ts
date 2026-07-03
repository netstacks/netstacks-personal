import { describe, it, expect } from 'vitest'
import { getToolByName } from '../agentTools'

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
