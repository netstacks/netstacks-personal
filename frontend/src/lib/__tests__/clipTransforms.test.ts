import { describe, it, expect, vi } from 'vitest'

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../../hooks/useSettings', () => ({ getSettings: () => settings.current }))

import {
  BUILTIN_PRESETS, TRANSFORMS, applyChain, describeChain, presetForFlavor, preparePasteText, activePresets,
} from '../clipTransforms'
import { isPromptLine } from '../aiLiveContext'

const ios = { flavor: 'cisco-ios' as const }

describe('transforms', () => {
  it('normalizes line endings and trailing whitespace', () => {
    expect(TRANSFORMS['normalize-lf'].apply('a\r\nb\rc\n', ios)).toBe('a\nb\nc\n')
    expect(TRANSFORMS['strip-trailing-ws'].apply('a  \nb\t\n', ios)).toBe('a\nb\n')
  })

  it('collapses blank lines and dedents', () => {
    expect(TRANSFORMS['collapse-blank-lines'].apply('\n\na\n\n\n b\n\n', ios)).toBe('a\n\n b')
    expect(TRANSFORMS.dedent.apply('  interface Gi0/1\n   description x\n\n  shutdown', ios)).toBe('interface Gi0/1\n description x\n\nshutdown')
    expect(TRANSFORMS['tabs-to-spaces'].apply('\tx', ios)).toBe('    x')
  })

  it('strips comment lines by flavor', () => {
    expect(TRANSFORMS['strip-comments'].apply('! Last configuration change\ninterface Gi0/1\n!\n', ios)).toBe('interface Gi0/1\n')
    expect(TRANSFORMS['strip-comments'].apply('# note\nset system host-name r1\n!keep', { flavor: 'juniper' })).toBe('set system host-name r1\n!keep')
  })

  it('strips prompts and echoed commands but keeps config', () => {
    const text = 'core-sw1#show run | s interface\ninterface Gi0/1\n description WAN>Core\n banner motd #\ncore-sw1(config-if)# no shut\n'
    expect(TRANSFORMS['strip-prompts'].apply(text, ios)).toBe('interface Gi0/1\n description WAN>Core\n banner motd #\n')
    expect(isPromptLine('admin@fw1> show system info', 'paloalto')).toBe(true)
    expect(isPromptLine('user@r1> show configuration', 'juniper')).toBe(true)
    expect(isPromptLine('cwdavis@peter:~$ ls', 'linux')).toBe(true)
    expect(isPromptLine('[root@box ~]# id', 'linux')).toBe(true)
    expect(isPromptLine('set system host-name r1', 'juniper')).toBe(false)
    expect(isPromptLine('ip address 10.0.0.1 255.255.255.0', 'cisco-ios')).toBe(false)
  })

  it('cleans Junos display-set output', () => {
    const text = 'show configuration | display set\n{master:0}\nset system host-name r1\nset interfaces ge-0/0/0 unit 0\n'
    expect(TRANSFORMS['display-set-to-set'].apply(text, { flavor: 'juniper' })).toBe('set system host-name r1\nset interfaces ge-0/0/0 unit 0\n')
  })
})

describe('presets', () => {
  it('auto-selects by flavor and pastes raw for auto/unmapped', () => {
    expect(presetForFlavor(BUILTIN_PRESETS, 'cisco-nxos')?.id).toBe('ios-clean')
    expect(presetForFlavor(BUILTIN_PRESETS, 'juniper')?.id).toBe('junos-set')
    expect(presetForFlavor(BUILTIN_PRESETS, 'auto')).toBeNull()
  })

  it('preparePasteText applies the chain unless disabled or overridden by user presets', () => {
    const text = '! comment\r\ninterface Gi0/1  \r\n\r\n\r\n shutdown\r\n'
    // collapse keeps a single blank line (harmless at a config prompt); comments and CRs go
    expect(preparePasteText(text, 'cisco-ios')).toBe('interface Gi0/1\n\n shutdown')
    expect(preparePasteText(text, 'auto')).toBe(text)
    settings.current = { 'clipboard.autoTransform': false }
    expect(preparePasteText(text, 'cisco-ios')).toBe(text)
    settings.current = { 'clipboard.presets': [{ id: 'mine', name: 'Mine', chain: ['normalize-lf'], cliFlavors: ['cisco-ios'] }] }
    expect(activePresets()[0].id).toBe('mine')
    expect(preparePasteText(text, 'cisco-ios')).toBe(text.replace(/\r\n/g, '\n'))
    settings.current = {}
  })

  it('describes chains', () => {
    expect(describeChain([])).toBe('no changes (raw)')
    expect(describeChain(['normalize-lf', 'dedent'])).toBe('Normalize line endings → Remove common indentation')
    expect(applyChain('x\r\n', ['normalize-lf'], ios)).toBe('x\n')
  })
})
