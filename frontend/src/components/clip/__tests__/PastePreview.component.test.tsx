import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../hooks/useSettings', () => ({ getSettings: () => ({}) }))

import PastePreview from '../PastePreview'

describe('PastePreview (editable)', () => {
  it('pastes the transformed EDITED text and can revert', () => {
    const onPaste = vi.fn()
    render(<PastePreview text={'! c\r\ninterface Gi0/1\r\n'} flavor="cisco-ios" targetName="r1" onPaste={onPaste} onClose={() => {}} />)
    const editor = screen.getByTestId('paste-preview-editor') as HTMLTextAreaElement
    // The DOM normalises CRLF to LF inside a textarea; the state still holds the original.
    expect(editor.value).toBe('! c\ninterface Gi0/1\n')
    fireEvent.change(editor, { target: { value: '! c\r\ninterface Gi0/2\r\n shutdown\r\n' } })
    expect(screen.getByText('revert')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('paste-preview-confirm'))
    // IOS clean paste: CRs normalised, comment dropped
    expect(onPaste).toHaveBeenCalledWith('interface Gi0/2\n shutdown')
    fireEvent.click(screen.getByText('revert'))
    expect(editor.value).toBe('! c\ninterface Gi0/1\n')
    expect(screen.queryByText('revert')).toBeNull()
  })

  it('Ctrl+Enter in the editor pastes and initialRaw selects the Raw preset', () => {
    const onPaste = vi.fn()
    render(<PastePreview text={'a\r\nb'} flavor="cisco-ios" targetName="r1" initialRaw onPaste={onPaste} onClose={() => {}} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('raw')
    fireEvent.keyDown(screen.getByTestId('paste-preview-editor'), { key: 'Enter', ctrlKey: true })
    expect(onPaste).toHaveBeenCalledWith('a\r\nb')
  })
})
