import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { ConfirmDialogHost, confirmDialog, resetConfirmQueueForTests } from './ConfirmDialog'

afterEach(() => {
  cleanup()
  resetConfirmQueueForTests()
})

describe('confirmDialog queue', () => {
  it('shows three concurrent confirms one at a time, in FIFO order, and settles all of them', async () => {
    render(<ConfirmDialogHost />)

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    let third!: Promise<boolean>
    await act(async () => {
      first = confirmDialog({ title: 'First?' })
      second = confirmDialog({ title: 'Second?' })
      third = confirmDialog({ title: 'Third?' })
    })

    expect(screen.getByRole('heading', { name: 'First?' })).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Confirm' }).click()
    })
    await expect(first).resolves.toBe(true)

    // The middle request must not be lost.
    expect(screen.getByRole('heading', { name: 'Second?' })).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Cancel' }).click()
    })
    await expect(second).resolves.toBe(false)

    expect(screen.getByRole('heading', { name: 'Third?' })).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Confirm' }).click()
    })
    await expect(third).resolves.toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Escape resolves false and advances to the next queued confirm', async () => {
    render(<ConfirmDialogHost />)

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = confirmDialog({ title: 'First?' })
      second = confirmDialog({ title: 'Second?' })
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(first).resolves.toBe(false)
    expect(screen.getByRole('heading', { name: 'Second?' })).toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(second).resolves.toBe(false)
  })
})
