/** Pure helpers for the clipboard history palette (kept out of the component file for fast refresh). */
import type { Clip, ClipSource } from '../../types/clip'
import { firstLine } from '../../lib/clipText'

export const SOURCE_LABEL: Record<ClipSource, string> = {
  'terminal-selection': 'terminal',
  'app-copy': 'app',
  'os-import': 'imported',
  ai: 'AI',
}

/** Per-clip data the palette derives once per clip, not per render/keystroke. */
export interface IndexedClip {
  clip: Clip
  /** First non-empty line, for the row. */
  title: string
  /** Lower-cased text + provenance labels the search matches against. */
  haystack: string
}

export function indexClip(clip: Clip): IndexedClip {
  const p = clip.provenance
  const haystack = [clip.text, p.sessionName, p.deviceHost, p.cliFlavor, SOURCE_LABEL[p.source], p.tabType]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return { clip, title: firstLine(clip.text), haystack }
}

/** Every whitespace-separated word of `query` must appear in the haystack. */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return q.split(/\s+/).every((word) => haystack.includes(word))
}
