import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// Simulated Tauri webview drop callback, captured when the coordinator
// subscribes. Typed loosely — we only feed it the fields the coordinator reads.
type DropEvent = { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }
let dropHandler: ((event: DropEvent) => void) | null = null

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (event: DropEvent) => void) => {
      dropHandler = cb
      return () => { dropHandler = null }
    },
  }),
}))

// Must be set before the module's import-time ensureSubscribed() runs.
Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })

import { useTauriDragDrop } from '../tauriDragDrop'

async function flush() {
  // Let the lazy dynamic import + subscription settle.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('useTauriDragDrop', () => {
  let surface: HTMLDivElement

  beforeEach(() => {
    document.body.innerHTML = ''
    surface = document.createElement('div')
    surface.className = 'drop-surface'
    document.body.appendChild(surface)
    // jsdom has no elementFromPoint; the coordinator hit-tests with it.
    document.elementFromPoint = () => surface
  })

  it('dispatches to the latest onDrop without re-registering on re-render', async () => {
    const first = vi.fn()
    const second = vi.fn()

    const { rerender } = renderHook(
      ({ onDrop }: { onDrop: (paths: string[]) => void }) =>
        useTauriDragDrop({ selector: '.drop-surface', onDrop }),
      { initialProps: { onDrop: first } },
    )
    await flush()
    expect(dropHandler).not.toBeNull()

    // Simulates state changing in the component (e.g. user navigated to a
    // new directory) — a fresh closure on the next render.
    rerender({ onDrop: second })

    dropHandler?.({ payload: { type: 'drop', paths: ['/tmp/a.txt'], position: { x: 10, y: 10 } } })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith(['/tmp/a.txt'], surface)
  })

  it('stops dispatching after unmount', async () => {
    const onDrop = vi.fn()
    const { unmount } = renderHook(() => useTauriDragDrop({ selector: '.drop-surface', onDrop }))
    await flush()
    unmount()

    dropHandler?.({ payload: { type: 'drop', paths: ['/tmp/a.txt'], position: { x: 10, y: 10 } } })
    expect(onDrop).not.toHaveBeenCalled()
  })
})
