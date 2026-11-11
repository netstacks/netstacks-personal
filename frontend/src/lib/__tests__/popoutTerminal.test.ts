import { describe, it, expect } from 'vitest'
import { popoutTerminalParams, parsePopoutTerminalParams, popoutSnapshotTabFields } from '../popoutTerminal'

describe('popout terminal snapshot round trip', () => {
  it('keeps scrollback, reconnect settings and the quick-connect target', () => {
    const tab = {
      title: 'admin@r1', protocol: 'telnet' as const, cliFlavor: 'cisco-ios',
      fontSize: 13, fontFamily: 'Mono', terminalTheme: 'dark',
      scrollbackLines: 50000, autoReconnect: false, reconnectDelay: 7,
      quickConnectHost: 'r1', quickConnectPort: 23, quickConnectProfileId: 'p1',
    }
    // URL snapshot → popout → pop-back-in payload → tab fields
    const url = new URL(`http://x/?${popoutTerminalParams(tab).toString()}`)
    const snap = parsePopoutTerminalParams(url.searchParams)
    const back = popoutSnapshotTabFields(JSON.parse(JSON.stringify(snap)))
    expect(back).toMatchObject({
      title: 'admin@r1', protocol: 'telnet', cliFlavor: 'cisco-ios', fontSize: 13, fontFamily: 'Mono',
      terminalTheme: 'dark', scrollbackLines: 50000, autoReconnect: false, reconnectDelay: 7,
      quickConnectHost: 'r1', quickConnectPort: 23, quickConnectProfileId: 'p1',
    })
  })

  it('leaves unset behaviour settings unset (Terminal defaults apply)', () => {
    const snap = parsePopoutTerminalParams(popoutTerminalParams({ title: 'T', sessionId: 's1' }))
    expect(snap.autoReconnect).toBeUndefined()
    expect(snap.reconnectDelay).toBeUndefined()
    expect(snap.scrollbackLines).toBeUndefined()
    expect(snap.sessionId).toBe('s1')
  })

  it('keeps an empty (device-anchored) enterprise profile id', () => {
    const snap = parsePopoutTerminalParams(popoutTerminalParams({
      title: 'r1', enterpriseProfileId: '', enterpriseSessionDefinitionId: 'q', enterpriseTargetHost: 'r1',
    }))
    expect(snap.enterpriseProfileId).toBe('')
    expect(snap.enterpriseTargetHost).toBe('r1')
  })
})
