import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import MarkdownViewer from './MarkdownViewer'

// Audit §14: MarkdownViewer registers an explicit grammar subset. Known
// languages (and their aliases) must highlight; unregistered ones must
// render as plain code instead of throwing.
describe('MarkdownViewer code highlighting', () => {
  afterEach(cleanup)

  it('highlights a registered language via its alias', () => {
    const { container } = render(
      <MarkdownViewer content={'```py\ndef f():\n    return 1\n```'} />,
    )
    const code = container.querySelector('pre code')
    expect(code?.classList.contains('hljs')).toBe(true)
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('def')
  })

  it('renders an unregistered language as plain code without throwing', () => {
    const { container } = render(
      <MarkdownViewer content={'```cisco\ninterface Gi0/1\n shutdown\n```'} />,
    )
    const code = container.querySelector('pre code')
    expect(code?.textContent).toContain('interface Gi0/1')
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull()
  })

  it('does not auto-detect fences without a language', () => {
    const { container } = render(
      <MarkdownViewer content={'```\n{"a": 1}\n```'} />,
    )
    const code = container.querySelector('pre code')
    expect(code?.textContent).toContain('{"a": 1}')
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull()
  })
})
