// Builds the per-turn "live workspace state" the AI sees so it picks up where the
// user is instead of re-deriving context by running commands. Pure parsers here;
// the envelope assembler + settings gating live below (Task 2). Never throws.
import type { CliFlavor } from '../types/enrichment'
import { getSettings } from '../hooks/useSettings'
import { logger } from './logger'

export const LIVE_CONTEXT_START = '[LIVE WORKSPACE STATE'
export const LIVE_CONTEXT_END = '<<<END LIVE WORKSPACE STATE>>>'

export interface WorkspaceStateSummary {
  mode: 'operational' | 'configuration' | 'shell' | 'unknown'
  editContext: string | null      // e.g. "[edit]" for Junos, "(config-if)" for Cisco
  uncommittedChanges: boolean | null // null = unknown/not applicable
  blockedPrompt: string | null    // the interactive prompt text the session waits on
  lastCommand: string | null
  lastResult: 'ok' | 'error' | null
  recentCommands: string[]
}

const MORE_LINE = /(--\s*more\s*--|---\(?\s*more[^\n]*\)?---|<--- more --->)/i

/** Strip pager fragments and the backspace/redraw artifacts they leave behind. */
export function collapsePaging(buffer: string): string {
  return buffer
    .split(/\r?\n/)
    .map((line) => {
      // Remove carriage returns first
      let cleaned = line.replace(/\r/g, '')
      // Remove the paging marker from the line (not the whole line, just the marker)
      cleaned = cleaned.replace(MORE_LINE, '')
      return cleaned
    })
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

function nonEmptyLines(buffer: string): string[] {
  return collapsePaging(buffer)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0)
}

function detectBlockedPrompt(lines: string[]): string | null {
  const last = lines[lines.length - 1] ?? ''
  const patterns = [/\[yes,no\]/i, /\[confirm\]/i, /\(y\/n\)/i, /--\s*more\s*--/i, /password:\s*$/i, /are you sure/i]
  return patterns.some((re) => re.test(last)) ? last.trim() : null
}

function detectMode(lines: string[], flavor: CliFlavor): { mode: WorkspaceStateSummary['mode']; editContext: string | null } {
  const tail = lines.slice(-12)
  const joined = tail.join('\n')
  if (flavor === 'linux') return { mode: 'shell', editContext: null }
  if (flavor === 'juniper') {
    if (/\[edit[^\]]*\]/.test(joined)) {
      const m = joined.match(/\[edit[^\]]*\]/)
      return { mode: 'configuration', editContext: m ? m[0] : '[edit]' }
    }
    if (/[>#]\s*$/.test(tail[tail.length - 1] ?? '')) return { mode: 'operational', editContext: null }
  }
  // Cisco IOS/XE/XR/NX-OS, Arista, FortiOS: (config...)# indicates config mode.
  const cfg = joined.match(/\(config[^)]*\)#/)
  if (cfg) return { mode: 'configuration', editContext: cfg[0].replace(/[()#]/g, '') }
  if (flavor === 'paloalto') {
    const lastLine = tail[tail.length - 1] ?? ''
    if (/#\s*$/.test(lastLine)) return { mode: 'configuration', editContext: null }
    if (/>\s*$/.test(lastLine)) return { mode: 'operational', editContext: null }
  }
  const lastLine = tail[tail.length - 1] ?? ''
  if (/[>#$]\s*$/.test(lastLine)) return { mode: 'operational', editContext: null }
  return { mode: 'unknown', editContext: null }
}

function detectUncommitted(buffer: string, flavor: CliFlavor): boolean | null {
  if (/there are uncommitted changes/i.test(buffer)) return true
  // Being in Junos [edit] is treated as a conservative "possibly uncommitted"
  // cue so the Task 6 guard warns before an exit/commit. Fail-safe (over-warn).
  if (flavor === 'juniper' && /\[edit[^\]]*\]/.test(buffer)) return true
  return null
}

/** Pull the command echoed after the last shell/device prompt, plus a result cue. */
function parseLastCommand(lines: string[]): { lastCommand: string | null; lastResult: 'ok' | 'error' | null } {
  let lastCommand: string | null = null
  // Look for a command echoed immediately after a prompt
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/[>#$]\s*(\S.*)$/)
    if (m && m[1] && !MORE_LINE.test(m[1])) { lastCommand = m[1].trim(); break }
  }
  const joinedTail = lines.slice(-6).join('\n')
  let lastResult: 'ok' | 'error' | null = null
  if (/\[error\]/i.test(joinedTail) || /% invalid|syntax error|aborted/i.test(joinedTail)) lastResult = 'error'
  else if (/\[ok\]/i.test(joinedTail)) lastResult = 'ok'
  return { lastCommand, lastResult }
}

function extractRecentCommands(lines: string[]): string[] {
  const cmds: string[] = []
  for (const line of lines) {
    const m = line.match(/[>#$]\s*(\S.*)$/)
    if (m && m[1] && !MORE_LINE.test(m[1])) cmds.push(m[1].trim())
  }
  return cmds.slice(-10)
}

export function computeStateSummary(buffer: string, flavor: CliFlavor): WorkspaceStateSummary {
  const lines = nonEmptyLines(buffer)
  const { mode, editContext } = detectMode(lines, flavor)
  const { lastCommand, lastResult } = parseLastCommand(lines)
  return {
    mode,
    editContext,
    uncommittedChanges: detectUncommitted(buffer, flavor),
    blockedPrompt: detectBlockedPrompt(lines),
    lastCommand,
    lastResult,
    recentCommands: extractRecentCommands(lines),
  }
}

export interface LiveContextDeps {
  getBuffer: (sessionId: string, lines: number) => string | null
  getSession: (sessionId: string) => { name: string; host?: string; cliFlavor?: CliFlavor } | null
  getEditorState?: () => { path: string; dirty: boolean } | null
}

function formatSummary(s: WorkspaceStateSummary, flavor: CliFlavor, host: string): string {
  const modeLabel =
    s.mode === 'configuration'
      ? `CONFIGURATION${s.editContext ? ` (${s.editContext})` : ''}`
      : s.mode.toUpperCase()
  const lines: string[] = []
  lines.push(`Device: ${host || 'unknown'} | CLI flavor: ${flavor}`)
  const uncommitted = s.uncommittedChanges === true ? 'YES' : s.uncommittedChanges === false ? 'no' : 'unknown'
  lines.push(`Mode: ${modeLabel} | Uncommitted changes: ${uncommitted}`)
  lines.push(`Blocked on interactive prompt: ${s.blockedPrompt ? `YES — "${s.blockedPrompt}"` : 'no'}`)
  if (s.lastCommand) lines.push(`Last command: ${s.lastCommand}${s.lastResult ? ` | Last result: ${s.lastResult}` : ''}`)
  if (s.recentCommands.length) lines.push(`Recent commands: ${s.recentCommands.join('; ')}`)
  return lines.join('\n')
}

const DESTRUCTIVE_VERBS = /^(exit|quit|commit|rollback|discard|end|logout|reload|clear config|delete)\b/i

/**
 * Returns a refusal reason when a command would collide with the user's in-progress
 * work, else null. Two triggers: (1) session blocked on an interactive prompt, and
 * (2) destructive/mode-exit verb while in config mode with uncommitted changes.
 */
export function shouldGuardCommand(
  summary: WorkspaceStateSummary,
  command: string,
  _flavor: CliFlavor,
): string | null {
  const cmd = command.trim()
  if (summary.blockedPrompt) {
    return `Session is waiting on an interactive prompt ("${summary.blockedPrompt}"). Ask the user how to respond instead of sending "${cmd}".`
  }
  if (summary.mode === 'configuration' && summary.uncommittedChanges === true && DESTRUCTIVE_VERBS.test(cmd)) {
    return `Refusing "${cmd}": the user is in configuration mode with uncommitted changes. Confirm with the user before exiting/committing/discarding.`
  }
  return null
}

export async function buildLiveContext(activeSessionId: string | null, deps: LiveContextDeps): Promise<string> {
  try {
    const settings = getSettings()
    if (!settings['ai.liveContext.enabled']) return ''

    const cap = Math.max(20, Number(settings['ai.liveContext.scrollbackLines']) || 200)
    const includeEditor = settings['ai.liveContext.includeEditor'] !== false

    const sections: string[] = []
    let header = ''
    let terminalBlock = ''

    if (activeSessionId) {
      const session = deps.getSession(activeSessionId)
      const rawBuffer = deps.getBuffer(activeSessionId, cap)
      if (session && rawBuffer) {
        const flavor: CliFlavor = session.cliFlavor ?? 'auto'
        const summary = computeStateSummary(rawBuffer, flavor)
        header = formatSummary(summary, flavor, session.host ?? session.name)
        const cleaned = collapsePaging(rawBuffer).split('\n').slice(-cap).join('\n')
        terminalBlock =
          `--- recent terminal (last ${cap} lines, paging-collapsed, secrets redacted) ---\n${cleaned}\n---`
      }
    }

    if (includeEditor && deps.getEditorState) {
      const ed = deps.getEditorState()
      if (ed) sections.push(`Editor (Zone 2): open ${ed.path}${ed.dirty ? ' (unsaved changes)' : ''}`)
    }

    if (!header && !sections.length) return ''

    const parts = ['[LIVE WORKSPACE STATE — current on-screen state]']
    if (header) parts.push(header)
    if (sections.length) parts.push(sections.join('\n'))
    if (terminalBlock) parts.push(terminalBlock)
    parts.push('Treat the above as the user\'s current on-screen state. Do not re-derive it by running commands.')
    parts.push(LIVE_CONTEXT_END)
    return parts.join('\n')
  } catch (err) {
    logger.warn('[aiLiveContext] failed to build live context', err)
    return ''
  }
}

/**
 * Strip the live context envelope from a message if present, returning the original user text.
 * If the content does not start with the envelope marker, returns unchanged.
 */
export function stripLiveContext(content: string): string {
  try {
    if (!content.startsWith(LIVE_CONTEXT_START)) return content
    const endIdx = content.indexOf(LIVE_CONTEXT_END)
    if (endIdx === -1) return content
    // Remove from start through the end marker + newline(s)
    let remaining = content.slice(endIdx + LIVE_CONTEXT_END.length)
    // Strip leading blank lines
    remaining = remaining.replace(/^\s*\n+/, '')
    return remaining
  } catch {
    return content
  }
}
