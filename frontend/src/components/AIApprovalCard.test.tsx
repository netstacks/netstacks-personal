import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import AIApprovalCard from './AIApprovalCard'
import { __resetPlatformForTests } from '../utils/platform'
import type { PendingCommand } from '../api/agent'

const pending = [{ id: 't1', command: 'show version', sessionId: 's1', sessionName: 'core-rtr-01', toolName: 'run_command', reason: 'Device command' }] as unknown as PendingCommand[]

function renderOn(platform: 'macos' | 'windows' | 'linux') {
  vi.stubGlobal('location', { ...window.location, search: `?platform=${platform}` })
  __resetPlatformForTests()
  render(<AIApprovalCard pending={pending} onApprove={() => {}} onReject={() => {}} />)
  return screen.getAllByRole('button').map(b => b.textContent?.trim())
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetPlatformForTests()
})

describe('AIApprovalCard', () => {
  it.each(['macos', 'linux'] as const)('puts Approve rightmost on %s', (platform) => {
    expect(renderOn(platform)).toEqual(['Reject', 'Approve'])
  })

  it('puts Approve first on Windows', () => {
    expect(renderOn('windows')).toEqual(['Approve', 'Reject'])
  })
})
