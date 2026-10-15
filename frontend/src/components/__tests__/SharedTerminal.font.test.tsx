import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'

// Records the options each xterm instance was created with.
const created = vi.hoisted(() => [] as Array<{ fontSize?: number; fontFamily?: string }>)

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    constructor(options: { fontSize?: number; fontFamily?: string }) { created.push(options) }
    loadAddon() {}
    open() {}
    write() {}
    resize() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} dispose() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose() {} } }))

import SharedTerminal from '../SharedTerminal'
import { defaultSettings, setGlobalSettings } from '../../hooks/useSettings'

class FakeWebSocket {
  binaryType = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send() {}
  close() {}
}

beforeEach(() => {
  created.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  document.documentElement.style.setProperty('--font-family-mono', '"SF Mono", Menlo, monospace')
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--font-family-mono')
  setGlobalSettings(defaultSettings)
})

describe('SharedTerminal font', () => {
  it('uses the terminal font size and the platform monospace token by default', () => {
    setGlobalSettings({ ...defaultSettings, 'terminal.fontSize': 17 })
    render(<SharedTerminal token="t" controllerUrl="https://ctl.example" />)
    expect(created[0]).toMatchObject({ fontSize: 17, fontFamily: '"SF Mono", Menlo, monospace' })
  })

  it('honours an explicit terminal font face', () => {
    setGlobalSettings({ ...defaultSettings, 'terminal.fontFamily': 'JetBrains Mono' })
    render(<SharedTerminal token="t" controllerUrl="https://ctl.example" />)
    expect(created[0]).toMatchObject({ fontSize: defaultSettings['terminal.fontSize'], fontFamily: 'JetBrains Mono' })
  })
})
