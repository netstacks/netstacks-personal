import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const listQuickPrompts = vi.fn()
const listGlobalSnippets = vi.fn()
const listQuickActions = vi.fn()

vi.mock('../../api/quickPrompts', () => ({ listQuickPrompts: () => listQuickPrompts() }))
vi.mock('../../api/snippets', () => ({ listGlobalSnippets: () => listGlobalSnippets() }))
vi.mock('../../api/quickActions', () => ({ listQuickActions: () => listQuickActions() }))

import QuickPromptsMenu from '../QuickPromptsMenu'
import SnippetsMenu from '../SnippetsMenu'
import QuickCallsMenu from '../QuickCallsMenu'

const prompt = (id: string, name: string, fav = false) => ({ id, name, prompt: name, is_favorite: fav, created_at: '', updated_at: '' })

interface Case {
  name: string
  loader: ReturnType<typeof vi.fn>
  items: unknown[]
  rowNames: string[]
  errorText: RegExp
  emptyText: RegExp
  renderMenu: (onSelect: (item: unknown) => void) => void
}

const cases: Case[] = [
  {
    name: 'QuickPromptsMenu',
    loader: listQuickPrompts,
    items: [prompt('1', 'Alpha', true), prompt('2', 'Bravo'), prompt('3', 'Charlie')],
    rowNames: ['Alpha', 'Bravo', 'Charlie'],
    errorText: /Couldn't load prompts/,
    emptyText: /No prompts yet/,
    renderMenu: (onSelect) => render(<QuickPromptsMenu onClose={() => {}} onSelectPrompt={onSelect} onManagePrompts={() => {}} />),
  },
  {
    name: 'SnippetsMenu',
    loader: listGlobalSnippets,
    items: [{ id: '1', name: 'Alpha', command: 'show a' }, { id: '2', name: 'Bravo', command: 'show b' }, { id: '3', name: 'Charlie', command: 'show c' }],
    rowNames: ['Alpha', 'Bravo', 'Charlie'],
    errorText: /Couldn't load snippets/,
    emptyText: /No snippets yet/,
    renderMenu: (onSelect) => render(<SnippetsMenu onClose={() => {}} onSelectSnippet={onSelect} onManageSnippets={() => {}} />),
  },
  {
    name: 'QuickCallsMenu',
    loader: listQuickActions,
    items: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Bravo' }, { id: '3', name: 'Charlie' }],
    rowNames: ['Alpha', 'Bravo', 'Charlie'],
    errorText: /Couldn't load quick calls/,
    emptyText: /No quick calls yet/,
    renderMenu: (onSelect) => render(<QuickCallsMenu onClose={() => {}} onSelectCall={onSelect} onManageQuickCalls={() => {}} />),
  },
]

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  listQuickPrompts.mockReset()
  listGlobalSnippets.mockReset()
  listQuickActions.mockReset()
})

const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) })

describe.each(cases)('$name', (c) => {
  it('shows an error with Retry instead of an empty list when loading fails', async () => {
    c.loader.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(c.items)
    c.renderMenu(() => {})
    expect(await screen.findByRole('alert')).toHaveTextContent(c.errorText)
    expect(screen.queryByText(c.emptyText)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /^Alpha/ })).toBeInTheDocument()
    expect(c.loader).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state only when the list really is empty', async () => {
    c.loader.mockResolvedValueOnce([])
    c.renderMenu(() => {})
    expect(await screen.findByText(c.emptyText)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('rows are buttons reachable with the arrow keys and activated from the keyboard', async () => {
    c.loader.mockResolvedValueOnce(c.items)
    const onSelect = vi.fn()
    c.renderMenu(onSelect)
    await waitFor(() => expect(row('Alpha')).toBeInTheDocument())
    const search = screen.getByPlaceholderText(/Search/)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('Alpha'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('Bravo'))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(row('Charlie'))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(row('Alpha'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(search)
    // Native <button>: Enter/Space dispatch click; activation goes through onClick.
    expect(row('Bravo').tagName).toBe('BUTTON')
    fireEvent.click(row('Bravo'))
    expect(onSelect).toHaveBeenCalledWith(c.items[1])
  })
})
