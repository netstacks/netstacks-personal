import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const panel = vi.hoisted(() => ({ onClose: undefined as undefined | (() => void) }))
vi.mock('../AISidePanel', () => ({
  default: (props: { onClose?: () => void }) => { panel.onClose = props.onClose; return null },
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => { throw new Error('not in Tauri') },
}))

import PopoutAIChat from '../PopoutAIChat'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('PopoutAIChat', () => {
  it('Close closes the popout window instead of doing nothing', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<PopoutAIChat />)
    expect(panel.onClose).toBeTypeOf('function')
    panel.onClose?.()
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })
})
