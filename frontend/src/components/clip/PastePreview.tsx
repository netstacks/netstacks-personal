/**
 * Paste dialog (docs/clipboard-history-plan.md §4.4): the clipboard text on the
 * left is EDITABLE (SecureCRT-style "confirm multi-line paste"), the right pane
 * shows exactly what the selected preset will send with control characters
 * made visible and changed lines highlighted. Confirm pastes the right-hand
 * text into the target terminal; Ctrl+Enter is the keyboard shortcut.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CliFlavor } from '../../types/enrichment'
import {
  activePresets, applyChain, describeChain, presetForFlavor, RAW_PRESET_ID, type TransformId,
} from '../../lib/clipTransforms'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { useMovableRect } from '../../hooks/useMovableRect'
import { formatClipSize, byteLength, countLines } from '../../lib/clipText'
import { addedLines, visualize } from './pastePreviewHelpers'
import DialogFooter from '../DialogFooter'
import './PastePreview.css'
import './movablePopup.css'
import Tooltip from '../Tooltip'

interface PastePreviewProps {
  text: string
  flavor: CliFlavor
  /** Where the paste will land, for the title. */
  targetName: string
  /** Start with the Raw preset selected (the user asked for a raw paste). */
  initialRaw?: boolean
  onPaste: (text: string) => void
  onClose: () => void
}

export default function PastePreview({ text, flavor, targetName, initialRaw = false, onPaste, onClose }: PastePreviewProps) {
  const presets = useMemo(() => activePresets(), [])
  const auto = presetForFlavor(presets, flavor)
  const [presetId, setPresetId] = useState<string>(initialRaw ? RAW_PRESET_ID : (auto?.id ?? RAW_PRESET_ID))
  const [draft, setDraft] = useState(text)
  const edited = draft !== text
  const chain = useMemo<TransformId[]>(() => presets.find((p) => p.id === presetId)?.chain ?? [], [presets, presetId])
  const result = useMemo(() => applyChain(draft, chain, { flavor }), [draft, chain, flavor])

  // Everything derived from the texts is memoised: the popup re-renders on
  // every drag/resize mousemove, and a large paste must not be re-diffed then.
  const draftStats = useMemo(() => formatClipSize(byteLength(draft), countLines(draft)), [draft])
  const resultLineCount = useMemo(() => countLines(result), [result])
  const resultStats = useMemo(() => formatClipSize(byteLength(result), resultLineCount), [result, resultLineCount])
  const resultLines = useMemo(() => result.split('\n'), [result])
  const added = useMemo(() => addedLines(draft.split('\n'), resultLines), [draft, resultLines])

  const editorRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    editorRef.current?.focus()
  }, [])
  const canPaste = result.length > 0
  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canPaste) {
      e.preventDefault()
      onPaste(result)
    }
  }

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose })
  const { style, onHeaderMouseDown, onResizeMouseDown } = useMovableRect({
    initial: (vw, vh) => ({ w: Math.min(1000, vw - 32), h: Math.min(640, Math.round(vh * 0.8)), x: Math.max(8, Math.round((vw - Math.min(1000, vw - 32)) / 2)), y: Math.round(vh * 0.08) }),
    minWidth: 520,
    minHeight: 300,
    storageKey: 'netstacks:paste-preview:rect',
  })

  return (
    <div className="command-palette-overlay" {...backdropProps}>
      <div className="paste-preview movable-popup" role="dialog" aria-label="Paste preview" style={style} {...contentProps}>
        <Tooltip label="Drag to move"><div className="paste-preview-head movable-popup-titlebar" onMouseDown={onHeaderMouseDown}>
          <div>
            <strong>Paste into {targetName}</strong>
            <span className="paste-preview-sub"> · flavor {flavor} · {describeChain(chain)}</span>
          </div>
          <label className="paste-preview-preset">
            Preset
            <select className="ns-select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{auto?.id === p.id ? ' (auto)' : ''}</option>
              ))}
            </select>
          </label>
        </div></Tooltip>

        <div className="paste-preview-panes">
          <div className="paste-preview-pane">
            <div className="paste-preview-pane-title">
              {edited ? 'Edited' : 'Clipboard'} · {draftStats} · editable
              {edited && (
                <Tooltip label="Discard edits and restore the clipboard text"><button type="button" className="ns-btn ns-btn--small paste-preview-revert" onClick={() => setDraft(text)}>
                  revert
                </button></Tooltip>
              )}
            </div>
            <textarea data-ai-fill="off"
              ref={editorRef}
              className="paste-preview-editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditorKeyDown}
              spellCheck={false}
              aria-label="Text to paste (editable)"
              data-testid="paste-preview-editor"
            />
          </div>
          <div className="paste-preview-pane">
            <div className="paste-preview-pane-title">Will paste · {resultStats}</div>
            <pre>
              {resultLines.map((l, i) => (
                <div key={i} className={added.has(i) ? 'added' : ''}>{visualize(l) || ' '}</div>
              ))}
            </pre>
          </div>
        </div>

        <DialogFooter
          primary={{ label: `Paste ${resultLineCount} ${resultLineCount === 1 ? 'line' : 'lines'}`, onClick: () => onPaste(result), disabled: !canPaste }}
          onCancel={onClose}
          leading={<span className="paste-preview-legend">Edit on the left · right shows what is sent · ␍ carriage return · → tab · · trailing space · <span className="added">changed by preset</span> · <kbd>Ctrl+↵</kbd> paste</span>}
        />
        <Tooltip label="Drag to resize"><div className="movable-popup-resize" onMouseDown={onResizeMouseDown} /></Tooltip>
      </div>
    </div>
  )
}
