/**
 * ScratchpadTab — the in-tab view of the Scratchpad. Same editor and
 * save logic as the floating panel; just rendered inside the main tab
 * area instead of a draggable panel. Closing the tab discards the
 * unsaved buffer (matches the floating panel's lifecycle).
 */

import { useState } from 'react'
import { useBinding } from '../hooks/useKeyboard'
import ScratchpadEditor, { saveScratchpadContent, scratchpadTarget } from './ScratchpadEditor'
import type { WorkspaceConfig } from '../types/workspace'
import './Scratchpad.css'
import Tooltip from './Tooltip'

interface ScratchpadTabProps {
  initialContent: string
  activeWorkspace: WorkspaceConfig | null
  /** Close this tab. Called after a successful save. */
  onClose: () => void
}

export default function ScratchpadTab({ initialContent, activeWorkspace, onClose }: ScratchpadTabProps) {
  const saveBinding = useBinding('saveDocument')
  const [content, setContent] = useState(initialContent)
  const [saving, setSaving] = useState(false)
  const target = scratchpadTarget(activeWorkspace)

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    try {
      await saveScratchpadContent(content, activeWorkspace)
      onClose()
    } catch { /* toast already shown */ }
    finally { setSaving(false) }
  }

  return (
    <div className="scratchpad-tab">
      <div className="scratchpad-tab-header">
        <div className="scratchpad-title">
          <span>Scratchpad</span>
          <Tooltip label="Save destination"><span className="scratchpad-target">→ {target}</span></Tooltip>
        </div>
        <div className="scratchpad-actions">
          <Tooltip label="Save" shortcut={saveBinding}><button
            className="ns-btn ns-btn--small ns-btn--primary"
            onClick={() => { void handleSave() }}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button></Tooltip>
        </div>
      </div>
      <div className="scratchpad-body">
        <ScratchpadEditor
          initialValue={content}
          onChange={setContent}
          activeWorkspace={activeWorkspace}
          onSaved={onClose}
        />
      </div>
    </div>
  )
}
