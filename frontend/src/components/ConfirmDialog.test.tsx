import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

const ask = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask }))

import { ConfirmDialogHost, confirmDialog, resetConfirmQueueForTests } from './ConfirmDialog'

afterEach(() => {
  cleanup()
  resetConfirmQueueForTests()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  ask.mockReset()
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

describe('confirmDialog under Tauri', () => {
  const tauri = () => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {} }

  it('shows a plain-text confirm as a native alert and resolves its answer', async () => {
    tauri()
    ask.mockResolvedValue(true)
    render(<ConfirmDialogHost />)
    await expect(confirmDialog({
      title: 'Delete profile?', body: 'It is used by 3 sessions.', confirmLabel: 'Delete', destructive: true,
    })).resolves.toBe(true)
    expect(ask).toHaveBeenCalledWith('It is used by 3 sessions.\n\nThis action cannot be undone.', {
      title: 'Delete profile?', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel',
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('uses the title as the message when there is no body', async () => {
    tauri()
    ask.mockResolvedValue(false)
    await expect(confirmDialog({ title: 'Disconnect all?' })).resolves.toBe(false)
    expect(ask).toHaveBeenCalledWith('Disconnect all?', expect.objectContaining({ title: undefined, kind: 'info' }))
  })

  it('keeps the HTML dialog for a JSX body', async () => {
    tauri()
    render(<ConfirmDialogHost />)
    await act(async () => {
      confirmDialog({ title: 'Delete?', body: <strong>router-1</strong> })
    })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(ask).not.toHaveBeenCalled()
  })
})
