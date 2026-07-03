import { describe, it, expect, vi } from 'vitest'

vi.mock('../../api/docs', () => ({
  listDocuments: vi.fn(async () => ([
    { id: '1', name: 'a', category: 'mops', content_type: 'markdown', content: '' },
    { id: '2', name: 'b', category: 'troubleshooting', content_type: 'text', content: '' },
    { id: '3', name: 'c', category: 'mops', content_type: 'markdown', content: '' },
  ])),
}))

import { buildDocumentsOverview } from '../aiDocumentsContext'

describe('buildDocumentsOverview', () => {
  it('lists all categories with counts and never throws', async () => {
    const out = await buildDocumentsOverview()
    expect(out).toContain('DOCUMENTS')
    expect(out).toContain('troubleshooting (1)')
    expect(out).toContain('mops (2)')
    expect(out).toContain('outputs (0)')
  })
})
