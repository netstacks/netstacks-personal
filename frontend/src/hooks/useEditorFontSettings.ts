/**
 * useEditorFontSettings — derive font settings for Monaco editors from
 * the global app settings.
 *
 * Why this exists
 * ---------------
 * Every Monaco editor in the app (DocumentTabEditor, ScriptEditor,
 * TemplateDetailTab, WorkspaceCodeEditor) reads its font here so they all
 * honor Settings → Appearance → Editor Font Size / Font Family and the
 * View → Zoom step, and stay in lockstep.
 *
 * Usage
 * -----
 *   const editorFont = useEditorFontSettings()
 *   <MonacoEditor options={{ ...editorFont, ...other }} />
 *
 * Dynamic updates: useSettings re-fires on change, so this hook
 * returns a fresh object on every change. Pass it as part of Monaco's
 * `options` prop — @monaco-editor/react diffs and applies via
 * editor.updateOptions automatically.
 */

import { useMemo } from 'react'
import { useSettings } from './useSettings'
import { platformMonoFont } from '../utils/fonts'
import { zoomedFontSize } from '../commands/zoom'

interface EditorFontSettings {
  /** Monaco fontSize option (pixels). */
  fontSize: number
  /** Monaco fontFamily option. */
  fontFamily: string
}

/**
 * Decide whether the user's chosen Font Family is safe to pass to
 * Monaco unchanged, or whether we should swap in a mono fallback.
 *
 * Previous heuristic ("does the name contain 'mono'?") had real false
 * positives (Comic Mono, Monotype Corsiva — italic display!) and false
 * negatives (Iosevka, Hack, JetBrains Mono — popular mono fonts whose
 * name doesn't contain "mono"). Trying to enumerate every mono font
 * is a losing battle.
 *
 * Cleaner: only intercept when the family is an exact match for one of
 * the SETTINGS-DROPDOWN sans-serif presets. Anything else — including
 * custom user input or fonts we don't recognise — passes through
 * unchanged. The user is the authority on their font; we shouldn't
 * second-guess.
 *
 * Hardcoded list because we control the Settings dropdown (see
 * SettingsPanel.tsx Font Family options). If a new sans preset is
 * ever added there, add it here too.
 */
const KNOWN_SANS_PRESETS: ReadonlySet<string> = new Set([
  '', // System Default (the platform UI font)
  "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif",
  "'Helvetica Neue', Helvetica, Arial, sans-serif",
  'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
])

function ensureMonoSafe(family: string): string {
  return KNOWN_SANS_PRESETS.has(family) ? platformMonoFont() : family
}

export function useEditorFontSettings(): EditorFontSettings {
  const { settings } = useSettings()
  const fontSize = zoomedFontSize(settings['editor.fontSize'], settings['view.zoomStep'])
  const { fontFamily } = settings
  return useMemo<EditorFontSettings>(
    () => ({ fontSize, fontFamily: ensureMonoSafe(fontFamily) }),
    [fontSize, fontFamily],
  )
}
