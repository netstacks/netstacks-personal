import { useState, useEffect, useCallback, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { editor } from 'monaco-editor'
import type { FileOps } from '../../types/workspace'
import { showToast } from '../Toast'
import { useMonacoOverlord } from '../../hooks/useMonacoOverlord'
import { useEditorFontSettings } from '../../hooks/useEditorFontSettings'
import MonacoOverlordWidget from '../MonacoOverlordWidget'
import { LspBridge } from '../../lsp/LspBridge'

import { getErrorMessage } from '../../api/errors'
interface WorkspaceCodeEditorProps {
  filePath: string
  workspaceRoot: string
  fileOps: FileOps
  isModified: boolean
  onModifiedChange: (modified: boolean) => void
  onRunFile?: (filePath: string) => void
}

const EXT_TO_LANG: Record<string, string> = {
  py: 'python',
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml',
  html: 'html', htm: 'html',
  css: 'css',
  md: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sql: 'sql',
  toml: 'ini',
  cfg: 'ini', conf: 'ini', ini: 'ini',
  j2: 'html', jinja: 'html', jinja2: 'html',
  yang: 'yang',
  tf: 'hcl',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

const RUNNABLE_EXTS = new Set(['py', 'sh', 'bash', 'zsh', 'js', 'ts'])

export default function WorkspaceCodeEditor({
  filePath,
  workspaceRoot,
  fileOps,
  onModifiedChange,
  onRunFile,
}: WorkspaceCodeEditorProps) {
  const [initialContent, setInitialContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const savedContentRef = useRef<string>('')
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<editor.ITextModel | null>(null)
  const fileOpsRef = useRef(fileOps)
  const filePathRef = useRef(filePath)
  const onModifiedChangeRef = useRef(onModifiedChange)
  const onRunFileRef = useRef(onRunFile)
  const savingRef = useRef(false)

  fileOpsRef.current = fileOps
  filePathRef.current = filePath
  onModifiedChangeRef.current = onModifiedChange
  onRunFileRef.current = onRunFile

  const overlord = useMonacoOverlord()
  const editorFont = useEditorFontSettings()

  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const language = EXT_TO_LANG[ext] || 'plaintext'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    editorRef.current = null
    modelRef.current = null
    // Tear down any open overlord state so the widget doesn't linger
    // pointing at the previous file's editor instance.
    overlord.reset()
    fileOps.readFile(filePath).then(text => {
      if (cancelled) return
      savedContentRef.current = text
      setInitialContent(text)
      onModifiedChange(false)
      setLoading(false)
    }).catch(err => {
      if (cancelled) return
      setError(getErrorMessage(err, 'Failed to read file'))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [filePath])

  const handleEditorMount: OnMount = useCallback((ed) => {
    editorRef.current = ed
    modelRef.current = ed.getModel()
    overlord.register(ed)

    // Cmd+S: Save
    ed.addAction({
      id: 'workspace-save',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: async () => {
        if (savingRef.current) return
        savingRef.current = true
        const content = ed.getValue()
        try {
          await fileOpsRef.current.writeFile(filePathRef.current, content)
          savedContentRef.current = content
          onModifiedChangeRef.current(false)
          showToast('Saved', 'success', 1500)
        } catch (err) {
          showToast(`Save failed: ${getErrorMessage(err, String(err))}`, 'error')
        } finally {
          savingRef.current = false
        }
      },
    })

    // Cmd+Shift+B: Run file (if runnable)
    const fileExt = filePathRef.current.split('.').pop()?.toLowerCase() || ''
    if (RUNNABLE_EXTS.has(fileExt)) {
      ed.addAction({
        id: 'workspace-run',
        label: 'Run File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyB],
        contextMenuGroupId: '1_run',
        contextMenuOrder: 1,
        run: () => {
          onRunFileRef.current?.(filePathRef.current)
        },
      })
    }

    ed.onDidChangeModelContent(() => {
      const isDirty = ed.getValue() !== savedContentRef.current
      onModifiedChangeRef.current(isDirty)
    })
  }, [overlord])

  // Window-level Cmd+S capture for when Monaco doesn't have focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && editorRef.current) {
        e.preventDefault()
        e.stopPropagation()
        editorRef.current.getAction('workspace-save')?.run()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  if (loading) {
    return <div className="workspace-empty-state"><div>Loading...</div></div>
  }

  if (error) {
    return <div className="workspace-empty-state"><div style={{ color: 'var(--color-error)' }}>{error}</div></div>
  }

  return (
    <div className="workspace-code-editor">
      {editorRef.current && modelRef.current && (
        <LspBridge
          monaco={monaco}
          editor={editorRef.current}
          model={modelRef.current}
          language={language}
          workspace={workspaceRoot}
        />
      )}
      {/* Wrapper takes the remaining flex height so the accept bar
          below can claim its natural content height without fighting
          the Editor's default height:100%. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Editor
          defaultValue={initialContent || ''}
          language={language}
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            // fontSize / fontFamily honor Settings → Appearance.
            ...editorFont,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'off',
            renderWhitespace: 'selection',
            padding: { top: 4 },
          }}
        />
        {overlord.isOpen && overlord.widgetPosition && editorRef.current && (
          <MonacoOverlordWidget
            position={overlord.widgetPosition}
            onSubmit={overlord.handleSubmit}
            onCancel={overlord.close}
            loading={overlord.loading}
            error={overlord.error}
          />
        )}
      </div>
      {overlord.hasPendingEdit && (
        <div className="overlord-accept-bar">
          <span>AI edit applied — review the highlighted changes</span>
          <button className="overlord-accept-btn" onClick={overlord.accept}>Accept</button>
          <button className="overlord-reject-btn" onClick={overlord.reject}>Reject</button>
        </div>
      )}
    </div>
  )
}
