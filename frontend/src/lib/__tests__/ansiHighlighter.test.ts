import { describe, it, expect } from 'vitest'
import { AnsiHighlighter } from '../ansiHighlighter'
import type { HighlightRule } from '../../api/highlightRules'

const ESC = '\x1b'
const BEL = '\x07'

function rule(partial: Partial<HighlightRule>): HighlightRule {
  return {
    id: 'r',
    name: 'r',
    pattern: '',
    is_regex: false,
    case_sensitive: false,
    whole_word: false,
    foreground: '#ff0000',
    background: null,
    bold: false,
    italic: false,
    underline: false,
    category: 'Custom',
    priority: 100,
    enabled: true,
    session_id: null,
    created_at: '',
    updated_at: '',
    ...partial,
  }
}

// An IPv4 rule — the kind a network engineer has enabled, and the trigger for
// the doubled-prompt / doubled-IP bug.
const ipRule = () =>
  rule({ pattern: '\\d{1,3}(?:\\.\\d{1,3}){3}', is_regex: true, foreground: '#00ff00' })

describe('AnsiHighlighter — escape-sequence safety', () => {
  it('never injects inside an OSC window-title sequence (doubled-prompt bug)', () => {
    const h = new AnsiHighlighter()
    h.setRules([rule({ pattern: 'root', foreground: '#ff0000' })])

    // Debian/Ubuntu root prompt: OSC title `root@..: /home` then visible PS1.
    const title = 'root@ip-10-117-184-177: /home/cm-admin'
    const input = `${ESC}]0;${title}${BEL}root@ip-10-117-184-177:/home/cm-admin# `
    const out = h.process(input)

    // The OSC sequence (ESC ] 0 ; ... BEL) must survive byte-for-byte so xterm
    // consumes it as a title instead of leaking it to the screen.
    expect(out).toContain(`${ESC}]0;${title}${BEL}`)
    // No color code may appear before the BEL that closes the title.
    const osc = out.slice(out.indexOf(`${ESC}]0;`), out.indexOf(BEL))
    expect(osc).not.toContain('[38;2;')
    // The visible prompt after the title still gets highlighted.
    expect(out.slice(out.indexOf(BEL))).toContain('[38;2;255;0;0m')
  })

  it('passes an OSC carrying an IP through untouched with an IPv4 rule active', () => {
    const h = new AnsiHighlighter()
    h.setRules([ipRule()])
    const input = `${ESC}]0;10.105.90.47${BEL}`
    expect(h.process(input)).toBe(input) // no splice at all
  })

  it('handles an OSC split across two chunks (the intermittent case)', () => {
    const h = new AnsiHighlighter()
    h.setRules([ipRule()])
    // Chunk boundary lands in the middle of the title payload.
    const a = h.process(`${ESC}]0;10.105`)
    const b = h.process(`.90.47${BEL}done`)
    // Neither half may have color spliced into the still-open title.
    expect(a).toBe(`${ESC}]0;10.105`)
    expect(b.startsWith('.90.47' + BEL)).toBe(true)
    expect(b).not.toContain('[38;2;') // IP inside the title stays unhighlighted
  })

  it('does not splice inside a CSI (SGR) sequence', () => {
    const h = new AnsiHighlighter()
    // A rule that would match the digits inside `\x1b[38;2;...m` if we were naive.
    h.setRules([rule({ pattern: '38', foreground: '#00ff00' })])
    const input = `${ESC}[38;2;1;2;3mhello${ESC}[0m`
    const out = h.process(input)
    expect(out).toContain(`${ESC}[38;2;1;2;3m`) // sequence intact
  })

  it('still highlights ordinary printable output', () => {
    const h = new AnsiHighlighter()
    h.setRules([ipRule()])
    const out = h.process('ping 10.105.90.47 ok\n')
    expect(out).toContain('[38;2;0;255;0m10.105.90.47' + RESET_TAIL())
  })

  it('highlights a bare interactive prompt (no trailing newline)', () => {
    const h = new AnsiHighlighter()
    h.setRules([rule({ pattern: 'error', foreground: '#ff0000' })])
    const out = h.process('error: ')
    expect(out).toContain('[38;2;255;0;0merror')
  })
})

function RESET_TAIL() {
  return '\x1b[0m'
}
