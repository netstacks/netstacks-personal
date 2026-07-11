import { describe, it, expect } from 'vitest'
import { collapsePaging, computeStateSummary, stripLiveContext, LIVE_CONTEXT_END } from '../aiLiveContext'

describe('collapsePaging', () => {
  it('removes --More-- and ---(more)--- fragments and their redraw artifacts', () => {
    const raw = 'line1\r\n --More-- \rline2\r\n---(more 25%)---\r\nline3'
    const out = collapsePaging(raw)
    expect(out).not.toMatch(/--More--/)
    expect(out).not.toMatch(/\(more/i)
    expect(out).toContain('line1')
    expect(out).toContain('line2')
    expect(out).toContain('line3')
  })
})

describe('computeStateSummary — Junos/NSO config mode (observed failure)', () => {
  const buffer = [
    '[edit devices device exar03-iidev.nae05.gi-nw.viasat.io config]',
    'cm-admin@nso-dev-64[edit]# exit',
    'There are uncommitted changes.',
    'Discard changes and continue? [yes,no] ',
  ].join('\n')

  it('detects configuration mode', () => {
    expect(computeStateSummary(buffer, 'juniper').mode).toBe('configuration')
  })
  it('detects uncommitted changes', () => {
    expect(computeStateSummary(buffer, 'juniper').uncommittedChanges).toBe(true)
  })
  it('detects the blocked interactive prompt', () => {
    expect(computeStateSummary(buffer, 'juniper').blockedPrompt).toMatch(/\[yes,no\]/)
  })
})

describe('computeStateSummary — Cisco IOS', () => {
  it('detects config mode from (config)# prompt', () => {
    const b = 'router#\nrouter(config)#\nrouter(config-if)#'
    expect(computeStateSummary(b, 'cisco-ios').mode).toBe('configuration')
  })
  it('reports operational mode at exec prompt', () => {
    const b = 'router#show version\nCisco IOS Software\nrouter#'
    const s = computeStateSummary(b, 'cisco-ios')
    expect(s.mode).toBe('operational')
    expect(s.lastCommand).toBe('show version')
  })
})

describe('computeStateSummary — Linux', () => {
  it('reports shell mode', () => {
    expect(computeStateSummary('user@host:~$ ls\nfile1\nuser@host:~$ ', 'linux').mode).toBe('shell')
  })
})

import { buildLiveContext, type LiveContextDeps, shouldGuardCommand } from '../aiLiveContext'
import * as settings from '../../hooks/useSettings'
import { vi } from 'vitest'

function stubSettings(over: Record<string, unknown>) {
  vi.spyOn(settings, 'getSettings').mockReturnValue({
    'ai.liveContext.enabled': true,
    'ai.liveContext.scrollbackLines': 200,
    'ai.liveContext.includeEditor': true,
    ...over,
  } as unknown as settings.AppSettings)
}

const baseDeps = (buffer: string): LiveContextDeps => ({
  getBuffer: () => buffer,
  getSession: () => ({ name: 'Dev_NSO', host: 'nso-dev-64', cliFlavor: 'juniper' }),
  getEditorState: () => ({ path: 'filters.j2', dirty: true }),
})

describe('buildLiveContext', () => {
  it('returns empty string when feature disabled', async () => {
    stubSettings({ 'ai.liveContext.enabled': false })
    expect(await buildLiveContext('s1', baseDeps('router#'))).toBe('')
  })

  it('includes state summary, editor line, and fenced scrollback', async () => {
    stubSettings({})
    const out = await buildLiveContext('s1', baseDeps('cm-admin@nso-dev-64[edit]# exit\nThere are uncommitted changes.'))
    expect(out).toContain('LIVE WORKSPACE STATE')
    expect(out).toContain('Mode: CONFIGURATION')
    expect(out).toContain('Uncommitted changes: YES')
    expect(out).toContain('filters.j2 (unsaved changes)')
    expect(out).toContain('Do not re-derive it by running commands')
    expect(out).toMatch(new RegExp(`${LIVE_CONTEXT_END}$`))
  })

  it('omits editor line when includeEditor is false', async () => {
    stubSettings({ 'ai.liveContext.includeEditor': false })
    const out = await buildLiveContext('s1', baseDeps('router#'))
    expect(out).not.toContain('Editor (Zone 2)')
  })

  it('returns empty string when no session and no editor state', async () => {
    stubSettings({})
    const out = await buildLiveContext(null, { getBuffer: () => null, getSession: () => null, getEditorState: () => null })
    expect(out).toBe('')
  })
})

describe('shouldGuardCommand', () => {
  const dirtyConfig = computeStateSummary(
    'cm-admin@nso-dev-64[edit]# exit\nThere are uncommitted changes.', 'juniper')

  it('blocks exit in dirty config mode', () => {
    expect(shouldGuardCommand(dirtyConfig, 'exit', 'juniper')).toMatch(/uncommitted/i)
  })
  it('blocks commit in dirty config mode', () => {
    expect(shouldGuardCommand(dirtyConfig, 'commit', 'juniper')).toBeTruthy()
  })
  it('allows a read-only show command in dirty config mode', () => {
    expect(shouldGuardCommand(dirtyConfig, 'show configuration', 'juniper')).toBeNull()
  })
  it('blocks answering a blocked [yes,no] prompt', () => {
    const blocked = computeStateSummary('Discard changes and continue? [yes,no] ', 'juniper')
    expect(shouldGuardCommand(blocked, 'yes', 'juniper')).toMatch(/waiting/i)
  })
  it('allows exit when config is clean', () => {
    const clean = computeStateSummary('router(config)#', 'cisco-ios')
    // clean = uncommittedChanges null (unknown) → not guarded
    expect(shouldGuardCommand(clean, 'exit', 'cisco-ios')).toBeNull()
  })
})

describe('stripLiveContext', () => {
  it('strips a real envelope leaving trailing user text intact', async () => {
    stubSettings({})
    const envelope = await buildLiveContext('s1', baseDeps('router#'))
    const userText = 'show running-config'
    const full = `${envelope}\n\n${userText}`
    const stripped = stripLiveContext(full)
    expect(stripped).toBe(userText)
    expect(stripped).not.toContain('LIVE WORKSPACE STATE')
    expect(stripped).not.toContain(LIVE_CONTEXT_END)
  })

  it('returns unchanged content when there is no envelope', () => {
    const plain = 'show ip interface brief'
    expect(stripLiveContext(plain)).toBe(plain)
  })

  it('handles content with only an envelope and no user text', async () => {
    stubSettings({})
    const envelope = await buildLiveContext('s1', baseDeps('router#'))
    const stripped = stripLiveContext(envelope)
    expect(stripped).toBe('')
  })
})
