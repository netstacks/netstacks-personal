import { useState, useCallback, useEffect } from 'react'
import type { WorkspaceConfig } from '../../types/workspace'
import { getClient } from '../../api/client'
import { showToast } from '../Toast'
import { confirmDialog } from '../ConfirmDialog'
import { usePersistedState } from '../../hooks/usePersistedState'
import ScriptsPanel from '../ScriptsPanel'
import type { Script } from '../../api/scripts'

interface WorkspacesPanelProps {
  onOpenWorkspace: (config: WorkspaceConfig) => void
  onNewWorkspace: () => void
  openWorkspaceIds: Set<string>
  /** Close the open workspace tab without deleting the saved config.
   *  Distinct from `delete` which removes the saved workspace entirely. */
  onCloseWorkspace?: (id: string) => void
  onOpenScript: (script: Script) => void
  onNewScript: () => void
  onAIGenerate: () => void
}

export async function loadSavedWorkspaces(): Promise<WorkspaceConfig[]> {
  try {
    const { data } = await getClient().http.get('/settings/workspaces')
    if (typeof data === 'string') return JSON.parse(data)
    if (Array.isArray(data)) return data
    if (data?.value) return typeof data.value === 'string' ? JSON.parse(data.value) : data.value
    return []
  } catch {
    return []
  }
}

async function saveSavedWorkspaces(workspaces: WorkspaceConfig[]): Promise<void> {
  await getClient().http.put('/settings/workspaces', JSON.stringify(workspaces))
}

export async function addSavedWorkspace(config: WorkspaceConfig): Promise<void> {
  const existing = await loadSavedWorkspaces()
  if (!existing.find(w => w.id === config.id)) {
    existing.push(config)
    await saveSavedWorkspaces(existing)
  }
}

/**
 * Update an existing saved workspace in-place. UPDATE-ONLY: if the
 * workspace isn't in the saved list (e.g. the user just deleted it
 * from the sidebar while the tab was still open), this is a no-op.
 *
 * The previous implementation also pushed-when-missing, which created
 * a resurrection bug: deleting an open workspace would write the
 * delete to storage, then the open tab's auto-save or unmount-save
 * effect (useWorkspace.ts ~317, ~348) would re-add it.
 */
export async function updateSavedWorkspace(config: WorkspaceConfig): Promise<void> {
  const existing = await loadSavedWorkspaces()
  const idx = existing.findIndex(w => w.id === config.id)
  if (idx < 0) {
    // Deleted while still open — let the deletion stand.
    return
  }
  existing[idx] = config
  await saveSavedWorkspaces(existing)
}

export default function WorkspacesPanel({
  onOpenWorkspace,
  onNewWorkspace,
  openWorkspaceIds,
  onCloseWorkspace,
  onOpenScript,
  onNewScript,
  onAIGenerate,
}: WorkspacesPanelProps) {
  const [savedWorkspaces, setSavedWorkspaces] = useState<WorkspaceConfig[]>([])
  // Collapsed states persist across panel mount/unmount and app restarts
  // — the panel was forgetting its layout every time the user switched
  // away from the Workspaces sidebar view.
  const [pyEngineCollapsed, setPyEngineCollapsed] = usePersistedState(
    'workspacesPanel.pyEngineCollapsed', false,
  )
  const [wsCollapsed, setWsCollapsed] = usePersistedState(
    'workspacesPanel.wsCollapsed', false,
  )
  const [explorerCollapsed, setExplorerCollapsed] = usePersistedState(
    'workspacesPanel.explorerCollapsed', false,
  )

  // Resilient load: fetches directly so a transient 5xx doesn't blank
  // the panel. loadSavedWorkspaces() returns [] on error (callers like
  // addSavedWorkspace rely on that), so we can't use it here without
  // wiping the visible list every time the network blips.
  const load = useCallback(async () => {
    try {
      const { data } = await getClient().http.get('/settings/workspaces')
      let parsed: WorkspaceConfig[] = []
      if (typeof data === 'string') parsed = JSON.parse(data)
      else if (Array.isArray(data)) parsed = data
      else if (data?.value) parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value
      setSavedWorkspaces(parsed)
    } catch {
      // Keep whatever we already had. A transient backend error
      // shouldn't visually delete the user's workspace list.
    }
  }, [])

  useEffect(() => {
    load()
    // Audit P2-2: removed the openWorkspaceIds.size-dependent reload
    // effect. Tab open/close is not a workspaces-list change, and the
    // late-resolving fetch raced with deleteWorkspace's local
    // setSavedWorkspaces — repopulating the deleted row until the next
    // interaction.
  }, [load])

  const deleteWorkspace = useCallback(async (id: string, name: string) => {
    const isOpen = openWorkspaceIds.has(id)
    const ok = await confirmDialog({
      title: 'Delete saved workspace?',
      body: (
        <>
          Remove the saved workspace <strong>{name}</strong>? Your git
          repository on disk is not touched.
          {isOpen && (
            <>
              <br /><br />
              <em>This workspace is currently open — the tab will be closed.</em>
            </>
          )}
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const updated = savedWorkspaces.filter(w => w.id !== id)
    try {
      // Close the open tab BEFORE persisting the delete so its
      // unmount-save can't race the deletion. updateSavedWorkspace is
      // now update-only (silently skips missing rows) so even with the
      // race this would be safe, but closing first is cleaner UX.
      if (isOpen && onCloseWorkspace) onCloseWorkspace(id)
      await saveSavedWorkspaces(updated)
      setSavedWorkspaces(updated)
      showToast(`Deleted "${name}"`, 'success')
    } catch {
      showToast('Failed to delete workspace', 'error')
    }
  }, [savedWorkspaces, openWorkspaceIds, onCloseWorkspace])

  return (
    <div className="workspace-panel-sidebar">
      {/* ── Python Engine section ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setPyEngineCollapsed(!pyEngineCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{pyEngineCollapsed ? '▸' : '▾'}</span>
        <span>PYTHON ENGINE</span>
      </div>

      {!pyEngineCollapsed && (
        <div className="workspace-panel-list" style={{ flex: 'none', maxHeight: 'none' }}>
          <ScriptsPanel
            onOpenScript={onOpenScript}
            onNewScript={onNewScript}
            onAIGenerate={onAIGenerate}
          />
        </div>
      )}

      {/* ── Workspaces section ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setWsCollapsed(!wsCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{wsCollapsed ? '▸' : '▾'}</span>
        <span>WORKSPACES</span>
        <button
          className="workspace-panel-section-btn"
          onClick={(e) => { e.stopPropagation(); onNewWorkspace() }}
          title="New Workspace"
        >
          +
        </button>
      </div>

      {!wsCollapsed && (
        <div className="workspace-panel-list" style={{ flex: explorerCollapsed ? 1 : undefined, maxHeight: explorerCollapsed ? 'none' : undefined }}>
          {savedWorkspaces.length === 0 && (
            <div className="workspace-panel-empty">
              <p>No saved workspaces</p>
              <button className="workspace-panel-add-btn" onClick={onNewWorkspace}>
                + New Workspace
              </button>
            </div>
          )}
          {savedWorkspaces.map(ws => {
            const isOpen = openWorkspaceIds.has(ws.id)
            return (
              <div
                key={ws.id}
                className={`workspace-panel-item ${isOpen ? 'active' : ''}`}
                onClick={() => onOpenWorkspace(ws)}
              >
                <span className="workspace-panel-item-icon">
                  {ws.mode === 'remote' ? '📡' : '📁'}
                </span>
                <div className="workspace-panel-item-info">
                  <span className="workspace-panel-item-name">{ws.name}</span>
                  <span className="workspace-panel-item-path">{ws.rootPath}</span>
                </div>
                {isOpen && (
                  <span className="workspace-panel-item-badge">open</span>
                )}
                {isOpen && onCloseWorkspace && (
                  <button
                    className="workspace-panel-item-close"
                    onClick={(e) => { e.stopPropagation(); onCloseWorkspace(ws.id) }}
                    title="Close workspace (keep saved config)"
                  >
                    ⌫
                  </button>
                )}
                <button
                  className="workspace-panel-item-delete"
                  onClick={(e) => { e.stopPropagation(); deleteWorkspace(ws.id, ws.name) }}
                  title="Delete saved workspace (does not touch the git repo on disk)"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Explorer section ── */}
      <div
        className="workspace-panel-section-header"
        onClick={() => setExplorerCollapsed(!explorerCollapsed)}
      >
        <span className="workspace-panel-section-toggle">{explorerCollapsed ? '▸' : '▾'}</span>
        <span>EXPLORER</span>
      </div>

      <div
        id="workspace-sidebar-explorer"
        className="workspace-sidebar-explorer-target"
        style={{ display: explorerCollapsed ? 'none' : undefined, flex: wsCollapsed ? 1 : undefined }}
      />
    </div>
  )
}
