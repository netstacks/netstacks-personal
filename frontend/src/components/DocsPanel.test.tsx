import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import DocsPanel, { DOCS_SELECT_CATEGORY_EVENT } from './DocsPanel'
import type { Document } from '../api/docs'

// NS-APP-14: Quick Look Notes / Templates / Outputs focus their category via
// the `initialCategory` prop (panel mounting) or the select-category event
// (panel already mounted).
const outputDoc: Document = {
  id: 'd1',
  name: 'show-version.txt',
  category: 'outputs',
  content_type: 'text',
  content: '',
  parent_folder: null,
  session_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

vi.mock('../api/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/docs')>()),
  listDocuments: vi.fn(),
}))

import { listDocuments } from '../api/docs'
vi.mocked(listDocuments).mockResolvedValue([outputDoc])

const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

afterEach(() => {
  cleanup()
  scrollIntoView.mockClear()
})

describe('DocsPanel category focus', () => {
  it('expands initialCategory even when empty and load finishes after mount', async () => {
    render(<DocsPanel onOpenDocument={() => {}} onNewDocument={() => {}} initialCategory="templates" />)
    // Outputs auto-expands (has a document); Templates is empty but was requested.
    expect(await screen.findByText('show-version.txt')).toBeInTheDocument()
    expect(screen.getByText('No templates')).toBeInTheDocument()
    expect(screen.queryByText('No notes')).not.toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('expands the category named by netstacks:docs-select-category', async () => {
    render(<DocsPanel onOpenDocument={() => {}} onNewDocument={() => {}} />)
    expect(await screen.findByText('show-version.txt')).toBeInTheDocument()
    expect(screen.queryByText('No notes')).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent(DOCS_SELECT_CATEGORY_EVENT, { detail: { category: 'notes' } }))
    })
    expect(await screen.findByText('No notes')).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalled()
  })
})
