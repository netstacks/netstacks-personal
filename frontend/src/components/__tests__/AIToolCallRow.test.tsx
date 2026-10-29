import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import AIToolCallRow from '../AIToolCallRow'

describe('AIToolCallRow', () => {
  it('keeps <summary> as the direct child of <details> (else the browser shows a bare "Details")', () => {
    const { container } = render(<AIToolCallRow command="get_mop(id=1)" output="ok" failed={false} />)
    const details = container.querySelector('details')!
    expect(details.firstElementChild?.tagName).toBe('SUMMARY')
    expect(details.querySelector(':scope > summary')!.textContent).toContain('get_mop(id=1)')
  })

  it('opens failed calls so the reason is visible, folds successful ones', () => {
    const failed = render(<AIToolCallRow command="create_mop()" output="sessionIds is required" failed />)
    const failedDetails = failed.container.querySelector('details')!
    expect(failedDetails.open).toBe(true)
    expect(failedDetails.classList.contains('failed')).toBe(true)
    expect(failedDetails.textContent).toContain('sessionIds is required')

    const ok = render(<AIToolCallRow command="list_sessions()" output="3 sessions" failed={false} />)
    expect(ok.container.querySelector('details')!.open).toBe(false)
  })

  it('shows every line of a batched command and the session', () => {
    const { container } = render(
      <AIToolCallRow command={'[ssh] uname -a\n[ssh] hostname'} sessionName="core-rtr-1" failed={false} />,
    )
    expect(container.querySelector('.ai-tool-call-command')!.textContent).toBe('[ssh] uname -a\n[ssh] hostname')
    expect(container.textContent).toContain('core-rtr-1')
    expect(container.querySelector('details')!.classList.contains('empty')).toBe(true)
  })
})
