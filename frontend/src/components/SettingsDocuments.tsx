/**
 * SettingsDocuments - configure where automatic document saves go.
 *
 * Each auto-save source (topology enrichment, troubleshooting, MOP, etc.) can be
 * pointed at a document category + optional folder. Stored in the
 * 'documents.saveTargets' setting (localStorage → applies in personal and
 * enterprise mode). The AI-agent default is also mirrored to the backend so the
 * standalone agent honors it.
 */
import AITabInput from './AITabInput'
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
import SettingsSection from './settings/SettingsSection'
import SettingRow from './settings/SettingRow'
import './SettingsDocuments.css'

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
    <SettingsSection
      title="Auto-save Locations"
      description="Choose which category and folder each part of the app saves generated documents into (enrichment markdown, snapshots, troubleshooting summaries, MOPs, AI outputs, and more). Leave a folder blank for none. Applies in both personal and enterprise mode."
      actions={<button className="ns-btn ns-btn--small" onClick={resetAll}>Reset to defaults</button>}
    >
      <div className="settings-group">
        {DOC_SAVE_SOURCES.map((source) => {
          const val = effective(source)
          const label = DOC_SAVE_SOURCE_LABELS[source]
          return (
            <SettingRow
              key={source}
              label={label}
              description={val.category === 'notes' ? 'Notes are encrypted at rest and hidden from the AI when the vault is locked.' : undefined}
            >
              <span className="settings-documents-target">
                <select aria-label={`Category for ${label}`} className="ns-select"
                  value={val.category}
                  onChange={(e) => writeTarget(source, { category: e.target.value as DocumentCategory })}
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <AITabInput
                  aria-label={`Folder for ${label}`}
                  value={val.folder}
                  placeholder="Folder (optional)"
                  onChange={(e) => writeTarget(source, { folder: e.target.value })}
                  aiField="document folder"
                  aiPlaceholder="Folder path where these auto-saved documents should go"
                  aiContext={{ source: label, category: val.category }}
                  onAIValue={(v) => writeTarget(source, { folder: v })}
                />
              </span>
            </SettingRow>
          )
        })}
      </div>
    </SettingsSection>
  )
}
