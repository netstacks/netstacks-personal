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
    const title = 'root@ip-10-0-184-177: /home/admin'
    const input = `${ESC}]0;${title}${BEL}root@ip-10-0-184-177:/home/admin# `
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

describe('AnsiHighlighter — restores the stream\'s own colours after a match', () => {
  const running = () => rule({ pattern: 'running', foreground: '#00ffff' })

  it('re-applies the app background after a highlighted word (Claude Code prompt band)', () => {
    const h = new AnsiHighlighter()
    h.setRules([running()])
    const bg = `${ESC}[48;5;238m`
    const out = h.process(`${bg}1 monitor still running and more`)
    // The highlight closes with a reset, then the app's own SGR is replayed.
    expect(out).toContain(`running${ESC}[0m${bg} and more`)
  })

  it('replays every SGR since the last reset, in order', () => {
    const h = new AnsiHighlighter()
    h.setRules([running()])
    const out = h.process(`${ESC}[1m${ESC}[38;2;10;20;30m${ESC}[48;5;0mrunning!`)
    // 48;5;0 is colour index 0, not a reset.
    expect(out).toContain(`running${ESC}[0m${ESC}[1m${ESC}[38;2;10;20;30m${ESC}[48;5;0m!`)
  })

  it('forgets earlier state after the stream resets', () => {
    const h = new AnsiHighlighter()
    h.setRules([running()])
    const out = h.process(`${ESC}[41mred${ESC}[0m running`)
    expect(out.endsWith(`running${ESC}[0m`)).toBe(true)
  })

  it('a combined reset+set sequence is replayed alone', () => {
    const h = new AnsiHighlighter()
    h.setRules([running()])
    const out = h.process(`${ESC}[41m${ESC}[0;1;32mrunning.`)
    expect(out).toContain(`running${ESC}[0m${ESC}[0;1;32m.`)
  })

  it('keeps state across chunks', () => {
    const h = new AnsiHighlighter()
    h.setRules([running()])
    h.process(`${ESC}[7m`)
    expect(h.process('still running.')).toContain(`running${ESC}[0m${ESC}[7m.`)
  })
})
