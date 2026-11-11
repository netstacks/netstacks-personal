import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm'

vi.mock('../api/enrichment', () => ({
  getActiveMatchers: vi.fn(async () => ({
    matchers: [{ name: 'ipv4', patterns: ['\\d+\\.\\d+\\.\\d+\\.\\d+'], cli_flavors: [], priority: 0 }],
    crawler_available: false,
    netbox_available: false,
  })),
  enrichMatch: vi.fn(async (token: string) => ({
    token, token_normalized: token, matcher_name: 'ipv4', source_names: [],
  })),
  enrichSource: vi.fn(),
}))
vi.mock('../api/ai', () => ({ sendChatMessage: vi.fn() }))

import { installEnrichPopup, type EnrichPopupAPI } from './enrichPopup'
import { enrichMatch } from '../api/enrichment'

const LINE = 'gw 10.0.0.1 peer 10.0.0.2'

/** Minimal xterm stand-in: one buffer line, captures the registered provider. */
function fakeTerminal() {
  const providers: ILinkProvider[] = []
  const term = {
    buffer: { active: { getLine: () => ({ translateToString: () => LINE }) } },
    registerLinkProvider: (p: ILinkProvider) => { providers.push(p); return { dispose: () => {} } },
  } as unknown as Terminal
  const links = (): ILink[] => {
    let out: ILink[] = []
    providers[0].provideLinks(1, (l) => { out = l ?? [] })
    return out
  }
  return { term, links }
}

const move = (buttons = 0) => new MouseEvent('mousemove', { clientX: 10, clientY: 10, buttons })
const key = (type: 'keydown' | 'keyup', k: string) => window.dispatchEvent(new KeyboardEvent(type, { key: k }))

describe('enrichPopup hover gating', () => {
  let host: HTMLElement
  let api: EnrichPopupAPI
  let links: () => ILink[]
  let delay: number
  const popup = () => host.querySelector<HTMLElement>('.ns-enrich-popup')!
  const visible = () => popup().style.display !== 'none'

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.mocked(enrichMatch).mockClear()
    delay = 500
    host = document.createElement('div')
    document.body.appendChild(host)
    const t = fakeTerminal()
    links = t.links
    api = installEnrichPopup(t.term, host, {
      getSettings: () => ({ hoverEnabled: true, hoverDelayMs: delay, aiDigestEnabled: false, disabledSources: [] }),
    })
    await vi.advanceTimersByTimeAsync(500) // initial matcher fetch
  })

  afterEach(() => {
    api.dispose()
    host.remove()
    vi.useRealTimers()
  })

  it('waits for the hover delay before opening', async () => {
    const [ip] = links()
    ip.hover!(move(), ip.text)
    await vi.advanceTimersByTimeAsync(400)
    expect(visible()).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(visible()).toBe(true)
  })

  it('never opens if the pointer leaves before the delay', async () => {
    const [ip] = links()
    ip.hover!(move(), ip.text)
    ip.leave!(move(), ip.text)
    await vi.advanceTimersByTimeAsync(1000)
    expect(enrichMatch).not.toHaveBeenCalled()
  })

  it('does not open while a mouse button is down (drag-select)', async () => {
    const [ip] = links()
    ip.hover!(move(1), ip.text)
    await vi.advanceTimersByTimeAsync(1000)
    expect(visible()).toBe(false)
  })

  it('× keeps the token closed on re-hover until another token is read', async () => {
    const [a, b] = links()
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(500)
    popup().querySelector<HTMLButtonElement>('.ns-enrich-close-btn')!.click()
    expect(visible()).toBe(false)

    // Pointer comes back over the same token — stays closed.
    a.leave!(move(), a.text)
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(1000)
    expect(visible()).toBe(false)

    // Reading a different token lifts the snooze.
    a.leave!(move(), a.text)
    b.hover!(move(), b.text)
    await vi.advanceTimersByTimeAsync(500)
    expect(popup().textContent).toContain('10.0.0.2')
    b.leave!(move(), b.text)
    await vi.advanceTimersByTimeAsync(200)
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(true)
    expect(popup().textContent).toContain('10.0.0.1')
  })

  it('snooze expires after 30 s', async () => {
    const [a] = links()
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(500)
    popup().querySelector<HTMLButtonElement>('.ns-enrich-close-btn')!.click()
    a.leave!(move(), a.text)
    await vi.advanceTimersByTimeAsync(30_000)
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(true)
  })

  it('Ctrl/⌘ dismisses an open popup and blocks opening while held', async () => {
    const [a, b] = links()
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(true)
    key('keydown', 'Meta')
    expect(visible()).toBe(false)

    a.leave!(move(), a.text)
    b.hover!(move(), b.text)
    await vi.advanceTimersByTimeAsync(1000)
    expect(visible()).toBe(false)
    key('keyup', 'Meta')

    b.leave!(move(), b.text)
    b.hover!(move(), b.text)
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(true)
  })

  it('a click on a token (double-click to select) snoozes it', async () => {
    const [a] = links()
    a.hover!(move(), a.text)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1000)
    a.leave!(move(), a.text)
    a.hover!(move(), a.text)
    await vi.advanceTimersByTimeAsync(1000)
    expect(visible()).toBe(false)
  })

  it('delay 0 opens immediately', async () => {
    delay = 0
    const [a] = links()
    a.hover!(move(), a.text)
    expect(visible()).toBe(true)
  })
})
