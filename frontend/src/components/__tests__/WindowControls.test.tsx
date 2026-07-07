// frontend/src/components/__tests__/WindowControls.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const minimize = vi.fn(); const toggleMaximize = vi.fn(); const close = vi.fn()
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}))

import WindowControls from '../WindowControls'

describe('WindowControls', () => {
  it('wires each control to the Tauri window API', async () => {
    render(<WindowControls />)
    fireEvent.click(screen.getByTestId('win-minimize'))
    fireEvent.click(screen.getByTestId('win-maximize'))
    fireEvent.click(screen.getByTestId('win-close'))
    await waitFor(() => {
      expect(minimize).toHaveBeenCalledOnce()
      expect(toggleMaximize).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    })
  })
})
