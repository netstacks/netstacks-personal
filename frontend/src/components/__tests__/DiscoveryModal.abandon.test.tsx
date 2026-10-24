import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { TargetDiscoveryResult } from '../../types/discovery'

const runBatchDiscovery = vi.fn()
vi.mock('../../api/discovery', () => ({
  runBatchDiscovery: (...args: unknown[]) => runBatchDiscovery(...args),
  getDiscoveryCapabilities: () => Promise.resolve(null),
}))

import DiscoveryModal from '../DiscoveryModal'

const devices = [{ name: 'r1', tabId: 't1', ip: '10.0.0.1' }]

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const result = { ip: '10.0.0.1', sysName: 'r1', sysDescr: null, neighbors: [], discoveryMethod: 'lldp', nmap: null, error: null } as unknown as TargetDiscoveryResult

beforeEach(() => {
  runBatchDiscovery.mockReset()
  // jsdom has no layout: the log auto-scroll needs a stub.
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe('DiscoveryModal run abandonment', () => {
  it('reports results for a run the user waited for', async () => {
    const pending = deferred<TargetDiscoveryResult[]>()
    runBatchDiscovery.mockReturnValue(pending.promise)
    const onDiscoveryComplete = vi.fn()
    render(<DiscoveryModal isOpen onClose={() => {}} groupName="g" devices={devices} onDiscoveryComplete={onDiscoveryComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start Discovery' }))
    await act(async () => { pending.resolve([result]) })

    expect(onDiscoveryComplete).toHaveBeenCalledTimes(1)
  })

  it('offers Cancel while running and ignores the completion after closing', async () => {
    const pending = deferred<TargetDiscoveryResult[]>()
    runBatchDiscovery.mockReturnValue(pending.promise)
    const onDiscoveryComplete = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(<DiscoveryModal isOpen onClose={onClose} groupName="g" devices={devices} onDiscoveryComplete={onDiscoveryComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start Discovery' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Discovery' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<DiscoveryModal isOpen={false} onClose={onClose} groupName="g" devices={devices} onDiscoveryComplete={onDiscoveryComplete} />)

    await act(async () => { pending.resolve([result]) })
    expect(onDiscoveryComplete).not.toHaveBeenCalled()
  })

  it('ignores a stale run that completes after the modal was reopened', async () => {
    const first = deferred<TargetDiscoveryResult[]>()
    runBatchDiscovery.mockReturnValueOnce(first.promise)
    const onDiscoveryComplete = vi.fn()
    const props = { onClose: () => {}, groupName: 'g', devices, onDiscoveryComplete }
    const { rerender } = render(<DiscoveryModal isOpen {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start Discovery' }))
    rerender(<DiscoveryModal isOpen={false} {...props} />)
    rerender(<DiscoveryModal isOpen {...props} />)

    await act(async () => { first.resolve([result]) })
    expect(onDiscoveryComplete).not.toHaveBeenCalled()
    // The reopened modal is still idle, not showing the stale run's outcome.
    expect(screen.getByRole('button', { name: 'Start Discovery' })).toBeInTheDocument()
  })
})
