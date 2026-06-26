/**
 * useEditorFontSettings — derive font settings for Monaco editors from
 * the global app settings.
 *
 * Why this exists
 * ---------------
 * Every Monaco editor in the app (DocumentTabEditor, ScriptEditor,
 * TemplateDetailTab, WorkspaceCodeEditor) used to hardcode fontSize
 * (13 / 14 — drift) and fall back to Monaco's default fontFamily. The
 * Settings → Appearance → Font Size / Font Family controls only
 * affected the terminal. Consolidating here so:
 *
 *   - Every editor honors the user's setting.
 *   - Sizes stay in lockstep across editors.
 *   - Future split (editor.fontSize separate from global) is a
 *     one-line change here, not a sweep across components.
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
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
  "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif",
  "'Helvetica Neue', Helvetica, Arial, sans-serif",
  'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
])

function ensureMonoSafe(family: string): string {
  if (KNOWN_SANS_PRESETS.has(family)) {
    return `'SF Mono', Menlo, Monaco, Consolas, 'Courier New', monospace`
  }
  return family
}

export function useEditorFontSettings(): EditorFontSettings {
  const { settings } = useSettings()
  return useMemo<EditorFontSettings>(
    () => ({
      fontSize: settings.fontSize,
      fontFamily: ensureMonoSafe(settings.fontFamily),
    }),
    [settings.fontSize, settings.fontFamily],
  )
}
