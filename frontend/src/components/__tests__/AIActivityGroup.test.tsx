import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import AIActivityGroup from '../AIActivityGroup'

const tool = (id: string, command: string, exitCode = 0) => ({ id, type: 'command-result', content: '', command, output: 'out', exitCode })
const thought = (id: string, content: string) => ({ id, type: 'reasoning', content })

describe('AIActivityGroup', () => {
  it('is open and says what it is doing while live', () => {
    const { container } = render(<AIActivityGroup live msgs={[thought('1', 'Check docs'), tool('2', 'list_documents()')]} />)
    const details = container.querySelector('details.ai-activity') as HTMLDetailsElement
    expect(details.open).toBe(true)
    expect(container.querySelector('.ai-activity-title')!.textContent).toBe('Working')
    expect(container.querySelector('.ai-activity-latest')!.textContent).toBe('list_documents()')
    expect(container.querySelectorAll('.ai-activity-list > details')).toHaveLength(2)
  })

  it('folds to a summary when done, but stays open on a failure', () => {
    const done = render(<AIActivityGroup live={false} msgs={[tool('1', 'a()'), tool('2', 'b()')]} />)
    expect((done.container.querySelector('details.ai-activity') as HTMLDetailsElement).open).toBe(false)
    expect(done.container.querySelector('.ai-activity-title')!.textContent).toBe('Used 2 tools')

    const failed = render(<AIActivityGroup live={false} msgs={[tool('1', 'a()'), tool('2', 'b()', 1)]} />)
    expect((failed.container.querySelector('details.ai-activity') as HTMLDetailsElement).open).toBe(true)
    expect(failed.container.querySelector('.ai-activity-failed')!.textContent).toBe('1 failed')
  })
})
