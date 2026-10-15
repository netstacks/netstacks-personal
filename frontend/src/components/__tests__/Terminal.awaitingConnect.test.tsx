import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'

// xterm needs a real canvas; a permissive stand-in is enough for the
// connection lifecycle under test.
vi.mock('@xterm/xterm', () => {
  class FakeXTerm {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    element: HTMLElement | undefined = undefined
    buffer = { active: { length: 0, viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined } }
    open(container: HTMLElement) {
      this.element = document.createElement('div')
      container.appendChild(this.element)
    }
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver)
          return () => ({ dispose() {} })
        },
      })
    }
  }
  return { Terminal: FakeXTerm }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } dispose() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose() {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() { return false } findPrevious() { return false } clearDecorations() {} onDidChangeResults() { return { dispose() {} } } dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() { return { dispose() {} } } dispose() {} } }))

vi.mock('../../api/client', () => {
  const http = {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  }
  return {
    getClient: () => ({ mode: 'standalone', http, wsUrlWithAuth: (path: string) => `ws://agent.test${path}` }),
    getCurrentMode: () => 'standalone',
  }
})

import Terminal, { type TerminalHandle } from '../Terminal'

/** Records every WebSocket the terminal opens — the connect API under test. */
const sockets: string[] = []
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    sockets.push(url)
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

beforeEach(() => {
  sockets.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
}

describe('Terminal awaitingConnect (restored tabs)', () => {
  it('connects on mount when not restored', async () => {
    render(<Terminal id="t1" sessionId="s1" />)
    await settle()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toContain('session_id=s1')
  })

  it('stays disconnected with a Connect affordance until the user clicks Connect', async () => {
    render(<Terminal id="t1" sessionId="s1" awaitingConnect autoReconnect />)
    await settle()

    expect(sockets).toHaveLength(0)
    expect(screen.getByText('Not Connected')).toBeInTheDocument()
    expect(screen.queryByText(/Reconnecting in/)).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    await settle()

    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toContain('/ws/terminal')
    expect(sockets[0]).toContain('session_id=s1')
    expect(screen.queryByText('Not Connected')).not.toBeInTheDocument()
  })

  it('connects through the reconnect action (shortcut / tab menu)', async () => {
    const ref = createRef<TerminalHandle>()
    render(<Terminal ref={ref} id="t1" sessionId="s1" awaitingConnect />)
    await settle()
    expect(sockets).toHaveLength(0)

    await act(async () => {
      ref.current?.reconnect()
    })
    await settle()
    expect(sockets).toHaveLength(1)
  })

  it('does not open the controller socket for a restored enterprise terminal until Connect', async () => {
    render(
      <Terminal
        id="t1"
        awaitingConnect
        enterpriseSessionDefinitionId="def-1"
        enterpriseProfileId="prof-1"
        enterpriseTargetHost="10.0.0.1"
        enterpriseTargetPort={22}
      />,
    )
    await settle()
    expect(sockets).toHaveLength(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })
    await settle()

    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toContain('/ws/ssh')
    expect(sockets[0]).toContain('session_id=def-1')
  })
})
