/**
 * SettingsDocuments - configure where automatic document saves go.
 *
 * Each auto-save source (topology enrichment, troubleshooting, MOP, etc.) can be
 * pointed at a document category + optional folder. Stored in the
 * 'documents.saveTargets' setting (localStorage → applies in personal and
 * enterprise mode). The AI-agent default is also mirrored to the backend so the
 * standalone agent honors it.
 */
import { useCallback, useMemo } from 'react'
import { useSettings } from '../hooks/useSettings'
import type { DocumentCategory } from '../api/docs'
import {
  DOC_SAVE_SOURCES,
  DOC_SAVE_SOURCE_LABELS,
  DEFAULT_SAVE_TARGETS,
  syncAiAgentDefaultToBackend,
  type DocSaveSource,
} from '../lib/docSaveTargets'

const CATEGORIES: DocumentCategory[] = [
  'outputs', 'templates', 'notes', 'backups', 'history', 'troubleshooting', 'mops',
]

export default function SettingsDocuments() {
  const { settings, updateSetting } = useSettings()
  const targets = useMemo(() => settings['documents.saveTargets'] ?? {}, [settings])

  const effective = useCallback((source: DocSaveSource) => {
    const def = DEFAULT_SAVE_TARGETS[source]
    const override = targets[source]
    return {
      category: (override?.category as DocumentCategory) || def.category,
      folder: override?.folder ?? def.folder ?? '',
    }
  }, [targets])

  const writeTarget = useCallback((source: DocSaveSource, patch: { category?: DocumentCategory; folder?: string }) => {
    const current = effective(source)
    const next = {
      ...targets,
      [source]: {
        category: patch.category ?? current.category,
        folder: patch.folder ?? current.folder,
      },
    }
    updateSetting('documents.saveTargets', next)
    // Keep the standalone agent in sync for the AI default row.
    if (source === 'aiAgentDefault') {
      // Defer so the setting singleton is updated before we read it.
      setTimeout(() => { void syncAiAgentDefaultToBackend() }, 0)
    }
  }, [targets, effective, updateSetting])

  const resetAll = useCallback(() => {
    updateSetting('documents.saveTargets', {})
    setTimeout(() => { void syncAiAgentDefaultToBackend() }, 0)
  }, [updateSetting])

  return (
    <div className="settings-section">
      <div className="settings-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>Documents — auto-save locations</h2>
          <p className="settings-section-description">
            Choose which category and folder each part of the app saves generated
            documents into (enrichment markdown, snapshots, troubleshooting summaries,
            MOPs, AI outputs, and more). Leave a folder blank for none. Applies in
            both personal and enterprise mode.
          </p>
        </div>
        <button className="settings-button" onClick={resetAll}>Reset to defaults</button>
      </div>

      <table className="settings-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th style={{ padding: '6px 8px' }}>Source</th>
            <th style={{ padding: '6px 8px' }}>Category</th>
            <th style={{ padding: '6px 8px' }}>Folder (optional)</th>
          </tr>
        </thead>
        <tbody>
          {DOC_SAVE_SOURCES.map((source) => {
            const val = effective(source)
            return (
              <tr key={source} style={{ borderTop: '1px solid var(--border-color, #333)' }}>
                <td style={{ padding: '6px 8px' }}>{DOC_SAVE_SOURCE_LABELS[source]}</td>
                <td style={{ padding: '6px 8px' }}>
                  <select
                    value={val.category}
                    onChange={(e) => writeTarget(source, { category: e.target.value as DocumentCategory })}
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {val.category === 'notes' && (
                    <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }} title="Notes are encrypted at rest and hidden from the AI when the vault is locked">🔒 encrypted</span>
                  )}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <input
                    type="text"
                    value={val.folder}
                    placeholder="(none)"
                    onChange={(e) => writeTarget(source, { folder: e.target.value })}
                    style={{ width: 180 }}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
