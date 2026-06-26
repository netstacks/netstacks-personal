import { useState, useCallback } from 'react'
import WorkspaceCodeEditor from './WorkspaceCodeEditor'
import WorkspaceBrowser from './WorkspaceBrowser'
import WorkspaceDiffViewer from './WorkspaceDiffViewer'
import WorkspaceBlameViewer from './WorkspaceBlameViewer'
import WorkspaceImageViewer from './WorkspaceImageViewer'
import WorkspaceMarkdownPreview from './WorkspaceMarkdownPreview'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import type { InnerTab, FileOps, GitOps } from '../../types/workspace'

const RUNNABLE_EXTS = new Set(['py', 'sh', 'bash', 'zsh', 'js', 'ts'])

interface WorkspaceEditorAreaProps {
  innerTabs: InnerTab[]
  activeInnerTabId: string | null
  workspaceRoot: string
  fileOps: FileOps
  gitOps: GitOps | null
  onSetActiveTab: (id: string) => void
  onCloseTab: (id: string) => void
  onMarkModified: (id: string, modified: boolean) => void
  onRunFile: (filePath: string) => void
  onCollapse?: () => void
}

export default function WorkspaceEditorArea({
  innerTabs,
  activeInnerTabId,
  workspaceRoot,
  fileOps,
  gitOps,
  onSetActiveTab,
  onCloseTab,
  onMarkModified,
  onRunFile,
  onCollapse,
}: WorkspaceEditorAreaProps) {
  const [previewTabs, setPreviewTabs] = useState<Set<string>>(new Set())
  const [tabContextMenu, setTabContextMenu] = useState<{ position: { x: number; y: number }; items: MenuItem[] } | null>(null)

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tab: InnerTab) => {
    e.preventDefault()
    e.stopPropagation()
    const ext = tab.filePath?.split('.').pop()?.toLowerCase() || ''
    const isMd = tab.type === 'code-editor' && (ext === 'md' || ext === 'markdown')
    const inPreview = previewTabs.has(tab.id)
    const isRunnable = tab.type === 'code-editor' && tab.filePath && RUNNABLE_EXTS.has(ext)

    const items: MenuItem[] = []

    if (isMd) {
      items.push({
        id: 'toggle-preview',
        label: inPreview ? 'Edit Markdown' : 'Preview Markdown',
        action: () => setPreviewTabs(prev => {
          const next = new Set(prev)
          if (next.has(tab.id)) next.delete(tab.id)
          else next.add(tab.id)
          return next
        }),
      })
    }

    if (isRunnable) {
      items.push({
        id: 'run-file',
        label: 'Run File',
        action: () => onRunFile(tab.filePath!),
      })
    }

    if (tab.filePath) {
      items.push({
        id: 'copy-path',
        label: 'Copy Path',
        action: () => { navigator.clipboard.writeText(tab.filePath!) },
      })
    }

    if (items.length > 0) {
      items.push({ id: 'divider-actions', label: '', divider: true, action: () => {} })
    }

    items.push({
      id: 'close-tab',
      label: 'Close',
      action: () => onCloseTab(tab.id),
    })
    items.push({
      id: 'close-others',
      label: 'Close Others',
      action: () => innerTabs.filter(t => t.id !== tab.id).forEach(t => onCloseTab(t.id)),
    })
    items.push({
      id: 'close-all',
      label: 'Close All',
      action: () => innerTabs.forEach(t => onCloseTab(t.id)),
    })

    setTabContextMenu({ position: { x: e.clientX, y: e.clientY }, items })
  }, [previewTabs, innerTabs, onCloseTab, onRunFile])

  if (innerTabs.length === 0) {
    return (
      <div className="workspace-empty-state">
        <div className="workspace-empty-state-icon">📝</div>
        <div>Open a file from the explorer</div>
      </div>
    )
  }

  const activeTab = innerTabs.find(t => t.id === activeInnerTabId) || innerTabs[0]
  const activeExt = activeTab.filePath?.split('.').pop()?.toLowerCase() || ''
  const canRun = activeTab.type === 'code-editor' && activeTab.filePath && RUNNABLE_EXTS.has(activeExt)

  const renderTabContent = (tab: InnerTab) => {
    switch (tab.type) {
      case 'code-editor':
        if (previewTabs.has(tab.id) && tab.filePath) {
          return (
            <WorkspaceMarkdownPreview
              key={`preview-${tab.id}`}
              filePath={tab.filePath}
              fileOps={fileOps}
            />
          )
        }
        return (
          <WorkspaceCodeEditor
            key={tab.id}
            filePath={tab.filePath!}
            workspaceRoot={workspaceRoot}
            fileOps={fileOps}
            isModified={tab.isModified || false}
            onModifiedChange={(modified) => onMarkModified(tab.id, modified)}
            onRunFile={onRunFile}
          />
        )
      case 'browser':
        return (
          <WorkspaceBrowser
            key={tab.id}
            initialUrl={tab.url || 'about:blank'}
          />
        )
      case 'diff':
        if (!tab.filePath || !gitOps) return null
        return (
          <WorkspaceDiffViewer
            key={tab.id}
            filePath={tab.filePath}
            gitOps={gitOps}
          />
        )
      case 'blame':
        if (!tab.filePath || !gitOps) return null
        return (
          <WorkspaceBlameViewer
            key={tab.id}
            filePath={tab.filePath}
            gitOps={gitOps}
          />
        )
      case 'image':
        if (!tab.filePath) return null
        return (
          <WorkspaceImageViewer
            key={tab.id}
            filePath={tab.filePath}
            fileOps={fileOps}
          />
        )
      default:
        return null
    }
  }

  return (
    <>
      <div className="workspace-inner-tab-bar" onDoubleClick={onCollapse}>
        <div className="workspace-inner-tab-list">
          {innerTabs.map(tab => (
            <div
              key={tab.id}
              className={`workspace-inner-tab ${tab.id === activeTab.id ? 'active' : ''}`}
              onClick={() => onSetActiveTab(tab.id)}
              onContextMenu={(e) => handleTabContextMenu(e, tab)}
            >
              {tab.isModified && <span className="workspace-inner-tab-modified" />}
              <span>{tab.title}</span>
              <button
                className="workspace-inner-tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {canRun && (
          <button
            className="workspace-run-btn"
            onClick={() => onRunFile(activeTab.filePath!)}
            title={`Run ${activeTab.title}`}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}
        {onCollapse && (
          <button
            className="workspace-terminal-action-btn"
            onClick={onCollapse}
            title="Collapse editor"
          >
            ▲
          </button>
        )}
      </div>
      <div className="workspace-inner-tab-content">
        {renderTabContent(activeTab)}
      </div>
      <ContextMenu
        position={tabContextMenu?.position ?? null}
        items={tabContextMenu?.items ?? []}
        onClose={() => setTabContextMenu(null)}
      />
    </>
  )
}
