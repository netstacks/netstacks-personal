import { getErrorMessage } from '../api/errors'
/**
 * ScratchpadEditor — shared Monaco editor for the floating Scratchpad
 * panel and the in-tab Scratchpad view.
 *
 * Save destination:
 *   - Active workspace tab  → <rootPath>/.netstacks/notes/<ts>.txt
 *   - No active workspace   → docs API, 'notes' category
 *
 * AI + text-tool integrations live in Monaco's native right-click
 * context menu (added via editor.addAction). The footer stays minimal:
 * just the cursor position. Power-user editing (multi-cursor, find,
 * column select, etc.) is Monaco's default behavior — see the options
 * block below for what's been explicitly enabled.
 */

import { useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useEditorFontSettings } from '../hooks/useEditorFontSettings'
import MonacoOverlordWidget from './MonacoOverlordWidget'
import { LocalFileOps } from '../lib/fileOps'
import { createAgentHttpClient } from '../api/localClient'
import { createDocument } from '../api/docs'
import { showToast } from './Toast'
import { stripAnsi } from '../lib/ansi'
import { sendChatMessage } from '../api/ai'
import { resolveProvider } from '../lib/aiProviderResolver'
import type { WorkspaceConfig } from '../types/workspace'

interface ScratchpadEditorProps {
  value: string
  onChange: (value: string) => void
  activeWorkspace: WorkspaceConfig | null
  /** Called after a successful save. */
  onSaved?: () => void
}

export function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  )
}

function buildFileOps(ws: WorkspaceConfig): LocalFileOps {
  if (ws.mode === 'remote' && ws.remoteAgentHost && ws.remoteAgentPort && ws.remoteAgentToken) {
    return new LocalFileOps(
      createAgentHttpClient(`https://${ws.remoteAgentHost}:${ws.remoteAgentPort}`, ws.remoteAgentToken),
    )
  }
  return new LocalFileOps()
}

export function scratchpadTarget(ws: WorkspaceConfig | null): string {
  return ws ? `Workspace: ${ws.name}` : 'Docs › Notes'
}

export async function saveScratchpadContent(content: string, ws: WorkspaceConfig | null): Promise<void> {
  if (content.length === 0) {
    showToast('Nothing to save — scratchpad is empty', 'info')
    return
  }
  try {
    if (ws) {
      const root = ws.rootPath.replace(/[/\\]+$/, '')
      const sep = root.includes('/') ? '/' : '\\'
      const fileName = `${formatTimestamp(new Date())}.txt`
      const filePath = `${root}${sep}.netstacks${sep}notes${sep}${fileName}`
      const fileOps = buildFileOps(ws)
      const bytes = new TextEncoder().encode(content)
      await fileOps.writeFileBinary(filePath, bytes)
      showToast(`Saved to ${filePath}`, 'success')
    } else {
      const ts = formatTimestamp(new Date())
      await createDocument({
        name: `Scratch ${ts}`,
        category: 'notes',
        content_type: 'text',
        content,
      })
      showToast('Saved to Docs › Notes', 'success')
    }
  } catch (err) {
    console.error('[Scratchpad] save failed:', err)
    const msg = getErrorMessage(err, String(err))
    showToast(`Failed to save: ${msg}`, 'error')
    throw err
  }
}

// ── Text-transform helpers (registered as context-menu actions) ─────

function tryFormatJson(text: string): string {
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    showToast('Not valid JSON', 'error')
    return text
  }
}

function sortLines(text: string): string {
  return text.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join('\n')
}

function dedupeLines(text: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out.join('\n')
}

interface TransformDef {
  id: string
  label: string
  fn: (s: string) => string
}

const TRANSFORMS: ReadonlyArray<TransformDef> = [
  { id: 'format-json', label: 'Format JSON', fn: tryFormatJson },
  { id: 'sort-lines', label: 'Sort Lines', fn: sortLines },
  { id: 'dedupe-lines', label: 'Remove Duplicate Lines', fn: dedupeLines },
  { id: 'strip-ansi', label: 'Strip ANSI Codes', fn: stripAnsi },
  { id: 'upper', label: 'UPPER CASE', fn: (s: string) => s.toUpperCase() },
  { id: 'lower', label: 'lower case', fn: (s: string) => s.toLowerCase() },
]

export default function ScratchpadEditor({ value, onChange, activeWorkspace, onSaved }: ScratchpadEditorProps) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const editorFont = useEditorFontSettings()
  const activeWorkspaceRef = useRef(activeWorkspace)
  activeWorkspaceRef.current = activeWorkspace
  const valueRef = useRef(value)
  valueRef.current = value
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  // AI edit widget state. The widget overlays the editor, takes a
  // single-line instruction, runs the AI call inline, and writes the
  // result back via Monaco's edit API so Cmd+Z undoes it cleanly.
  const [aiEdit, setAiEdit] = useState<{
    open: boolean
    position: { top: number; left: number } | null
    loading: boolean
    error: string | null
  }>({ open: false, position: null, loading: false, error: null })

  // Apply a text transform to the current selection if any, else the
  // whole buffer. Goes through Monaco's edit API so undo works.
  const applyTransform = (fn: (s: string) => string) => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    const sel = editor.getSelection()
    if (sel && !sel.isEmpty()) {
      const selected = model.getValueInRange(sel)
      editor.executeEdits('scratchpad-transform', [{ range: sel, text: fn(selected), forceMoveMarkers: true }])
    } else {
      const fullRange = model.getFullModelRange()
      editor.executeEdits('scratchpad-transform', [{ range: fullRange, text: fn(model.getValue()), forceMoveMarkers: true }])
    }
    editor.focus()
  }

  // Open the inline AI edit widget anchored near the cursor. The widget
  // takes the user's instruction, the AI rewrites the selection (or the
  // whole buffer if nothing is selected), and the result is applied via
  // Monaco's edit API so Cmd+Z undoes it.
  const openAskAI = () => {
    const editor = editorRef.current
    if (!editor) return
    const pos = editor.getPosition()
    const dom = editor.getDomNode()
    let top = 100
    let left = 100
    if (pos && dom) {
      const coords = editor.getScrolledVisiblePosition(pos)
      const rect = dom.getBoundingClientRect()
      if (coords) {
        left = rect.left + coords.left
        top = rect.top + coords.top + coords.height
      }
    }
    setAiEdit({ open: true, position: { top, left }, loading: false, error: null })
  }

  const closeAskAI = () => setAiEdit({ open: false, position: null, loading: false, error: null })

  const submitAskAI = async (prompt: string) => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return

    const sel = editor.getSelection()
    const hasSelection = !!(sel && !sel.isEmpty())
    const targetText = hasSelection ? model.getValueInRange(sel!) : model.getValue()
    const isEmpty = targetText.trim().length === 0

    // System prompt is tight on purpose — we want raw replacement text,
    // no markdown fencing, no preamble. The user's instruction goes in
    // the user message so the AI sees it as their explicit ask.
    const systemContext = isEmpty
      ? `You are a writing assistant for a network engineer's scratchpad. The user has nothing written yet. Write the content they ask for.

Rules:
- Output ONLY the raw text the user should see in their scratchpad.
- No commentary, no markdown code fences, no preamble.
- Keep it concise and practical for a network engineer.`
      : `You are an editing assistant for a network engineer's scratchpad. The user has the following content and wants you to transform it according to their instruction.

Existing content:
"""
${targetText}
"""

Rules:
- Output ONLY the replacement text — no commentary, no code fences, no preamble.
- If the user asks a question that doesn't require rewriting, still output revised text that incorporates the answer.
- Preserve the user's intent and any factual data in the existing content.`

    setAiEdit(prev => ({ ...prev, loading: true, error: null }))
    try {
      const { provider, model: providerModel } = resolveProvider()
      const aiResponse = await sendChatMessage(
        [
          { role: 'system', content: systemContext },
          { role: 'user', content: prompt },
        ],
        { provider, model: providerModel },
      )
      if (!aiResponse) throw new Error('AI returned an empty response')

      // Strip stray code fences if the model added them anyway.
      const cleaned = aiResponse
        .replace(/^```[a-zA-Z0-9]*\n?/, '')
        .replace(/\n?```\s*$/, '')

      // Apply via the edit API so undo works.
      if (hasSelection) {
        editor.executeEdits('scratchpad-ai', [{ range: sel!, text: cleaned, forceMoveMarkers: true }])
      } else {
        const fullRange = model.getFullModelRange()
        editor.executeEdits('scratchpad-ai', [{ range: fullRange, text: cleaned, forceMoveMarkers: true }])
      }
      closeAskAI()
      showToast('AI edit applied — Cmd/Ctrl+Z to undo', 'success', 2500)
    } catch (err) {
      const msg = getErrorMessage(err, String(err))
      setAiEdit(prev => ({ ...prev, loading: false, error: msg }))
    }
  }

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.focus()

    // Right-click positioning: Monaco anchors its context menu at the
    // caret, so when the click lands somewhere the caret didn't move
    // to (empty space below text, gutter, scrollbar) the menu appears
    // far from the mouse. Force the caret to whatever the mouse is
    // hovering, with multiple fallbacks because Monaco's mouse target
    // can be position-less in several edge cases.
    editor.onMouseDown((e) => {
      if (!e.event.rightButton) return
      let pos: { lineNumber: number; column: number } | null = e.target.position
      // Fallback 1: recompute the target from the browser event's
      // client coordinates — sometimes gives a position when the
      // event target's own .position is null (e.g. content-empty).
      if (!pos) {
        const be = e.event.browserEvent as MouseEvent
        const t = editor.getTargetAtClientPoint(be.clientX, be.clientY)
        pos = t?.position ?? null
      }
      // Fallback 2: last position in the buffer. Better to anchor at
      // the bottom of the text than at the (stale) caret elsewhere.
      if (!pos) {
        const model = editor.getModel()
        if (model) {
          const lineCount = model.getLineCount()
          pos = { lineNumber: lineCount, column: model.getLineMaxColumn(lineCount) }
        }
      }
      if (pos) editor.setPosition(pos)
    })

    // Cmd/Ctrl+S → Save (also surfaced as a context-menu action).
    editor.addAction({
      id: 'scratchpad-save',
      label: 'Save Note',
      keybindings: [2048 /* CtrlCmd */ | 49 /* KeyS */],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.0,
      run: () => {
        void (async () => {
          try {
            await saveScratchpadContent(valueRef.current, activeWorkspaceRef.current)
            onSavedRef.current?.()
          } catch { /* toast already shown */ }
        })()
      },
    })

    // Ask AI — uses the same AIInlinePopup flow as the docs editor.
    editor.addAction({
      id: 'scratchpad-ask-ai',
      label: 'AI Edit…',
      contextMenuGroupId: 'ai',
      contextMenuOrder: 1.0,
      run: () => openAskAI(),
    })

    // Text transforms — one context-menu entry each.
    TRANSFORMS.forEach((t, i) => {
      editor.addAction({
        id: `scratchpad-${t.id}`,
        label: t.label,
        contextMenuGroupId: 'transform',
        contextMenuOrder: i,
        run: () => applyTransform(t.fn),
      })
    })

    editor.onDidChangeCursorPosition((e) => {
      setCursor({ line: e.position.lineNumber, col: e.position.column })
    })
  }

  return (
    <div className="scratchpad-editor-shell">
      <div className="scratchpad-editor-monaco">
        <Editor
          height="100%"
          theme="vs-dark"
          language="plaintext"
          value={value}
          onChange={(v) => onChange(v ?? '')}
          onMount={handleMount}
          options={{
            ...editorFont,
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            lineNumbers: 'on',
            folding: false,
            renderLineHighlight: 'line',
            padding: { top: 12, bottom: 12 },
            // Power-user defaults — Monaco's own. Listed for visibility.
            //   Alt+Click           → add cursor
            //   Cmd/Ctrl+D          → select next occurrence
            //   Cmd/Ctrl+Shift+L    → select all occurrences
            //   Shift+Alt+Down/Up   → duplicate line
            //   Alt+Down/Up         → move line
            //   Shift+Alt+drag      → column selection
            //   Cmd/Ctrl+F / H      → find / replace (regex + multi-line)
            multiCursorModifier: 'alt',
            multiCursorMergeOverlapping: true,
            mouseWheelZoom: true,
            bracketPairColorization: { enabled: true },
            find: {
              addExtraSpaceOnTop: false,
              autoFindInSelection: 'multiline',
              seedSearchStringFromSelection: 'selection',
            },
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'off',
            smoothScrolling: false,
            dragAndDrop: true,
            occurrencesHighlight: 'singleFile',
            selectionHighlight: true,
            autoClosingBrackets: 'languageDefined',
            autoIndent: 'advanced',
            contextmenu: true,
            // The Scratchpad panel is position:fixed. Without this,
            // Monaco anchors overflow widgets (context menu, find,
            // suggest, hover) using the document offset parent, which
            // misplaces them — sometimes far from the cursor — when
            // the host is a fixed/transformed container.
            fixedOverflowWidgets: true,
          }}
        />
        {aiEdit.open && aiEdit.position && (
          <MonacoOverlordWidget
            position={aiEdit.position}
            onSubmit={submitAskAI}
            onCancel={closeAskAI}
            loading={aiEdit.loading}
            error={aiEdit.error}
          />
        )}
      </div>
      <div className="scratchpad-footer">
        <span className="scratchpad-footer-hint" title="Right-click in the editor for tools and Ask AI">Right-click for tools · AI</span>
        <span className="scratchpad-footer-pos">Ln {cursor.line}, Col {cursor.col}</span>
      </div>
    </div>
  )
}
