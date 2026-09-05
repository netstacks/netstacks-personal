/**
 * Paste-hygiene transforms and presets (docs/clipboard-history-plan.md §4.1).
 *
 * Every transform is a pure `(text, ctx) => text`. A preset is an ordered chain
 * of transform ids, optionally auto-selected for a set of CLI flavors. Built-in
 * presets live here; the user's edited list is stored in `clipboard.presets`
 * and wins when present.
 */
import type { CliFlavor } from '../types/enrichment'
import { isPromptLine } from './aiLiveContext'
import { getSettings } from '../hooks/useSettings'
import { countLines } from './clipText'

export type TransformId =
  | 'normalize-lf'
  | 'strip-trailing-ws'
  | 'collapse-blank-lines'
  | 'tabs-to-spaces'
  | 'strip-comments'
  | 'dedent'
  | 'strip-prompts'
  | 'display-set-to-set'

export interface TransformContext {
  flavor: CliFlavor
}

export interface TransformPreset {
  id: string
  name: string
  chain: TransformId[]
  /** Auto-selected when pasting into a terminal with one of these flavors. */
  cliFlavors: CliFlavor[]
}

interface TransformDef {
  label: string
  description: string
  apply: (text: string, ctx: TransformContext) => string
}

/** The comment leader a device CLI ignores, per flavor. */
export function commentLeader(flavor: CliFlavor): string {
  switch (flavor) {
    case 'cisco-ios':
    case 'cisco-ios-xr':
    case 'cisco-nxos':
    case 'arista':
      return '!'
    default:
      return '#'
  }
}

const splitLines = (text: string): string[] => text.split('\n')

export const TRANSFORMS: Record<TransformId, TransformDef> = {
  'normalize-lf': {
    label: 'Normalize line endings',
    description: 'CRLF and bare CR become LF so a device never sees stray carriage returns.',
    apply: (text) => text.replace(/\r\n?/g, '\n'),
  },
  'strip-trailing-ws': {
    label: 'Strip trailing whitespace',
    description: 'Remove spaces/tabs at the end of every line.',
    apply: (text) => splitLines(text).map((l) => l.replace(/[ \t]+$/, '')).join('\n'),
  },
  'collapse-blank-lines': {
    label: 'Collapse blank lines',
    description: 'Runs of blank lines become one; leading and trailing blank lines are dropped.',
    apply: (text) => {
      const out: string[] = []
      for (const line of splitLines(text)) {
        const blank = line.trim() === ''
        if (blank && (out.length === 0 || out[out.length - 1] === '')) continue
        out.push(blank ? '' : line)
      }
      while (out.length && out[out.length - 1] === '') out.pop()
      return out.join('\n')
    },
  },
  'tabs-to-spaces': {
    label: 'Tabs to spaces',
    description: 'Replace tab characters with four spaces (tabs trigger completion on many CLIs).',
    apply: (text) => text.replace(/\t/g, '    '),
  },
  'strip-comments': {
    label: 'Strip comment lines',
    description: 'Drop lines that are only a comment (! on Cisco/Arista, # elsewhere).',
    apply: (text, ctx) => {
      const leader = commentLeader(ctx.flavor)
      return splitLines(text).filter((l) => !l.trimStart().startsWith(leader)).join('\n')
    },
  },
  dedent: {
    label: 'Remove common indentation',
    description: 'Strip the indentation shared by every non-blank line.',
    apply: (text) => {
      const lines = splitLines(text)
      const indents = lines.filter((l) => l.trim() !== '').map((l) => (l.match(/^[ \t]*/) ?? [''])[0].length)
      const common = indents.length ? Math.min(...indents) : 0
      return common === 0 ? text : lines.map((l) => (l.trim() === '' ? l : l.slice(common))).join('\n')
    },
  },
  'strip-prompts': {
    label: 'Strip prompts and echoed commands',
    description: 'Remove lines that are a device prompt (with the command typed after it), leaving only output/config.',
    apply: (text, ctx) => splitLines(text).filter((l) => !isPromptLine(l, ctx.flavor)).join('\n'),
  },
  'display-set-to-set': {
    label: 'Junos "display set" cleanup',
    description: 'Drop the echoed "show configuration | display set" line and {master:0}-style banners so only set/delete statements remain.',
    apply: (text) =>
      splitLines(text)
        .filter((l) => !/^\s*show\s+configuration\b/i.test(l))
        .filter((l) => !/^\{(master|backup|line card|primary|secondary)[^}]*\}\s*$/i.test(l))
        .join('\n'),
  },
}

export const TRANSFORM_IDS = Object.keys(TRANSFORMS) as TransformId[]

export const RAW_PRESET_ID = 'raw'

export const BUILTIN_PRESETS: TransformPreset[] = [
  {
    id: 'ios-clean',
    name: 'IOS clean paste',
    chain: ['normalize-lf', 'strip-trailing-ws', 'collapse-blank-lines', 'strip-comments'],
    cliFlavors: ['cisco-ios', 'cisco-ios-xr', 'cisco-nxos', 'arista'],
  },
  {
    id: 'junos-set',
    name: 'Junos set-mode',
    chain: ['normalize-lf', 'strip-trailing-ws', 'display-set-to-set'],
    cliFlavors: ['juniper'],
  },
  {
    id: 'panos',
    name: 'PAN-OS',
    chain: ['normalize-lf', 'strip-trailing-ws'],
    cliFlavors: ['paloalto', 'fortinet'],
  },
  {
    id: 'linux-shell',
    name: 'Linux shell',
    chain: ['normalize-lf'],
    cliFlavors: ['linux'],
  },
  {
    id: RAW_PRESET_ID,
    name: 'Raw',
    chain: [],
    cliFlavors: [],
  },
]

export function applyChain(text: string, chain: TransformId[], ctx: TransformContext): string {
  return chain.reduce((acc, id) => TRANSFORMS[id].apply(acc, ctx), text)
}

/** Stored preset list → effective list (built-ins when never edited). Pure. */
export function presetsFrom(stored: TransformPreset[] | undefined): TransformPreset[] {
  return Array.isArray(stored) && stored.length > 0 ? stored : BUILTIN_PRESETS
}

/** The user's preset list, falling back to the built-ins when never edited. */
export function activePresets(): TransformPreset[] {
  return presetsFrom(getSettings()['clipboard.presets'])
}

/** A positive-integer setting with a fallback for missing/invalid values. */
export function settingInt(key: 'clipboard.maxClips' | 'clipboard.expiryHours' | 'clipboard.confirmPasteLines', fallback: number): number {
  const n = Number(getSettings()[key])
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Master switch for the advanced paste features (Settings → Clipboard). */
export function advancedPasteEnabled(): boolean {
  return getSettings()['clipboard.advancedPaste'] !== false
}

/** Preset auto-selected for a flavor; null means paste raw ('auto' and unmapped flavors). */
export function presetForFlavor(presets: TransformPreset[], flavor: CliFlavor): TransformPreset | null {
  if (flavor === 'auto') return null
  return presets.find((p) => p.cliFlavors.includes(flavor)) ?? null
}

/**
 * Text as it should reach the terminal for a paste into `flavor`: the
 * auto-selected preset when `clipboard.autoTransform` is on, otherwise the
 * original text.
 */
export function preparePasteText(text: string, flavor: CliFlavor): string {
  if (!advancedPasteEnabled()) return text
  if (getSettings()['clipboard.autoTransform'] === false) return text
  const preset = presetForFlavor(activePresets(), flavor)
  return preset ? applyChain(text, preset.chain, { flavor }) : text
}

/** Human summary of a chain for settings rows and the preview toolbar. */
export function describeChain(chain: TransformId[]): string {
  return chain.length === 0 ? 'no changes (raw)' : chain.map((id) => TRANSFORMS[id].label).join(' → ')
}

/**
 * SecureCRT-style guard: a paste of `clipboard.confirmPasteLines` lines or more
 * (default 2, i.e. anything multi-line) is reviewed in the editable paste
 * dialog before it reaches the device. Off when the setting is disabled.
 */
export function shouldConfirmPaste(text: string): boolean {
  if (!advancedPasteEnabled()) return false
  if (getSettings()['clipboard.confirmMultilinePaste'] === false) return false
  return countLines(text) >= settingInt('clipboard.confirmPasteLines', 2)
}

