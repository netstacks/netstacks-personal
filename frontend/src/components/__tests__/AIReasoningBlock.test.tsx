import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import AIReasoningBlock from '../AIReasoningBlock'

describe('AIReasoningBlock', () => {
  it('is folded to the latest line, with the full text on expand', () => {
    const { container } = render(<AIReasoningBlock text={'Check the platform.\nIt is Ubuntu, so use uname.'} />)
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.firstElementChild?.tagName).toBe('SUMMARY')
    expect(container.querySelector('.ai-reasoning-preview')!.textContent).toBe('It is Ubuntu, so use uname.')
    expect(container.querySelector('.ai-reasoning-body')!.textContent).toContain('Check the platform.')
  })
})
