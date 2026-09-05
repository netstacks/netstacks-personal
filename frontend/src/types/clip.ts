/**
 * Clipboard history ("clips") — provenance-tagged records of what the user
 * copied inside NetStacks. See docs/clipboard-history-plan.md.
 *
 * Only in-app copies are recorded (plus an explicit OS import); there is no
 * global clipboard listener.
 */
import type { CliFlavor } from './enrichment'

export type ClipSource =
  | 'terminal-selection'   // text selected in xterm and copied
  | 'app-copy'             // any copyToClipboard() call site (path, URL, output…)
  | 'os-import'            // explicit "Import from OS clipboard"
  | 'ai'                   // copied from the AI side panel

export interface ClipProvenance {
  source: ClipSource
  sessionId?: string
  sessionName?: string
  deviceHost?: string
  cliFlavor?: CliFlavor
  /** Where in the app the copy happened (tab type, panel name). */
  tabType?: string
}

export type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'

export interface Clip {
  id: string
  text: string
  createdAt: string        // ISO 8601
  provenance: ClipProvenance
  pinned: boolean
  lineEnding: LineEnding
  bytes: number
  lines: number
  /** A credential pattern matched on capture; the stored text is scrubbed. */
  redacted: boolean
}
