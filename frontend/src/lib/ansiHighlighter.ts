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

export class AnsiHighlighter {
  private compiled: CompiledRule[] = []

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
   * spliced around matches.
   *
   * NO buffering — every chunk is emitted immediately so interactive prompts
   * (which never end with \n) and typed-character echo work correctly.
   *
   * Trade-off: a match that spans a chunk boundary won't highlight. In practice
   * remote output arrives in line-sized chunks, so this is rare; latency-free
   * terminal behavior is non-negotiable.
   */
  process(chunk: string): string {
    if (this.compiled.length === 0 || !chunk) return chunk
    // Split on \n so per-line regex matching can't cross lines. The trailing
    // partial (after the last \n) is highlighted in place and reaches xterm
    // immediately so the cursor lands where the user expects.
    const parts = chunk.split('\n')
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
