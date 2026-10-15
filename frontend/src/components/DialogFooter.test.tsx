import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import DialogFooter from './DialogFooter'
import { __resetPlatformForTests } from '../utils/platform'

function renderOn(platform: 'macos' | 'windows' | 'linux', props: Partial<Parameters<typeof DialogFooter>[0]> = {}) {
  vi.stubGlobal('location', { ...window.location, search: `?platform=${platform}` })
  __resetPlatformForTests()
  const onSave = vi.fn()
  const onCancel = vi.fn()
  render(
    <div>
      <input aria-label="Name" />
      <textarea aria-label="Notes" />
      <DialogFooter primary={{ label: 'Save', onClick: onSave }} onCancel={onCancel} {...props} />
    </div>,
  )
  return { onSave, onCancel }
}

const labels = () => screen.getAllByRole('button').map(b => b.textContent)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetPlatformForTests()
})

describe('DialogFooter', () => {
  it.each(['macos', 'linux'] as const)('puts the primary action rightmost on %s', (platform) => {
    renderOn(platform)
    expect(labels()).toEqual(['Cancel', 'Save'])
  })

  it('puts the primary action first on Windows', () => {
    renderOn('windows')
    expect(labels()).toEqual(['Save', 'Cancel'])
  })

  it('keeps leading actions before the platform-ordered pair', () => {
    renderOn('windows', { leading: <button type="button">Delete</button> })
    expect(labels()).toEqual(['Delete', 'Save', 'Cancel'])
  })

  it('Enter in a field triggers the primary action, but not in a textarea', () => {
    const { onSave } = renderOn('macos')
    fireEvent.keyDown(screen.getByLabelText('Notes'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
    expect(onSave).toHaveBeenCalledOnce()
  })

  it('Enter does nothing while the primary action is disabled', () => {
    const { onSave } = renderOn('macos', { primary: { label: 'Save', onClick: () => onSave(), disabled: true } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Cancel calls onCancel', () => {
    const { onCancel } = renderOn('macos')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('DialogFooter options', () => {
  it('disables Cancel while an uninterruptible operation runs', () => {
    renderOn('macos', { cancelDisabled: true })
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('marks an inline row so it drops the dialog bar styling', () => {
    renderOn('macos', { inline: true })
    expect(screen.getByRole('button', { name: 'Cancel' }).parentElement).toHaveClass('dialog-actions', 'dialog-actions--inline')
  })
})

describe('DialogFooter Enter handling', () => {
  it('leaves Enter to a field that handles it itself', () => {
    vi.stubGlobal('location', { ...window.location, search: '?platform=macos' })
    __resetPlatformForTests()
    const onSave = vi.fn()
    render(
      <div>
        <input aria-label="Shortcut" onKeyDown={(e) => e.preventDefault()} />
        <DialogFooter primary={{ label: 'Save', onClick: onSave }} onCancel={() => {}} />
      </div>,
    )
    fireEvent.keyDown(screen.getByLabelText('Shortcut'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('runs a field\'s own Enter action once, without also saving the dialog', () => {
    vi.stubGlobal('location', { ...window.location, search: '?platform=macos' })
    __resetPlatformForTests()
    const onSave = vi.fn()
    const addChip = vi.fn()
    render(
      <div>
        <input aria-label="Community" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChip() } }} />
        <DialogFooter primary={{ label: 'Save', onClick: onSave }} onCancel={() => {}} />
      </div>,
    )
    fireEvent.keyDown(screen.getByLabelText('Community'), { key: 'Enter' })
    expect(addChip).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('ignores Enter outside its dialog', () => {
    vi.stubGlobal('location', { ...window.location, search: '?platform=macos' })
    __resetPlatformForTests()
    const onSave = vi.fn()
    render(
      <>
        <input aria-label="Elsewhere" />
        <div><DialogFooter primary={{ label: 'Save', onClick: onSave }} onCancel={() => {}} /></div>
      </>,
    )
    fireEvent.keyDown(screen.getByLabelText('Elsewhere'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })
})
