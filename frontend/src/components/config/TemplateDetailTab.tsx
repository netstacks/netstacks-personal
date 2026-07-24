import { useState, useEffect, useCallback, useRef } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import './TemplateDetailTab.css'
import { useMonacoOverlord } from '../../hooks/useMonacoOverlord'
import { useEditorFontSettings } from '../../hooks/useEditorFontSettings'
import MonacoOverlordWidget from '../MonacoOverlordWidget'
import './VariableInputs.css'
import VariableInputs from './VariableInputs'
import {
  getConfigTemplate,
  createConfigTemplate,
  updateConfigTemplate,
  deleteConfigTemplate,
  renderConfigTemplate,
  listTemplateVersions,
  listPlatforms,
} from '../../api/configManagement'
import type { ConfigPlatform } from '../../api/configManagement'
import type { ConfigTemplate, TemplateVersion } from '../../api/configManagement'
import AITabInput from '../AITabInput'

import { getErrorMessage } from '../../api/errors'
interface TemplateDetailTabProps {
  templateId: string
  onTitleChange?: (title: string) => void
  onDeleted?: () => void
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString()
  } catch {
    return dateStr
  }
}

function getMonacoLanguage(format: string): string {
  switch (format.toLowerCase()) {
    case 'json':
      return 'json'
    case 'xml':
    case 'netconf-xml':
      return 'xml'
    case 'yaml':
    case 'yml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

export default function TemplateDetailTab({
  templateId,
  onTitleChange,
  onDeleted,
}: TemplateDetailTabProps) {
  const isCreate = !templateId

  const [template, setTemplate] = useState<ConfigTemplate | null>(null)
  const [loading, setLoading] = useState(!isCreate)
  const [error, setError] = useState<string | null>(null)

  // Editor state
  const overlord = useMonacoOverlord()
  const editorFont = useEditorFontSettings()
  const [source, setSource] = useState('')
  const [readOnly, setReadOnly] = useState(!isCreate)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Versions
  const [versions, setVersions] = useState<TemplateVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [selectedVersionDiff, setSelectedVersionDiff] = useState<{ version: number; oldSource: string; newSource: string } | null>(null)

  // Render preview
  const [renderVars, setRenderVars] = useState<Record<string, string>>({})
  const [rendered, setRendered] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  // Confirm delete
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Resizable editor panel
  const [editorWidth, setEditorWidth] = useState<number | null>(null)
  const [draggingDivider, setDraggingDivider] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Editable metadata (used in both create and edit modes)
  const [editName, setEditName] = useState('')
  const [editPlatform, setEditPlatform] = useState('ios')
  const [editFormat, setEditFormat] = useState('cli')
  const [editOperation, setEditOperation] = useState('merge')
  const [platforms, setPlatforms] = useState<ConfigPlatform[]>([])

  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  // Load platforms list
  useEffect(() => {
    listPlatforms().then(setPlatforms).catch(console.error)
    if (isCreate) onTitleChangeRef.current?.('New Template')
  }, [isCreate])

  const fetchTemplate = useCallback(async () => {
    if (!templateId) return
    setLoading(true)
    setError(null)
    try {
      const t = await getConfigTemplate(templateId)
      setTemplate(t)
      setSource(t.source)
      setEditName(t.name)
      setEditPlatform(t.platform)
      setEditFormat(t.config_format)
      setEditOperation(t.operation)
      setDirty(false)
      onTitleChangeRef.current?.(`Template: ${t.name}`)
      // Init render vars
      const vars: Record<string, string> = {}
      for (const v of t.variables) vars[v.name] = ''
      setRenderVars(vars)
      setRendered(null)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load template'))
    } finally {
      setLoading(false)
    }
  }, [templateId])

  useEffect(() => {
    if (templateId) fetchTemplate()
  }, [fetchTemplate, templateId])

  const fetchVersions = useCallback(async () => {
    if (!templateId) return
    setVersionsLoading(true)
    try {
      const v = await listTemplateVersions(templateId)
      setVersions(v)
    } catch {
      setVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }, [templateId])

  useEffect(() => {
    if (versionsOpen && templateId) fetchVersions()
  }, [versionsOpen, fetchVersions, templateId])

  const handleSourceChange = (value: string | undefined) => {
    setSource(value || '')
    setDirty(true)
  }

  const handleSave = useCallback(async () => {
    if (isCreate) {
      if (!editName.trim()) return
      setSaving(true)
      try {
        const created = await createConfigTemplate({
          name: editName.trim(),
          source,
          platform: editPlatform,
          operation: editOperation,
          config_format: editFormat,
        })
        setTemplate(created)
        setSource(created.source)
        setDirty(false)
        onTitleChangeRef.current?.(`Template: ${created.name}`)
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to create template'))
      } finally {
        setSaving(false)
      }
      return
    }
    if (!template || !dirty) return
    setSaving(true)
    try {
      const updated = await updateConfigTemplate(templateId, {
        name: editName.trim() || template.name,
        description: template.description,
        source,
        platform: editPlatform,
        operation: editOperation,
        config_format: editFormat,
      })
      setTemplate(updated)
      setSource(updated.source)
      setEditName(updated.name)
      setEditPlatform(updated.platform)
      setEditFormat(updated.config_format)
      setEditOperation(updated.operation)
      setDirty(false)
      onTitleChangeRef.current?.(`Template: ${updated.name}`)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to save template'))
    } finally {
      setSaving(false)
    }
  }, [template, templateId, source, dirty, isCreate, editName, editPlatform, editFormat, editOperation])

  const handleDelete = useCallback(async () => {
    try {
      await deleteConfigTemplate(templateId)
      onDeleted?.()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete template'))
    }
  }, [templateId, onDeleted])

  const handleRender = useCallback(async () => {
    if (!template) return
    setRendering(true)
    try {
      const result = await renderConfigTemplate(templateId, { variables: renderVars })
      setRendered(result.rendered)
    } catch (err) {
      setRendered(`Error: ${getErrorMessage(err, 'Render failed')}`)
    } finally {
      setRendering(false)
    }
  }, [templateId, renderVars, template])

  // Auto-render when variables change (debounced)
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!template || !previewOpen) return
    // Only auto-render if at least one variable has a value
    const hasValue = Object.values(renderVars).some((v) => v.trim() !== '')
    if (!hasValue) return
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current)
    renderTimerRef.current = setTimeout(() => {
      handleRender()
    }, 600)
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current)
    }
  }, [renderVars, previewOpen, template, handleRender])

  // Resizable divider handler
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDraggingDivider(true)
    const startX = e.clientX
    const startWidth = editorWidth || (bodyRef.current ? bodyRef.current.offsetWidth * 0.5 : 400)

    const onMouseMove = (ev: MouseEvent) => {
      const bodyRect = bodyRef.current?.getBoundingClientRect()
      if (!bodyRect) return
      const newWidth = Math.min(bodyRect.width - 250, Math.max(200, startWidth + (ev.clientX - startX)))
      setEditorWidth(newWidth)
    }
    const onMouseUp = () => {
      setDraggingDivider(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [editorWidth])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleSave])

  if (loading) {
    return (
      <div className="tdt-container">
        <div className="tdt-loading">
          <div className="tdt-spinner" />
          <span>Loading template...</span>
        </div>
      </div>
    )
  }

  if (error && !template) {
    return (
      <div className="tdt-container">
        <div className="tdt-error">
          <span>{error}</span>
          <button className="tdt-btn" onClick={fetchTemplate}>Retry</button>
        </div>
      </div>
    )
  }

  if (!template && !isCreate) return null

  const monacoLang = getMonacoLanguage(editFormat)

  return (
    <div className="tdt-container">
      {/* Header */}
      <div className="tdt-header">
        <div className="tdt-header-info">
          {!readOnly || isCreate ? (
            <>
              <AITabInput
                className="tdt-create-name-input"
                value={editName}
                onChange={e => { setEditName(e.target.value); setDirty(true) }}
                placeholder="Template name..."
                autoFocus={isCreate}
                aiField="template_name"
                aiPlaceholder="Config template name"
                aiContext={{ platform: editPlatform, format: editFormat, operation: editOperation }}
                onAIValue={v => { setEditName(v); setDirty(true) }}
              />
              <select className="tdt-create-select" value={editPlatform} onChange={e => { setEditPlatform(e.target.value); setDirty(true) }}>
                {platforms.length > 0 ? platforms.map(p => (
                  <option key={p.id} value={p.name}>{p.display_name}</option>
                )) : (
                  <>
                    <option value="ios">IOS</option>
                    <option value="iosxr">IOS-XR</option>
                    <option value="junos">JunOS</option>
                    <option value="nxos">NX-OS</option>
                    <option value="eos">EOS</option>
                  </>
                )}
              </select>
              <select className="tdt-create-select" value={editFormat} onChange={e => { setEditFormat(e.target.value); setDirty(true) }}>
                <option value="cli">CLI</option>
                <option value="xml">XML</option>
                <option value="netconf-xml">NETCONF XML</option>
                <option value="json">JSON</option>
                <option value="yaml">YAML</option>
              </select>
              <select className="tdt-create-select" value={editOperation} onChange={e => { setEditOperation(e.target.value); setDirty(true) }}>
                <option value="merge">Merge</option>
                <option value="replace">Replace</option>
                <option value="delete">Delete</option>
              </select>
              {template && <span className="tdt-badge tdt-badge-version">v{template.current_version}</span>}
              {dirty && <span className="tdt-badge tdt-badge-unsaved">unsaved</span>}
            </>
          ) : (
            <>
              <h2 className="tdt-title">{template!.name}</h2>
              <span className="tdt-badge tdt-badge-platform">{template!.platform}</span>
              <span className="tdt-badge tdt-badge-format">{template!.config_format}</span>
              <span className="tdt-badge tdt-badge-version">v{template!.current_version}</span>
            </>
          )}
        </div>
        <div className="tdt-header-actions">
          {!isCreate && (
            <label className="tdt-toggle-label">
              <input
                type="checkbox"
                checked={!readOnly}
                onChange={(e) => setReadOnly(!e.target.checked)}
              />
              <span>Edit</span>
            </label>
          )}
          <button
            className="tdt-btn primary"
            onClick={handleSave}
            disabled={isCreate ? (!editName.trim() || saving) : (!dirty || saving)}
          >
            {saving ? 'Saving...' : isCreate && !template ? 'Create' : 'Save'}
          </button>
          {!isCreate && (
            confirmDelete ? (
              <>
                <button className="tdt-btn danger" onClick={handleDelete}>
                  Confirm Delete
                </button>
                <button className="tdt-btn" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="tdt-btn" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )
          )}
        </div>
      </div>

      {error && (
        <div className="tdt-error-bar">{error}</div>
      )}

      {/* Main content */}
      <div className="tdt-body" ref={bodyRef}>
        {/* Monaco Editor */}
        <div className="tdt-editor-section" style={editorWidth ? { width: editorWidth } : { flex: '1 1 50%' }}>
          <div className="tdt-section-header">
            Template Source
            <span className="tdt-section-lang">{monacoLang}</span>
          </div>
          <div className="tdt-editor-wrapper">
            <div className="tdt-editor-monaco">
              <Editor
                height="100%"
                language={monacoLang}
                value={source}
                onChange={handleSourceChange}
                onMount={(editor) => overlord.register(editor)}
                theme="vs-dark"
                options={{
                  readOnly,
                  minimap: { enabled: false },
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  tabSize: 2,
                  // fontSize / fontFamily honor Settings → Appearance.
                  ...editorFont,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  padding: { top: 8, bottom: 8 },
                }}
              />
              {overlord.isOpen && overlord.widgetPosition && (
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
        </div>

        {/* Resizable divider */}
        <div
          className={`tdt-panel-divider ${draggingDivider ? 'active' : ''}`}
          onMouseDown={handleDividerMouseDown}
        />

        {/* Side panel */}
        <div className="tdt-side-panel">
          {/* Variables */}
          {(template?.variables?.length ?? 0) > 0 && (
            <div className="tdt-side-section">
              <div className="tdt-side-section-header">
                Variables ({template?.variables?.length})
              </div>
              <div className="tdt-variables-list">
                {template!.variables.map((v) => (
                  <div key={v.name} className="tdt-variable-item">
                    <span className="tdt-variable-name">{v.name}</span>
                    <span className="tdt-variable-badges">
                      <span className="tdt-badge tdt-badge-type">{v.type}</span>
                      {v.required && <span className="tdt-badge tdt-badge-required">req</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Render Preview */}
          {(template?.variables?.length ?? 0) > 0 && (
            <div className="tdt-side-section">
              <div
                className="tdt-side-section-header tdt-clickable"
                onClick={() => setPreviewOpen(!previewOpen)}
              >
                <span className="tdt-toggle-arrow">{previewOpen ? '\u25BC' : '\u25B6'}</span>
                Render Preview
              </div>
              {previewOpen && (
                <div className="tdt-render-panel">
                  <VariableInputs
                    variables={template!.variables}
                    values={renderVars}
                    onChange={setRenderVars}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
                    <button className="tdt-btn primary tdt-render-btn" onClick={handleRender} disabled={rendering} style={{ flex: 'none', width: 'auto' }}>
                      {rendering ? 'Rendering...' : 'Render'}
                    </button>
                    {rendering && <span style={{ fontSize: 10, color: 'var(--text-secondary, #858585)' }}>Auto-renders on change</span>}
                  </div>
                  {rendered && (
                    <div className="tdt-render-output-wrapper">
                      <Editor
                        height="200px"
                        language={monacoLang}
                        value={rendered}
                        theme="vs-dark"
                        options={{
                          readOnly: true,
                          minimap: { enabled: false },
                          lineNumbers: 'off',
                          wordWrap: 'on',
                          // Preview pane — keep one step smaller than the
                          // main editor so the eye reads it as secondary.
                          fontSize: Math.max(8, editorFont.fontSize - 1),
                          fontFamily: editorFont.fontFamily,
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          padding: { top: 4, bottom: 4 },
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Version History */}
          <div className="tdt-side-section">
            <div
              className="tdt-side-section-header tdt-clickable"
              onClick={() => setVersionsOpen(!versionsOpen)}
            >
              <span className="tdt-toggle-arrow">{versionsOpen ? '\u25BC' : '\u25B6'}</span>
              Version History
            </div>
            {versionsOpen && (
              <div className="tdt-versions-panel">
                {versionsLoading ? (
                  <div className="tdt-versions-loading">Loading...</div>
                ) : versions.length === 0 ? (
                  <div className="tdt-versions-empty">No version history</div>
                ) : (
                  <div className="tdt-versions-list">
                    {versions.map((v, idx) => {
                      const isSelected = selectedVersionDiff?.version === v.version
                      return (
                        <div key={v.version}>
                          <div
                            className={`tdt-version-item ${isSelected ? 'active' : ''}`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              if (isSelected) {
                                setSelectedVersionDiff(null)
                              } else {
                                // Find previous version source
                                const prevVersion = versions[idx + 1]
                                setSelectedVersionDiff({
                                  version: v.version,
                                  oldSource: prevVersion?.source || '',
                                  newSource: v.source,
                                })
                              }
                            }}
                          >
                            <span className="tdt-version-num">v{v.version}</span>
                            <span className="tdt-version-date">{formatDate(v.created_at)}</span>
                            <span className="tdt-version-by">{v.created_by}</span>
                          </div>
                          {isSelected && (
                            <div className="tdt-version-diff">
                              <div className="tdt-version-diff-actions">
                                <button
                                  className="tdt-btn"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSource(v.source)
                                    setDirty(true)
                                    setSelectedVersionDiff(null)
                                  }}
                                >
                                  Restore v{v.version}
                                </button>
                              </div>
                              <DiffEditor
                                height="200px"
                                language={monacoLang}
                                original={selectedVersionDiff.oldSource}
                                modified={selectedVersionDiff.newSource}
                                theme="vs-dark"
                                options={{
                                  readOnly: true,
                                  minimap: { enabled: false },
                                  renderSideBySide: false,
                                  wordWrap: 'on',
                                  // Diff strip — two steps smaller than
                                  // the main editor to fit dense per-line
                                  // change context.
                                  fontSize: Math.max(8, editorFont.fontSize - 2),
                                  fontFamily: editorFont.fontFamily,
                                  scrollBeyondLastLine: false,
                                  automaticLayout: true,
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
