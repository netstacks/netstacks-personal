/**
 * AnsiHighlighter — rewrites terminal output chunks to inject ANSI color codes
 * around regex matches before they reach xterm.js.
 *
 * This is the durable alternative to xterm decorations: styling is baked into
 * the line, so it survives selection/copy, scrollback reflow, resize, and any
 * ANSI-aware export. Cost: no hover/click metadata (those stay on the
 * decoration engine for detection + AI annotations). Ported from
 * netstacks-vsce/src/webview/highlighter.ts.
 */

import type { HighlightRule } from '../api/highlightRules'

interface CompiledRule {
  rule: HighlightRule
  regex: RegExp
  prefix: string
}

const RESET = '\x1b[0m'
// Cap matches per line so a pathological regex on a long line doesn't generate
// thousands of overlapping matches.
const MAX_MATCHES_PER_LINE = 64

/**
 * Escape-sequence parser state. We only need enough of the VT500 state machine
 * to tell "inside a control/escape sequence" from "printable text" so we never
 * splice color codes into a sequence. OSC/DCS/APC/PM/SOS all collapse to `osc`
 * (a string swallowed until BEL or ST) since we treat them identically.
 */
type EscMode = 'ground' | 'esc' | 'csi' | 'osc' | 'oscEsc'

export class AnsiHighlighter {
  private compiled: CompiledRule[] = []
  // Parser state, carried across process() calls so a sequence split across two
  // PTY chunks is still recognized (and left untouched) on both sides.
  private mode: EscMode = 'ground'

  setRules(rules: HighlightRule[]): void {
    this.compiled = []
    for (const rule of rules) {
      if (!rule.enabled) continue
      const prefix = ansiPrefixFor(rule)
      if (!prefix) continue
      const regex = buildRegex(rule)
      if (!regex) continue
      this.compiled.push({ rule, regex, prefix })
    }
    // Lower priority number = higher precedence.
    this.compiled.sort(
      (a, b) => (a.rule.priority ?? 100) - (b.rule.priority ?? 100),
    )
  }

  hasRules(): boolean {
    return this.compiled.length > 0
  }

  /**
   * Push a chunk through the highlighter. Returns the chunk with ANSI codes
   * spliced around matches in the *printable text* only.
   *
   * Escape sequences (CSI, OSC/window-title, DCS, etc.) are passed through
   * verbatim and never highlighted. This is essential: splicing an ESC into the
   * middle of, say, an OSC title sequence aborts xterm's parser and dumps the
   * title text onto the screen (the classic "doubled prompt / doubled IP" bug).
   * Parser state is carried across calls so a sequence split across two chunks
   * is still recognized on both sides.
   *
   * NO buffering of printable text — every chunk is emitted immediately so
   * interactive prompts (which never end with \n) and typed-character echo work
   * correctly. Trade-off: a match that spans a chunk boundary, or one broken by
   * an interior escape sequence, won't highlight; latency-free terminal
   * behavior is non-negotiable.
   */
  process(chunk: string): string {
    if (this.compiled.length === 0 || !chunk) return chunk

    let out = ''
    let text = '' // printable run pending highlight
    let esc = '' // in-flight escape sequence, emitted verbatim

    const flushText = () => {
      if (text) {
        out += this.highlightText(text)
        text = ''
      }
    }
    const flushEsc = () => {
      if (esc) {
        out += esc
        esc = ''
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      const code = chunk.charCodeAt(i)

      switch (this.mode) {
        case 'ground':
          if (code === 0x1b) {
            // ESC begins a sequence: close the text run so we don't highlight
            // into it, then start collecting the sequence verbatim.
            flushText()
            esc += c
            this.mode = 'esc'
          } else {
            text += c
          }
          break

        case 'esc':
          esc += c
          if (code === 0x5b) {
            this.mode = 'csi' // '['
          } else if (
            code === 0x5d || // ']' OSC
            code === 0x50 || // 'P' DCS
            code === 0x58 || // 'X' SOS
            code === 0x5e || // '^' PM
            code === 0x5f //   '_' APC
          ) {
            this.mode = 'osc'
          } else if (code >= 0x20 && code <= 0x2f) {
            // intermediate byte (e.g. ESC ( B) — stay, await final
          } else {
            // final byte of a short escape (e.g. ESC c, ESC 7) — done
            flushEsc()
            this.mode = 'ground'
          }
          break

        case 'csi':
          esc += c
          // params 0x30–0x3f, intermediates 0x20–0x2f, final 0x40–0x7e
          if (code >= 0x40 && code <= 0x7e) {
            flushEsc()
            this.mode = 'ground'
          }
          break

        case 'osc':
          esc += c
          if (code === 0x07) {
            flushEsc() // BEL terminates
            this.mode = 'ground'
          } else if (code === 0x1b) {
            this.mode = 'oscEsc' // maybe ST (ESC \)
          }
          break

        case 'oscEsc':
          esc += c
          if (code === 0x5c) {
            flushEsc() // ESC \ = ST terminator
            this.mode = 'ground'
          } else {
            // ESC not followed by backslash; keep swallowing the string.
            this.mode = 'osc'
          }
          break
      }
    }

    // End of chunk: emit the pending text (highlighted) and any partial escape
    // sequence (verbatim). `mode` persists so the next chunk resumes correctly.
    flushText()
    flushEsc()
    return out
  }

  /** Highlight a run of printable text, keeping per-line regex semantics. */
  private highlightText(text: string): string {
    // Split on \n so per-line regex matching can't cross lines.
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) parts[i] = this.highlightLine(parts[i])
    }
    return parts.join('\n')
  }

  private highlightLine(line: string): string {
    if (!line) return line

    type Match = { start: number; end: number; prefix: string }
    const matches: Match[] = []

    for (const cr of this.compiled) {
      cr.regex.lastIndex = 0
      let m: RegExpExecArray | null
      let countForRule = 0
      while ((m = cr.regex.exec(line)) !== null) {
        if (m[0].length === 0) {
          // Zero-width matches would loop forever
          cr.regex.lastIndex++
          continue
        }
        matches.push({ start: m.index, end: m.index + m[0].length, prefix: cr.prefix })
        countForRule++
        if (countForRule >= MAX_MATCHES_PER_LINE) break
      }
    }

    if (matches.length === 0) return line

    // Greedy non-overlap: sort by start (then by length), drop any match that
    // overlaps an already-accepted one. compiled[] is priority-ordered.
    matches.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start))

    const kept: Match[] = []
    let cursor = 0
    for (const m of matches) {
      if (m.start < cursor) continue
      kept.push(m)
      cursor = m.end
    }

    if (kept.length === 0) return line

    const out: string[] = []
    let pos = 0
    for (const m of kept) {
      if (m.start > pos) out.push(line.slice(pos, m.start))
      out.push(m.prefix)
      out.push(line.slice(m.start, m.end))
      out.push(RESET)
      pos = m.end
    }
    if (pos < line.length) out.push(line.slice(pos))
    return out.join('')
  }
}

function buildRegex(rule: HighlightRule): RegExp | null {
  let pattern: string
  let flags = 'g'
  if (!rule.case_sensitive) flags += 'i'

  try {
    if (rule.is_regex) {
      pattern = rule.pattern
    } else {
      pattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    if (rule.whole_word && !rule.is_regex) {
      pattern = `\\b${pattern}\\b`
    }
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

function ansiPrefixFor(rule: HighlightRule): string {
  let s = ''
  if (rule.bold) s += '\x1b[1m'
  if (rule.italic) s += '\x1b[3m'
  if (rule.underline) s += '\x1b[4m'
  if (rule.foreground) {
    const rgb = parseHex(rule.foreground)
    if (rgb) s += `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  }
  if (rule.background) {
    const rgb = parseHex(rule.background)
    if (rgb) s += `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  }
  return s
}

function parseHex(hex: string): [number, number, number] | null {
  let v = hex.trim().replace(/^#/, '')
  if (v.length === 3) v = v.split('').map((c) => c + c).join('')
  if (v.length !== 6) return null
  const n = parseInt(v, 16)
  if (Number.isNaN(n)) return null
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
